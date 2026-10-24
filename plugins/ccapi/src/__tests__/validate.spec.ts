import { describe, expect, test } from 'bun:test'
import { parseMessagesRequest } from '../validate.ts'

const ok = { model: 'claude-haiku-4-5-20251001', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }

describe('parseMessagesRequest', () => {
  test('accepts a minimal request', () => {
    expect(parseMessagesRequest(ok).model).toBe('claude-haiku-4-5-20251001')
  })

  test('accepts tools, tool_choice, system blocks and stop sequences', () => {
    const req = parseMessagesRequest({
      ...ok,
      system: [{ type: 'text', text: 'be brief' }],
      tools: [{ name: 'get_weather', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'get_weather' },
      stop_sequences: ['END'],
      stream: true,
    })
    expect(req.tools?.[0]?.name).toBe('get_weather')
  })

  const rejects: Array<[string, unknown, string]> = [
    ['non-object body', 'x', 'JSON object'],
    ['missing model', { ...ok, model: '' }, 'model'],
    ['bad max_tokens', { ...ok, max_tokens: 0 }, 'max_tokens'],
    ['empty messages', { ...ok, messages: [] }, 'messages'],
    ['bad role', { ...ok, messages: [{ role: 'system', content: 'x' }] }, 'role'],
    ['unsupported block', { ...ok, messages: [{ role: 'user', content: [{ type: 'search_result' }] }] }, 'not supported'],
    [
      'image by URL',
      { ...ok, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x' } }] }] },
      'URL sources',
    ],
    ['server tool', { ...ok, tools: [{ type: 'web_search_20250305', name: 'web_search' }] }, 'server tools'],
    ['tool without schema', { ...ok, tools: [{ name: 't' }] }, 'input_schema'],
    ['tool_choice tool without name', { ...ok, tool_choice: { type: 'tool' } }, 'tool_choice.name'],
    ['empty stop sequence', { ...ok, stop_sequences: [''] }, 'stop_sequences'],
  ]
  for (const [name, body, message] of rejects) {
    test(`rejects ${name}`, () => {
      expect(() => parseMessagesRequest(body)).toThrow(message)
    })
  }
})
