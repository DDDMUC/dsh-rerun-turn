// The two ways a rerun target can be mis-read, both reproduced from a real
// session (2026-10-01, the "this reply cannot be rerun" report):
//
//   1. a turn NUMBER that appears in more than one bracket. Rerunning replays
//      the tail, and a replay opens bookkeeping brackets that reuse a number
//      while carrying no user message. The planner used to take the FIRST
//      bracket holding the number, so a reply that was plainly on screen and
//      had a live prompt in its own bracket was refused with
//      "the turn has no prompt to re-send";
//   2. an event LIST that is not a dense seq vector. The log file leads with a
//      header record the platform's scanner strips, and a resumed log inherits
//      its head, so \`events[seq]\` is not \`the event with this seq\`. In the
//      reproduced session that offset turned a user prompt into a \`step/start\`
//      and the same request failed with "the turn prompt is not a user message".
//
// Both are pinned here, and the second one is also pinned in the shape that
// hurts worst: an inherited head, where every seq is far ahead of its index.
//
//   node --test "test/*.test.js"
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

const P = await import('../lib/index.js')

const uid = (prefix) => prefix + '-' + randomUUID()
const textBlock = (text) => ({ type: 'text', text })

/**
 * Build the bracket shape the failure came from: one turn number, two
 * brackets, the first one carrying a reply but no prompt.
 */
