import { describe, expect, test } from 'bun:test'
import type { RequestJob, SpawnJob } from '../../src/wire.ts'
import { type BridgeConfig, createBridge } from '../app.ts'

const usage = { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const body = async (res: Response): Promise<any> => res.json()

const setup = (over: Partial<BridgeConfig> = {}) => {
  const bridge = createBridge({
    token: 'tok',
    internalToken: 'int',
    maxConcurrent: 4,
    queueSize: 4,
    toolWaitMs: 60_000,
    exposeThinking: 'requested',
    longPollMs: 1000,
    maxParked: 32,
    debugBodies: false,
    log: () => {},
    ...over,
  })
  const client = (payload: unknown, key = 'tok', signal?: AbortSignal) =>
    bridge.fetch(
      new Request('http://bridge/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        ...(signal ? { signal } : {}),
      }),
    )
  const internal = async (path: string, payload?: unknown) => {
    const res = await bridge.fetch(
      new Request(`http://bridge/internal/${path}`, {
        method: payload === undefined ? 'GET' : 'POST',
        headers: { 'x-ccapi-internal': 'int', 'content-type': 'application/json' },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      }),
    )
    return { status: res.status, json: res.status === 200 ? await body(res) : undefined }
  }
  // Plays both mods: registration, spawn, agent id report.
  const admit = async (agentId: string) => {
    const job = (await internal('next-request')).json as RequestJob
    await internal('registered', { convId: job.convId, agentType: `ccapi:${job.agent.name}` })
    const spawn = (await internal('next-spawn')).json as SpawnJob
    await internal('spawned', { convId: job.convId, agentId })
    return { job, spawn }
  }
  return { bridge, client, internal, admit }
}

const parseSse = (text: string) =>
  text
    .split('\n\n')
    .filter(c => c.trim() !== '')
    .map(c => JSON.parse(c.split('\n').find(l => l.startsWith('data: '))!.slice(6)) as Record<string, unknown>)

