/**
 * Five-phase runner + adapter surface.
 *
 *   ingest -> light -> REM -> deep -> review (pending approval)
 *                                     -> publish -> verify
 *
 * Every phase writes a checkpoint. A retry/resume reuses earlier checkpoints so
 * ingest is not repeated. Model calls are bounded by a per-run and daily budget,
 * retried only for retryable failures, and preceded by a fresh policy check.
 */

import { DreamError, isDreamError, toPublicError } from './errors.mjs'
import { EvidenceRegistry, toEvidenceRef } from './evidence.mjs'
import { ingest } from './sessions.mjs'
import { validateCandidates } from './candidates.mjs'
import { buildRem, proposeWikiDraft } from './rem.mjs'
import { buildPlan } from './plan.mjs'
import { readEntries } from './l1.mjs'
import { renderL3, validateBudget } from './l3.mjs'
import { publishPlan, rollbackMemory } from './publishing.mjs'
import { verifyAnswerCitations, verifyPublishedVersion } from './verify.mjs'
import { BudgetMeter, tokensOf } from './budget.mjs'
import { deepClone, newId, estimateTokens, normalizeKey, normalizeSpace, sleep } from './util.mjs'

const PHASES = ['ingest', 'light', 'rem', 'deep', 'review']

function isAbort(error) {
  return error?.name === 'AbortError' || error?.code === 'CANCELLED'
}

function defaultPolicy() {
  return { authorized: true, revokedSourceIds: [] }
}

export class DreamingPipeline {
  /**
   * @param {{
   *   store:any, registry?:any, model:any, policyProvider?:Function,
   *   l3Budget?:any, maxDeleteRatio?:number, maxAttempts?:number,
   *   budgetLimits?:any, sleep?:Function, backoffMs?:number,
   *   originalsDir?:string|null, clock?:()=>number
   * }} options
   */
  constructor(options) {
    if (!options?.store) throw new DreamError('VALIDATION', 'DreamingPipeline needs a store')
    if (!options?.model) throw new DreamError('VALIDATION', 'DreamingPipeline needs a model')
    this.store = options.store
    this.registry = options.registry ?? null
    this.registryFactory = options.registryFactory ?? null
    this.model = options.model
    this.policyProvider = options.policyProvider ?? (async () => defaultPolicy())
    this.clock = options.clock ?? Date.now
    this.maxAttempts = options.maxAttempts ?? 3
    this.maxDeleteRatio = options.maxDeleteRatio ?? 0.5
    this.l3Budget = validateBudget(options.l3Budget ?? {})
    this.budgetLimits = options.budgetLimits ?? {}
    this.sleep = options.sleep ?? sleep
    this.backoffMs = options.backoffMs ?? 100
    this.originalsDir = options.originalsDir ?? null
    this.jobs = new Map()
    this.controllers = new Map()
    this.dailyLedger = new Map()
    this.registries = new Map()
    this.closed = false
  }

