// dsh-rerun-turn - host half.
//
// Loopback-only JSON routes:
//
//   GET  /dsh-rerun-turn/state?sessionId=<id>
//   POST /dsh-rerun-turn/apply   { sessionId, seq|messageId }
//   POST /dsh-rerun-turn/replay  { sessionId, rerunId? }
//   GET  /dsh-rerun-turn/debug
//
// WHAT A RERUN IS
//
// The model context is re-derived from the session surface on every call, so
// re-running turn C is a *splice*: the surface loses the old reply and keeps
// every later turn, and the next call reads A B C1 D E F G. DSH's official
// surface-replace contract cannot express that directly - an assistant message
// may never carry `sourceEventSeqs`, so a reply can never be the replacement
// carrier (checked against the real validator, not assumed). A rerun is
// therefore three official operations, in order:
//
//   1. SHADOW  - one replace event whose window runs from the turn's prompt to
//      the last surface node. The window always ends at the tail, so a reply
//      and the tool calls/results it produced always leave together. The
//      carrier is an EMPTY `developer/message` inside its own closed turn
//      (empty content projects to no model message; the format reads a
//      developer message only inside an open turn and step, which is why the
//      carrier turn is opened and closed around it - the same shape the
//      sibling plugin dsh-edit-turn proved on this contract).
//
//   2. REGENERATE - the official prompt path (`sessionController.prompt`),
//      re-sending the turn's own prompt text/images. The model sees the
//      surviving prefix plus the re-sent prompt and answers fresh, with the
//      session's real tools.
//
//   3. REPLAY - every shadowed event after the prompt is appended back,
//      verbatim except for: fresh turn numbers (the log requires them
//      contiguous), fresh message ids, remapped `sourceEventSeqs` on tool
//      results, dropped usage numbers and embedded streams, and a source
//      marker (`rerunBy`/`rerunId`/`originalSeq`) that lets this plugin - or
//      a sibling - tell a replayed event from its retired original. The
//      replayed turns go into the log as ordinary turns, so cold reads,
//      exports and other instances see exactly what the model sees.
//
// The append-only log is never rewritten. Uninstalling the plugin keeps every
// landed rerun: the operations are official events.
//
// RECOVERY
//
// Generation can take minutes; a crash mid-rerun is a real state. The carrier
// names the operation (`rerunId`), the fold records exactly which surface
// nodes it shadowed, and every replayed event cites its `originalSeq` - so
// "which copies are missing" is always computable from the log alone, and the
// missing suffix can be replayed later without the model. `/state` reports
// incomplete reruns and, by default, resumes them automatically when the
// session is live, idle and its inbox is empty.
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)
const schemaPackage = (() => {
  try {
    return nodeRequire('@deepseek-ai/schemastery')
  } catch {
    return null
  }
})()
const z = schemaPackage === null ? null : (schemaPackage.default ?? schemaPackage)

/** Plugin id shared by the host and browser halves. */
export const PLUGIN_ID = 'dsh-rerun-turn'

/** Cordis plugin name. */
export const name = PLUGIN_ID

/** Keep in sync with package.json and lib/client.js. */
export const PLUGIN_VERSION = '0.1.14'

const ROUTE_PREFIX = '/dsh-rerun-turn'
const SESSION_ID_RE = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PROMPT_DEADLINE_MS = 30_000
const FLUSH_DEADLINE_MS = 5_000
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000
const REPLAY_DEFER_MS = 2_000
const REPLAY_DEFER_MAX = 30

// A ring of the last few requests, answering "did the browser half even ask,
// and what did it get?" without needing its console.
const REQUEST_LOG_LIMIT = 40
const requestLog = []

/** Record one request for the diagnostic route. */
export function noteRequest(entry) {
  requestLog.push({ at: Date.now(), ...entry })
  if (requestLog.length > REQUEST_LOG_LIMIT) requestLog.shift()
}

/** The recorded requests, oldest first. */
export function recentRequests() {
  return requestLog.slice()
}

export const Config =
  z === null
    ? undefined
    : z.object({
        /**
         * Whether the client asks for a second confirmation before rerunning.
         * Off by default: the button is an explicit action, and its tooltip
         * states what it does.
         */
        confirm: z.boolean().default(false),
        /**
         * Whether `/state` resumes an interrupted rerun's replay on its own
         * (session live, idle, inbox empty). On by default: a rerun that died
         * mid-flight would otherwise leave the later turns out of the model
         * context until someone pressed "complete replay".
         */
        autoResume: z.boolean().default(true),
        /**
         * How long the rerun waits for the regenerated turn to settle before
         * giving up on in-process replay (the replay then waits for a resume).
         */
        idleTimeoutMs: z.number().default(DEFAULT_IDLE_TIMEOUT_MS),
        /**
         * Whether the loopback dev routes are mounted: `POST /dev/scratch`
         * creates a throwaway session and drives a few short turns, and
         * `GET /dev/derived` reports the live derived context. They exist for
         * end-to-end verification and spend real model calls, so they stay off
         * unless a deployment explicitly turns them on.
         */
        devTools: z.boolean().default(false),
      })

// ---------------------------------------------------------------------------
// pure session-log logic (no DSH SDK imports; unit-testable under node --test)
// ---------------------------------------------------------------------------

/** The five event types that may carry `surfaceOp` (official surface contract). */
const SURFACE_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

/**
 * Whether one event participates in the model-visible surface.
 * @param event - raw session event.
 * @returns true for a message-producing event type.
 */
export function isSurfaceEvent(event) {
  const type = event && event.type
  return typeof type === 'string' && SURFACE_TYPES.has(type)
}

/**
 * Replay the surface operations of a complete log.
 *
 * Mirrors the official fold: `append` pushes the event onto the tail; a
 * `replace` swaps the inclusive window between its two surface nodes for the
 * replacing event. Replacements whose anchors are no longer present are
 * skipped defensively - a corrupt log must not throw inside an HTTP handler.
 *
 * @param events - complete contiguous raw event log in seq order.
 * @returns current surface seqs in model order plus every landed replacement.
 */
export function foldSurface(events) {
  const nodes = []
  const replacements = []
  for (const event of events) {
    const op = event.surfaceOp
    if (op === undefined) continue
    if (op === 'append') {
      nodes.push(event.seq)
      continue
    }
    if (op === null || typeof op !== 'object' || op.op !== 'replace') continue
    const startIdx = nodes.indexOf(op.startSeq)
    const endIdx = nodes.indexOf(op.endSeq)
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) continue
    const shadowed = nodes.slice(startIdx, endIdx + 1)
    nodes.splice(startIdx, endIdx - startIdx + 1, event.seq)
    replacements.push({ seq: event.seq, startSeq: op.startSeq, endSeq: op.endSeq, shadowed })
  }
  return { nodes, replacements }
}

/**
 * Map every event seq to the turn that encloses it.
 *
 * Turn brackets are the durable source for user messages (their payload has no
 * turn field); assistant and tool events carry their own turn and override the
 * bracket reading.
 *
 * @param events - complete contiguous raw event log.
 * @returns seq -> turn number (undefined outside any turn).
 */
export function turnIndex(events) {
  const turnOf = new Map()
  let current
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = event.data && event.data.turn
      turnOf.set(event.seq, current)
      continue
    }
    if (event.type === 'turn/end') {
      turnOf.set(event.seq, current)
      current = undefined
      continue
    }
    const data = event.data
    const explicit =
      (event.type === 'assistant/message' || event.type === 'tool/result' || event.type === 'tool/call') &&
      data &&
      typeof data.turn === 'number'
        ? data.turn
        : undefined
    turnOf.set(event.seq, explicit !== undefined ? explicit : current)
  }
  return turnOf
}

/**
 * One turn bracket: its number, log range, first prompt and reply count.
 * @param events - complete contiguous raw event log.
 * @returns one entry per `turn/start`, in log order.
 */
export function turnSpans(events) {
  const spans = []
  let open = null
  for (const event of events) {
    if (event.type === 'turn/start') {
      open = {
        turn: event.data && event.data.turn,
        startSeq: event.seq,
        endSeq: null,
        promptSeq: null,
        replies: 0,
      }
      spans.push(open)
      continue
    }
    if (open === null) continue
    if (event.type === 'turn/end') {
      open.endSeq = event.seq
      open = null
      continue
    }
    if (event.type === 'user/message' && open.promptSeq === null) open.promptSeq = event.seq
    if (event.type === 'assistant/message') open.replies += 1
  }
  return spans
}

/** The turn still awaiting its `turn/end`, or null when every turn closed. */
export function openTurn(events) {
  let open = null
  for (const event of events) {
    if (event.type === 'turn/start') open = event.data && event.data.turn
    else if (event.type === 'turn/end' && (open === null || event.data.turn === open)) open = null
  }
  return open
}

/**
 * Whether the trailing open turn is a crash-orphan of this plugin's replay.
 *
 * A replay dies mid-batch only between two appends, and the bracket events it
 * writes carry no marker - so the orphan shows up as an open turn holding
 * nothing but turn/step brackets, `tool/call` copies, and this rerun's own
 * marked copies. Any real turn in flight carries a plain user or assistant
 * message and fails the test, as does a regenerated turn that never closed.
 *
 * @param events - complete contiguous raw event log.
 * @param rerunId - the rerun whose replay may have died.
 * @returns true when the open turn belongs to this plugin's interrupted write.
 */
