// End-to-end verification against a RUNNING DSH (needs config.devTools: true).
//
// Drives a throwaway session through three short model turns, reruns the
// MIDDLE turn through the plugin's own /apply route, waits for the background
// regeneration and replay, then reads the live derived context - the exact
// message list the next model request would send - and asserts the infix
// splice: the middle turn's answer is fresh, and the later turn is a replayed
// copy carrying the replay marker.
//
//   node tools/verify-live-e2e.mjs [port]
import { request } from 'node:http'

const port = Number(process.argv[2] || 3080)

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        timeout: 30_000,
        headers: payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => {
          let parsed
          try {
            parsed = data ? JSON.parse(data) : {}
          } catch {
            parsed = { raw: data }
          }
          resolve({ status: res.statusCode, body: parsed })
        })
      },
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

function assert(condition, label) {
  if (!condition) throw new Error(`FAILED: ${label}`)
  console.log(`  ok - ${label}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

console.log(`dsh-rerun-turn live end-to-end (port ${port})`)

// The dev route answers 405 to GET when mounted; 404 when the switch is off.
const scratchProbe = await call('GET', '/dsh-rerun-turn/dev/scratch')
if (scratchProbe.status !== 405) {
  console.error(`dev tools are not mounted (GET /dev/scratch -> ${scratchProbe.status}); set config.devTools: true and retry.`)
  process.exit(2)
}

// 1. A throwaway session with three short turns.
const scratch = await call('POST', '/dsh-rerun-turn/dev/scratch', { turns: 3 })
if (scratch.status !== 200 || !scratch.body.ok) {
  console.error('scratch creation failed:', scratch.status, scratch.body)
  process.exit(1)
}
const sessionId = scratch.body.sessionId
const tokens = scratch.body.tokens
console.log(`  session ${sessionId}: ${scratch.body.turns} turns`)

const first = await call('GET', `/dsh-rerun-turn/dev/derived?sessionId=${encodeURIComponent(sessionId)}`)
assert(first.status === 200 && first.body.ok, 'the derived context reads')
const firstText = first.body.derived.map((entry) => entry.text)
for (const token of tokens) assert(firstText.some((text) => text.includes(token)), `turn prompt ${token} is in the context`)
// Injected context (runtime snapshots, agent instructions) travels as
// user-role messages too; the scratch prompts are identified by their tokens.
const tokenIndexes = first.body.derived
  .map((entry, index) => (entry.role === 'user' && entry.text.includes('TOKEN-') ? index : -1))
  .filter((index) => index >= 0)
assert(tokenIndexes.length === 3, `three scratch prompts in the context (got ${tokenIndexes.length})`)
const originalMiddleReplies = first.body.derived
  .slice(tokenIndexes[1] + 1, tokenIndexes[2])
  .filter((entry) => entry.role === 'assistant')
assert(originalMiddleReplies.length >= 1, 'the middle reply exists before the rerun')
const originalMiddleReplyIds = new Set(originalMiddleReplies.map((entry) => entry.id))

// 2. Rerun the middle turn through the plugin's own route.
const state = await call('GET', `/dsh-rerun-turn/state?sessionId=${encodeURIComponent(sessionId)}`)
assert(state.status === 200 && state.body.ok, '/state answers')
const middle = state.body.replies.find((reply) => reply.turn === 2)
assert(middle !== undefined, 'turn 2 has a reply to target')
const applied = await call('POST', '/dsh-rerun-turn/apply', { sessionId, seq: middle.seq })
assert(applied.status === 200 && applied.body.ok && applied.body.started === true, '/apply starts the rerun')
assert(Array.isArray(applied.body.shadowed) && applied.body.shadowed.length > 0, 'the shadow covers the tail')

// 3. Wait for the background regeneration and replay.
let finalState = null
for (let attempt = 0; attempt < 150; attempt += 1) {
  await sleep(2000)
  const polled = await call('GET', `/dsh-rerun-turn/state?sessionId=${encodeURIComponent(sessionId)}`)
  if (polled.status !== 200 || !polled.body.ok) continue
  finalState = polled.body
  const progress = polled.body.progress
  if (!polled.body.rerunning && progress && progress.phase === 'done') break
  if (!polled.body.rerunning && progress && (progress.phase === 'interrupted' || progress.phase === 'failed')) {
    console.error('rerun did not finish cleanly:', progress)
    process.exit(1)
  }
}
assert(finalState !== null && finalState.rerunning === false, 'the rerun task finished')
assert(finalState.reruns.length === 1 && finalState.reruns[0].complete === true, 'the ledger reports the rerun complete')
assert(finalState.progress.phase === 'done', `the progress phase is done (got ${finalState.progress && finalState.progress.phase})`)
const debug = await call('GET', '/dsh-rerun-turn/debug')
const replayNotes = (debug.body.requests || []).filter((entry) => entry.kind === 'replay')
console.log('  · replay notes:', JSON.stringify(replayNotes))
assert(
  replayNotes.some((entry) => entry.sync === 'synced' || entry.sync === 'already-current'),
  'the loop turn counter was synced after the replay',
)

// 4. The live derived context is the spliced order.
const after = await call('GET', `/dsh-rerun-turn/dev/derived?sessionId=${encodeURIComponent(sessionId)}`)
assert(after.status === 200 && after.body.ok, 'the derived context reads after the rerun')
const derived = after.body.derived
// The rerun's bookkeeping carrier must never reach the model. The carrier IS an
// empty user message on the surface (that is how a rerun retires a window), and
// /dev/derived reports the request the adapters would send - where an empty user
// message is skipped (dsh-llm-deepseek: `role === "user" && content.length === 0`;
// pi-ai: `dsh-delete-turn:skip-empty-user`). So: no blank or zero-width user
// message in the derived input, and the carrier itself opened no turn.
const blankMessages = derived.filter(
  (entry) => entry.role === 'user' && (entry.text || '').replace(/[\u200B\uFEFF\s]/g, '') === '',
)
assert(blankMessages.length === 0, 'no blank or zero-width user message reaches the model')
assert(finalState.reruns[0].carrierTurn === null, 'the carrier opened no bookkeeping turn')
const userIndexes = derived
  .map((entry, index) => (entry.role === 'user' && entry.text.includes('TOKEN-') ? index : -1))
  .filter((index) => index >= 0)
assert(userIndexes.length === 3, `three user turns survive (got ${userIndexes.length})`)
assert(derived[userIndexes[0]].text.includes(tokens[0]), 'turn 1 keeps its prompt')
assert(derived[userIndexes[1]].text.includes(tokens[1]), 'turn 2 keeps its prompt')
assert(derived[userIndexes[2]].text.includes(tokens[2]), 'turn 3 keeps its prompt')
const middleReplies = derived.slice(userIndexes[1] + 1, userIndexes[2]).filter((entry) => entry.role === 'assistant')
assert(middleReplies.length >= 1, 'the middle turn has a fresh answer')
assert(middleReplies.every((entry) => !originalMiddleReplyIds.has(entry.id)), 'the old middle answer is gone from the context')
const tailReplies = derived.slice(userIndexes[2] + 1).filter((entry) => entry.role === 'assistant')
assert(tailReplies.length >= 1, 'the later turn keeps its answer')
assert(tailReplies.every((entry) => !originalMiddleReplyIds.has(entry.id)), 'the later answer is not the middle one')

// 5. The later turn's copy carries the replay marker. (The carrier itself
//    carries rerunBy/rerunId without an originalSeq; copies cite one.)
const copies = after.body.copies
const marked = copies.filter((copy) => copy.rerunId === finalState.reruns[0].rerunId && typeof copy.originalSeq === 'number')
assert(marked.length >= 2, `the replayed later turn carries its marker (${marked.length} marked copies)`)
const shadowed = new Set(finalState.reruns[0].shadowed)
assert(marked.some((copy) => shadowed.has(copy.originalSeq)), 'at least one copy stands in for a shadowed node')

// 6. The conversation continues after a rerun: the next real turn must open
//    the correct next number (the 0.1.0 carrier-turn shape made the loop reuse
//    a turn number here and every cold read of the log failed afterwards).
const followToken = `TOKEN-4-${Math.random().toString(16).slice(2, 10)}`
const prompted = await call('POST', '/dsh-rerun-turn/dev/prompt', { sessionId, text: `Reply with exactly this text and nothing else: ${followToken}` })
assert(prompted.status === 200 && prompted.body.ok, 'a new turn runs after the rerun')
const continued = await call('GET', `/dsh-rerun-turn/dev/derived?sessionId=${encodeURIComponent(sessionId)}`)
assert(continued.status === 200 && continued.body.ok, 'the derived context reads after the follow-up turn')
const continuedUsers = continued.body.derived
  .map((entry, index) => (entry.role === 'user' && entry.text.includes('TOKEN-') ? index : -1))
  .filter((index) => index >= 0)
assert(continuedUsers.length === 4, `four prompts survive after the follow-up (got ${continuedUsers.length})`)
assert(continued.body.derived[continuedUsers[3]].text.includes(followToken), 'the follow-up prompt is last')
const continuedTail = continued.body.derived.slice(continuedUsers[3] + 1).filter((entry) => entry.role === 'assistant')
assert(continuedTail.length >= 1, 'the follow-up turn got an answer')

console.log('\nlive end-to-end passed')
console.log(`session kept for inspection: ${sessionId}`)
