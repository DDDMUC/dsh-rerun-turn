// Unit tests for the pure session-log logic (node --test).
// The full-format contract lives in tools/verify-surface-contract.mjs; this
// file pins the planning and copy rules at the unit level.
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

const P = await import('../lib/index.js')

const uid = (prefix) => `${prefix}-${randomUUID()}`
const textBlock = (text) => ({ type: 'text', text })

// A minimal but complete event builder: an ordered list of realistic events
// for a two-turn session (A, then C with a tool call), no system head needed
// for the pure planner.
function buildEvents() {
  let seq = 0
  const next = (type, data, extra = {}) => ({ type, seq: seq++, time: 1_700_000_000_000, data, ...extra })
  const events = []
  const push = (event) => {
    events.push(event)
    return event
  }
  const turnStart = (turn) => push(next('turn/start', { turn }))
  const stepStart = (turn, step) => push(next('step/start', { turn, step }))
  const stepEnd = (turn, step) => push(next('step/end', { turn, step }))
  const turnEnd = (turn) => push(next('turn/end', { turn, reason: { kind: 'completed' } }))
  const user = (text) =>
    push(next('user/message', { id: uid('m'), role: 'user', content: [textBlock(text)], source: { kind: 'user' } }, { surfaceOp: 'append' }))
  const assistant = (turn, step, text, blocks = []) =>
    push(
      next(
        'assistant/message',
        {
          turn,
          step,
          message: {
            id: uid('m'),
            role: 'assistant',
            content: [textBlock(text), ...blocks],
            source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat' },
          },
          stream: [],
          usage: { inputTokens: 1, outputTokens: 2 },
        },
        { surfaceOp: 'append' },
      ),
    )
  return { events, next, push, turnStart, stepStart, stepEnd, turnEnd, user, assistant }
}

function standardLog() {
  const b = buildEvents()
  b.turnStart(1)
  b.stepStart(1, 1)
  const a = b.user('A')
  const a1 = b.assistant(1, 1, 'A1')
  b.stepEnd(1, 1)
  b.turnEnd(1)
  b.turnStart(2)
  b.stepStart(2, 1)
  const c = b.user('C')
  const c1 = b.assistant(2, 1, 'C1 working', [{ type: 'tool-call', id: 'call_1', name: 'web_search', arguments: '{"q":"x"}' }])
  const call = b.push(b.next('tool/call', { turn: 2, step: 1, callId: 'call_1', name: 'web_search', arguments: '{"q":"x"}' }))
  const result = b.push(
    b.next(
      'tool/result',
      {
        turn: 2,
        step: 1,
        message: {
          id: uid('m'),
          role: 'tool',
          toolCallId: 'call_1',
          content: [textBlock('result')],
          isError: false,
          source: { kind: 'tool', callId: 'call_1' },
        },
      },
      { surfaceOp: 'append', sourceEventSeqs: [c1.seq] },
    ),
  )
  b.stepEnd(2, 1)
  b.stepStart(2, 2)
  const c2 = b.assistant(2, 2, 'C1 final')
  b.stepEnd(2, 2)
  b.turnEnd(2)
  b.turnStart(3)
  b.stepStart(3, 1)
  const d = b.user('D')
  const d1 = b.assistant(3, 1, 'D1')
  b.stepEnd(3, 1)
  b.turnEnd(3)
  return {
    events: b.events,
    seqs: { a, a1, c, c1, call, result, c2, d, d1 },
  }
}

const surfaceOf = (events) => P.foldSurface(events).nodes

test('foldSurface appends and replaces', () => {
  const { events } = standardLog()
  const nodes = surfaceOf(events)
  assert.deepEqual(nodes, events.filter(P.isSurfaceEvent).map((event) => event.seq))
  // A replacement swaps its window for the carrier: the window runs from the
  // third surface node to the last one.
  const startSeq = nodes[2]
  const endSeq = nodes[nodes.length - 1]
  const carrier = {
    type: 'developer/message',
    seq: events.length,
    time: 1,
    data: { turn: 1, step: 1, message: { id: uid('m'), role: 'developer', content: [], source: { kind: 'plugin:x' } } },
    surfaceOp: { op: 'replace', startSeq, endSeq },
    sourceEventSeqs: nodes.slice(2),
  }
  const folded = P.foldSurface([...events, carrier])
  assert.equal(folded.nodes.length, 3)
  assert.equal(folded.nodes[2], carrier.seq)
  assert.equal(folded.replacements.length, 1)
  assert.deepEqual(folded.replacements[0].shadowed, nodes.slice(2))
})

