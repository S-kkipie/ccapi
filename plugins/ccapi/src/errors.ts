export type ApiErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'rate_limit_error'
  | 'api_error'
  | 'overloaded_error'

export class ApiError extends Error {
  readonly status: number
  readonly type: ApiErrorType

  constructor(status: number, type: ApiErrorType, message: string) {
    super(message)
    this.status = status
    this.type = type
  }
}

export const errorBody = (err: ApiError) => ({ type: 'error' as const, error: { type: err.type, message: err.message } })

export const toApiError = (err: unknown): ApiError =>
  err instanceof ApiError ? err : new ApiError(500, 'api_error', err instanceof Error ? err.message : String(err))

export const upstreamError = (reason: 'error' | 'aborted'): ApiError =>
  reason === 'aborted'
    ? new ApiError(500, 'api_error', 'The Claude Code subagent was interrupted')
    : new ApiError(
        529,
        'overloaded_error',
        'The Claude Code session could not complete the model call (plan rate limit, overload or API error); retry later',
      )
