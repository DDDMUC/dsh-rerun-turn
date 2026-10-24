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

  getBoundingClientRect() {
    // The rail probe reads marker heights; the tests set them per element.
    const height = typeof this.rectHeight === 'number' ? this.rectHeight : 10
    return { x: 0, y: 0, width: 100, height, top: 0, left: 0, right: 100, bottom: height }
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
const storage = new Map()
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
  // The settings card persists its choice here, and the controller polls the
  // host through a timer; both are stubbed so a test can read the stored value
  // and never leaves a real interval behind.
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
  setInterval: () => 0,
  clearInterval: () => {},
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
// The settings card reads its control from the platform's own primitives, and
// the tree is returned so a test can drive the checkbox the way the page does.
const jsxRuntimeStub = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: {} }
const primitivesStub = { Checkbox: 'Checkbox', Modal: 'Modal', Button: 'Button' }
const stubRequireFor = (react) => (specifier) => {
  if (specifier === 'react') return react
  if (specifier === 'react/jsx-runtime') return jsxRuntimeStub
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
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
    dismissedKey: null,
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
    dismissCalls: [],
    load() {},
    stopPolling() {},
    ensurePolling() {},
    subscribe: () => () => {},
    rerun(entry) {
      this.rerunCalls.push(entry)
    },
    dismissNotice() {
      this.dismissCalls.push(true)
    },
    getSnapshot: () => currentView,
  }
}

/** Render the overlay entry once and return both its tree and its controller. */
function render(currentView, nodes = {}) {
  effects.length = 0
  const controller = stubController(currentView)
  const tree = overlaySlot.entry({
    useChat: () => ({ nodes: new Map(Object.entries(nodes)) }),
    useRerunTurn: () => currentView,
    controller,
    t: (key) => key,
  })
  for (const effect of effects) effect()
  return { controller, tree }
}

/** Run one real applyDom pass through the registered overlay entry. */
function pass(currentView, nodes) {
  return render(currentView, nodes).controller
}

