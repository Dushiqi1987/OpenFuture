/**
 * Small dependency-free infrastructure helpers. Everything here is built on
 * Node built-ins so the prototype runs from a source checkout without an
 * install step (Node 22.19+ can execute the TypeScript sources directly).
 */

import { createHash, randomUUID } from 'node:crypto'
import { abortError } from './errors.ts'

export interface Clock {
  now(): number
}

export const systemClock: Clock = {
  now: () => Date.now()
}

export function createManualClock(start = 1_000_000): Clock & { advance(ms: number): void } {
  let current = start
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal))
      return
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError(signal))
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
  })
}

export class Deferred<T> {
  readonly promise: Promise<T>
  private resolveFn!: (value: T | PromiseLike<T>) => void
  private rejectFn!: (reason?: unknown) => void
  settled = false

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolveFn = resolve
      this.rejectFn = reject
    })
  }

  resolve(value: T): void {
    if (this.settled) return
    this.settled = true
    this.resolveFn(value)
  }

  reject(reason: unknown): void {
    if (this.settled) return
    this.settled = true
    this.rejectFn(reason)
  }
}

interface SemaphoreWaiter {
  resolve: () => void
  reject: (reason: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
}

/**
 * FIFO counting semaphore with abort support. The scheduler releases the
 * permit before a task waits for a peer reply.
 */
export class Semaphore {
  private available: number
  private readonly capacity: number
  private readonly waiters: SemaphoreWaiter[] = []

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new Error(`semaphore permits must be a positive integer, got ${permits}`)
    }
    this.capacity = permits
    this.available = permits
  }

  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError(signal))
    if (this.available > 0 && this.waiters.length === 0) {
      this.available -= 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: SemaphoreWaiter = { resolve, reject, signal }
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(abortError(signal))
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.waiters.push(waiter)
    })
  }

  release(): void {
    const next = this.waiters.shift()
    if (!next) {
      if (this.available < this.capacity) this.available += 1
      return
    }
    if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort)
    next.resolve()
  }

  get active(): number {
    return this.capacity - this.available
  }

  get queued(): number {
    return this.waiters.length
  }
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) sorted[key] = sortValue(record[key])
    return sorted
  }
  return value
}

export interface IdFactory {
  run(): string
  plan(): string
  task(seed: string): string
  agent(taskId: string): string
  message(): string
  artifact(content: string): string
}

export function createIdFactory(prefix = 'of'): IdFactory {
  const nonce = randomUUID().replaceAll('-', '').slice(0, 8)
  let counter = 0
  const next = (kind: string): string => {
    counter += 1
    return `${prefix}-${kind}-${nonce}-${counter.toString(36)}`
  }
  return {
    run: () => next('run'),
    plan: () => next('plan'),
    task: (seed) => next(`task-${seed}`),
    agent: (taskId) => `agent-${taskId}`,
    message: () => next('msg'),
    artifact: (content) => `sha256:${sha256Hex(content)}`
  }
}

/** Deterministic ids for fixtures and assertions. */
export function createSequentialIdFactory(prefix = 'test'): IdFactory {
  let counter = 0
  const next = (kind: string): string => {
    counter += 1
    return `${prefix}-${kind}-${counter}`
  }
  return {
    run: () => next('run'),
    plan: () => next('plan'),
    task: (seed) => `task-${seed}`,
    agent: (taskId) => `agent-${taskId}`,
    message: () => next('msg'),
    artifact: (content) => `sha256:${sha256Hex(content)}`
  }
}

export function normalizePosixPath(input: string): string {
  const slashed = input.replaceAll('\\', '/')
  const parts: string[] = []
  for (const part of slashed.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) throw new Error(`path escapes root: ${input}`)
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return parts.join('/')
}

export function shortHash(value: string, length = 8): string {
  return sha256Hex(value).slice(0, length)
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

export function intersection<T>(left: readonly T[], right: readonly T[]): T[] {
  const rightSet = new Set(right)
  return left.filter((value) => rightSet.has(value))
}
