/**
 * Independent integration gate.
 *
 * The gate never touches the real working tree. It builds a fresh copy under
 * the project's integration root, validates each diff against the baseline
 * hash and its task write scope, applies changes once, and reports conflicts,
 * checks and evidence. The tester consumes this report rather than trusting
 * producer self-reports.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { TeamError } from './errors.ts'
import {
  fileHash,
  validateArtifactDraft,
  validateFileChanges,
  type ArtifactStore
} from './artifacts.ts'
import {
  isTerminalTaskState,
  type IntegrationCheck,
  type IntegrationConflict,
  type IntegrationReport,
  type ProjectPolicy,
  type TaskRecord
} from './types.ts'
import type { RunStore } from './store.ts'
import { normalizePosixPath, systemClock, type Clock } from './util.ts'

export interface IntegrationRunnerOptions {
  clock?: Clock
}

interface AppliedFile {
  taskId: string
  path: string
  hash: string
}

export class IntegrationRunner {
  private readonly project: ProjectPolicy
  private readonly store: RunStore
  private readonly artifacts: ArtifactStore
  private readonly clock: Clock

  constructor(project: ProjectPolicy, store: RunStore, artifacts: ArtifactStore, options: IntegrationRunnerOptions = {}) {
    this.project = project
    this.store = store
    this.artifacts = artifacts
    this.clock = options.clock ?? systemClock
  }

  get integrationRoot(): string {
    const root = path.resolve(this.project.rootPath)
    const target = path.resolve(root, this.project.integrationRoot, this.store.run.runId)
    const relative = path.relative(root, target)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new TeamError('integration-outside-root', 'integration root escapes the project root')
    }
    if (target === root) throw new TeamError('integration-outside-root', 'integration root must be a subdirectory')
    return target
  }

  async run(): Promise<IntegrationReport> {
    const existing = this.store.snapshot.integration
    if (existing) return existing

    const startedAt = this.clock.now()
    this.store.emit('integration.started', undefined, {
      baselineRevision: this.project.baseRevision,
      root: path.relative(path.resolve(this.project.rootPath), this.integrationRoot)
    })

    const conflicts: IntegrationConflict[] = []
    const checks: IntegrationCheck[] = []
    const applied: Array<{ taskId: string; files: string[] }> = []
    const appliedFiles: AppliedFile[] = []
    const owners = new Map<string, string>()
    const root = this.integrationRoot

    await rm(root, { recursive: true, force: true })
    await mkdir(root, { recursive: true })

    const baselineHashes = new Map<string, string>()
    for (const [filePath, content] of Object.entries(this.project.baselineFiles ?? {})) {
      const normalized = normalizePosixPath(filePath)
      if (normalized.startsWith('../') || path.isAbsolute(filePath)) {
        conflicts.push({
          path: filePath,
          firstTaskId: 'baseline',
          secondTaskId: 'baseline',
          reason: 'out-of-scope',
          detail: 'baseline file escapes the integration root'
        })
        continue
      }
      const absolute = this.resolveIntegrationPath(normalized)
      await mkdir(path.dirname(absolute), { recursive: true })
      await writeFile(absolute, content, 'utf8')
      baselineHashes.set(normalized, fileHash(content))
    }
    checks.push(
      baselineHashes.size > 0
        ? { id: 'baseline-manifest', status: 'passed', detail: `${baselineHashes.size} baseline files` }
        : { id: 'baseline-manifest', status: 'passed', detail: 'empty baseline (prototype)' }
    )

    const codeTasks = this.store.tasks.filter(
      (task) =>
        task.role !== 'tester' &&
        isTerminalTaskState(task.state) &&
        (task.state === 'succeeded' || task.state === 'reviewed' || task.state === 'integrated') &&
        task.fileChanges.length > 0
    )

    for (const task of codeTasks) {
      const taskFiles: string[] = []
      let validated
      try {
        validated = validateFileChanges(this.project, task, task.fileChanges)
      } catch (error) {
        conflicts.push({
          path: (task.fileChanges[0]?.path ?? '<none>'),
          firstTaskId: task.id,
          secondTaskId: 'policy',
          reason: 'permission-denied',
          detail: error instanceof Error ? error.message : String(error)
        })
        continue
      }

      for (const change of validated.changes) {
        const owner = owners.get(change.path)
        if (owner && owner !== task.id) {
          conflicts.push({
            path: change.path,
            firstTaskId: owner,
            secondTaskId: task.id,
            reason: 'duplicate-write',
            detail: 'two tasks produced changes for the same file; the second was not applied'
          })
          continue
        }
        const absolute = this.resolveIntegrationPath(change.path)
        const previousHash = await this.hashIfExists(absolute)
        const expected = change.baseHash ?? baselineHashes.get(change.path)
        if (expected && previousHash && previousHash !== expected) {
          conflicts.push({
            path: change.path,
            firstTaskId: task.id,
            secondTaskId: owner ?? 'baseline',
            reason: 'base-hash-mismatch',
            detail: `expected ${expected.slice(0, 12)} but found ${previousHash.slice(0, 12)}`
          })
          continue
        }
        if (change.deleted) {
          await rm(absolute, { force: true })
          appliedFiles.push({ taskId: task.id, path: change.path, hash: '' })
        } else {
          await mkdir(path.dirname(absolute), { recursive: true })
          await writeFile(absolute, change.content, 'utf8')
          appliedFiles.push({ taskId: task.id, path: change.path, hash: fileHash(change.content) })
        }
        owners.set(change.path, task.id)
        taskFiles.push(change.path)
      }
      if (taskFiles.length > 0) {
        applied.push({ taskId: task.id, files: taskFiles })
        this.store.emit('integration.applied', task.id, { files: taskFiles })
      }
    }

    checks.push({
      id: 'write-ownership',
      status: conflicts.some((conflict) => conflict.reason === 'duplicate-write') ? 'failed' : 'passed',
      detail: `${appliedFiles.length} files from ${applied.length} tasks`
    })

    // Evidence: every declared output must still verify against its hash.
    const artifactProblems: string[] = []
    for (const task of this.store.tasks) {
      if (task.state === 'failed' || task.state === 'cancelled') continue
      for (const ref of task.producedArtifacts) {
        const valid = await this.artifacts.verify(ref)
        if (!valid) artifactProblems.push(`${task.id}:${ref.name}@${ref.version}`)
      }
    }
    checks.push({
      id: 'artifact-hashes',
      status: artifactProblems.length === 0 ? 'passed' : 'failed',
      ...(artifactProblems.length > 0 ? { detail: `unverifiable: ${artifactProblems.join(', ')}` } : {})
    })

    // Contract consistency: the frontend must consume exactly the latest
    // contract produced by the backend.
    const contractCheck = await this.checkContractConsistency()
    checks.push(contractCheck)

    const missingDiffs = codeTasks.filter(
      (task) => task.fileChanges.length > 0 && !applied.some((entry) => entry.taskId === task.id)
    )
    checks.push({
      id: 'diffs-applied',
      status: missingDiffs.length === 0 ? 'passed' : 'failed',
      ...(missingDiffs.length > 0 ? { detail: `not applied: ${missingDiffs.map((task) => task.id).join(', ')}` } : {})
    })

    const buildProblems = await this.checkIntegratedFiles(appliedFiles)
    checks.push({
      id: 'integration-build',
      status: buildProblems.length === 0 ? 'passed' : 'failed',
      ...(buildProblems.length > 0 ? { detail: buildProblems.join('; ') } : {})
    })

    // A tester may already exist on resume; otherwise the gate runs before it
    // starts and the tester verifies this report separately.
    const tester = this.store.tasks.find((task) => task.role === 'tester')
    const testReport = tester?.producedArtifacts.find((ref) => ref.name === 'test-report')
    if (testReport && tester?.state === 'succeeded') {
      try {
        const parsed = JSON.parse(await this.artifacts.readText(testReport)) as { status?: string }
        checks.push({
          id: 'tester-report',
          status: parsed.status === 'passed' ? 'passed' : 'failed',
          detail: `test-report status=${String(parsed.status)}`
        })
      } catch (error) {
        checks.push({
          id: 'tester-report',
          status: 'failed',
          detail: error instanceof Error ? error.message : String(error)
        })
      }
    }

    for (const check of checks) {
      this.store.emit('integration.check', check.taskId, {
        checkId: check.id,
        status: check.status,
        detail: check.detail ?? null
      })
    }
    for (const conflict of conflicts) {
      this.store.emit('integration.conflict', conflict.secondTaskId, { ...conflict })
    }

    const hasFailedCheck = checks.some((check) => check.status === 'failed')
    const status: IntegrationReport['status'] =
      conflicts.length > 0 ? 'blocked' : hasFailedCheck ? 'failed' : 'passed'
    const finishedAt = this.clock.now()
    const evidenceFiles = appliedFiles.filter((file) => !file.path.endsWith('.json') || true)
    const integrationRevision = createHash('sha256')
      .update(
        JSON.stringify(
          evidenceFiles
            .map((file) => `${file.path}:${file.hash}`)
            .sort()
        )
      )
      .digest('hex')

    const report: IntegrationReport = {
      schemaVersion: '1.0',
      runId: this.store.run.runId,
      status,
      startedAt,
      finishedAt,
      applied,
      conflicts,
      checks,
      evidence: {
        baselineRevision: this.project.baseRevision,
        integrationRevision,
        files: appliedFiles.length,
        artifacts: this.store.snapshot.artifacts.map((ref) => ref.uri)
      },
      blockers: [
        ...conflicts.map((conflict) => `${conflict.reason}: ${conflict.path} (${conflict.firstTaskId} vs ${conflict.secondTaskId})`),
        ...checks.filter((check) => check.status === 'failed').map((check) => `${check.id}: ${check.detail ?? 'failed'}`)
      ]
    }

    this.store.setIntegration(report)
    if (status === 'passed') {
      this.store.emit('integration.passed', undefined, {
        files: report.evidence.files,
        integrationRevision
      })
    } else if (status === 'blocked') {
      this.store.emit('integration.blocked', undefined, {
        conflicts: conflicts.length,
        blockers: report.blockers
      })
    } else {
      this.store.emit('integration.failed', undefined, { checks: report.blockers })
    }
    await this.store.flush()
    return report
  }

  private async checkContractConsistency(): Promise<IntegrationCheck> {
    const contracts = this.store.snapshot.artifacts.filter((ref) => ref.kind === 'contract')
    const backend = this.store.tasks.find((task) => task.role === 'backend')
    if (!contracts.length) {
      return backend
        ? { id: 'contract-consistency', status: 'failed', detail: 'backend produced no contract artifact' }
        : { id: 'contract-consistency', status: 'passed', detail: 'no contract expected' }
    }
    const latest = [...contracts].sort((left, right) => right.createdAt - left.createdAt)[0]
    if (!latest) return { id: 'contract-consistency', status: 'failed', detail: 'contract lookup failed' }
    try {
      validateArtifactDraft({
        name: latest.name,
        version: latest.version,
        kind: latest.kind,
        content: await this.artifacts.readText(latest)
      })
    } catch (error) {
      return {
        id: 'contract-consistency',
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error)
      }
    }
    const consumers = this.store.tasks.filter(
      (task) => task.role === 'frontend' || task.role === 'tester'
    )
    for (const consumer of consumers) {
      if (consumer.state === 'failed' || consumer.state === 'cancelled') continue
      const pinned = consumer.resolvedInputs.filter((ref) => ref.kind === 'contract')
      if (consumer.role === 'frontend' && pinned.length === 0 && consumer.state === 'succeeded') {
        return {
          id: 'contract-consistency',
          status: 'failed',
          detail: `${consumer.id} succeeded without a pinned contract`
        }
      }
      for (const ref of pinned) {
        const matches = contracts.some((candidate) => candidate.sha256 === ref.sha256 && candidate.version === ref.version)
        if (!matches) {
          return {
            id: 'contract-consistency',
            status: 'failed',
            detail: `${consumer.id} pinned ${ref.name}@${ref.version} that no longer exists`
          }
        }
      }
    }
    return {
      id: 'contract-consistency',
      status: 'passed',
      detail: `${latest.name}@${latest.version} pinned by ${consumers.filter((task) => task.resolvedInputs.length > 0).length} consumers`
    }
  }

  private async checkIntegratedFiles(applied: AppliedFile[]): Promise<string[]> {
    const problems: string[] = []
    for (const file of applied) {
      if (file.path.endsWith('.json')) {
        try {
          JSON.parse(await readFile(this.resolveIntegrationPath(file.path), 'utf8'))
        } catch (error) {
          problems.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    return problems
  }

  private resolveIntegrationPath(relative: string): string {
    const normalized = normalizePosixPath(relative)
    const root = this.integrationRoot
    const absolute = path.resolve(root, ...normalized.split('/'))
    const relativeResult = path.relative(root, absolute)
    if (relativeResult.startsWith('..') || path.isAbsolute(relativeResult)) {
      throw new TeamError('integration-path-escape', `integration path ${relative} escapes the integration root`)
    }
    return absolute
  }

  private async hashIfExists(absolute: string): Promise<string | null> {
    try {
      const content = await readFile(absolute)
      return createHash('sha256').update(content).digest('hex')
    } catch {
      return null
    }
  }
}

export function integrationSummary(report: IntegrationReport): string {
  const applied = report.applied.reduce((sum, entry) => sum + entry.files.length, 0)
  return `${report.status}: ${applied} files applied, ${report.conflicts.length} conflicts, ${report.checks.filter((check) => check.status === 'failed').length} failed checks`
}

export function tasksWithChanges(tasks: readonly TaskRecord[]): TaskRecord[] {
  return tasks.filter((task) => task.fileChanges.length > 0)
}
