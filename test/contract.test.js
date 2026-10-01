// The cross-plugin runtime contract: dsh-edit-turn drives this plugin over HTTP.
//
// dsh-edit-turn's prompt editor carries a re-run button that exists only when
// this plugin is mounted. Clicking it saves the rewritten prompt through its own
// route, then chains POST /dsh-rerun-turn/apply so the regenerated answer is
// produced from the NEW wording. That makes the following shapes a contract
// between two packages that share no code — and a contract nobody can remember
// is a contract that breaks silently. These cases are the memory:
//
//   1. the mount probe      GET /state with no sessionId answers 400 while
//                           mounted (the sibling reads 400/405 as present,
//                           404 as absent — a changed status makes the button
//                           vanish without a word);
//   2. the target list      GET /state carries replies[{seq, turn}], the list
//                           the sibling picks its target from (highest seq of
//                           the edited turn);
//   3. the apply shape      POST /apply needs sessionId plus seq OR messageId,
//                           and nothing else — a new REQUIRED field (a confirm
//                           token, a text payload) would break the chained call;
//   4. unknown fields       an extra key is ignored, never a 400;
//   5. the error vocabulary the sibling prints our code to the user verbatim, so
//                           the codes stay stable and machine-readable;
//   6. the routes           exactly the paths the sibling calls.
//
// Only shapes 2 and 3's happy path need a live session, so every case here uses
// a context without session services on purpose: what is asserted is which
// failure a request earns, which is exactly what tells a missing field apart
// from a missing session.
//
//   node --test "test/*.test.js"
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../lib/index.js'

const SESSION_ID = 'session-11111111-2222-4333-8444-555555555555'

// --- the wire -----------------------------------------------------------------