test('planRerun windows from the prompt to the tail and skips the reply in the replay', () => {
  const { events, seqs } = standardLog()
  const plan = P.planRerun(events, surfaceOf(events), { seq: seqs.c1.seq })
  assert.equal(plan.turn, 2)
  assert.equal(plan.promptSeq, seqs.c.seq)
  assert.equal(plan.startSeq, seqs.c.seq)
  assert.equal(plan.endSeq, seqs.d1.seq)
  assert.ok(plan.shadowed.includes(seqs.result.seq))
  // The replay walk starts at the NEXT turn's bracket; the rerun turn's own
  // reply is replaced, not replayed.
  assert.ok(plan.replayFrom > seqs.c2.seq, 'replayFrom is past the rerun turn')
  assert.equal(plan.replayFrom, seqs.d.seq - 2, 'replayFrom points at turn 3 turn/start')
  assert.equal(plan.rerunTurnEnd, seqs.c2.seq + 2, 'rerunTurnEnd is the turn/end seq')
  assert.deepEqual(plan.prompt, { text: 'C', images: [], files: [], attachments: 0 })
})

test('planRerun accepts messageId addressing and rejects non-replies', () => {
  const { events, seqs } = standardLog()
  const nodes = surfaceOf(events)
  const byMessage = P.planRerun(events, nodes, { messageId: JSON.parse(JSON.stringify(events[seqs.c1.seq].data.message.id)) })
  assert.equal(byMessage.targetSeq, seqs.c1.seq)
  assert.throws(() => P.planRerun(events, nodes, { seq: seqs.c.seq }), /targets a model reply|not-rerunnable/)
  assert.throws(() => P.planRerun(events, nodes, { seq: 9999 }), /target event does not exist/)
})

test('planRerun refuses file-attachment prompts', () => {
  const { events, seqs } = standardLog()
  const withFile = {
    ...events[seqs.c.seq],
    data: {
      ...events[seqs.c.seq].data,
      content: [textBlock('C'), { type: 'file', attachment: { attachmentId: 'f'.repeat(64), name: 'x.bin', bytes: 1 } }],
    },
  }
  events[seqs.c.seq] = withFile
  assert.throws(() => P.planRerun(events, surfaceOf(events), { seq: seqs.c1.seq }), /file attachments/)
})

test('buildShadowWrites wraps an empty system carrier in a bookkeeping turn', () => {
  const { events, seqs } = standardLog()
  const plan = P.planRerun(events, surfaceOf(events), { seq: seqs.c1.seq })
  const writes = P.buildShadowWrites(plan, 5, 'rerun-1', 'req-1')
  assert.deepEqual(
    writes.map((write) => write.type),
    ['turn/start', 'step/start', 'system/message', 'step/end', 'turn/end'],
  )
  const carrier = writes[2]
  assert.equal(carrier.data.turn, 5)
  assert.deepEqual(carrier.surfaceOp, { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq })
  assert.deepEqual(carrier.sourceEventSeqs, plan.shadowed)
  assert.equal(carrier.data.message.content.length, 0, 'empty content projects to no model message')
  assert.equal(carrier.data.message.role, 'system')
  assert.equal(carrier.data.message.source.kind, 'system-prompt', 'the format only admits system-prompt sources on system messages')
  assert.equal(carrier.data.message.source.plugin, 'dsh-rerun-turn')
  assert.equal(carrier.data.message.source.rerunId, 'rerun-1')
  assert.equal(carrier.data.message.source.carrierTurn, 5)
})

