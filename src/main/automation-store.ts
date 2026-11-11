import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AutomationRun,
  AutomationScheduleKind,
  AutomationTask,
  CreateAutomationInput,
  UpdateAutomationInput
} from '../shared/protocol'
import { AppError } from './errors'

interface AutomationFile {
  version: 1
  tasks: AutomationTask[]
  runs: AutomationRun[]
}

const MAX_RUNS = 500
const RUNS_PER_TASK = 40

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cleanText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new AppError('VALIDATION', `${field}不能为空`)
  const text = value.trim()
  if (!text) throw new AppError('VALIDATION', `${field}不能为空`)
  if (text.length > max) throw new AppError('VALIDATION', `${field}过长`)
  return text
}

function parseTimeOfDay(value: unknown): string {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new AppError('VALIDATION', '执行时间必须是 HH:mm')
  }
  return value
}

function parseWeekday(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 6) {
    throw new AppError('VALIDATION', '星期必须是 0–6')
  }
  return value
}

function localDay(base: Date): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate())
}

function nextDaily(after: Date, timeOfDay: string): Date {
  const [hourText = '0', minuteText = '0'] = timeOfDay.split(':')
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const candidate = localDay(after)
  candidate.setHours(hour, minute, 0, 0)
  if (candidate.getTime() <= after.getTime()) candidate.setDate(candidate.getDate() + 1)
  return candidate
}

function nextWeekly(after: Date, weekday: number, timeOfDay: string): Date {
  const [hourText = '0', minuteText = '0'] = timeOfDay.split(':')
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const candidate = localDay(after)
  candidate.setHours(hour, minute, 0, 0)
  let delta = (weekday - candidate.getDay() + 7) % 7
  if (delta === 0 && candidate.getTime() <= after.getTime()) delta = 7
  candidate.setDate(candidate.getDate() + delta)
  return candidate
}

export function computeNextRun(task: AutomationTask, after: number): string | undefined {
  const base = new Date(Math.max(after, task.createdAt + 1))
  if (task.scheduleKind === 'once') {
    if (!task.runAt) return undefined
    const at = new Date(task.runAt).getTime()
    return Number.isFinite(at) ? task.runAt : undefined
  }
  if (task.scheduleKind === 'interval') {
    const minutes = task.everyMinutes
    if (!minutes || minutes < 1) return undefined
    const last = task.lastRunAt ? new Date(task.lastRunAt).getTime() : task.createdAt
    let next = last + minutes * 60_000
    while (next <= after) next += minutes * 60_000
    return new Date(next).toISOString()
  }
  if (task.scheduleKind === 'daily' && task.timeOfDay) {
    return nextDaily(base, task.timeOfDay).toISOString()
  }
  if (task.scheduleKind === 'weekly' && task.timeOfDay && typeof task.weekday === 'number') {
    return nextWeekly(base, task.weekday, task.timeOfDay).toISOString()
  }
  return undefined
}

function scheduleFields(input: {
  scheduleKind: AutomationScheduleKind
  runAt?: string
  everyMinutes?: number
  timeOfDay?: string
  weekday?: number
}): Pick<AutomationTask, 'scheduleKind' | 'runAt' | 'everyMinutes' | 'timeOfDay' | 'weekday'> {
  const kind = input.scheduleKind
  if (kind === 'once') {
    const at = typeof input.runAt === 'string' ? new Date(input.runAt) : null
    if (!at || !Number.isFinite(at.getTime())) throw new AppError('VALIDATION', '一次性任务需要有效执行时间')
    return { scheduleKind: kind, runAt: at.toISOString() }
  }
  if (kind === 'interval') {
    const every = input.everyMinutes
    if (typeof every !== 'number' || !Number.isInteger(every) || every < 1 || every > 10_080) {
      throw new AppError('VALIDATION', '间隔必须是 1–10080 分钟')
    }
    return { scheduleKind: kind, everyMinutes: every }
  }
  if (kind === 'daily') {
    return { scheduleKind: kind, timeOfDay: parseTimeOfDay(input.timeOfDay) }
  }
  if (kind === 'weekly') {
    return {
      scheduleKind: kind,
      timeOfDay: parseTimeOfDay(input.timeOfDay),
      weekday: parseWeekday(input.weekday)
    }
  }
  throw new AppError('VALIDATION', '未知的重复方式')
}

