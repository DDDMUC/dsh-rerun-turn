// DOM-level tests for the browser half (node --test).
//
// The client bundle is loaded the way the client-modules protocol loads it
// (window.__ModuleLoader__.load), the factory runs against stub React runtimes,
// and the plugin is applied to a stub slot context - so the entries under test
// are the real ones the host registers. A hand-written DOM stub stands in for
// the transcript, which lets the real applyDom() pass run over real rows.
//
// Covered here:
//   - the slot table (both registrations, the contract orders);
//   - I4 hide attribution: a row is only reopened when no sibling plugin's
//     hide stands, and a display:none this plugin never set is never cleared;
//   - I3 injection: one namespaced host per user row, reused across passes,
//     foreign nodes in the action bar untouched, no ghost nodes.
import assert from 'node:assert/strict'
import test from 'node:test'

// --- DOM stub -----------------------------------------------------------------

const dataAttributeOf = (prop) => 'data-' + String(prop).replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase())
const datasetKeyOf = (attribute) => attribute.slice('data-'.length).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.childNodes = []
    this.parentElement = null
    this.attributes = new Map()
    this.style = {}
    this.className = ''
    this.innerHTML = ''
    this.listeners = new Map()
    // A real dataset is the data-* attribute map; keep both directions in sync
    // so the attribution helpers (which read either route) see the same thing.
    const attributes = this.attributes
    this.dataset = new Proxy(
      {},
      {
        set(target, prop, value) {
          target[prop] = String(value)
          attributes.set(dataAttributeOf(prop), String(value))
          return true
        },
        deleteProperty(target, prop) {
          delete target[prop]
          attributes.delete(dataAttributeOf(prop))
          return true
        },
      },
    )
  }

  get children() {
    return this.childNodes
  }

  get nextSibling() {
    if (this.parentElement === null) return null
    const index = this.parentElement.childNodes.indexOf(this)
    if (index < 0) return null
    return index + 1 < this.parentElement.childNodes.length ? this.parentElement.childNodes[index + 1] : null
  }

  appendChild(child) {
    child.remove()
    child.parentElement = this
    this.childNodes.push(child)
    return child
  }

  insertBefore(child, reference) {
    child.remove()
    child.parentElement = this
    const index = reference === null || reference === undefined ? -1 : this.childNodes.indexOf(reference)
    this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, child)
    return child
  }

  removeChild(child) {
    const index = this.childNodes.indexOf(child)
    if (index >= 0) {
      this.childNodes.splice(index, 1)
      child.parentElement = null
    }
    return child
  }

  remove() {
    if (this.parentElement !== null) this.parentElement.removeChild(this)
  }

  setAttribute(name, value) {
    if (name.startsWith('data-')) this.dataset[datasetKeyOf(name)] = String(value)
    else this.attributes.set(name, String(value))
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }

  hasAttribute(name) {
    return this.attributes.has(name)
  }

  removeAttribute(name) {
    if (name.startsWith('data-')) delete this.dataset[datasetKeyOf(name)]
    else this.attributes.delete(name)
  }

  addEventListener(type, handler) {
    this.listeners.set(type, handler)
  }

  matches(selector) {
    return selector
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .some((part) => this.matchesOne(part))
  }

  matchesOne(selector) {
    let rest = selector
    const tag = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(rest)
    if (tag !== null) {
      if (this.tagName !== tag[0].toUpperCase()) return false
      rest = rest.slice(tag[0].length)
    }
    const attribute = /\[\s*([a-zA-Z0-9_-]+)(?:\s*(\*=|=)\s*"([^"]*)")?\s*\]/g
    let match
    while ((match = attribute.exec(rest)) !== null) {
      const name = match[1]
      const actual = name === 'class' ? this.className : this.getAttribute(name)
      if (actual === null || actual === undefined) return false
      if (match[2] === undefined) continue
      if (match[2] === '*=' ? !String(actual).includes(match[3]) : String(actual) !== match[3]) return false
    }
    return true
  }

  querySelectorAll(selector) {
    const out = []
    for (const child of this.childNodes) {
      if (child.matches(selector)) out.push(child)
      out.push(...child.querySelectorAll(selector))
    }
    return out
  }

  querySelector(selector) {
    const all = this.querySelectorAll(selector)
    return all.length > 0 ? all[0] : null
  }
}

