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
})
