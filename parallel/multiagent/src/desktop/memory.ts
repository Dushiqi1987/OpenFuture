/**
 * Read-only project memory projections.
 *
 * The desktop app never receives raw Pi transcripts. It receives curated,
 * traceable entries built from the persisted plan, task board, integration
 * report and published artifacts. Every entry carries refs back to the run so
 * the UI can show provenance instead of asking the model to remember.
 */

import type { ArtifactStore } from '../core/artifacts.ts'
import type { RunResult } from '../core/engine.ts'
import type { ArtifactRef, MemoryView, ProjectPolicy, TaskRecord } from '../core/types.ts'
import {
  DESKTOP_CONTRACT_VERSION,
  type MemoryEntry,
  type MemoryRef,
  type ProjectMemoryView,
  type RunMemoryView
} from './types.ts'

const MAX_ENTRIES = 160
const MAX_PROJECT_ENTRIES = 400
const MAX_EXCERPT_RAG = 600
const MAX_EXCERPT_WIKI = 1400

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi
]

export interface MemoryBuildOptions {
  artifactStore?: ArtifactStore
  now?: number
}

interface Redacted {
  text: string
  redactions: number
}

export function redactMemoryText(input: string): Redacted {
  let text = input
  let redactions = 0
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, () => {
      redactions += 1
      return '[redacted]'
    })
  }
  return { text, redactions }
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function excerpt(text: string, max: number): string {
  const collapsed = collapse(text)
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed
}

function refsForTask(task: TaskRecord, artifacts: ArtifactRef[] = []): MemoryRef[] {
  return [
    { kind: 'task', id: task.id, label: task.role },
    ...artifacts
      .filter((artifact) => artifact.taskId === task.id)
      .map((artifact) => ({ kind: 'artifact' as const, id: artifact.id, label: artifact.name }))
  ]
}

async function artifactExcerpt(
  artifact: ArtifactRef,
  store: ArtifactStore | undefined,
  view: MemoryView
): Promise<string | undefined> {
  if (!store) return undefined
  if (!artifact.mediaType.startsWith('text/') && artifact.mediaType !== 'application/json') return undefined
  try {
    const content = await store.readText(artifact)
    return excerpt(content, view === 'wiki' ? MAX_EXCERPT_WIKI : MAX_EXCERPT_RAG)
  } catch {
    return undefined
  }
}

function taskText(task: TaskRecord): string {
  const progress = task.progress
    .map((entry) => entry.message)
    .filter((message): message is string => typeof message === 'string' && message.length > 0)
    .slice(-4)
  if (task.error) {
    return `${task.state}: ${task.error.code} — ${task.error.message}`
  }
  if (progress.length > 0) return `${task.state}: ${progress.join(' · ')}`
  return `${task.state} (attempt ${task.attempt}/${task.budget.maxAttempts})`
}

/**
 * Build a run-scoped memory view. `off` deliberately returns no entries so the
 * caller cannot accidentally treat it as a fallback retrieval view.
 */
