// dshx-side-chat — host half.
//
// A Claude-style side chat: ask a quick question about the current conversation
// in a side panel. The answer sees the main conversation's full model history
// (system prompt, messages, tool results) up to the moment you ask, but NOTHING
// is written back: the main session log, its model history and its KV prefix
// stay exactly as they were. Each ask is one independent model request.
//
// HOW A SIDE QUESTION IS BUILT (all verified against 0.2.2-rc.1 sources)
//
//   * history  = mainSession.deriveMessages()  — the very array the agent loop
//                would send next, projections applied, system prompt first.
//   * route    = mainSession.requestHeader().config (provider / model /
//                reasoning effort), unless the panel picked another model.
//   * tools    = the main header's tool schemas + session.toolHistory(), sent
//                only so that a history full of tool calls stays a VALID request
//                (several providers reject tool_use blocks without tool
//                declarations) and so the provider can reuse the cached prefix.
//                The side model is told not to call tools; any tool call it
//                emits anyway is dropped, never executed.
//   * an open step (assistant tool calls whose results have not arrived yet,
//     e.g. the main agent is mid-turn) is trimmed so the request is well formed.
//   * then the earlier side exchange (user/assistant pairs) and the new
//     question are appended.
//
// No sessionId is put on the request: reusing the live agent's id makes
// subscription providers collide with an in-flight main turn (same lesson as
// dshx-ai-approval). The side chat transcript itself lives in the browser.
//
// ROUTES (same-origin, behind the connection trust fence when present)
//
//   POST /dshx-side-chat/ask      { sessionId, question, history?, provider?, model? }
//                                 -> application/x-ndjson stream of
//                                    {type:'meta'|'text'|'done'|'error', …}
//   GET  /dshx-side-chat/models   -> { groups: [{ id, name, models: [{id,name}] }] }
//   GET  /dshx-side-chat/pending?sessionId=<id>  -> { questions: string[] }  (consumes)
//
// COMMAND  /btw [question]  — opens the side chat; a question is handed to the
// panel (it is NOT sent to the main model). The command row stays in the
// transcript like every host command, but it is never model-visible.

import { createAssistantMessage, createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

export const name = 'dshx-side-chat'
export const inject = ['webServer', 'sessions', 'llm']

export const Config = z.object({
  maxSideTurns: z.natural().default(20).description('每次提问时最多带上多少轮之前的侧边问答'),
  maxOutputTokens: z.natural().default(0).description('侧边回答的输出上限；0 = 用主对话 / 模型默认值'),
  requestTimeoutSeconds: z.natural().default(600).description('单次侧边提问的超时（秒）'),
})

const BASE = '/dshx-side-chat'
const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_QUESTION_CHARS = 20000
const PENDING_TTL_MS = 5 * 60 * 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const FRAME = [
  '[SIDE QUESTION — dshx-side-chat]',
  'The user is asking a quick side question in a separate side panel. This exchange is NOT part of the main conversation above and will never be added to it.',
  '- Answer only the side question, using the conversation above as context.',
  '- Do NOT continue, resume or redo the main task. Do NOT call any tools, run commands or modify files — tools are unavailable here; answer from what is already in the context.',
  '- If the answer needs information that is not in the context, say so briefly.',
  '- Be concise. Reply in the language the user uses in the side question.',
].join('\n')

function describeError(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string') return error.message
  return String(error)
}

/** Candidate ids for a session id from the browser (`session-<uuid>` or bare uuid). */
export function idCandidates(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 200) return []
  const out = [sessionId]
  const bare = sessionId.startsWith('session-') ? sessionId.slice(8) : sessionId
  if (UUID.test(bare)) {
    for (const id of ['session-' + bare.toLowerCase(), bare.toLowerCase()]) if (!out.includes(id)) out.push(id)
  }
  return out
}

// ------------------------------------------------------------- history

/**
 * Make a snapshot of the main history safe to send on its own: drop tool calls
 * without a result (an open step) and results without a call, and drop
 * assistant messages that become empty. Message objects are copied, never mutated.
 * @param messages - the main session's derived messages.
 * @returns a new, well-formed message array.
 */