const transcriptRows = []
globalThis.HTMLElement = FakeNode
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
}
globalThis.document = {
  body: new FakeNode('body'),
  head: new FakeNode('head'),
  createElement: (tag) => new FakeNode(tag),
  // The style probe finds its own tag, the transcript answers the flow-key
  // query, and anything else is looked up in the body the way a browser would
  // (the dispose sweep walks the whole page, not just the transcript list).
  querySelector: (selector) =>
    String(selector).includes('data-plugin-css')
      ? new FakeNode('style')
      : globalThis.document.body.querySelector(selector),
  querySelectorAll: (selector) =>
    selector === '[data-chat-flow-key]' ? transcriptRows.slice() : globalThis.document.body.querySelectorAll(selector),
}
let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
}

await import(new URL('../lib/client.js', import.meta.url))
assert.ok(captured, 'the module registers with __ModuleLoader__')

const effects = []
const reactStub = {
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: (fn) => {
    effects.push(fn)
  },
  createElement: () => null,
}
const jsxRuntimeStub = { jsx: () => null, jsxs: () => null, Fragment: {} }
const stubRequireFor = (react) => (specifier) => {
  if (specifier === 'react') return react
  if (specifier === 'react/jsx-runtime') return jsxRuntimeStub
  throw new Error(`unexpected require: ${specifier}`)
}
const client = captured.factory(stubRequireFor(reactStub))

const registrations = []
client.apply({
  effect(fn) {
    fn()
    return () => {}
  },
  locale: { register() {} },
  slots: {
    inject(name, register) {
      register()
    },
    register(config, entry) {
      registrations.push({ config, entry })
      return () => {}
    },
  },
})

const byName = (name) => registrations.find((entry) => entry.config.name === name)
const replySlot = byName('conversation.chat.assistant-actions')
const overlaySlot = byName('conversation.input.overlay')

// --- helpers ------------------------------------------------------------------

function row(key, turn) {
  const node = new FakeNode('div')
  node.setAttribute('data-chat-flow-key', key)
  node.dataset.chatTurn = String(turn)
  return node
}

function actionsBar(rowNode, count) {
  const bar = new FakeNode('div')
  bar.className = 'chat_actions_bar__h1x2'
  rowNode.appendChild(bar)
  const buttons = []
  for (let index = 0; index < count; index += 1) {
    const button = new FakeNode('button')
    button.className = `platform-action-${index}`
    bar.appendChild(button)
    buttons.push(button)
  }
  return { bar, buttons }
}

function view(patch) {
  return Object.freeze({
    hidden: new Map(),
    reruns: [],
    replies: new Map(),
    repliesByMessage: new Map(),
    busy: false,
    rerunning: false,
    progress: null,
    pending: false,
    failure: null,
    notice: null,
    noticeError: false,
    confirming: false,
    loaded: true,
    loadError: false,
    confirm: false,
    rerunFocus: null,
    markerTurns: new Set(),
    retiredTurns: new Set(),
    revision: 0,
    ...patch,
  })
}

/** The controller surface applyDom touches, with every rerun it was asked for. */
function stubController(currentView) {
  return {
    rowCount: -1,
    rerunCalls: [],
    load() {},
    stopPolling() {},
    ensurePolling() {},
    subscribe: () => () => {},
    rerun(entry) {
      this.rerunCalls.push(entry)
    },
    getSnapshot: () => currentView,
  }
}

/** Run one real applyDom pass through the registered overlay entry. */
function pass(currentView, nodes) {
  effects.length = 0
  const controller = stubController(currentView)
  overlaySlot.entry({
    useChat: () => ({ nodes: new Map(Object.entries(nodes)) }),
    useRerunTurn: () => currentView,
    controller,
    t: (key) => key,
  })
  for (const effect of effects) effect()
  return controller
}

// --- slot table -----------------------------------------------------------------

