import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import fs0 from 'node:fs'
fs0.copyFileSync(new URL('../index.js', import.meta.url), new URL('./plug/index.js', import.meta.url))
const m = await import('./plug/index.js')
let pass = 0; const ok = (c, n) => { assert.ok(c, n); pass++ }

// sanitizeHistory: open step trimmed
const hist = [
  { role: 'system', content: [{ type: 'text', text: 'sys' }] },
  { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'reading' }, { type: 'tool-call', id: 'a', name: 'read', arguments: '{}' }] },
  { role: 'tool', toolCallId: 'a', content: [{ type: 'text', text: 'file' }] },
  { role: 'assistant', content: [{ type: 'reasoning', text: 'x' }, { type: 'tool-call', id: 'b', name: 'read', arguments: '{}' }] },
  { role: 'tool', toolCallId: 'zzz', content: [] },
]
const s = m.sanitizeHistory(hist)
ok(s.length === 4, 'open step + orphan result dropped')
ok(s[2] === hist[2], 'complete message kept by identity')

const pairs = m.cleanSideHistory([{ question: 'q1', answer: 'a1' }, { question: 'bad' }, { question: 'q2', answer: 'a2' }], 1)
ok(pairs.length === 1 && pairs[0].question === 'q2', 'side history capped')
const built = m.buildMessages(hist, pairs, 'why?', { provider: 'p', model: 'm' })
ok(built.at(-1).role === 'user' && built.at(-1).content[0].text.includes('why?'), 'question last')
ok(built.at(-3).content[0].text.startsWith('[SIDE QUESTION'), 'first side q framed')
ok(!built.at(-1).content[0].text.startsWith('[SIDE QUESTION'), 'followup not re-framed')
ok(hist.length === 6, 'input not mutated')
ok(m.idCandidates('session-AAAAAAAA-1111-2222-3333-444444444444').includes('session-aaaaaaaa-1111-2222-3333-444444444444'), 'id normalize')

// pending
m.pushPending('s1', 'hello'); ok(m.takePending(['s1'])[0] === 'hello', 'pending take'); ok(m.takePending(['s1']).length === 0, 'pending consumed')
const cmd = m.commandDefinition()
const r = cmd.handler({ agent: { session: { id: 's2' } }, rawInput: ' 这是啥 ' })
ok(r.kind === 'success' && m.takePending(['s2'])[0] === '这是啥', '/btw queues')

// ask handler end-to-end with fake ctx
let sent
const appended = []
const session = {
  id: 's3', requestHeader: () => ({ config: { provider: 'p', model: 'm', reasoningEffort: 'high' }, tools: [{ name: 'read' }] }),
  toolHistory: () => ({ th: 1 }), deriveMessages: () => hist, append: (...a) => appended.push(a),
}
const ctx = {
  sessions: { get: (id) => id === 's3' ? session : undefined },
  llm: {
    listProviders: () => [{ id: 'p', name: 'P' }], listModels: async () => [{ id: 'm' }],
    async *stream(o) { sent = o
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Hel' }
      yield { type: 'text-delta', index: 0, text: 'lo' }
      yield { type: 'finish', reason: { kind: 'stop' } } },
  },
}
const h = m.createHandlers(ctx, () => ({ maxSideTurns: 20, maxOutputTokens: 0, requestTimeoutSeconds: 60 }))
function fakeRes() { const e = new EventEmitter(); e.chunks = []; e.writableEnded = false; e.headersSent = false
  e.writeHead = (st) => { e.status = st; e.headersSent = true }; e.write = (c) => e.chunks.push(c); e.end = (c) => { if (c) e.chunks.push(c); e.writableEnded = true }; return e }
function fakeReq(body) { const r = Readable.from([Buffer.from(JSON.stringify(body))]); r.method = 'POST'; return r }
const res = fakeRes()
await h.ask(fakeReq({ sessionId: 's3', question: 'what file?' }), res)
const events = res.chunks.join('').trim().split('\n').map((l) => JSON.parse(l))
ok(res.status === 200 && events[0].type === 'meta' && events[0].model === 'm', 'meta')
ok(events.filter((e) => e.type === 'text').map((e) => e.text).join('') === 'Hello', 'streamed text')
ok(events.at(-1).type === 'done', 'done')
ok(sent.sessionId === undefined, 'no sessionId on request')
ok(sent.reasoningEffort === 'high' && sent.tools.length === 1 && sent.toolHistory.th === 1, 'route + tools from main header')
ok(appended.length === 0, 'main session never appended')
ok(sent.messages.length === 5, 'sanitized history + question')

const res2 = fakeRes()
await h.ask(fakeReq({ sessionId: 's3', question: 'x', provider: 'p', model: 'nope' }), res2)
ok(res2.status === 400, 'unknown override model rejected')
const res3 = fakeRes()
await h.ask(fakeReq({ sessionId: 's3', question: '   ' }), res3)
ok(res3.status === 400, 'empty question')
console.log('PASS', pass)