export function replayOrphanOpen(events, rerunId) {
  let openSeq = -1
  for (const event of events) {
    if (event.type === 'turn/start') openSeq = event.seq
    else if (event.type === 'turn/end') openSeq = -1
  }
  if (openSeq === -1) return false
  for (let seq = openSeq; seq < events.length; seq += 1) {
    const event = events[seq]
    if (event.type === 'turn/start' || event.type === 'step/start' || event.type === 'step/end' || event.type === 'turn/end' || event.type === 'tool/call') continue
    const marker = replayMarkerOf(event)
    if (marker !== null && marker.rerunId === rerunId) continue
    return false
  }
  return true
}

/** Whether an operation is in flight that will still write the surface. */
export function isBusy(events) {
  if (openTurn(events) !== null) return true
  let compaction = false
  for (const event of events) {
    if (event.type === 'compaction/start') compaction = true
    else if (event.type === 'compaction/end') compaction = false
  }
  return compaction
}

/**
 * Durable message identity of one surface event.
 * @param event - raw session event.
 * @returns the message id, or undefined for an event without one.
 */
export function messageIdOf(event) {
  const data = event.data
  if (!data || typeof data !== 'object') return undefined
  if (event.type === 'user/message') return typeof data.id === 'string' ? data.id : undefined
  if (event.type === 'assistant/message' || event.type === 'tool/result' || event.type === 'system/message') {
    const message = data.message
    return message && typeof message.id === 'string' ? message.id : undefined
  }
  return undefined
}

/** Highest turn number recorded in the log, or 0 for an empty log. */
export function lastTurnOf(events) {
  let last = 0
  for (const event of events) {
    const turn = event.data && event.data.turn
    if (typeof turn === 'number' && turn > last) last = turn
  }
  return last
}

/**
 * Prompt-facing parts of a user message: plain text plus the durable
 * attachment references a rerun would have to re-admit.
 * @param event - raw `user/message` event.
 * @returns `{ text, images, files, attachments }`.
 */
export function readPromptParts(event) {
  const data = (event && event.data) || {}
  const blocks = Array.isArray(data.content) ? data.content : []
  const text = []
  const images = []
  const files = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') text.push(block.text)
    else if (block.type === 'image' && block.attachment) images.push(block.attachment)
    else if (block.type === 'file' && block.attachment) files.push(block.attachment)
  }
  return { text: text.join('\n'), images, files, attachments: images.length + files.length }
}

/** Whether the message source records a replay by this plugin. */
export function replayMarkerOf(event) {
  const data = event && event.data
  if (!data || typeof data !== 'object') return null
  const message = data.message && typeof data.message === 'object' ? data.message : data
  const source = message && message.source
  if (!source || typeof source !== 'object' || source.rerunBy !== PLUGIN_ID) return null
  return {
    rerunId: typeof source.rerunId === 'string' ? source.rerunId : null,
    originalSeq: typeof source.originalSeq === 'number' ? source.originalSeq : null,
  }
}

/**
 * Whether one event is a replacement carrier this plugin landed for a rerun.
 *
 * Current shape: an empty `system/message` whose source is the canonical
 * system-prompt kind plus our own `plugin` marker (the format only admits
 * system-prompt sources on system messages). Older releases used developer or
 * user carriers with a `plugin:<id>` kind; both stay recognised so ledgers
 * over historical logs remain correct.
 */
export function isRerunCarrier(event) {
  if (!event) return false
  const type = event.type
  if (type !== 'developer/message' && type !== 'user/message' && type !== 'system/message') return false
  const data = event.data || {}
  const message = data.message && typeof data.message === 'object' ? data.message : data
  const source = message && message.source
  if (!source || typeof source.rerunId !== 'string') return false
  if (source.rerunBy !== PLUGIN_ID) return false
  if (source.kind === `plugin:${PLUGIN_ID}`) return true
  return source.kind === 'system-prompt' && source.plugin === PLUGIN_ID
}

/**
 * Build this plugin's rerun ledger from the log alone.
 *
 * Every rerun is one replacement whose carrier source is
 * `{ kind: 'plugin:dsh-rerun-turn', rerunBy, rerunId, ... }`. A replacement
 * landed by any other producer - compaction, dsh-edit-turn - is ignored.
 *
 * @param events - complete contiguous raw event log.
 * @returns `{ hidden, reruns }`: one hidden entry per retired or carrier seq,
 *   and one record per landed rerun with its replay progress.
 */
export function rerunLedger(events) {
  const folded = foldSurface(events)
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const turnOf = turnIndex(events)
  // Replacement lineage: shadowed seq -> replacement seq. A retired node may
  // itself be the stand-in for an older original (dsh-edit-turn rewrote a
  // prompt in place), and hiding must reach the original too - the sibling
  // plugin's client will surface that original row itself when its own
  // replacement bubble can no longer render.
  const revisions = new Map()
  for (const replacement of folded.replacements) {
    for (const seq of replacement.shadowed) revisions.set(seq, replacement.seq)
  }
  /** Whether following a node's replacement chain runs into this window. */
  const chainHits = (seq, shadowedSet) => {
    let current = revisions.get(seq)
    const seen = new Set([seq])
    while (current !== undefined && !seen.has(current)) {
      if (shadowedSet.has(current)) return true
      seen.add(current)
      current = revisions.get(current)
    }
    return false
  }
  const hidden = []
  const reruns = []
  for (const replacement of folded.replacements) {
    const carrier = bySeq.get(replacement.seq)
    if (!isRerunCarrier(carrier)) continue
    const carrierData = carrier.data || {}
    const carrierMessage = carrierData.message && typeof carrierData.message === 'object' ? carrierData.message : carrierData
    const source = carrierMessage.source
    const rerunId = source.rerunId
    const shadowedSet = new Set(replacement.shadowed)
    for (const seq of replacement.shadowed) {
      const turn = turnOf.get(seq)
      hidden.push({ seq, turn: typeof turn === 'number' ? turn : null, rerunId })
    }
    // Every original whose live stand-in this rerun retired is retired too:
    // its row would otherwise reappear (the sibling edit plugin's client
    // un-hides an original once its own replacement bubble cannot render).
    const already = new Set(replacement.shadowed)
    for (const seq of revisions.keys()) {
      if (already.has(seq)) continue
      if (!chainHits(seq, shadowedSet)) continue
      already.add(seq)
      const turn = turnOf.get(seq)
      hidden.push({ seq, turn: typeof turn === 'number' ? turn : null, rerunId })
    }
    // The carrier row itself is retired too: the synthetic turn around it has
    // no visible content, and hiding its seq takes any turn-tail strip with it.
    hidden.push({ seq: replacement.seq, turn: null, rerunId })
    // Replay progress: every shadowed surface seq needs a later copy citing it,
    // except the prompt itself, which the regeneration re-sends (spotted by its
    // rpcId) or - when admission failed - replays as a copy like the rest.
    const covered = new Set()
    for (const event of events) {
      if (event.seq <= replacement.seq) continue
      const marker = replayMarkerOf(event)
      if (marker !== null && marker.rerunId === rerunId && marker.originalSeq !== null) covered.add(marker.originalSeq)
    }
    const promptRequestId = typeof source.promptRequestId === 'string' ? source.promptRequestId : null
    let promptLanded = false
    if (promptRequestId !== null) {
      promptLanded = events.some((event) => {
        if (event.seq <= replacement.seq || event.type !== 'user/message') return false
        const promptSource = event.data && event.data.source
        return Boolean(promptSource && promptSource.kind === 'user' && promptSource.rpcId === promptRequestId)
      })
    }
    const walkTo = typeof source.logTo === 'number' ? source.logTo : Number.POSITIVE_INFINITY
    // The walk the replay actually takes: with the prompt landed it starts at
    // the next turn's bracket (`replayFrom`; absent = no tail to replay), and
    // without it - the failed-admission fallback - it reproduces the whole
    // window from the rerun turn's own bracket (`logFrom`).
    const tailFrom = typeof source.replayFrom === 'number' ? source.replayFrom : null
    const fallbackFrom = typeof source.logFrom === 'number' ? source.logFrom : null
    const expectsCopy = (seq) => {
      const from = promptLanded ? tailFrom : fallbackFrom
      return from !== null && seq >= from && seq <= walkTo
    }
    const missing = []
    for (const seq of replacement.shadowed) {
      // The prompt itself: covered by the rpcId event, or by its own copy when
      // the regeneration never happened. Its seq can sit anywhere - an in-place
      // rewrite by a sibling plugin leaves the live prompt as a late carrier -
      // so it is classified first.
      if (seq === source.promptSeq) {
        if (!promptLanded && !covered.has(seq)) missing.push(seq)
        continue
      }
      // Everything else needs a copy exactly when the replay walk covers it
      // (its originalSeq is cited by the copy). Nodes the rerun turn itself
      // produced, and any surface node outside the walked range, are retired
      // without copies.
      if (expectsCopy(seq) && !covered.has(seq)) missing.push(seq)
    }
    reruns.push({
      rerunId,
      carrierSeq: replacement.seq,
      startSeq: replacement.startSeq,
      endSeq: replacement.endSeq,
      shadowed: replacement.shadowed,
      promptSeq: typeof source.promptSeq === 'number' ? source.promptSeq : null,
      promptRequestId,
      replayFrom: typeof source.replayFrom === 'number' ? source.replayFrom : null,
      logFrom: typeof source.logFrom === 'number' ? source.logFrom : null,
      logTo: typeof source.logTo === 'number' ? source.logTo : null,
      rerunTurnEnd: typeof source.rerunTurnEnd === 'number' ? source.rerunTurnEnd : null,
      turn: typeof source.turn === 'number' ? source.turn : null,
      // The synthetic bookkeeping turn the carrier lives in; the client hides
      // its rows (an empty turn still draws a process/tail strip).
      carrierTurn: typeof source.carrierTurn === 'number' ? source.carrierTurn : null,
      complete: missing.length === 0,
      missing,
    })
  }
  return { hidden, reruns }
}