test('the two slot registrations carry the contract ids and orders', () => {
  assert.ok(replySlot, 'the assistant-actions strip is registered')
  assert.equal(replySlot.config.id, 'rerun-turn-reply')
  assert.equal(replySlot.config.order, 6, 'behind the sibling edit pencil (5)')
  assert.ok(overlaySlot, 'the input overlay is registered')
  assert.equal(overlaySlot.config.id, 'rerun-turn')
  // delete-turn 8 / edit-turn 9 / this plugin 10: a shared order leaves the
  // siblings' relative order undefined.
  assert.equal(overlaySlot.config.order, 10, 'after delete-turn (8) and edit-turn (9)')
})

// --- bookkeeping turns ----------------------------------------------------------

test('a bookkeeping turn is hidden from the row data, not only from the flow key', () => {
  // DSH keys the process/tail rows by node kind ('turn-tail',
  // '["turn-tail","response"]') and publishes the turn on data-chat-turn.
  // Reading the turn out of the key alone (0.1.14-0.1.25) left the carrier
  // turn's empty "completed" strip on screen - the reported empty shell.
  const strip = row('turn-tail', 4)
  const process = row('["turn-process","response"]', 4)
  const live = row('["turn-tail","response"]', 5)
  transcriptRows.length = 0
  transcriptRows.push(strip, process, live)
  const nodes = {
    'turn-tail': { kind: 'turn-tail', data: { seq: 40 } },
    '["turn-process","response"]': { kind: 'turn-process', data: { seq: 41 } },
    '["turn-tail","response"]': { kind: 'turn-tail', data: { seq: 50 } },
  }
  pass(view({ markerTurns: new Set([4]) }), nodes)
  assert.equal(strip.dataset.dsrrHidden, '1', 'the carrier turn strip is hidden')
  assert.equal(strip.style.display, 'none')
  assert.equal(process.dataset.dsrrHidden, '1', 'its process row too')
  assert.equal(live.dataset.dsrrHidden, undefined, 'a live turn is untouched')
})

test('a retired turn is hidden from the row data as well', () => {
  const strip = row('turn-tail', 2)
  transcriptRows.length = 0
  transcriptRows.push(strip)
  pass(view({ retiredTurns: new Set([2]) }), { 'turn-tail': { kind: 'turn-tail', data: { seq: 20 } } })
  assert.equal(strip.dataset.dsrrHidden, '1')
})

// --- I4 hide attribution --------------------------------------------------------

test('a sibling hide keeps the row closed even after this plugin retracts its own', () => {
  const node = row('user5', 1)
  transcriptRows.length = 0
  transcriptRows.push(node)
  const nodes = { user5: { kind: 'user', data: { seq: 5 } } }

  // The host reports seq 5 retired: this plugin hides the row.
  pass(view({ hidden: new Map([[5, 1]]) }), nodes)
  assert.equal(node.dataset.dsrrHidden, '1')
  assert.equal(node.style.display, 'none')

  // dsh-edit-turn hides the same row with its own attribution.
  node.dataset.dshetHidden = '1'
  node.style.display = 'none'

  // The host no longer reports it retired, so this plugin tries to reopen it.
  pass(view({ hidden: new Map() }), nodes)
  assert.equal(node.style.display, 'none', 'the sibling hide still stands')
  assert.equal(node.dataset.dsrrHidden, '1', 'my marker stays, so a later pass can still retract it')

  // The sibling releases its hide: nothing pins the row any more.
  delete node.dataset.dshetHidden
  pass(view({ hidden: new Map() }), nodes)
  assert.equal(node.style.display, '')
  assert.equal(node.dataset.dsrrHidden, undefined, 'my marker is gone with my hide')
})

