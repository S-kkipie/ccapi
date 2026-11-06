import { describe, expect, test } from 'bun:test'
import { canonicalConversation } from '../conversation-key.ts'

const system = 'You are terse.'
const tools = [{ name: 'get_weather', input_schema: { type: 'object' } }]
const turn1 = [{ role: 'user' as const, content: 'Weather in Lima?' }]
const reply1 = { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Sunny, 22°C.' }] }

describe('canonicalConversation', () => {
  test('a history plus its reply keys the same as the next request without its new message', () => {
    const after = canonicalConversation(system, tools, [...turn1, reply1])
    const next = [...turn1, reply1, { role: 'user' as const, content: 'And tomorrow?' }]
    expect(canonicalConversation(system, tools, next.slice(0, -1))).toBe(after)
  })

  test('string content and a single text block are the same message', () => {
    expect(canonicalConversation(system, tools, turn1)).toBe(
      canonicalConversation(system, tools, [{ role: 'user', content: [{ type: 'text', text: 'Weather in Lima?' }] }]),
    )
  })

  test('thinking blocks a client sends back or drops do not change the key', () => {
    const withThinking = {
      role: 'assistant' as const,
      content: [{ type: 'thinking' as const, thinking: 'hmm', signature: 's' }, ...reply1.content],
    }
    expect(canonicalConversation(system, tools, [...turn1, withThinking])).toBe(canonicalConversation(system, tools, [...turn1, reply1]))
  })

  test('tool input key order does not change the key', () => {
    const a = { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 't1', name: 'x', input: { a: 1, b: 2 } }] }
    const b = { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 't1', name: 'x', input: { b: 2, a: 1 } }] }
    expect(canonicalConversation(system, tools, [...turn1, a])).toBe(canonicalConversation(system, tools, [...turn1, b]))
  })

  test('an edited earlier message, another system prompt or other tools are another conversation', () => {
    const base = canonicalConversation(system, tools, [...turn1, reply1])
    expect(canonicalConversation(system, tools, [{ role: 'user', content: 'Weather in Cusco?' }, reply1])).not.toBe(base)
    expect(canonicalConversation('You are chatty.', tools, [...turn1, reply1])).not.toBe(base)
    expect(canonicalConversation(system, [], [...turn1, reply1])).not.toBe(base)
  })
})