/** The notice nodes in a rendered stack, in order. */
function noticesOf(tree) {
  return tree.props.children.filter((child) => child !== null && child !== undefined && String(child.props && child.props.className).includes('dsrr-notice'))
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

test('the old answer retires the moment the rerun starts, not when the answer lands', () => {
  const answer = row('assistant5', 1)
  const tail = row('turn-tail', 2)
  transcriptRows.length = 0
  transcriptRows.push(answer, tail)
  const nodes = {
    assistant5: { kind: 'assistant-step', anchorSeq: 5, data: { finalNode: { seq: 5 } } },
    'turn-tail': { kind: 'turn-tail', anchorSeq: 20, data: {} },
  }
  pass(view({
    rerunning: true,
    rerunFocus: { turn: 1, carrierSeq: 100, targetSeqs: new Set([5]), tailSeqs: new Set([20]) },
  }), nodes)
  assert.equal(answer.dataset.dsrrHidden, '1', 'the retired answer is hidden while the fresh row streams')
  assert.equal(answer.style.display, 'none')
  assert.equal(tail.dataset.dsrrHidden, undefined, 'the later turn keeps its place')
  assert.equal(tail.style.order, '2')
})

test('the rail drops the retired turns and closes their gap', () => {
  resetPage()
  const nav = new FakeNode('nav')
  const container = new FakeNode('div')
  container.style.height = '32px'
  const marks = []
  for (let turn = 1; turn <= 3; turn += 1) {
    const mark = new FakeNode('button')
    mark.setAttribute('data-index', String(turn - 1))
    mark.setAttribute('aria-label', `跳转到第 ${turn} 轮`)
    mark.style.transform = `translate3d(0px, ${(turn - 1) * 10 + 1}px, 0px)`
    container.appendChild(mark)
    marks.push(mark)
  }
  nav.appendChild(container)
  globalThis.document.body.appendChild(nav)

  const rows = []
  const nodes = {}
  for (let turn = 1; turn <= 3; turn += 1) {
    const node = row(`user${turn}`, turn)
    globalThis.document.body.appendChild(node)
    transcriptRows.push(node)
    rows.push(node)
    nodes[`user${turn}`] = { kind: 'user', data: { seq: turn } }
  }
  // Turn 2 is retired: every row it has is hidden.
  rows[1].style.display = 'none'

  pass(view({ retiredTurns: new Set([2]) }), nodes)
  assert.equal(marks[1].style.display, 'none', 'the retired turn keeps no mark')
  assert.equal(marks[2].style.transform, 'translate3d(0px, 11px, 0px)', 'the next mark closes the gap')
  assert.equal(container.style.height, '32px', "the host's own height is kept: it is what its window measures")

  // The turn is on screen again: its mark comes back, and so does the spacing.
  rows[1].style.display = ''
  pass(view({ retiredTurns: new Set() }), nodes)
  assert.equal(marks[1].style.display, '', 'a visible turn keeps its mark')
  assert.equal(marks[2].style.transform, 'translate3d(0px, 21px, 0px)')
  assert.equal(container.style.height, '32px')
})

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

  // The target reply disappears and a later turn exists: the host goes, the
  // foreign nodes stay. (On the LAST user row an unanswered prompt keeps its
  // button on purpose - that is the "send this prompt again" affordance.)
  const later = row('user6', 3)
  actionsBar(later, 1)
  globalThis.document.body.appendChild(later)
  transcriptRows.push(later)
  pass(view(), { ...nodes, user6: { kind: 'user', data: { seq: 6 } } })
  // An unanswered row keeps its button on purpose (it addresses the newest
  // unanswered prompt, or that very turn - the `resend` setting). What this
  // test guards is that no SECOND host appears and no foreign node is touched.
  assert.equal(hosts().length, 1, 'no ghost node: still exactly one host')
  assert.equal(hosts()[0], host, 'and it is the node that was already there')
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

test('the confirmation is the platform modal, without the A B C1 D E F G line', () => {
  const handle = applyInstance(freshInstance().instance)
  const dict = handle.dictionaries.find((entry) => entry.ns === 'dsh-rerun-turn').dict.zh
  assert.equal(
    dict['confirm.body'].includes('A B C1 D E F G'),
    false,
    'the dialog no longer promises the replayed shape',
  )
  assert.ok(dict['confirm.body'].includes('重新生成'), 'it still says what happens to the turn')

  const effects = []
  handle.registrations.length = 0
  const tree = handle.overlay.entry({
    useChat: () => ({ nodes: new Map() }),
    useRerunTurn: () => view({ confirming: true }),
    controller: stubController(view({ confirming: true })),
    t: (key) => dict[key] ?? key,
  })
  const modal = tree.props.children[0]
  assert.equal(modal.type, 'Modal', 'the confirmation is the platform dialog, not an inline panel')
  assert.equal(modal.props.open, true)
  assert.equal(modal.props.title, dict['confirm.title'])
  const [body, note] = modal.props.children.props.children
  assert.equal(body.props.className, 'dsrr-dialog-text')
  assert.equal(body.props.children, dict['confirm.body'])
  assert.equal(note.props.className, 'dsrr-dialog-note', 'the dialog keeps the sibling plugin\'s two-paragraph shape')
  assert.ok(String(note.props.children).includes('不会改写历史日志'))
  assert.deepEqual(modal.props.footer.props.children.map((button) => button.type), ['Button', 'Button'])
  assert.deepEqual(modal.props.footer.props.children.map((button) => button.props.variant), ['ghost', 'primary'])
})

// --- the plugin page: "ask before rerunning" (slot plugins.row.config) ---------

test('the plugin page registers a row.config entry under the bundle#row key', () => {
  const entry = byName('plugins.row.config')
  assert.ok(entry, 'the settings page must register a plugins.row.config entry')
  assert.equal(entry.config.key, 'dsh-rerun-turn#dsh-rerun-turn', 'the key is <bundle>#<row id>')
})

/** Every element in a React tree, depth first. */
function cardNodes(tree) {
  const out = []
  const visit = (node) => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (typeof node !== 'object' || node.props === undefined || node.props === null) return
    out.push(node)
    visit(node.props.children)
  }
  visit(tree)
  return out
}

/** The card's checkbox / select / a classed node, wherever they sit. */
function checkboxOf(tree) {
  return cardNodes(tree).find((node) => typeof node.props.checked === 'boolean')
}
function selectOf(tree) {
  return cardNodes(tree).find((node) => node.props.className === 'dsrr-select')
}
function classedIn(tree, className) {
  return cardNodes(tree).find((node) => node.props.className === className)
}

