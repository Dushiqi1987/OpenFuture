import type { IpcErrorCode } from '../shared/protocol'

export class AppError extends Error {
  readonly code: IpcErrorCode

  constructor(code: IpcErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AppError'
    this.code = code
  }
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function toErrorCode(error: unknown): IpcErrorCode {
  return error instanceof AppError ? error.code : 'INTERNAL'
}
