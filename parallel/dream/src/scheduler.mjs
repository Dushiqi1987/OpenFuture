/**
 * Background scheduler skeleton.
 *
 * Disabled by default. A project must be explicitly registered AND authorized;
 * every round re-reads the project policy and passes the cancellation signal into
 * the pipeline, which revalidates it again before each phase/model call. The
 * scheduler never reads or merges a plan by itself: a scheduled round stops at
 * `review` and waits for an explicit publisher approval.
 */

import { DreamError } from './errors.mjs'
import { normalizeSpace } from './util.mjs'

const DEFAULTS = Object.freeze({
  minIntervalMs: 6 * 60 * 60 * 1000,
  maxConcurrentTasks: 1,
  maxTasksPerDay: 4,
  budgetLimits: null
})

function dayOf(clock) {
  return new Date(clock()).toISOString().slice(0, 10)
}

export class DreamingScheduler {
  /**
   * @param {{
   *   pipeline:any, enabled?:boolean, projects?:Record<string,any>,
   *   policyProvider?:Function, sourcesProvider?:Function,
   *   clock?:()=>number, intervalMs?:number, logger?:Function
   * }} options
   */
  constructor({
    pipeline,
    enabled = false,
    projects = {},
    policyProvider = null,
    sourcesProvider = null,
    clock = Date.now,
    intervalMs = 60_000,
    logger = null
  } = {}) {
    if (!pipeline) throw new DreamError('VALIDATION', 'DreamingScheduler needs a pipeline')
    if (typeof enabled !== 'boolean') throw new DreamError('VALIDATION', 'enabled must be a boolean')
    if (typeof sourcesProvider !== 'function') {
      throw new DreamError('VALIDATION', 'DreamingScheduler needs a sourcesProvider(projectId)')
    }
    this.pipeline = pipeline
    this.enabled = enabled
    this.projects = new Map()
    this.policyProvider = policyProvider
    this.sourcesProvider = sourcesProvider
    this.clock = clock
    this.intervalMs = intervalMs
    this.logger = logger
    this.timer = null
    this.running = 0
    this.daily = new Map()
    this.lastRuns = new Map()
    this.lastError = null
    this.rounds = 0
    for (const [projectId, config] of Object.entries(projects)) {
      this.registerProject(projectId, config)
    }
  }