test('a sibling hide expressed as a bare attribute is respected too', () => {
  const node = row('user6', 1)
  transcriptRows.length = 0
  transcriptRows.push(node)
  const nodes = { user6: { kind: 'user', data: { seq: 6 } } }

  pass(view({ hidden: new Map([[6, 1]]) }), nodes)
  assert.equal(node.style.display, 'none')

  // delete-turn that only mirrors its marker into the attribute (no dataset).
  node.setAttribute('data-dshdt-hidden', '1')
  pass(view({ hidden: new Map() }), nodes)
  assert.equal(node.style.display, 'none', 'the attribute alone owns the hide')
  assert.equal(node.dataset.dsrrHidden, '1')

  node.removeAttribute('data-dshdt-hidden')
  pass(view({ hidden: new Map() }), nodes)
  assert.equal(node.style.display, '')
})

test('a display:none this plugin never set is never cleared', () => {
  const node = row('user7', 1)
  node.style.display = 'none'
  node.dataset.dshdtHidden = '1'
  transcriptRows.length = 0
  transcriptRows.push(node)

  pass(view({ hidden: new Map() }), { user7: { kind: 'user', data: { seq: 7 } } })
  assert.equal(node.style.display, 'none', 'no own marker, no right to reopen')
  assert.equal(node.dataset.dsrrHidden, undefined, 'and no marker is claimed either')
  assert.equal(node.dataset.dshdtHidden, '1', "the sibling's marker is untouched")
})

// --- I3 injection ---------------------------------------------------------------

test('the user-row button is injected once, namespaced, and never disturbs foreign nodes', () => {
  const node = row('user5', 2)
  const { bar, buttons } = actionsBar(node, 2)
  // A sibling plugin's own node already sits in the bar.
  const sibling = new FakeNode('span')
  sibling.className = 'dshet-action-host'
  bar.appendChild(sibling)
  transcriptRows.length = 0
  transcriptRows.push(node)
  const nodes = { user5: { kind: 'user', data: { seq: 5 } } }
  const live = view({ replies: new Map([[9, { seq: 9, turn: 2, messageId: 'm-9' }]]) })

  pass(live, nodes)
  const hosts = () => bar.querySelectorAll('[data-dsrr-action-host="1"]')
  assert.equal(hosts().length, 1, 'exactly one injected host')
  const host = hosts()[0]
  assert.equal(host.dataset.dsrrActionHost, '1')
  assert.equal(host.querySelectorAll('button').length, 1)
  assert.equal(host.querySelectorAll('button')[0].dataset.dsrrAction, 'rerun', 'the button is namespaced')
  assert.ok(bar.childNodes.includes(sibling), "the sibling's node is still there")
  assert.deepEqual(
    buttons.map((button) => bar.childNodes.includes(button)),
    [true, true],
    'the platform buttons were not moved out',
  )

  // Repeated passes (MutationObserver churn) reuse the node instead of stacking.
  pass(live, nodes)
  pass(live, nodes)
  assert.equal(hosts().length, 1, 'still one host after three passes')
  assert.equal(hosts()[0], host, 'the same node is reused')
  assert.equal(bar.childNodes.includes(sibling), true)

  // Nothing is assumed about being the last child: a foreign append survives.
  const late = new FakeNode('button')
  bar.appendChild(late)
  pass(live, nodes)
  assert.equal(bar.childNodes.includes(late), true, 'a node added after the pass is untouched')
  assert.equal(hosts().length, 1)

  // The target reply disappears: the host goes, the foreign nodes stay.
  pass(view(), nodes)
  assert.equal(hosts().length, 0, 'no ghost node is left behind')
  assert.equal(bar.childNodes.includes(sibling), true)
})

test('a host left by a previous instance is adopted, and only extra copies are dropped', () => {
  const node = row('user5', 1)
  const { bar } = actionsBar(node, 1)
  const orphan = new FakeNode('span')
  orphan.className = 'dsrr-action-host'
  orphan.dataset.dsrrActionHost = '1'
  bar.appendChild(orphan)
  // An older build stacked a second one: it is this plugin's own node, so it is
  // the one thing the pass may drop - the first host is reused, not replaced
  // (contract I3: repeat renders reuse the node they find).
  const extra = new FakeNode('span')
  extra.className = 'dsrr-action-host'
  extra.dataset.dsrrActionHost = '1'
  bar.appendChild(extra)
  transcriptRows.length = 0
  transcriptRows.push(node)

  pass(view({ replies: new Map([[9, { seq: 9, turn: 1, messageId: 'm-9' }]]) }), { user5: { kind: 'user', data: { seq: 5 } } })
  const hosts = bar.querySelectorAll('[data-dsrr-action-host="1"]')
  assert.equal(hosts.length, 1, 'one host, not three')
  assert.equal(hosts[0], orphan, 'the node that was already there is the one that stays')
  assert.equal(bar.childNodes.includes(extra), false, 'the stacked copy is gone')
})

