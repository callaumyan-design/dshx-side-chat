// dshx-side-chat — browser half.
//
// A "侧边对话" page type in the right sidebar (one per session). It streams
// answers from POST /dshx-side-chat/ask, which reads the main conversation's
// history but never writes to it. Ways in:
//   * the sidebar's "+" guide card "侧边对话";
//   * Ctrl+;  (same key as Claude desktop);
//   * /btw [question] in the composer (host command; the question is handed
//     over through /dshx-side-chat/pending and asked here, not in the main chat).
// The side transcript is kept per session in localStorage and can be cleared.
window.__ModuleLoader__.load({
  id: 'dshx-side-chat',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const primitives = (() => { try { return require('@deepseek-ai/dsh-client-ui-primitives') } catch { return {} } })()
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo } = React

    const NS = 'dshx-side-chat'
    const TYPE_ID = 'dshx-side-chat/tab'
    const KIND = 'dshx-side-chat'
    const BASE = '/dshx-side-chat'
    const STORE_PREFIX = 'dshx-side-chat.v1.'
    const PENDING_EVENT = 'dshx-side-chat:pending'
    const MAX_STORED_TURNS = 50
    const DRAFT_EVENT = 'dshx-side-chat:draft'
    /** sessionId -> text to put in the side-chat input ('' = just focus it). */
    const pendingDrafts = new Map()

    /** Turn selected text into a Markdown quote block followed by a blank line. */
    function quoteOf(text) {
      const clean = String(text || '').replace(/\r\n?/g, '\n').trim()
      if (!clean) return ''
      return clean.split('\n').map((line) => '> ' + line).join('\n') + '\n\n'
    }

    // ------------------------------------------------------------- styles
    const CSS = `
.dshx-sc{display:flex;flex-direction:column;height:100%;min-height:0;font:var(--dsw-font-sm-14, 14px/1.55 system-ui);color:var(--dsw-alias-label-primary)}
.dshx-sc-bar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3);flex:none}
.dshx-sc-bar .grow{flex:1;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshx-sc select{max-width:190px;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);background:transparent;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm, 6px);padding:2px 4px}
.dshx-sc-btn{font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);background:transparent;border:none;border-radius:var(--dsw-radius-sm, 6px);padding:3px 8px;cursor:pointer}
.dshx-sc-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshx-sc-btn:disabled{opacity:.45;cursor:default;background:transparent}
.dshx-sc-list{flex:1;min-height:0;overflow:auto;padding:12px 14px 4px}
.dshx-sc-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.7;padding:24px 6px}
.dshx-sc-empty b{color:var(--dsw-alias-label-secondary);font-weight:600}
.dshx-sc-q{margin:10px 0 6px auto;max-width:88%;width:fit-content;white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg, 12px);padding:7px 11px}
.dshx-sc-a{margin:4px 0 14px;word-break:break-word}
.dshx-sc-a pre.plain{white-space:pre-wrap;font:inherit;margin:0}
.dshx-sc-meta{display:flex;gap:10px;align-items:center;font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-top:4px}
.dshx-sc-err{color:var(--dsw-alias-state-error-primary);font-size:13px;white-space:pre-wrap}
.dshx-sc-thinking{color:var(--dsw-alias-label-tertiary);font-size:13px;animation:dshxScPulse 1.4s ease-in-out infinite}
@keyframes dshxScPulse{50%{opacity:.4}}
.dshx-sc-input{flex:none;margin:6px 10px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xl, 16px);background:var(--dsw-alias-bg-layer-1);padding:8px 10px 6px}
.dshx-sc-input textarea{width:100%;box-sizing:border-box;resize:none;border:none;outline:none;background:transparent;color:inherit;font:inherit;min-height:22px;max-height:180px}
.dshx-sc-input .row{display:flex;align-items:center;gap:6px;margin-top:4px}
.dshx-sc-input .hint{flex:1;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.dshx-sc-send{font:inherit;font-size:12.5px;border:none;border-radius:999px;padding:4px 12px;cursor:pointer;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1)}
.dshx-sc-send:disabled{opacity:.35;cursor:default}
.dshx-sc-title{display:inline-flex;align-items:center;gap:6px}
.dshx-sc-guide-icon{width:100%;height:100%;display:block}
.dshx-sc-menu{display:flex;flex-direction:column;min-width:200px;padding:4px;background:var(--dsw-alias-button-floating-fill, var(--dsw-alias-bg-layer-1));--dsw-elevation-stroke-color:var(--dsw-alias-border-l3);box-shadow:var(--dsw-elevation-panel, 0 6px 24px rgba(0,0,0,.18));border-radius:var(--dsw-radius-lg, 12px);font:var(--dsw-font-xs-13, 13px/1.4 system-ui);color:var(--dsw-alias-label-primary)}
.dshx-sc-menu-item{all:unset;box-sizing:border-box;display:block;padding:6px 10px;border-radius:var(--dsw-radius-sm, 8px);cursor:pointer;white-space:nowrap}
.dshx-sc-menu-item:hover,.dshx-sc-menu-item:focus-visible{background:var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-button-floating-hover))}
.dshx-sc-menu-sep{height:.5px;margin:4px 6px;background:var(--dsw-alias-border-l3)}
`
    function ensureStyle() {
      if (typeof document === 'undefined' || document.querySelector('style[data-plugin-css="' + NS + '"]')) return
      const tag = document.createElement('style')
      tag.dataset.plugin = NS
      tag.dataset.pluginCss = NS
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // -------------------------------------------------------------- icons
    function ChatGlyph(props) {
      return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', width: 16, height: 16, 'aria-hidden': true, ...props },
        h('path', { d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3h7A2.5 2.5 0 0 1 16 5.5v4A2.5 2.5 0 0 1 13.5 12H9l-3 2.5V12h0A2.5 2.5 0 0 1 4 9.5z' }),
        h('path', { d: 'M18.5 8.5A1.5 1.5 0 0 1 20 10v5.5a2 2 0 0 1-2 2v2.5l-3-2.5h-4a2 2 0 0 1-2-2' }))
    }
    function GuideIcon() {
      return h('svg', { viewBox: '0 0 48 48', className: 'dshx-sc-guide-icon', 'aria-hidden': true },
        h('rect', { x: 4, y: 4, width: 40, height: 40, rx: 12, fill: 'var(--dsw-alias-bg-layer-1)', stroke: 'var(--dsw-alias-border-l3)' }),
        h('g', { transform: 'translate(12 12)', stroke: 'var(--dsw-alias-label-secondary)', fill: 'none', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('path', { d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3h7A2.5 2.5 0 0 1 16 5.5v4A2.5 2.5 0 0 1 13.5 12H9l-3 2.5V12h0A2.5 2.5 0 0 1 4 9.5z' }),
          h('path', { d: 'M18.5 8.5A1.5 1.5 0 0 1 20 10v5.5a2 2 0 0 1-2 2v2.5l-3-2.5h-4a2 2 0 0 1-2-2' })))
    }

    // -------------------------------------------------------------- store
    const loadTurns = (sessionId) => {
      try {
        const parsed = JSON.parse(localStorage.getItem(STORE_PREFIX + sessionId) || '[]')
        return Array.isArray(parsed) ? parsed.filter((t) => t && typeof t.question === 'string').map((t) => ({ ...t, status: t.status === 'streaming' ? 'stopped' : t.status })) : []
      } catch { return [] }
    }
    const saveTurns = (sessionId, turns) => {
      try {
        const kept = turns.slice(-MAX_STORED_TURNS)
        if (kept.length === 0) localStorage.removeItem(STORE_PREFIX + sessionId)
        else localStorage.setItem(STORE_PREFIX + sessionId, JSON.stringify(kept))
      } catch { /* quota: keep in memory */ }
    }

    async function fetchJson(path, init) {
      const response = await fetch(BASE + path, { credentials: 'same-origin', ...init })
      const text = await response.text()
      let body = {}
      try { body = text ? JSON.parse(text) : {} } catch { body = { error: text.slice(0, 300) } }
      if (!response.ok) throw new Error(body.error || 'HTTP ' + response.status)
      return body
    }

    let modelsPromise = null
    const loadModels = () => (modelsPromise ??= fetchJson('/models').then((b) => b.groups || []).catch((e) => { modelsPromise = null; throw e }))

    const markdownLabels = { code: { copyLabel: '复制', copiedLabel: '已复制', toolbarLabels: { codeLabel: '代码', wrapLabel: '换行', unwrapLabel: '不换行' } }, footnotes: '脚注' }

    function Answer({ turn }) {
      const text = turn.answer || ''
      const body = text
        ? (typeof primitives.MarkdownText === 'function'
          ? h(primitives.MarkdownText, { text, streaming: turn.status === 'streaming', labels: markdownLabels })
          : h('pre', { className: 'plain' }, text))
        : turn.status === 'streaming' ? h('div', { className: 'dshx-sc-thinking' }, turn.thinking ? '思考中…' : '正在读取主对话上下文…') : null
      const [copied, setCopied] = useState(false)
      return h('div', { className: 'dshx-sc-a' },
        body,
        turn.error ? h('div', { className: 'dshx-sc-err' }, '⚠ ' + turn.error) : null,
        turn.status !== 'streaming' && (text || turn.model) ? h('div', { className: 'dshx-sc-meta' },
          turn.model ? h('span', null, turn.model) : null,
          turn.ms ? h('span', null, (turn.ms / 1000).toFixed(1) + 's') : null,
          turn.status === 'stopped' ? h('span', null, '已停止') : null,
          text ? h('button', { type: 'button', className: 'dshx-sc-btn', onClick: () => { navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200) }) } }, copied ? '已复制' : '复制') : null,
        ) : null)
    }

    function SideChatBody(props) {
      const { sessionId } = props
      const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : undefined
      const visible = info?.tab?.visible !== false
      const [turns, setTurns] = useState(() => loadTurns(sessionId))
      const [draft, setDraft] = useState('')
      const [groups, setGroups] = useState([])
      const [modelKey, setModelKey] = useState(() => { try { return localStorage.getItem(STORE_PREFIX + 'model') || '' } catch { return '' } })
      const abortRef = useRef(null)
      const listRef = useRef(null)
      const inputRef = useRef(null)
      const turnsRef = useRef(turns)
      turnsRef.current = turns
      const busy = turns.some((t) => t.status === 'streaming')

      useEffect(() => { ensureStyle() }, [])
      useEffect(() => { saveTurns(sessionId, turns) }, [sessionId, turns])
      useEffect(() => { loadModels().then(setGroups, () => {}) }, [])
      useEffect(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight }, [turns])
      useEffect(() => { if (visible) setTimeout(() => inputRef.current?.focus(), 30) }, [visible])
      useEffect(() => () => abortRef.current?.abort(), [])

      const update = useCallback((id, patch) => {
        setTurns((list) => list.map((t) => (t.id === id ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t)))
      }, [])

      const ask = useCallback(async (raw) => {
        const question = String(raw || '').trim()
        if (!question || turnsRef.current.some((t) => t.status === 'streaming')) return
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
        const history = turnsRef.current.filter((t) => t.status === 'done' && t.answer).map((t) => ({ question: t.question, answer: t.answer }))
        setTurns((list) => [...list, { id, question, answer: '', status: 'streaming' }])
        setDraft('')
        const controller = new AbortController()
        abortRef.current = controller
        const [provider, ...rest] = modelKey ? modelKey.split('\u0000') : []
        const started = Date.now()
        try {
          const response = await fetch(BASE + '/ask', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, question, history, ...(modelKey ? { provider, model: rest.join('\u0000') } : {}) }),
            signal: controller.signal,
          })
          if (!response.ok || !response.body) {
            let message = 'HTTP ' + response.status
            try { message = (await response.json()).error || message } catch { /* keep */ }
            update(id, { status: 'error', error: message })
            return
          }
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          let settled = false
          const handle = (line) => {
            if (!line.trim()) return
            let event
            try { event = JSON.parse(line) } catch { return }
            if (event.type === 'meta') update(id, { model: event.model })
            else if (event.type === 'thinking') update(id, (t) => (t.thinking ? {} : { thinking: true }))
            else if (event.type === 'text') update(id, (t) => ({ answer: (t.answer || '') + event.text }))
            else if (event.type === 'done') {
              settled = true
              update(id, (t) => ({ status: 'done', ms: event.ms || Date.now() - started, ...(event.empty && !t.answer ? { error: '模型没有给出文字回答' } : {}), ...(event.droppedToolCalls ? { note: '忽略了 ' + event.droppedToolCalls + ' 个工具调用' } : {}) }))
            } else if (event.type === 'error') {
              settled = true
              update(id, (t) => ({ status: event.message === '已停止' ? 'stopped' : 'error', error: event.message === '已停止' ? undefined : event.message, ms: Date.now() - started, answer: t.answer }))
            }
          }
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let index
            while ((index = buffer.indexOf('\n')) !== -1) { handle(buffer.slice(0, index)); buffer = buffer.slice(index + 1) }
          }
          handle(buffer)
          if (!settled) update(id, { status: 'error', error: '连接中断' })
        } catch (error) {
          if (controller.signal.aborted) update(id, { status: 'stopped', ms: Date.now() - started })
          else update(id, { status: 'error', error: error?.message || String(error) })
        } finally {
          if (abortRef.current === controller) abortRef.current = null
        }
      }, [sessionId, modelKey, update])

      // /btw hand-off: fetch queued questions on mount and when signalled.
      const askRef = useRef(ask)
      askRef.current = ask
      useEffect(() => {
        let cancelled = false
        const pull = async () => {
          try {
            const { questions } = await fetchJson('/pending?sessionId=' + encodeURIComponent(sessionId))
            if (cancelled || !Array.isArray(questions) || questions.length === 0) return
            const last = questions[questions.length - 1]
            if (turnsRef.current.some((t) => t.status === 'streaming')) setDraft(last)
            else askRef.current(last)
          } catch { /* host half missing: nothing queued */ }
        }
        const onSignal = (event) => { if (!event.detail || event.detail === sessionId) void pull() }
        void pull()
        window.addEventListener(PENDING_EVENT, onSignal)
        return () => { cancelled = true; window.removeEventListener(PENDING_EVENT, onSignal) }
      }, [sessionId])

      // Right-click hand-off: a quoted selection (or nothing) to drop into the input.
      useEffect(() => {
        const take = () => {
          const value = pendingDrafts.get(sessionId)
          if (value === undefined) return
          pendingDrafts.delete(sessionId)
          if (value) setDraft((d) => (d.trim() ? value + d : value))
          setTimeout(() => {
            const el = inputRef.current
            if (!el) return
            el.focus()
            el.setSelectionRange?.(el.value.length, el.value.length)
          }, 40)
        }
        const onSignal = (event) => { if (!event.detail || event.detail === sessionId) take() }
        take()
        window.addEventListener(DRAFT_EVENT, onSignal)
        return () => window.removeEventListener(DRAFT_EVENT, onSignal)
      }, [sessionId])

      const insertSelection = () => {
        const text = String(window.getSelection?.()?.toString() || '').trim()
        if (!text) return
        const quoted = text.split(/\r?\n/).map((l) => '> ' + l).join('\n') + '\n\n'
        setDraft((d) => quoted + d)
        inputRef.current?.focus()
      }

      const options = useMemo(() => {
        const out = [h('option', { key: '', value: '' }, '模型：跟随主对话')]
        for (const group of groups) {
          out.push(h('optgroup', { key: group.id, label: group.name },
            group.models.map((m) => h('option', { key: group.id + m.id, value: group.id + '\u0000' + m.id }, m.name))))
        }
        return out
      }, [groups])

      return h('div', { className: 'dshx-sc', 'data-dshx-side-chat': sessionId },
        h('div', { className: 'dshx-sc-bar' },
          h('span', { className: 'grow', title: '侧边对话能看到主对话的全部上下文，但问答不会写回主对话' }, '不会写入主对话 · 可读取主对话上下文'),
          h('select', {
            value: modelKey,
            title: '回答用的模型',
            onChange: (e) => { setModelKey(e.target.value); try { localStorage.setItem(STORE_PREFIX + 'model', e.target.value) } catch { /* ignore */ } },
          }, options),
          h('button', { type: 'button', className: 'dshx-sc-btn', disabled: busy || turns.length === 0, onClick: () => setTurns([]), title: '清空这段侧边对话' }, '清空')),
        h('div', { className: 'dshx-sc-list', ref: listRef },
          turns.length === 0
            ? h('div', { className: 'dshx-sc-empty' },
              h('div', null, h('b', null, '侧边对话'), '：顺手问一个小问题，不打断、不污染主对话。'),
              h('div', null, '它能看到主对话到现在为止的全部内容（包括读过的文件和工具结果），但不能调用工具；问答只保存在这个面板里。'),
              h('div', { style: { marginTop: 8 } }, '入口：', h('b', null, 'Ctrl+;'), ' · 输入框里 ', h('b', null, '/btw 问题'), ' · 右侧栏 + 号'))
            : turns.map((turn) => h(React.Fragment, { key: turn.id },
              h('div', { className: 'dshx-sc-q' }, turn.question),
              h(Answer, { turn })))),
        h('div', { className: 'dshx-sc-input' },
          h('textarea', {
            ref: inputRef,
            rows: Math.min(8, Math.max(1, draft.split('\n').length)),
            value: draft,
            placeholder: '问一个不进入主对话的问题…',
            onChange: (e) => setDraft(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void ask(draft) }
              else if (e.key === 'Escape' && busy) { e.preventDefault(); abortRef.current?.abort() }
            },
          }),
          h('div', { className: 'row' },
            h('span', { className: 'hint' }, 'Enter 发送 · Shift+Enter 换行'),
            h('button', { type: 'button', className: 'dshx-sc-btn', onMouseDown: (e) => e.preventDefault(), onClick: insertSelection, title: '把主对话里选中的文字作为引用放进问题' }, '引用选中'),
            busy
              ? h('button', { type: 'button', className: 'dshx-sc-send', onClick: () => abortRef.current?.abort() }, '停止')
              : h('button', { type: 'button', className: 'dshx-sc-send', disabled: !draft.trim(), onClick: () => void ask(draft) }, '发送'))))
    }

    /**
     * Right-click menu inside the chat transcript (conversation.chat.text-interaction).
     * With text selected under the pointer: quote it into the side chat; otherwise
     * just open the side chat. Also offers Copy, since the native menu is suppressed.
     */
    function makeContextAction(openWith) {
      return function SideChatContextAction(props) {
        const { trigger, readText, dismiss, clearSelection, sessionId } = props
        useEffect(() => { ensureStyle() }, [])
        if (trigger !== 'contextmenu') return null
        const text = readText?.() ?? null
        const item = (label, onClick, key) => h('button', {
          key,
          type: 'button',
          role: 'menuitem',
          className: 'dshx-sc-menu-item',
          onPointerDown: (event) => event.preventDefault(),
          onClick,
        }, label)
        const items = []
        if (text) {
          items.push(item('在侧边对话中提问（引用选中）', () => { openWith(sessionId, quoteOf(text)); clearSelection?.(); dismiss?.() }, 'quote'))
          items.push(item('复制', () => { navigator.clipboard?.writeText(text); dismiss?.() }, 'copy'))
          items.push(h('div', { key: 'sep', className: 'dshx-sc-menu-sep' }))
          items.push(item('打开侧边对话', () => { openWith(sessionId, ''); dismiss?.() }, 'open'))
        } else {
          items.push(item('打开侧边对话', () => { openWith(sessionId, ''); dismiss?.() }, 'open'))
        }
        return h('div', { className: 'dshx-sc-menu', role: 'menu' }, items)
      }
    }

    function SideChatTitle() {
      return h('span', { className: 'dshx-sc-title' }, h(ChatGlyph, null), '侧边对话')
    }

    // ---------------------------------------------------------------- apply
    exports.name = NS
    exports.inject = ['slots', 'sidebarRight', 'sidebarRightTabs']

    exports.apply = (ctx) => {
      ensureStyle()

      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: TYPE_ID,
        kind: KIND,
        priority: 'extension',
        keepMounted: true,
        title: () => '侧边对话',
        guide: [{
          id: 'open',
          order: 30,
          title: () => '侧边对话',
          description: () => '问个小问题，不写入主对话',
          icon: GuideIcon,
        }],
      }), NS + ': tab type')

      ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: TYPE_ID,
        inject: (sessionId) => ({ sessionId }),
      }, SideChatBody))

      ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: TYPE_ID,
      }, SideChatTitle))

      const open = (sessionId) => {
        try {
          ctx.sidebarRight.openTab(KIND)
        } catch (error) {
          console.warn('[dshx-side-chat] open failed', error)
        }
        // Let the (possibly just mounted) body pull the queued question.
        setTimeout(() => window.dispatchEvent(new CustomEvent(PENDING_EVENT, { detail: sessionId })), 60)
      }

      /** Open the side chat for a session and drop `draft` into its input. */
      const openWith = (sessionId, draft) => {
        pendingDrafts.set(sessionId, draft || '')
        try {
          const target = ctx.sidebarRight.commandTarget?.()
          if (target !== undefined && typeof ctx.sidebarRight.openTabFromTarget === 'function') ctx.sidebarRight.openTabFromTarget(KIND, target)
          else ctx.sidebarRight.openTab(KIND)
        } catch (error) {
          try { ctx.sidebarRight.openTab(KIND) } catch { console.warn('[dshx-side-chat] open failed', error) }
        }
        setTimeout(() => window.dispatchEvent(new CustomEvent(DRAFT_EVENT, { detail: sessionId })), 60)
      }

      // Right-click in the transcript: own the contextmenu gesture (selection or
      // not) and show our menu. Selection-only gestures stay with Quote.
      ctx.inject(['uiConversation'], (scope) => {
        const conversation = scope.get('uiConversation')
        // The gesture object carries no DOM event, so remember Shift from a
        // capture listener: Shift+right-click keeps the browser's own menu.
        // Also skip links, images and other elements that own a context menu
        // (file links use the shared menu, whose React handler would otherwise
        // see our preventDefault and bow out).
        let skipGesture = false
        scope.effect(() => {
          const remember = (event) => {
            const el = event.target instanceof Element ? event.target : null
            const owner = el?.closest('a[href], img, video, [tabindex]:not([data-text-interaction-source]), [data-context-menu-trigger]')
            skipGesture = event.shiftKey === true || (owner != null && !owner.hasAttribute('data-text-interaction-source'))
          }
          window.addEventListener('contextmenu', remember, true)
          return () => window.removeEventListener('contextmenu', remember, true)
        }, NS + ': gesture tracker')
        scope.effect(() => conversation.interactions.register({
          id: NS,
          onInteraction(request) {
            if (request.trigger !== 'contextmenu' || skipGesture) return
            request.preventDefault()
            request.open()
          },
        }), NS + ': context interaction')
        ctx.slots.inject('conversation.chat.text-interaction', () => ctx.slots.register({
          name: 'conversation.chat.text-interaction',
          key: NS,
          inject: (sessionId) => ({ sessionId }),
        }, makeContextAction(openWith)))
      })

      // Right-click on the session title / breadcrumb: shared context menu.
      ctx.inject(['contextMenus'], (scope) => {
        const menus = scope.get('contextMenus')
        scope.effect(() => menus.register({
          id: NS + '.session',
          target: 'session',
          order: 50,
          resolve: (value) => (typeof value?.sessionId === 'string' ? [{
            id: 'open-side-chat',
            label: '打开侧边对话',
            commandId: 'dshx-side-chat.open',
            run: () => openWith(value.sessionId, ''),
          }] : []),
        }), NS + ': session menu')
      })

      // /btw (host command) -> open the panel in this window.
      ctx.effect(() => ctx.on('command/executed', (sessionId, commandName, result) => {
        if (commandName === 'btw' && result?.kind !== 'error') open(sessionId)
      }), NS + ': /btw')

      // Ctrl+;  — same chord as Claude desktop.
      ctx.inject(['shortcuts'], (scope) => {
        const shortcuts = scope.get('shortcuts')
        const chord = { code: 'Semicolon', modifiers: ['control'] }
        const mac = { code: 'Semicolon', modifiers: ['meta'] }
        scope.effect(() => shortcuts.register({
          id: 'dshx-side-chat.open',
          label: () => '打开侧边对话',
          aliases: ['side chat', 'btw', '侧边对话'],
          defaults: { 'desktop:macos': mac, 'desktop:windows': chord, 'desktop:linux': chord, 'web:macos': mac, 'web:windows': chord },
          regions: ['page', 'editable'],
          modals: [],
          resolve: ({ target: element }) => {
            const target = ctx.sidebarRight.commandTarget(element)
            if (target === undefined) return { status: 'blocked', reason: '先打开一个对话' }
            return {
              status: 'handled',
              run: () => {
                ctx.sidebarRight.openTabFromTarget(KIND, target)
                setTimeout(() => document.querySelector('.dshx-sc-input textarea')?.focus(), 80)
              },
            }
          },
        }), NS + ': shortcut')
      })
    }

    return exports
  },
})
