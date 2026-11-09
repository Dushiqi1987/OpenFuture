/**
 * Durable run state.
 *
 * The first release keeps one JSON snapshot per run. Every state transition
 * goes through RunStore so a crash cannot leave the inbox or board ahead of the
 * persisted task states. The API is intentionally narrow enough to swap the
 * file for SQLite in the desktop app later.
 */

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { TeamError } from './errors.ts'
import type {
  ArtifactRef,
  InboxMessage,
  IntegrationReport,
  Plan,
  ProjectPolicy,
  RunEvent,
  RunEventType,
  RunStatus,
  TaskRecord
} from './types.ts'
import { systemClock, type Clock } from './util.ts'

export const RUN_SCHEMA_VERSION = '1.0'
export const RUNTIME_DIR = '.runtime'

export interface RunMeta {
  runId: string
  projectId: string
  planId: string
  mainGoal: string
  baseRevision: string
  status: RunStatus
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  stopReason?: string
}

export interface RunSnapshot {
  schemaVersion: typeof RUN_SCHEMA_VERSION
  run: RunMeta
  plan: Plan
  tasks: TaskRecord[]
  artifacts: ArtifactRef[]
  messages: InboxMessage[]
  events: RunEvent[]
  integration?: IntegrationReport
  updatedAt: number
}

export interface RunStoreOptions {
  clock?: Clock
}

function assertRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(runId) || runId.includes('..')) {
    throw new TeamError('run-id-invalid', `run id ${JSON.stringify(runId)} is not filesystem safe`)
  }
}

export class RunStore {
  readonly project: ProjectPolicy
  readonly snapshot: RunSnapshot
  private readonly clock: Clock
  private dirty = false

  private constructor(project: ProjectPolicy, snapshot: RunSnapshot, options: RunStoreOptions = {}) {
    this.project = project
    this.snapshot = snapshot
    this.clock = options.clock ?? systemClock
  }

  static runsRoot(project: ProjectPolicy): string {
    return path.resolve(project.rootPath, RUNTIME_DIR, 'runs')
  }

  static runDir(project: ProjectPolicy, runId: string): string {
    assertRunId(runId)
    return path.join(RunStore.runsRoot(project), runId)
  }

  static statePath(project: ProjectPolicy, runId: string): string {
    return path.join(RunStore.runDir(project, runId), 'snapshot.json')
  }

  static async create(
    project: ProjectPolicy,
    plan: Plan,
    tasks: TaskRecord[],
    options: RunStoreOptions = {}
  ): Promise<RunStore> {
    if (plan.projectId !== project.projectId) {
      throw new TeamError('project-mismatch', 'cannot create a run for a plan from another project')
    }
    const clock = options.clock ?? systemClock
    const now = clock.now()
    const baseRevision = plan.tasks[0]?.baseRevision ?? project.baseRevision
    const snapshot: RunSnapshot = {
      schemaVersion: RUN_SCHEMA_VERSION,
      run: {
        runId: plan.runId,
        projectId: project.projectId,
        planId: plan.planId,
        mainGoal: plan.mainGoal,
        baseRevision,
        status: 'created',
        createdAt: now,
        updatedAt: now
      },
      plan,
      tasks,
      artifacts: [],
      messages: [],
      events: [],
      updatedAt: now
    }
    const store = new RunStore(project, snapshot, options)
    store.emit('run.created', undefined, {
      planId: plan.planId,
      tasks: tasks.length,
      baseRevision
    })
    await store.flush()
    return store
  }

