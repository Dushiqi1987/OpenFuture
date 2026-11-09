/**
 * Dependency- and slot-aware scheduler.
 *
 * A waiting task is "parked": its execution slot is released so a different
 * ready task (for example the researcher it is waiting for) can run. Resuming
 * a parked task takes a slot again and may have to queue behind other work.
 */

import { TeamError } from './errors.ts'
import {
  MAX_PARALLEL_WORKERS,
  isDependencySatisfied,
  type TaskState
} from './types.ts'

export interface SchedulerTask {
  id: string
  dependsOn: string[]
}

export class Scheduler {
  readonly maxConcurrency: number
  private readonly deps = new Map<string, string[]>()
  private readonly running = new Set<string>()
  private readonly parked = new Set<string>()
  private readonly finished = new Set<string>()
  private readonly resumeQueue: string[] = []

  constructor(tasks: readonly SchedulerTask[], maxConcurrency: number, finished: readonly string[] = []) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new TeamError('scheduler-invalid', 'maxConcurrency must be a positive integer')
    }
    this.maxConcurrency = Math.min(maxConcurrency, MAX_PARALLEL_WORKERS)
    for (const task of tasks) {
      this.deps.set(task.id, [...task.dependsOn])
    }
    for (const taskId of finished) {
      if (this.deps.has(taskId)) this.finished.add(taskId)
    }
  }

  get activeCount(): number {
    return this.running.size
  }

  get freeSlots(): number {
    return Math.max(0, this.maxConcurrency - this.running.size)
  }

  get runningIds(): string[] {
    return [...this.running]
  }

  get parkedIds(): string[] {
    return [...this.parked]
  }

  get queuedResumeIds(): string[] {
    return [...this.resumeQueue]
  }

  get finishedIds(): string[] {
    return [...this.finished]
  }

  isRunning(taskId: string): boolean {
    return this.running.has(taskId)
  }

  isParked(taskId: string): boolean {
    return this.parked.has(taskId)
  }

  isFinished(taskId: string): boolean {
    return this.finished.has(taskId)
  }

  readyIds(states: ReadonlyMap<string, TaskState>): string[] {
    const ready: string[] = []
    for (const [taskId, dependencies] of this.deps) {
      if (this.running.has(taskId) || this.parked.has(taskId) || this.finished.has(taskId)) continue
      const state = states.get(taskId)
      if (state !== 'planned' && state !== 'ready') continue
      if (dependencies.every((dependency) => isDependencySatisfied(states.get(dependency) ?? 'planned'))) {
        ready.push(taskId)
      }
    }
    return ready
  }

  blockedIds(states: ReadonlyMap<string, TaskState>): string[] {
    const blocked: string[] = []
    for (const [taskId, dependencies] of this.deps) {
      if (this.running.has(taskId) || this.parked.has(taskId) || this.finished.has(taskId)) continue
      const state = states.get(taskId)
      if (state !== 'planned' && state !== 'ready') continue
      if (dependencies.some((dependency) => {
        const dependencyState = states.get(dependency)
        return dependencyState === 'failed' || dependencyState === 'cancelled'
      })) {
        blocked.push(taskId)
      }
    }
    return blocked
  }

  start(taskId: string): void {
    if (!this.deps.has(taskId)) throw new TeamError('unknown-task', `scheduler has no task ${taskId}`)
    if (this.running.has(taskId)) throw new TeamError('scheduler-already-running', `task ${taskId} is already running`)
    if (this.parked.has(taskId)) throw new TeamError('scheduler-parked', `task ${taskId} is parked`)
    if (this.finished.has(taskId)) throw new TeamError('scheduler-finished', `task ${taskId} already finished`)
    if (this.freeSlots <= 0) {
      throw new TeamError('scheduler-no-slot', `cannot start ${taskId}: ${this.maxConcurrency} slots busy`)
    }
    this.running.add(taskId)
  }

  /** Release a slot after a retryable failure; the task can be dispatched again. */
  release(taskId: string): string[] {
    this.running.delete(taskId)
    this.parked.delete(taskId)
    return this.takePromotable()
  }

  /** Release a slot and mark the task terminal. */
  finish(taskId: string): string[] {
    this.running.delete(taskId)
    this.parked.delete(taskId)
    this.finished.add(taskId)
    return this.takePromotable()
  }

  /** Give up a slot while waiting for inbox input. */
  park(taskId: string): string[] {
    if (!this.running.has(taskId)) {
      throw new TeamError('scheduler-not-running', `cannot park ${taskId}: it does not hold a slot`)
    }
    this.running.delete(taskId)
    this.parked.add(taskId)
    return this.takePromotable()
  }

  /**
   * Try to resume a parked task. Returns true when it immediately holds a slot;
   * false when it was queued (or was not parked).
   */
  requestResume(taskId: string): boolean {
    if (!this.parked.has(taskId)) return false
    this.parked.delete(taskId)
    if (this.freeSlots > 0) {
      this.running.add(taskId)
      return true
    }
    this.resumeQueue.push(taskId)
    return false
  }

  /** Hand out slots to queued resumes after a slot became free. */
  takePromotable(): string[] {
    const promoted: string[] = []
    while (this.freeSlots > 0 && this.resumeQueue.length > 0) {
      const taskId = this.resumeQueue.shift()
      if (!taskId) break
      if (this.finished.has(taskId)) continue
      this.running.add(taskId)
      promoted.push(taskId)
    }
    return promoted
  }

  cancelQueuedResume(taskId: string): boolean {
    const index = this.resumeQueue.indexOf(taskId)
    if (index === -1) return false
    this.resumeQueue.splice(index, 1)
    this.parked.delete(taskId)
    return true
  }

  dependentsOf(taskId: string): string[] {
    const dependents: string[] = []
    for (const [candidate, dependencies] of this.deps) {
      if (dependencies.includes(taskId)) dependents.push(candidate)
    }
    return dependents
  }

  downstreamOf(taskId: string): string[] {
    const seen = new Set<string>()
    const queue = this.dependentsOf(taskId)
    while (queue.length > 0) {
      const current = queue.shift()
      if (!current || seen.has(current)) continue
      seen.add(current)
      queue.push(...this.dependentsOf(current))
    }
    return [...seen]
  }

  dependencyIds(taskId: string): string[] {
    return [...(this.deps.get(taskId) ?? [])]
  }

  get taskIds(): string[] {
    return [...this.deps.keys()]
  }
}