export async function buildRunMemory(
  result: RunResult,
  view: MemoryView,
  options: MemoryBuildOptions = {}
): Promise<RunMemoryView> {
  const generatedAt = options.now ?? Date.now()
  if (view === 'off') {
    return {
      schemaVersion: DESKTOP_CONTRACT_VERSION,
      projectId: result.projectId,
      runId: result.runId,
      view,
      generatedAt,
      entries: [],
      redactions: 0
    }
  }

  let redactions = 0
  const entries: MemoryEntry[] = []
  const add = (entry: MemoryEntry): void => {
    if (entries.length >= MAX_ENTRIES) return
    entries.push(entry)
  }
  const addText = (entry: Omit<MemoryEntry, 'text'>, text: string): void => {
    const redacted = redactMemoryText(text)
    redactions += redacted.redactions
    add({ ...entry, text: redacted.text })
  }

  addText(
    {
      id: `memory:goal:${result.runId}`,
      kind: 'goal',
      title: 'Run goal',
      refs: [
        { kind: 'run', id: result.runId },
        { kind: 'plan', id: result.plan.planId }
      ]
    },
    result.plan.mainGoal
  )

  for (const question of result.plan.sourceQuestions) {
    const intents = result.plan.intents.filter((intent) => intent.sourceQuestionIds.includes(question.id))
    const taskIds = intents.flatMap((intent) => intent.taskIds)
    addText(
      {
        id: `memory:question:${result.runId}:${question.id}`,
        kind: 'question',
        title: `Question ${question.index + 1}`,
        refs: [
          { kind: 'question', id: question.id },
          ...intents.map((intent) => ({ kind: 'intent' as const, id: intent.id })),
          ...taskIds.map((taskId) => ({ kind: 'task' as const, id: taskId }))
        ]
      },
      question.text
    )
  }

  if (view === 'wiki') {
    for (const intent of result.plan.intents) {
      addText(
        {
          id: `memory:intent:${result.runId}:${intent.id}`,
          kind: 'intent',
          title: `Intent ${intent.kind}`,
          refs: [
            { kind: 'intent', id: intent.id },
            ...intent.sourceQuestionIds.map((id) => ({ kind: 'question' as const, id })),
            ...intent.taskIds.map((id) => ({ kind: 'task' as const, id }))
          ]
        },
        intent.text
      )
    }
  }

  const artifacts = [...result.artifacts].sort((left, right) => left.createdAt - right.createdAt)
  for (const artifact of artifacts) {
    const content = await artifactExcerpt(artifact, options.artifactStore, view)
    addText(
      {
        id: `memory:artifact:${result.runId}:${artifact.id}`,
        kind: 'artifact',
        title: `${artifact.name}@${artifact.version} (${artifact.kind})`,
        runId: result.runId,
        sha256: artifact.sha256,
        refs: [
          { kind: 'artifact', id: artifact.id, label: artifact.name },
          { kind: 'task', id: artifact.taskId }
        ]
      },
      content ?? `${artifact.kind} artifact ${artifact.name}@${artifact.version} (${artifact.bytes} bytes)`
    )
  }

  const integration = result.integration
  const decisionText = integration
    ? [
        `Integration gate ${integration.status}.`,
        integration.applied.length > 0 ? `Applied ${integration.applied.length} task diff(s).` : 'No diffs applied.',
        integration.conflicts.length > 0
          ? `Conflicts: ${integration.conflicts
              .map((conflict) => `${conflict.reason} on ${conflict.path} (${conflict.firstTaskId}/${conflict.secondTaskId})`)
              .join('; ')}.`
          : '',
        integration.blockers.length > 0 ? `Blockers: ${integration.blockers.join('; ')}.` : ''
      ]
        .filter(Boolean)
        .join(' ')
    : `Integration gate has not run (run ${result.status}).`
  addText(
    {
      id: `memory:decision:${result.runId}:integration`,
      kind: 'decision',
      title: 'Integration decision',
      refs: integration
        ? [
            { kind: 'integration', id: result.runId },
            ...integration.applied.map((application) => ({ kind: 'task' as const, id: application.taskId }))
          ]
        : [{ kind: 'run', id: result.runId }]
    },
    decisionText
  )

  for (const task of result.tasks) {
    if (view === 'rag' && task.state !== 'failed') continue
    addText(
      {
        id: `memory:task:${result.runId}:${task.id}`,
        kind: 'task',
        title: `${task.role}: ${task.title}`,
        runId: result.runId,
        refs: refsForTask(task, artifacts)
      },
      taskText(task)
    )
  }

  for (const task of result.tasks.filter((candidate) => candidate.state === 'failed')) {
    const error = task.error
    addText(
      {
        id: `memory:failure:${result.runId}:${task.id}`,
        kind: 'failure',
        title: `Failed ${task.role} task`,
        runId: result.runId,
        refs: refsForTask(task, artifacts)
      },
      `${task.title}: ${error?.code ?? 'failed'} — ${error?.message ?? 'no error detail'} (escalated=${error?.escalatedToSuperAgent === true})`
    )
  }

  return {
    schemaVersion: DESKTOP_CONTRACT_VERSION,
    projectId: result.projectId,
    runId: result.runId,
    view,
    generatedAt,
    entries,
    redactions
  }
}

export async function buildProjectMemory(
  project: ProjectPolicy,
  results: RunResult[],
  view: MemoryView,
  options: MemoryBuildOptions = {}
): Promise<ProjectMemoryView> {
  const generatedAt = options.now ?? Date.now()
  if (view === 'off') {
    return {
      schemaVersion: DESKTOP_CONTRACT_VERSION,
      projectId: project.projectId,
      view,
      generatedAt,
      runs: [],
      entries: [],
      redactions: 0
    }
  }
  const runs: string[] = []
  const entries: MemoryEntry[] = []
  let redactions = 0
  for (const result of results) {
    const runView = await buildRunMemory(result, view, options)
    runs.push(result.runId)
    redactions += runView.redactions
    for (const entry of runView.entries) {
      if (entries.length >= MAX_PROJECT_ENTRIES) break
      entries.push({ ...entry, runId: result.runId, id: `${result.runId}:${entry.id}` })
    }
  }
  return {
    schemaVersion: DESKTOP_CONTRACT_VERSION,
    projectId: project.projectId,
    view,
    generatedAt,
    runs,
    entries,
    redactions
  }
}
