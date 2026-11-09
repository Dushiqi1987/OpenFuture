/**
 * Immutable, content-addressed artifact storage.
 *
 * Artifacts live inside the run's project root and are referenced by relative
 * POSIX URI. Publishing never overwrites: a new version gets a new file, so
 * consumers can prove exactly which contract/report they used.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { TeamError } from './errors.ts'
import { matchesScope } from './roles.ts'
import type {
  ArtifactDraft,
  ArtifactKind,
  ArtifactRef,
  FileChange,
  ProjectPolicy,
  TaskSpec
} from './types.ts'
import { createIdFactory, normalizePosixPath, systemClock, type Clock, type IdFactory } from './util.ts'

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024
const MAX_CHANGED_FILES = 64
const MAX_FILE_BYTES = 512 * 1024

export const ARTIFACT_DIR = 'artifacts'

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const DEFAULT_MEDIA_TYPES: Record<ArtifactKind, string> = {
  'research-report': 'text/markdown',
  contract: 'application/json',
  'code-diff': 'text/plain',
  'test-report': 'application/json',
  review: 'text/markdown',
  generic: 'text/plain'
}

const DEFAULT_EXTENSIONS: Record<ArtifactKind, string> = {
  'research-report': 'md',
  contract: 'json',
  'code-diff': 'diff',
  'test-report': 'json',
  review: 'md',
  generic: 'txt'
}

export interface ArtifactPublishInput {
  runId: string
  projectId: string
  taskId: string
  draft: ArtifactDraft
}

export interface ArtifactStoreOptions {
  artifactDir?: string
  clock?: Clock
  idFactory?: IdFactory
}

export function isValidContract(content: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return 'contract is not valid JSON'
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'contract must be a JSON object'
  const document = parsed as Record<string, unknown>
  if (typeof document.openapi !== 'string' || !document.openapi.startsWith('3.')) {
    return 'contract must declare openapi 3.x'
  }
  const info = document.info
  if (!info || typeof info !== 'object') return 'contract must declare info'
  const infoRecord = info as Record<string, unknown>
  if (typeof infoRecord.title !== 'string' || !infoRecord.title) return 'contract info.title is required'
  if (typeof infoRecord.version !== 'string' || !infoRecord.version) return 'contract info.version is required'
  const paths = document.paths
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) return 'contract paths must be an object'
  const entries = Object.entries(paths as Record<string, unknown>)
  if (entries.length === 0) return 'contract paths must not be empty'
  for (const [route, item] of entries) {
    if (!route.startsWith('/')) return `contract path ${route} must start with /`
    if (!item || typeof item !== 'object' || Array.isArray(item)) return `contract path ${route} must be an object`
    const operations = Object.entries(item as Record<string, unknown>)
    if (operations.length === 0) return `contract path ${route} has no operations`
    for (const [method, operation] of operations) {
      if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method)) {
        return `contract path ${route} has unsupported operation ${method}`
      }
      if (!operation || typeof operation !== 'object') return `contract ${method.toUpperCase()} ${route} must be an object`
      const responses = (operation as Record<string, unknown>).responses
      if (!responses || typeof responses !== 'object') {
        return `contract ${method.toUpperCase()} ${route} must declare responses`
      }
    }
  }
  return null
}

export function validateArtifactDraft(draft: ArtifactDraft): void {
  if (!draft || typeof draft !== 'object') {
    throw new TeamError('artifact-invalid', 'artifact draft is required')
  }
  if (!NAME_PATTERN.test(draft.name)) {
    throw new TeamError('artifact-invalid', `artifact name ${JSON.stringify(draft.name)} is not a safe file name`)
  }
  if (!VERSION_PATTERN.test(draft.version)) {
    throw new TeamError('artifact-invalid', `artifact version ${JSON.stringify(draft.version)} is invalid`)
  }
  if (typeof draft.content !== 'string') {
    throw new TeamError('artifact-invalid', 'artifact content must be a string')
  }
  if (Buffer.byteLength(draft.content) > MAX_ARTIFACT_BYTES) {
    throw new TeamError('artifact-too-large', `artifact ${draft.name} exceeds ${MAX_ARTIFACT_BYTES} bytes`)
  }
  if (draft.kind !== 'generic' && draft.content.trim().length === 0) {
    throw new TeamError('artifact-invalid', `artifact ${draft.name} must not be empty`)
  }
  if (draft.kind === 'contract') {
    const problem = isValidContract(draft.content)
    if (problem) {
      throw new TeamError('contract-invalid', problem, { name: draft.name })
    }
  }
  if (draft.kind === 'test-report') {
    let parsed: unknown
    try {
      parsed = JSON.parse(draft.content)
    } catch {
      throw new TeamError('artifact-invalid', 'test-report must be valid JSON')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TeamError('artifact-invalid', 'test-report must be a JSON object')
    }
    const report = parsed as Record<string, unknown>
    if (typeof report.status !== 'string' || !['passed', 'failed', 'blocked'].includes(report.status)) {
      throw new TeamError('artifact-invalid', 'test-report status must be passed, failed or blocked')
    }
    if (!Array.isArray(report.checks)) {
      throw new TeamError('artifact-invalid', 'test-report checks must be an array')
    }
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_')
}

function extensionFor(name: string, kind: ArtifactKind): string {
  const existing = path.extname(name)
  if (existing.length > 1) return ''
  return `.${DEFAULT_EXTENSIONS[kind]}`
}

export class ArtifactStore {
  readonly root: string
  readonly artifactDir: string
  private readonly clock: Clock
  private readonly ids: IdFactory

  constructor(project: ProjectPolicy, options: ArtifactStoreOptions = {}) {
    this.root = path.resolve(project.rootPath)
    this.artifactDir = options.artifactDir ?? ARTIFACT_DIR
    this.clock = options.clock ?? systemClock
    this.ids = options.idFactory ?? createIdFactory()
  }

  async publish(input: ArtifactPublishInput): Promise<ArtifactRef> {
    const { draft } = input
    validateArtifactDraft(draft)
    if (!input.runId || !input.projectId || !input.taskId) {
      throw new TeamError('artifact-invalid', 'runId, projectId and taskId are required')
    }

    const id = this.ids.artifact(draft.content)
    const fileName = `${safeSegment(id)}-${safeSegment(draft.name)}${extensionFor(draft.name, draft.kind)}`
    const relative = normalizePosixPath(path.posix.join(this.artifactDir, input.runId, input.taskId, fileName))
    const absolute = this.resolveUri(relative)
    const buffer = Buffer.from(draft.content, 'utf8')
    const digest = createHash('sha256').update(buffer).digest('hex')

    await mkdir(path.dirname(absolute), { recursive: true })
    const temporary = `${absolute}.tmp-${this.ids.message()}`
    await writeFile(temporary, buffer, { flag: 'wx' })
    await rename(temporary, absolute)

    return {
      id,
      runId: input.runId,
      projectId: input.projectId,
      taskId: input.taskId,
      name: draft.name,
      version: draft.version,
      kind: draft.kind,
      mediaType: draft.mediaType ?? DEFAULT_MEDIA_TYPES[draft.kind],
      sha256: digest,
      bytes: buffer.byteLength,
      createdAt: this.clock.now(),
      uri: relative
    }
  }

  resolveUri(uri: string): string {
    const normalized = normalizePosixPath(uri)
    const absolute = path.resolve(this.root, ...normalized.split('/'))
    const relative = path.relative(this.root, absolute)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new TeamError('artifact-outside-root', `artifact uri ${uri} escapes the project root`)
    }
    return absolute
  }

  async read(ref: Pick<ArtifactRef, 'uri' | 'sha256'>): Promise<Buffer> {
    const buffer = await readFile(this.resolveUri(ref.uri))
    const digest = createHash('sha256').update(buffer).digest('hex')
    if (digest !== ref.sha256) {
      throw new TeamError('artifact-corrupt', `artifact ${ref.uri} hash does not match its reference`, {
        expected: ref.sha256,
        actual: digest
      })
    }
    return buffer
  }

  async readText(ref: Pick<ArtifactRef, 'uri' | 'sha256'>): Promise<string> {
    return (await this.read(ref)).toString('utf8')
  }

  async verify(ref: Pick<ArtifactRef, 'uri' | 'sha256' | 'bytes'>): Promise<boolean> {
    try {
      const info = await stat(this.resolveUri(ref.uri))
      if (!info.isFile() || info.size !== ref.bytes) return false
      const buffer = await readFile(this.resolveUri(ref.uri))
      return createHash('sha256').update(buffer).digest('hex') === ref.sha256
    } catch {
      return false
    }
  }
}

export interface ValidatedChanges {
  changes: FileChange[]
  paths: string[]
}

/**
 * A worker may only propose changes it is allowed to make. This gate runs
 * before anything reaches the integration copy, and again during integration.
 */
