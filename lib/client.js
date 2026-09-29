// dsh-rerun-turn - browser half.
//
// Two pieces:
//
//   - a rerun action in the official `conversation.chat.assistant-actions`
//     strip (one per finalized assistant message, receiving its messageId);
//   - a per-session controller in the `conversation.input.overlay` list slot
//     that hides the rows a rerun retired, follows the background rerun to
//     completion, and surfaces its failures.
//
// Hiding reads the official `useChat` standard hook (the ChatSnapshot keyed by
// the same `data-chat-flow-key` the DOM publishes) plus the official
// `data-chat-flow-*` anchors - no React fiber introspection, no CSS-module
// hashes. The retired rows are hidden, not removed: the log keeps them, and
// the replayed copies stand in for them as ordinary rows.
//
// The module is a classic client bundle (client-modules protocol): it registers
// a factory with window.__ModuleLoader__ and returns apply().
window.__ModuleLoader__.load({
  id: 'dsh-rerun-turn',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const jsxRuntime = require('react/jsx-runtime')
    const { jsx, jsxs, Fragment } = jsxRuntime

    const NS = 'dsh-rerun-turn'
    const ROUTE_PREFIX = '/dsh-rerun-turn'

    /** Keep in sync with package.json and lib/index.js. */
    const PLUGIN_VERSION = '0.1.13'

    // --- copy -----------------------------------------------------------------

    const zh = {
      'action.rerun': '重跑这一轮',
      'confirm.title': '重跑这一轮？',
      'confirm.body': '这条回答连同它之后的内容会先从模型上下文移除，再用原提示词重新生成；之后的轮次会原样重放。后续调用将读到 A B C1 D E F G。',
      'confirm.yes': '重跑',
      'confirm.no': '取消',
      'notice.deferred': '重跑已中断：后续轮次的回放将在会话空闲时自动完成。',
      'notice.loadError': '状态加载失败，稍后重试。',
      'error.invalid': '请求无效，请刷新后重试。',
      'error.session-not-active': '这个会话当前未激活，请先打开该会话再重跑。',
      'error.session-not-found': '找不到该会话的日志。',
      'error.busy': '该会话正在回复中，请等回复结束后再重跑。',
      'error.rerunning': '已有一个重跑在进行中。',
      'error.not-rerunnable': '这条回答不支持重跑。',
      'error.rerun-not-found': '找不到这次重跑记录。',
      'error.dev-unavailable': '开发接口不可用。',
      'error.dev-timeout': '开发会话超时。',
      'error.already-retired': '这条回答已经不在当前上下文里了。',
      'error.attachments-unsupported': '这一轮的提示词带文件附件，暂时无法重跑（文件无法重新上传）。',
      'error.stale': '会话刚刚发生了变化，请重试。',
      'error.forbidden': '请求来源不被允许。',
      'error.method': '请求方式不被接受，请刷新后重试。',
      'error.generic': '重跑失败，请重试。',
      'error.internal': '服务器内部错误，请稍后重试。',
    }

    const en = {
      'action.rerun': 'Rerun this turn',
      'confirm.title': 'Rerun this turn?',
      'confirm.body': "The reply and everything after it leave the model context first; the turn's own prompt is sent again, and the later turns are replayed verbatim. The next call will read A B C1 D E F G.",
      'confirm.yes': 'Rerun',
      'confirm.no': 'Cancel',
      'notice.deferred': 'Rerun interrupted: the replay of the later turns will resume automatically once the session is idle.',
      'notice.loadError': 'Loading the state failed; try again shortly.',
      'error.invalid': 'Invalid request; refresh and try again.',
      'error.session-not-active': 'This session is not open in DSH; open it first.',
      'error.session-not-found': 'No session log was found for this id.',
      'error.busy': 'This session is still replying; wait for it to finish.',
      'error.rerunning': 'A rerun is already in flight.',
      'error.not-rerunnable': 'This reply cannot be rerun.',
      'error.rerun-not-found': 'No rerun record was found for this id.',
      'error.dev-unavailable': 'The dev routes are unavailable.',
      'error.dev-timeout': 'The dev session timed out.',
      'error.already-retired': 'This reply is no longer in the current context.',
      'error.attachments-unsupported': "The turn's prompt carries file attachments, which a rerun cannot re-admit yet.",
      'error.stale': 'The session just changed; try again.',
      'error.forbidden': 'The request origin is not allowed.',
      'error.method': 'The request method is not accepted; refresh and try again.',
      'error.generic': 'The rerun failed; try again.',
      'error.internal': 'The host hit an internal error; try again shortly.',
    }

    // Every error code the host can return travels through here. A code is
    // validated against the dictionary before it becomes a lookup key, so a
    // missing or unknown code can never reach `t()` as a constructed key.
    const ERROR_KEYS = new Set(Object.keys(en).filter((key) => key.startsWith('error.')))
    function errorText(t, code) {
      return t(typeof code === 'string' && ERROR_KEYS.has(`error.${code}`) ? `error.${code}` : 'error.generic')
    }

    // --- style ----------------------------------------------------------------

    // Same policy as the sibling plugins: the plugin paints its own surfaces
    // from namespaced variables (dark branch on the official
    // `body[data-ds-dark-theme]` hook), while *colours* keep using the theme
    // variables - a skin may make theme surfaces translucent, and borrowed
    // surface colours would go transparent with it.
    const CSS = [
      ':root{--dsrr-panel:rgba(255,255,255,.96);--dsrr-field:rgba(244,247,252,.98);--dsrr-line:rgba(16,24,40,.16);--dsrr-ink:#0f1524;--dsrr-ink-dim:#4b5872;--dsrr-hover:rgba(16,24,40,.07);--dsrr-shadow:0 12px 32px rgba(9,18,40,.22);--dsrr-accent:#4d6bfe}',
      'body[data-ds-dark-theme]{--dsrr-panel:rgba(22,28,44,.96);--dsrr-field:rgba(14,19,33,.98);--dsrr-line:rgba(255,255,255,.18);--dsrr-ink:#eef2f8;--dsrr-ink-dim:#a6b1c6;--dsrr-hover:rgba(255,255,255,.11);--dsrr-shadow:0 12px 32px rgba(0,0,0,.5)}',
      // The rerun icon sits among the platform's own action icons and takes
      // their colour (the fallback is what the default theme resolves to).
      '.dsrr-action{width:28px;height:28px;padding:6px;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:28px;background:transparent;color:var(--dsw-alias-label-tertiary,#81858c);cursor:pointer;transition:background-color .12s,color .12s}',
      '.dsrr-action:hover:not(:disabled){background:var(--dsrr-field);box-shadow:inset 0 0 0 1px var(--dsrr-line);color:var(--dsw-alias-label-primary,var(--dsrr-ink))}',
      '.dsrr-action:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,var(--dsrr-accent));outline-offset:2px}',
      '.dsrr-action:disabled{cursor:default;opacity:.4}',
      '.dsrr-action svg{width:15px;height:15px}',
      // Next to the sibling edit pencil, ahead of the platform's own actions.
      '.dsrr-reply-action{order:-1}',
      // A retired row is hidden whole: its replayed copy is an ordinary row
      // elsewhere in the transcript, and a turn tail of a retired turn has
      // nothing left to act on.
      '[data-dsrr-hidden="1"]{display:none!important}',
      // The overlay slot host has zero height and sits at the composer's top
      // edge, so its children would spill over the input. The stack lifts
      // itself by its own height, landing fully above the composer.
      '.dsrr-stack{transform:translateY(-100%)}',
      '.dsrr-notice{margin:4px 0;padding:6px 10px;border:1px solid var(--dsrr-line);border-radius:8px;background:var(--dsrr-panel);backdrop-filter:blur(18px) saturate(1.2);box-shadow:var(--dsrr-shadow);color:var(--dsrr-ink-dim);font-size:12px;line-height:19px}',
      '.dsrr-notice.dsrr-notice-error{color:var(--dsw-alias-state-error-primary,#c93a31)}',
      '.dsrr-confirm{margin:4px 0;padding:8px 10px;border:1px solid var(--dsrr-line);border-radius:8px;background:var(--dsrr-panel);backdrop-filter:blur(18px) saturate(1.2);box-shadow:var(--dsrr-shadow);color:var(--dsrr-ink);font-size:12px;line-height:19px}',
      '.dsrr-confirm-title{font-weight:600;margin-bottom:2px}',
      '.dsrr-confirm-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:6px}',
      '.dsrr-btn{padding:4px 12px;border:1px solid var(--dsrr-line);border-radius:999px;background:var(--dsrr-field);color:var(--dsrr-ink);font:inherit;font-size:12px;line-height:18px;cursor:pointer;transition:background-color .12s}',
      '.dsrr-btn:hover{background:var(--dsrr-hover)}',
      '.dsrr-btn:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,var(--dsrr-accent));outline-offset:2px}',
      '.dsrr-btn-primary{border-color:var(--dsw-alias-button-primary-fill,var(--dsrr-accent));background:var(--dsw-alias-button-primary-fill,var(--dsrr-accent));color:var(--dsw-alias-label-primary-foreground,#fff)}',
      '@media (prefers-reduced-motion:reduce){.dsrr-action{transition:none}}',
    ].join('')

    const TAG_ID = 'dsh-rerun-turn/rerun-turn.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(TAG_ID) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = NS
      tag.dataset.pluginCss = TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // --- icon -----------------------------------------------------------------

    // Circular-arrow glyph: open arc plus arrowhead.
    const ICON_PATHS = ['M13.65 2.6v2.9h-2.9', 'M13.3 8a5.3 5.3 0 1 1-1.55-3.75l1.9 1.25']
    const ICON_MARKUP =
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
      ICON_PATHS.map(
        (d) =>
          '<path d="' + d + '" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>',
      ).join('') +
      '</svg>'

    function RerunIcon() {
      return jsx('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': true,
        children: ICON_PATHS.map((d, index) =>
          jsx('path', { d, stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }, index),
        ),
      })
    }

    // --- controller -----------------------------------------------------------

    class RerunController {
      constructor(sessionId) {
        this.sessionId = sessionId
        this.listeners = new Set()
        this.inflight = null
        this.pollTimer = null
        this.rowCount = -1
        this.confirmTarget = null
        this.view = Object.freeze({
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
          loaded: false,
          loadError: false,
          confirm: false,
          revision: 0,
        })
      }

      getSnapshot = () => this.view

      subscribe = (listener) => {
        this.listeners.add(listener)
        return () => {
          this.listeners.delete(listener)
        }
      }

      publish(patch) {
        this.view = Object.freeze({ ...this.view, ...patch, revision: this.view.revision + 1 })
        for (const listener of this.listeners) {
          try {
            listener()
          } catch (error) {
            console.error('[dsh-rerun-turn] subscriber threw:', error)
          }
        }
      }

      dispose() {
        if (this.pollTimer !== null) {
          window.clearInterval(this.pollTimer)
          this.pollTimer = null
        }
      }

      load(force) {
        // A refresh asked for while one is already running has to land *after*
        // it: handing back the in-flight response would answer with a snapshot
        // the host may have taken before a rerun started.
        if (this.inflight !== null) return this.inflight.then(() => this.load(force))
        if (this.view.loaded && force !== true) return Promise.resolve()
        const url = `${ROUTE_PREFIX}/state?sessionId=${encodeURIComponent(this.sessionId)}`
        const pending = fetch(url, { headers: { accept: 'application/json' } })
          .then(async (res) => {
            const data = await res.json().catch(() => ({}))
            if (!res.ok || !data.ok) throw new Error(data && data.error ? String(data.error) : `HTTP ${res.status}`)
            // Hide the rows a rerun retired only once that rerun's replacement
            // is actually on screen. A rerun with no tail turns "complete" the
            // moment its prompt lands, so `complete` alone is not enough: the
            // in-flight rerun (identified by the progress record) stays visible
            // until the whole operation is done.
            const reruns = Array.isArray(data.reruns) ? data.reruns : []
            const completeIds = new Set(reruns.filter((rerun) => rerun && rerun.complete === true).map((rerun) => rerun.rerunId))
            const inFlightId =
              data.rerunning === true && data.progress && typeof data.progress.rerunId === 'string' ? data.progress.rerunId : null
            const hidden = new Map()
            for (const item of Array.isArray(data.hidden) ? data.hidden : []) {
              if (!item || typeof item.seq !== 'number') continue
              if (typeof item.rerunId === 'string') {
                if (!completeIds.has(item.rerunId)) continue
                if (inFlightId !== null && item.rerunId === inFlightId) continue
              }
              hidden.set(item.seq, item.turn)
            }
            const replies = new Map()
            const repliesByMessage = new Map()
            for (const reply of Array.isArray(data.replies) ? data.replies : []) {
              if (!reply || typeof reply.seq !== 'number') continue
              replies.set(reply.seq, reply)
              if (typeof reply.messageId === 'string' && reply.messageId !== '') repliesByMessage.set(reply.messageId, reply)
            }
            const rerunning = data.rerunning === true
            // While a rerun is in flight, its rows are regrouped so the fresh
            // answer streams IN PLACE of the old one: the old reply retires as
            // soon as its replacement exists, the re-sent prompt stays hidden
            // (the standing prompt keeps its spot), and the later turns keep
            // their positions below until the replay lands.
            let rerunFocus = null
            if (inFlightId !== null) {
              const record = reruns.find((rerun) => rerun && rerun.rerunId === inFlightId)
              if (record && typeof record.carrierSeq === 'number' && typeof record.turn === 'number') {
                const targetSeqs = new Set()
                const tailSeqs = new Set()
                for (const item of Array.isArray(data.hidden) ? data.hidden : []) {
                  if (!item || typeof item.seq !== 'number' || item.rerunId !== inFlightId) continue
                  if (item.turn === record.turn) targetSeqs.add(item.seq)
                  else tailSeqs.add(item.seq)
                }
                rerunFocus = {
                  turn: record.turn,
                  carrierSeq: record.carrierSeq,
                  targetSeqs,
                  tailSeqs,
                }
              }
            }
            this.publish({
              hidden,
              replies,
              repliesByMessage,
              reruns: Array.isArray(data.reruns) ? data.reruns : [],
              busy: data.busy === true,
              rerunning,
              rerunFocus,
              progress: data.progress || null,
              loaded: true,
              loadError: false,
              confirm: Boolean(data.config && data.config.confirm),
            })
            // While a rerun runs in the host, keep asking; one last refresh
            // after it ends picks up the replayed turns.
            if (rerunning) this.ensurePolling()
            else this.stopPolling()
          })
          .catch(() => {
            this.publish({ loadError: true })
          })
          .finally(() => {
            this.inflight = null
          })
        this.inflight = pending
        return pending
      }

      ensurePolling() {
        if (this.pollTimer !== null) return
        this.pollTimer = window.setInterval(() => {
          if (this.view.rerunning || this.view.pending) {
            this.load(true)
            return
          }
          // One final refresh, then stop: the replay may have landed between
          // ticks.
          this.load(true)
          this.stopPolling()
        }, 1600)
      }

      stopPolling() {
        if (this.pollTimer !== null) {
          window.clearInterval(this.pollTimer)
          this.pollTimer = null
        }
      }

      rerun(entry) {
        if (this.view.pending) return
        if (this.view.confirm) {
          this.confirmTarget = entry
          this.publish({ confirming: true, failure: null })
          return
        }
        this.send(entry)
      }

      confirmYes() {
        const entry = this.confirmTarget
        this.confirmTarget = null
        this.publish({ confirming: false })
        if (entry) this.send(entry)
      }

      confirmNo() {
        this.confirmTarget = null
        this.publish({ confirming: false })
      }

      dismissNotice() {
        this.publish({ notice: null, noticeError: false })
      }

      async send(entry) {
        if (this.view.pending) return
        this.publish({ pending: true, failure: null, notice: null, noticeError: false })
        try {
          const res = await fetch(`${ROUTE_PREFIX}/apply`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: this.sessionId, seq: entry.seq, messageId: entry.messageId }),
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok || !data.ok) {
            const code = data && data.code ? String(data.code) : 'generic'
            if (code === 'already-retired') {
              // The reply this button belonged to was retired - very often by
              // the rerun that just completed, clicked once more before the
              // client refreshed. Not an error: refresh silently and let the
              // stale row disappear.
              this.publish({ pending: false, failure: null })
              this.load(true)
              return
            }
            this.publish({ pending: false, failure: code })
            return
          }
          // Do NOT hide the retired rows here: the rerun's replacement (fresh
          // answer + replay) is not on screen yet, and /state only reports the
          // retired set for COMPLETED reruns. The rows switch over when the
          // replay lands.
          this.publish({ pending: false, failure: null, rerunning: true })
          this.ensurePolling()
          this.load(true)
        } catch {
          this.publish({ pending: false, failure: 'generic' })
        }
      }
    }

    // --- row hiding -----------------------------------------------------------

    // Every surface seq a row stands for, so one rerun can hide the rows it
    // retired however the host UI chose to group them.
    function seqsFor(node) {
      const data = node.data || {}
      const out = []
      const push = (value) => {
        if (typeof value === 'number' && !out.includes(value)) out.push(value)
      }
      switch (node.kind) {
        case 'user':
        case 'context':
        case 'steering':
          push(data.seq)
          break
        case 'assistant-step':
          push(node.anchorSeq)
          if (data.finalNode) push(data.finalNode.seq)
          break
        case 'tool-call':
          if (data.root) push(data.root.seq)
          break
        case 'turn-tail':
          push(node.anchorSeq)
          if (data.closing && data.closing.finalNode) push(data.closing.finalNode.seq)
          break
        case 'turn-process':
          push(data.answerAnchorSeq)
          break
        default:
          push(node.anchorSeq)
      }
      return out
    }

    function isRowHidden(hidden, seqs) {
      for (const seq of seqs) {
        if (hidden.has(seq)) return true
      }
      return false
    }

    function setRowHidden(row, hide) {
      if (hide) {
        if (row.dataset.dsrrHidden !== '1') {
          row.dataset.dsrrHidden = '1'
          row.style.display = 'none'
        }
        return
      }
      if (row.dataset.dsrrHidden === '1') {
        delete row.dataset.dsrrHidden
        row.style.display = ''
      }
    }

    // Ask the host again whenever the transcript gains or loses rows: a replay
    // appends copies that need their own buttons, and the retired set may have
    // moved on.
    function syncRowCount(controller, rowCount) {
      if (rowCount === controller.rowCount) return
      controller.rowCount = rowCount
      controller.load(true)
    }

    function applyDom(snapshot, view, controller, t) {
      if (!snapshot || !snapshot.nodes || typeof snapshot.nodes.get !== 'function') return
      const rows = document.querySelectorAll('[data-chat-flow-key]')
      syncRowCount(controller, rows.length)
      const resolved = new Map()
      const resolveKey = (key) => {
        if (resolved.has(key)) return resolved.get(key)
        const node = snapshot.nodes.get(key)
        const decision = node !== undefined && node !== null ? isRowHidden(view.hidden, seqsFor(node)) : null
        resolved.set(key, decision)
        return decision
      }
      // The turn a row belongs to, from its key shape
      // (`turn-process17`, `turn-tail17`, `assistant-step17:1`).
      const keyTurnOf = (key) => {
        const match = /(?:turn-process|turn-tail)(\d+)|assistant-step(\d+):/.exec(key)
        return match === null ? null : Number(match[1] ?? match[2])
      }
      const nodeOf = (key) => {
        const direct = snapshot.nodes.get(key)
        if (direct !== undefined && direct !== null) return direct
        if (!key.startsWith('[')) return null
        try {
          for (const part of JSON.parse(key)) {
            if (typeof part !== 'string') continue
            const node = snapshot.nodes.get(part)
            if (node !== undefined && node !== null) return node
          }
        } catch {
          /* not a composite key after all */
        }
        return null
      }
      const focus = view.rerunning === true && view.rerunFocus ? view.rerunFocus : null
      const infos = []
      let hasFresh = false
      for (const row of rows) {
        if (!(row instanceof HTMLElement)) continue
        const key = row.getAttribute('data-chat-flow-key')
        if (!key) continue
        const node = nodeOf(key)
        const info = {
          row,
          key,
          kind: node ? node.kind : null,
          seqs: node ? seqsFor(node) : [],
          keyTurn: keyTurnOf(key),
          inTarget: false,
          inTail: false,
          fresh: false,
        }
        if (focus) {
          info.inTarget = info.seqs.some((seq) => focus.targetSeqs.has(seq))
          info.inTail = info.seqs.some((seq) => focus.tailSeqs.has(seq))
          const freshBySeq = info.seqs.some((seq) => seq > focus.carrierSeq)
          const freshByTurn = info.keyTurn !== null && info.keyTurn > focus.turn
          info.fresh = !info.inTarget && !info.inTail && (freshBySeq || freshByTurn)
          if (info.fresh && info.kind !== 'user') hasFresh = true
        }
        infos.push(info)
      }
      for (const info of infos) {
        let decision = resolveKey(info.key)
        if (decision === null && info.key.startsWith('[')) {
          try {
            for (const part of JSON.parse(info.key)) {
              if (typeof part !== 'string') continue
              if (resolveKey(part) === true) {
                decision = true
                break
              }
            }
          } catch {
            /* not a composite key after all */
          }
        }
        let order = ''
        if (focus) {
          if (info.inTail) {
            // The later turns keep their position, below the stood-in answer.
            order = '2'
          }
          if (info.fresh) {
            if (info.kind === 'user') {
              // The re-sent prompt is invisible: the standing prompt keeps its
              // spot, so the row's duplicate wording never appears.
              decision = true
            } else {
              order = '1'
            }
          } else if (info.inTarget && info.kind !== 'user' && hasFresh) {
            // The old answer retires only once its replacement is on screen -
            // the streaming row occupies the same spot.
            decision = true
          }
        }
        if (decision !== null) setRowHidden(info.row, decision)
        if ((info.row.style.order || '') !== order) info.row.style.order = order
      }
    }

    // --- react entries --------------------------------------------------------

    // A snapshot this entry can read, or null when the controller cannot be
    // trusted to have one. The slot runtime abdicates an entry that throws
    // during render - permanently for the life of the page - so every read
    // below is guarded and nothing here can throw.
    function readView(controller) {
      if (controller === null || controller === undefined || typeof controller.getSnapshot !== 'function') return null
      const view = controller.getSnapshot()
      if (view === null || typeof view !== 'object') return null
      if (!view.repliesByMessage || typeof view.repliesByMessage.get !== 'function') return null
      if (!view.hidden || typeof view.hidden.has !== 'function') return null
      return view
    }

    // The rerun action, registered in the official assistant-actions strip
    // (one entry per finalized assistant message, receiving its messageId).
    // Hidden while the session is busy or a rerun is in flight: the next turn
    // is exactly what a rerun would retire.
    function RerunActionEntry(input) {
      const props = input !== null && typeof input === 'object' ? input : {}
      const messageId = props.messageId
      const controller = props.controller
      const t = typeof props.t === 'function' ? props.t : null
      const [view, setView] = react.useState(() => {
        try {
          return readView(controller)
        } catch {
          return null
        }
      })
      react.useEffect(() => {
        let unsubscribe = null
        try {
          setView(readView(controller))
          if (controller !== null && controller !== undefined && typeof controller.subscribe === 'function') {
            unsubscribe = controller.subscribe(() => setView(readView(controller)))
          }
        } catch {
          setView(null)
        }
        return () => {
          if (typeof unsubscribe === 'function') unsubscribe()
        }
      }, [controller])
      const entry = view === null || messageId === undefined || messageId === null ? undefined : view.repliesByMessage.get(messageId)
      if (entry === undefined || entry === null) return null
      if (view.hidden.has(entry.seq)) return null
      // Deliberately NOT hidden while the session is busy or a rerun is in
      // flight: other turns must look untouched during the process. The host
      // admits one rerun at a time and answers a second attempt with a clear
      // "a rerun is already in flight" / "the session is still working".
      const label = t === null ? '' : t('action.rerun')
      return jsx('button', {
        type: 'button',
        className: 'dsrr-action dsrr-reply-action',
        'aria-label': label,
        title: label,
        onClick: (event) => {
          event.preventDefault()
          event.stopPropagation()
          controller.rerun(entry)
        },
        children: jsx(RerunIcon, {}),
      })
    }

    // The overlay: hides retired rows, follows the background rerun, and
    // shows the confirm step plus any failure the host reported.
    function OverlayEntry({ useChat, useRerunTurn, controller, t }) {
      const snapshot = typeof useChat === 'function' ? useChat((state) => state) : undefined
      const view = useRerunTurn((state) => state)

      react.useEffect(() => {
        controller.load()
        return () => controller.stopPolling()
      }, [controller])

      react.useEffect(() => {
        if (snapshot === undefined) return undefined
        let scheduled = false
        const run = () => {
          scheduled = false
          // Always the CURRENT view: this callback can outlive the render that
          // created it, and a pass carrying an older view could un-hide a row
          // the newer view retired.
          const live = typeof controller.getSnapshot === 'function' ? controller.getSnapshot() : view
          applyDom(snapshot, live, controller, t)
        }
        run()
        const observer = new MutationObserver(() => {
          if (scheduled) return
          scheduled = true
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
          else window.setTimeout(run, 16)
        })
        observer.observe(document.body, { childList: true, subtree: true })
        return () => {
          observer.disconnect()
        }
      }, [snapshot, view, controller, t])

      // Follow a rerun to completion even if the user does nothing: the host
      // runs it in the background, and the polling lives in the controller.
      react.useEffect(() => {
        if (view.rerunning === true) controller.ensurePolling()
      }, [view.rerunning, controller])

      const progress = view.progress
      const notice =
        view.notice !== null && view.notice !== undefined
          ? { text: view.notice, error: view.noticeError === true }
          : view.loadError === true
            ? { text: t('notice.loadError'), error: true }
            : progress && typeof progress.error === 'string' && progress.error !== ''
              ? { text: `${t('notice.deferred')} (${progress.error})`, error: true }
              : progress && typeof progress.promptError === 'string' && progress.promptError !== ''
                ? { text: progress.promptError, error: true }
                : null

      return jsxs('div', {
        className: 'dsrr-stack',
        children: [
          view.confirming === true
            ? jsxs('div', {
                className: 'dsrr-confirm',
                role: 'alertdialog',
                'aria-label': t('confirm.title'),
                children: [
                  jsx('div', { className: 'dsrr-confirm-title', children: t('confirm.title') }),
                  jsx('div', { children: t('confirm.body') }),
                  jsxs('div', {
                    className: 'dsrr-confirm-actions',
                    children: [
                      jsx('button', {
                        type: 'button',
                        className: 'dsrr-btn',
                        onClick: () => controller.confirmNo(),
                        children: t('confirm.no'),
                      }),
                      jsx('button', {
                        type: 'button',
                        className: 'dsrr-btn dsrr-btn-primary',
                        onClick: () => controller.confirmYes(),
                        children: t('confirm.yes'),
                      }),
                    ],
                  }),
                ],
              })
            : null,
          view.failure !== null && view.failure !== undefined
            ? jsx('div', {
                className: 'dsrr-notice dsrr-notice-error',
                role: 'status',
                onClick: () => controller.publish({ failure: null }),
                children: errorText(t, view.failure),
              })
            : null,
          notice !== null
            ? jsx('div', {
                className: notice.error ? 'dsrr-notice dsrr-notice-error' : 'dsrr-notice',
                role: 'status',
                onClick: () => controller.dismissNotice(),
                children: notice.text,
              })
            : null,
        ],
      })
    }

    // --- plugin ---------------------------------------------------------------

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-rerun-turn: dictionaries')

      const controllers = new Map()
      const controllerFor = (sessionId) => {
        let controller = controllers.get(sessionId)
        if (controller === undefined) {
          controller = new RerunController(sessionId)
          controllers.set(sessionId, controller)
        }
        return controller
      }
      ctx.effect(
        () => () => {
          for (const controller of controllers.values()) controller.dispose()
          controllers.clear()
        },
        'dsh-rerun-turn: per-session controllers',
      )

      // The rerun action lives in the official assistant-actions strip, one
      // entry per assistant message. order 6 puts it right behind the sibling
      // edit pencil (order 5), ahead of the feedback entries (order 10).
      ctx.slots.inject('conversation.chat.assistant-actions', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.assistant-actions',
            id: 'rerun-turn-reply',
            order: 6,
            locale: NS,
            inject: (sessionId) => ({
              hooks: { rerunTurn: controllerFor(sessionId) },
              controller: controllerFor(sessionId),
            }),
          },
          RerunActionEntry,
        ),
      )

      ctx.slots.inject('conversation.input.overlay', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.overlay',
            id: 'rerun-turn',
            order: 8,
            locale: NS,
            inject: (sessionId) => ({ hooks: { rerunTurn: controllerFor(sessionId) }, controller: controllerFor(sessionId) }),
          },
          OverlayEntry,
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    exports.PLUGIN_VERSION = PLUGIN_VERSION
    return module.exports
  },
})