// --- I3 re-apply: dispose cleans up, a re-apply adopts -------------------------

/** A fresh factory call is a fresh module instance: its WeakMaps start empty,
 * which is what an HMR reload / a plugin re-apply hands the page. */
function freshInstance() {
  const instanceEffects = []
  const instance = captured.factory(stubRequireFor({ ...reactStub, useEffect: (fn) => instanceEffects.push(fn) }))
  return { instance, effects: instanceEffects }
}

/** Apply a module instance against a disposable stub context. */
function applyInstance(instance) {
  const disposers = []
  const registrations = []
  instance.apply({
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
    locale: { register() {} },
    slots: {
      inject(name, register) {
        register()
      },
      register(config, entry) {
        registrations.push({ config, entry })
        return () => {}
      },
    },
  })
  return {
    overlay: registrations.find((item) => item.config.name === 'conversation.input.overlay'),
    /** Cordis disposes a fiber's effects in reverse registration order. */
    dispose() {
      for (let index = disposers.length - 1; index >= 0; index -= 1) disposers[index]()
    },
  }
}

/** One real applyDom pass through a given instance's overlay entry. */
function runPass(handle, currentView, nodes, instanceEffects) {
  instanceEffects.length = 0
  const controller = stubController(currentView)
  handle.overlay.entry({
    useChat: () => ({ nodes: new Map(Object.entries(nodes)) }),
    useRerunTurn: () => currentView,
    controller,
    t: (key) => key,
  })
  for (const effect of instanceEffects) effect()
  return { controller }
}