export function validateFileChanges(
  project: ProjectPolicy,
  task: Pick<TaskSpec, 'id' | 'writeScope' | 'role'>,
  changes: readonly FileChange[]
): ValidatedChanges {
  if (changes.length > MAX_CHANGED_FILES) {
    throw new TeamError('file-change-too-many', `task ${task.id} proposes more than ${MAX_CHANGED_FILES} files`)
  }
  const seen = new Set<string>()
  const validated: FileChange[] = []
  for (const change of changes) {
    if (!change || typeof change.path !== 'string' || !change.path.trim()) {
      throw new TeamError('file-change-invalid', `task ${task.id} has a change without a path`)
    }
    const normalized = normalizePosixPath(change.path)
    if (normalized.startsWith('../') || normalized === '..' || path.isAbsolute(change.path)) {
      throw new TeamError('file-change-invalid', `task ${task.id} proposes an escaping path ${change.path}`)
    }
    if (normalized.startsWith('.git/') || normalized === '.git') {
      throw new TeamError('file-change-denied', `task ${task.id} may not touch ${normalized}`)
    }
    if (seen.has(normalized)) {
      throw new TeamError('file-change-duplicate', `task ${task.id} proposes ${normalized} twice`)
    }
    seen.add(normalized)
    if (!project.allowedWritePaths.some((scope) => matchesScope(scope, normalized))) {
      throw new TeamError('file-change-denied', `task ${task.id} may not write ${normalized} outside project policy`)
    }
    if (task.writeScope.length === 0 || !task.writeScope.some((scope) => matchesScope(scope, normalized))) {
      throw new TeamError('file-change-denied', `task ${task.id} may not write ${normalized} under its role scope`)
    }
    if (change.deleted) {
      validated.push({ path: normalized, content: '', baseHash: change.baseHash, deleted: true })
      continue
    }
    if (typeof change.content !== 'string') {
      throw new TeamError('file-change-invalid', `task ${task.id} change ${normalized} needs content`)
    }
    if (Buffer.byteLength(change.content) > MAX_FILE_BYTES) {
      throw new TeamError('file-change-too-large', `task ${task.id} change ${normalized} is too large`)
    }
    if (change.baseHash !== undefined && !/^[a-f0-9]{64}$/.test(change.baseHash)) {
      throw new TeamError('file-change-invalid', `task ${task.id} change ${normalized} has an invalid baseHash`)
    }
    validated.push({
      path: normalized,
      content: change.content,
      ...(change.baseHash ? { baseHash: change.baseHash } : {})
    })
  }
  return { changes: validated, paths: [...seen] }
}

export function fileHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}
