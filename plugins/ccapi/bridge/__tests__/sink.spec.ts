import { describe, expect, test } from 'bun:test'
import type { AssemblerOptions } from '../../src/assembler.ts'
import { ApiError } from '../../src/errors.ts'
import { ResponseSink } from '../sink.ts'

const opts: AssemblerOptions = {
  id: 'msg_1',
  model: 'claude-haiku-4-5-20251001',
  inputTokensEstimate: 3,
  maxTokens: 1000,
  stopSequences: [],
  exposeThinking: false,
  clientToolName: () => undefined,
}
const usage = { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const parseSse = (text: string) =>
  text
    .split('\n\n')
    .filter(chunk => chunk.trim() !== '')
    .map(chunk => JSON.parse(chunk.split('\n').find(l => l.startsWith('data: '))!.slice(6)) as Record<string, unknown>)

describe('ResponseSink', () => {
  test('non-stream answers JSON once the message ends', async () => {
    let ended = 0
    const sink = new ResponseSink(opts, false, () => ended++)
    sink.feed({ kind: 'text', agentId: 'a', index: 0, text: 'Hi' })
    sink.feed({ kind: 'step-end', agentId: 'a', stopReason: 'end_turn', usage, toolUseIds: [], toolNames: [] })
    const res = await sink.response
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ content: [{ type: 'text', text: 'Hi' }], stop_reason: 'end_turn' })
    expect(sink.isEnded).toBe(true)
    expect(ended).toBe(1)
  })

  test('stream answers SSE events in order', async () => {
    const sink = new ResponseSink(opts, true, () => {})
    sink.feed({ kind: 'text', agentId: 'a', index: 0, text: 'Hi' })
    const res = await sink.response
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    sink.feed({ kind: 'step-end', agentId: 'a', stopReason: 'end_turn', usage, toolUseIds: [], toolNames: [] })
    const types = parseSse(await res.text()).map(e => e.type)
    expect(types).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'])
  })

  test('turn-end answer closes a message still open', async () => {
    const sink = new ResponseSink(opts, false, () => {})
    sink.feed({ kind: 'text', agentId: 'a', index: 0, text: 'Hi' })
    sink.feed({ kind: 'turn-end', agentId: 'a', reason: 'answer' })
    expect(((await (await sink.response).json()) as { stop_reason: string }).stop_reason).toBe('end_turn')
  })

  test('an upstream error before any output is an HTTP error', async () => {
    const sink = new ResponseSink(opts, true, () => {})
    sink.feed({ kind: 'turn-end', agentId: 'a', reason: 'error' })
    const res = await sink.response
    expect(res.status).toBe(529)
    expect(await res.json()).toMatchObject({ type: 'error', error: { type: 'overloaded_error' } })
  })

  test('an error after the stream started is an SSE error event', async () => {
    const sink = new ResponseSink(opts, true, () => {})
    sink.feed({ kind: 'text', agentId: 'a', index: 0, text: 'Hi' })
    const res = await sink.response
    sink.fail(new ApiError(529, 'overloaded_error', 'busy'))
    const events = parseSse(await res.text())
    expect(events.at(-1)).toEqual({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } })
  })
})