export class AutomationStore {
  private readonly filePath: string
  private tasks: AutomationTask[] = []
  private runs: AutomationRun[] = []

  constructor(userDataDir: string) {
    this.filePath = join(userDataDir, 'config', 'automation.json')
    this.load()
    this.recalculateMissing()
  }

  list(): AutomationTask[] {
    return [...this.tasks].sort((a, b) => {
      if (a.status !== b.status) return a.status === 'active' ? -1 : 1
      return (a.nextRunAt ?? '').localeCompare(b.nextRunAt ?? '')
    })
  }

  get(id: string): AutomationTask | null {
    return this.tasks.find((task) => task.id === id) ?? null
  }

  runsFor(taskId?: string): AutomationRun[] {
    const list = taskId ? this.runs.filter((run) => run.taskId === taskId) : this.runs
    return [...list].sort((a, b) => b.startedAt - a.startedAt)
  }

  create(input: CreateAutomationInput, projectName?: string): AutomationTask {
    const title = cleanText(input.title, '任务名称', 120)
    const prompt = cleanText(input.prompt, '指令', 100_000)
    const projectId = cleanText(input.projectId, '项目', 200)
    const now = Date.now()
    const fields = scheduleFields(input)
    const task: AutomationTask = {
      id: `task-${randomUUID()}`,
      title,
      prompt,
      projectId,
      projectName,
      ...fields,
      status: 'active',
      createdAt: now,
      updatedAt: now
    }
    task.nextRunAt = computeNextRun(task, now)
    if (task.scheduleKind === 'once' && task.nextRunAt && new Date(task.nextRunAt).getTime() <= now) {
      throw new AppError('VALIDATION', '一次性任务的执行时间必须晚于当前时间')
    }
    this.tasks.push(task)
    this.persist()
    return task
  }

  update(input: UpdateAutomationInput): AutomationTask {
    const task = this.get(input.id)
    if (!task) throw new AppError('VALIDATION', '自动化任务不存在')
    const prospectiveStatus = input.status ?? task.status
    const prospectiveKind = input.scheduleKind ?? task.scheduleKind
    const prospectiveRunAt = input.runAt ?? task.runAt
    if (prospectiveStatus === 'active' && prospectiveKind === 'once') {
      const at = prospectiveRunAt ? new Date(prospectiveRunAt).getTime() : Number.NaN
      if (!Number.isFinite(at) || at <= Date.now()) {
        throw new AppError('VALIDATION', '一次性任务的执行时间已过，请先修改执行时间')
      }
    }
    if (input.title !== undefined) task.title = cleanText(input.title, '任务名称', 120)
    if (input.prompt !== undefined) task.prompt = cleanText(input.prompt, '指令', 100_000)
    if (input.projectId !== undefined) task.projectId = cleanText(input.projectId, '项目', 200)
    const scheduleChanged =
      input.scheduleKind !== undefined ||
      input.runAt !== undefined ||
      input.everyMinutes !== undefined ||
      input.timeOfDay !== undefined ||
      input.weekday !== undefined
    if (scheduleChanged) {
      Object.assign(
        task,
        scheduleFields({
          scheduleKind: input.scheduleKind ?? task.scheduleKind,
          runAt: input.runAt ?? task.runAt,
          everyMinutes: input.everyMinutes ?? task.everyMinutes,
          timeOfDay: input.timeOfDay ?? task.timeOfDay,
          weekday: input.weekday ?? task.weekday
        })
      )
    }
    if (input.status !== undefined) task.status = input.status
    task.updatedAt = Date.now()
    if (task.status === 'active') {
      task.nextRunAt = computeNextRun(task, Date.now())
    } else {
      task.nextRunAt = undefined
    }
    this.persist()
    return task
  }