const ask = { model: 'claude-haiku-4-5-20251001', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }
const weather = { name: 'get_weather', description: 'Weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }

describe('bridge', () => {
  test('rejects a bad token', async () => {
    const { client } = setup()
    const res = await client(ask, 'nope')
    expect(res.status).toBe(401)
  })

  test('rejects internal calls without the internal token', async () => {
    const { bridge } = setup()
    const res = await bridge.fetch(new Request('http://bridge/internal/next-request'))
    expect(res.status).toBe(401)
  })

  test('validation errors are 400 before anything is queued', async () => {
    const { client, internal } = setup({ longPollMs: 50 })
    expect((await client({ ...ask, max_tokens: 0 })).status).toBe(400)
    expect((await internal('next-request')).status).toBe(204)
  })

  test('plain text, non-stream', async () => {
    const { client, internal, admit } = setup()
    const pending = client(ask)
    const { job, spawn } = await admit('ag1')
    expect(job.registerAgent).toBe(true)
    expect(job.agent.tools).toEqual([])
    expect(spawn.prompt).toBe('hi')
    expect(spawn.description).toBe(`ccapi:${job.convId}`)
    await internal('events', [
      { kind: 'text', agentId: 'ag1', index: 0, text: 'Hello' },
      { kind: 'step-end', agentId: 'ag1', stopReason: 'end_turn', usage, toolUseIds: [], toolNames: [] },
      { kind: 'turn-end', agentId: 'ag1', reason: 'answer' },
    ])
    const res = await pending
    expect(res.status).toBe(200)
    expect(await body(res)).toMatchObject({ type: 'message', content: [{ type: 'text', text: 'Hello' }], stop_reason: 'end_turn' })
  })

  test('events that arrive before the spawn report are buffered', async () => {
    const { client, internal } = setup()
    const pending = client(ask)
    const job = (await internal('next-request')).json as RequestJob
    await internal('registered', { convId: job.convId, agentType: `ccapi:${job.agent.name}` })
    await internal('next-spawn')
    await internal('events', [
      { kind: 'text', agentId: 'ag2', index: 0, text: 'Early' },
      { kind: 'step-end', agentId: 'ag2', stopReason: 'end_turn', usage, toolUseIds: [], toolNames: [] },
    ])
    await internal('spawned', { convId: job.convId, agentId: 'ag2' })
    expect((await body(await pending)).content).toEqual([{ type: 'text', text: 'Early' }])
  })

  test('tool use parks the call and the next request continues the same subagent', async () => {
    const { client, internal, admit } = setup()
    const first = client({ ...ask, stream: true, tools: [weather], messages: [{ role: 'user', content: 'Weather in Paris?' }] })
    const { job } = await admit('ag3')
    expect(job.newTools).toEqual([{ name: 'get_weather', description: 'Weather', inputSchema: weather.input_schema }])
    expect(job.agent.tools).toEqual(['mcp__ccapi__get_weather'])
    const waiting = internal('wait/toolu_1')
    await internal('events', [
      { kind: 'tool', agentId: 'ag3', index: 0, id: 'toolu_1', name: 'mcp__ccapi__get_weather' },
      { kind: 'input', agentId: 'ag3', index: 0, json: '{"city":"Paris"}' },
      { kind: 'step-end', agentId: 'ag3', stopReason: 'tool_use', usage, toolUseIds: ['toolu_1'], toolNames: ['mcp__ccapi__get_weather'] },
    ])
    const events = parseSse(await (await first).text())
    expect(events.find(e => e.type === 'content_block_start')).toMatchObject({ content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather' } })
    expect(events.find(e => e.type === 'message_delta')).toMatchObject({ delta: { stop_reason: 'tool_use' } })

    const second = client({
      ...ask,
      tools: [weather],
      messages: [
        { role: 'user', content: 'Weather in Paris?' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '22C' }] },
      ],
    })
    expect((await waiting).json).toEqual({ result: '22C' })
    await internal('events', [
      { kind: 'text', agentId: 'ag3', index: 0, text: 'It is 22C.' },
      { kind: 'step-end', agentId: 'ag3', stopReason: 'end_turn', usage, toolUseIds: [], toolNames: [] },
      { kind: 'turn-end', agentId: 'ag3', reason: 'answer' },
    ])
    expect(await body(await second)).toMatchObject({ content: [{ type: 'text', text: 'It is 22C.' }], stop_reason: 'end_turn' })
  })

  test('a continuation queues no new subagent', async () => {
    const { client, internal, admit } = setup({ longPollMs: 100 })
    const first = client({ ...ask, tools: [weather] })
    await admit('ag4')
    await internal('events', [
      { kind: 'tool', agentId: 'ag4', index: 0, id: 'toolu_4', name: 'mcp__ccapi__get_weather' },
      { kind: 'step-end', agentId: 'ag4', stopReason: 'tool_use', usage, toolUseIds: ['toolu_4'], toolNames: [] },
    ])
    await first
    void client({
      ...ask,
      tools: [weather],
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_4', name: 'get_weather', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_4', content: 'x' }] },
      ],
    })
    expect((await internal('next-request')).status).toBe(204)
  })

  test('the attachments route serves the request images to view_attachments', async () => {
    const { client, internal, admit } = setup()
    const png = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
    void client({ ...ask, messages: [{ role: 'user', content: [png, { type: 'text', text: 'what?' }] }] })
    const { job } = await admit('ag5')
    expect(job.agent.tools).toEqual(['mcp__ccapi__view_attachments'])
    expect(job.agent.prompt).toContain('view_attachments')
    expect((await internal('attachments/ag5')).json).toEqual([{ type: 'text', text: 'attachment #1:' }, png])
  })

  test('a registration error is a 400', async () => {
    const { client, internal } = setup()
    const pending = client(ask)
    const job = (await internal('next-request')).json as RequestJob
    await internal('registered', { convId: job.convId, error: 'bad model' })
    const res = await pending
    expect(res.status).toBe(400)
    expect((await body(res)).error.message).toContain('bad model')
  })

  test('an upstream failure before output is a 529', async () => {
    const { client, internal, admit } = setup()
    const pending = client(ask)
    await admit('ag6')
    await internal('events', [{ kind: 'turn-end', agentId: 'ag6', reason: 'error' }])
    expect((await pending).status).toBe(529)
  })

  test('the concurrency limit answers 429 with retry-after', async () => {
    const { client } = setup({ maxConcurrent: 1, queueSize: 0 })
    void client(ask)
    await Bun.sleep(10)
    const res = await client(ask)
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('5')
  })

  test('a parked conversation frees its concurrency slot', async () => {
    const { client, internal, admit } = setup({ maxConcurrent: 1, queueSize: 0, longPollMs: 300 })
    const first = client({ ...ask, tools: [weather] })
    await admit('ag7')
    await internal('events', [
      { kind: 'tool', agentId: 'ag7', index: 0, id: 'toolu_7', name: 'mcp__ccapi__get_weather' },
      { kind: 'step-end', agentId: 'ag7', stopReason: 'tool_use', usage, toolUseIds: ['toolu_7'], toolNames: [] },
    ])
    expect((await body(await first)).stop_reason).toBe('tool_use')
    void client(ask)
    expect((await internal('next-request')).status).toBe(200)
  })

  test('too many parked conversations evict the oldest', async () => {
    const { client, internal, admit } = setup({ maxParked: 1 })
    for (const [agentId, toolId] of [
      ['ag8', 'toolu_8'],
      ['ag9', 'toolu_9'],
    ] as const) {
      const pending = client({ ...ask, tools: [weather] })
      await admit(agentId)
      await internal('events', [
        { kind: 'tool', agentId, index: 0, id: toolId, name: 'mcp__ccapi__get_weather' },
        { kind: 'step-end', agentId, stopReason: 'tool_use', usage, toolUseIds: [toolId], toolNames: [] },
      ])
      await pending
    }
    expect((await internal('wait/toolu_8')).json).toMatchObject({ deny: expect.stringContaining('closed') })
  })

  test('a client tool cut off by max_tokens gets a deny', async () => {
    const { client, internal, admit } = setup()
    const pending = client({ ...ask, max_tokens: 1, tools: [weather] })
    await admit('ag10')
    await internal('events', [
      { kind: 'tool', agentId: 'ag10', index: 0, id: 'toolu_10', name: 'mcp__ccapi__get_weather' },
      { kind: 'input', agentId: 'ag10', index: 0, json: '{"city":"a very long city name indeed"}' },
    ])
    expect((await body(await pending)).stop_reason).toBe('max_tokens')
    expect((await internal('wait/toolu_10')).json).toMatchObject({ deny: expect.any(String) })
  })

  test('a request whose client left while queued never starts', async () => {
    const { client, internal, admit } = setup({ maxConcurrent: 1, queueSize: 1, longPollMs: 200 })
    void client(ask)
    await admit('ag11')
    const ac = new AbortController()
    const queued = client(ask, 'tok', ac.signal).catch(() => undefined)
    await Bun.sleep(10)
    ac.abort()
    await queued
    await internal('events', [{ kind: 'turn-end', agentId: 'ag11', reason: 'answer' }])
    expect((await internal('next-request')).status).toBe(204)
  })

  test('a conversation stuck before its spawn times out', async () => {
    const { bridge, client } = setup()
    const pending = client(ask)
    await Bun.sleep(10)
    bridge.sweep(Date.now() + 10 * 60_000)
    expect((await pending).status).toBe(500)
  })

  test('a changed tool description is registered again', async () => {
    const { client, internal, admit } = setup()
    void client({ ...ask, tools: [weather] })
    await admit('ag12')
    void client({ ...ask, tools: [{ ...weather, description: 'Weather, in Celsius' }] })
    const job = (await internal('next-request')).json as RequestJob
    expect(job.newTools).toEqual([{ name: 'get_weather', description: 'Weather, in Celsius', inputSchema: weather.input_schema }])
  })

  test('the /anthropic gateway prefix reaches the same routes', async () => {
    const { bridge } = setup()
    const models = await bridge.fetch(new Request('http://bridge/anthropic/v1/models', { headers: { 'x-api-key': 'tok' } }))
    expect(models.status).toBe(200)
  })

  test('models and count_tokens', async () => {
    const { bridge } = setup()
    const models = await bridge.fetch(new Request('http://bridge/v1/models', { headers: { 'x-api-key': 'tok' } }))
    expect((await body(models)).data.length).toBeGreaterThan(0)
    const count = await bridge.fetch(
      new Request('http://bridge/v1/messages/count_tokens', { method: 'POST', headers: { 'x-api-key': 'tok' }, body: JSON.stringify(ask) }),
    )
    expect((await body(count)).input_tokens).toBeGreaterThan(0)
  })
})