/** Planner rejection with a machine code the HTTP layer forwards verbatim. */
export class RerunPlanError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'RerunPlanError'
    this.code = code
  }
}

/**
 * Resolve one rerun target inside a log: the reply the button was pressed on.
 * @param events - complete contiguous raw event log.
 * @param request - `{ seq?, messageId? }`.
 * @returns the target assistant event.
 * @throws {RerunPlanError} with `not-rerunnable` when no unique target exists.
 */
function resolveTarget(events, request) {
  let targetSeq = typeof request.seq === 'number' ? request.seq : undefined
  if (targetSeq === undefined && typeof request.messageId === 'string' && request.messageId !== '') {
    for (const event of events) {
      if (messageIdOf(event) === request.messageId) {
        targetSeq = event.seq
        break
      }
    }
  }
  if (targetSeq === undefined) throw new RerunPlanError('not-rerunnable', 'no rerun target was found')
  const target = events.find((event) => event.seq === targetSeq)
  if (!target) throw new RerunPlanError('not-rerunnable', 'the target event does not exist')
  if (target.type !== 'assistant/message') {
    throw new RerunPlanError('not-rerunnable', 'rerunning targets a model reply')
  }
  return target
}

/**
 * Plan one rerun: the target turn, the shadow window, the log range the replay
 * walks, and the prompt the regeneration re-sends.
 *
 * The window is `[the turn's own prompt .. the last surface node]` - the
 * complete remainder of the conversation in surface order. The prompt is what
 * the rerun re-sends; everything the turn produced and everything built on it
 * is shadowed now and replayed after the fresh answer lands.
 *
 * @param events - complete contiguous raw event log.
 * @param surfaceNodes - current surface seqs in model order.
 * @param request - `{ seq?, messageId? }` addressing a reply.
 * @returns the plan (without `rerunId`, which the caller mints).
 * @throws {RerunPlanError} with a stable code when the target cannot be planned.
 */
export function planRerun(events, surfaceNodes, request) {
  const nodeIndex = new Map(surfaceNodes.map((seq, index) => [seq, index]))
  const turnOf = turnIndex(events)
  const target = resolveTarget(events, request)
  if (!nodeIndex.has(target.seq)) {
    throw new RerunPlanError('already-retired', 'this reply is no longer on the current surface')
  }
  if (target.seq === surfaceNodes[0]) {
    throw new RerunPlanError('not-rerunnable', 'the system prompt head cannot be rerun')
  }
  const turn = turnOf.get(target.seq)
  if (typeof turn !== 'number') {
    throw new RerunPlanError('not-rerunnable', 'the reply does not belong to a turn')
  }
  const span = turnSpans(events).find((entry) => entry.turn === turn)
  if (!span || typeof span.promptSeq !== 'number') {
    throw new RerunPlanError('not-rerunnable', 'the turn has no prompt to re-send')
  }
  // The turn's prompt AS THE SURFACE SHOWS IT NOW: a sibling plugin editing a
  // prompt in place (dsh-edit-turn replaces one node with the new wording)
  // shadows the original event and stands in its place. Following that chain
  // is a documented cross-plugin contract; without it a rerun on a turn whose
  // prompt was edited dies on `already-retired` while the UI still offers it.
  const revisions = new Map()
  for (const replacement of foldSurface(events).replacements) {
    for (const seq of replacement.shadowed) revisions.set(seq, replacement.seq)
  }
  let livePromptSeq = span.promptSeq
  {
    const seen = new Set()
    while (!nodeIndex.has(livePromptSeq)) {
      const next = revisions.get(livePromptSeq)
      if (next === undefined || seen.has(livePromptSeq)) {
        throw new RerunPlanError('already-retired', 'the turn prompt is no longer on the current surface')
      }
      seen.add(livePromptSeq)
      livePromptSeq = next
    }
  }
  const promptEvent = events[livePromptSeq]
  if (!promptEvent || promptEvent.type !== 'user/message') {
    throw new RerunPlanError('not-rerunnable', 'the turn prompt is not a user message')
  }
  if (livePromptSeq === surfaceNodes[0]) {
    throw new RerunPlanError('not-rerunnable', 'the system prompt head cannot be rerun')
  }
  const shadowed = surfaceNodes.slice(nodeIndex.get(livePromptSeq))
  if (shadowed.length === 0 || shadowed[0] !== livePromptSeq) {
    throw new RerunPlanError('not-rerunnable', 'the prompt does not open a rerun window')
  }
  if (promptEvent.data && Array.isArray(promptEvent.data.content)) {
    const files = promptEvent.data.content.filter((block) => block && block.type === 'file')
    if (files.length > 0) {
      throw new RerunPlanError('attachments-unsupported', 'the turn prompt carries file attachments, which a rerun cannot re-admit yet')
    }
  }
  // The replay walks the tail AFTER the rerun turn: the shadowed window is
  // [the prompt .. the last surface node], but the rerun turn's own reply is
  // replaced by the fresh answer, not replayed - only the later turns come
  // back. When the prompt never lands (admission failed), the walk falls back
  // to the rerun turn's own `turn/start`, so the copies reproduce the whole
  // window and the context keeps its content.
  const lastShadowed = shadowed[shadowed.length - 1]
  let logTo = lastShadowed
  for (let seq = lastShadowed + 1; seq < events.length; seq += 1) {
    const event = events[seq]
    if (isSurfaceEvent(event)) break
    logTo = seq
    if (event.type === 'turn/end') break
  }
  const spans = turnSpans(events)
  const spanIndex = spans.findIndex((entry) => entry.turn === turn)
  const nextSpan = spanIndex >= 0 ? spans[spanIndex + 1] : undefined
  const replayFrom = nextSpan && nextSpan.startSeq <= logTo ? nextSpan.startSeq : null
  const parts = readPromptParts(promptEvent)
  return {
    turn,
    targetSeq: target.seq,
    promptSeq: livePromptSeq,
    startSeq: shadowed[0],
    endSeq: shadowed[shadowed.length - 1],
    shadowed,
    // The seq where the replay's copies start in the normal path - the next
    // turn's own bracket - and the fallback start (the rerun turn's bracket)
    // for the failed-admission replay. `rerunTurnEnd` closes the rerun turn;
    // its surface nodes are retired without copies.
    replayFrom,
    logFrom: span.startSeq,
    logTo,
    rerunTurnEnd: span.endSeq,
    prompt: parts,
  }
}

/**
 * The silent carrier of the shadow step.
 *
 * The replacement carrier has to be a surface event with complete
 * `sourceEventSeqs` coverage of the shadowed window, and it must not leave a
 * message the model can read. An EMPTY `system/message` is the one shape that
 * satisfies both: `deriveMessages()` drops empty system nodes entirely, so the
 * model input never contains it (unlike a zero-width or marker user message,
 * which the model sees and comments on). The format requires system messages
 * to come from a system-prompt source, and reads them only inside an open turn
 * and step - so the carrier travels inside a synthetic bookkeeping turn whose
 * number is the log's next turn (`turn/end` count + 1), and the caller
 * re-points an idle loop's turn counter at that number so the regenerated turn
 * opens N+1 (the shape validated in dsh-delete-turn 0.2.x on DSH 0.2.0).
 */
const CARRIER_SOURCE_KIND = 'system-prompt'

/**
 * Build the writes of the shadow step: a synthetic bookkeeping turn holding
 * one empty `system/message` replacement over the whole window.
 *
 * @param plan - the planned window.
 * @param turn - the turn number the bookkeeping turn occupies (N).
 * @param rerunId - the operation identity the recovery path keys on.
 * @param promptRequestId - the `rpcId` the regenerated prompt will carry.
 * @returns an ordered `{ type, data }` list: turn bracket, carrier, closers.
 */