/** The page the global dispose sweep walks. */
function resetPage() {
  for (const child of [...globalThis.document.body.childNodes]) child.remove()
  transcriptRows.length = 0
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test('a re-apply adopts the host, and a late pass of the previous instance cannot stack it', async () => {
  resetPage()
  const node = row('user21', 4)
  const { bar, buttons } = actionsBar(node, 2)
  const sibling = new FakeNode('span')
  sibling.className = 'dshet-action-host'
  sibling.dataset.dshetActionHost = '1'
  bar.appendChild(sibling)
  globalThis.document.body.appendChild(node)
  transcriptRows.push(node)
  const nodes = { user21: { kind: 'user', data: { seq: 21 } } }
  const live = view({ replies: new Map([[41, { seq: 41, turn: 4, messageId: 'm-41' }]]) })
  const hosts = () => bar.querySelectorAll('[data-dsrr-action-host="1"]')
  const foreign = () =>
    bar.childNodes.filter((child) => child.getAttribute('data-dsrr-action-host') !== '1').map((child) => child.className || child.tagName)

  // Round 1: the first instance injects its host.
  const first = freshInstance()
  const handle1 = applyInstance(first.instance)
  const pass1 = runPass(handle1, live, nodes, first.effects)
  assert.equal(hosts().length, 1, 'the first pass injects exactly one host')
  const host = hosts()[0]
  const button = host.querySelector('[data-dsrr-action="rerun"]')
  assert.ok(button, 'the host carries the namespaced button')
  const neighbours = foreign()

  // Round 2: a re-apply that starts while the previous instance's node is still
  // in the row - the state the probe caught, because the previous instance's
  // MutationObserver outlives its teardown by a task.
  const second = freshInstance()
  const handle2 = applyInstance(second.instance)
  const pass2 = runPass(handle2, live, nodes, second.effects)
  assert.equal(hosts().length, 1, 'the re-apply adopts instead of adding a second host')
  assert.equal(hosts()[0], host, 'the node the previous instance injected is reused')
  assert.deepEqual(foreign(), neighbours, 'no foreign node was added, moved or dropped')

  // The dying instance wakes on that childList churn and runs one more pass.
  runPass(handle1, live, nodes, first.effects)
  assert.equal(hosts().length, 1, 'one host after the late pass of the previous instance')
  assert.equal(hosts()[0], host)

  // The adopted button acts on the CURRENT instance, never on a stale closure.
  button.listeners.get('click')({ preventDefault() {}, stopPropagation() {} })
  assert.equal(pass2.controller.rerunCalls.length, 1, 'the click reached the live controller')
  assert.equal(pass1.controller.rerunCalls.length, 0, 'the dead instance did not act')

  // The first instance finally tears down: every node of this namespace goes -
  // including the one the live instance adopted - and the live instance's next
  // pass injects its own again (the removal is a mutation, so it wakes).
  handle1.dispose()
  await settle()
  assert.equal(hosts().length, 0, "dispose sweeps this plugin's own nodes")
  assert.equal(bar.childNodes.includes(sibling), true, "the sibling plugin's node survives")
  assert.deepEqual(buttons.map((item) => bar.childNodes.includes(item)), [true, true], 'the platform buttons survive')
  runPass(handle2, live, nodes, second.effects)
  assert.equal(hosts().length, 1, 'the live instance re-injects on the next pass')
  assert.deepEqual(foreign(), neighbours, 'and the neighbours are still untouched')

  // Its own teardown leaves nothing behind either.
  handle2.dispose()
  await settle()
  assert.equal(hosts().length, 0, 'no ghost host is left behind')
  assert.equal(bar.childNodes.includes(sibling), true)

  // Round 3, after two full dispose cycles: still exactly one host.
  const third = freshInstance()
  const handle3 = applyInstance(third.instance)
  runPass(handle3, live, nodes, third.effects)
  assert.equal(hosts().length, 1, 'two apply/dispose rounds still leave one host')
  assert.deepEqual(foreign(), neighbours)
  handle3.dispose()
  await settle()
  assert.equal(hosts().length, 0)
})

test('a dispose clears every node this plugin injected and nothing else', async () => {
  resetPage()
  const node = row('user22', 5)
  const { bar } = actionsBar(node, 1)
  globalThis.document.body.appendChild(node)
  transcriptRows.push(node)
  const nodes = { user22: { kind: 'user', data: { seq: 22 } } }
  const live = view({ replies: new Map([[42, { seq: 42, turn: 5, messageId: 'm-42' }]]) })

  const { instance, effects: instanceEffects } = freshInstance()
  const handle = applyInstance(instance)
  runPass(handle, live, nodes, instanceEffects)
  assert.equal(globalThis.document.body.querySelectorAll('[data-dsrr-action-host="1"]').length, 1, 'the row host is in the page')

  // The React-rendered half of this plugin (the strip button, the overlay root)
  // plus the nodes of a sibling plugin and of the platform.
  const strip = new FakeNode('button')
  strip.dataset.dsrrAction = 'rerun'
  const overlay = new FakeNode('div')
  overlay.dataset.dsrrOverlay = '1'
  const sibling = new FakeNode('span')
  sibling.className = 'dshet-action-host'
  sibling.dataset.dshetActionHost = '1'
  const platform = new FakeNode('button')
  platform.className = 'platform-action'
  for (const child of [strip, overlay, sibling, platform]) globalThis.document.body.appendChild(child)

  handle.dispose()
  // The React-owned nodes are re-checked one task later; a node that is still
  // there by then is a genuine leftover.
  await settle()

  const owned = () =>
    globalThis.document.body.querySelectorAll('[data-dsrr-action-host="1"], [data-dsrr-action="rerun"], [data-dsrr-overlay="1"]')
  assert.equal(owned().length, 0, 'every node of this plugin is gone')
  assert.equal(globalThis.document.body.childNodes.includes(sibling), true, "the sibling plugin's node is untouched")
  assert.equal(globalThis.document.body.childNodes.includes(platform), true, "the host's own node is untouched")
  assert.equal(bar.childNodes.includes(sibling), false, 'nothing was moved into the action bar')
})

