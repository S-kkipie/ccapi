import type { MessagesRequest } from '../src/api.ts'
import type { AgentEvent, RegisteredReport, RequestJob, SpawnedReport, SpawnJob, ToolToRegister } from '../src/wire.ts'
import { ATTACHMENTS_ADDENDUM, buildAgentPlan, effortOf, toolChoiceAddendum } from '../src/agent-spec.ts'
import { ApiError, errorBody, toApiError } from '../src/errors.ts'
import { fnv1a } from '../src/hash.ts'
import { familyAlias, MODELS, resolveModel } from '../src/models.ts'
import { renderConversation, systemText } from '../src/render.ts'
import { type Route, routeRequest } from '../src/router.ts'
import { estimateRequestTokens } from '../src/token-estimate.ts'
import { ATTACHMENTS_TOOL, modelVisibleName, schemaKey, stripPrefix, ToolNameRegistry } from '../src/tool-names.ts'
import { parseMessagesRequest } from '../src/validate.ts'
import { type Conversation, ConversationStore } from './conversations.ts'
import { Limiter } from './limiter.ts'
import { JobQueue } from './queue.ts'
import { ResponseSink } from './sink.ts'

export type BridgeConfig = {
  token: string
  internalToken: string
  maxConcurrent: number
  queueSize: number
  toolWaitMs: number
  exposeThinking: 'requested' | 'always' | 'never'
  longPollMs: number
  maxParked: number
  debugBodies: boolean
  log: (entry: Record<string, unknown>) => void
}

export type Health = { ok: true; active: number; queued: number; conversations: number; parked: number; total: number }

const BUFFER_MS = 60_000
// A conversation that has no subagent this long after it was queued is failed (lost registration or spawn report).
const SPAWN_TIMEOUT_MS = 90_000
// The deny a parked tool call gets when its client never comes back; it keeps the subagent's last reply short.
const CLIENT_GONE = 'The client closed this conversation. Do not call any tool; reply with just: ok'
const CLIENT_ENDED = 'The client ended this message before the tool ran. Do not call any tool; reply with just: ok'
const noContent = () => new Response(null, { status: 204 })