  static async open(project: ProjectPolicy, runId: string, options: RunStoreOptions = {}): Promise<RunStore> {
    const statePath = RunStore.statePath(project, runId)
    let raw: string
    try {
      raw = await readFile(statePath, 'utf8')
    } catch (readError) {
      const code = (readError as NodeJS.ErrnoException).code
      throw new TeamError(
        code === 'ENOENT' ? 'run-not-found' : 'run-unreadable',
        `cannot open run ${runId}: ${readError instanceof Error ? readError.message : String(readError)}`
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (parseError) {
      throw new TeamError('run-snapshot-corrupt', `run ${runId} snapshot is not valid JSON`, {
        cause: parseError instanceof Error ? parseError.message : String(parseError)
      })
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new TeamError('run-snapshot-corrupt', `run ${runId} snapshot is not an object`)
    }
    const snapshot = parsed as RunSnapshot
    if (snapshot.schemaVersion !== RUN_SCHEMA_VERSION) {
      throw new TeamError('run-snapshot-version', `run ${runId} has unsupported schema ${String(snapshot.schemaVersion)}`)
    }
    if (!snapshot.run || snapshot.run.runId !== runId || snapshot.run.projectId !== project.projectId) {
      throw new TeamError('run-snapshot-corrupt', `run ${runId} snapshot identity mismatch`)
    }
    if (!snapshot.plan || !Array.isArray(snapshot.tasks) || !Array.isArray(snapshot.messages)) {
      throw new TeamError('run-snapshot-corrupt', `run ${runId} snapshot is missing plan/tasks/messages`)
    }
    if (!Array.isArray(snapshot.artifacts)) snapshot.artifacts = []
    if (!Array.isArray(snapshot.events)) snapshot.events = []
    return new RunStore(project, snapshot, options)
  }

  static async list(project: ProjectPolicy): Promise<RunMeta[]> {
    const root = RunStore.runsRoot(project)
    let entries: string[]
    try {
      entries = await readdir(root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const metas: RunMeta[] = []
    for (const entry of entries) {
      try {
        const raw = await readFile(path.join(root, entry, 'snapshot.json'), 'utf8')
        const parsed = JSON.parse(raw) as RunSnapshot
        if (parsed?.run?.runId) metas.push(parsed.run)
      } catch {
        // A partially written or foreign directory is ignored by the listing;
        // opening it directly still reports the precise error.
      }
    }
    return metas.sort((left, right) => right.updatedAt - left.updatedAt)
  }

  get run(): RunMeta {
    return this.snapshot.run
  }

  get plan(): Plan {
    return this.snapshot.plan
  }

  get tasks(): TaskRecord[] {
    return this.snapshot.tasks
  }

  get events(): RunEvent[] {
    return this.snapshot.events
  }

  task(taskId: string): TaskRecord {
    const task = this.snapshot.tasks.find((candidate) => candidate.id === taskId)
    if (!task) throw new TeamError('unknown-task', `run ${this.run.runId} has no task ${taskId}`)
    return task
  }

  findTask(taskId: string): TaskRecord | undefined {
    return this.snapshot.tasks.find((candidate) => candidate.id === taskId)
  }

  updateTask(taskId: string, patch: Partial<TaskRecord>): TaskRecord {
    const task = this.task(taskId)
    Object.assign(task, patch)
    this.markDirty()
    return task
  }

  setRunStatus(status: RunStatus, patch: Partial<RunMeta> = {}): void {
    this.snapshot.run.status = status
    Object.assign(this.snapshot.run, patch)
    this.markDirty()
  }

  addArtifact(ref: ArtifactRef): void {
    if (this.snapshot.artifacts.some((candidate) => candidate.id === ref.id)) {
      throw new TeamError('artifact-duplicate', `artifact ${ref.id} already exists`)
    }
    this.snapshot.artifacts.push(ref)
    this.markDirty()
  }

  addMessage(message: InboxMessage): void {
    this.snapshot.messages.push(message)
    this.markDirty()
  }

  updateMessage(messageId: string, patch: Partial<InboxMessage>): void {
    const message = this.snapshot.messages.find((candidate) => candidate.id === messageId)
    if (!message) throw new TeamError('inbox-unknown-message', `message ${messageId} does not exist`)
    Object.assign(message, patch)
    this.markDirty()
  }

  setIntegration(report: IntegrationReport): void {
    this.snapshot.integration = report
    this.markDirty()
  }

  emit(type: RunEventType, taskId: string | undefined, payload: Record<string, unknown> = {}): RunEvent {
    const last = this.snapshot.events[this.snapshot.events.length - 1]
    const event: RunEvent = {
      schemaVersion: '1.0',
      seq: (last?.seq ?? 0) + 1,
      runId: this.run.runId,
      projectId: this.run.projectId,
      at: this.clock.now(),
      type,
      ...(taskId ? { taskId } : {}),
      payload
    }
    this.snapshot.events.push(event)
    this.markDirty()
    return event
  }

  private markDirty(): void {
    const now = this.clock.now()
    this.snapshot.updatedAt = now
    this.snapshot.run.updatedAt = now
    this.dirty = true
  }

  get hasPendingChanges(): boolean {
    return this.dirty
  }

  async flush(): Promise<void> {
    if (!this.dirty) return
    const directory = RunStore.runDir(this.project, this.run.runId)
    await mkdir(directory, { recursive: true })
    const target = path.join(directory, 'snapshot.json')
    const temporary = path.join(directory, `snapshot.json.tmp-${process.pid}-${Date.now()}`)
    await writeFile(temporary, `${JSON.stringify(this.snapshot, null, 2)}\n`, 'utf8')
    await rename(temporary, target)
    this.dirty = false
  }
}

export function findTaskOrThrow(store: RunStore, taskId: string): TaskRecord {
  return store.task(taskId)
}