  #registryFor(projectId) {
    if (this.registry) {
      if (this.registry.projectId !== projectId) {
        throw new DreamError('PROJECT_MISMATCH', 'Evidence registry belongs to another project')
      }
      return this.registry
    }
    if (this.registryFactory) {
      if (this.registries.has(projectId)) return this.registries.get(projectId)
      const registry = this.registryFactory(projectId)
      if (!(registry instanceof EvidenceRegistry)) {
        throw new DreamError('VALIDATION', 'registryFactory must return an EvidenceRegistry')
      }
      this.registries.set(projectId, registry)
      return registry
    }
    this.registry = new EvidenceRegistry(projectId)
    return this.registry
  }

  /**
   * Create an immutable job input. Running is separate so the caller can cancel.
   * @param {{projectId:string, sessions?:any[], materials?:any[], wiki?:any,
   *          trigger?:string, baseVersionId?:string|null, budgetLimits?:any, metadata?:any}} input
   */
  createJob(input) {
    if (!input || typeof input.projectId !== 'string' || input.projectId.length === 0) {
      throw new DreamError('VALIDATION', 'projectId is required')
    }
    if (!Array.isArray(input.sessions ?? [])) throw new DreamError('VALIDATION', 'sessions must be an array')
    if (!Array.isArray(input.materials ?? [])) throw new DreamError('VALIDATION', 'materials must be an array')
    this.#registryFor(input.projectId)
    const now = this.clock()
    const job = {
      id: newId('job'),
      projectId: input.projectId,
      trigger: input.trigger ?? 'manual',
      phase: 'queued',
      status: 'queued',
      baseVersionId: input.baseVersionId ?? null,
      baseRevision: null,
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      error: null,
      ops: [],
      evidenceRefs: [],
      publishId: null,
      input: {
        sessions: structuredClone(input.sessions ?? []),
        materials: structuredClone(input.materials ?? []),
        wiki: input.wiki ? structuredClone(input.wiki) : null,
        metadata: input.metadata ? structuredClone(input.metadata) : null
      },
      checkpoints: {},
      plan: null,
      model: null,
      degraded: false,
      budgetLimits: input.budgetLimits ?? this.budgetLimits,
      meter: null,
      verification: null,
      wikiDraft: null,
      policyChecks: [],
      history: [],
      cancelRequested: false,
      startedAt: null,
      finishedAt: null
    }
    job.meter = new BudgetMeter({
      limits: job.budgetLimits,
      clock: this.clock,
      dailyLedger: this.dailyLedger
    })
    this.jobs.set(job.id, job)
    return this.getJob(job.id)
  }

  getJob(jobId) {
    const job = this.jobs.get(jobId)
    if (!job) throw new DreamError('JOB_NOT_FOUND', `Unknown job: ${jobId}`)
    return this.#view(job)
  }

  listJobs({ projectId = null } = {}) {
    return [...this.jobs.values()]
      .filter((job) => projectId === null || job.projectId === projectId)
      .map((job) => this.#view(job, { compact: true }))
  }

  async start(input) {
    const job = this.createJob(input)
    return this.run(job.id)
  }

  async run(jobId, { signal = null } = {}) {
    if (this.closed) throw new DreamError('JOB_STATE', 'Pipeline is closed')
    const job = this.jobs.get(jobId)
    if (!job) throw new DreamError('JOB_NOT_FOUND', `Unknown job: ${jobId}`)
    if (job.status === 'running') throw new DreamError('JOB_STATE', 'Job is already running')
    if (job.status === 'applied' || job.status === 'rejected') {
      throw new DreamError('JOB_STATE', `Job is ${job.status} and cannot be re-run`)
    }
    const registry = this.#registryFor(job.projectId)
    const controller = new AbortController()
    const onExternalAbort = () => controller.abort(new Error('cancelled'))
    if (signal) {
      if (signal.aborted) controller.abort(new Error('cancelled'))
      else signal.addEventListener('abort', onExternalAbort, { once: true })
    }
    this.controllers.set(job.id, controller)
    job.status = 'running'
    job.error = null
    job.cancelRequested = false
    job.updatedAt = this.clock()
    if (!job.startedAt) {
      job.startedAt = this.clock()
      job.meter.beginRun(job.startedAt)
    }
    this.#mark(job, 'run-started')

    try {
      this.#throwIfAborted(controller.signal)
      await this.#assertPolicy(job, 'start', registry)
      const active = await this.#loadBase(job)
      this.#throwIfAborted(controller.signal)

      await this.#phaseIngest(job, registry, controller.signal)
      await this.#phaseLight(job, registry, controller.signal)
      await this.#phaseRem(job, registry, controller.signal)
      await this.#phaseDeep(job, registry, controller.signal)
      await this.#phaseReview(job, registry, controller.signal)

      if (job.plan.status === 'blocked') {
        job.status = 'failed'
        job.error = {
          name: 'DreamError',
          code: 'PLAN_CHECK_FAILED',
          message: 'The proposed plan is blocked by validation',
          retryable: false,
          details: { blocking: job.plan.checks.blocking, rejectedOps: job.plan.rejectedOps }
        }
      } else {
        job.status = 'review'
      }
      if (job.plan.status === 'no-changes') {
        job.warning = { code: 'NO_CHANGES', message: 'No admissible memory changes were found' }
      }
      job.phase = 'review'
      this.#mark(job, job.status === 'failed' ? 'plan-blocked' : 'plan-ready')
      return this.getJob(job.id)
    } catch (error) {
      if (isAbort(error) || controller.signal.aborted || job.cancelRequested) {
        job.status = 'cancelled'
        job.error = {
          name: 'DreamError',
          code: 'CANCELLED',
          message: 'Job was cancelled',
          retryable: true,
          details: null
        }
        this.#mark(job, 'cancelled')
      } else {
        job.status = 'failed'
        job.error = toPublicError(error)
        this.#mark(job, 'failed', job.error.code)
      }
      return this.getJob(job.id)
    } finally {
      job.updatedAt = this.clock()
      job.finishedAt = this.clock()
      if (job.status !== 'running') job.updatedAt = this.clock()
      if (signal) signal.removeEventListener('abort', onExternalAbort)
      this.controllers.delete(job.id)
      this.#syncPublicFields(job)
    }
  }

  async resume(jobId, options = {}) {
    const job = this.jobs.get(jobId)
    if (!job) throw new DreamError('JOB_NOT_FOUND', `Unknown job: ${jobId}`)
    if (!['failed', 'cancelled', 'queued'].includes(job.status)) {
      throw new DreamError('JOB_STATE', `Job is ${job.status} and cannot be resumed`)
    }
    job.cancelRequested = false
    return this.run(jobId, options)
  }

  cancel(jobId, reason = 'cancelled by publisher') {
    const job = this.jobs.get(jobId)
    if (!job) throw new DreamError('JOB_NOT_FOUND', `Unknown job: ${jobId}`)
    if (['applied', 'rejected'].includes(job.status)) return this.getJob(jobId)
    job.cancelRequested = true
    job.cancelReason = String(reason).slice(0, 500)
    const controller = this.controllers.get(jobId)
    if (controller) controller.abort(new Error(reason))
    if (job.status !== 'running') {
      job.status = 'cancelled'
      job.error = { name: 'DreamError', code: 'CANCELLED', message: job.cancelReason, retryable: true, details: null }
      job.updatedAt = this.clock()
      this.#syncPublicFields(job)
    }
    return this.getJob(jobId)
  }

  reject(jobId, { actor = 'publisher', reason = 'rejected' } = {}) {
    const job = this.jobs.get(jobId)
    if (!job) throw new DreamError('JOB_NOT_FOUND', `Unknown job: ${jobId}`)
    if (job.status !== 'review') throw new DreamError('JOB_STATE', 'Only review jobs can be rejected')
    job.status = 'rejected'
    job.error = { name: 'DreamError', code: 'REJECTED', message: normalizeSpace(reason), retryable: false, details: { actor } }
    job.phase = 'review'
    this.#mark(job, 'rejected')
    this.#syncPublicFields(job)
    return this.getJob(jobId)
  }

  /**
   * Publish the pending plan. Approval is an explicit {approvedBy, approvalToken}
   * pair; the token must equal plan.planHash.
   */
  async publish(jobId, approval, { signal = null } = {}) {
    const job = this.jobs.get(jobId)
    if (!job) throw new DreamError('JOB_NOT_FOUND', `Unknown job: ${jobId}`)
    if (job.status === 'applied') {
      return { ...deepClone(job.publishResult), status: 'idempotent' }
    }
    if (job.status !== 'review' || !job.plan) {
      throw new DreamError('JOB_STATE', 'Job has no plan waiting for approval')
    }
    if (signal?.aborted) throw new DreamError('CANCELLED', 'Publish was cancelled')
    const registry = this.#registryFor(job.projectId)
    await this.#assertPolicy(job, 'publish', registry)
    const result = await publishPlan({
      store: this.store,
      registry,
      plan: job.plan,
      approval,
      now: this.clock(),
      maxDeleteRatio: this.maxDeleteRatio
    })
    job.publishResult = result
    job.publishId = result.publishId
    job.status = 'applied'
    job.phase = 'verify'
    job.verification = verifyPublishedVersion({ projectId: job.projectId, registry, version: result.version })
    if (!job.verification.ok) {
      job.warning = {
        code: 'POST_PUBLISH_VERIFY_FAILED',
        message: 'The published version has entries that are no longer readable',
        details: job.verification.excluded
      }
    }
    job.finishedAt = this.clock()
    job.updatedAt = job.finishedAt
    this.#mark(job, 'published')
    this.#syncPublicFields(job)
    return {
      ...result,
      jobId: job.id,
      verification: job.verification
    }
  }

  async rollback({ projectId, toRevision, approvedBy, reason, publishId = null, signal = null }) {
    if (signal?.aborted) throw new DreamError('CANCELLED', 'Rollback was cancelled')
    const registry = this.#registryFor(projectId)
    const policy = await this.#policy(projectId, 'rollback', null)
    this.#applyPolicyRevocations(registry, policy)
    return rollbackMemory({
      store: this.store,
      registry,
      projectId,
      toRevision,
      approvedBy,
      reason,
      now: this.clock(),
      publishId,
      budget: this.l3Budget
    })
  }

  /** Active L3 rebuilt through current revocations; never trusts the snapshot. */
  async getL3(projectId, { budget = this.l3Budget } = {}) {
    const registry = this.#registryFor(projectId)
    const active = await this.store.getActive(projectId)
    const readable = readEntries(registry, active.entries, { projectId })
    const rendered = renderL3(readable.entries, budget)
    return {
      projectId,
      versionId: active.versionId,
      revision: active.revision,
      text: rendered.text,
      stats: rendered.stats,
      truncated: rendered.truncated,
      hash: rendered.hash ?? null,
      drifted: rendered.text !== active.l3?.text,
      excluded: readable.excluded
    }
  }

  /**
   * Deterministic retrieval for Verify. Uses only approved, readable L3 entries.
   */
  async answer({ projectId, query, limit = 3 }) {
    const registry = this.#registryFor(projectId)
    const active = await this.store.getActive(projectId)
    const readable = readEntries(registry, active.entries, { projectId })
    const promoted = readable.entries.filter((entry) => entry.promoted === true)
    const q = normalizeKey(query)
    const scored = []
    for (const entry of promoted) {
      const subject = normalizeKey(entry.subject)
      const value = normalizeKey(entry.value)
      let score = 0
      if (q.length > 0 && (subject.includes(q) || value.includes(q) || q.includes(subject))) score += 3
      for (const token of q.split(/[\s,，。.!！?？;；:：/]+/).filter((part) => part.length >= 2)) {
        if (subject.includes(token) || value.includes(token) || entry.title && normalizeKey(entry.title).includes(token)) {
          score += 1
        }
      }
      if (score > 0) scored.push({ entry, score })
    }
    scored.sort((a, b) => b.score - a.score || (a.entry.subject < b.entry.subject ? -1 : 1))
    const chosen = scored.slice(0, Math.max(1, limit)).map((item) => item.entry)
    const citations = chosen.map((entry) => ({
      entryId: entry.id,
      evidenceIds: entry.assertionRefs.map((ref) => ref.evidenceId),
      versionId: active.versionId,
      revision: active.revision
    }))
    const citationCheck = verifyAnswerCitations({
      projectId,
      registry,
      version: active,
      citations
    })
    return {
      projectId,
      query: normalizeSpace(query),
      versionId: active.versionId,
      revision: active.revision,
      matched: chosen.length > 0,
      citationCheck,
      answer:
        chosen.length === 0
          ? 'No approved project memory matched the query.'
          : chosen.map((entry) => `- ${entry.subject}: ${entry.value} [${entry.id}]`).join('\n'),
      entries: chosen.map((entry) => ({
        id: entry.id,
        type: entry.type,
        subject: entry.subject,
        value: entry.value
      })),
      citations,
      excluded: readable.excluded
    }
  }

  async verifyProject(projectId) {
    const registry = this.#registryFor(projectId)
    const active = await this.store.getActive(projectId)
    return verifyPublishedVersion({ projectId, registry, version: active })
  }

  async close() {
    this.closed = true
    for (const controller of this.controllers.values()) controller.abort(new Error('pipeline closed'))
    this.controllers.clear()
    await this.store.close?.()
  }

  async #loadBase(job) {
    const active = await this.store.getActive(job.projectId)
    if (job.baseVersionId && active.versionId !== job.baseVersionId) {
      throw new DreamError('PLAN_STALE', 'Active version no longer matches the job base version')
    }
    job.baseVersionId = active.versionId
    job.baseRevision = active.revision
    job.baseEntries = active.entries
    return active
  }

  async #phaseIngest(job, registry, signal) {
    if (job.checkpoints.ingest) {
      this.#mark(job, 'ingest-reused')
      return
    }
    job.phase = 'ingest'
    this.#throwIfAborted(signal)
    await this.#assertPolicy(job, 'ingest', registry)
    const result = await ingest({
      registry,
      projectId: job.projectId,
      sessions: job.input.sessions,
      materials: job.input.materials,
      now: this.clock(),
      originalsDir: this.originalsDir
    })
    job.checkpoints.ingest = result
    job.ingest = result
    job.updatedAt = this.clock()
    this.#mark(job, 'ingest-done', {
      sources: result.sources.length,
      evidence: result.evidenceIds.length,
      excludedSessions: result.excludedSessions.length
    })
  }

  #activeEvidence(registry, projectId) {
    return registry
      .listEvidence({ includeQuarantined: false })
      .filter((record) => {
        if (record.projectId !== projectId) return false
        if (record.quarantined || record.injectionFlags?.length > 0) return false
        return registry.verifyRef(toEvidenceRef(record), { requireQuote: true }).ok
      })
  }

  async #phaseLight(job, registry, signal) {
    if (job.checkpoints.light) {
      this.#mark(job, 'light-reused')
      return
    }
    job.phase = 'light'
    this.#throwIfAborted(signal)
    await this.#assertPolicy(job, 'light', registry)
    const evidence = this.#activeEvidence(registry, job.projectId)
    let raw = { candidates: [], notes: [], degraded: false, provider: this.model.name ?? null }
    if (evidence.length > 0) {
      raw = await this.#callModel(
        job,
        'extract',
        { projectId: job.projectId, evidence },
        signal
      )
    }
    const validated = validateCandidates({
      projectId: job.projectId,
      registry,
      rawCandidates: raw.candidates ?? [],
      now: this.clock()
    })
    job.degraded = job.degraded || raw.degraded === true
    if (raw.provider) job.model = { provider: raw.provider, degraded: raw.degraded === true, reason: raw.degradedReason ?? null }
    job.checkpoints.light = {
      candidates: validated.candidates,
      rejected: validated.rejected,
      stats: validated.stats,
      model: job.model
    }
    job.light = job.checkpoints.light
    job.updatedAt = this.clock()
    this.#mark(job, 'light-done', validated.stats)
  }

  async #phaseRem(job, registry, signal) {
    if (job.checkpoints.rem) {
      this.#mark(job, 'rem-reused')
      return
    }
    job.phase = 'rem'
    this.#throwIfAborted(signal)
    await this.#assertPolicy(job, 'rem', registry)
    const readable = readEntries(registry, job.baseEntries ?? [], { projectId: job.projectId })
    const rem = buildRem({
      projectId: job.projectId,
      candidates: job.checkpoints.light.candidates,
      entries: readable.entries
    })
    job.checkpoints.rem = rem
    job.rem = rem
    if (job.input.wiki) {
      job.wikiDraft = proposeWikiDraft({ projectId: job.projectId, rem, existingWiki: job.input.wiki, now: this.clock() })
    }
    job.updatedAt = this.clock()
    this.#mark(job, 'rem-done', rem.stats)
  }

  async #phaseDeep(job, registry, signal) {
    if (job.checkpoints.deep) {
      this.#mark(job, 'deep-reused')
      return
    }
    job.phase = 'deep'
    this.#throwIfAborted(signal)
    await this.#assertPolicy(job, 'deep', registry)
    const candidates = job.checkpoints.light.candidates
    const rem = job.checkpoints.rem
    const readable = readEntries(registry, job.baseEntries ?? [], { projectId: job.projectId })
    let proposal = { ops: [], notes: [] }
    if (candidates.length > 0) {
      const result = await this.#callModel(
        job,
        'adjudicate',
        {
          projectId: job.projectId,
          candidates: candidates.map((candidate) => ({
            id: candidate.id,
            type: candidate.type,
            subject: candidate.subject,
            value: candidate.value,
            previousValue: candidate.previousValue,
            basis: candidate.basis,
            confidence: candidate.confidence,
            sessionId: candidate.sessionId,
            evidenceIds: candidate.evidenceIds
          })),
          entries: readable.entries.map((entry) => ({
            id: entry.id,
            type: entry.type,
            subject: entry.subject,
            value: entry.value,
            revision: entry.revision,
            promoted: entry.promoted
          })),
          conflicts: rem.conflicts
        },
        signal
      )
      if (!Array.isArray(result.ops)) {
        throw new DreamError('MODEL_OUTPUT_INVALID', 'Adjudication response must contain ops[]')
      }
      proposal = { ops: result.ops, notes: result.notes ?? [] }
      job.degraded = job.degraded || result.degraded === true
      if (result.provider) {
        job.model = { provider: result.provider, degraded: result.degraded === true, reason: result.degradedReason ?? null }
      }
    }
    job.checkpoints.deep = { proposal }
    job.updatedAt = this.clock()
    this.#mark(job, 'deep-done', { ops: proposal.ops.length })
  }

  async #phaseReview(job, registry, signal) {
    if (job.checkpoints.review && job.plan) {
      this.#mark(job, 'review-reused')
      return
    }
    job.phase = 'review'
    this.#throwIfAborted(signal)
    await this.#assertPolicy(job, 'review', registry)
    const plan = buildPlan({
      projectId: job.projectId,
      jobId: job.id,
      baseVersion: {
        versionId: job.baseVersionId,
        revision: job.baseRevision,
        entries: job.baseEntries,
        conflicts: (await this.store.getVersion(job.projectId, job.baseRevision))?.conflicts ?? []
      },
      registry,
      proposal: job.checkpoints.deep.proposal,
      rem: job.checkpoints.rem,
      candidates: job.checkpoints.light.candidates,
      budget: this.l3Budget,
      now: this.clock(),
      model: job.model,
      maxDeleteRatio: this.maxDeleteRatio
    })
    if (job.wikiDraft) plan.wikiDraft = job.wikiDraft
    job.plan = plan
    job.checkpoints.review = { planId: plan.planId, planHash: plan.planHash, status: plan.status }
    job.updatedAt = this.clock()
    this.#mark(job, 'review-done', { planId: plan.planId, status: plan.status })
    this.#syncPublicFields(job)
  }

  async #callModel(job, method, payload, signal) {
    if (typeof this.model[method] !== 'function') {
      throw new DreamError('MODEL_UNAVAILABLE', `Model does not implement ${method}()`)
    }
    let lastError = null
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      this.#throwIfAborted(signal)
      await this.#assertPolicy(job, `model:${method}`, this.#registryFor(job.projectId))
      this.#throwIfAborted(signal)
      const requestTokens = tokensOf(payload)
      job.meter.begin({ calls: 1, tokens: requestTokens, phase: method })
      job.attempts += 1
      try {
        const result = await this.model[method]({ ...payload, signal })
        job.meter.finish({ tokens: tokensOf(result), phase: method })
        this.#mark(job, `model-${method}-done`, { attempt })
        return result
      } catch (error) {
        if (isAbort(error) || signal?.aborted) {
          throw Object.assign(new Error('cancelled'), { name: 'AbortError', code: 'CANCELLED' })
        }
        lastError = error
        if (!(error instanceof DreamError) || !error.retryable) {
          if (error instanceof DreamError) throw error
          throw new DreamError('MODEL_UNAVAILABLE', `Model ${method} failed`, { cause: error })
        }
        this.#mark(job, `model-${method}-retry`, { attempt, code: error.code })
        if (attempt < this.maxAttempts) {
          const delay = Math.min(this.backoffMs * 2 ** (attempt - 1), 2000)
          await this.sleep(delay, { signal })
          this.#throwIfAborted(signal)
        }
      }
    }
    throw new DreamError('RETRY_EXHAUSTED', `Model ${method} failed after ${this.maxAttempts} attempts`, {
      details: { lastCode: lastError?.code ?? null },
      cause: lastError
    })
  }

  async #policy(projectId, phase, job) {
    let policy
    try {
      policy = await this.policyProvider({ projectId, phase, jobId: job?.id ?? null })
    } catch (error) {
      throw new DreamError('POLICY_UNAVAILABLE', 'Project policy could not be revalidated', { cause: error })
    }
    if (!policy || policy.authorized !== true) {
      throw new DreamError('POLICY_UNAVAILABLE', 'Project is not authorized for dreaming', { details: { phase } })
    }
    if (policy.projectId && policy.projectId !== projectId) {
      throw new DreamError('PROJECT_MISMATCH', 'Policy belongs to another project')
    }
    return policy
  }

  async #assertPolicy(job, phase, registry) {
    const policy = await this.#policy(job.projectId, phase, job)
    this.#applyPolicyRevocations(registry, policy)
    job.policyChecks.push({
      phase,
      at: this.clock(),
      authorized: true,
      revokedSourceIds: Array.isArray(policy.revokedSourceIds) ? [...policy.revokedSourceIds] : []
    })
    if (job.policyChecks.length > 50) job.policyChecks.splice(0, job.policyChecks.length - 50)
    return policy
  }

  #applyPolicyRevocations(registry, policy) {
    for (const sourceId of policy.revokedSourceIds ?? []) {
      const source = registry.getSource(sourceId)
      if (!source) continue
      if (source.status !== 'revoked') registry.revokeSource(sourceId, { at: this.clock(), reason: 'policy-revocation' })
    }
  }

  #throwIfAborted(signal) {
    if (signal?.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError', code: 'CANCELLED' })
  }

  #mark(job, action, detail = null) {
    job.history.push({ at: this.clock(), phase: job.phase, action, detail })
    if (job.history.length > 100) job.history.splice(0, job.history.length - 100)
  }

  #syncPublicFields(job) {
    job.ops = job.plan?.ops ?? job.ops ?? []
    const refs = new Map()
    for (const op of job.ops) for (const ref of op.evidenceRefs ?? []) refs.set(ref.evidenceId, ref)
    for (const candidate of job.checkpoints.light?.candidates ?? []) {
      for (const ref of candidate.evidenceRefs ?? []) refs.set(ref.evidenceId, ref)
    }
    job.evidenceRefs = [...refs.values()]
  }

  #view(job, { compact = false } = {}) {
    const excluded = {
      sessions: job.ingest?.excludedSessions ?? [],
      messages: job.ingest?.excludedMessages ?? [],
      candidates: job.checkpoints.light?.rejected ?? []
    }
    const view = {
      id: job.id,
      projectId: job.projectId,
      trigger: job.trigger,
      phase: job.phase,
      status: job.status,
      baseVersionId: job.baseVersionId,
      baseRevision: job.baseRevision,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      attempts: job.attempts,
      error: job.error,
      warning: job.warning ?? null,
      ops: job.ops,
      evidenceRefs: job.evidenceRefs,
      publishId: job.publishId,
      degraded: job.degraded,
      model: job.model,
      budget: job.meter?.snapshot() ?? null,
      checks: job.plan?.checks ?? null,
      plan: job.plan,
      verification: job.verification,
      wikiDraft: job.wikiDraft,
      excluded,
      history: compact ? job.history.slice(-5) : job.history
    }
    if (compact) {
      return {
        id: view.id,
        projectId: view.projectId,
        phase: view.phase,
        status: view.status,
        createdAt: view.createdAt,
        updatedAt: view.updatedAt,
        error: view.error,
        planId: job.plan?.planId ?? null,
        planStatus: job.plan?.status ?? null
      }
    }
    return deepClone(view)
  }
}