export const createBridge = (cfg: BridgeConfig) => {
  const store = new ConversationStore()
  const limiter = new Limiter(cfg.maxConcurrent, cfg.queueSize)
  const names = new ToolNameRegistry()
  const registeredTools = new Set<string>()
  const registeredAgents = new Set<string>()
  const pendingRegistration = new Map<string, { toolKeys: string[]; agentName: string }>()
  const requests = new JobQueue<RequestJob>()
  const spawns = new JobQueue<SpawnJob>()
  const buffered = new Map<string, { at: number; events: AgentEvent[] }>()
  let total = 0

  const fail = (err: ApiError) =>
    Response.json(errorBody(err), { status: err.status, ...(err.status === 429 ? { headers: { 'retry-after': '5' } } : {}) })

  const readJson = async (req: Request): Promise<unknown> => {
    try {
      return await req.json()
    } catch {
      throw new ApiError(400, 'invalid_request_error', 'body is not valid JSON')
    }
  }

  const authorized = (req: Request): boolean => {
    const key = req.headers.get('x-api-key') ?? req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    return key === cfg.token
  }

  const health = (): Health => ({ ok: true, ...limiter.stats(), conversations: store.size, parked: store.parkedCount, total })

  const newSink = (req: MessagesRequest, convId: string, toolNames: Record<string, string>, route: 'fresh' | 'continue') => {
    const startedAt = Date.now()
    return new ResponseSink(
      {
        id: `msg_${crypto.randomUUID().replaceAll('-', '')}`,
        model: req.model,
        inputTokensEstimate: estimateRequestTokens(req),
        maxTokens: req.max_tokens,
        stopSequences: req.stop_sequences ?? [],
        exposeThinking: cfg.exposeThinking === 'always' || (cfg.exposeThinking === 'requested' && req.thinking?.type === 'enabled'),
        clientToolName: name => {
          const registered = stripPrefix(name)
          return registered === undefined || registered === ATTACHMENTS_TOOL ? undefined : toolNames[registered]
        },
      },
      req.stream === true,
      sink => {
        const message = sink.message()
        cfg.log({
          convId,
          route,
          model: req.model,
          stream: req.stream === true,
          ms: Date.now() - startedAt,
          stopReason: message.stop_reason,
          usage: message.usage,
          ...(cfg.debugBodies ? { request: req } : {}),
        })
      },
    )
  }

  // Takes a concurrency slot for this request; the returned release is safe to call more than once.
  const takeSlot = async (signal: AbortSignal): Promise<() => void> => {
    await limiter.acquire(signal)
    let released = false
    const release = () => {
      if (released) return
      released = true
      limiter.release()
    }
    if (signal.aborted) {
      release()
      throw new ApiError(499, 'api_error', 'the client closed the request')
    }
    return release
  }

  const denyClientTools = (sink: ResponseSink, reason: string): void => {
    for (const id of sink.clientToolUseIds) store.deliver(id, { deny: reason })
  }

  const bindAbort = (signal: AbortSignal, conv: Conversation, sink: ResponseSink): void => {
    const onAbort = () => {
      if (sink.isEnded) return
      sink.abandon()
      denyClientTools(sink, CLIENT_ENDED)
      if (conv.sink === sink) {
        conv.sink = undefined
        conv.detached = true
      }
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  const startConversation = async (req: MessagesRequest, signal: AbortSignal): Promise<Response> => {
    const model = resolveModel(req.model)
    const release = await takeSlot(signal)
    try {
      const convId = crypto.randomUUID()
      const rendered = renderConversation(req.messages)
      const clientTools = req.tool_choice?.type === 'none' ? [] : (req.tools ?? [])
      const toolNames: Record<string, string> = {}
      const clientToModel: Record<string, string> = {}
      const newTools: ToolToRegister[] = []
      const toolKeys: string[] = []
      const schemaKeys: string[] = []
      for (const tool of clientTools) {
        const key = schemaKey(tool.input_schema)
        const { registered } = names.bind(tool.name, key)
        toolNames[registered] = tool.name
        clientToModel[tool.name] = modelVisibleName(registered)
        schemaKeys.push(key)
        const toolKey = `${registered}\u0000${key}\u0000${fnv1a(tool.description ?? '')}`
        if (!registeredTools.has(toolKey)) {
          newTools.push({ name: registered, description: tool.description || tool.name, inputSchema: tool.input_schema })
          toolKeys.push(toolKey)
        }
      }
      const tools = Object.values(clientToModel)
      if (rendered.attachments.items.length > 0) tools.push(modelVisibleName(ATTACHMENTS_TOOL))
      const addenda = [
        toolChoiceAddendum(req.tool_choice, n => clientToModel[n] ?? n),
        rendered.latestHasAttachments ? ATTACHMENTS_ADDENDUM : undefined,
      ].filter((s): s is string => s !== undefined)
      const effort = effortOf(req)
      const plan = buildAgentPlan({
        system: systemText(req.system),
        addenda,
        tools,
        toolSchemaKeys: schemaKeys,
        model,
        ...(effort !== undefined ? { effort } : {}),
      })
      const fallback = familyAlias(model)
      const sink = newSink(req, convId, toolNames, 'fresh')
      const conv: Conversation = {
        convId,
        model,
        prompt: rendered.prompt,
        toolNames,
        attachments: rendered.attachments,
        sink,
        parked: [],
        detached: false,
        startedAt: Date.now(),
        release,
      }
      store.add(conv)
      bindAbort(signal, conv, sink)
      pendingRegistration.set(convId, { toolKeys, agentName: plan.name })
      requests.push({
        convId,
        newTools,
        agent: { ...plan, ...(fallback !== undefined && fallback !== model ? { modelFallback: fallback } : {}) },
        registerAgent: !registeredAgents.has(plan.name),
      })
      return await sink.response
    } catch (err) {
      release()
      throw err
    }
  }

  const continueConversation = async (
    req: MessagesRequest,
    route: Extract<Route, { kind: 'continue' }>,
    signal: AbortSignal,
  ): Promise<Response> => {
    const release = await takeSlot(signal)
    const conv = store.get(route.convId)
    // It may have expired or been evicted while this request waited for a slot.
    if (!conv) {
      release()
      return startConversation(req, signal)
    }
    conv.release = release
    const sink = newSink(req, conv.convId, conv.toolNames, 'continue')
    conv.sink = sink
    conv.detached = false
    bindAbort(signal, conv, sink)
    for (const [id, result] of route.results) store.deliver(id, result)
    return sink.response
  }

  const handleEvent = (conv: Conversation, ev: AgentEvent): void => {
    if (ev.kind === 'turn-end') {
      conv.sink?.feed(ev)
      store.remove(conv.convId, 'the conversation has ended')
      return
    }
    const sink = conv.sink
    if (conv.detached || !sink) {
      if (ev.kind === 'tool') store.deliver(ev.id, { deny: CLIENT_ENDED })
      return
    }
    sink.feed(ev)
    if (!sink.isEnded) return
    conv.sink = undefined
    if (sink.stopReason === 'tool_use') {
      store.park(conv.convId, sink.clientToolUseIds, Date.now() + cfg.toolWaitMs)
      // A parked subagent is idle until the client answers, so it holds no concurrency slot.
      conv.release()
      conv.release = () => {}
      const parked = store.parkedConversationIds()
      while (parked.length > cfg.maxParked) {
        const oldest = parked.shift()
        if (oldest !== undefined) store.remove(oldest, CLIENT_GONE)
      }
    } else {
      conv.detached = true
      denyClientTools(sink, CLIENT_ENDED)
    }
  }

  const onEvent = (ev: AgentEvent): void => {
    const conv = store.byAgent(ev.agentId)
    if (conv) return handleEvent(conv, ev)
    if (store.isDeadAgent(ev.agentId)) {
      if (ev.kind === 'tool') store.deliver(ev.id, { deny: CLIENT_GONE })
      return
    }
    const entry = buffered.get(ev.agentId) ?? { at: Date.now(), events: [] }
    entry.events.push(ev)
    buffered.set(ev.agentId, entry)
  }

  const onRegistered = (report: RegisteredReport): void => {
    const pending = pendingRegistration.get(report.convId)
    pendingRegistration.delete(report.convId)
    const conv = store.get(report.convId)
    if (!conv) return
    if ('error' in report) {
      conv.sink?.fail(new ApiError(400, 'invalid_request_error', `ccapi could not prepare the agent: ${report.error}`))
      store.remove(report.convId, 'registration failed')
      return
    }
    if (pending) {
      for (const key of pending.toolKeys) registeredTools.add(key)
      registeredAgents.add(pending.agentName)
    }
    spawns.push({ convId: report.convId, agentType: report.agentType, prompt: conv.prompt, description: `ccapi:${report.convId}` })
  }

  const onSpawned = (report: SpawnedReport): void => {
    const conv = store.get(report.convId)
    if (!conv) return
    if ('error' in report) {
      conv.sink?.fail(new ApiError(500, 'api_error', `ccapi could not start the agent: ${report.error}`))
      store.remove(report.convId, 'spawn failed')
      return
    }
    store.bindAgent(report.convId, report.agentId)
    const early = buffered.get(report.agentId)
    buffered.delete(report.agentId)
    for (const ev of early?.events ?? []) handleEvent(conv, ev)
  }

  const takeJob = async <T>(queue: JobQueue<T>, req: Request): Promise<Response> => {
    const job = await queue.take(cfg.longPollMs, req.signal)
    if (job === undefined) return noContent()
    if (req.signal.aborted) {
      queue.unshift(job)
      return noContent()
    }
    return Response.json(job)
  }

  const internalRoute = async (req: Request, url: URL): Promise<Response> => {
    if (req.headers.get('x-ccapi-internal') !== cfg.internalToken)
      return fail(new ApiError(401, 'authentication_error', 'bad internal token'))
    const [, , route = '', arg = ''] = url.pathname.split('/')
    switch (`${req.method} ${route}`) {
      case 'GET next-request':
        return takeJob(requests, req)
      case 'GET next-spawn':
        return takeJob(spawns, req)
      case 'POST registered':
        onRegistered((await readJson(req)) as RegisteredReport)
        return Response.json({ ok: true })
      case 'POST spawned':
        onSpawned((await readJson(req)) as SpawnedReport)
        return Response.json({ ok: true })
      case 'POST events':
        for (const ev of (await readJson(req)) as AgentEvent[]) onEvent(ev)
        return Response.json({ ok: true })
      case 'GET wait': {
        const result = await store.wait(arg, cfg.longPollMs, req.signal)
        return result === undefined ? noContent() : Response.json(result)
      }
      case 'GET attachments': {
        const conv = store.byAgent(arg)
        if (!conv) return fail(new ApiError(404, 'not_found_error', 'unknown agent'))
        const ids = (url.searchParams.get('ids') ?? '').split(',').filter(s => s !== '').map(Number)
        return Response.json(conv.attachments.toToolResult(ids))
      }
      default:
        return fail(new ApiError(404, 'not_found_error', `no internal route ${req.method} ${route}`))
    }
  }

  const messages = async (req: Request): Promise<Response> => {
    const body = parseMessagesRequest(await readJson(req))
    total++
    const route = routeRequest(body, ids => store.findParked(ids))
    return route.kind === 'continue' ? continueConversation(body, route, req.signal) : startConversation(body, req.signal)
  }

  const fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    // Clients reach the routes as /v1/messages, /messages, or under the /anthropic gateway prefix (Hermes, others).
    const path = url.pathname.replace(/^\/anthropic(?=\/)/, '').replace(/^\/v1(?=\/)/, '')
    try {
      if (url.pathname.startsWith('/internal/')) return await internalRoute(req, url)
      if (req.method === 'GET' && path === '/health') return Response.json(health())
      if (!authorized(req)) throw new ApiError(401, 'authentication_error', 'invalid x-api-key')
      if (req.method === 'GET' && path === '/models')
        return Response.json({
          data: MODELS.map(m => ({ type: 'model', id: m.id, display_name: m.display_name, created_at: '2025-01-01T00:00:00Z' })),
          has_more: false,
          first_id: MODELS[0]?.id ?? null,
          last_id: MODELS[MODELS.length - 1]?.id ?? null,
        })
      if (req.method === 'POST' && path === '/messages/count_tokens') {
        const body = await readJson(req)
        if (typeof body !== 'object' || body === null || !Array.isArray((body as { messages?: unknown }).messages))
          throw new ApiError(400, 'invalid_request_error', 'messages: required array')
        return Response.json({ input_tokens: estimateRequestTokens(body as { messages: unknown }) })
      }
      if (req.method === 'POST' && path === '/messages') return await messages(req)
      throw new ApiError(404, 'not_found_error', `no route ${req.method} ${url.pathname}`)
    } catch (err) {
      return fail(toApiError(err))
    }
  }

  const sweep = (now: number): void => {
    for (const convId of store.expired(now)) store.remove(convId, CLIENT_GONE)
    for (const conv of store.list()) {
      if (conv.agentId !== undefined || now - conv.startedAt <= SPAWN_TIMEOUT_MS) continue
      conv.sink?.fail(new ApiError(500, 'api_error', 'ccapi could not start the subagent in time'))
      pendingRegistration.delete(conv.convId)
      store.remove(conv.convId, 'the subagent never started')
    }
    for (const [agentId, entry] of buffered) if (now - entry.at > BUFFER_MS) buffered.delete(agentId)
    store.prune(now)
  }

  return { fetch, sweep, health }
}