export function sanitizeHistory(messages) {
  const calls = new Set()
  const results = new Set()
  for (const message of messages) {
    if (message?.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) if (block?.type === 'tool-call' && typeof block.id === 'string') calls.add(block.id)
    } else if (message?.role === 'tool' && typeof message.toolCallId === 'string') {
      results.add(message.toolCallId)
    }
  }
  const out = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    if (message.role === 'tool') {
      if (calls.has(message.toolCallId)) out.push(message)
      continue
    }
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      const kept = message.content.filter((block) => block?.type !== 'tool-call' || results.has(block.id))
      if (kept.length === message.content.length) { out.push(message); continue }
      const visible = kept.filter((block) => block?.type !== 'reasoning')
      if (visible.length === 0) continue
      out.push({ ...message, content: kept })
      continue
    }
    out.push(message)
  }
  return out
}

/**
 * Normalize the side-chat history the browser sends: alternating question /
 * answer pairs, newest last, capped.
 * @param raw - `[{ question, answer }]` from the request body.
 * @param max - most recent pairs to keep.
 * @returns the cleaned pairs.
 */
export function cleanSideHistory(raw, max) {
  if (!Array.isArray(raw)) return []
  const pairs = []
  for (const item of raw) {
    const question = typeof item?.question === 'string' ? item.question.slice(0, MAX_QUESTION_CHARS) : ''
    const answer = typeof item?.answer === 'string' ? item.answer.slice(0, 200000) : ''
    if (question.trim() && answer.trim()) pairs.push({ question, answer })
  }
  return max > 0 ? pairs.slice(-max) : []
}

const sideSource = { kind: 'plugin', plugin: name }

/** Wrap a side question in the framing the model reads. */
export function framedQuestion(question, first) {
  return first ? FRAME + '\n\nSide question:\n' + question : '[Side question, continued]\n' + question
}

/**
 * Build the full message list for one side question.
 * @param mainMessages - the main session's derived history.
 * @param pairs - earlier side exchange.
 * @param question - the new side question.
 * @param route - `{ provider, model }` used to attribute earlier side answers.
 * @returns messages ready for `llm.stream`.
 */
export function buildMessages(mainMessages, pairs, question, route) {
  const messages = sanitizeHistory(mainMessages)
  pairs.forEach((pair, index) => {
    messages.push(createUserMessage({ content: [{ type: 'text', text: framedQuestion(pair.question, index === 0) }], source: sideSource }))
    messages.push(createAssistantMessage({ content: [{ type: 'text', text: pair.answer }], source: { provider: route.provider, model: route.model } }))
  })
  messages.push(createUserMessage({ content: [{ type: 'text', text: framedQuestion(question, pairs.length === 0) }], source: sideSource }))
  return messages
}

// -------------------------------------------------------------- pending /btw

const pending = new Map()

export function pushPending(sessionId, question) {
  const now = Date.now()
  const list = (pending.get(sessionId) ?? []).filter((item) => now - item.at < PENDING_TTL_MS)
  list.push({ question, at: now })
  pending.set(sessionId, list.slice(-5))
}

export function takePending(ids) {
  const now = Date.now()
  const out = []
  for (const id of ids) {
    const list = pending.get(id)
    if (list === undefined) continue
    pending.delete(id)
    for (const item of list) if (now - item.at < PENDING_TTL_MS) out.push(item.question)
  }
  return out
}

// ------------------------------------------------------------------- http

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
}

function rejectedBy(ctx, req, res) {
  let connection
  try { connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined } catch { connection = undefined }
  if (connection === undefined || typeof connection.requestRejection !== 'function') return false
  const status = connection.requestRejection(req)
  if (status === undefined) return false
  res.statusCode = status
  res.end()
  return true
}

