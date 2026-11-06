import { describe, expect, test } from 'bun:test'
import { ApiError, errorBody, toApiError, upstreamError } from '../errors.ts'

describe('errors', () => {
  test('errorBody uses the Anthropic error envelope', () => {
    expect(errorBody(new ApiError(400, 'invalid_request_error', 'bad'))).toEqual({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'bad' },
    })
  })

  test('toApiError keeps an ApiError as it is', () => {
    const err = new ApiError(429, 'rate_limit_error', 'slow down')
    expect(toApiError(err)).toBe(err)
  })

  test('toApiError wraps anything else as a 500 api_error', () => {
    const err = toApiError(new Error('boom'))
    expect([err.status, err.type, err.message]).toEqual([500, 'api_error', 'boom'])
  })

  test('an upstream model failure maps to 529 overloaded_error', () => {
    const err = upstreamError('error')
    expect([err.status, err.type]).toEqual([529, 'overloaded_error'])
  })

  test('an interrupted subagent maps to 500 api_error', () => {
    expect(upstreamError('aborted').status).toBe(500)
  })

  test('a failure with a plan window used up is a 429 that names the window and its reset', () => {
    const err = upstreamError('error', [
      { kind: 'five_hour', percentUsed: 12, resetsAt: '2026-11-07T01:30:00Z' },
      { kind: 'seven_day', percentUsed: 100, resetsAt: '2026-11-13T20:00:00Z' },
    ])
    expect([err.status, err.type]).toEqual([429, 'rate_limit_error'])
    expect(err.message).toContain('seven_day')
    expect(err.message).toContain('2026-11-13T20:00:00Z')
    expect(err.retryAfterSeconds).toBeGreaterThan(0)
  })

  test('a failure with every window below its limit stays a 529', () => {
    const err = upstreamError('error', [{ kind: 'seven_day', percentUsed: 40, resetsAt: '2026-11-13T20:00:00Z' }])
    expect([err.status, err.type]).toEqual([529, 'overloaded_error'])
  })
})
