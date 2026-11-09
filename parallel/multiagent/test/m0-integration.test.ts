import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { ArtifactStore } from '../src/core/artifacts.ts'
import { IntegrationRunner } from '../src/core/integration.ts'
import { createSyntheticPlan } from '../src/core/plan.ts'
import { RunStore } from '../src/core/store.ts'
import type { Plan, TaskRecord, TaskSpec } from '../src/core/types.ts'
import { createSequentialIdFactory } from '../src/core/util.ts'
import { makeTaskRecord, makeTempRoot } from './helpers.ts'

test('integration gate blocks two tasks writing the same shared file and keeps the first content', async () => {
  const root = await makeTempRoot('openfuture-conflict-')
  try {
    const synthetic = createSyntheticPlan({
      project: { rootPath: root, integrationRoot: '.scratch/integration' }
    })
    const baseTask = synthetic.plan.tasks.find((task) => task.role === 'backend')
    assert.ok(baseTask)

    const firstSpec: TaskSpec = {
      ...structuredClone(baseTask),
      id: 'writer-one',
      title: 'writer one',
      dependsOn: [],
      inputArtifacts: [],
      outputs: [],
      acceptance: [],
      writeScope: ['src/shared.ts']
    }
    const secondSpec: TaskSpec = {
      ...structuredClone(firstSpec),
      id: 'writer-two',
      title: 'writer two'
    }
    const plan: Plan = {
      ...structuredClone(synthetic.plan),
      planId: 'plan-conflict-1',
      runId: 'run-conflict-1',
      tasks: [firstSpec, secondSpec],
      intents: [
        {
          id: 'intent-conflict',
          kind: 'backend',
          text: 'two tasks write the same file',
          sourceQuestionIds: ['q1'],
          taskIds: [firstSpec.id, secondSpec.id]
        }
      ],
      sourceQuestions: [{ id: 'q1', index: 0, text: 'two tasks write the same file' }]
    }
    const project = { ...synthetic.project, integrationRoot: '.scratch/integration' }
    const firstContent = '// first writer\n'
    const secondContent = '// second writer\n'
    const first = makeTaskRecord(firstSpec, project, plan.runId, 1, {
      state: 'succeeded',
      fileChanges: [{ path: 'src/shared.ts', content: firstContent }]
    })
    const second = makeTaskRecord(secondSpec, project, plan.runId, 2, {
      state: 'succeeded',
      fileChanges: [{ path: 'src/shared.ts', content: secondContent }]
    })
    const store = await RunStore.create(project, plan, [first, second] as TaskRecord[], {
      clock: { now: () => 1_700_000_000_000 }
    })
    const ids = createSequentialIdFactory('conflict')
    const artifacts = new ArtifactStore(project, { idFactory: ids })
    const runner = new IntegrationRunner(project, store, artifacts)

    const report = await runner.run()

    assert.equal(report.status, 'blocked')
    assert.ok(report.conflicts.length >= 1)
    const conflict = report.conflicts.find((candidate) => candidate.path === 'src/shared.ts')
    assert.ok(conflict)
    assert.equal(conflict.reason, 'duplicate-write')
    assert.equal(conflict.firstTaskId, 'writer-one')
    assert.equal(conflict.secondTaskId, 'writer-two')
    assert.equal(report.applied.length, 1)
    assert.deepEqual(report.applied[0]?.files, ['src/shared.ts'])

    const integrated = await readFile(path.join(runner.integrationRoot, 'src/shared.ts'), 'utf8')
    assert.equal(integrated, firstContent)
    assert.ok(report.blockers.some((blocker) => blocker.includes('src/shared.ts')))
  } finally {
    await import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true }))
  }
})
