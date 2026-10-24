import { describe, expect, test } from 'bun:test'
import type { SseEvent } from '../api.ts'
import { type AssemblerOptions, MessageAssembler, UNSIGNED } from '../assembler.ts'
import { encodeSse } from '../sse.ts'

const usage = (input: number, output: number) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
})

const make = (over: Partial<AssemblerOptions> = {}) => {
  const events: SseEvent[] = []
  const a = new MessageAssembler(
    {
      id: 'msg_1',
      model: 'claude-haiku-4-5-20251001',
      inputTokensEstimate: 10,
      maxTokens: 1000,
      stopSequences: [],
      exposeThinking: false,
      clientToolName: n => (n === 'mcp__ccapi__get_weather' ? 'get_weather' : undefined),
      ...over,
    },
    ev => events.push(ev),
  )
  return { a, events, types: () => events.map(e => e.type) }
}

describe('MessageAssembler', () => {
  test('plain text', () => {
    const { a, events, types } = make()
    a.start()
    a.text(0, 'Hel')
    a.text(0, 'lo')
    expect(a.stepEnd({ stopReason: 'end_turn', usage: usage(5, 2), toolUseIds: [] })).toEqual({ kind: 'done', stopReason: 'end_turn' })
    expect(types()).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    expect(events[0]).toMatchObject({ type: 'message_start', message: { id: 'msg_1', content: [], usage: { input_tokens: 10 } } })
    expect(a.message()).toMatchObject({
      content: [{ type: 'text', text: 'Hello' }],
      stop_reason: 'end_turn',
      usage: usage(5, 2),
    })
  })

  test('client tool use ends the message with tool_use', () => {
    const { a, events, types } = make()
    a.start()
    a.text(0, 'Checking. ')
    a.tool(1, 'toolu_1', 'mcp__ccapi__get_weather')
    a.input(1, '{"ci')
    a.input(1, 'ty":"Paris"}')
    expect(a.stepEnd({ stopReason: 'tool_use', usage: null, toolUseIds: ['toolu_1'] })).toEqual({ kind: 'done', stopReason: 'tool_use' })
    expect(types()).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    expect(events[4]).toEqual({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} },
    })
    expect(a.message().content[1]).toEqual({ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } })
    expect(a.clientToolUseIds).toEqual(['toolu_1'])
  })

  test('internal tools are hidden and the message continues into the next step', () => {
    const { a, events, types } = make()
    a.start()
    a.tool(0, 'toolu_9', 'mcp__ccapi__view_attachments')
    a.input(0, '{}')
    expect(a.stepEnd({ stopReason: 'tool_use', usage: usage(100, 5), toolUseIds: ['toolu_9'] })).toEqual({ kind: 'continue' })
    a.text(0, 'Red.')
    expect(a.stepEnd({ stopReason: 'end_turn', usage: usage(200, 3), toolUseIds: [] })).toEqual({ kind: 'done', stopReason: 'end_turn' })
    expect(types()).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'])
    expect(events[1]).toMatchObject({ index: 0, content_block: { type: 'text' } })
    expect(a.message().usage).toEqual(usage(300, 8))
  })

  test('a stop sequence split across chunks ends the message', () => {
    const { a, events } = make({ stopSequences: ['STOP'] })
    a.start()
    a.text(0, 'abc ST')
    a.text(0, 'OP def')
    a.text(0, 'more')
    expect(a.isFinished).toBe(true)
    expect(a.stepEnd({ stopReason: 'end_turn', usage: null, toolUseIds: [] })).toEqual({ kind: 'done', stopReason: 'stop_sequence' })
    const deltas = events.flatMap(e => (e.type === 'content_block_delta' && e.delta.type === 'text_delta' ? [e.delta.text] : []))
    expect(deltas).toEqual(['abc', ' '])
    expect(a.message()).toMatchObject({ stop_reason: 'stop_sequence', stop_sequence: 'STOP', content: [{ text: 'abc ' }] })
  })

  test('max_tokens ends the message once the estimate passes the cap', () => {
    const { a, types } = make({ maxTokens: 2 })
    a.start()
    a.text(0, 'x'.repeat(30))
    expect(a.isFinished).toBe(true)
    expect(types()).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'])
    expect(a.message().stop_reason).toBe('max_tokens')
  })

  test('thinking is hidden unless exposed', () => {
    const { a, events } = make()
    a.start()
    a.thinking(0, 'hmm')
    a.text(1, 'Hi')
    a.stepEnd({ stopReason: 'end_turn', usage: null, toolUseIds: [] })
    expect(events.some(e => e.type === 'content_block_delta' && e.delta.type === 'thinking_delta')).toBe(false)
    expect(events[1]).toMatchObject({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })
  })

  test('exposed thinking gets a signature before its block stops', () => {
    const { a, types } = make({ exposeThinking: true })
    a.start()
    a.thinking(0, 'hmm')
    a.text(1, 'Hi')
    a.stepEnd({ stopReason: 'end_turn', usage: null, toolUseIds: [] })
    expect(types()).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    expect(a.message().content[0]).toEqual({ type: 'thinking', thinking: 'hmm', signature: UNSIGNED })
  })

  test('empty thinking chunks open no block', () => {
    const { a, events } = make({ exposeThinking: true })
    a.start()
    a.thinking(0, '')
    a.text(1, 'Hi')
    a.stepEnd({ stopReason: 'end_turn', usage: null, toolUseIds: [] })
    expect(events.some(e => e.type === 'content_block_start' && e.content_block.type === 'thinking')).toBe(false)
    expect(a.message().content).toEqual([{ type: 'text', text: 'Hi' }])
  })

  test('a step stopped by the safety classifier stays open for the engine retry', () => {
    const { a } = make()
    a.start()
    expect(a.stepEnd({ stopReason: 'refusal', usage: usage(100, 0), toolUseIds: [] })).toEqual({ kind: 'continue' })
    a.text(0, 'Fine.')
    expect(a.stepEnd({ stopReason: 'end_turn', usage: usage(120, 2), toolUseIds: [] })).toEqual({ kind: 'done', stopReason: 'end_turn' })
    expect(a.message().content).toEqual([{ type: 'text', text: 'Fine.' }])
  })

  test('a refusal the engine does not retry ends the message at turn end', () => {
    const { a } = make()
    a.start()
    a.stepEnd({ stopReason: 'refusal', usage: usage(100, 0), toolUseIds: [] })
    a.finish('refusal')
    expect(a.message().stop_reason).toBe('refusal')
  })

  test('fail emits an error event and finishes', () => {
    const { a, events } = make()
    a.start()
    a.fail('overloaded_error', 'busy')
    expect(events.at(-1)).toEqual({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } })
    expect(a.isFinished).toBe(true)
  })
})

describe('encodeSse', () => {
  test('writes the event name and a JSON data line', () => {
    expect(encodeSse({ type: 'ping' })).toBe('event: ping\ndata: {"type":"ping"}\n\n')
  })
})
