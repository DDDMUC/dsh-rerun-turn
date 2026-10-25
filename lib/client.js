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
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const NS = 'dsh-rerun-turn'
    const ROUTE_PREFIX = '/dsh-rerun-turn'

    /** Keep in sync with package.json and lib/index.js. */
    const PLUGIN_VERSION = '0.2.5'

    // --- copy -----------------------------------------------------------------

    const zh = {
      'action.rerun': '重跑这一轮',
      'action.resend.below': '顺补：重跑下面第一个有 O 的可见轮',
      'action.resend.inplace': '自补：重新生成这一轮的回答',
      'confirm.title': '重跑这一轮？',
      'confirm.body': '这条回答连同它之后的内容会先从模型上下文移除，再用原提示词重新生成；之后的轮次会原样重放。',
      'confirm.note': '重跑只影响模型后续看到的内容，不会改写历史日志。',
      'confirm.yes': '重跑',
      'confirm.no': '取消',
      'notice.deferred': '重跑已中断：后续轮次的回放将在会话空闲时自动完成。',
      'notice.dismiss': '关闭这条提示',
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
      'config.ask': '重跑时询问',
      'config.hint.ask': '每次重跑前都会先弹出确认，说明这一轮会怎么重放。',
      'config.hint.auto': '点一下就直接重跑，不再询问。',
      'config.summary.ask': '重跑前询问',
      'config.resend': '缺失 O 的可见轮',
      'config.terms.title': '本插件约定',
      'config.terms.short': 'Q = 用户输入；O = 模型输出的所有内容块（O = C + A + T），其中 C = 思维链，A = 正文，T = 工具调用',
      'config.terms.log': '日志轮',
      'config.terms.log.def': '日志里记录的轮次',
      'config.terms.visible': '可见轮',
      'config.terms.visible.def': '对话视窗里、经插件操作之后应该看到的那些轮次',
      // The option is the WORD; what it does is the hint right below it.
      'config.resend.below': '顺补',
      'config.resend.inplace': '自补',
      'config.hint.resend.below': '重跑它下面第一个有 O 的可见轮；下面没有，就重发最新那条缺 O 的。',
      'config.hint.resend.inplace': '重跑这一可见轮自己的 O，后面的轮次不动。',
      'config.summary.auto': '直接重跑',
    }

    const en = {
      'action.rerun': 'Rerun this turn',
      'action.resend.below': 'Shunbu: rerun the first visible turn with an O below',
      'action.resend.inplace': 'Zibu: regenerate this turn\'s reply',
      'confirm.title': 'Rerun this turn?',
      'confirm.body': "The reply and everything after it leave the model context first; the turn's own prompt is sent again, and the later turns are replayed verbatim.",
      'confirm.note': 'A rerun only changes what the model reads next; the session log is never rewritten.',
      'confirm.yes': 'Rerun',
      'confirm.no': 'Cancel',
      'notice.deferred': 'Rerun interrupted: the replay of the later turns will resume automatically once the session is idle.',
      'notice.dismiss': 'Dismiss this notice',
      'notice.loadError': 'Loading the state failed; try again shortly.',
      'config.ask': 'Ask before rerunning',
      'config.hint.ask': 'Show the confirmation step before every rerun.',
      'config.hint.auto': 'Rerun right away without asking.',
      'config.summary.ask': 'Ask before rerunning',
      'config.resend': 'Visible turns missing an O',
      'config.terms.title': 'Conventions this plugin uses',
      'config.terms.short': 'Q = the user input; O = every content block the model outputs (O = C + A + T): C = reasoning, A = answer text, T = tool calls',
      'config.terms.log': 'Log turn',
      'config.terms.log.def': 'a turn recorded in the log',
      'config.terms.visible': 'Visible turn',
      'config.terms.visible.def': 'one of the turns the transcript should show after the plugins have done their work',
      'config.resend.below': 'Shunbu',
      'config.resend.inplace': 'Zibu',
      'config.hint.resend.below': 'Reruns the first visible turn below it that has an O; if none, resends the newest one missing an O.',
      'config.hint.resend.inplace': "Reruns this visible turn's own O; the turns after it are left alone.",
      'config.summary.auto': 'Rerun without asking',
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

    // A notice derived from live progress is dismissed per phase, rerun and
    // text: the same interruption stays closed, while a new one still shows.
    function progressKeyOf(progress) {
      if (progress === null || typeof progress !== 'object') return null
      const phase = typeof progress.phase === 'string' ? progress.phase : ''
      const rerunId = typeof progress.rerunId === 'string' ? progress.rerunId : ''
      const error = typeof progress.error === 'string' ? progress.error : ''
      const promptError = typeof progress.promptError === 'string' ? progress.promptError : ''
      return `${phase}|${rerunId}|${error}|${promptError}`
    }

    // --- preferences ----------------------------------------------------------

    // One client-side preference: whether a rerun opens its confirmation step
    // first. It lives in localStorage - the store the official client plugins
    // keep their view options in - so it survives reloads with no host
    // round-trip, and a subscription keeps the settings page and the rerun
    // action on one value. Nothing stored means "follow the host config".
    const PREFS_KEY = 'dsh-rerun-turn:prefs'

    /** The two answers the "which turn does the button address" setting allows. */
    const RESEND_MODES = ['below', 'inplace']

    function readStoredPrefs() {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return { ask: null, resend: null }
        const raw = window.localStorage.getItem(PREFS_KEY)
        if (raw === null) return { ask: null, resend: null }
        const parsed = JSON.parse(raw)
        return {
          ask: parsed && typeof parsed.ask === 'boolean' ? parsed.ask : null,
          resend: parsed && RESEND_MODES.includes(parsed.resend) ? parsed.resend : null,
        }
      } catch {
        // A missing or malformed entry falls back to the host config rather than
        // breaking the plugin.
        return { ask: null, resend: null }
      }
    }

    const storedPrefs = readStoredPrefs()
    let storedAsk = storedPrefs.ask
    let storedResend = storedPrefs.resend
    let hostConfirm = false
    const prefListeners = new Set()

    /**
     * @returns the effective settings: the stored choices, else the defaults.
     *
     * `resend` decides what the button on an UNANSWERED turn addresses:
     * `below` reruns the reply of the first VISIBLE turn below it that has an A
     * (and sends the newest unanswered prompt when nothing below has one),
     * `inplace` regenerates the reply of the visible turn that Q belongs to.
     * The host replays the turns in between either way. The default is `below`.
     */
    function getPrefs() {
      return {
        ask: storedAsk === null ? hostConfirm : storedAsk,
        resend: storedResend === null ? 'below' : storedResend,
      }
    }

    function writePrefs() {
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          // Only the choices that are set: an untouched preference stays absent
          // so "follow the host config" keeps meaning what it says.
          const payload = {}
          if (storedAsk !== null) payload.ask = storedAsk
          if (storedResend !== null) payload.resend = storedResend
          window.localStorage.setItem(PREFS_KEY, JSON.stringify(payload))
        }
      } catch {
        // Storage that refuses writes (private mode) must not break the toggle.
      }
      for (const listener of prefListeners) {
        try {
          listener()
        } catch {}
      }
    }

    function setResendMode(value) {
      if (!RESEND_MODES.includes(value) || storedResend === value) return
      storedResend = value
      writePrefs()
    }

    function setAskBeforeRerun(value) {
      const ask = value === true
      if (storedAsk === ask) return
      storedAsk = ask
      // Through the shared writer: writing `{ ask }` alone would drop the other
      // stored choice (the two live under one key).
      writePrefs()
    }

    function subscribePrefs(listener) {
      prefListeners.add(listener)
      return () => {
        prefListeners.delete(listener)
      }
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
      '.dsrr-action{width:28px;height:28px;padding:6px;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:28px;background:transparent;color:var(--dsw-alias-label-tertiary,#81858c);cursor:pointer;transition:background-color .12s,color .12s}',
      '.dsrr-action:hover:not(:disabled){background:var(--dsrr-field);color:var(--dsw-alias-label-primary,var(--dsrr-ink))}',
      '.dsrr-action:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,var(--dsrr-accent));outline-offset:2px}',
      '.dsrr-action:disabled{cursor:default;opacity:.4}',
      '.dsrr-action svg{width:15px;height:15px}',
      '.dsrr-action-host{display:inline-flex;align-items:center}',
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
      '.dsrr-notice{display:flex;align-items:flex-start;gap:8px;margin:4px 0;padding:6px 10px;border:1px solid var(--dsrr-line);border-radius:8px;background:var(--dsrr-panel);backdrop-filter:blur(18px) saturate(1.2);box-shadow:var(--dsrr-shadow);color:var(--dsrr-ink-dim);font-size:12px;line-height:19px}',
      '.dsrr-notice-text{flex:1;min-width:0}',
      '.dsrr-notice-close{flex:none;width:18px;height:18px;margin:0 -2px 0 0;padding:0;border:none;border-radius:50%;background:transparent;color:inherit;font:inherit;font-size:14px;line-height:18px;cursor:pointer;opacity:.7}',
      '.dsrr-notice-close:hover{opacity:1;background:var(--dsrr-hover)}',
      '.dsrr-notice-close:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,var(--dsrr-accent));outline-offset:1px}',
      '.dsrr-notice.dsrr-notice-error{color:var(--dsw-alias-state-error-primary,#c93a31)}',
      // The confirmation is the platform's own modal (the sibling delete plugin
      // draws its dialog the same way), so the only copy style here is the body
      // paragraph - the same 14/22 the platform's dialog text uses.
      '.dsrr-dialog-text{margin:0;color:var(--dsw-alias-label-primary,var(--dsrr-ink));font-size:14px;line-height:22px}',
      '.dsrr-dialog-note{margin:10px 0 0;color:var(--dsw-alias-label-tertiary,var(--dsrr-ink-dim));font-size:13px;line-height:20px}',
      '.dsrr-config{display:flex;flex-direction:column;gap:14px;width:100%;max-width:none}',
      '.dsrr-config-group{display:flex;flex-direction:column;gap:6px}',
      '.dsrr-config-row{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:13px;font-weight:500}',
      // Width follows the choice: the options are two characters each, so a
      // fixed 190px floor only stretched the control across the card.
      '.dsrr-select{flex:0 0 auto;width:auto;max-width:100%;padding:5px 8px;border:1px solid var(--dsrr-line);border-radius:8px;background:var(--dsrr-panel);color:inherit;font:inherit;font-size:12.5px;cursor:pointer;transition:border-color .15s ease}',
      '.dsrr-select:hover{border-color:var(--dsrr-accent)}',
      '.dsrr-select:focus-visible{outline:none;border-color:var(--dsrr-accent);box-shadow:0 0 0 2px var(--dsrr-hover)}',
      '.dsrr-config-hint{margin:0;max-width:72ch;color:var(--dsrr-ink-dim);font-size:12px;line-height:19px}',
      '.dsrr-config-divider{height:1px;background:var(--dsrr-line);opacity:.6}',
      '.dsrr-terms{display:flex;flex-direction:column;gap:8px;margin:0;padding:12px 14px;border-left:3px solid var(--dsrr-accent);border-radius:0 10px 10px 0;background:var(--dsrr-panel)}',
      '.dsrr-terms-title{margin:0;font-size:13.5px;font-weight:600;line-height:20px}',
      '.dsrr-terms-short{margin:0;max-width:88ch;font-size:13px;line-height:21px}',
      '.dsrr-terms-row{display:grid;grid-template-columns:62px 1fr;gap:4px 12px;align-items:baseline;font-size:13px;line-height:21px}',
      '.dsrr-terms-term{font-weight:600}',
      '.dsrr-terms-def{margin:0;color:var(--dsrr-ink-dim)}',
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
        // Set by dispose(): a listener that outlives the apply (an adopted
        // button still carries the previous instance's click handler) must not
        // open a confirm panel on a controller nobody renders any more.
        this.disposed = false
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
          failureDetail: null,
          notice: null,
          noticeError: false,
          dismissedKey: null,
          confirming: false,
          loaded: false,
          loadError: false,
          loadErrorDetail: null,
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
        this.disposed = true
        if (this.pollTimer !== null) {
          window.clearInterval(this.pollTimer)
          this.pollTimer = null
        }
      }

      load(force) {
        // A refresh asked for while one is already running has to land *after*
        // it, but only once: chaining every request would queue a burst (the
        // row-count watcher and the poller both ask), and each response
        // republishes the view. Coalesce into one queued refresh.
        if (this.inflight !== null) {
          if (force === true) this.reloadQueued = true
          return this.inflight
        }
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
            const markerTurns = new Set(Array.isArray(data.markerTurns) ? data.markerTurns.filter((turn) => typeof turn === 'number') : [])
            // Turns whose content a landed rerun fully retired: their
            // process/tail strips hold nothing and must vanish with it.
            const retiredTurns = new Set(Array.isArray(data.retiredTurns) ? data.retiredTurns.filter((turn) => typeof turn === 'number') : [])
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
            hostConfirm = Boolean(data.config && data.config.confirm)
            this.publish({
              hidden,
              replies,
              repliesByMessage,
              reruns: Array.isArray(data.reruns) ? data.reruns : [],
              busy: data.busy === true,
              rerunning,
              rerunFocus,
              markerTurns,
              retiredTurns,
              progress: data.progress || null,
              loaded: true,
              loadError: false,
              loadErrorDetail: null,
              confirm: Boolean(data.config && data.config.confirm),
            })
            // While a rerun runs in the host, keep asking; one last refresh
            // after it ends picks up the replayed turns.
            if (rerunning) this.ensurePolling()
            else this.stopPolling()
          })
          .catch((error) => {
            // The host says WHY (`invalid session id`, `no session log for this
            // id`, a 500, a network failure). Swallowing it left the panel with
            // "状态加载失败，稍后重试。" for every cause alike - including the
            // causes a user can act on.
            this.publish({ loadError: true, loadErrorDetail: error instanceof Error ? error.message : String(error) })
          })
          .finally(() => {
            this.inflight = null
            if (this.reloadQueued === true) {
              this.reloadQueued = false
              this.load(true)
            }
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
        if (this.disposed === true) return
        if (this.view.pending) return
        // The settings-page checkbox (stored) wins over the host config; with
        // asking off the click goes straight to the host, and a failure still
        // surfaces through the notice path.
        if (getPrefs().ask === true) {
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
        // A transient notice (view.notice) is not derived from progress;
        // closing it must not also dismiss the progress notice underneath.
        const transient = this.view.notice !== null && this.view.notice !== undefined
        const key = transient ? this.view.dismissedKey : progressKeyOf(this.view.progress)
        this.publish({ notice: null, noticeError: false, dismissedKey: key })
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
              this.publish({ pending: false, failure: null, failureDetail: null })
              this.load(true)
              return
            }
            this.publish({ pending: false, failure: code, failureDetail: typeof data.error === 'string' && data.error !== '' ? data.error : null })
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

    // Hide attribution (interop contract I4 / §4): every component declares its
    // own hides with a namespaced attribute, so a hide is only ever retracted by
    // the plugin that set it. Copy kept per package - the components share no
    // code (I1).
    const HIDE_OWNERS = [
      ['dshdt', 'data-dshdt-hidden', 'dshdtHidden'],
      ['dshet', 'data-dshet-hidden', 'dshetHidden'],
      ['dsrr', 'data-dsrr-hidden', 'dsrrHidden'],
    ]

    /** Does a plugin other than `own` declare this row hidden? */
    function foreignHideOn(row, own) {
      for (const [key, attr, prop] of HIDE_OWNERS) {
        if (key === own) continue
        if (row.dataset && row.dataset[prop] === '1') return true
        if (typeof row.hasAttribute === 'function' && row.hasAttribute(attr)) return true
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
      // Only the plugin holding its own marker may touch `display`. A sibling's
      // hide (delete-turn / edit-turn) outlives my reopen: keep the row hidden
      // AND keep my marker, so the `[data-dsrr-hidden="1"]` rule stays in force
      // and a later pass - once the sibling's hide is gone - can still retract
      // it. Never clear a `display:none` whose owner is not visible to me.
      if (row.dataset.dsrrHidden !== '1') return
      if (foreignHideOn(row, 'dsrr') === true) return
      delete row.dataset.dsrrHidden
      row.style.display = ''
    }

    // The injected rerun buttons on USER rows, keyed by their row. The user
    // row has no official action slot, so the button joins its platform action
    // bar directly (see the pass at the end of applyDom).
    const promptActions = new WeakMap()

    // The buttons this module instance already wired. A button is adopted from a
    // host another instance injected, so wiring on every pass would stack a
    // second listener - and a click would fire two rerun requests.
    const wiredButtons = new WeakSet()

    // Namespaced handles (interop contract I3). Every node this plugin injects
    // carries one, and that is exactly what makes the two re-apply rules
    // possible: the WeakMap above dies with the module instance, the attributes
    // do not. So a fresh instance finds the previous instance's nodes in the DOM
    // (and adopts the host instead of building a second one), and a dispose can
    // sweep precisely its own nodes - never the host's, never a sibling's.
    const HOST_SELECTOR = '[data-dsrr-action-host="1"]'
    const PROMPT_BUTTON_SELECTOR = '[data-dsrr-action="rerun"]'
    const OWNED_SELECTOR = HOST_SELECTOR + ', ' + PROMPT_BUTTON_SELECTOR + ', [data-dsrr-overlay="1"]'
    // The stylesheet the factory appends. It has its own presence guard, but it
    // is a node this plugin injected all the same: the dispose drops it by the
    // same id the client-modules loader uses for its own teardown sweep, and the
    // next apply re-creates it.
    const CSS_SELECTOR = 'style[data-plugin="' + NS + '"]'

    /** Remove every node of this plugin's namespace that `scope` can reach. */
    function sweepOwnedNodes(scope, selector) {
      const root = scope === undefined || scope === null ? (typeof document === 'undefined' ? null : document) : scope
      if (root === null || typeof root.querySelectorAll !== 'function') return 0
      let removed = 0
      for (const node of root.querySelectorAll(selector === undefined ? OWNED_SELECTOR : selector)) {
        if (node === null || node === undefined || typeof node.remove !== 'function') continue
        node.remove()
        removed += 1
      }
      return removed
    }

    // Ask the host again whenever the transcript gains or loses rows: a replay
    // appends copies that need their own buttons, and the retired set may have
    // moved on.
    function syncRowCount(controller, rowCount) {
      if (rowCount === controller.rowCount) return
      const grew = rowCount > controller.rowCount
      controller.rowCount = rowCount
      // Only new rows can add edit targets / a fresh turn; shrink churn (the
      // host rebuilding its list) does not need a refresh.
      if (grew) controller.load(true)
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
      // The turn a row belongs to. The platform publishes it on the flow item
      // itself (`data-chat-turn`, the same anchor the prompt-row buttons read),
      // and a key sometimes spells it out as well
      // (`turn-process17`, `turn-tail17`, `assistant-step17:1`). Reading the
      // key alone is what left a bookkeeping turn's empty "completed" strip on
      // screen once DSH started keying those rows by node kind
      // (`turn-tail`, `["turn-tail","response"]`) with the turn only in the
      // data attribute.
      const keyTurnOf = (key, row) => {
        const match = /(?:turn-process|turn-tail)(\d+)|assistant-step(\d+):/.exec(key)
        if (match !== null) return Number(match[1] ?? match[2])
        const fromRow = row && row.dataset ? Number(row.dataset.chatTurn) : Number.NaN
        return Number.isInteger(fromRow) ? fromRow : null
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
          keyTurn: keyTurnOf(key, row),
          inTarget: false,
          inTail: false,
          fresh: false,
        }
        info.marker = info.keyTurn !== null && view.markerTurns instanceof Set && view.markerTurns.has(info.keyTurn)
        info.retired = info.keyTurn !== null && view.retiredTurns instanceof Set && view.retiredTurns.has(info.keyTurn)
        if (focus) {
          info.inTarget = info.seqs.some((seq) => focus.targetSeqs.has(seq))
          info.inTail = info.seqs.some((seq) => focus.tailSeqs.has(seq))
          const freshBySeq = info.seqs.some((seq) => seq > focus.carrierSeq)
          const freshByTurn = info.keyTurn !== null && info.keyTurn > focus.turn
          info.fresh = !info.inTarget && !info.inTail && (freshBySeq || freshByTurn)
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
        if (info.marker || info.retired) {
          // A rerun's bookkeeping turn holds no conversation, and a turn whose
          // content is fully retired holds nothing a viewer could open: their
          // process/tail strips must never show, not even during the in-place
          // regrouping.
          decision = true
        } else if (focus) {
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
          } else if (info.inTarget && info.kind !== 'user') {
            // The old answer retires the moment the rerun starts, so the fresh
            // "thinking" row streams where the answer was instead of below it.
            // Waiting for an assistant-step row left the old answer on screen
            // for the whole generation.
            decision = true
          }
        }
        if (decision !== null) setRowHidden(info.row, decision)
        if ((info.row.style.order || '') !== order) info.row.style.order = order
      }
      // The platform exposes no action slot for user rows, so the prompt side of
      // an exchange gets its rerun button injected into the row's own action bar
      // (the one copy/delete/edit live in). It drives the SAME controller path
      // as the reply button; the turn's last live reply is the target, found by
      // the row's own turn number.
      const lastReplyForTurn = (turn) => {
        if (!Number.isInteger(turn)) return null
        let found = null
        for (const reply of view.replies.values()) {
          if (reply !== null && typeof reply === 'object' && reply.turn === turn) found = reply
        }
        return found
      }
      // Every user row whose turn has no live reply gets the prompt-side button:
      // a stopped turn, a failed one, one whose reply was deleted, or the prompt
      // nothing has answered yet. What the button ADDRESSES is the setting
      // (`getPrefs().resend`):
      //   below   - the reply of the first VISIBLE turn below it that has an A
      //             (a hidden reply is not visible, so it is skipped); when
      //             nothing below has one, the newest unanswered prompt.
      //   inplace - the reply of the visible turn this Q belongs to.
      // The turns in between are replayed by the host either way.
      const liveReplyOf = (turn) => {
        if (!Number.isInteger(turn)) return null
        const reply = lastReplyForTurn(turn)
        if (reply === null || view.hidden.has(reply.seq)) return null
        return reply
      }
      let newestUnansweredSeq = null
      for (const info of infos) {
        if (info.kind !== 'user') continue
        if (liveReplyOf(Number(info.row.dataset.chatTurn)) !== null) continue
        const seq = Array.isArray(info.seqs) ? info.seqs[0] : undefined
        if (typeof seq === 'number') newestUnansweredSeq = seq
      }
      const resendMode = getPrefs().resend
      for (let index = 0; index < infos.length; index += 1) {
        const info = infos[index]
        if (info.kind !== 'user') continue
        const row = info.row
        let entry = promptActions.get(row)
        const reply = lastReplyForTurn(Number(row.dataset.chatTurn))
        // A reply that exists but is hidden (delete-turn owns the row, or an
        // earlier rerun retired it) leaves nothing to rerun.
        if (reply !== null && view.hidden.has(reply.seq)) {
          if (entry !== undefined) {
            entry.host.remove()
            promptActions.delete(row)
          }
          continue
        }
        // No live reply at all: a turn the user stopped, one that failed, or the
        // prompt just sent that nothing has answered yet. The host accepts a
        // PROMPT target for exactly that shape - planRerun: "a prompt target is
        // an address, never a licence ... accepted only for a turn that has no
        // rerunnable reply of its own" - and sends it again as a fresh request.
        // So the button stays and addresses the prompt instead of a reply.
        const promptSeq = Array.isArray(info.seqs) ? info.seqs[0] : undefined
        let unansweredTarget = null
        if (resendMode === 'inplace') {
          // The visible turn this Q belongs to: its own prompt is the anchor.
          if (typeof promptSeq === 'number') unansweredTarget = { seq: promptSeq }
        } else {
          // The first visible turn BELOW this Q that has an A.
          for (let next = index + 1; next < infos.length && unansweredTarget === null; next += 1) {
            if (infos[next].kind !== 'assistant-step') continue
            const below = liveReplyOf(infos[next].keyTurn)
            if (below !== null) unansweredTarget = below
          }
          // Nothing below has an A: send the newest unanswered prompt instead.
          if (unansweredTarget === null && typeof newestUnansweredSeq === 'number') {
            unansweredTarget = { seq: newestUnansweredSeq }
          }
        }
        const target = reply !== null ? reply : unansweredTarget
        if (target === null) {
          if (entry !== undefined) {
            entry.host.remove()
            promptActions.delete(row)
          }
          continue
        }
        // I3: find my own node BEFORE building one. This WeakMap only knows what
        // THIS instance injected; a re-apply (HMR, plugin toggle, bundle reload)
        // starts an instance whose map is empty while the node the previous
        // instance injected is still in the row. Deleting that node and building
        // a replacement loses a race with the instance on its way out: a removal
        // is a childList mutation, its observer wakes, its entry still points at
        // the removed node and re-inserts it - one more ghost per reload (the
        // probe counted 5 hosts where one belongs). So the node already there is
        // ADOPTED: both instances end up holding the same element, and neither
        // can stack a second one.
        const existing = typeof row.querySelectorAll === 'function' ? [...row.querySelectorAll(HOST_SELECTOR)] : []
        // Anything past the first is a leftover of a build that already stacked
        // them. It is this plugin's own node, so dropping it is allowed; a node
        // of the host's or of a sibling plugin is never touched.
        for (let index = 1; index < existing.length; index += 1) existing[index].remove()
        const host = existing.length > 0 ? existing[0] : document.createElement('span')
        if (existing.length === 0) {
          host.className = 'dsrr-action-host'
          host.dataset.dsrrActionHost = '1'
        }
        const adopted = typeof host.querySelector === 'function' ? host.querySelector(PROMPT_BUTTON_SELECTOR) : null
        const button = adopted !== null && adopted !== undefined ? adopted : document.createElement('button')
        if (adopted === null || adopted === undefined) {
          button.type = 'button'
          button.className = 'dsrr-action dsrr-prompt-action'
          button.dataset.dsrrAction = 'rerun'
          button.innerHTML = ICON_MARKUP
          host.appendChild(button)
        }
        if (entry === undefined || entry.host !== host || entry.button !== button) {
          entry = { host, button, reply: target, controller }
          promptActions.set(row, entry)
        }
        entry.reply = target
        entry.controller = controller
        if (!wiredButtons.has(button)) {
          // Wired ONCE per button per instance: the pass runs on every snapshot.
          // The click reads the CURRENT target and the CURRENT controller off the
          // WeakMap - this closure outlives the pass that wired it, and an
          // adopted button keeps the listener of the instance that built it.
          wiredButtons.add(button)
          button.addEventListener('click', (event) => {
            event.preventDefault()
            event.stopPropagation()
            const current = promptActions.get(row)
            if (current === undefined || current === null || current.reply === null) return
            current.controller.rerun(current.reply)
          })
        }
        // The prompt-side button of an unanswered turn says what it will do:
        // send the newest unanswered prompt again, or regenerate this very turn.
        const label =
          t === null
            ? ''
            : t(reply === null ? (resendMode === 'inplace' ? 'action.resend.inplace' : 'action.resend.below') : 'action.rerun')
        if (entry.button.getAttribute('aria-label') !== label) {
          entry.button.setAttribute('aria-label', label)
          entry.button.setAttribute('title', label)
        }
        // Insert after the last existing button and before whatever follows it:
        // nothing of the host's or a sibling's is moved or removed, and the
        // pass never assumes this host is the last child.
        const bar = row.querySelector('[class*="_actions"]')
        if (bar === null) {
          entry.host.remove()
          continue
        }
        const buttons = [...bar.querySelectorAll('button')].filter((candidate) => candidate !== entry.button)
        const last = buttons.length > 0 ? buttons[buttons.length - 1] : null
        let next = last === null ? null : last.nextSibling
        if (next === entry.host) next = next.nextSibling
        if (entry.host.parentElement !== bar || entry.host.nextSibling !== next) {
          bar.insertBefore(entry.host, next)
        }
      }
      syncTurnRail(view)
    }

    // --- turn rail ------------------------------------------------------------

    /** The turn a rail mark addresses: its label carries the real turn number. */
    function turnOfRailMark(mark) {
      const label = mark.getAttribute('aria-label') || mark.getAttribute('title') || ''
      const match = /(\d+)/.exec(label)
      return match === null ? null : Number(match[1])
    }

    /**
     * Every turn that has a row in the DOM, mapped to whether any of its rows is
     * visible. A turn with no row at all is absent here: it is not empty, just
     * not loaded, and the rail may still jump to it.
     */
    function turnRowVisibility() {
      const seen = new Map()
      let rows
      try {
        rows = document.querySelectorAll('[data-chat-flow-key][data-chat-turn]')
      } catch {
        return seen
      }
      for (const row of rows) {
        const turn = Number(row.getAttribute('data-chat-turn'))
        if (!Number.isInteger(turn)) continue
        const style = row.style
        const hidden =
          row.dataset.dsrrHidden === '1' ||
          row.dataset.dshetHidden === '1' ||
          row.dataset.dshdtHidden === '1' ||
          (style !== undefined && style !== null && style.display === 'none') ||
          (typeof row.getBoundingClientRect === 'function' && row.getBoundingClientRect().height === 0)
        if (seen.get(turn) !== true) seen.set(turn, hidden !== true)
      }
      return seen
    }

    /**
     * The official rail keeps one mark per turn of the session - including the
     * turns this plugin retired, whose rows are hidden. So a rerun left marks
     * for turns the conversation no longer shows, and their slots left a gap.
     * Drop the marks of turns with no visible row, re-space the rest inside the
     * host's own ladder and centre them; the container keeps the host's height,
     * because that height is what the host's virtualisation measures: shrinking
     * it unmounts the marks past the new window (a ten-turn transcript showed
     * six marks).
     */
    function syncTurnRail(view) {
      const rows = turnRowVisibility()
      const hiddenTurns = []
      for (const [turn, visible] of rows) if (visible !== true) hiddenTurns.push(turn)
      let navs
      try {
        navs = document.querySelectorAll('nav')
      } catch {
        return
      }
      for (const nav of navs) {
        let marks
        try {
          marks = [...nav.querySelectorAll('button[data-index]')]
        } catch {
          continue
        }
        if (marks.length === 0) continue
        const container = marks[0].parentElement
        if (container === null || container === undefined) continue
        const observed = Math.round((Number.parseFloat(container.style.height) - 2) / 10)
        const total = Math.max(Number.isFinite(observed) && observed > 0 ? observed : 0, marks.length)
        const inRail = hiddenTurns.filter((turn) => turn <= total)
        const kept = total - inRail.length
        const offset = kept > 0 && kept < total ? Math.floor((total - kept) / 2) : 0
        for (const mark of marks) {
          const turn = turnOfRailMark(mark)
          if (turn === null) continue
          if (hiddenTurns.includes(turn)) {
            mark.style.display = 'none'
            continue
          }
          mark.style.display = ''
          const before = hiddenTurns.filter((hidden) => hidden < turn).length
          mark.style.transform = `translate3d(0px, ${(turn - 1 - before + offset) * 10 + 1}px, 0px)`
        }
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
        // Namespaced like every other node this plugin injects, so a dispose can
        // find it again without a WeakMap (interop contract I3).
        'data-dsrr-action': 'rerun',
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
    // The plugin's own page in the manager: the row this bundle inserts
    // (`cordis.patch.yml`, id `dsh-rerun-turn`) gains a configure arrow that
    // opens this card. Same shape as the sibling plugins' cards.
    function AskBeforeRerunOption({ view, t }) {
      const tr = typeof t === 'function' ? t : (key) => key
      const [ask, setAsk] = react.useState(getPrefs().ask)
      const [resend, setResend] = react.useState(getPrefs().resend)
      react.useEffect(
        () =>
          subscribePrefs(() => {
            setAsk(getPrefs().ask)
            setResend(getPrefs().resend)
          }),
        [],
      )
      if (view === 'summary') return tr(ask ? 'config.summary.ask' : 'config.summary.auto')
      return jsxs('div', {
        className: 'dsrr-config',
        children: [
          // The convention frames both settings, so it leads.
          jsxs('div', {
            className: 'dsrr-terms',
            children: [
              jsx('p', { className: 'dsrr-terms-title', children: tr('config.terms.title') }),
              jsx('p', { className: 'dsrr-terms-short', children: tr('config.terms.short') }),
              jsxs('div', {
                className: 'dsrr-terms-row',
                children: [
                  jsx('span', { className: 'dsrr-terms-term', children: tr('config.terms.log') }),
                  jsx('p', { className: 'dsrr-terms-def', children: tr('config.terms.log.def') }),
                ],
              }),
              jsxs('div', {
                className: 'dsrr-terms-row',
                children: [
                  jsx('span', { className: 'dsrr-terms-term', children: tr('config.terms.visible') }),
                  jsx('p', { className: 'dsrr-terms-def', children: tr('config.terms.visible.def') }),
                ],
              }),
            ],
          }),
          // One setting per group: the control on the row, what it means right
          // under it, and a hairline between the groups.
          jsxs('div', {
            className: 'dsrr-config-group',
            children: [
              jsx(primitives.Checkbox, {
                checked: ask,
                label: tr('config.ask'),
                onChange: (checked) => setAskBeforeRerun(checked),
              }),
              jsx('p', { className: 'dsrr-config-hint', children: tr(ask ? 'config.hint.ask' : 'config.hint.auto') }),
            ],
          }),
          jsx('div', { className: 'dsrr-config-divider' }),
          // What the button on an UNANSWERED turn addresses: the first visible
          // turn with an A below it, or the visible turn that Q belongs to.
          jsxs('div', {
            className: 'dsrr-config-group',
            children: [
              jsxs('label', {
                className: 'dsrr-config-row',
                children: [
                  jsx('span', { children: tr('config.resend') }),
                  jsx('select', {
                    className: 'dsrr-select',
                    value: resend,
                    onChange: (event) => setResendMode(event.target.value),
                    children: [
                      jsx('option', { value: 'below', children: tr('config.resend.below') }),
                      jsx('option', { value: 'inplace', children: tr('config.resend.inplace') }),
                    ],
                  }),
                ],
              }),
              jsx('p', { className: 'dsrr-config-hint', children: tr(resend === 'inplace' ? 'config.hint.resend.inplace' : 'config.hint.resend.below') }),
            ],
          }),
        ],
      })
    }

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
          // Mutation callbacks are microtasks: running here restyles the rows
          // BEFORE the browser paints, so a row added by the host is hidden or
          // moved in the same frame it appears. Deferring to a frame callback
          // made the fresh answer flash at the bottom before jumping into
          // place.
          run()
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
      const progressKey = progressKeyOf(progress)
      const progressDismissed = progressKey !== null && view.dismissedKey === progressKey
      // `error` is only meaningful while the rerun is interrupted or failed.
      // Older hosts merged progress records, so a finished rerun could still
      // carry the interruption text; trusting the phase keeps that stale text
      // off the screen even before the host is upgraded.
      const progressError =
        progressDismissed !== true && progress !== null && typeof progress === 'object' &&
        (progress.phase === 'interrupted' || progress.phase === 'failed') &&
        typeof progress.error === 'string' && progress.error !== ''
          ? progress.error
          : ''
      const progressPromptError =
        progressDismissed !== true && progress !== null && typeof progress === 'object' && typeof progress.promptError === 'string' && progress.promptError !== ''
          ? progress.promptError
          : ''
      const notice =
        view.notice !== null && view.notice !== undefined
          ? { text: view.notice, error: view.noticeError === true }
          : view.loadError === true
            ? {
                text:
                  typeof view.loadErrorDetail === 'string' && view.loadErrorDetail !== ''
                    ? `${t('notice.loadError')} (${view.loadErrorDetail})`
                    : t('notice.loadError'),
                error: true,
              }
            : progressError !== ''
              ? { text: `${t('notice.deferred')} (${progressError})`, error: true }
              : progressPromptError !== ''
                ? { text: progressPromptError, error: true }
                : null

      return jsxs('div', {
        className: 'dsrr-stack',
        'data-dsrr-overlay': '1',
        children: [
          jsx(primitives.Modal, {
            open: view.confirming === true,
            title: t('confirm.title'),
            closeLabel: t('confirm.no'),
            onClose: () => controller.confirmNo(),
            footer: jsxs(Fragment, {
              children: [
                jsx(primitives.Button, {
                  variant: 'ghost',
                  size: 'md',
                  onClick: () => controller.confirmNo(),
                  children: t('confirm.no'),
                }),
                jsx(primitives.Button, {
                  variant: 'primary',
                  size: 'md',
                  onClick: () => controller.confirmYes(),
                  children: t('confirm.yes'),
                }),
              ],
            }),
            children: jsxs(Fragment, {
              children: [
                jsx('p', { className: 'dsrr-dialog-text', children: t('confirm.body') }),
                jsx('p', { className: 'dsrr-dialog-note', children: t('confirm.note') }),
              ],
            }),
          }),
          view.failure !== null && view.failure !== undefined
            ? jsx('div', {
                className: 'dsrr-notice dsrr-notice-error',
                role: 'status',
                onClick: () => controller.publish({ failure: null, failureDetail: null }),
                children: (view.failure === 'internal' || view.failure === 'generic') && typeof view.failureDetail === 'string' && view.failureDetail !== ''
                  ? `${errorText(t, view.failure)}（${view.failureDetail.slice(0, 300)}）`
                  : errorText(t, view.failure),
              })
            : null,
          notice !== null
            ? jsxs('div', {
                className: notice.error ? 'dsrr-notice dsrr-notice-error' : 'dsrr-notice',
                role: 'status',
                onClick: () => controller.dismissNotice(),
                children: [
                  jsx('span', { className: 'dsrr-notice-text', children: notice.text }),
                  jsx('button', {
                    type: 'button',
                    className: 'dsrr-notice-close',
                    'aria-label': t('notice.dismiss'),
                    title: t('notice.dismiss'),
                    onClick: (event) => {
                      event.stopPropagation()
                      controller.dismissNotice()
                    },
                    children: '×',
                  }),
                ],
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
          // I3: a dispose takes this plugin's own nodes with it. They are found
          // by namespace attribute, never through the WeakMap - that died with
          // the module instance, and a re-apply (HMR / plugin toggle) otherwise
          // leaves the previous instance's host in the row forever.
          sweepOwnedNodes(undefined, HOST_SELECTOR)
          sweepOwnedNodes(undefined, CSS_SELECTOR)
          // The buttons and the overlay root are rendered by the app's own React
          // root, which removes them itself when the slot entry unmounts. Pulling
          // one of those out from under React makes React's own removal throw
          // (NotFoundError), so they are re-checked on the next task instead: by
          // then React has committed its unmount, and anything still standing is
          // a genuine leftover. Only this plugin's namespace is ever touched.
          const deferredSweep = () => sweepOwnedNodes()
          if (typeof setTimeout === 'function') setTimeout(deferredSweep, 0)
          else deferredSweep()
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

      // The shared slot table fixes this order: delete-turn 8, edit-turn 9,
      // rerun-turn 10 (dsh-as-aistudio's own overlay is 12). Sharing an order
      // with a sibling leaves their relative order undefined.
      ctx.slots.inject('conversation.input.overlay', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.overlay',
            id: 'rerun-turn',
            order: 10,
            locale: NS,
            inject: (sessionId) => ({ hooks: { rerunTurn: controllerFor(sessionId) }, controller: controllerFor(sessionId) }),
          },
          OverlayEntry,
        ),
      )

      // The plugin's own page in the manager. The key is the manager's
      // `<bundle package>#<row id>` contract (the row this bundle inserts in
      // cordis.patch.yml), exactly as the sibling plugins declare it.
      ctx.slots.inject('plugins.row.config', () =>
        ctx.slots.register(
          {
            name: 'plugins.row.config',
            key: 'dsh-rerun-turn#dsh-rerun-turn',
            locale: NS,
          },
          AskBeforeRerunOption,
        ),
      )
    }

    exports.apply = apply
    // The settings card, exported so a composing bundle (dsh-as-aistudio) can
    // render THE SAME component on its own page instead of re-implementing it:
    // one source of truth for 重跑 settings.
    exports.ConfigCard = AskBeforeRerunOption
    exports.inject = ['slots', 'locale']
    exports.PLUGIN_VERSION = PLUGIN_VERSION
    return module.exports
  },
})