/** Lowest-cost reading of a model's effort list is not needed: keep the main session's effort. */
function routeOf(header, body) {
  const config = header?.config ?? {}
  const override = typeof body.provider === 'string' && body.provider && typeof body.model === 'string' && body.model
  if (override) return { provider: body.provider, model: body.model, overridden: true }
  if (typeof config.provider === 'string' && config.provider && typeof config.model === 'string' && config.model) {
    return {
      provider: config.provider,
      model: config.model,
      ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
      ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
      ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
      overridden: false,
    }
  }
  return null
}

export function createHandlers(ctx, getConfig, logger) {
  const controller = () => {
    try { return ctx.get?.('sessionController') ?? ctx.sessionController } catch { return undefined }
  }

  /** The live main session; a cold one is resumed through the host's own resolver. */
  async function resolveSession(sessionId) {
    const ids = idCandidates(sessionId)
    for (const id of ids) {
      const live = ctx.sessions.get(id)
      if (live !== undefined) return live
    }
    const facade = controller()
    if (facade === undefined || typeof facade.resolveAgent !== 'function') throw new Error('主对话尚未载入，请先打开它。')
    let lastError
    for (const id of ids) {
      try {
        const result = await facade.resolveAgent(id)
        if (result?.agent?.session !== undefined) return result.agent.session
        if (result && 'error' in result) lastError = result.error
      } catch (error) { lastError = error }
    }
    throw new Error('无法载入主对话：' + describeError(lastError))
  }

  return {
    async ask(req, res) {
      if ((req.method ?? 'GET') !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      const body = await readBody(req)
      const question = typeof body.question === 'string' ? body.question.trim() : ''
      if (!question) return sendJson(res, 400, { error: '问题不能为空' })
      if (question.length > MAX_QUESTION_CHARS) return sendJson(res, 400, { error: '问题太长' })
      const config = getConfig()
      const session = await resolveSession(body.sessionId)
      const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
      const route = routeOf(header, body)
      if (route === null) return sendJson(res, 409, { error: '主对话还没有向模型发过请求，无法确定模型；请在侧边对话里手动选择一个模型。' })
      if (route.overridden) {
        const models = await ctx.llm.listModels(route.provider)
        if (!models.some((m) => m.id === route.model)) return sendJson(res, 400, { error: '模型不可用：' + route.provider + '/' + route.model })
      }

      const pairs = cleanSideHistory(body.history, config.maxSideTurns)
      const messages = buildMessages(session.deriveMessages(), pairs, question, route)
      // Tool declarations only when the route is the main one: a different
      // model may not accept the same schemas, and the cache prefix is lost anyway.
      const tools = !route.overridden && Array.isArray(header?.tools) && header.tools.length > 0 ? header.tools : undefined
      let toolHistory
      if (tools !== undefined) { try { toolHistory = session.toolHistory() } catch { toolHistory = undefined } }

      const abort = new AbortController()
      const timeout = setTimeout(() => abort.abort(), Math.max(10, config.requestTimeoutSeconds || 600) * 1000)
      const onClose = () => { if (!res.writableEnded) abort.abort() }
      res.on('close', onClose)

      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
      const emit = (value) => { if (!res.writableEnded) res.write(JSON.stringify(value) + '\n') }
      emit({ type: 'meta', provider: route.provider, model: route.model, overridden: route.overridden, historyMessages: messages.length - 1 - pairs.length * 2 })

      const started = Date.now()
      const assembler = new BlockAssembler()
      let droppedToolCalls = 0
      try {
        const options = {
          provider: route.provider,
          model: route.model,
          ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
          ...(route.temperature === undefined ? {} : { temperature: route.temperature }),
          ...(config.maxOutputTokens > 0 ? { maxTokens: config.maxOutputTokens } : route.maxTokens === undefined ? {} : { maxTokens: route.maxTokens }),
          messages,
          ...(tools === undefined ? {} : { tools }),
          ...(toolHistory === undefined ? {} : { toolHistory }),
          signal: abort.signal,
        }
        for await (const chunk of ctx.llm.stream(options)) {
          assembler.push(chunk)
          if (chunk.type === 'text-delta' && chunk.text) emit({ type: 'text', text: chunk.text })
          else if (chunk.type === 'reasoning-delta') emit({ type: 'thinking' })
          else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') droppedToolCalls += 1
        }
        const finish = assembler.finish
        if (finish?.kind === 'error' || finish?.kind === 'aborted') {
          const failure = finish.failure
          const message = failure ? [failure.code, failure.message].filter(Boolean).join(': ') : finish.kind
          emit({ type: 'error', message: abort.signal.aborted ? '已停止' : message })
        } else {
          const text = assembler.blocks().filter((b) => b.type === 'text').map((b) => b.text).join('')
          emit({
            type: 'done',
            finish: finish?.kind ?? 'stop',
            usage: assembler.usage ?? null,
            ms: Date.now() - started,
            ...(droppedToolCalls > 0 ? { droppedToolCalls } : {}),
            ...(text.trim() === '' ? { empty: true } : {}),
          })
        }
      } catch (error) {
        logger?.warn?.('side question failed: %s', describeError(error))
        emit({ type: 'error', message: abort.signal.aborted ? '已停止' : describeError(error) })
      } finally {
        clearTimeout(timeout)
        res.off?.('close', onClose)
        if (!res.writableEnded) res.end()
      }
    },

    async models(req, res) {
      if ((req.method ?? 'GET') !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      const groups = []
      for (const provider of ctx.llm.listProviders()) {
        try {
          const models = await ctx.llm.listModels(provider.id)
          if (models.length) groups.push({ id: provider.id, name: provider.name ?? provider.id, models: models.map((m) => ({ id: m.id, name: m.name ?? m.id })) })
        } catch { /* a broken provider must not hide the others */ }
      }
      sendJson(res, 200, { groups })
    },

    async pending(req, res) {
      if ((req.method ?? 'GET') !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      sendJson(res, 200, { questions: takePending(idCandidates(url.searchParams.get('sessionId') ?? '')) })
    },
  }
}

// ---------------------------------------------------------------- command

export function commandDefinition() {
  return {
    name: 'btw',
    description: '侧边对话：问一个不进入主对话的小问题',
    input: { hint: '[问题] —— 不填则只打开侧边对话' },
    recordInput: false,
    handler({ agent, rawInput }) {
      const question = String(rawInput ?? '').trim()
      const sessionId = agent?.session?.id ?? agent?.id
      if (question && typeof sessionId === 'string') pushPending(sessionId, question.slice(0, MAX_QUESTION_CHARS))
      return { kind: 'success', text: question ? '↗ 已转到侧边对话（不会进入主对话）' : '↗ 已打开侧边对话' }
    },
  }
}

// ------------------------------------------------------------------ apply

export function apply(ctx, config = {}) {
  const logger = (() => { try { return ctx.logger?.(name) } catch { return undefined } })()
  const live = {
    maxSideTurns: Number.isSafeInteger(config.maxSideTurns) ? config.maxSideTurns : 20,
    maxOutputTokens: Number.isSafeInteger(config.maxOutputTokens) ? config.maxOutputTokens : 0,
    requestTimeoutSeconds: Number.isSafeInteger(config.requestTimeoutSeconds) ? config.requestTimeoutSeconds : 600,
  }
  const handlers = createHandlers(ctx, () => live, logger)
  const route = (path, handler) => ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: BASE + path,
    handler: async (req, res) => {
      if (rejectedBy(ctx, req, res)) return
      try {
        await handler(req, res)
      } catch (error) {
        logger?.warn?.('%s failed: %s', path, describeError(error))
        if (!res.headersSent) sendJson(res, 500, { error: describeError(error) })
        else if (!res.writableEnded) { res.write(JSON.stringify({ type: 'error', message: describeError(error) }) + '\n'); res.end() }
      }
    },
  }), name + ': ' + path)

  route('/ask', handlers.ask)
  route('/models', handlers.models)
  route('/pending', handlers.pending)

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['commands'], (inner) => {
        try { inner.commands.register(commandDefinition()) } catch (error) { logger?.warn?.('/btw not registered: %s', describeError(error)) }
      })
    } catch { logger?.warn?.('commands service unavailable; /btw not registered') }
  }
}