  setActive(id: string, active: boolean): AutomationTask {
    return this.update({ id, status: active ? 'active' : 'paused' })
  }

  delete(id: string): void {
    const task = this.get(id)
    if (!task) throw new AppError('VALIDATION', '自动化任务不存在')
    this.tasks = this.tasks.filter((item) => item.id !== id)
    this.runs = this.runs.filter((run) => run.taskId !== id)
    this.persist()
  }

  due(now = Date.now()): AutomationTask[] {
    return this.tasks.filter((task) => {
      if (task.status !== 'active' || !task.nextRunAt) return false
      return new Date(task.nextRunAt).getTime() <= now
    })
  }

  startRun(taskId: string): AutomationRun {
    const task = this.get(taskId)
    if (!task) throw new AppError('VALIDATION', '自动化任务不存在')
    const run: AutomationRun = {
      id: `run-${randomUUID()}`,
      taskId,
      startedAt: Date.now(),
      status: 'running'
    }
    task.lastRunAt = new Date(run.startedAt).toISOString()
    task.lastError = undefined
    task.updatedAt = run.startedAt
    this.runs.unshift(run)
    this.trimRuns()
    this.persist()
    return run
  }

  finishRun(
    runId: string,
    result: {
      ok: boolean
      output?: string
      error?: string
      conversationId?: string
      sessionId?: string
    }
  ): AutomationRun {
    const run = this.runs.find((item) => item.id === runId)
    if (!run) throw new AppError('VALIDATION', '运行记录不存在')
    run.finishedAt = Date.now()
    run.status = result.ok ? 'succeeded' : 'failed'
    run.output = result.output
    run.error = result.error
    run.conversationId = result.conversationId
    run.sessionId = result.sessionId
    const task = this.get(run.taskId)
    if (task) {
      task.lastError = result.ok ? undefined : result.error
      task.updatedAt = run.finishedAt
      if (task.scheduleKind === 'once') {
        task.status = 'ended'
        task.nextRunAt = undefined
      } else if (task.status === 'active') {
        task.nextRunAt = computeNextRun(task, run.finishedAt + 1)
      }
    }
    this.persist()
    return run
  }

  private trimRuns(): void {
    if (this.runs.length > MAX_RUNS) this.runs = this.runs.slice(0, MAX_RUNS)
    const counts = new Map<string, number>()
    this.runs = this.runs.filter((run) => {
      const count = (counts.get(run.taskId) ?? 0) + 1
      counts.set(run.taskId, count)
      return count <= RUNS_PER_TASK
    })
  }

  private recalculateMissing(): void {
    let changed = false
    for (const task of this.tasks) {
      if (task.status === 'active' && !task.nextRunAt) {
        task.nextRunAt = computeNextRun(task, Date.now())
        changed = true
      }
    }
    if (changed) this.persist()
  }

  private load(): void {
    if (!existsSync(this.filePath)) return
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown
      if (!isObject(raw) || !Array.isArray(raw.tasks) || !Array.isArray(raw.runs)) {
        throw new Error('bad automation file')
      }
      this.tasks = raw.tasks.filter((item): item is AutomationTask => isObject(item) && typeof item.id === 'string')
      this.runs = raw.runs.filter((item): item is AutomationRun => isObject(item) && typeof item.id === 'string')
    } catch (error) {
      const suffix = new Date().toISOString().replace(/[:.]/g, '-')
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt-${suffix}`)
      } catch {
        // ignore
      }
      console.error('[automation] failed to load, starting empty:', error)
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const data: AutomationFile = { version: 1, tasks: this.tasks, runs: this.runs }
    const temp = `${this.filePath}.tmp`
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    renameSync(temp, this.filePath)
  }
}