test('the row.config summary follows the checkbox', () => {
  storage.clear()
  const entry = byName('plugins.row.config')
  const t = (key) => key
  assert.equal(entry.entry({ view: 'summary', t }), 'config.summary.auto', 'the shipped default follows the host config (off)')
  const tree = entry.entry({ view: 'page', t })
  assert.equal(tree.props.className, 'dsrr-config')
  assert.equal(checkboxOf(tree).props.checked, false)
  checkboxOf(tree).props.onChange(true)
  assert.equal(entry.entry({ view: 'summary', t }), 'config.summary.ask')
  assert.equal(storage.get('dsh-rerun-turn:prefs'), '{"ask":true}', 'the choice is stored, so it survives a reload')
  effects.length = 0
})

test('the settings card defines the two words the host does not', () => {
  // The choice is stated in this plugin's own words - a LOG TURN (every turn is
  // one: the log cannot be deleted) and a VISIBLE TURN (what the transcript
  // should show after the plugins' work). Without the definition the card is
  // unreadable three months later, so the card carries it.
  const handle = applyInstance(freshInstance().instance)
  const entry = byName('plugins.row.config')
  const page = entry.entry({ view: 'page', t: (key) => key })
  const terms = classedIn(page, 'dsrr-terms')
  assert.ok(terms, 'the card carries the convention block')
  assert.equal(page.props.children[0], terms, 'and it leads the card: both settings are worded in its terms')
  assert.ok(classedIn(page, 'dsrr-config-divider'), 'the two settings are separated by a hairline')
  const texts = cardNodes(terms).map((node) => node.props.children).filter((child) => typeof child === 'string')
  assert.ok(texts.includes('config.terms.title'), 'a title')
  assert.ok(texts.includes('config.terms.short'), 'the shorthand')
  assert.ok(texts.includes('config.terms.log') && texts.includes('config.terms.log.def'), 'the log turn and its meaning')
  assert.ok(texts.includes('config.terms.visible') && texts.includes('config.terms.visible.def'), 'the visible turn and its meaning')
  const dict = handle.dictionaries.find((item) => item.ns === 'dsh-rerun-turn').dict
  assert.match(dict.zh['config.terms.short'], /Q = 用户输入；O = 模型输出的所有内容块（O = C \+ A \+ T）/, 'zh defines the shorthand')
  assert.match(dict.zh['config.terms.short'], /C = 思维链，A = 正文，T = 工具调用/, 'including C, A and T')
  assert.equal(dict.zh['config.terms.log'], '日志轮')
  assert.equal(dict.zh['config.terms.log.def'], '日志里记录的轮次', 'zh defines a log turn')
  assert.equal(dict.zh['config.terms.visible'], '可见轮')
  assert.equal(dict.zh['config.terms.visible.def'], '对话视窗里、经插件操作之后应该看到的那些轮次', 'and a visible turn')
  assert.match(dict.en['config.terms.short'], /O = every content block the model outputs \(O = C \+ A \+ T\)/, 'en defines the shorthand')
  assert.equal(dict.en['config.terms.log.def'], 'a turn recorded in the log', 'en defines a log turn')
  assert.match(dict.en['config.terms.visible.def'], /the transcript should show/, 'and a visible turn')
  // The options are named with the same words the terms line defines.
  const select = selectOf(page)
  assert.deepEqual(select.props.children.map((option) => option.props.children), ['config.resend.below', 'config.resend.inplace'])
  assert.match(dict.zh['config.resend.below'], /可见轮/, 'the option name uses the defined word')
  assert.match(dict.zh['config.resend.inplace'], /可见轮/, 'both of them')
})