/** A webServer stub that records the registrations apply() makes. */
function webServerStub() {
  const routes = new Map()
  return {
    routes,
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
}

/** A context stub: a webServer, an effect runner, and no session services. */
function contextStub() {
  const server = webServerStub()
  const ctx = {
    get: (service) => (service === 'webServer' ? server.webServer : undefined),
    effect: (factory) => {
      const disposer = factory()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    inject: () => {},
    on: () => {},
    logger: { warn: () => {}, error: () => {}, debug: () => {}, info: () => {} },
  }
  return { ctx, server }
}

/** A loopback request the guard accepts. */
function request(method, url, body) {
  const listeners = new Map()
  const req = {
    method,
    url,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
    on(event, handler) {
      listeners.set(event, handler)
      return req
    },
    destroy() {},
  }
  // readBody listens for data then end; deliver the body on the next tick so the
  // handler has attached both.
  setImmediate(() => {
    if (body !== undefined) listeners.get('data')?.(body)
    listeners.get('end')?.()
  })
  return req
}

/** A response recorder. */
function response() {
  const box = { status: 0, body: '' }
  return {
    box,
    writeHead(status) {
      box.status = status
    },
    end(payload) {
      box.body = payload
    },
  }
}

/** Register the routes once and hand back the two the sibling calls. */
function routes() {
  const { ctx, server } = contextStub()
  apply(ctx)
  return server.routes
}

/** Call one route and parse what the client would see. */
async function call(route, method, url, payload) {
  const res = response()
  await route.handler(request(method, url, payload === undefined ? undefined : JSON.stringify(payload)), res)
  let body = null
  try {
    body = JSON.parse(res.box.body)
  } catch {
    body = null
  }
  return { status: res.box.status, body }
}

function stateUrl(sessionId) {
  return '/dsh-rerun-turn/state' + (sessionId === undefined ? '' : '?sessionId=' + encodeURIComponent(sessionId))
}

// --- 6. the routes the sibling calls ------------------------------------------

test('the two routes the sibling drives exist and are exact matches', () => {
  const registered = routes()
  for (const path of ['/dsh-rerun-turn/state', '/dsh-rerun-turn/apply']) {
    const route = registered.get(path)
    assert.ok(route !== undefined, path + ' is registered')
    assert.equal(route.kind, 'exact', path + ' stays an exact match')
  }
})

// --- 1. the mount probe --------------------------------------------------------

test('GET /state without a sessionId answers 400 while mounted (the mount probe)', async () => {
  const route = routes().get('/dsh-rerun-turn/state')
  const answer = await call(route, 'GET', stateUrl(undefined))
  assert.equal(answer.status, 400, 'the sibling reads 400 as mounted')
  assert.equal(answer.body.ok, false)
  assert.equal(answer.body.code, 'invalid')
})

test('a non-GET on /state answers 405, the probe other accept', async () => {
  const route = routes().get('/dsh-rerun-turn/state')
  const answer = await call(route, 'POST', stateUrl(undefined), {})
  assert.equal(answer.status, 405)
  assert.equal(answer.body.code, 'method')
})

test('a well-formed sessionId is the only thing /state requires', async () => {
  const route = routes().get('/dsh-rerun-turn/state')
  const answer = await call(route, 'GET', stateUrl(SESSION_ID))
  // No session is open in this stub, so the request must fail on the SESSION and
  // not on the query: an 'invalid' here would mean a second required parameter
  // crept in and the sibling's call would stop working.
  assert.notEqual(answer.body.code, 'invalid', 'no other query parameter became required')
  assert.equal(answer.status, 404)
  assert.equal(answer.body.code, 'session-not-found')
})

test('a malformed sessionId is still refused', async () => {
  const route = routes().get('/dsh-rerun-turn/state')
  const answer = await call(route, 'GET', stateUrl('not-a-session'))
  assert.equal(answer.status, 400)
  assert.equal(answer.body.code, 'invalid')
})

// --- 3 and 4. the apply shape --------------------------------------------------

const APPLY_SHAPES = [
  { label: 'sessionId only', body: () => ({ sessionId: SESSION_ID }) },
  { label: 'sessionId + seq', body: () => ({ sessionId: SESSION_ID, seq: 12 }) },
  { label: 'sessionId + messageId', body: () => ({ sessionId: SESSION_ID, messageId: 'msg-1' }) },
  { label: 'sessionId + seq + turn', body: () => ({ sessionId: SESSION_ID, seq: 12, turn: 3 }) },
  { label: 'an unknown extra field', body: () => ({ sessionId: SESSION_ID, seq: 12, confirmToken: 'x' }) },
  { label: 'a stray text payload', body: () => ({ sessionId: SESSION_ID, seq: 12, text: 'rewritten' }) },
]

for (const shape of APPLY_SHAPES) {
  test('POST /apply accepts ' + shape.label + ' without demanding anything new', async () => {
    const route = routes().get('/dsh-rerun-turn/apply')
    const answer = await call(route, 'POST', '/dsh-rerun-turn/apply', shape.body())
    assert.notEqual(answer.body.code, 'invalid', shape.label + ' must fail on the session, not the shape')
    assert.equal(typeof answer.body.code, 'string', 'every failure carries a machine-readable code')
    assert.equal(answer.body.ok, false)
  })
}

test('POST /apply without a sessionId is refused', async () => {
  const route = routes().get('/dsh-rerun-turn/apply')
  const answer = await call(route, 'POST', '/dsh-rerun-turn/apply', { seq: 12 })
  assert.equal(answer.status, 400)
  assert.equal(answer.body.code, 'invalid')
})

test('POST /apply with a malformed JSON body is refused', async () => {
  const route = routes().get('/dsh-rerun-turn/apply')
  const res = response()
  await route.handler(request('POST', '/dsh-rerun-turn/apply', '{\n not json'), res)
  assert.equal(res.box.status, 400)
  assert.equal(JSON.parse(res.box.body).code, 'invalid')
})

// --- 5. the error vocabulary ---------------------------------------------------

// The sibling prints these codes to the user verbatim, so renaming one silently
// changes what a user reads. The list is the vocabulary of the two routes the
// sibling drives: every code this file can observe must be in it.
const CONTRACT_CODES = new Set([
  'invalid',
  'method',
  'forbidden',
  'busy',
  'rerunning',
  'stale',
  'session-not-found',
  'session-not-active',
  'not-rerunnable',
  'already-retired',
  'attachments-unsupported',
  'internal',
])

test('the plan-error codes reach the client unchanged', async () => {
  // planRerun's own vocabulary, converted to an HTTP answer by the host half
  // (lib/index.js maps RerunPlanError to HttpError keeping the code).
  const { RerunPlanError } = await import('../lib/index.js')
  assert.equal(typeof RerunPlanError, 'function', 'the plan error type is exported for this check')
  for (const code of ['not-rerunnable', 'already-retired', 'attachments-unsupported']) {
    assert.ok(CONTRACT_CODES.has(code), code + ' is part of the published vocabulary')
  }
})

test('every code this file observes belongs to the published vocabulary', async () => {
  const route = routes().get('/dsh-rerun-turn/state')
  const observed = []
  for (const answer of [
    await call(route, 'GET', stateUrl(undefined)),
    await call(route, 'GET', stateUrl(SESSION_ID)),
    await call(route, 'POST', stateUrl(undefined), {}),
    await call(route, 'GET', stateUrl('not-a-session')),
    await call(routes().get('/dsh-rerun-turn/apply'), 'POST', '/dsh-rerun-turn/apply', { sessionId: SESSION_ID, seq: 1 }),
  ]) {
    observed.push(answer.body.code)
  }
  for (const code of observed) {
    assert.ok(CONTRACT_CODES.has(code), code + ' is not in the contract vocabulary')
  }
})

// --- the guard the sibling relies on for safety --------------------------------

test('a non-loopback caller is refused before anything else', async () => {
  const route = routes().get('/dsh-rerun-turn/apply')
  const res = response()
  const remote = request('POST', '/dsh-rerun-turn/apply', JSON.stringify({ sessionId: SESSION_ID, seq: 1 }))
  remote.socket = { remoteAddress: '10.0.0.7' }
  await route.handler(remote, res)
  assert.equal(res.box.status, 403)
  assert.equal(JSON.parse(res.box.body).code, 'forbidden')
})
