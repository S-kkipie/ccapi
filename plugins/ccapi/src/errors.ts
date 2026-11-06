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
  // Sent as retry-after when set.
  readonly retryAfterSeconds: number | undefined

  constructor(status: number, type: ApiErrorType, message: string, retryAfterSeconds?: number) {
    super(message)
    this.status = status
    this.type = type
    this.retryAfterSeconds = retryAfterSeconds
  }
}

// A plan usage window as Claude Code reports it: five_hour, seven_day, or a gateway's spend_limit.
export type PlanWindow = { kind: string; percentUsed: number; resetsAt: string }

export const errorBody = (err: ApiError) => ({ type: 'error' as const, error: { type: err.type, message: err.message } })

export const toApiError = (err: unknown): ApiError =>
  err instanceof ApiError ? err : new ApiError(500, 'api_error', err instanceof Error ? err.message : String(err))

// A failed model call while a plan window is used up is that limit, not an overload: say which window
// and when it resets, as a 429 a client can wait out instead of retrying into it.
export const upstreamError = (reason: 'error' | 'aborted', limits: readonly PlanWindow[] = []): ApiError => {
  if (reason === 'aborted') return new ApiError(500, 'api_error', 'The Claude Code subagent was interrupted')
  const spent = limits.filter(w => w.percentUsed >= 100).sort((a, b) => b.resetsAt.localeCompare(a.resetsAt))[0]
  if (spent) {
    const wait = Math.max(1, Math.ceil((Date.parse(spent.resetsAt) - Date.now()) / 1000))
    return new ApiError(
      429,
      'rate_limit_error',
      `The Claude plan's ${spent.kind} usage limit is used up; it resets at ${spent.resetsAt}`,
      Number.isFinite(wait) ? wait : 60,
    )
  }
  return new ApiError(
    529,
    'overloaded_error',
    'The Claude Code session could not complete the model call (plan rate limit, overload or API error); retry later',
  )
}
