// Contract verification against the REAL installed validator.
//
// Builds a full multi-turn session with the official `@deepseek-ai/dsh-session`
// `Session` class, performs a complete rerun of its middle turn exactly the way
// the plugin's host half does (shadow -> regenerate -> replay), then proves:
//
//   1. the whole log survives the official format round-trip
//      (`sessionFormatCatalog` encode -> restore, which runs the v4 vocabulary,
//      relationship and lifecycle validators plus `Session.fromRestore`);
//   2. the derived model context is exactly A B C1' D' E' - the spliced
//      infix order, with the later turns replayed as ordinary events;
//   3. the ledger reports the rerun complete and the hidden set retires the
//      old rows (plus the silent carrier);
//   4. a replay interrupted halfway resumes from the log alone and lands the
//      same final state (the crash-recovery path);
//   5. a rerun whose prompt never lands (admission failure) replays the whole
//      window including the prompt, leaving the context content-identical to
//      the original.
//
// Run: npm run verify:contract   (needs @deepseek-ai/dsh-session resolvable)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const dshSession = await import('@deepseek-ai/dsh-session')
const { Session, SessionId, SESSION_FORMAT_VERSION, isAppendSurfaceEvent } = dshSession
const { sessionFormatCatalog } = await import('@deepseek-ai/dsh-session-format-catalog')

const PLUGIN = await import('../lib/index.js')

// The carrier's CONTENT shape is a property of the host, not of the contract
// (0.1.27): an empty list where the installed pi-ai adapter proves it drops a
// user message whose content converts to nothing, one zero-width space
// otherwise. An unpatched adapter turns `content: []` into
// `{ role: 'user', content: '' }` and the provider refuses the whole request
// ("user message must have content"), so the empty list may not be assumed.
// Both shapes are turn-free, both are recognised by `isRerunCarrier`, and
// `derivedShape` renders both as the carrier. These checks therefore pin the
// shape to the same load-time decision the host half makes, and hold on a
// patched and on an unpatched machine alike.
const CARRIER_CONTENT = PLUGIN.silentCarrierContent(PLUGIN.ADAPTER_DROPS_EMPTY_USER_CONTENT)

const uid = (prefix) => `${prefix}-${randomUUID()}`

let passed = 0
function ok(name, body) {
  body()
  passed += 1
  console.log(`  ok ${passed} - ${name}`)
}

// --- session fixture -----------------------------------------------------------

function makeSession() {
  const id = SessionId(`session-${randomUUID()}`)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: Date.now(),
    isSeeded: false,
    cwd: '/tmp/dsh-rerun-turn-contract',
  })
  return session
}

const textBlock = (text) => ({ type: 'text', text })
const userMessage = (text, extraSource = {}) => ({
  id: uid('m'),
  role: 'user',
  content: [textBlock(text)],
  source: { kind: 'user', ...extraSource },
})
const assistantMessage = (text, extra = {}) => ({
  id: uid('m'),
  role: 'assistant',
  content: Array.isArray(text) ? text : [textBlock(text)],
  source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat', ...extra },
})
// v4 carries first-class tool-role messages: role 'tool', a top-level
// `toolCallId`, and bare content blocks (no released tool-result wrapper).
const toolResultMessage = (callId, text) => ({
  id: uid('m'),
  role: 'tool',
  toolCallId: callId,
  content: [textBlock(text)],
  isError: false,
  source: { kind: 'tool', callId },
})

// A complete plain turn: bracket, prompt, reply, closers. Returns the seqs.
function plainTurn(session, turn, prompt, reply, promptSource = {}) {
  const seqs = {}
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  seqs.prompt = session.append('user/message', userMessage(prompt, promptSource), { surfaceOp: 'append' }).seq
  seqs.reply = session.append(
    'assistant/message',
    { turn, step: 1, message: assistantMessage(reply), stream: [] },
    { surfaceOp: 'append' },
  ).seq
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return seqs
}