test('with asking off a click reruns at once, with it on it only asks', async () => {
  storage.clear()
  const handle = applyInstance(freshInstance().instance)
  const controller = handle.overlay.config.inject('session-1').controller
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
  const applies = () => calls.filter((url) => url.includes('/apply')).length

  // Off (the host config default): the click goes straight to the host.
  controller.rerun({ seq: 3, messageId: 'm-a1' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(applies(), 1, 'no confirmation step while asking is off')
  assert.equal(controller.getSnapshot().confirming, false)

  // On (the settings page checkbox): the click only opens the confirmation.
  checkboxOf(handle.config.entry({ view: 'page', t: (key) => key })).props.onChange(true)
  controller.rerun({ seq: 3, messageId: 'm-a1' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(applies(), 1, 'nothing is rerun until the confirmation is accepted')
  assert.equal(controller.getSnapshot().confirming, true)

  // Accepting it issues the rerun.
  controller.confirmYes()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(applies(), 2)
  assert.equal(controller.getSnapshot().confirming, false)
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
  const dictionaries = []
  instance.apply({
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
    locale: { register: (ns, dict) => dictionaries.push({ ns, dict }) },
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
    config: registrations.find((item) => item.config.name === 'plugins.row.config'),
    registrations,
    dictionaries,
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

test('a prompt whose reply was deleted keeps a button that addresses the newest unanswered turn', async () => {
  // U1M1 U2 U3M3 ... (M2 deleted): turn 2 has no reply left, so its prompt is
  // an unanswered turn and carries a button - but that button must NOT fall
  // through to the next turn's ANSWER: it addresses the newest unanswered
  // prompt (here turn 2 itself, the only one).
  resetPage()
  const u2 = row('user22', 2)
  const u3 = row('user33', 3)
  actionsBar(u2, 1)
  actionsBar(u3, 1)
  globalThis.document.body.appendChild(u2)
  globalThis.document.body.appendChild(u3)
  transcriptRows.push(u2, u3)
  const nodes = {
    user22: { kind: 'user', data: { seq: 22 } },
    user33: { kind: 'user', data: { seq: 33 } },
  }
  const live = view({ replies: new Map([[33, { seq: 33, turn: 3, messageId: 'm-33' }]]) })
  const controller = pass(live, nodes)
  const hostsIn = (element) => element.querySelectorAll('[data-dsrr-action-host="1"]').length

  assert.equal(hostsIn(u2), 1, 'the unanswered turn carries a button')
  assert.equal(hostsIn(u3), 1, 'the answered turn keeps its own entry')

  const button = u3.querySelector('[data-dsrr-action="rerun"]')
  button.listeners.get('click')({ preventDefault() {}, stopPropagation() {} })
  assert.deepEqual(controller.rerunCalls.map((entry) => entry.seq), [33], 'the answered turn reruns its own reply')

  const unanswered = u2.querySelector('[data-dsrr-action="rerun"]')
  unanswered.listeners.get('click')({ preventDefault() {}, stopPropagation() {} })
  assert.deepEqual(
    controller.rerunCalls.map((entry) => entry.seq),
    [33, 22],
    'the unanswered turn addresses the newest unanswered prompt (turn 2), never turn 3\'s reply',
  )
})

test('the last turn with no reply yet keeps its rerun button and re-sends the prompt', async () => {
  // The shape the request names: the newest prompt has no answer under it, so
  // pressing rerun should send that prompt again. The host accepts a prompt
  // target for exactly this turn (planRerun), so the button addresses the
  // prompt rather than a reply that does not exist.
  resetPage()
  const node = row('user41', 7)
  const { bar } = actionsBar(node, 2)
  globalThis.document.body.appendChild(node)
  transcriptRows.push(node)
  const nodes = { user41: { kind: 'user', data: { seq: 41 } } }
  const live = view({ replies: new Map() })
  const controller = pass(live, nodes)

  const hosts = bar.querySelectorAll('[data-dsrr-action-host="1"]')
  assert.equal(hosts.length, 1, 'an unanswered last prompt keeps its button')
  const button = hosts[0].querySelector('[data-dsrr-action="rerun"]')
  assert.ok(button, 'and it is the namespaced rerun button')
  assert.equal(button.getAttribute('aria-label'), 'action.resend.below', 'its label says which turn it will rerun')
  button.listeners.get('click')({ preventDefault() {}, stopPropagation() {} })
  assert.deepEqual(controller.rerunCalls.map((entry) => entry.seq), [41], 'the click addresses the prompt, the shape the host accepts')
})

test('the resend setting decides what an unanswered turn addresses: the first A below, or its own turn', async () => {
  // Q2 has no reply, and Q3's reply (seq 33) sits below it. `below` (default)
  // reruns THAT reply; `inplace` regenerates Q2's own turn instead.
  const build = () => {
    resetPage()
    const unanswered = row('user42', 2)
    const answered = row('assistant-step3:1', 3)
    actionsBar(unanswered, 1)
    globalThis.document.body.appendChild(unanswered)
    globalThis.document.body.appendChild(answered)
    transcriptRows.push(unanswered, answered)
    return unanswered
  }
  const nodes = {
    user42: { kind: 'user', data: { seq: 42 } },
    'assistant-step3:1': { kind: 'assistant-step', anchorSeq: 33, data: { finalNode: { seq: 33 } } },
  }
  const replies = new Map([[33, { seq: 33, turn: 3, messageId: 'm-33' }]])

  const unanswered = build()
  const byDefault = pass(view({ replies }), nodes)
  const belowButton = unanswered.querySelector('[data-dsrr-action="rerun"]')
  assert.equal(belowButton.getAttribute('aria-label'), 'action.resend.below')
  belowButton.listeners.get('click')({ preventDefault() {}, stopPropagation() {} })
  assert.deepEqual(
    byDefault.rerunCalls.map((entry) => entry.seq),
    [33],
    'the default reruns the reply of the first visible turn below that has an A',
  )

  // inplace: the Q addresses the visible turn it belongs to. Switched through
  // the settings card, exactly as the page does it.
  const configEntry = byName('plugins.row.config')
  const page = configEntry.entry({ view: 'page', t: (key) => key })
  const select = selectOf(page)
  assert.deepEqual(select.props.children.map((option) => option.props.value), ['below', 'inplace'])
  select.props.onChange({ target: { value: 'inplace' } })
  assert.equal(JSON.parse(storage.get('dsh-rerun-turn:prefs')).resend, 'inplace', 'the choice is stored')

  const own = build()
  const inplace = pass(view({ replies }), nodes)
  const ownButton = own.querySelector('[data-dsrr-action="rerun"]')
  assert.equal(ownButton.getAttribute('aria-label'), 'action.resend.inplace')
  ownButton.listeners.get('click')({ preventDefault() {}, stopPropagation() {} })
  assert.deepEqual(inplace.rerunCalls.map((entry) => entry.seq), [42], 'inplace addresses the turn the Q belongs to')

  // A HIDDEN reply is not visible: `below` must skip it and fall through to the
  // newest unanswered prompt instead of addressing something off screen.
  select.props.onChange({ target: { value: 'below' } })
  const skipped = build()
  const hidden = pass(view({ replies, hidden: new Map([[33, 'message']]) }), nodes)
  skipped.querySelector('[data-dsrr-action="rerun"]').listeners.get('click')({ preventDefault() {}, stopPropagation() {} })
  assert.deepEqual(hidden.rerunCalls.map((entry) => entry.seq), [42], 'a hidden reply is skipped, the fallback sends the newest unanswered prompt')

  // Back to the shipped default so the rest of the file sees it.
  select.props.onChange({ target: { value: 'below' } })
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

// --- the progress notice --------------------------------------------------------
//
// A rerun's live progress is polled into the overlay. The interruption text is
// derived from `progress.error`, so two rules matter: it only applies to a
// phase that is actually interrupted/failed (older hosts merged records and
// left the error behind on `done`), and the user can close it.

const deferredProgress = {
  phase: 'interrupted',
  rerunId: 'rerun-1',
  error: 'the regenerated turn did not settle in time; replay deferred',
}

test('a stale progress error on a finished phase is not a notice', () => {
  const { tree } = render(view({ progress: { phase: 'done', rerunId: 'rerun-1', replayed: 2, error: deferredProgress.error } }))
  assert.equal(noticesOf(tree).length, 0, 'done with an inherited error shows nothing')
})

test('an interrupted rerun notice carries a working close button', () => {
  const { tree, controller } = render(view({ progress: deferredProgress }))
  const notices = noticesOf(tree)
  assert.equal(notices.length, 1)
  assert.equal(notices[0].props.children[1].type, 'button', 'a close button is part of the notice')
  notices[0].props.children[1].props.onClick({ stopPropagation() {} })
  assert.equal(controller.dismissCalls.length, 1, 'the close button asks the controller to dismiss')
})

test('clicking the notice body dismisses it too', () => {
  const { tree, controller } = render(view({ progress: deferredProgress }))
  noticesOf(tree)[0].props.onClick()
  assert.equal(controller.dismissCalls.length, 1)
})

test('a dismissed progress notice stays closed, but a new error shows again', () => {
  const key = 'interrupted|rerun-1|the regenerated turn did not settle in time; replay deferred|'
  assert.equal(noticesOf(render(view({ progress: deferredProgress, dismissedKey: key })).tree).length, 0)

  const moved = { ...deferredProgress, error: 'replay deferred: the tail never quieted' }
  assert.equal(noticesOf(render(view({ progress: moved, dismissedKey: key })).tree).length, 1, 'a different error has a different key')
})

test('a prompt error is still shown', () => {
  const progress = { phase: 'replaying', rerunId: 'rerun-2', promptError: 'the prompt was not accepted' }
  const { tree } = render(view({ progress }))
  const notices = noticesOf(tree)
  assert.equal(notices.length, 1)
  assert.equal(notices[0].props.children[0].props.children, 'the prompt was not accepted')
})