export function buildShadowWrites(plan, turn, rerunId, promptRequestId) {
  const carrier = {
    type: 'system/message',
    surfaceOp: { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq },
    sourceEventSeqs: plan.shadowed,
    data: {
      turn,
      step: 1,
      message: {
        id: randomUUID(),
        role: 'system',
        content: [],
        source: {
          kind: CARRIER_SOURCE_KIND,
          plugin: PLUGIN_ID,
          rerunBy: PLUGIN_ID,
          rerunId,
          promptRequestId,
          promptSeq: plan.promptSeq,
          turn: plan.turn,
          carrierTurn: turn,
          replayFrom: plan.replayFrom,
          logFrom: plan.logFrom,
          logTo: plan.logTo,
          rerunTurnEnd: plan.rerunTurnEnd,
        },
      },
    },
  }
  return [
    { type: 'turn/start', data: { turn } },
    { type: 'step/start', data: { turn, step: 1 } },
    carrier,
    { type: 'step/end', data: { turn, step: 1 } },
    { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
  ]
}

/** Source marker shared by every event a replay appends. */
function replaySource(source, rerunId, originalSeq) {
  return {
    ...(source && typeof source === 'object' ? source : {}),
    rerunBy: PLUGIN_ID,
    rerunId,
    originalSeq,
  }
}

/**
 * Build the replay writes for one rerun's shadowed log range.
 *
 * Every shadowed event after the prompt is copied verbatim except for:
 * fresh turn numbers (the format requires them contiguous), fresh message
 * ids, remapped `sourceEventSeqs` on tool results, dropped usage numbers and
 * embedded streams, and the replay marker in each message source. System
 * messages are skipped - the system prompt is loop-owned machinery that
 * reconciles itself on the next request. Log-only records (attempts, retries,
 * splices, title/request bookkeeping) are skipped too: they describe the
 * original run, not the conversation.
 *
 * Tool calls are copied only as complete pairs. A call whose result never
 * landed (an interrupted turn) is dropped along with its advertisement in the
 * copied assistant content, because the format refuses a turn that closes with
 * an unresolved call. The inverse repair shape - a `TOOL_NOT_STARTED` result
 * with no call event - is copied as-is and keeps its absent
 * `sourceEventSeqs`: the validator accepts that repair only without one.
 *
 * @param events - complete contiguous raw event log.
 * @param plan - the planned window (`logFrom`..`logTo`).
 * @param baseTurn - the first turn number the replay may use.
 * @param rerunId - the operation identity.
 * @param startSeq - the seq the first write will land at (all writes are
 *   appended back to back, so each predicted seq is `startSeq` + its offset).
 * @param promptCopied - whether the prompt itself is part of the replay
 *   (admission failed); when false the walk skips the prompt event.
 * @returns an ordered `{ type, data, surfaceOp? }` write list.
 */
export function buildReplayWrites(events, plan, baseTurn, rerunId, startSeq, promptCopied) {
  // Replay EXACTLY the surface nodes the rerun shadowed - never the raw log
  // range. After earlier reruns the range can contain retired originals (and
  // retired replacement carriers) that are no longer on the surface; copying
  // them would resurrect content the conversation no longer has in its context
  // and grow a duplicate history with every chained rerun. Log-only companions
  // (turn/step brackets, tool calls) are included only for turns that still
  // own a shadowed node.
  const shadowedSet = new Set(plan.shadowed)
  const turnOf = turnIndex(events)
  const shadowedTurns = new Set()
  for (const seq of plan.shadowed) {
    const turn = turnOf.get(seq)
    if (typeof turn === 'number') shadowedTurns.add(turn)
  }
  const included = (event) => {
    if (isSurfaceEvent(event)) return shadowedSet.has(event.seq)
    if (
      event.type === 'turn/start' ||
      event.type === 'turn/end' ||
      event.type === 'step/start' ||
      event.type === 'step/end' ||
      event.type === 'tool/call'
    ) {
      return typeof event.data.turn === 'number' && shadowedTurns.has(event.data.turn)
    }
    return false
  }
  const range = []
  for (let seq = plan.logFrom; seq <= plan.logTo && seq < events.length; seq += 1) {
    const event = events[seq]
    if (included(event)) range.push(event)
  }
  // Tool pairing facts for the whole range, so assistant content can be
  // corrected before anything is written.
  const calledIds = new Set()
  const resultIds = new Set()
  const repairIds = new Set()
  for (const event of range) {
    if (event.type === 'tool/call') calledIds.add(event.data.callId)
    else if (event.type === 'tool/result') {
      resultIds.add(event.data.message && event.data.message.source ? event.data.message.source.callId : event.data.callId)
      const error = event.data.error
      if (error && error.name === 'ToolNotStartedError' && error.code === 'TOOL_NOT_STARTED' && event.sourceEventSeqs === undefined) {
        repairIds.add(event.data.message && event.data.message.source ? event.data.message.source.callId : event.data.callId)
      }
    }
  }
  const healthyIds = new Set()
  for (const id of calledIds) if (resultIds.has(id)) healthyIds.add(id)
  for (const id of repairIds) if (!calledIds.has(id)) healthyIds.add(id)
  const pairedResultIds = new Set()
  for (const id of calledIds) if (resultIds.has(id)) pairedResultIds.add(id)
  for (const id of repairIds) if (!calledIds.has(id)) pairedResultIds.add(id)

  const writes = []
  let predicted = startSeq
  let nextTurn = baseTurn
  const turnMap = new Map()
  const assistantSeqById = new Map()
  let lastAssistantSeq = null
  const seqOf = () => {
    const seq = predicted
    predicted += 1
    return seq
  }
  for (const event of range) {
    const data = event.data || {}
    if (event.type === 'turn/start') {
      turnMap.set(data.turn, nextTurn)
      writes.push({ type: 'turn/start', data: { turn: nextTurn } })
      seqOf()
      continue
    }
    if (event.type === 'turn/end') {
      writes.push({ type: 'turn/end', data: { turn: turnMap.get(data.turn), reason: data.reason } })
      seqOf()
      nextTurn += 1
      continue
    }
    if (event.type === 'step/start' || event.type === 'step/end') {
      writes.push({ type: event.type, data: { turn: turnMap.get(data.turn), step: data.step } })
      seqOf()
      continue
    }
    if (event.type === 'user/message') {
      if (event.seq === plan.promptSeq && promptCopied !== true) continue
      writes.push({
        type: 'user/message',
        surfaceOp: 'append',
        data: {
          id: randomUUID(),
          role: 'user',
          content: data.content,
          source: replaySource(data.source, rerunId, event.seq),
        },
      })
      seqOf()
      continue
    }
    if (event.type === 'assistant/message') {
      const message = data.message || {}
      const source = { ...(message.source || {}) }
      delete source.replayState
      const content = Array.isArray(message.content)
        ? message.content.filter((block) => !(block && block.type === 'tool-call' && !healthyIds.has(block.id)))
        : []
      writes.push({
        type: 'assistant/message',
        surfaceOp: 'append',
        data: {
          turn: turnMap.get(data.turn),
          step: data.step,
          message: {
            id: randomUUID(),
            role: 'assistant',
            content,
            source: replaySource(source, rerunId, event.seq),
          },
          stream: [],
          ...(data.interrupted === true ? { interrupted: true } : {}),
        },
      })
      assistantSeqById.set(event.seq, predicted)
      lastAssistantSeq = predicted
      seqOf()
      continue
    }
    if (event.type === 'tool/call') {
      if (!pairedResultIds.has(data.callId)) continue
      writes.push({
        type: 'tool/call',
        data: { turn: turnMap.get(data.turn), step: data.step, callId: data.callId, name: data.name, arguments: data.arguments },
      })
      seqOf()
      continue
    }
    if (event.type === 'tool/result') {
      const callId = data.message && data.message.source ? data.message.source.callId : data.callId
      if (!pairedResultIds.has(callId)) continue
      const message = data.message
      const source = replaySource(message && message.source, rerunId, event.seq)
      // The TOOL_NOT_STARTED repair is accepted only without sourceEventSeqs;
      // ordinary results remap theirs onto the copied assistant message.
      let sourceEventSeqs
      if (!repairIds.has(callId)) {
        const remapped = Array.isArray(event.sourceEventSeqs)
          ? event.sourceEventSeqs.map((seq) => assistantSeqById.get(seq)).filter((seq) => typeof seq === 'number')
          : []
        if (remapped.length > 0) sourceEventSeqs = remapped
        else if (typeof lastAssistantSeq === 'number') sourceEventSeqs = [lastAssistantSeq]
      }
      const originalMessage = message || {}
      const rest = { ...originalMessage }
      delete rest.id
      delete rest.content
      delete rest.source
      // The interrupted-repair carrier must keep its contract-shaped id
      // (`interrupted-tool-result-<callId>-<n>`): the validator refuses a
      // repair whose id does not match, and a random id breaks it. The suffix
      // is the copy's own predicted seq, so the identity stays self-describing.
      const messageId = repairIds.has(callId) ? `interrupted-tool-result-${callId}-${predicted}` : randomUUID()
      writes.push({
        type: 'tool/result',
        surfaceOp: 'append',
        ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
        data: {
          turn: turnMap.get(data.turn),
          step: data.step,
          message: {
            // The message shape travels verbatim (v4's first-class tool role
            // keeps its `toolCallId` and bare content blocks); only the id and
            // the source attribution are ours.
            ...rest,
            id: messageId,
            content: originalMessage.content ?? [],
            source,
          },
          ...(data.error === undefined ? {} : { error: data.error }),
          ...(data.meta === undefined ? {} : { meta: data.meta }),
        },
      })
      seqOf()
      continue
    }
    // system/message and every log-only record are skipped on purpose.
  }
  return writes
}

/**
 * Every model reply that can currently be rerun.
 * @param events - complete contiguous raw event log.
 * @param surfaceNodes - current surface seqs in model order.
 * @returns one entry per live reply, in conversation order.
 */
export function rerunnableReplies(events, surfaceNodes) {
  const nodeIndex = new Map(surfaceNodes.map((seq, index) => [seq, index]))
  const turnOf = turnIndex(events)
  const head = surfaceNodes[0]
  const out = []
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    if (!nodeIndex.has(event.seq)) continue
    if (event.seq === head) continue
    const turn = turnOf.get(event.seq)
    out.push({
      seq: event.seq,
      turn: typeof turn === 'number' ? turn : null,
      messageId: messageIdOf(event) ?? null,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// host service plumbing
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

// A session id travels in two spellings: the raw uuid and `session-<uuid>`.
function idVariants(sessionId) {
  const out = new Set([sessionId])
  if (sessionId.startsWith('session-')) out.add(sessionId.slice('session-'.length))
  else out.add(`session-${sessionId}`)
  return [...out]
}

function findLiveSession(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (!sessions || typeof sessions.get !== 'function') return undefined
  for (const variant of idVariants(sessionId)) {
    const found = sessions.get(variant)
    if (found) return found
  }
  return undefined
}

// Resolve the live Agent (and its Session) through the official controller -
// the same path the web UI uses, which resumes a cold session on the way.
// Always returns `{ agent?, session }`: `agent` is present only when the
// controller resolved one (the loop object exposes `whenIdle` and the idle
// turn counter the replay syncs); a bare live session is the fallback.
async function resolveAgent(ctx, sessionId) {
  const controller = ctx.get('sessionController')
  if (controller && typeof controller.resolveAgent === 'function') {
    try {
      const result = await controller.resolveAgent(sessionId)
      if (result && result.agent && result.agent.session) return { agent: result.agent, session: result.agent.session }
    } catch {
      // fall through to the live-store lookup
    }
  }
  const live = findLiveSession(ctx, sessionId)
  if (live) return { session: live }
  return undefined
}

function eventsFromLive(session) {
  if (session && typeof session.snapshotEvents === 'function') {
    try {
      const events = session.snapshotEvents()
      if (Array.isArray(events)) return events
    } catch {
      // fall through to the query service
    }
  }
  return undefined
}

// Live-preferred read through the public query service; the live session's own
// snapshot is the fallback when the service is absent.
async function readEvents(ctx, sessionId) {
  const query = ctx.get('sessionQuery')
  if (query && typeof query.readSession === 'function') {
    try {
      const snapshot = await query.readSession(sessionId)
      if (snapshot && Array.isArray(snapshot.events)) return snapshot.events
    } catch {
      // fall through to the live snapshot
    }
  }
  const live = findLiveSession(ctx, sessionId)
  return eventsFromLive(live) ?? null
}

function surfaceOf(ctx, sessionId, events) {
  const live = findLiveSession(ctx, sessionId)
  const nodes = live && live.surface && Array.isArray(live.surface.nodes) ? live.surface.nodes : undefined
  return nodes ?? foldSurface(events).nodes
}

// The append is committed in memory the moment `session.append` returns; the
// persistence writer buffers asynchronously. Await the official durability
// checkpoint so a reload or a DSH restart still sees the write.
async function flushSession(ctx, session) {
  const errors = []
  const sessions = ctx.get('sessions')
  if (sessions && typeof sessions.flush === 'function') {
    try {
      await Promise.race([sessions.flush(session), new Promise((resolve) => setTimeout(resolve, FLUSH_DEADLINE_MS))])
      return { flushed: true }
    } catch (error) {
      errors.push(String((error && error.message) || error))
    }
  } else {
    errors.push('sessions.flush unavailable')
  }
  const persistence = ctx.get('sessionPersistence')
  if (persistence && typeof persistence.flush === 'function') {
    try {
      await Promise.race([persistence.flush(), new Promise((resolve) => setTimeout(resolve, FLUSH_DEADLINE_MS))])
      return { flushed: true }
    } catch (error) {
      errors.push(String((error && error.message) || error))
    }
  } else {
    errors.push('sessionPersistence.flush unavailable')
  }
  return { flushed: false, flushError: errors.join(' | ') }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Re-point the agent loop's idle turn counter at the log's true last turn.
 *
 * Why this exists: the replay (and any external writer of completed turns,
 * including the sibling edit plugin's corrections) appends `turn/start`
 * events the loop did not open. The loop's next turn is `phase.lastTurn + 1`
 * from its own process-local counter, initialized from the `turnBoundary`
 * projection only when the agent ATTACHES - an already-attached idle loop
 * never re-reads it. So without this sync the loop's next real prompt reuses
 * a turn number the replay already consumed, and the log fails its cold read
 * ("turn/start does not open the expected turn"). DSH exposes no official
 * re-sync API; this is the one place the plugin touches loop state, guarded
 * and best-effort: an unexpected shape changes nothing and is reported.
 *
 * @param agent - the live agent from `sessionController.resolveAgent`.
 * @param maxTurn - the highest turn number the log now contains.
 * @returns 'synced' | 'already-current' | 'unavailable'.
 */
export function syncLoopTurn(agent, maxTurn) {
  try {
    const phase = agent && agent.phase
    if (!phase || typeof phase !== 'object' || typeof phase.lastTurn !== 'number' || phase.kind !== 'idle') {
      return 'unavailable'
    }
    if (maxTurn > phase.lastTurn) {
      phase.lastTurn = maxTurn
      return 'synced'
    }
    return 'already-current'
  } catch {
    return 'unavailable'
  }
}

// ---------------------------------------------------------------------------
// rerun tasks
// ---------------------------------------------------------------------------

/** One in-flight operation per session; every route checks it first. */
const locks = new Map()

function lock(sessionId) {
  if (locks.has(sessionId)) return false
  locks.set(sessionId, { startedAt: Date.now() })
  return true
}

function unlock(sessionId) {
  locks.delete(sessionId)
}

function locked(sessionId) {
  return locks.has(sessionId)
}

/** Live rerun progress for /state, keyed by session id. */
const progress = new Map()

function setProgress(sessionId, patch) {
  const current = progress.get(sessionId) || {}
  const next = { ...current, ...patch }
  if (next.phase === undefined) delete next.phase
  progress.set(sessionId, next)
  return next
}

/**
 * Append one write to the live session, expecting a specific seq.
 * @returns the landed event, or throws when the log moved under us.
 */
function appendWrite(session, write, expectedSeq) {
  if (typeof expectedSeq === 'number' && session.seq !== expectedSeq) {
    throw new HttpError(409, 'stale', `the log moved: expected seq ${expectedSeq}, found ${session.seq}`)
  }
  const opts = write.surfaceOp === undefined ? [] : [{ surfaceOp: write.surfaceOp, ...(write.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: write.sourceEventSeqs }) }]
  return session.append(write.type, write.data, ...opts)
}

/**
 * Whether the regenerated prompt (its rpcId) is still sitting unclaimed in the
 * agent inbox - replaying before it is claimed would put the copies before the
 * fresh answer.
 */
function inboxHoldsPrompt(agent, promptRequestId) {
  const inbox = agent && agent.inbox
  if (!inbox || !Array.isArray(inbox.nextTurn) || promptRequestId === null) return false
  return inbox.nextTurn.some((message) => {
    const source = message && message.source
    return Boolean(source && source.kind === 'user' && source.rpcId === promptRequestId)
  })
}

/**
 * Whether the regenerated prompt landed on the surface: either the loop
 * claimed it (the rpcId event exists) or an earlier replay copied it.
 */
function promptLandedIn(events, record) {
  const promptRequestId = record.promptRequestId
  const markerCopied = events.some((event) => {
    if (event.seq <= record.carrierSeq) return false
    const marker = replayMarkerOf(event)
    return marker !== null && marker.rerunId === record.rerunId && marker.originalSeq === record.promptSeq
  })
  if (markerCopied) return true
  if (promptRequestId === null) return false
  return events.some((event) => {
    if (event.seq <= record.carrierSeq || event.type !== 'user/message') return false
    const source = event.data && event.data.source
    return Boolean(source && source.kind === 'user' && source.rpcId === promptRequestId)
  })
}

/**
 * How many leading bracket writes a crashed replay already landed.
 *
 * A replay dies only between two appends, so a partial write is a prefix of
 * the plan sitting at the tail of the log. The largest tail that structurally
 * matches a plan prefix is skipped on resume - the format requires turn
 * numbers contiguous, and a duplicated `turn/start` would make the whole log
 * unreadable. Marker-bearing surface writes are never absorbed: their presence
 * is tracked separately through `originalSeq`.
 *
 * @param events - complete contiguous raw event log.
 * @param writes - the replay plan (ordered writes).
 * @param cap - how many trailing events may be considered.
 * @returns the number of leading writes already on the log tail.
 */
export function matchReplayPrefix(events, writes, cap) {
  const limit = Math.min(writes.length, typeof cap === 'number' && cap >= 0 ? cap : 0)
  for (let k = limit; k >= 1; k -= 1) {
    let match = true
    for (let j = 0; j < k; j += 1) {
      const write = writes[j]
      const landed = events[events.length - k + j]
      if (!landed || landed.type !== write.type || isSurfaceEvent(write)) {
        match = false
        break
      }
      if (write.type === 'turn/start' && landed.data.turn !== write.data.turn) { match = false; break }
      if ((write.type === 'step/start' || write.type === 'step/end') && (landed.data.turn !== write.data.turn || landed.data.step !== write.data.step)) { match = false; break }
      if (write.type === 'turn/end' && landed.data.turn !== write.data.turn) { match = false; break }
      if (write.type === 'tool/call' && landed.data.callId !== write.data.callId) { match = false; break }
    }
    if (match) return k
  }
  return 0
}

/**
 * The replay phase, shared by the fresh-rerun task and the resume path.
 *
 * Waits for a quiet tail - no open turn, no queued rerun prompt - because the
 * copies must land directly after the fresh answer for the spliced order to
 * hold, then appends the missing suffix. When the tail never quiets, the rerun
 * stays incomplete and `/state`'s resume path picks it up later.
 * @returns `{ replayed, deferred, error? }`.
 */
async function performReplay(ctx, sessionId, rerunId, config) {
  const resolution = await resolveAgent(ctx, sessionId)
  const session = resolution && (resolution.session ?? resolution.agent?.session)
  if (!session || typeof session.append !== 'function') {
    return { replayed: 0, deferred: true, error: 'session-not-active' }
  }
  let deferLeft = REPLAY_DEFER_MAX
  while (true) {
    const events = eventsFromLive(session) ?? (await readEvents(ctx, sessionId))
    if (!events) return { replayed: 0, deferred: true, error: 'session-not-found' }
    const ledger = rerunLedger(events)
    const record = ledger.reruns.find((entry) => entry.rerunId === rerunId)
    if (!record) return { replayed: 0, deferred: true, error: 'rerun-not-found' }
    if (record.complete) return { replayed: 0, deferred: false }
    const open = openTurn(events)
    if (isBusy(events) && !(open !== null && replayOrphanOpen(events, rerunId))) {
      // A real turn in flight or a compaction. Our own crash-orphan - an open
      // turn of pure brackets and marked copies - is continued below instead:
      // leaving it open would refuse the session's next real turn on read.
      if (deferLeft-- <= 0) return { replayed: 0, deferred: true, error: 'busy' }
      await sleep(REPLAY_DEFER_MS)
      continue
    }
    if (inboxHoldsPrompt(resolution && resolution.agent, record.promptRequestId)) {
      // The regenerated prompt is admitted but not claimed yet; the copies
      // must not overtake it.
      if (deferLeft-- <= 0) return { replayed: 0, deferred: true, error: 'prompt-pending' }
      await sleep(REPLAY_DEFER_MS)
      continue
    }
    const promptLanded = promptLandedIn(events, record)
    // Resume point: the suffix after the last original event that already has
    // a copy. Bracket events written just before a crash carry no marker, so
    // leading writes that already exist verbatim at the tail are skipped.
    let lastCopied = record.carrierSeq
    for (const event of events) {
      if (event.seq <= record.carrierSeq) continue
      const marker = replayMarkerOf(event)
      if (marker !== null && marker.rerunId === rerunId && marker.originalSeq !== null && marker.originalSeq > lastCopied) {
        lastCopied = marker.originalSeq
      }
    }
    // Continue an orphan open turn at its own number; otherwise open the next.
    const baseTurn = open !== null && replayOrphanOpen(events, rerunId) ? open : lastTurnOf(events) + 1
    // Normal path: the walk starts at the next turn's bracket (the rerun
    // turn's own reply is replaced, not replayed). Fallback - the prompt never
    // landed - the walk starts at the rerun turn's own bracket, so the copies
    // reproduce the whole window and the context keeps its content.
    const fallbackFrom = record.logFrom ?? record.promptSeq ?? record.startSeq
    const walkFrom = promptLanded ? record.replayFrom ?? fallbackFrom : fallbackFrom
    if (walkFrom === null || walkFrom > (record.logTo ?? record.endSeq)) {
      return { replayed: 0, deferred: false }
    }
    const plan = {
      logFrom: walkFrom,
      logTo: record.logTo ?? record.endSeq,
      promptSeq: record.promptSeq ?? record.startSeq,
      // The replay copies exactly these surface nodes (and nothing the log
      // happens to hold between them), so the shadowed list must travel.
      shadowed: record.shadowed,
    }
    const startSeq = session.seq
    const writes = buildReplayWrites(events, plan, baseTurn, rerunId, startSeq, !promptLanded)
    const skip = matchReplayPrefix(events, writes, events.length - (record.carrierSeq + 1))
    let replayed = 0
    try {
      for (let index = skip; index < writes.length; index += 1) {
        appendWrite(session, writes[index], startSeq + index)
        replayed += 1
      }
    } catch (error) {
      await flushSession(ctx, session)
      const message = String((error && error.message) || error)
      setProgress(sessionId, { phase: 'interrupted', rerunId, error: message })
      noteRequest({ kind: 'replay', sessionId, ok: false, rerunId, error: message })
      return { replayed, deferred: true, error: message }
    }
    // The log now holds completed turns the loop never opened; re-point its
    // idle counter SYNCHRONOUSLY (same tick as the appends, before any await)
    // so its next prompt opens the correct number instead of colliding.
    const playedMax = writes.reduce((max, write) => {
      const turn = write.data && typeof write.data.turn === 'number' ? write.data.turn : 0
      return turn > max ? turn : max
    }, 0)
    const sync = syncLoopTurn(resolution && resolution.agent, playedMax)
    if (sync === 'unavailable' && playedMax > lastTurnOf(events)) {
      noteRequest({ kind: 'replay', sessionId, ok: false, rerunId, error: `loop turn counter not synced (${playedMax}); a later prompt may reuse a turn number` })
    }
    await flushSession(ctx, session)
    noteRequest({ kind: 'replay', sessionId, ok: true, rerunId, replayed, skipped: skip, sync })
    return { replayed, deferred: false }
  }
}

/**
 * The background task behind one rerun: regenerate, then replay the tail.
 * Never throws - every outcome lands in `progress` for /state to report.
 * `afterSeq` is the log seq of the shadow's last write; the fallback poll
 * waits for a turn/end beyond it.
 */
async function runRerunTask(ctx, sessionId, resolution, plan, rerunId, promptRequestId, afterSeq, config) {
  const session = resolution.session
  try {
    setProgress(sessionId, { phase: 'generating', rerunId })
    let promptError = null
    let promptAccepted = false
    const controller = ctx.get('sessionController')
    if (!controller || typeof controller.prompt !== 'function') {
      promptError = 'sessionController.prompt unavailable'
    } else {
      const content = []
      if (plan.prompt.text.trim() !== '') content.push({ type: 'text', text: plan.prompt.text })
      for (const ref of plan.prompt.images) {
        try {
          const attachments = ctx.get('attachments')
          const stored = await attachments.readImage(ref)
          content.push({
            type: 'image',
            mediaType: ref.mediaType,
            data: Buffer.from(stored.data).toString('base64'),
            ...(ref.name === undefined ? {} : { name: ref.name }),
          })
        } catch (error) {
          promptError = `could not re-admit an image attachment: ${String((error && error.message) || error)}`
          break
        }
      }
      if (promptError === null && content.length > 0) {
        try {
          await controller.prompt(
            { requestId: promptRequestId, sessionId, mode: 'queue', content },
            AbortSignal.timeout(PROMPT_DEADLINE_MS),
          )
          promptAccepted = true
        } catch (error) {
          promptError = String((error && error.message) || error)
        }
      } else if (content.length === 0 && promptError === null) {
        promptError = 'the turn prompt has no re-sendable content'
      }
    }
    setProgress(sessionId, { phase: promptAccepted ? 'waiting' : 'replaying', rerunId, ...(promptError === null ? {} : { promptError }) })
    if (promptAccepted) {
      // Wait for the regenerated turn to close: `whenIdle` is the precise
      // signal, and the log poll - which only settles once a turn/end lands
      // after the shadow - is the fallback for an agent object without one.
      const deadline = Date.now() + (config.idleTimeoutMs > 0 ? config.idleTimeoutMs : DEFAULT_IDLE_TIMEOUT_MS)
      const agent = resolution.agent
      const idle = agent && typeof agent.whenIdle === 'function' ? agent.whenIdle().catch(() => {}) : new Promise(() => {})
      const timeout = (async () => {
        while (Date.now() < deadline) {
          const events = eventsFromLive(session)
          if (events && afterSeq >= 0 && openTurn(events) === null && events.some((event) => event.type === 'turn/end' && event.seq > afterSeq)) return
          await sleep(700)
        }
      })()
      await Promise.race([idle, timeout])
      const events = eventsFromLive(session)
      const settled =
        events !== undefined &&
        afterSeq >= 0 &&
        openTurn(events) === null &&
        events.some((event) => event.type === 'turn/end' && event.seq > afterSeq)
      if (!settled && Date.now() >= deadline) {
        setProgress(sessionId, { phase: 'interrupted', rerunId, error: 'the regenerated turn did not settle in time; replay deferred' })
        return
      }
    }
    const result = await performReplay(ctx, sessionId, rerunId, config)
    if (result.deferred) {
      setProgress(sessionId, {
        phase: 'interrupted',
        rerunId,
        ...(result.error === undefined ? {} : { error: `replay deferred: ${result.error}; /state will resume it` }),
      })
    } else {
      setProgress(sessionId, { phase: 'done', rerunId, replayed: result.replayed })
    }
  } catch (error) {
    setProgress(sessionId, { phase: 'failed', rerunId, error: String((error && error.message) || error) })
    noteRequest({ kind: 'rerun', sessionId, ok: false, rerunId, error: String((error && error.message) || error) })
  } finally {
    unlock(sessionId)
  }
}

/**
 * Resume one interrupted rerun's replay: no regeneration, just the copies.
 */
async function runReplayTask(ctx, sessionId, rerunId, config) {
  try {
    setProgress(sessionId, { phase: 'replaying', ...(rerunId === null ? {} : { rerunId }) })
    const result = await performReplay(ctx, sessionId, rerunId, config)
    if (result.deferred) {
      setProgress(sessionId, { phase: 'interrupted', ...(rerunId === null ? {} : { rerunId }), ...(result.error === undefined ? {} : { error: `replay deferred: ${result.error}` }) })
    } else {
      setProgress(sessionId, { phase: 'done', ...(rerunId === null ? {} : { rerunId }), replayed: result.replayed })
    }
  } catch (error) {
    setProgress(sessionId, { phase: 'failed', ...(rerunId === null ? {} : { rerunId }), error: String((error && error.message) || error) })
  } finally {
    unlock(sessionId)
  }
}

// ---------------------------------------------------------------------------
// operations
// ---------------------------------------------------------------------------

async function stateOf(ctx, sessionId, config) {
  const events = await readEvents(ctx, sessionId)
  if (!events) {
    noteRequest({ kind: 'state', sessionId, ok: false, code: 'session-not-found' })
    throw new HttpError(404, 'session-not-found', 'no session log for this id')
  }
  const folded = foldSurface(events)
  const ledger = rerunLedger(events)
  const live = findLiveSession(ctx, sessionId)
  const replies = rerunnableReplies(events, folded.nodes)
  const busy = isBusy(events)
  const rerunning = locked(sessionId)
  const current = progress.get(sessionId) || null
  noteRequest({
    kind: 'state',
    sessionId,
    ok: true,
    events: events.length,
    replies: replies.length,
    hidden: ledger.hidden.length,
    reruns: ledger.reruns.length,
    incomplete: ledger.reruns.filter((entry) => !entry.complete).length,
    live: Boolean(live),
    rerunning,
  })
  // Auto-resume: a rerun whose replay never finished (a crash mid-generation,
  // a tail that never quieted) is completed from the log alone - no model call.
  // The gate exempts this plugin's own crash-orphan (an open turn of pure
  // brackets and marked copies): the resume is what closes it.
  if (config.autoResume === true && live && !rerunning && ledger.reruns.some((entry) => !entry.complete)) {
    const incomplete = ledger.reruns.find((entry) => !entry.complete)
    const orphanOpen = openTurn(events) !== null && replayOrphanOpen(events, incomplete.rerunId)
    if ((!isBusy(events) || orphanOpen) && lock(sessionId)) {
      runReplayTask(ctx, sessionId, incomplete.rerunId, config)
    }
  }
  return {
    hidden: ledger.hidden,
    // Bookkeeping turns are UI noise, never conversation; the client hides
    // their rows by turn number.
    markerTurns: ledger.reruns.map((entry) => entry.carrierTurn).filter((turn) => typeof turn === 'number'),
    reruns: ledger.reruns,
    replies,
    live: Boolean(live),
    busy,
    rerunning,
    progress: current,
    lastSeq: events.length > 0 ? events[events.length - 1].seq : -1,
    config: { confirm: config.confirm, autoResume: config.autoResume === true },
    version: PLUGIN_VERSION,
  }
}

async function applyRerun(ctx, sessionId, body, config) {
  if (locked(sessionId)) throw new HttpError(409, 'rerunning', 'a rerun is already in flight')
  const resolution = await resolveAgent(ctx, sessionId)
  const session = resolution && (resolution.session ?? (resolution.agent && resolution.agent.session))
  if (!session || typeof session.append !== 'function') {
    throw new HttpError(409, 'session-not-active', 'the session is not open in DSH')
  }
  const events = await readEvents(ctx, sessionId)
  if (!events) throw new HttpError(404, 'session-not-found', 'no session log for this id')
  if (isBusy(events)) throw new HttpError(409, 'busy', 'the session is still working')
  const surfaceNodes = surfaceOf(ctx, sessionId, events)
  let plan
  try {
    plan = planRerun(events, surfaceNodes, {
      seq: typeof body.seq === 'number' ? body.seq : undefined,
      messageId: typeof body.messageId === 'string' ? body.messageId : undefined,
    })
  } catch (error) {
    if (error instanceof RerunPlanError) {
      const status = error.code === 'already-retired' ? 409 : 400
      throw new HttpError(status, error.code, error.message)
    }
    throw error
  }
  // The live surface is the append authority; a node that vanished between the
  // read and this check means another writer landed first.
  for (const seq of plan.shadowed) {
    if (!surfaceNodes.includes(seq)) throw new HttpError(409, 'stale', 'the session changed, retry')
  }
  if (!lock(sessionId)) throw new HttpError(409, 'rerunning', 'a rerun is already in flight')
  const rerunId = randomUUID()
  const promptRequestId = randomUUID()
  // The bookkeeping turn takes the log's next number: every closed turn has
  // exactly one turn/end, so its count + 1 is the number the format expects
  // next.
  const carrierTurn = events.filter((event) => event.type === 'turn/end').length + 1
  let afterSeq = -1
  try {
    const shadowWrites = buildShadowWrites(plan, carrierTurn, rerunId, promptRequestId)
    for (const write of shadowWrites) {
      appendWrite(session, write, session.seq)
      afterSeq = session.seq - 1
    }
  } catch (error) {
    unlock(sessionId)
    throw new HttpError(409, 'stale', `the surface refused the shadow: ${String((error && error.message) || error)}`)
  }
  // The loop opens its own turns from a process-local counter; point an idle
  // counter at the bookkeeping turn so the regenerated turn opens N+1 instead
  // of colliding with it (DSH reads the counter anew on attach, but a live,
  // idle loop does not).
  syncLoopTurn(resolution && resolution.agent, carrierTurn)
  const flush = await flushSession(ctx, session)
  setProgress(sessionId, { phase: 'generating', rerunId })
  // The regeneration and the replay run in the background; /apply returns as
  // soon as the shadow is durable so the client can retire the old rows.
  runRerunTask(ctx, sessionId, resolution, plan, rerunId, promptRequestId, afterSeq, config)
  return {
    started: true,
    rerunId,
    carrierSeq: plan.startSeq,
    shadowed: plan.shadowed,
    turn: plan.turn,
    promptSeq: plan.promptSeq,
    ...flush,
  }
}

async function replayRoute(ctx, sessionId, body, config) {
  if (locked(sessionId)) throw new HttpError(409, 'rerunning', 'a rerun is already in flight')
  const live = findLiveSession(ctx, sessionId)
  if (!live) throw new HttpError(409, 'session-not-active', 'the session is not open in DSH')
  const events = await readEvents(ctx, sessionId)
  if (!events) throw new HttpError(404, 'session-not-found', 'no session log for this id')
  const ledger = rerunLedger(events)
  const rerunId = typeof body.rerunId === 'string' && body.rerunId !== '' ? body.rerunId : null
  const incomplete = rerunId === null ? ledger.reruns.find((entry) => !entry.complete) : ledger.reruns.find((entry) => entry.rerunId === rerunId && !entry.complete)
  // The busy gate exempts this plugin's own crash-orphan: the replay is what
  // closes it.
  const orphanOpen = incomplete !== undefined && openTurn(events) !== null && replayOrphanOpen(events, incomplete.rerunId)
  if (isBusy(events) && !orphanOpen) throw new HttpError(409, 'busy', 'the session is still working')
  if (!incomplete) {
    if (rerunId !== null && ledger.reruns.some((entry) => entry.rerunId === rerunId)) {
      return { started: false, complete: true }
    }
    throw new HttpError(404, 'rerun-not-found', 'no incomplete rerun for this id')
  }
  if (!lock(sessionId)) throw new HttpError(409, 'rerunning', 'a rerun is already in flight')
  setProgress(sessionId, { phase: 'replaying', rerunId: incomplete.rerunId })
  runReplayTask(ctx, sessionId, incomplete.rerunId, config)
  return { started: true, rerunId: incomplete.rerunId }
}

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------

function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address.length === 0) return false
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.')
}

function isLocalHostHeader(host) {
  if (typeof host !== 'string' || host.length === 0) return false
  const trimmed = host.trim().toLowerCase()
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    if (end === -1) return false
    const rest = trimmed.slice(end + 1)
    if (rest !== '' && !/^:[0-9]+$/.test(rest)) return false
    return trimmed.slice(1, end) === '::1'
  }
  const match = /^([^:]*)(?::([0-9]+))?$/.exec(trimmed)
  if (match === null) return false
  return match[1] === 'localhost' || match[1] === '127.0.0.1' || match[1] === '::1'
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1e6) req.destroy()
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('aborted')))
  })
}