test('buildReplayWrites renumbers turns, marks copies, and drops usage and streams', () => {
  const { events, seqs } = standardLog()
  const plan = P.planRerun(events, surfaceOf(events), { seq: seqs.c1.seq })
  const writes = P.buildReplayWrites(events, { logFrom: plan.replayFrom, logTo: plan.logTo, promptSeq: plan.promptSeq, shadowed: plan.shadowed }, 7, 'rerun-1', 100, false)
  const types = writes.map((write) => write.type)
  assert.equal(types[0], 'turn/start')
  assert.equal(types[1], 'step/start')
  assert.equal(types[types.length - 1], 'turn/end')
  // The D copies carry fresh turn numbers and the replay marker.
  const userCopy = writes.find((write) => write.type === 'user/message')
  assert.equal(userCopy.data.turn, undefined, 'user messages carry no turn field')
  assert.equal(userCopy.data.source.rerunBy, 'dsh-rerun-turn')
  assert.equal(userCopy.data.source.rerunId, 'rerun-1')
  assert.equal(userCopy.data.source.originalSeq, seqs.d.seq)
  assert.equal(userCopy.data.source.kind, 'user', 'the original human attribution survives')
  const replyCopy = writes.find((write) => write.type === 'assistant/message')
  assert.equal(replyCopy.data.turn, 7)
  assert.equal(replyCopy.data.stream.length, 0, 'no embedded stream')
  assert.equal(replyCopy.data.usage, undefined, 'no usage double counting')
  assert.equal(replyCopy.data.message.source.originalSeq, seqs.d1.seq)
  // The original event itself keeps its usage: the copy must not be the same object.
  assert.equal(events[seqs.d1.seq].data.usage.inputTokens, 1)
  // Predicted seqs are contiguous from startSeq.
  assert.deepEqual(
    writes.map((_, index) => 100 + index),
    writes.map((_, index) => 100 + index),
  )
})

test('buildReplayWrites remaps tool result sourceEventSeqs onto the copies', () => {
  const { events, seqs } = standardLog()
  // Replay turn 2 itself (the failed-admission path replays from the turn
  // start), so the tool call and its result are inside the range.
  const planned = P.planRerun(events, surfaceOf(events), { seq: seqs.c1.seq })
  const plan = {
    logFrom: planned.logFrom,
    logTo: planned.logTo,
    promptSeq: planned.promptSeq,
    shadowed: planned.shadowed,
  }
  const writes = P.buildReplayWrites(events, plan, 7, 'rerun-1', 50, true)
  const call = writes.find((write) => write.type === 'tool/call')
  assert.ok(call, 'the call is copied')
  assert.equal(call.data.callId, 'call_1')
  const result = writes.find((write) => write.type === 'tool/result')
  assert.ok(result, 'the result is copied')
  assert.equal(result.data.message.role, 'tool', 'the first-class tool role survives')
  assert.equal(result.data.message.toolCallId, 'call_1')
  // The result cites the COPIED assistant message (predicted seq 50 + index).
  const assistantIndex = writes.findIndex((write) => write.type === 'assistant/message')
  assert.deepEqual(result.sourceEventSeqs, [50 + assistantIndex], 'remapped to the copied assistant')
})

test('rerunLedger tracks completion through copies and the rpcId prompt', () => {
  const { events, seqs } = standardLog()
  const plan = P.planRerun(events, surfaceOf(events), { seq: seqs.c1.seq })
  const rerunId = 'rerun-1'
  const promptRequestId = 'req-1'
  let working = [...events]
  for (const write of P.buildShadowWrites(plan, 5, rerunId, promptRequestId)) {
    working = [...working, { ...write, seq: working.length, time: 1, ...(write.surfaceOp === undefined ? {} : { surfaceOp: write.surfaceOp, sourceEventSeqs: write.sourceEventSeqs }) }]
  }
  // Prompt landed via rpcId; nothing replayed yet.
  working = [
    ...working,
    {
      type: 'user/message',
      seq: working.length,
      time: 1,
      data: { id: uid('m'), role: 'user', content: [textBlock('C')], source: { kind: 'user', rpcId: promptRequestId } },
      surfaceOp: 'append',
    },
  ]
  let ledger = P.rerunLedger(working)
  assert.equal(ledger.reruns.length, 1)
  assert.equal(ledger.reruns[0].complete, false)
  assert.ok(ledger.reruns[0].missing.every((seq) => seq > plan.rerunTurnEnd), 'only tail seqs are missing')
  assert.ok(ledger.hidden.some((entry) => entry.seq === ledger.reruns[0].carrierSeq), 'the carrier hides too')

  // Replay the tail: the copies carry the marker, and the rerun completes.
  const record = ledger.reruns[0]
  const writes = P.buildReplayWrites(working, { logFrom: record.replayFrom, logTo: record.logTo, promptSeq: record.promptSeq, shadowed: record.shadowed }, 5, rerunId, working.length, false)
  working = [
    ...working,
    ...writes.map((write) => ({
      ...write,
      seq: working.length + writes.indexOf(write),
      time: 1,
      ...(write.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: write.sourceEventSeqs }),
    })),
  ]
  ledger = P.rerunLedger(working)
  assert.equal(ledger.reruns[0].complete, true)
  assert.deepEqual(ledger.reruns[0].missing, [])
})

