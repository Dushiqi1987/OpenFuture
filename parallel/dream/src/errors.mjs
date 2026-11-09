/**
 * Dreaming worker error contract.
 *
 * Every failure surfaced to the main-line adapter is a DreamError with a
 * stable machine-readable code. Adapters must map this code into the shared
 * IpcErrorCode vocabulary; they must not forward raw messages from documents
 * or model output.
 */

export const RETRYABLE_CODES = new Set([
  'MODEL_UNAVAILABLE',
  'MODEL_TIMEOUT',
  'STORE_IO'
])

export const ERROR_CODES = Object.freeze({
  VALIDATION: 'VALIDATION',
  POLICY_UNAVAILABLE: 'POLICY_UNAVAILABLE',
  SESSION_UNAUTHORIZED: 'SESSION_UNAUTHORIZED',
  SESSION_INCOMPLETE: 'SESSION_INCOMPLETE',
  PROJECT_MISMATCH: 'PROJECT_MISMATCH',
  EVIDENCE_UNKNOWN: 'EVIDENCE_UNKNOWN',
  EVIDENCE_STALE: 'EVIDENCE_STALE',
  EVIDENCE_REVOKED: 'EVIDENCE_REVOKED',
  EVIDENCE_INACTIVE: 'EVIDENCE_INACTIVE',
  QUOTE_MISMATCH: 'QUOTE_MISMATCH',
  EVIDENCE_BASIS_MISMATCH: 'EVIDENCE_BASIS_MISMATCH',
  CANDIDATE_INVALID: 'CANDIDATE_INVALID',
  OP_INVALID: 'OP_INVALID',
  TARGET_UNKNOWN: 'TARGET_UNKNOWN',
  REVISION_CONFLICT: 'REVISION_CONFLICT',
  CONFLICT_UNRESOLVED: 'CONFLICT_UNRESOLVED',
  DELETE_RATIO: 'DELETE_RATIO',
  DUPLICATE_ENTRY: 'DUPLICATE_ENTRY',
  INJECTION_BLOCKED: 'INJECTION_BLOCKED',
  L3_BUDGET: 'L3_BUDGET',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  PLAN_CHECK_FAILED: 'PLAN_CHECK_FAILED',
  PLAN_STALE: 'PLAN_STALE',
  NO_EFFECTIVE_OPS: 'NO_EFFECTIVE_OPS',
  PUBLISH_CONFLICT: 'PUBLISH_CONFLICT',
  PUBLISH_IDEMPOTENT_MISMATCH: 'PUBLISH_IDEMPOTENT_MISMATCH',
  VERSION_NOT_FOUND: 'VERSION_NOT_FOUND',
  VERSION_ALREADY_ACTIVE: 'VERSION_ALREADY_ACTIVE',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  MODEL_TIMEOUT: 'MODEL_TIMEOUT',
  MODEL_OUTPUT_INVALID: 'MODEL_OUTPUT_INVALID',
  RETRY_EXHAUSTED: 'RETRY_EXHAUSTED',
  CANCELLED: 'CANCELLED',
  JOB_NOT_FOUND: 'JOB_NOT_FOUND',
  JOB_STATE: 'JOB_STATE',
  STORE_IO: 'STORE_IO'
})

export class DreamError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{details?: unknown, retryable?: boolean, cause?: unknown}} [options]
   */
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'DreamError'
    this.code = code
    this.details = options.details ?? null
    this.retryable = options.retryable ?? RETRYABLE_CODES.has(code)
    if (options.cause !== undefined) this.cause = options.cause
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.details
    }
  }
}

/** @param {unknown} error @param {string} [code] */
export function isDreamError(error, code) {
  return error instanceof DreamError && (code === undefined || error.code === code)
}

export function isRetryable(error) {
  return error instanceof DreamError && error.retryable === true
}

export function assert(condition, code, message, details) {
  if (!condition) throw new DreamError(code, message, { details })
}

/** Convert any thrown value into a public, JSON-safe shape. */
export function toPublicError(error) {
  if (error instanceof DreamError) return error.toJSON()
  return {
    name: 'DreamError',
    code: 'VALIDATION',
    message: 'Unexpected dreaming worker failure',
    retryable: false,
    details: null
  }
}
