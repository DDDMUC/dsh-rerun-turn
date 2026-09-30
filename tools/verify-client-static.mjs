// Static checks for the browser half, plus an optional live-delivery check.
//
// Loads lib/client.js the way the client-modules protocol does (a
// `window.__ModuleLoader__.load` registration), runs the factory with stub
// React/JSX runtimes, applies the plugin against a stub context, and asserts:
//
//   - the module id and version match the host half and package.json;
//   - both slot registrations land on the official names with the expected ids
//     and orders;
//   - the zh/en dictionaries agree key for key, and every error code the host
//     can return has copy.
//
// With `--token-file <path>` it also fetches the module group from a RUNNING
// instance and asserts the plugin's browser bytes are actually being served.
//
//   node tools/verify-client-static.mjs
//   node tools/verify-client-static.mjs --token-file ~/Documents/Default\ Project/dsh.log
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = new URL('..', import.meta.url)
const pluginId = 'dsh-rerun-turn'

const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const hostSource = readFileSync(new URL('lib/index.js', root), 'utf8')
const clientSource = readFileSync(new URL('lib/client.js', root), 'utf8')

let passed = 0
function ok(label) {
  passed += 1
  console.log(`  ok ${passed} - ${label}`)
}

// --- version + id sync --------------------------------------------------------

const hostVersion = /PLUGIN_VERSION = '([^']+)'/.exec(hostSource)
const clientVersion = /PLUGIN_VERSION = '([^']+)'/.exec(clientSource)
assert.ok(hostVersion, 'host half declares a version')
assert.ok(clientVersion, 'client half declares a version')
assert.equal(pkg.version, hostVersion[1], 'package.json version matches the host half')
assert.equal(pkg.version, clientVersion[1], 'package.json version matches the client half')
assert.ok(hostSource.includes(`PLUGIN_ID = '${pluginId}'`), 'host half uses the package id')
assert.ok(clientSource.includes(`id: '${pluginId}'`), 'client half registers under the package id')
ok('version and id stay in sync across package.json, host and client')

// --- load the client module ---------------------------------------------------

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
}
await import(new URL('lib/client.js', root))
assert.ok(captured, 'the module registers with __ModuleLoader__')
assert.equal(captured.id, pluginId)

const reactStub = { useState: () => [null, () => {}], useEffect: () => {}, createElement: () => null }
const jsxRuntimeStub = { jsx: () => null, jsxs: () => null, Fragment: {} }
const exportsObject = captured.factory((specifier) => {
  if (specifier === 'react') return reactStub
  if (specifier === 'react/jsx-runtime') return jsxRuntimeStub
  return require(specifier)
})
assert.equal(typeof exportsObject.apply, 'function', 'the factory exports apply()')
assert.deepEqual(exportsObject.inject, ['slots', 'locale'], 'the declared injections match what apply uses')
assert.equal(exportsObject.PLUGIN_VERSION, pkg.version, 'the exported version matches package.json')
ok('the factory loads, exports apply() and declares its injections')

// --- apply against a stub context --------------------------------------------

const registrations = []
const dictionaries = []
const ctx = {
  effect(fn) {
    fn()
    return () => {}
  },
  locale: {
    register(namespace, dicts) {
      dictionaries.push({ namespace, dicts })
    },
  },
  slots: {
    inject(name, register) {
      assert.equal(typeof register, 'function', `inject(${name}) gets a registrar`)
      register()
    },
    register(config, entry) {
      registrations.push({ config, entry })
      return () => {}
    },
  },
}
exportsObject.apply(ctx)

const replySlot = registrations.find((item) => item.config.name === 'conversation.chat.assistant-actions')
const overlaySlot = registrations.find((item) => item.config.name === 'conversation.input.overlay')
assert.ok(replySlot, 'registers an entry in the official assistant-actions strip')
assert.equal(replySlot.config.id, 'rerun-turn-reply')
assert.equal(replySlot.config.order, 6, 'sits right behind the sibling edit pencil (5)')
assert.equal(replySlot.config.locale, pluginId)
assert.equal(typeof replySlot.entry, 'function', 'the strip entry is a component')
assert.ok(overlaySlot, 'registers a per-session overlay controller')
assert.equal(overlaySlot.config.id, 'rerun-turn')
// The shared slot table: delete-turn 8, edit-turn 9, rerun-turn 10. An order
// shared with a sibling leaves the two overlays unordered on the slot.
assert.equal(overlaySlot.config.order, 10, 'the input overlay sits after delete-turn (8) and edit-turn (9)')
assert.equal(typeof overlaySlot.entry, 'function', 'the overlay entry is a component')
ok('both slot registrations land on the official names with the expected ids')

// --- dictionaries -------------------------------------------------------------

