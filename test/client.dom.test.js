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
  // The style probe finds its own tag; everything else is absent.
  querySelector: (selector) => (String(selector).includes('data-plugin-css') ? new FakeNode('style') : null),
  querySelectorAll: (selector) => (selector === '[data-chat-flow-key]' ? transcriptRows.slice() : []),
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
const client = captured.factory((specifier) => {
  if (specifier === 'react') return reactStub
  if (specifier === 'react/jsx-runtime') return jsxRuntimeStub
  throw new Error(`unexpected require: ${specifier}`)
})

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

/** Run one real applyDom pass through the registered overlay entry. */
function pass(currentView, nodes) {
  effects.length = 0
  const controller = {
    rowCount: -1,
    load() {},
    stopPolling() {},
    ensurePolling() {},
    subscribe: () => () => {},
    rerun() {},
    getSnapshot: () => currentView,
  }
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

test('a leftover host from a previous instance is swept, not stacked', () => {
  const node = row('user5', 1)
  const { bar } = actionsBar(node, 1)
  const orphan = new FakeNode('span')
  orphan.className = 'dsrr-action-host'
  orphan.dataset.dsrrActionHost = '1'
  bar.appendChild(orphan)
  transcriptRows.length = 0
  transcriptRows.push(node)

  pass(view({ replies: new Map([[9, { seq: 9, turn: 1, messageId: 'm-9' }]]) }), { user5: { kind: 'user', data: { seq: 5 } } })
  const hosts = bar.querySelectorAll('[data-dsrr-action-host="1"]')
  assert.equal(hosts.length, 1, 'one host, not two')
  assert.notEqual(hosts[0], orphan)
  assert.equal(bar.childNodes.includes(orphan), false)
})
