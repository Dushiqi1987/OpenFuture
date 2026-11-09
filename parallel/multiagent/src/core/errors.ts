/**
 * Error taxonomy for the multi-agent prototype.
 *
 * Every rejection that crosses a module boundary is a TeamError with a stable
 * machine code so the scheduler, inbox and acceptance tests can branch on it
 * without string matching.
 */

export class TeamError extends Error {
  readonly code: string
  readonly details: Record<string, unknown> | undefined

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'TeamError'
    this.code = code
    this.details = details
  }
}

export class TaskFailureError extends TeamError {
  readonly retryable: boolean
  readonly retryAfterMs: number | undefined

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; retryAfterMs?: number; details?: Record<string, unknown> } = {}
  ) {
    super(code, message, options.details)
    this.name = 'TaskFailureError'
    this.retryable = options.retryable ?? false
    this.retryAfterMs = options.retryAfterMs
  }
}

export function isTeamError(value: unknown): value is TeamError {
  return value instanceof TeamError
}

export function errorCode(value: unknown, fallback = 'internal'): string {
  if (value instanceof TeamError) return value.code
  if (value instanceof Error && value.name === 'AbortError') return 'aborted'
  return fallback
}

export function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  return 'unknown error'
}

export function toTaskFailure(value: unknown): TaskFailureError {
  if (value instanceof TaskFailureError) return value
  if (value instanceof TeamError) {
    return new TaskFailureError(value.code, value.message, { details: value.details })
  }
  return new TaskFailureError('internal', errorMessage(value))
}

export function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  const error = new Error('operation aborted')
  error.name = 'AbortError'
  return error
}