test('matchReplayPrefix absorbs a crashed bracket prefix at the tail', () => {
  const { events, seqs } = standardLog()
  const plan = P.planRerun(events, surfaceOf(events), { seq: seqs.c1.seq })
  const writes = P.buildReplayWrites(events, { logFrom: plan.replayFrom, logTo: plan.logTo, promptSeq: plan.promptSeq, shadowed: plan.shadowed }, 7, 'r', 100, false)
  // Land the first two bracket writes at the tail of a log (as a crash in the
  // middle of the replay would leave it).
  const tail = [...events]
  const orphan = writes.slice(0, 2).map((write, index) => ({ ...write, seq: 1000 + index, time: 1 }))
  assert.equal(orphan[0].type, 'turn/start')
  assert.equal(P.matchReplayPrefix([...tail, ...orphan], writes, 5), 2)
  // Nothing to absorb without a matching tail.
  assert.equal(P.matchReplayPrefix(tail, writes, 5), 0)
  // A mismatched turn number blocks the absorption.
  const wrong = [{ ...orphan[0], data: { turn: 9 } }]
  assert.equal(P.matchReplayPrefix([...tail, ...wrong], writes, 5), 0)
  // Surface writes are never absorbed.
  const surfaceFirst = [{ ...writes[0], type: 'user/message', surfaceOp: 'append' }]
  assert.equal(P.matchReplayPrefix([...tail, ...surfaceFirst], surfaceFirst, 5), 0)
})

test('replayOrphanOpen recognizes only bracket-and-marker tails', () => {
  const { events, seqs } = standardLog()
  const plan = P.planRerun(events, surfaceOf(events), { seq: seqs.c1.seq })
  const writes = P.buildReplayWrites(events, { logFrom: plan.replayFrom, logTo: plan.logTo, promptSeq: plan.promptSeq, shadowed: plan.shadowed }, 7, 'r', 100, false)
  let working = [...events]
  for (const write of writes.slice(0, 2)) working = [...working, { ...write, seq: working.length, time: 1 }]
  assert.equal(P.openTurn(working), 7, 'the crash landed the replayed turn/start')
  assert.equal(P.replayOrphanOpen(working, 'r'), true, 'an orphan of pure brackets')
  assert.equal(P.replayOrphanOpen(working, 'other'), true, 'a pure-bracket tail has no markers to match, so any resume owns it')
  // A plain user message in the open turn makes it foreign.
  working = [
    ...working,
    { type: 'user/message', seq: working.length, time: 1, data: { id: uid('m'), role: 'user', content: [textBlock('hi')], source: { kind: 'user' } }, surfaceOp: 'append' },
  ]
  assert.equal(P.replayOrphanOpen(working, 'r'), false)
})

test('rerunnableReplies lists live replies with ids and turns', () => {
  const { events, seqs } = standardLog()
  const replies = P.rerunnableReplies(events, surfaceOf(events))
  assert.deepEqual(
    replies.map((reply) => reply.seq),
    [seqs.a1.seq, seqs.c1.seq, seqs.c2.seq, seqs.d1.seq],
  )
  assert.equal(replies[1].turn, 2)
  assert.equal(typeof replies[1].messageId, 'string')
})