  registerProject(projectId, config = {}) {
    if (typeof projectId !== 'string' || projectId.length === 0) {
      throw new DreamError('VALIDATION', 'projectId is required')
    }
    if (!config || typeof config !== 'object') throw new DreamError('VALIDATION', 'Project config must be an object')
    if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
      throw new DreamError('VALIDATION', 'Project enabled must be a boolean')
    }
    const merged = {
      ...DEFAULTS,
      ...config,
      enabled: config.enabled ?? false,
      authorized: config.authorized === true,
      trigger: config.trigger ?? 'scheduled'
    }
    for (const key of ['minIntervalMs', 'maxConcurrentTasks', 'maxTasksPerDay']) {
      if (!Number.isInteger(merged[key]) || merged[key] < 0) {
        throw new DreamError('VALIDATION', `Project ${key} must be a non-negative integer`)
      }
    }
    this.projects.set(projectId, merged)
    return { ...merged }
  }

  setProjectEnabled(projectId, enabled) {
    const config = this.projects.get(projectId)
    if (!config) throw new DreamError('JOB_NOT_FOUND', `Project is not registered: ${projectId}`)
    config.enabled = enabled === true
    return { ...config }
  }

  status() {
    return {
      enabled: this.enabled,
      running: this.running,
      intervalMs: this.intervalMs,
      rounds: this.rounds,
      lastError: this.lastError,
      projects: [...this.projects.entries()].map(([projectId, config]) => ({
        projectId,
        enabled: config.enabled,
        authorized: config.authorized,
        minIntervalMs: config.minIntervalMs,
        maxConcurrentTasks: config.maxConcurrentTasks,
        maxTasksPerDay: config.maxTasksPerDay,
        runsToday: this.#dailyCount(projectId),
        lastRunAt: this.lastRuns.get(projectId) ?? null
      }))
    }
  }

  start() {
    if (this.timer) return this.status()
    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        this.lastError = { code: error?.code ?? 'SCHEDULER_FAILED', message: normalizeSpace(error?.message ?? 'tick failed') }
      })
    }, this.intervalMs)
    this.timer.unref?.()
    return this.status()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    return this.status()
  }

  /**
   * One deterministic scheduling round. No-op while disabled.
   * @param {{signal?:AbortSignal}} options
   */
  async tick({ signal = null } = {}) {
    if (!this.enabled) return { skipped: 'disabled', started: [], status: this.status() }
    this.rounds += 1
    const started = []
    const skipped = []
    for (const [projectId, config] of this.projects) {
      if (signal?.aborted) break
      if (!config.enabled) {
        skipped.push({ projectId, reason: 'project-disabled' })
        continue
      }
      if (!config.authorized) {
        skipped.push({ projectId, reason: 'not-authorized' })
        continue
      }
      if (this.running >= config.maxConcurrentTasks) {
        skipped.push({ projectId, reason: 'concurrency' })
        continue
      }
      const lastRun = this.lastRuns.get(projectId) ?? 0
      if (this.clock() - lastRun < config.minIntervalMs) {
        skipped.push({ projectId, reason: 'interval' })
        continue
      }
      if (this.#dailyCount(projectId) >= config.maxTasksPerDay) {
        skipped.push({ projectId, reason: 'daily-task-limit' })
        continue
      }
      if (this.policyProvider) {
        try {
          const policy = await this.policyProvider({ projectId, phase: 'scheduler', jobId: null })
          if (!policy || policy.authorized !== true) {
            skipped.push({ projectId, reason: 'policy-denied' })
            continue
          }
          if (policy.projectId && policy.projectId !== projectId) {
            skipped.push({ projectId, reason: 'policy-project-mismatch' })
            continue
          }
        } catch (error) {
          this.lastError = { code: 'POLICY_UNAVAILABLE', message: normalizeSpace(error?.message ?? 'policy failed') }
          skipped.push({ projectId, reason: 'policy-unavailable' })
          continue
        }
      }
      let sources
      try {
        sources = await this.sourcesProvider(projectId)
      } catch (error) {
        this.lastError = { code: 'SOURCES_UNAVAILABLE', message: normalizeSpace(error?.message ?? 'sources failed') }
        skipped.push({ projectId, reason: 'sources-unavailable' })
        continue
      }
      if (!sources || !Array.isArray(sources.sessions)) {
        skipped.push({ projectId, reason: 'no-sources' })
        continue
      }
      this.running += 1
      this.#bumpDaily(projectId)
      this.lastRuns.set(projectId, this.clock())
      started.push({ projectId, sessions: sources.sessions.length, materials: sources.materials?.length ?? 0 })
      try {
        const job = await this.pipeline.start({
          projectId,
          sessions: sources.sessions,
          materials: sources.materials ?? [],
          trigger: config.trigger,
          budgetLimits: config.budgetLimits ?? undefined
        })
        this.logger?.({
          event: 'scheduler-round',
          projectId,
          jobId: job.id,
          status: job.status,
          planStatus: job.plan?.status ?? null
        })
        if (job.status === 'failed') this.lastError = job.error
      } catch (error) {
        this.lastError = { code: error?.code ?? 'JOB_FAILED', message: normalizeSpace(error?.message ?? 'job failed') }
      } finally {
        this.running -= 1
      }
    }
    return { skipped, started, status: this.status() }
  }

  #dailyCount(projectId) {
    return this.daily.get(`${dayOf(this.clock)}:${projectId}`) ?? 0
  }

  #bumpDaily(projectId) {
    const key = `${dayOf(this.clock)}:${projectId}`
    this.daily.set(key, (this.daily.get(key) ?? 0) + 1)
  }
}