// A tool-using turn: prompt, reply advertising the call, call, result, then a
// second step with the final text reply.
function toolTurn(session, turn, prompt, reply, callId, toolName, result, finalReply) {
  const seqs = {}
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  seqs.prompt = session.append('user/message', userMessage(prompt), { surfaceOp: 'append' }).seq
  const advertise = { type: 'tool-call', id: callId, name: toolName, arguments: '{"q":"x"}' }
  seqs.reply = session.append(
    'assistant/message',
    { turn, step: 1, message: assistantMessage([textBlock(reply), advertise]), stream: [] },
    { surfaceOp: 'append' },
  ).seq
  session.append('tool/call', { turn, step: 1, callId, name: toolName, arguments: '{"q":"x"}' })
  const resultSeq = session.append(
    'tool/result',
    {
      turn,
      step: 1,
      message: toolResultMessage(callId, result),
    },
    { surfaceOp: 'append', sourceEventSeqs: [seqs.reply] },
  ).seq
  session.append('step/end', { turn, step: 1 })
  session.append('step/start', { turn, step: 2 })
  seqs.finalReply = session.append(
    'assistant/message',
    { turn, step: 2, message: assistantMessage(finalReply), stream: [] },
    { surfaceOp: 'append' },
  ).seq
  session.append('step/end', { turn, step: 2 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  seqs.result = resultSeq
  return seqs
}

// The first turn with the system prompt head (surface node 0) inside it, the
// way the loop lands it: the format reads system messages only inside an open
// turn and step, so the head lives in turn 1's first step.
function firstTurn(session, prompt, reply) {
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append(
    'system/message',
    {
      turn: 1,
      step: 1,
      message: { id: uid('m'), role: 'system', content: [textBlock('SYSTEM PROMPT')], source: { kind: 'system-prompt' } },
    },
    { surfaceOp: 'append' },
  )
  session.append('user/message', userMessage(prompt), { surfaceOp: 'append' })
  session.append(
    'assistant/message',
    { turn: 1, step: 1, message: assistantMessage(reply), stream: [] },
    { surfaceOp: 'append' },
  )
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

// Derived context as a compact, comparable shape: `role:text` per message.
// The silent replacement carrier this plugin (and its siblings) writes is a
// user message with no readable text: an EMPTY one where the installed adapter
// is proven to drop it, one zero-width space otherwise (0.1.27). It is on the
// surface, and `deriveMessages()` returns it, but no adapter puts a READABLE
// message on the wire for it - dsh-llm-deepseek always skips
// `role === "user" && content.length === 0`, the pi-ai adapter does the same
// under the name `dsh-delete-turn:skip-empty-user`, and where that proof is
// missing the single zero-width space is the price the provider accepts. So the
// derivation is rendered as `user:<carrier>` in both shapes and the wire view
// drops exactly those rows.
function derivedShape(session) {
  return session.deriveMessages().map((message) => {
    if (message.role === 'user' && message.content.length === 0) return 'user:<carrier>'
    const first = message.content[0]
    const text =
      first && first.type === 'text'
        ? first.text === '\u200B'
          ? '<carrier>'
          : first.text
        : first && first.type === 'tool-result'
          ? `<tool-result ${first.toolCallId}>`
          : `<${first ? first.type : 'empty'}>`
    return `${message.role}:${text}`
  })
}

/** What the provider actually receives: the derived shape without the carriers. */
function modelShape(session) {
  return derivedShape(session).filter((row) => row !== 'user:<carrier>')
}

/**
 * Turn numbers on screen that hold nothing a viewer could see.
 *
 * A turn exists in the log as a bracket, but the viewer draws it from its
 * surface nodes: a node that derives no message (DSH drops empty system,
 * developer and assistant messages) or that the adapters drop on the way out
 * (an empty user message is the silent carrier) leaves the turn showing an
 * empty "completed" strip and its number a hole in the trajectory view. The
 * carrier must never create one - that is the whole point of the turn-free
 * shape.
 *
 * A turn the ledger reports as RETIRED is excluded: retiring a window is the
 * rerun working as designed, and the client drops those rows by turn number
 * (`retiredTurns`). What must never happen - and what this checks - is an empty
 * turn nobody accounted for, which is exactly the bare "completed" strip the
 * carrier turn used to leave behind. The trailing turn is excluded too: it may
 * be a generation in flight.
 *
 * @param events - complete log.
 * @param session - the official Session built from those events, so the
 *   derivation rule is DSH's own, not a copy.
 * @returns turn numbers, ascending.
 */
function emptyTurnBrackets(events, session) {
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const visible = (seq) => {
    const event = bySeq.get(seq)
    if (event === undefined) return false
    const message = session.deriveEventMessage(event)
    if (message === null) return false
    if (message.role === 'user' && message.content.length === 0) return false
    return true
  }
  const surfaceSeqs = new Set(PLUGIN.foldSurface(events).nodes)
  const ledger = PLUGIN.rerunLedger(events)
  const retired = new Set(
    PLUGIN.retiredTurnList(events, PLUGIN.foldSurface(events), ledger, { inFlightId: null }),
  )
  const maxTurn = PLUGIN.lastTurnOf(events)
  const out = []
  for (const span of PLUGIN.turnSpans(events)) {
    if (retired.has(span.turn) || span.turn === maxTurn) continue
    const owned = [...surfaceSeqs].filter(
      (seq) => seq > span.startSeq && (span.endSeq === null || seq <= span.endSeq),
    )
    if (!owned.some(visible)) out.push(span.turn)
  }
  return out
}

// Full official validation: encode every event through the shipped codec and
// restore it - restoreCurrent runs the v4 vocabulary, relationship/lifecycle,
// and installed-Session validators over the complete artifact.
function officialRoundTrip(events, headerFields) {
  // The v4 physical header requires the full canonical field set.
  const header = {
    version: SESSION_FORMAT_VERSION,
    id: headerFields.id,
    createdAt: headerFields.createdAt,
    isSeeded: false,
    cwd: '/tmp/dsh-rerun-turn-contract',
    delegationDepth: 0,
  }
  const headerValue = sessionFormatCatalog.encodeCurrentHeader(header, 0)
  const restore = sessionFormatCatalog.createRestore(headerValue, { recovery: 'strict', validation: 'current' })
  for (const event of events) restore.decodeRow(sessionFormatCatalog.encodeCurrentEvent(event))
  return restore.finish()
}

// --- the rerun, exactly the way the host half performs it ----------------------

function performRerun(session, targetSeq) {
  const events = session.snapshotEvents()
  const surface = session.surface.nodes
  const plan = PLUGIN.planRerun(events, surface, { seq: targetSeq })
  const rerunId = randomUUID()
  const promptRequestId = randomUUID()
  for (const write of PLUGIN.buildShadowWrites(plan, rerunId, promptRequestId)) {
    if (write.surfaceOp === undefined) session.append(write.type, write.data)
    else session.append(write.type, write.data, { surfaceOp: write.surfaceOp, sourceEventSeqs: write.sourceEventSeqs })
  }
  return { plan, rerunId, promptRequestId }
}

// Simulate the loop's own turn: it opens `lastTurn + 1` (the number the format
// requires next) and runs one plain step. The carrier must never consume a
// turn number, or this call collides - the production corruption this test
// guards against.
function nextTurn(session) {
  return PLUGIN.lastTurnOf(session.snapshotEvents()) + 1
}

// The live reply seq of one turn number, for chained-rerun scenarios.
function turnSpanSeq(session, turn) {
  const mid = session.snapshotEvents()
  const nodes = session.surface.nodes
  const replies = PLUGIN.rerunnableReplies(mid, nodes)
  const reply = replies.find((entry) => entry.turn === turn)
  assert.ok(reply, `turn ${turn} has a live reply`)
  return reply.seq
}

// --- scenarios -----------------------------------------------------------------

console.log('dsh-rerun-turn surface contract')

// Scenario 1: the full rerun, validated and derived.
{
  const session = makeSession()
  firstTurn(session, 'A', 'A1')
  plainTurn(session, 2, 'B', 'B1')
  const turnC = toolTurn(session, 3, 'C', 'C1 working', 'call_C', 'web_search', 'result C', 'C1 final')
  const turnD = toolTurn(session, 4, 'D', 'D1 working', 'call_D', 'run_code', 'result D', 'D1 final')
  plainTurn(session, 5, 'E', 'E1')

  const beforeRerun = session.snapshotEvents()
  const { plan, rerunId, promptRequestId } = performRerun(session, turnC.reply)
  ok('the shadow opens no turn at all: it buys no turn number', () => {
    const afterShadow = session.snapshotEvents()
    assert.equal(afterShadow.length, beforeRerun.length + 1, 'the shadow is exactly one event')
    // The carrier is one empty user/message with no turn bracket around it, so
    // the log's turn numbering - and therefore the loop's own counter - never
    // moves. A carrier that opened a turn is what left an empty "completed"
    // strip on screen and a hole in the trajectory numbering (0.1.14-0.1.25).
    assert.equal(PLUGIN.lastTurnOf(afterShadow), PLUGIN.lastTurnOf(beforeRerun))
    assert.deepEqual(
      PLUGIN.turnSpans(afterShadow).map((span) => span.turn),
      PLUGIN.turnSpans(beforeRerun).map((span) => span.turn),
    )
    const carrier = afterShadow[afterShadow.length - 1]
    assert.equal(carrier.type, 'user/message')
    assert.deepEqual(carrier.data.content, CARRIER_CONTENT, 'the carrier holds no readable text')
    if (!PLUGIN.ADAPTER_DROPS_EMPTY_USER_CONTENT) {
      // The whole point of 0.1.27: without the adapter proof the carrier may not
      // be empty, because an unpatched adapter converts `content: []` to
      // `content: ''` and the provider refuses the request outright.
      assert.ok(
        carrier.data.content.length > 0,
        'an unproven host must not write an empty carrier (the provider refuses content: "")',
      )
    }
    assert.equal(carrier.data.turn, undefined, 'a user carrier carries no turn coordinate')
    assert.equal(PLUGIN.isRerunCarrier(carrier), true)
    assert.equal(PLUGIN.isSilentPluginCarrier(carrier), true, 'a text-free plugin carrier is never a prompt')
  })
  ok('plan targets the whole turn C window', () => {
    assert.equal(plan.turn, 3)
    assert.equal(plan.promptSeq, turnC.prompt)
    assert.equal(plan.shadowed[0], turnC.prompt)
    assert.deepEqual(plan.prompt, { text: 'C', images: [], files: [], attachments: 0 })
  })

  // Regeneration: the official prompt path would append exactly this shape.
  const gen1 = nextTurn(session)
  session.append('turn/start', { turn: gen1 })
  session.append('step/start', { turn: gen1, step: 1 })
  const freshPromptSeq = session.append(
    'user/message',
    userMessage('C', { rpcId: promptRequestId }),
    { surfaceOp: 'append' },
  ).seq
  const freshReplySeq = session.append(
    'assistant/message',
    { turn: gen1, step: 1, message: assistantMessage('C1 fresh'), stream: [] },
    { surfaceOp: 'append' },
  ).seq
  session.append('step/end', { turn: gen1, step: 1 })
  session.append('turn/end', { turn: gen1, reason: { kind: 'completed' } })

  // The ledger sees an incomplete rerun: everything after C's prompt is gone
  // from the surface and nothing has been replayed yet.
  const midLedger = PLUGIN.rerunLedger(session.snapshotEvents())
  ok('ledger reports the rerun incomplete before the replay', () => {
    assert.equal(midLedger.reruns.length, 1)
    const record = midLedger.reruns[0]
    assert.equal(record.rerunId, rerunId)
    assert.equal(record.complete, false)
    assert.ok(record.missing.length > 0)
    assert.ok(!record.missing.includes(plan.promptSeq), 'the prompt is covered by its rpcId event')
  })

  // Replay: rebuild the plan from the ledger record the way the resume path
  // does, then append every write.
  const midEvents = session.snapshotEvents()
  const record = PLUGIN.rerunLedger(midEvents).reruns[0]
  const replayPlan = {
    logFrom: record.replayFrom,
    logTo: record.logTo,
    promptSeq: record.promptSeq,
    shadowed: record.shadowed,
  }
  const writes = PLUGIN.buildReplayWrites(midEvents, replayPlan, PLUGIN.lastTurnOf(midEvents) + 1, rerunId, session.seq, false)
  for (let index = 0; index < writes.length; index += 1) {
    const write = writes[index]
    if (write.surfaceOp === undefined) session.append(write.type, write.data)
    else session.append(write.type, write.data, { surfaceOp: write.surfaceOp, sourceEventSeqs: write.sourceEventSeqs })
  }

  // The loop keeps running: the next real prompt opens `lastTurn + 1` after
  // the replay. With the old carrier-turn shape this collided and the log
  // failed its cold read ("turn/start does not open the expected turn").
  plainTurn(session, nextTurn(session), 'F', 'F1')

  const finalEvents = session.snapshotEvents()
  const artifact = officialRoundTrip(finalEvents, { id: session.id, createdAt: Date.now() })
  ok('the complete rerun log (plus a new turn after it) passes the strict cold read', () => {
    assert.equal(artifact.events.length, finalEvents.length)
  })

  const reloaded = Session.create(session.id, artifact.events, {
    version: SESSION_FORMAT_VERSION,
    id: session.id,
    createdAt: Date.now(),
    isSeeded: false,
  })
  ok('the derived context is exactly A B C1fresh D E (the infix splice)', () => {
    const shape = modelShape(reloaded)
    assert.deepEqual(shape, [
      'system:SYSTEM PROMPT',
      'user:A',
      'assistant:A1',
      'user:B',
      'assistant:B1',
      'user:C',
      'assistant:C1 fresh',
      'user:D',
      'assistant:D1 working',
      'tool:result D',
      'assistant:D1 final',
      'user:E',
      'assistant:E1',
      'user:F',
      'assistant:F1',
    ])
    // No empty user message is left in the derived request unless this host can
    // prove its adapter drops one; without that proof the carrier is the single
    // zero-width user message instead (0.1.27, see CARRIER_CONTENT).
    const derivedMessages = reloaded.deriveMessages()
    const emptyUserMessages = derivedMessages.filter(
      (message) => message.role === 'user' && message.content.length === 0,
    )
    assert.equal(
      emptyUserMessages.length,
      PLUGIN.ADAPTER_DROPS_EMPTY_USER_CONTENT ? 1 : 0,
      'an empty user message exists only where the adapter is proven to drop it',
    )
    if (!PLUGIN.ADAPTER_DROPS_EMPTY_USER_CONTENT) {
      const fallbackCarriers = derivedMessages.filter(
        (message) =>
          message.role === 'user' &&
          message.content.length === 1 &&
          message.content[0].type === 'text' &&
          message.content[0].text === PLUGIN.CARRIER_ZWSP,
      )
      assert.equal(fallbackCarriers.length, 1, 'the fallback carrier is one zero-width user message')
    }
    // The carrier is the ONLY blank message in the derivation, and it sits where
    // the old window was - right before the re-sent prompt.
    const raw = derivedShape(reloaded)
    assert.deepEqual(
      raw.filter((row) => row === 'user:<carrier>').length,
      1,
      'exactly one silent carrier',
    )
    assert.equal(
      raw.indexOf('user:<carrier>'),
      raw.indexOf('user:C') - 1,
      'the carrier stands where the retired window was',
    )
  })
  ok('no turn in the finished log exists only to hold bookkeeping', () => {
    const empty = emptyTurnBrackets(finalEvents, reloaded)
    assert.deepEqual(empty, [], `turns with nothing on screen: ${empty.join(',')}`)
    const turns = finalEvents.filter((event) => event.type === 'turn/start').map((event) => event.data.turn)
    assert.deepEqual(turns, turns.map((_turn, index) => index + 1), 'turn numbers stay 1..N with no gap')
  })
  ok('replayed surface events are ordinary appends carrying the replay marker', () => {
    const markers = finalEvents
      .filter((event) => event.seq > freshReplySeq)
      .map((event) => PLUGIN.replayMarkerOf(event))
      .filter(Boolean)
    assert.ok(markers.length >= 6, `expected the D/E copies, got ${markers.length}`)
    for (const marker of markers) {
      assert.equal(marker.rerunId, rerunId)
      assert.equal(typeof marker.originalSeq, 'number')
    }
  })
  ok('the ledger reports the rerun complete afterwards', () => {
    const ledger = PLUGIN.rerunLedger(finalEvents)
    assert.equal(ledger.reruns.length, 1)
    assert.equal(ledger.reruns[0].complete, true)
    assert.deepEqual(ledger.reruns[0].missing, [])
    // Every shadowed seq plus the carrier itself is retired for the UI.
    assert.equal(ledger.hidden.length, plan.shadowed.length + 1)
    assert.ok(ledger.hidden.some((entry) => entry.seq === ledger.reruns[0].carrierSeq))
  })
  ok('replayed copies are append-origin events (they render as transcript rows)', () => {
    const copyCount = finalEvents.filter(
      (event) => event.seq > freshReplySeq && isAppendSurfaceEvent(event),
    ).length
    assert.ok(copyCount >= 5, `expected the replayed rows, got ${copyCount}`)
  })
}

// Scenario 2: a replay interrupted halfway resumes from the log alone.
{
  const session = makeSession()
  firstTurn(session, 'A', 'A1')
  const turnC = toolTurn(session, 2, 'C', 'C1 working', 'call_C', 'web_search', 'result C', 'C1 final')
  plainTurn(session, 3, 'D', 'D1')
  plainTurn(session, 4, 'E', 'E1')

  const { plan, rerunId, promptRequestId } = performRerun(session, turnC.reply)
  const gen2 = nextTurn(session)
  session.append('turn/start', { turn: gen2 })
  session.append('step/start', { turn: gen2, step: 1 })
  session.append('user/message', userMessage('C', { rpcId: promptRequestId }), { surfaceOp: 'append' })
  session.append(
    'assistant/message',
    { turn: gen2, step: 1, message: assistantMessage('C1 fresh'), stream: [] },
    { surfaceOp: 'append' },
  )
  session.append('step/end', { turn: gen2, step: 1 })
  session.append('turn/end', { turn: gen2, reason: { kind: 'completed' } })

  // "Crash": land only the first two replay writes (the bracket of D's copy).
  const midEvents = session.snapshotEvents()
  const record = PLUGIN.rerunLedger(midEvents).reruns[0]
  const writes = PLUGIN.buildReplayWrites(
    midEvents,
    { logFrom: record.replayFrom, logTo: record.logTo, promptSeq: record.promptSeq, shadowed: record.shadowed },
    PLUGIN.lastTurnOf(midEvents) + 1,
    rerunId,
    session.seq,
    false,
  )
  assert.ok(writes.length > 4)
  for (const write of writes.slice(0, 2)) {
    if (write.surfaceOp === undefined) session.append(write.type, write.data)
    else session.append(write.type, write.data, { surfaceOp: write.surfaceOp, sourceEventSeqs: write.sourceEventSeqs })
  }
  const crashedEvents = session.snapshotEvents()
  const crashedLedger = PLUGIN.rerunLedger(crashedEvents)
  ok('the ledger sees the interrupted replay as incomplete', () => {
    assert.equal(crashedLedger.reruns[0].complete, false)
    assert.ok(crashedLedger.reruns[0].missing.length > 0)
  })

  // Resume: same computation performReplay runs - an orphan open turn at the
  // tail is continued at its own number, the full write plan is rebuilt, and
  // the leading bracket writes that already landed verbatim are skipped.
  const orphan = PLUGIN.openTurn(crashedEvents)
  const resumedBase = orphan !== null && PLUGIN.replayOrphanOpen(crashedEvents, rerunId) ? orphan : PLUGIN.lastTurnOf(crashedEvents) + 1
  const startSeq = session.seq
  const resumedWrites = PLUGIN.buildReplayWrites(
    crashedEvents,
    { logFrom: record.replayFrom, logTo: record.logTo, promptSeq: record.promptSeq, shadowed: record.shadowed },
    resumedBase,
    rerunId,
    startSeq,
    false,
  )
  const skip = PLUGIN.matchReplayPrefix(crashedEvents, resumedWrites, crashedEvents.length - (record.carrierSeq + 1))
  ok('resume skips exactly the bracket writes the crash already landed', () => {
    assert.equal(skip, 2)
  })
  for (let index = skip; index < resumedWrites.length; index += 1) {
    const write = resumedWrites[index]
    if (write.surfaceOp === undefined) session.append(write.type, write.data)
    else session.append(write.type, write.data, { surfaceOp: write.surfaceOp, sourceEventSeqs: write.sourceEventSeqs })
  }

  const finalEvents = session.snapshotEvents()
  officialRoundTrip(finalEvents, { id: session.id, createdAt: Date.now() })
  const reloaded = Session.create(session.id, finalEvents, {
    version: SESSION_FORMAT_VERSION,
    id: session.id,
    createdAt: Date.now(),
    isSeeded: false,
  })
  ok('the resumed log is valid and derives the spliced context', () => {
    assert.deepEqual(modelShape(reloaded), [
      'system:SYSTEM PROMPT',
      'user:A',
      'assistant:A1',
      'user:C',
      'assistant:C1 fresh',
      'user:D',
      'assistant:D1',
      'user:E',
      'assistant:E1',
    ])
  })
  ok('the resumed rerun is complete', () => {
    assert.equal(PLUGIN.rerunLedger(finalEvents).reruns[0].complete, true)
  })
}

// Scenario 3: the prompt never lands (admission failed) - the replay includes
// the prompt copy, so the context stays content-identical to the original.
{
  const session = makeSession()
  firstTurn(session, 'A', 'A1')
  const turnC = plainTurn(session, 2, 'C', 'C1')
  plainTurn(session, 3, 'D', 'D1')
  const before = modelShape(session)

  const { rerunId } = performRerun(session, turnC.reply)
  // No rpcId event: the prompt was never claimed.
  const midEvents = session.snapshotEvents()
  const record = PLUGIN.rerunLedger(midEvents).reruns[0]
  const writes = PLUGIN.buildReplayWrites(
    midEvents,
    { logFrom: record.logFrom, logTo: record.logTo, promptSeq: record.promptSeq, shadowed: record.shadowed },
    PLUGIN.lastTurnOf(midEvents) + 1,
    rerunId,
    session.seq,
    true,
  )
  for (const write of writes) {
    if (write.surfaceOp === undefined) session.append(write.type, write.data)
    else session.append(write.type, write.data, { surfaceOp: write.surfaceOp, sourceEventSeqs: write.sourceEventSeqs })
  }
  const finalEvents = session.snapshotEvents()
  officialRoundTrip(finalEvents, { id: session.id, createdAt: Date.now() })
  const reloaded = Session.create(session.id, finalEvents, {
    version: SESSION_FORMAT_VERSION,
    id: session.id,
    createdAt: Date.now(),
    isSeeded: false,
  })
  ok('a failed admission replays the prompt too - the context keeps its content', () => {
    // The carrier stands where the window was, so it is the one row the wire
    // view drops; everything the model reads must be byte-identical.
    assert.deepEqual(modelShape(reloaded), before)
    assert.deepEqual(emptyTurnBrackets(finalEvents, reloaded), [], 'an empty window still leaves no empty turn')
  })
  ok('that rerun counts as complete (the prompt travelled as a copy)', () => {
    assert.equal(PLUGIN.rerunLedger(finalEvents).reruns[0].complete, true)
  })
}

// Scenario 4: chained reruns - rerunning a replayed turn shadows the copies
// and replays the tail again.
{
  const session = makeSession()
  firstTurn(session, 'A', 'A1')
  const turnC = plainTurn(session, 2, 'C', 'C1 original')
  plainTurn(session, 3, 'D', 'D1')

  // First rerun: shadow C, regenerate, replay the D tail.
  let run = performRerun(session, turnC.reply)
  let runTurn = nextTurn(session)
  session.append('turn/start', { turn: runTurn })
  session.append('step/start', { turn: runTurn, step: 1 })
  session.append('user/message', userMessage('C', { rpcId: run.promptRequestId }), { surfaceOp: 'append' })
  session.append(
    'assistant/message',
    { turn: runTurn, step: 1, message: assistantMessage('C1 first rerun'), stream: [] },
    { surfaceOp: 'append' },
  )
  session.append('step/end', { turn: runTurn, step: 1 })
  session.append('turn/end', { turn: runTurn, reason: { kind: 'completed' } })
  let mid = session.snapshotEvents()
  let record = PLUGIN.rerunLedger(mid).reruns[0]
  for (const write of PLUGIN.buildReplayWrites(mid, { logFrom: record.replayFrom, logTo: record.logTo, promptSeq: record.promptSeq, shadowed: record.shadowed }, PLUGIN.lastTurnOf(mid) + 1, run.rerunId, session.seq, false)) {
    if (write.surfaceOp === undefined) session.append(write.type, write.data)
    else session.append(write.type, write.data, { surfaceOp: write.surfaceOp, sourceEventSeqs: write.sourceEventSeqs })
  }
  const afterFirst = session.snapshotEvents()
  officialRoundTrip(afterFirst, { id: session.id, createdAt: Date.now() })
  ok('the first rerun is complete and the ledger carries one record', () => {
    const ledger = PLUGIN.rerunLedger(afterFirst)
    assert.equal(ledger.reruns.length, 1)
    assert.equal(ledger.reruns[0].complete, true)
  })

  // Second rerun targets the FIRST rerun's fresh reply. The copies of D are
  // ordinary surface nodes now, so the shadow window and replay cover them.
  const surface = session.surface.nodes
  const freshReply = afterFirst.filter(
    (event) => event.type === 'assistant/message' && event.seq > record.carrierSeq && PLUGIN.replayMarkerOf(event) === null,
  )
  const secondTarget = freshReply[freshReply.length - 1]
  assert.ok(surface.includes(secondTarget.seq), 'the fresh reply is a live node')
  run = performRerun(session, secondTarget.seq)
  runTurn = nextTurn(session)
  session.append('turn/start', { turn: runTurn })
  session.append('step/start', { turn: runTurn, step: 1 })
  session.append('user/message', userMessage('C', { rpcId: run.promptRequestId }), { surfaceOp: 'append' })
  session.append(
    'assistant/message',
    { turn: runTurn, step: 1, message: assistantMessage('C1 second rerun'), stream: [] },
    { surfaceOp: 'append' },
  )
  session.append('step/end', { turn: runTurn, step: 1 })
  session.append('turn/end', { turn: runTurn, reason: { kind: 'completed' } })
  mid = session.snapshotEvents()
  record = PLUGIN.rerunLedger(mid).reruns.find((entry) => entry.rerunId === run.rerunId)
  for (const write of PLUGIN.buildReplayWrites(mid, { logFrom: record.replayFrom, logTo: record.logTo, promptSeq: record.promptSeq, shadowed: record.shadowed }, PLUGIN.lastTurnOf(mid) + 1, run.rerunId, session.seq, false)) {
    if (write.surfaceOp === undefined) session.append(write.type, write.data)
    else session.append(write.type, write.data, { surfaceOp: write.surfaceOp, sourceEventSeqs: write.sourceEventSeqs })
  }
  const afterSecond = session.snapshotEvents()
  officialRoundTrip(afterSecond, { id: session.id, createdAt: Date.now() })
  const reloaded = Session.create(session.id, afterSecond, {
    version: SESSION_FORMAT_VERSION,
    id: session.id,
    createdAt: Date.now(),
    isSeeded: false,
  })
  ok('the chained rerun lands A B C1second D and both records complete', () => {
    assert.deepEqual(modelShape(reloaded), [
      'system:SYSTEM PROMPT',
      'user:A',
      'assistant:A1',
      'user:C',
      'assistant:C1 second rerun',
      'user:D',
      'assistant:D1',
    ])
    const ledger = PLUGIN.rerunLedger(afterSecond)
    assert.equal(ledger.reruns.length, 2)
    for (const entry of ledger.reruns) assert.equal(entry.complete, true)
  })
}

// Scenario 5: a TOOL_NOT_STARTED repair result (no call event, no
// sourceEventSeqs) survives the replay in its exact repair shape, and a call
// whose result never landed is dropped together with its advertisement.
{
  const session = makeSession()
  firstTurn(session, 'C', 'C1')
  const promptSeq = session.snapshotEvents().find((event) => event.type === 'user/message').seq
  const replySeq = session.snapshotEvents().filter((event) => event.type === 'assistant/message')[0].seq
  // The tail turn carries the interesting tool shapes - a call that never
  // started (repaired by a TOOL_NOT_STARTED result) next to one that
  // completed - because the replay copies the tail, not the rerun turn.
  const repairId = 'call_lost'
  const startedId = 'call_started'
  session.append('turn/start', { turn: 2 })
  session.append('step/start', { turn: 2, step: 1 })
  session.append('user/message', userMessage('D'), { surfaceOp: 'append' })
  const startedReplySeq = session.append(
    'assistant/message',
    {
      turn: 2,
      step: 1,
      message: assistantMessage([
        textBlock('D1 working'),
        { type: 'tool-call', id: repairId, name: 'run_code', arguments: '{"a":1}' },
        { type: 'tool-call', id: startedId, name: 'web_search', arguments: '{"b":2}' },
      ]),
      stream: [],
    },
    { surfaceOp: 'append' },
  ).seq
  session.append('tool/call', { turn: 2, step: 1, callId: startedId, name: 'web_search', arguments: '{"b":2}' })
  session.append(
    'tool/result',
    { turn: 2, step: 1, message: toolResultMessage(startedId, 'result') },
    { surfaceOp: 'append', sourceEventSeqs: [startedReplySeq] },
  )
  session.append(
    'tool/result',
    {
      turn: 2,
      step: 1,
      message: {
        id: `interrupted-tool-result-${repairId}-0`,
        role: 'tool',
        toolCallId: repairId,
        content: [textBlock('The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.')],
        isError: true,
        source: { kind: 'tool', callId: repairId },
      },
      error: { name: 'ToolNotStartedError', code: 'TOOL_NOT_STARTED' },
    },
    { surfaceOp: 'append' },
  )
  session.append('step/end', { turn: 2, step: 1 })
  session.append('step/start', { turn: 2, step: 2 })
  session.append(
    'assistant/message',
    { turn: 2, step: 2, message: assistantMessage('D1 final'), stream: [] },
    { surfaceOp: 'append' },
  )
  session.append('step/end', { turn: 2, step: 2 })
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

  const { rerunId, promptRequestId } = performRerun(session, replySeq)
  const gen5 = nextTurn(session)
  session.append('turn/start', { turn: gen5 })
  session.append('step/start', { turn: gen5, step: 1 })
  session.append('user/message', userMessage('C', { rpcId: promptRequestId }), { surfaceOp: 'append' })
  session.append(
    'assistant/message',
    { turn: gen5, step: 1, message: assistantMessage('C1 fresh'), stream: [] },
    { surfaceOp: 'append' },
  )
  session.append('step/end', { turn: gen5, step: 1 })
  session.append('turn/end', { turn: gen5, reason: { kind: 'completed' } })
  const mid = session.snapshotEvents()
  const record = PLUGIN.rerunLedger(mid).reruns[0]
  const writes = PLUGIN.buildReplayWrites(mid, { logFrom: record.replayFrom, logTo: record.logTo, promptSeq: record.promptSeq, shadowed: record.shadowed }, PLUGIN.lastTurnOf(mid) + 1, rerunId, session.seq, false)
  ok('the repair result is copied without sourceEventSeqs; the lost call is gone', () => {
    const repairs = writes.filter((write) => write.type === 'tool/result' && write.data.error && write.data.error.code === 'TOOL_NOT_STARTED')
    assert.equal(repairs.length, 1)
    assert.equal(repairs[0].sourceEventSeqs, undefined)
    const copiedCalls = writes.filter((write) => write.type === 'tool/call').map((write) => write.data.callId)
    assert.deepEqual(copiedCalls, [startedId])
    const stripped = writes.find((write) => write.type === 'assistant/message' && JSON.stringify(write.data.message.content).includes('D1 working'))
    assert.ok(stripped, 'the advertising reply is copied')
    // A repaired call keeps its block: the block plus the TOOL_NOT_STARTED
    // result form a complete lifecycle without a call event.
    assert.equal(stripped.data.message.content.some((block) => block.type === 'tool-call' && block.id === repairId), true, 'the repaired call block survives')
    assert.equal(stripped.data.message.content.some((block) => block.type === 'tool-call' && block.id === startedId), true, 'the started call block survives')
  })
  for (const write of writes) {
    if (write.surfaceOp === undefined) session.append(write.type, write.data)
    else session.append(write.type, write.data, { surfaceOp: write.surfaceOp, sourceEventSeqs: write.sourceEventSeqs })
  }
  const finalEvents = session.snapshotEvents()
  officialRoundTrip(finalEvents, { id: session.id, createdAt: Date.now() })
  const reloaded = Session.create(session.id, finalEvents, {
    version: SESSION_FORMAT_VERSION,
    id: session.id,
    createdAt: Date.now(),
    isSeeded: false,
  })
  ok('the replayed repair shape passes the validator and derives the tail', () => {
    const shape = modelShape(reloaded)
    assert.deepEqual(shape, [
      'system:SYSTEM PROMPT',
      'user:C',
      'assistant:C1 fresh',
      'user:D',
      'assistant:D1 working',
      'tool:result',
      'tool:The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.',
      'assistant:D1 final',
    ])
    assert.ok(shape.includes('assistant:C1 fresh'))
    assert.ok(!shape.some((entry) => entry.includes('C1') && entry.includes('result')), 'no stale turn-1 content')
  })
}

// Scenario 6: a sibling plugin rewrote the prompt in place (dsh-edit-turn's
// single-node replacement). The rerun must re-send the LIVE wording and open
// its shadow window at the live node; the retired original must not appear.
{
  const session = makeSession()
  firstTurn(session, 'A', 'A1')
  const turnC = plainTurn(session, 2, 'C original', 'C1')
  plainTurn(session, 3, 'D', 'D1')
  // In-place prompt edit, the way dsh-edit-turn lands one.
  session.append(
    'user/message',
    {
      id: uid('m'),
      role: 'user',
      content: [textBlock('C edited')],
      source: { kind: 'plugin:dsh-edit-turn', editedBy: 'dsh-edit-turn' },
    },
    { surfaceOp: { op: 'replace', startSeq: turnC.prompt, endSeq: turnC.prompt }, sourceEventSeqs: [turnC.prompt] },
  )
  const { plan, rerunId, promptRequestId } = performRerun(session, turnC.reply)
  ok('the rerun follows the in-place edit to the live prompt', () => {
    assert.equal(plan.prompt.text, 'C edited')
    assert.notEqual(plan.promptSeq, turnC.prompt)
    assert.ok(plan.shadowed.includes(plan.promptSeq))
    assert.ok(!plan.shadowed.includes(turnC.prompt))
  })
  const gen6 = nextTurn(session)
  session.append('turn/start', { turn: gen6 })
  session.append('step/start', { turn: gen6, step: 1 })
  session.append('user/message', userMessage('C edited', { rpcId: promptRequestId }), { surfaceOp: 'append' })
  session.append(
    'assistant/message',
    { turn: gen6, step: 1, message: assistantMessage('C1 fresh'), stream: [] },
    { surfaceOp: 'append' },
  )
  session.append('step/end', { turn: gen6, step: 1 })
  session.append('turn/end', { turn: gen6, reason: { kind: 'completed' } })
  const mid = session.snapshotEvents()
  const record = PLUGIN.rerunLedger(mid).reruns[0]
  for (const write of PLUGIN.buildReplayWrites(mid, { logFrom: record.replayFrom, logTo: record.logTo, promptSeq: record.promptSeq, shadowed: record.shadowed }, PLUGIN.lastTurnOf(mid) + 1, rerunId, session.seq, false)) {
    if (write.surfaceOp === undefined) session.append(write.type, write.data)
    else session.append(write.type, write.data, { surfaceOp: write.surfaceOp, sourceEventSeqs: write.sourceEventSeqs })
  }
  const finalEvents = session.snapshotEvents()
  officialRoundTrip(finalEvents, { id: session.id, createdAt: Date.now() })
  const reloaded = Session.create(session.id, finalEvents, {
    version: SESSION_FORMAT_VERSION,
    id: session.id,
    createdAt: Date.now(),
    isSeeded: false,
  })
  ok('the edited-prompt rerun derives the live wording and the replayed tail', () => {
    assert.deepEqual(modelShape(reloaded), [
      'system:SYSTEM PROMPT',
      'user:A',
      'assistant:A1',
      'user:C edited',
      'assistant:C1 fresh',
      'user:D',
      'assistant:D1',
    ])
  })
  ok('the edited-prompt rerun reads strictly and completes', () => {
    const ledger = PLUGIN.rerunLedger(finalEvents)
    assert.equal(ledger.reruns[0].complete, true)
    const hiddenSeqs = ledger.hidden.map((entry) => entry.seq)
    assert.ok(hiddenSeqs.includes(turnC.prompt), 'the original prompt the edited carrier stood for is retired for the UI')
  })
}


// Scenario 7: chained reruns must not resurrect retired log content. A rerun
// targets an early turn AFTER later reruns have retired parts of the log; the
// walk range then contains events that left the surface long ago. The replay
// copies exactly the shadowed surface nodes - never the retired leftovers.
{
  const session = makeSession()
  firstTurn(session, 'A', 'A1')
  plainTurn(session, 2, 'B', 'B1')
  plainTurn(session, 3, 'C', 'C1')

  // One full rerun: shadow, regenerate with the plan's own prompt, replay.
  const runFull = (targetSeq) => {
    const run = performRerun(session, targetSeq)
    const genTurn = nextTurn(session)
    session.append('turn/start', { turn: genTurn })
    session.append('step/start', { turn: genTurn, step: 1 })
    session.append(
      'user/message',
      userMessage(run.plan.prompt.text, { rpcId: run.promptRequestId }),
      { surfaceOp: 'append' },
    )
    session.append(
      'assistant/message',
      { turn: genTurn, step: 1, message: assistantMessage('fresh ' + run.plan.prompt.text), stream: [] },
      { surfaceOp: 'append' },
    )
    session.append('step/end', { turn: genTurn, step: 1 })
    session.append('turn/end', { turn: genTurn, reason: { kind: 'completed' } })
    const mid = session.snapshotEvents()
    const record = PLUGIN.rerunLedger(mid).reruns.find((entry) => entry.rerunId === run.rerunId)
    for (const write of PLUGIN.buildReplayWrites(
      mid,
      { logFrom: record.replayFrom, logTo: record.logTo, promptSeq: record.promptSeq, shadowed: record.shadowed },
      PLUGIN.lastTurnOf(mid) + 1,
      run.rerunId,
      session.seq,
      false,
    )) {
      if (write.surfaceOp === undefined) session.append(write.type, write.data)
      else session.append(write.type, write.data, { surfaceOp: write.surfaceOp, sourceEventSeqs: write.sourceEventSeqs })
    }
    return { run, record }
  }

  // 1. Rerun B (middle): retires B + C, regenerates B as turn 4, replays C as turn 5.
  const first = runFull(turnSpanSeq(session, 2))
  // 2. Rerun A (the first turn): its walk range now spans the ORIGINAL turn 2/3
  //    brackets - retired by step 1 - while the live content lives later.
  const second = runFull(turnSpanSeq(session, 1))

  const finalEvents = session.snapshotEvents()
  officialRoundTrip(finalEvents, { id: session.id, createdAt: Date.now() })
  const reloaded = Session.create(session.id, finalEvents, {
    version: SESSION_FORMAT_VERSION,
    id: session.id,
    createdAt: Date.now(),
    isSeeded: false,
  })
  ok('a chained rerun replayed only the live surface, never retired log leftovers', () => {
    const shape = modelShape(reloaded)
    assert.deepEqual(shape, [
      'system:SYSTEM PROMPT',
      'user:A',
      'assistant:fresh A',
      'user:B',
      'assistant:fresh B',
      'user:C',
      'assistant:C1',
    ])
  })
  ok('both reruns complete, including the one whose window covered a carrier', () => {
    // The first rerun's carrier stands where B's prompt was, so the second
    // rerun (of A) shadows it. The replay retires it without a copy, and the
    // ledger must agree - an eternally missing seq would make every /state poll
    // append the replay batch again.
    const ledger = PLUGIN.rerunLedger(finalEvents)
    assert.equal(ledger.reruns.length, 2)
    for (const entry of ledger.reruns) {
      assert.deepEqual(entry.missing, [], `rerun ${entry.rerunId.slice(0, 8)} has no missing copy`)
      assert.equal(entry.complete, true)
    }
    const coveredCarrier = finalEvents.some(
      (event) => PLUGIN.isRerunCarrier(event) && second.record.shadowed.includes(event.seq),
    )
    assert.equal(coveredCarrier, true, 'the second window really did cover the first rerun carrier')
  })
  ok('the second rerun\'s copies cite only surface nodes of its own window', () => {
    const copies = finalEvents
      .filter((event) => event.seq > second.record.carrierSeq)
      .map((event) => PLUGIN.replayMarkerOf(event))
      .filter((marker) => marker !== null && typeof marker.originalSeq === 'number')
    assert.ok(copies.length > 0, 'copies landed')
    const shadowed = new Set(second.record.shadowed)
    for (const copy of copies) {
      assert.ok(shadowed.has(copy.originalSeq), `copy cites a shadowed node (${copy.originalSeq})`)
    }
  })
}

// Scenario 8 (the reported defect, in the shape of the real session): the user
// asks the same question over and over ("Reply with exactly: FLICK") and presses
// rerun on the same reply several times. 0.1.14-0.1.25 spent one turn number per
// rerun on the bookkeeping carrier, so the transcript showed a bare "completed,
// 1s" strip and the trajectory view showed 4/6/8 skipped. The log built here is
// the fix's acceptance shape: the rerun must leave the turn numbering alone.
{
  const session = makeSession()
  const ask = (turn) => plainTurn(session, turn, 'Reply with exactly: FLICK', 'FLICK')
  firstTurn(session, 'Reply with exactly: FLICK', 'FLICK')
  ask(2)

  const before = session.snapshotEvents()
  const beforeTurns = before.filter((event) => event.type === 'turn/start').length

  // Three reruns of the same answer, the way the user pressed the button.
  let target = before.find((event) => event.type === 'assistant/message').seq
  const runs = []
  for (let index = 0; index < 3; index += 1) {
    const run = performRerun(session, target)
    const genTurn = nextTurn(session)
    session.append('turn/start', { turn: genTurn })
    session.append('step/start', { turn: genTurn, step: 1 })
    session.append('user/message', userMessage('Reply with exactly: FLICK', { rpcId: run.promptRequestId }), {
      surfaceOp: 'append',
    })
    const reply = session.append(
      'assistant/message',
      { turn: genTurn, step: 1, message: assistantMessage('FLICK'), stream: [] },
      { surfaceOp: 'append' },
    ).seq
    session.append('step/end', { turn: genTurn, step: 1 })
    session.append('turn/end', { turn: genTurn, reason: { kind: 'completed' } })
    const mid = session.snapshotEvents()
    const record = PLUGIN.rerunLedger(mid).reruns.find((entry) => entry.rerunId === run.rerunId)
    for (const write of PLUGIN.buildReplayWrites(
      mid,
      { logFrom: record.replayFrom, logTo: record.logTo, promptSeq: record.promptSeq, shadowed: record.shadowed },
      PLUGIN.lastTurnOf(mid) + 1,
      run.rerunId,
      session.seq,
      false,
    )) {
      if (write.surfaceOp === undefined) session.append(write.type, write.data)
      else session.append(write.type, write.data, { surfaceOp: write.surfaceOp, sourceEventSeqs: write.sourceEventSeqs })
    }
    runs.push({ run, record, reply })
    target = reply
  }

  const finalEvents = session.snapshotEvents()
  const artifact = officialRoundTrip(finalEvents, { id: session.id, createdAt: Date.now() })
  const reloaded = Session.create(session.id, artifact.events, {
    version: SESSION_FORMAT_VERSION,
    id: session.id,
    createdAt: Date.now(),
    isSeeded: false,
  })
  ok('three reruns of the same turn pass the strict cold read', () => {
    assert.equal(artifact.events.length, finalEvents.length)
    assert.equal(PLUGIN.rerunLedger(finalEvents).reruns.filter((entry) => entry.complete).length, 3)
  })
  ok('no rerun left a turn that holds only the carrier', () => {
    // 0.1.25's log: one carrier turn per rerun (four extra brackets here). Now
    // the shadow is one turn-free user/message, so a rerun adds exactly ONE
    // turn - the regenerated one - and every bracket holds a real exchange.
    const turns = finalEvents.filter((event) => event.type === 'turn/start')
    assert.deepEqual(
      turns.map((event) => event.data.turn),
      turns.map((_turn, index) => index + 1),
      'turn numbers are 1..N with no hole',
    )
    // Three reruns wrote three shadow events; not one of them bought a turn.
    assert.equal(finalEvents.filter((event) => PLUGIN.isRerunCarrier(event)).length, 3)
    assert.deepEqual(emptyTurnBrackets(finalEvents, reloaded), [])
  })
  ok('every carrier holds no readable text, in the shape this host proves safe', () => {
    const carriers = finalEvents.filter((event) => PLUGIN.isRerunCarrier(event))
    assert.equal(carriers.length, 3)
    for (const carrier of carriers) {
      assert.equal(carrier.type, 'user/message')
      assert.deepEqual(carrier.data.content, CARRIER_CONTENT)
      assert.equal(PLUGIN.isSilentPluginCarrier(carrier), true, 'no carrier is ever offered as a prompt')
      assert.equal(carrier.data.source.kind, 'plugin:dsh-rerun-turn')
      assert.equal(carrier.data.turn, undefined)
    }
    const shape = derivedShape(reloaded)
    assert.equal(shape.filter((row) => row === 'user:<carrier>').length, 3, 'the carriers are the only blank rows')
    // Each rerun re-sends its own prompt and replays the single surviving tail
    // turn, so the conversation stays two exchanges long however many times the
    // button is pressed - exactly what the 0.1.25 log derived, minus the
    // bookkeeping the carrier turn used to leave in the turn numbering.
    assert.deepEqual(modelShape(reloaded), [
      'system:SYSTEM PROMPT',
      'user:Reply with exactly: FLICK',
      'assistant:FLICK',
      'user:Reply with exactly: FLICK',
      'assistant:FLICK',
    ])
  })
  ok('the turn-free carrier needs no turn-level hiding at all', () => {
    // 0.1.14-0.1.25 shipped `markerTurns` so the client could hide the
    // bookkeeping turns; with the carrier living outside every turn there is
    // nothing to hide by turn number, and the carrier row is retired by seq the
    // way every other retired row is.
    const ledger = PLUGIN.rerunLedger(finalEvents)
    assert.deepEqual(ledger.reruns.map((entry) => entry.carrierTurn), [null, null, null])
    for (const carrier of finalEvents.filter((event) => PLUGIN.isRerunCarrier(event))) {
      assert.ok(
        ledger.hidden.some((entry) => entry.seq === carrier.seq),
        'the carrier row is hidden by seq',
      )
    }
  })
}

console.log(`\n${passed} contract checks passed`)