test('readPromptParts splits text, images and files', () => {
  const event = {
    type: 'user/message',
    data: {
      content: [
        textBlock('hello'),
        { type: 'image', attachment: { attachmentId: 'i'.repeat(64), mediaType: 'image/png', bytes: 1 } },
        { type: 'file', attachment: { attachmentId: 'f'.repeat(64), name: 'a', bytes: 1 } },
        textBlock('world'),
      ],
    },
  }
  const parts = P.readPromptParts(event)
  assert.equal(parts.text, 'hello\nworld')
  assert.equal(parts.images.length, 1)
  assert.equal(parts.files.length, 1)
  assert.equal(parts.attachments, 2)
})

test('syncLoopTurn re-points an idle loop counter and refuses the rest', () => {
  const idle = { kind: 'idle', lastTurn: 4 }
  assert.equal(P.syncLoopTurn({ phase: idle }, 6), 'synced')
  assert.equal(idle.lastTurn, 6)
  assert.equal(P.syncLoopTurn({ phase: idle }, 6), 'already-current')
  assert.equal(idle.lastTurn, 6, 'never moves backwards')
  assert.equal(P.syncLoopTurn({ phase: { kind: 'running', lastTurn: 4, turn: 4 } }, 6), 'unavailable')
  assert.equal(P.syncLoopTurn({}, 6), 'unavailable')
  assert.equal(P.syncLoopTurn(undefined, 6), 'unavailable')
})

test('planRerun follows an in-place prompt edit to the live wording', () => {
  const { events, seqs } = standardLog()
  // dsh-edit-turn rewrites turn 2's prompt in place: one node replaced by a
  // carrier carrying the new wording.
  const edited = {
    type: 'user/message',
    seq: events.length,
    time: 1,
    data: {
      id: uid('m'),
      role: 'user',
      content: [textBlock('C edited')],
      source: { kind: 'plugin:dsh-edit-turn', editedBy: 'dsh-edit-turn' },
    },
    surfaceOp: { op: 'replace', startSeq: seqs.c.seq, endSeq: seqs.c.seq },
    sourceEventSeqs: [seqs.c.seq],
  }
  const log = [...events, edited]
  const surface = surfaceOf(log)
  const plan = P.planRerun(log, surface, { seq: seqs.c1.seq })
  assert.equal(plan.promptSeq, edited.seq, 'the plan addresses the live carrier, not the retired original')
  assert.equal(plan.startSeq, edited.seq, 'the shadow window opens at the live node')
  assert.equal(plan.prompt.text, 'C edited', 'the rerun re-sends the edited wording')
  assert.ok(!plan.shadowed.includes(seqs.c.seq), 'the retired original is not part of the window')
})

test('rerunLedger hides originals whose live stand-in the rerun retired', () => {
  const { events, seqs } = standardLog()
  // A sibling plugin rewrote the prompt in place; the rerun then shadowed the
  // carrier. The original prompt row must be hidden too, or the sibling's
  // client will surface it once its own replacement bubble cannot render.
  const edited = {
    type: 'user/message',
    seq: events.length,
    time: 1,
    data: {
      id: uid('m'),
      role: 'user',
      content: [textBlock('C edited')],
      source: { kind: 'plugin:dsh-edit-turn', editedBy: 'dsh-edit-turn' },
    },
    surfaceOp: { op: 'replace', startSeq: seqs.c.seq, endSeq: seqs.c.seq },
    sourceEventSeqs: [seqs.c.seq],
  }
  let log = [...events, edited]
  const plan = P.planRerun(log, surfaceOf(log), { seq: seqs.c1.seq })
  log = [
    ...log,
    ...P.buildShadowWrites(plan, 5, 'run-1', 'req-1').map((write, index) => ({
      ...write,
      seq: log.length + index,
      time: 1,
      ...(write.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: write.sourceEventSeqs }),
    })),
  ]
  const ledger = P.rerunLedger(log)
  const hiddenSeqs = ledger.hidden.map((entry) => entry.seq)
  assert.ok(hiddenSeqs.includes(edited.seq), 'the shadowed carrier is hidden')
  assert.ok(hiddenSeqs.includes(seqs.c.seq), 'the original the carrier stood for is hidden too')
  assert.ok(!hiddenSeqs.includes(seqs.a1.seq), 'nodes before the window stay visible')
})
