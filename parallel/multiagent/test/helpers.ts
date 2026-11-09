import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { TeamRuntime, type CreateTeamRuntimeOptions } from '../src/core/engine.ts'
import { createSyntheticPlan } from '../src/core/plan.ts'
import { simulatedWorkerFactory } from '../src/core/simulated-worker.ts'
import type { Plan, ProjectPolicy, TaskRecord, TaskSpec } from '../src/core/types.ts'
import { createSequentialIdFactory, sleep } from '../src/core/util.ts'

export interface SyntheticFixture {
  root: string
  project: ProjectPolicy
  plan: Plan
  runtime: TeamRuntime
  cleanup: () => Promise<void>
}

export async function makeTempRoot(prefix = 'openfuture-m0-'): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), prefix))
}

export async function makeSyntheticFixture(options: {
  project?: Partial<ProjectPolicy>
  workerFactory?: CreateTeamRuntimeOptions['workerFactory']
  mutatePlan?: (plan: Plan) => void
  maxConcurrency?: number
} = {}): Promise<SyntheticFixture> {
  const root = await makeTempRoot()
  const synthetic = createSyntheticPlan({ project: { rootPath: root, ...options.project } })
  options.mutatePlan?.(synthetic.plan)
  const runtime = await TeamRuntime.create({
    project: synthetic.project,
    plan: synthetic.plan,
    workerFactory: options.workerFactory ?? simulatedWorkerFactory(),
    maxConcurrency: options.maxConcurrency
  })
  return {
    root,
    project: synthetic.project,
    plan: synthetic.plan,
    runtime,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true })
    }
  }
}

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 2000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await sleep(10)
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
}

export function taskByRole(planOrTasks: Plan | readonly TaskRecord[], role: string): TaskSpec | TaskRecord {
  if ('tasks' in planOrTasks) {
    const task = planOrTasks.tasks.find((candidate) => candidate.role === role)
    if (!task) throw new Error(`plan has no ${role} task`)
    return task
  }
  const task = planOrTasks.find((candidate) => candidate.role === role)
  if (!task) throw new Error(`run has no ${role} task`)
  return task
}

export async function readText(filePath: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  return await readFile(filePath, 'utf8')
}

export function makeTaskRecord(spec: TaskSpec, project: ProjectPolicy, runId: string, ordinal: number, overrides: Partial<TaskRecord> = {}): TaskRecord {
  const ids = createSequentialIdFactory(`record-${ordinal}`)
  const now = Date.now()
  return {
    ...spec,
    projectId: project.projectId,
    runId,
    agentId: ids.agent(spec.id),
    state: 'succeeded',
    attempt: 1,
    attempts: [
      {
        attempt: 1,
        startedAt: now,
        finishedAt: now + 5,
        status: 'succeeded',
        progress: []
      }
    ],
    producedArtifacts: [],
    resolvedInputs: [],
    fileChanges: [],
    checks: [{ id: 'recorded-check', status: 'passed' }],
    progress: [],
    startedAt: now,
    finishedAt: now + 5,
    ...overrides
  }
}