// Rewriting the derived context is destructive for the model, so every route
// demands a loopback socket, a loopback Host header, and a same-origin check
// when the browser sends Origin.
function guard(req, res) {
  if (!isLoopbackAddress(req.socket && req.socket.remoteAddress)) {
    sendJson(res, 403, { ok: false, code: 'forbidden', error: 'loopback only' })
    return false
  }
  const host = req.headers.host
  if (!isLocalHostHeader(host)) {
    sendJson(res, 403, { ok: false, code: 'forbidden', error: 'unexpected host' })
    return false
  }
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    let originHost = null
    try {
      originHost = new URL(origin).host
    } catch {
      originHost = null
    }
    if (originHost !== host) {
      sendJson(res, 403, { ok: false, code: 'forbidden', error: 'cross-origin request' })
      return false
    }
  }
  return true
}

function sessionIdFromQuery(url) {
  try {
    return (new URL(url, 'http://localhost').searchParams.get('sessionId') || '').trim()
  } catch {
    return ''
  }
}

function requireSessionId(value) {
  if (!value) throw new HttpError(400, 'invalid', 'sessionId required')
  if (!SESSION_ID_RE.test(value)) throw new HttpError(400, 'invalid', 'invalid session id')
  return value
}

function failure(res, error) {
  const status = error instanceof HttpError ? error.status : 500
  const code = error instanceof HttpError ? error.code : 'internal'
  sendJson(res, status, { ok: false, code, error: String((error && error.message) || error) })
}

