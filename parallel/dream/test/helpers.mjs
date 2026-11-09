/**
 * Shared test environment.
 *
 * Every test gets its own OS temp directory, its own file-backed version store,
 * its own evidence registry, and a deterministic clock. Nothing touches the real
 * OpenFuture application data directory or configuration.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  DreamingPipeline,
  EvidenceRegistry,
  FileDreamStore,
  HeuristicModel,
  PROJECT_ID,
  buildSyntheticInputs
} from '../src/index.mjs'

const BASE_TIME = Date.UTC(2026, 0, 15, 10, 0, 0)

export async function makeEnv(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dreaming-worker-test-'))
  let now = BASE_TIME
  const clock = () => {
    now += 1000
    return now
  }
  const state = {
    authorized: true,
    revokedSourceIds: [],
    policyCalls: 0
  }
  const store = new FileDreamStore({ root, clock })
  const registry = new EvidenceRegistry(PROJECT_ID)
  const model = options.model ?? new HeuristicModel({ name: 'heuristic-test' })
  const policyProvider =
    options.policyProvider ??
    (async ({ projectId }) => {
      state.policyCalls += 1
      return {
        authorized: state.authorized,
        projectId,
        revokedSourceIds: [...state.revokedSourceIds]
      }
    })
  const pipeline = new DreamingPipeline({
    store,
    registry,
    model,
    policyProvider,
    l3Budget: options.l3Budget ?? { maxLines: 40, maxBytes: 4096, maxTokens: 800 },
    maxDeleteRatio: options.maxDeleteRatio ?? 0.5,
    maxAttempts: options.maxAttempts ?? 2,
    sleep: async () => {},
    backoffMs: 1,
    clock
  })
  const fixture = options.fixture ?? buildSyntheticInputs()

  return {
    root,
    store,
    registry,
    model,
    pipeline,
    fixture,
    state,
    async cleanup() {
      await pipeline.close()
      await rm(root, { recursive: true, force: true })
    },
    async active() {
      return store.getActive(PROJECT_ID)
    }
  }
}

export async function runJob(env, { sessions, materials, trigger = 'manual' } = {}) {
  return env.pipeline.start({
    projectId: PROJECT_ID,
    sessions: sessions ?? env.fixture.sessions,
    materials: materials ?? env.fixture.materials,
    trigger
  })
}

export async function publishJob(env, job, actor = 'publisher@test.invalid') {
  return env.pipeline.publish(job.id, {
    approvedBy: actor,
    approvalToken: job.plan.planHash,
    note: 'synthetic acceptance approval'
  })
}

export function valuesOf(entries) {
  return entries.map((entry) => `${entry.subject}=${entry.value}`)
}
