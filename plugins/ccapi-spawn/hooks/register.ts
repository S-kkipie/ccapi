// ccapi spawner mod. A plugin does not see the steps or tool calls of subagents it spawns itself
// (spike finding 1b), so spawning lives here and the ccapi core mod observes them.
// Inert unless the session was started by `ccapi start` (CCAPI_SERVER=1).
import type { EngineInterface, Register } from 'claude-code'

// Mirrors SpawnJob in plugins/ccapi/src/wire.ts (a hooks module only imports its own plugin's files).
type SpawnJob = { convId: string; agentType: string; prompt: string; description: string }

const report = async ($: EngineInterface, base: string, headers: Record<string, string>, body: unknown): Promise<void> => {
  await $.http.fetch(`${base}/internal/spawned`, { method: 'POST', headers, body: JSON.stringify(body) }).catch(() => undefined)
}

const spawn = async ($: EngineInterface, base: string, headers: Record<string, string>, job: SpawnJob): Promise<void> => {
  try {
    const started = await $.agent.spawn({ subagentType: job.agentType, prompt: job.prompt, description: job.description })
    await report(
      $,
      base,
      headers,
      started.agentId !== undefined
        ? { convId: job.convId, agentId: started.agentId }
        : { convId: job.convId, error: started.deny ?? 'the spawn returned no agent id' },
    )
  } catch (err) {
    await report($, base, headers, { convId: job.convId, error: String(err) })
  }
}

const spawnLoop = async ($: EngineInterface, base: string, headers: Record<string, string>): Promise<void> => {
  for (;;) {
    try {
      const res = await $.http.fetch(`${base}/internal/next-spawn`, { headers })
      if (res.status === 200) void spawn($, base, headers, JSON.parse(res.text) as SpawnJob)
      else if (res.status !== 204) await $.clock.sleep(1000)
    } catch {
      await $.clock.sleep(1000)
    }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if ((await $.env.get('CCAPI_SERVER')) !== '1') return started
    const port = (await $.env.get('CCAPI_PORT')) ?? '18787'
    const internal = await $.env.get('CCAPI_INTERNAL_TOKEN')
    if (!internal) return started
    const headers = { 'x-ccapi-internal': internal, 'content-type': 'application/json' }
    $.clock.after(1000, () => void spawnLoop($, `http://127.0.0.1:${port}`, headers))
    return started
  })
}