// ---------------------------------------------------------------------------
// dev tools (config.devTools; used by end-to-end verification)
// ---------------------------------------------------------------------------

/** Compact text of one derived message, for the dev transcript route. */
function messageTextOf(message) {
  if (!message || !Array.isArray(message.content)) return ''
  const parts = []
  for (const block of message.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block && block.type === 'tool-call') parts.push(`<tool-call ${block.name}>`)
  }
  return parts.join('\n')
}

/**
 * Wait until a fresh session has closed `count` turns.
 * @returns the events, or null on timeout.
 */
async function waitForTurns(ctx, sessionId, count, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const live = findLiveSession(ctx, sessionId)
    const events = live ? eventsFromLive(live) : await readEvents(ctx, sessionId)
    if (events) {
      let closed = 0
      for (const event of events) if (event.type === 'turn/end') closed += 1
      if (closed >= count && openTurn(events) === null) return events
    }
    await sleep(500)
  }
  return null
}

/**
 * Create a throwaway session and drive `turns` short model turns in it.
 * Every turn asks for a unique token, so a replayed copy can be told apart
 * from a regenerated answer in the derived context.
 */
async function devScratch(ctx, turns, cwd) {
  const controller = ctx.get('sessionController')
  if (!controller || typeof controller.create !== 'function' || typeof controller.prompt !== 'function') {
    throw new HttpError(503, 'dev-unavailable', 'sessionController is not available')
  }
  const count = Math.max(1, Math.min(6, typeof turns === 'number' ? Math.floor(turns) : 3))
  const sessionId = `session-${randomUUID()}`
  const created = await controller.create({ sessionId, cwd })
  const tokens = []
  for (let turn = 1; turn <= count; turn += 1) {
    const token = `TOKEN-${turn}-${randomUUID().slice(0, 8)}`
    tokens.push(token)
    await controller.prompt(
      {
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: `Reply with exactly this text and nothing else: ${token}` }],
      },
      AbortSignal.timeout(PROMPT_DEADLINE_MS),
    )
    const settled = await waitForTurns(ctx, sessionId, turn, 5 * 60_000)
    if (!settled) throw new HttpError(504, 'dev-timeout', `turn ${turn} did not settle`)
  }
  return { sessionId: created && created.sessionId ? created.sessionId : sessionId, turns: count, tokens }
}