assert.equal(dictionaries.length, 1, 'exactly one dictionary registration')
const { zh, en } = dictionaries[0].dicts
assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'zh and en agree key for key')
const errorKeys = Object.keys(en).filter((key) => key.startsWith('error.'))
assert.ok(errorKeys.length >= 10, `error copy exists (${errorKeys.length} codes)`)
for (const key of ['action.rerun', 'confirm.title', 'confirm.body', 'confirm.yes', 'confirm.no', 'notice.deferred', 'notice.loadError']) {
  assert.ok(zh[key] && en[key], `copy exists for ${key}`)
}
ok('the dictionaries are complete and parallel')

// --- required host error codes have client copy ------------------------------
// Every `new HttpError(status, 'code', ...)` in the host half must have an
// error.<code> key, or the client falls back to a generic message.
const hostCodes = new Set()
for (const match of hostSource.matchAll(/new HttpError\(\s*\d+,\s*'([^']+)'/g)) hostCodes.add(match[1])
for (const match of hostSource.matchAll(/new RerunPlanError\('([^']+)'/g)) hostCodes.add(match[1])
const clientCodes = new Set(errorKeys.map((key) => key.slice('error.'.length)))
for (const code of hostCodes) {
  assert.ok(clientCodes.has(code), `client has copy for host error code "${code}"`)
}
ok(`every host failure code has client copy (${hostCodes.size} codes)`)

// --- interop hardening present in the browser half ----------------------------

// I4: a restore must ask the shared attribution helper before clearing
// `display`, and the guard has to sit inside the un-hide branch.
assert.ok(clientSource.includes('function foreignHideOn(row, own)'), 'the hide-attribution helper is present')
assert.ok(clientSource.includes("if (foreignHideOn(row, 'dsrr') === true) return"), 'the un-hide branch keeps a sibling\'s hide')
// I3: the nodes injected into a message row carry their namespace.
assert.ok(clientSource.includes("host.dataset.dsrrActionHost = '1'"), 'the injected host is namespaced')
assert.ok(clientSource.includes("button.dataset.dsrrAction = 'rerun'"), 'the injected button is namespaced')
ok('the hide attribution and the namespaced injection are wired')

// --- optional: the running instance serves these bytes ------------------------

const tokenFileIndex = process.argv.indexOf('--token-file')
if (tokenFileIndex >= 0) {
  const tokenFile = process.argv[tokenFileIndex + 1]
  assert.ok(tokenFile, '--token-file needs a path')
  const logText = readFileSync(tokenFile, 'utf8')
  const urlMatch = [...logText.matchAll(/dsh web:\s*(http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/g)].pop()
  assert.ok(urlMatch, `no dsh web URL found in ${tokenFile}`)
  const pageUrl = new URL(urlMatch[1])
  // The token URL answers 303 with the auth cookie; the redirected page is the
  // real startup document.
  const tokenResponse = await fetch(pageUrl, { redirect: 'manual' })
  const setCookie = tokenResponse.headers.get('set-cookie') || ''
  const cookie = setCookie.split(';')[0]
  assert.ok(cookie.startsWith('dsh'), `expected an auth cookie, got "${setCookie.slice(0, 40)}"`)
  const target = tokenResponse.headers.get('location')
    ? new URL(tokenResponse.headers.get('location'), pageUrl.origin)
    : new URL('/', pageUrl.origin)
  const page = await fetch(target, { headers: { cookie } })
  const html = await page.text()
  assert.ok(page.ok && html.length > 0, 'the startup document loads with the cookie')
  // The startup document embeds the module manifest; the group URL that lists
  // this plugin's client module is the one to fetch.
  const groupMatch = /plugins\/\?\?[^"'&]*dsh-rerun-turn\/client\.js[^"']*/.exec(html)
  assert.ok(groupMatch, 'the startup manifest lists dsh-rerun-turn/client.js')
  const groupUrl = new URL(groupMatch[0].replaceAll('&amp;', '&'), pageUrl.origin)
  const group = await fetch(groupUrl, { headers: { cookie } })
  assert.ok(group.ok, `the module group loads (${group.status})`)
  const found = { src: String(groupUrl), text: await group.text() }
  for (const needle of ['dsrr-action', 'conversation.chat.assistant-actions', "'/dsh-rerun-turn'", 'Rerun this turn']) {
    assert.ok(found.text.includes(needle), `the delivered bytes carry "${needle}"`)
  }
  // The delivered group must parse as a script module.
  new Function(found.text.replace(/^window\.__ModuleLoader__/, 'globalThis.__ModuleLoader__'))
  ok(`the running instance serves the current browser half (${found.src})`)
}

console.log(`\n${passed} client checks passed`)
