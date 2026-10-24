// ccapi core mod: runs the bridge, registers tools and agent types for each request, streams the
// request subagents' steps to the bridge and parks their tool calls until the client answers.
// Inert unless the session was started by `ccapi start` (CCAPI_SERVER=1).
import type { EngineInterface, PluginOptions, Register } from 'claude-code'
import type { AgentEvent, AgentToRegister, EngineToolResult, EngineUsage, RequestJob } from '../src/wire.ts'
import { OrderedSender } from '../src/event-sender.ts'
import { shouldScrub } from '../src/scrub.ts'
import { ATTACHMENTS_TOOL, TOOL_PREFIX } from '../src/tool-names.ts'

type Runtime = { base: string; headers: Record<string, string>; sender: OrderedSender<AgentEvent>; toolWaitMs: number }

let rt: Runtime | undefined

const post = async ($: EngineInterface, r: Runtime, path: string, body: unknown): Promise<void> => {
  const res = await $.http.fetch(`${r.base}${path}`, { method: 'POST', headers: r.headers, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`ccapi bridge ${path} answered ${res.status}`)
}

const envFor = (o: PluginOptions, port: string, token: string, internal: string): Record<string, string> => ({
  CCAPI_PORT: port,
  CCAPI_TOKEN: token,
  CCAPI_INTERNAL_TOKEN: internal,
  CCAPI_MAX_CONCURRENT: String(o.max_concurrent ?? 4),
  CCAPI_QUEUE_SIZE: String(o.queue_size ?? 16),
  CCAPI_TOOL_WAIT_MINUTES: String(o.tool_wait_minutes ?? 10),
  CCAPI_EXPOSE_THINKING: String(o.expose_thinking ?? 'requested'),
  CCAPI_DEBUG_BODIES: String(o.debug_bodies ?? false),
})

const runBridge = async ($: EngineInterface, argv: string[], env: Record<string, string>): Promise<void> => {
  for (;;) {
    try {
      for await (const { text } of $.process.spawn({ argv, env })) $.ui.log(`ccapi bridge: ${text.trimEnd()}`, { to: 'debug' })
    } catch (err) {
      $.ui.log(`ccapi bridge failed to start: ${String(err)}`, { to: 'debug' })
    }
    $.ui.toast('ccapi: bridge stopped, restarting')
    await $.clock.sleep(2000)
  }
}

const registerAgent = async ($: EngineInterface, a: AgentToRegister): Promise<void> => {
  const base = {
    name: a.name,
    description: 'ccapi request agent',
    prompt: a.prompt,
    tools: a.tools,
    omitClaudeMd: true as const,
    maxTurns: 200,
    ...(a.effort !== undefined ? { effort: a.effort } : {}),
  }
  const attempts = [
    { ...base, model: a.model, permissionMode: 'bypassPermissions' },
    { ...base, model: a.model },
    ...(a.modelFallback !== undefined ? [{ ...base, model: a.modelFallback }] : []),
  ]
  let last: unknown
  for (const spec of attempts) {
    try {
      await $.agent.register(spec)
      return
    } catch (err) {
      last = err
    }
  }
  throw last
}

const handleJob = async ($: EngineInterface, r: Runtime, job: RequestJob): Promise<void> => {
  try {
    for (const tool of job.newTools) await $.tool.register(tool)
    if (job.registerAgent) await registerAgent($, job.agent)
    await post($, r, '/internal/registered', { convId: job.convId, agentType: `ccapi:${job.agent.name}` })
  } catch (err) {
    await post($, r, '/internal/registered', { convId: job.convId, error: String(err) }).catch(() => undefined)
  }
}

const requestLoop = async ($: EngineInterface, r: Runtime): Promise<void> => {
  for (;;) {
    try {
      const res = await $.http.fetch(`${r.base}/internal/next-request`, { headers: r.headers })
      if (res.status === 200) void handleJob($, r, JSON.parse(res.text) as RequestJob)
      else if (res.status !== 204) await $.clock.sleep(1000)
    } catch {
      await $.clock.sleep(1000)
    }
  }
}

const refreshStatus = async ($: EngineInterface, r: Runtime): Promise<void> => {
  try {
    const res = await $.http.fetch(`${r.base}/health`)
    const h = JSON.parse(res.text) as { active: number; queued: number; total: number }
    $.ui.status(res.ok ? `ccapi · ${h.active} activos · ${h.queued} en cola · ${h.total} req` : 'ccapi · bridge caído')
  } catch {
    $.ui.status('ccapi · bridge caído')
  }
}

const toEngineUsage = (u: EngineUsage | null): EngineUsage | null =>
  u === null
    ? null
    : {
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        cache_read_input_tokens: u.cache_read_input_tokens,
        cache_creation_input_tokens: u.cache_creation_input_tokens,
      }

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if ((await $.env.get('CCAPI_SERVER')) !== '1') return started
    const port = (await $.env.get('CCAPI_PORT')) ?? '18787'
    const token = await $.env.get('CCAPI_TOKEN')
    const internal = await $.env.get('CCAPI_INTERNAL_TOKEN')
    const bridge = await $.env.get('CCAPI_BRIDGE')
    const bun = (await $.env.get('CCAPI_BUN')) ?? 'bun'
    if (!token || !internal || !bridge) {
      $.ui.toast('ccapi: CCAPI_TOKEN, CCAPI_INTERNAL_TOKEN and CCAPI_BRIDGE must be set (start with `ccapi start`)')
      return started
    }
    const runtime: Runtime = {
      base: `http://127.0.0.1:${port}`,
      headers: { 'x-ccapi-internal': internal, 'content-type': 'application/json' },
      toolWaitMs: Number(options.tool_wait_minutes ?? 10) * 60_000,
      sender: new OrderedSender<AgentEvent>(
        batch => post($, runtime, '/internal/events', batch),
        err => $.ui.log(`ccapi events: ${String(err)}`, { to: 'debug' }),
        { retries: 4, sleep: ms => $.clock.sleep(ms) },
      ),
    }
    rt = runtime
    await $.tool.register({
      name: ATTACHMENTS_TOOL,
      description: 'Shows the images and documents attached to this conversation. Pass ids to see specific attachments; omit them to see all.',
      inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'integer' } } } },
    })
    await $.command.register({ name: 'ccapi', description: 'Show the ccapi server status' })
    void runBridge($, [bun, bridge], envFor(options, port, token, internal))
    $.clock.after(1000, () => void requestLoop($, runtime))
    $.clock.every(10_000, () => void refreshStatus($, runtime))
    return started
  })

  on('agent.offer', ($, e, next) => (e.agent.startsWith('ccapi:') ? { isOffered: false } : next(e)))

  on('session.append', ($, e, next) =>
    rt && e.agentId && shouldScrub(e.message.type) ? next({ ...e, message: { ...e.message, content: [] } }) : next(e),
  )

  on('turn.step', async function* ($, e, next) {
    const r = rt
    if (!r || !e.agentId) return yield* next(e)
    const agentId = e.agentId
    const stream = next(e)
    const tools: Array<{ id: string; name: string }> = []
    let stopReason: string | null = null
    let usage: EngineUsage | null = null
    for await (const c of stream) {
      if (c.kind === 'text') r.sender.push({ kind: 'text', agentId, index: c.index, text: c.text })
      else if (c.kind === 'thinking') r.sender.push({ kind: 'thinking', agentId, index: c.index, text: c.text })
      else if (c.kind === 'tool') {
        tools.push({ id: c.id, name: c.name })
        r.sender.push({ kind: 'tool', agentId, index: c.index, id: c.id, name: c.name })
      } else if (c.kind === 'input') r.sender.push({ kind: 'input', agentId, index: c.index, json: c.json })
      else if (c.kind === 'stop') {
        stopReason = c.stopReason
        usage = c.usage
      }
      yield c
    }
    const result = await stream.result
    r.sender.push({
      kind: 'step-end',
      agentId,
      stopReason: stopReason ?? result.stopReason ?? null,
      usage: toEngineUsage(usage),
      toolUseIds: tools.map(t => t.id),
      toolNames: tools.map(t => t.name),
    })
    return result
  })

  on('tool.call', { tool: /^mcp__ccapi__/ }, async ($, e) => {
    const r = rt
    if (!r || !e.agentId) return { deny: 'ccapi tools only run inside ccapi request agents' }
    if (e.tool === TOOL_PREFIX + ATTACHMENTS_TOOL) {
      // A RegExp matcher leaves `e` as the union of every tool's input; view_attachments takes `ids`.
      const requested = (e as { ids?: unknown }).ids
      const ids = Array.isArray(requested) ? requested.join(',') : ''
      const res = await $.http.fetch(`${r.base}/internal/attachments/${e.agentId}?ids=${ids}`, { headers: r.headers })
      return res.ok ? { result: JSON.parse(res.text) as never } : { deny: `ccapi: attachments unavailable (${res.status})` }
    }
    // The bridge must have seen this call's tool chunk before we wait for its result.
    await r.sender.flushed()
    const deadline = Date.now() + r.toolWaitMs + 60_000
    let failures = 0
    while (Date.now() < deadline) {
      let res: { status: number; text: string }
      try {
        res = await $.http.fetch(`${r.base}/internal/wait/${e.tool_use_id}`, { headers: r.headers })
      } catch (err) {
        // A bridge restart or a dropped connection: retry a few times before giving the model an error.
        if (++failures >= 5) return { deny: `ccapi: lost the bridge while waiting (${String(err)})` }
        await $.clock.sleep(500)
        continue
      }
      if (res.status === 200) {
        const out = JSON.parse(res.text) as EngineToolResult
        return 'deny' in out ? { deny: out.deny } : { result: out.result as never }
      }
      if (res.status !== 204 && ++failures >= 5) return { deny: `ccapi: bridge answered ${res.status} while waiting` }
    }
    return { deny: 'ccapi: timed out waiting for the client tool result' }
  })

  on('turn.complete', async ($, e, next) => {
    if (rt && e.agentId) rt.sender.push({ kind: 'turn-end', agentId: e.agentId, reason: e.reason })
    return next(e)
  })

  on('command.run', { command: 'ccapi' }, async $ => {
    const r = rt
    if (!r) return { text: 'ccapi is inactive in this session. Start the server with `ccapi start`.' }
    try {
      const res = await $.http.fetch(`${r.base}/health`)
      return { text: `ccapi on ${r.base}\n${res.text}` }
    } catch (err) {
      return { text: `ccapi bridge not answering: ${String(err)}` }
    }
  })
}
