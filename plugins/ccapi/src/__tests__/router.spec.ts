import { describe, expect, test } from 'bun:test'
import type { Message } from '../api.ts'
import { routeRequest } from '../router.ts'
import { shouldScrub } from '../scrub.ts'
import { toEngineToolResult } from '../tool-results.ts'

const png = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'AAAA' } }
const parkedOnly = (convId: string, parked: string[]) => (ids: readonly string[]) =>
  ids.some(id => parked.includes(id)) ? { convId, parked } : undefined

describe('toEngineToolResult', () => {
  test('text content becomes a string', () => {
    expect(toEngineToolResult({ type: 'tool_result', tool_use_id: 't', content: '22C' })).toEqual({ result: '22C' })
    expect(toEngineToolResult({ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toEqual({ result: 'a\nb' })
  })
  test('an empty result is never an empty string', () => {
    expect(toEngineToolResult({ type: 'tool_result', tool_use_id: 't' })).toEqual({ result: '(empty result)' })
  })
  test('media content becomes an array of blocks', () => {
    expect(toEngineToolResult({ type: 'tool_result', tool_use_id: 't', content: [png] })).toEqual({ result: [png] })
  })
  test('is_error becomes a deny', () => {
    expect(toEngineToolResult({ type: 'tool_result', tool_use_id: 't', content: 'not found', is_error: true })).toEqual({ deny: 'not found' })
  })
})

describe('routeRequest', () => {
  const history: Message[] = [
    { role: 'user', content: 'weather?' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} }] },
  ]

  test('a plain user message is a fresh request', () => {
    expect(routeRequest({ messages: [{ role: 'user', content: 'hi' }] }, parkedOnly('c1', ['toolu_1']))).toEqual({ kind: 'fresh' })
  })

  test('tool results for parked calls continue that conversation', () => {
    const route = routeRequest(
      { messages: [...history, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '22C' }] }] },
      parkedOnly('c1', ['toolu_1']),
    )
    expect(route).toEqual({ kind: 'continue', convId: 'c1', results: [['toolu_1', { result: '22C' }]] })
  })

  test('tool results nobody waits for start a fresh request', () => {
    const route = routeRequest(
      { messages: [...history, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: '22C' }] }] },
      parkedOnly('c1', ['toolu_1']),
    )
    expect(route).toEqual({ kind: 'fresh' })
  })

  test('parked calls without a result get a deny', () => {
    const route = routeRequest(
      { messages: [...history, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a' }] }] },
      parkedOnly('c1', ['toolu_1', 'toolu_2']),
    )
    expect(route).toEqual({
      kind: 'continue',
      convId: 'c1',
      results: [
        ['toolu_1', { result: 'a' }],
        ['toolu_2', { deny: 'no result provided by client' }],
      ],
    })
  })

  test('extra blocks beside the tool results ride on the last result', () => {
    const route = routeRequest(
      {
        messages: [
          ...history,
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a' }, { type: 'text', text: 'also this' }] },
        ],
      },
      parkedOnly('c1', ['toolu_1']),
    )
    expect(route).toEqual({ kind: 'continue', convId: 'c1', results: [['toolu_1', { result: 'a\n\nalso this' }]] })
  })
})

describe('shouldScrub', () => {
  test('only attachment rows are scrubbed', () => {
    expect(shouldScrub('attachment')).toBe(true)
    expect(shouldScrub('user')).toBe(false)
    expect(shouldScrub('assistant')).toBe(false)
  })
})