/** Send one prompt into a live session and wait for its turn to close. */
async function devPrompt(ctx, sessionId, text) {
  const controller = ctx.get('sessionController')
  if (!controller || typeof controller.prompt !== 'function') {
    throw new HttpError(503, 'dev-unavailable', 'sessionController is not available')
  }
  await controller.prompt(
    {
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: typeof text === 'string' && text !== '' ? text : 'ping' }],
    },
    AbortSignal.timeout(PROMPT_DEADLINE_MS),
  )
  const live = findLiveSession(ctx, sessionId)
  const before = live ? eventsFromLive(live) : await readEvents(ctx, sessionId)
  const closed = before ? before.filter((event) => event.type === 'turn/end').length : 0
  const settled = await waitForTurns(ctx, sessionId, closed + 1, 5 * 60_000)
  if (!settled) throw new HttpError(504, 'dev-timeout', 'the prompt did not settle')
  return { sessionId, turns: closed + 1 }
}

/** The live derived context of one session - exactly what the next request sends. */
async function devDerived(ctx, sessionId) {
  const resolution = await resolveAgent(ctx, sessionId)
  const session = resolution && (resolution.session ?? resolution.agent?.session)
  if (!session) throw new HttpError(404, 'session-not-found', 'no live session for this id')
  let messages
  if (typeof session.deriveMessages === 'function') {
    messages = session.deriveMessages()
  } else {
    const events = await readEvents(ctx, sessionId)
    if (!events) throw new HttpError(404, 'session-not-found', 'no session log for this id')
    const folded = foldSurface(events)
    const bySeq = new Map(events.map((event) => [event.seq, event]))
    messages = []
    for (const seq of folded.nodes) {
      const event = bySeq.get(seq)
      if (!event) continue
      const message = event.type === 'user/message' ? event.data : event.data && event.data.message
      if (!message) continue
      if (Array.isArray(message.content) && message.content.length === 0) continue
      messages.push(message)
    }
  }
  const derived = messages
    .map((message) => ({
      role: message.role,
      text: messageTextOf(message),
      id: message.id,
    }))
    .filter((entry) => entry.text !== '' || entry.role !== 'developer')
  // The replay markers, so a verification can tell copies from fresh output.
  const events = (session && eventsFromLive(session)) ?? (await readEvents(ctx, sessionId)) ?? []
  const copies = events
    .map((event) => {
      const marker = replayMarkerOf(event)
      return marker === null ? null : { seq: event.seq, ...marker }
    })
    .filter(Boolean)
  return { sessionId, derived, copies }
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  const resolved = {
    confirm: config && config.confirm === true,
    autoResume: !(config && config.autoResume === false),
    idleTimeoutMs:
      config && typeof config.idleTimeoutMs === 'number' && config.idleTimeoutMs > 0 ? config.idleTimeoutMs : DEFAULT_IDLE_TIMEOUT_MS,
    devTools: config && config.devTools === true,
  }

  const registerRoutes = (webServer, fiber) => {
    fiber.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/state`,
        handler: async (req, res) => {
          if (!guard(req, res)) return
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, code: 'method', error: 'GET only' })
            return
          }
          try {
            const sessionId = requireSessionId(sessionIdFromQuery(req.url))
            sendJson(res, 200, { ok: true, ...(await stateOf(ctx, sessionId, resolved)) })
          } catch (error) {
            failure(res, error)
          }
        },
      }),
    )

    // Read-only diagnostics. The browser half's own state cannot be observed
    // from here, so the next best thing is an honest record of what its
    // requests asked for and what they got back.
    fiber.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/debug`,
        handler: (req, res) => {
          if (!guard(req, res)) return
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, code: 'method', error: 'GET only' })
            return
          }
          sendJson(res, 200, { ok: true, version: PLUGIN_VERSION, requests: recentRequests() })
        },
      }),
    )

    fiber.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/apply`,
        handler: async (req, res) => {
          if (!guard(req, res)) return
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, code: 'method', error: 'POST only' })
            return
          }
          let body = {}
          try {
            const raw = await readBody(req)
            if (raw) body = JSON.parse(raw)
          } catch {
            sendJson(res, 400, { ok: false, code: 'invalid', error: 'malformed JSON body' })
            return
          }
          try {
            const sessionId = requireSessionId(typeof body.sessionId === 'string' ? body.sessionId.trim() : '')
            const result = await applyRerun(ctx, sessionId, body, resolved)
            noteRequest({
              kind: 'apply',
              sessionId,
              ok: true,
              rerunId: result.rerunId,
              seq: typeof body.seq === 'number' ? body.seq : null,
              shadowed: Array.isArray(result.shadowed) ? result.shadowed.length : null,
            })
            sendJson(res, 200, { ok: true, ...result })
          } catch (error) {
            noteRequest({
              kind: 'apply',
              sessionId: typeof body.sessionId === 'string' ? body.sessionId.trim() : null,
              ok: false,
              code: error && error.code ? String(error.code) : 'internal',
            })
            failure(res, error)
          }
        },
      }),
    )

    fiber.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/replay`,
        handler: async (req, res) => {
          if (!guard(req, res)) return
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, code: 'method', error: 'POST only' })
            return
          }
          let body = {}
          try {
            const raw = await readBody(req)
            if (raw) body = JSON.parse(raw)
          } catch {
            sendJson(res, 400, { ok: false, code: 'invalid', error: 'malformed JSON body' })
            return
          }
          try {
            const sessionId = requireSessionId(typeof body.sessionId === 'string' ? body.sessionId.trim() : '')
            sendJson(res, 200, { ok: true, ...(await replayRoute(ctx, sessionId, body, resolved)) })
          } catch (error) {
            failure(res, error)
          }
        },
      }),
    )

    if (resolved.devTools === true) {
      fiber.effect(() =>
        webServer.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/dev/scratch`,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, code: 'method', error: 'POST only' })
              return
            }
            let body = {}
            try {
              const raw = await readBody(req)
              if (raw) body = JSON.parse(raw)
            } catch {
              sendJson(res, 400, { ok: false, code: 'invalid', error: 'malformed JSON body' })
              return
            }
            try {
              const cwd = typeof body.cwd === 'string' && body.cwd !== '' ? body.cwd : process.cwd()
              sendJson(res, 200, { ok: true, ...(await devScratch(ctx, body.turns, cwd)) })
            } catch (error) {
              failure(res, error)
            }
          },
        }),
      )
      fiber.effect(() =>
        webServer.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/dev/prompt`,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, code: 'method', error: 'POST only' })
              return
            }
            let body = {}
            try {
              const raw = await readBody(req)
              if (raw) body = JSON.parse(raw)
            } catch {
              sendJson(res, 400, { ok: false, code: 'invalid', error: 'malformed JSON body' })
              return
            }
            try {
              const sessionId = requireSessionId(typeof body.sessionId === 'string' ? body.sessionId.trim() : '')
              sendJson(res, 200, { ok: true, ...(await devPrompt(ctx, sessionId, body.text)) })
            } catch (error) {
              failure(res, error)
            }
          },
        }),
      )
      fiber.effect(() =>
        webServer.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/dev/derived`,
          handler: async (req, res) => {
            if (!guard(req, res)) return
            if (req.method !== 'GET') {
              sendJson(res, 405, { ok: false, code: 'method', error: 'GET only' })
              return
            }
            try {
              const sessionId = requireSessionId(sessionIdFromQuery(req.url))
              sendJson(res, 200, { ok: true, ...(await devDerived(ctx, sessionId)) })
            } catch (error) {
              failure(res, error)
            }
          },
        }),
      )
    }
  }

  const webServer = ctx.get('webServer')
  if (webServer) {
    registerRoutes(webServer, ctx)
  } else {
    ctx.inject(['webServer'], (sub) => registerRoutes(sub.webServer, sub))
  }
}
