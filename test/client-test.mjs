import fs from 'node:fs'
import vm from 'node:vm'
const src = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
let mod
const React = { createElement: (t, p, ...c) => ({ t, p, c }), Fragment: 'F', useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useEffect() {}, useRef: (v) => ({ current: v }), useCallback: (f) => f, useMemo: (f) => f() }
const store = new Map()
const listeners = new Map()
const dispatched = []
const sandbox = {
  window: {
    __ModuleLoader__: { load: (d) => { mod = d.factory((n) => { if (n === 'react') return React; throw new Error('no ' + n) }) } },
    addEventListener: (t, f) => listeners.set(t, f), removeEventListener() {}, dispatchEvent: (e) => dispatched.push(e),
  },
  document: { querySelector: () => null, createElement: () => ({ dataset: {} }), head: { appendChild() {} } },
  navigator: { clipboard: { writeText: (t) => { sandbox.copied = t; return Promise.resolve() } } },
  localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
  Element: class Element { constructor(owner) { this.owner = owner } closest() { return this.owner } },
  console, setTimeout: (f) => f(), CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o?.detail } },
}
vm.runInNewContext(src, sandbox)
const reg = { tabs: [], slots: [], shortcuts: [], on: [], interactions: [], menus: [] }
const services = {
  shortcuts: { register: (d) => { reg.shortcuts.push(d); return () => {} } },
  uiConversation: { interactions: { register: (d) => { reg.interactions.push(d); return () => {} } } },
  contextMenus: { register: (d) => { reg.menus.push(d); return () => {} } },
}
const ctx = {
  effect: (f) => f(),
  sidebarRightTabs: { register: (d) => { reg.tabs.push(d); return () => {} } },
  slots: { inject: (_n, f) => f(), register: (d, C) => { reg.slots.push([d, C]); return () => {} } },
  sidebarRight: { openTab: (k) => { reg.opened = k }, commandTarget: () => ({ paneId: 'p' }), openTabFromTarget: (k) => { reg.fromTarget = k } },
  on: (e, f) => { reg.on.push([e, f]); return () => {} },
  inject: (keys, f) => f({ get: (k) => services[k], effect: (g) => g(), slots: ctx.slots }),
}
mod.apply(ctx)
let n = 0
const assert = (c, m) => { if (!c) throw new Error(m); n++ }
const slot = (name) => reg.slots.find((s) => s[0].name === name)
assert(mod.name === 'dshx-side-chat', 'name')
assert(reg.tabs[0].kind === 'dshx-side-chat' && reg.tabs[0].guide[0].title() === '侧边对话', 'tab type')
assert(slot('sidebar.right.pane.tab')[0].key === reg.tabs[0].id && slot('sidebar.right.pane.tab.title')[0].key === reg.tabs[0].id, 'tab slots keyed by type id')
reg.on[0][1]('s1', 'btw', { kind: 'success' }); assert(reg.opened === 'dshx-side-chat', '/btw opens tab')
const sc = reg.shortcuts[0]; assert(sc.defaults['desktop:windows'].code === 'Semicolon', 'ctrl+;')
sc.resolve({ target: {} }).run(); assert(reg.fromTarget === 'dshx-side-chat', 'shortcut opens')
const Body = slot('sidebar.right.pane.tab')[1]
assert(Body({ sessionId: 's1', useTabInfo: () => ({ tab: { visible: true } }) }).p.className === 'dshx-sc', 'body renders')

// --- right click in the transcript
const inter = reg.interactions[0]
assert(inter.id === 'dshx-side-chat', 'interaction registered')
const gesture = (trigger) => { const g = { trigger, opened: false, prevented: false, open() { g.opened = true }, preventDefault() { g.prevented = true } }; return g }
const sel = gesture('selection'); inter.onInteraction(sel); assert(!sel.opened, 'plain selection left to Quote')
const cm = gesture('contextmenu'); inter.onInteraction(cm); assert(cm.opened && cm.prevented, 'right-click claimed, native menu suppressed')
listeners.get('contextmenu')({ shiftKey: true })
const cmShift = gesture('contextmenu'); inter.onInteraction(cmShift); assert(!cmShift.opened, 'shift+right-click keeps native menu')
listeners.get('contextmenu')({ shiftKey: false })
listeners.get('contextmenu')({ shiftKey: false, target: new sandbox.Element({ hasAttribute: () => false }) })
const cmLink = gesture('contextmenu'); inter.onInteraction(cmLink); assert(!cmLink.opened, 'links/images keep their own menu')
listeners.get('contextmenu')({ shiftKey: false, target: new sandbox.Element(null) })
const cmText = gesture('contextmenu'); inter.onInteraction(cmText); assert(cmText.opened, 'plain text claimed')

const [decl, Menu] = slot('conversation.chat.text-interaction')
assert(decl.key === 'dshx-side-chat' && decl.inject('s9').sessionId === 's9', 'menu slot keyed by interaction id')
const texts = (tree) => tree.c.flat().filter((x) => x && x.t === 'button').map((b) => b.c[0])
let dismissed = 0, cleared = 0
const withSel = Menu({ trigger: 'contextmenu', readText: () => 'line A\nline B', dismiss: () => dismissed++, clearSelection: () => cleared++, sessionId: 's9' })
assert(texts(withSel)[0] === '在侧边对话中提问（引用选中）' && texts(withSel).includes('复制'), 'selection menu items')
reg.fromTarget = undefined
withSel.c.flat()[0].p.onClick()
assert(reg.fromTarget === 'dshx-side-chat' && dismissed === 1 && cleared === 1, 'quote action opens side chat')
assert(dispatched.some((e) => e.type === 'dshx-side-chat:draft' && e.detail === 's9'), 'draft signal sent')
withSel.c.flat()[1].p.onClick(); assert(sandbox.copied === 'line A\nline B', 'copy action')
const noSel = Menu({ trigger: 'contextmenu', readText: () => null, dismiss() {}, sessionId: 's9' })
assert(texts(noSel).join() === '打开侧边对话', 'no-selection menu = open only')
assert(Menu({ trigger: 'selection', readText: () => 'x', sessionId: 's9' }) === null, 'menu silent for other triggers')

// --- session header context menu
const sm = reg.menus[0]
assert(sm.target === 'session', 'session menu target')
const actions = sm.resolve({ sessionId: 's7' })
assert(actions[0].label === '打开侧边对话' && actions[0].commandId === 'dshx-side-chat.open', 'session menu action')
reg.fromTarget = undefined; actions[0].run(); assert(reg.fromTarget === 'dshx-side-chat', 'session menu opens')
console.log('PASS', n)