function twoBracketsOneTurn() {
  let seq = 0
  const events = []
  const next = (type, data, extra = {}) => ({ type, seq: seq++, time: 1_700_000_000_000, data, ...extra })
  const push = (event) => {
    events.push(event)
    return event
  }
  const turnStart = (turn) => push(next('turn/start', { turn }))
  const turnEnd = (turn) => push(next('turn/end', { turn, reason: { kind: 'completed' } }))
  const stepStart = (turn, step) => push(next('step/start', { turn, step }))
  const stepEnd = (turn, step) => push(next('step/end', { turn, step }))
  const user = (text) =>
    push(next('user/message', { id: uid('m'), role: 'user', content: [textBlock(text)], source: { kind: 'user' } }, { surfaceOp: 'append' }))
  const assistant = (turn, step, text) =>
    push(
      next(
        'assistant/message',
        {
          turn,
          step,
          message: { id: uid('m'), role: 'assistant', content: [textBlock(text)], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat' } },
          stream: [],
          usage: { inputTokens: 1, outputTokens: 2 },
        },
        { surfaceOp: 'append' },
      ),
    )

  // The head every real log has: the system prompt is surface node 0, and the
  // planner refuses to rerun it. Without it the fixture's first USER message
  // would sit at the head and every plan would be refused for the wrong reason.
  push(
    next(
      'system/message',
      { message: { id: uid('m'), role: 'system', content: [textBlock('system prompt')], source: { kind: 'system-prompt' } } },
      { surfaceOp: 'append' },
    ),
  )

  // A settled turn first, so the log is not degenerate.
  turnStart(1)
  stepStart(1, 1)
  const a = user('A')
  const a1 = assistant(1, 1, 'A1')
  stepEnd(1, 1)
  turnEnd(1)

  // Bracket A: turn 49 again, a reply copy and no user message at all.
  turnStart(2)
  stepStart(2, 1)
  const copy = assistant(2, 1, 'the copy a rerun replayed')
  stepEnd(2, 1)
  turnEnd(2)

  // Bracket B: the same number, this time with a real prompt and its answer.
  turnStart(2)
  stepStart(2, 1)
  const prompt = user('the live prompt')
  const answer = assistant(2, 1, 'the live answer')
  stepEnd(2, 1)
  turnEnd(2)

  return { events, seqs: { a, a1, copy, prompt, answer } }
}

const surfaceOf = (events) => P.foldSurface(events).nodes

test('a turn number in two brackets: the reply that owns the prompt is plannable', () => {
  const { events, seqs } = twoBracketsOneTurn()
  const surface = surfaceOf(events)
  const brackets = P.turnSpans(events).filter((entry) => entry.turn === 2)
  assert.equal(brackets.length, 2, 'the fixture really has two brackets with one number')
  assert.equal(brackets[0].promptSeq, null, 'the first bracket carries no prompt')
  assert.equal(brackets[1].promptSeq, seqs.prompt.seq, 'the second carries the prompt')

  const plan = P.planRerun(events, surface, { seq: seqs.answer.seq })
  assert.equal(plan.promptSeq, seqs.prompt.seq, 'the plan uses the prompt of the bracket that owns the reply')
  assert.equal(plan.prompt.text, 'the live prompt')
  assert.equal(plan.startSeq, seqs.prompt.seq, 'the window opens at that prompt')
})

test('a reply whose own bracket has no prompt is refused, not sent to a stranger prompt', () => {
  const { events, seqs } = twoBracketsOneTurn()
  const surface = surfaceOf(events)
  // Bracket A's copy has no prompt of its own. Falling back to the NEXT
  // bracket's prompt would re-send a question that never produced this answer.
  assert.throws(
    () => P.planRerun(events, surface, { seq: seqs.copy.seq }),
    (error) => error.code === 'not-rerunnable' && /no prompt to re-send/.test(error.message),
  )
})

test('every advertised reply is plannable, and the unplannable one is not advertised', () => {
  const { events, seqs } = twoBracketsOneTurn()
  const surface = surfaceOf(events)
  const advertised = P.rerunnableReplies(events, surface).map((reply) => reply.seq)
  assert.equal(advertised.includes(seqs.copy.seq), false, 'the prompt-less copy is not offered as rerunnable')
  assert.equal(advertised.includes(seqs.answer.seq), true, 'the answer with a prompt is offered')
  for (const seq of advertised) {
    P.planRerun(events, surface, { seq }) // throws if the advertisement lied
  }
})

test('a log that leads with a header record plans exactly the same', () => {
  const { events, seqs } = twoBracketsOneTurn()
  const dense = P.planRerun(events, surfaceOf(events), { seq: seqs.answer.seq })
  // The platform's scanner strips this record before handing events over; a
  // caller that hands over the raw file must still get the same plan.
  const withHeader = [{ type: 'session', version: 4, id: 'session-x', createdAt: 1 }, ...events]
  const shifted = P.planRerun(withHeader, surfaceOf(withHeader), { seq: seqs.answer.seq })
  assert.equal(shifted.promptSeq, dense.promptSeq)
  assert.equal(shifted.startSeq, dense.startSeq)
  assert.deepEqual(shifted.shadowed, dense.shadowed)
  assert.equal(shifted.prompt.text, dense.prompt.text)
})

test('an inherited head (every seq far ahead of its index) plans exactly the same', () => {
  const { events, seqs } = twoBracketsOneTurn()
  const dense = P.planRerun(events, surfaceOf(events), { seq: seqs.answer.seq })
  // A resumed log inherits its head from another file, so the list starts at a
  // seq well past 0: \`events[seq]\` would read the wrong event by that offset.
  // The slice drops the opening turn/start and step/start only — the content
  // stays, so the two plans must agree exactly.
  const inherited = events.slice(2).map((event) => ({ ...event }))
  assert.equal(inherited[0].seq, 2, 'the inherited list no longer starts at seq 0')
  const shifted = P.planRerun(inherited, surfaceOf(inherited), { seq: seqs.answer.seq })
  assert.equal(shifted.promptSeq, dense.promptSeq)
  assert.deepEqual(shifted.shadowed, dense.shadowed)
  assert.equal(shifted.prompt.text, dense.prompt.text)
  // Turn 1's own turn/start went with the sliced head, so its bracket no longer
  // exists and its reply stops being offered — that is the truthful reading of a
  // log that begins mid-conversation. Turn 2 is untouched and must still plan.
  assert.deepEqual(
    P.rerunnableReplies(inherited, surfaceOf(inherited)).map((reply) => reply.seq),
    [seqs.answer.seq],
  )
})

test('padding the list with records that carry no seq changes nothing', () => {
  const { events, seqs } = twoBracketsOneTurn()
  const dense = P.rerunnableReplies(events, surfaceOf(events)).map((reply) => reply.seq)
  // Every index moves, no seq does: the purest form of "the list is not a seq
  // vector". A position-indexing reader shifts with the padding.
  const padded = [{ type: 'session', version: 4 }, { type: 'note' }, { type: 'note' }, ...events]
  assert.deepEqual(P.rerunnableReplies(padded, surfaceOf(padded)).map((reply) => reply.seq), dense)
  const plan = P.planRerun(padded, surfaceOf(padded), { seq: seqs.answer.seq })
  assert.equal(plan.promptSeq, seqs.prompt.seq)
  assert.equal(plan.prompt.text, 'the live prompt')
})

test('a gap in the seqs does not talk the planner into a stranger event', () => {
  const { events, seqs } = twoBracketsOneTurn()
  // Drop the prompt from the ARRAY while every other event keeps its seq. A
  // reader that indexes by position lands on the NEXT event and would happily
  // plan against a prompt that is not there; a seq lookup finds nothing.
  const holed = events.filter((event) => event.seq !== seqs.prompt.seq)
  assert.equal(holed.length, events.length - 1)
  const advertised = P.rerunnableReplies(holed, surfaceOf(holed)).map((reply) => reply.seq)
  assert.equal(advertised.includes(seqs.answer.seq), false, 'a reply whose prompt is gone is not offered')
  assert.equal(advertised.includes(seqs.a1.seq), true, 'the untouched turn keeps its offer')
  // With the prompt's event gone the bracket carries no prompt at all, so the
  // planner says exactly that — not "already-retired", and never a plan built
  // from whatever event happened to sit at that index.
  assert.throws(
    () => P.planRerun(holed, surfaceOf(holed), { seq: seqs.answer.seq }),
    (error) => error.code === 'not-rerunnable' && /no prompt to re-send/.test(error.message),
    'the planner refuses instead of planning a stranger',
  )
})
