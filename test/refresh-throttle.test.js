// 行增长节流 + 传输层失败重试（回归：大会话里每加一行就重拉 /state，
// 一旦 fetch 失败就把「状态加载失败」永久钉在面板上）。
process.env.DSH_RERUN_ROW_REFRESH_MS = '40'
process.env.DSH_RERUN_RETRY_MS = '5'

import assert from 'node:assert/strict'
import test from 'node:test'

const node = (tag) => ({
  tagName: String(tag).toUpperCase(),
  style: {},
  className: '',
  children: [],
  dataset: {},
  attributes: new Map(),
  appendChild(child) { this.children.push(child); return child },
  setAttribute(name, value) { this.attributes.set(name, String(value)) },
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null },
  querySelector() { return null },
  querySelectorAll() { return [] },
  addEventListener() {},
  removeEventListener() {},
  insertBefore(child) { this.children.push(child); return child },
  remove() {},
})
globalThis.document = {
  body: node('body'),
  head: node('head'),
  createElement: (tag) => node(tag),
  querySelector: () => node('style'),
  querySelectorAll: () => [],
}
let captured = null
globalThis.window = {
  __ModuleLoader__: { load(definition) { captured = definition } },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: () => 0,
  clearInterval() {},
}

await import(new URL('../lib/client.js', import.meta.url))

const reactStub = {
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect() {},
  createElement: () => null,
}
const jsxRuntimeStub = { jsx: () => null, jsxs: () => null, Fragment: {} }
const client = captured.factory((specifier) => {
  if (specifier === 'react') return reactStub
  if (specifier === 'react/jsx-runtime') return jsxRuntimeStub
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return { Checkbox: 'Checkbox', Modal: 'Modal', Button: 'Button' }
  throw new Error(`unexpected require: ${specifier}`)
})

const registrations = []
client.apply({
  effect(fn) { fn(); return () => {} },
  locale: { register() {} },
  slots: {
    inject(name, register) { register() },
    register(config, entry) { registrations.push({ config, entry }); return () => {} },
  },
})

const overlay = registrations.find((entry) => entry.config.name === 'conversation.input.overlay')
const controller = overlay.config.inject('session-1').controller
const realLoad = controller.load.bind(controller)

test('行增长：两次增长只触发一次刷新（窗口内合并）', async () => {
  let calls = 0
  controller.load = () => { calls += 1 }
  controller.requestRowRefresh()
  controller.requestRowRefresh()
  assert.equal(calls, 1, '第一次立即刷新，第二次并入等待')
  await new Promise((resolve) => setTimeout(resolve, 90))
  assert.equal(calls, 2, '等待中的那次刷新到点落一次')
  controller.requestRowRefresh()
  assert.equal(calls, 3, '窗口过后再增长才再刷新')
})

test('传输层失败：静默重试，成功即自愈', async () => {
  controller.load = realLoad
  let attempts = 0
  globalThis.fetch = async () => {
    attempts += 1
    if (attempts === 1) throw new Error('Failed to fetch')
    return { ok: true, status: 200, json: async () => ({ ok: true, hidden: [], replies: [], reruns: [], busy: false, rerunning: false, config: {} }) }
  }
  controller.loadAttempts = 0
  await controller.load(true)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(attempts, 2, '第一次失败后自动重试一次')
  assert.equal(controller.getSnapshot().loadError, false, '重试成功后不显示错误')
})

test('传输层失败：重试用尽才显示错误', async () => {
  controller.load = realLoad
  let attempts = 0
  globalThis.fetch = async () => { attempts += 1; throw new Error('Failed to fetch') }
  controller.loadAttempts = 0
  await controller.load(true)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.ok(attempts >= 4, `至少重试 ${attempts - 1} 次`)
  assert.equal(controller.getSnapshot().loadError, true, '重试用尽后显示错误')
})
