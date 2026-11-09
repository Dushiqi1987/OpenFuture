/**
 * Dream version store.
 *
 * Publication protocol (both implementations):
 *   1. version file is written to a temp path, fsynced and renamed
 *   2. an audit event is appended
 *   3. the state pointer is atomically replaced (compare expected revision)
 *
 * A crash before step 3 leaves a complete but inactive version ("orphan");
 * it is never partially visible. A retry with the same publishId + planHash is
 * idempotent. A retry with the same publishId but a different plan is a
 * conflict. Duplicate subjects / evidence checks live in publishing.mjs, not
 * here; the store only enforces the revision protocol.
 */

import { mkdir, open, readFile, readdir, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DreamError } from './errors.mjs'
import { buildL3Snapshot } from './l3.mjs'
import { contentHash, deepClone, shortId } from './util.mjs'

export function versionIdFor(projectId, revision) {
  return shortId('ver', { projectId, revision }, 24)
}

function versionFileName(revision) {
  return `v${String(revision).padStart(6, '0')}.json`
}

function initialState(projectId, now) {
  return {
    projectId,
    activeRevision: 0,
    activeVersionId: null,
    updatedAt: now,
    lastPublishId: null
  }
}

export function emptyVersion({ projectId, revision = 1, parent = null, now = Date.now(), actor = 'system' }) {
  const l3 = buildL3Snapshot([], undefined)
  return {
    versionId: versionIdFor(projectId, revision),
    projectId,
    revision,
    parentVersionId: parent?.versionId ?? null,
    parentRevision: parent?.revision ?? null,
    createdAt: now,
    createdBy: actor,
    kind: 'init',
    publishId: `init:${projectId}:${revision}`,
    planHash: contentHash({ projectId, revision, kind: 'init' }),
    entries: [],
    conflicts: [],
    l3: { text: l3.text, stats: l3.stats, hash: l3.hash },
    approval: { approvedBy: null, approvedAt: null },
    reason: 'Initial empty project memory'
  }
}

function structuralCheck(projectId, version) {
  if (!version || version.projectId !== projectId) {
    throw new DreamError('PROJECT_MISMATCH', 'Version belongs to another project')
  }
  if (!Number.isInteger(version.revision) || version.revision < 1) {
    throw new DreamError('VALIDATION', 'Version revision must be a positive integer')
  }
  if (version.versionId !== versionIdFor(projectId, version.revision)) {
    throw new DreamError('VALIDATION', 'Version id does not match project/revision')
  }
  if (!Array.isArray(version.entries)) throw new DreamError('VALIDATION', 'Version entries must be an array')
  if (!Array.isArray(version.conflicts)) throw new DreamError('VALIDATION', 'Version conflicts must be an array')
  if (!version.publishId || typeof version.publishId !== 'string') {
    throw new DreamError('VALIDATION', 'Version needs a publishId')
  }
  if (!version.planHash || typeof version.planHash !== 'string') {
    throw new DreamError('VALIDATION', 'Version needs a planHash')
  }
  if (!version.l3 || typeof version.l3.text !== 'string') {
    throw new DreamError('VALIDATION', 'Version needs an L3 snapshot')
  }
}

async function atomicWrite(file, text) {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  const handle = await open(temp, 'w')
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, file)
}

export class MemoryDreamStore {
  constructor({ clock = Date.now } = {}) {
    this.clock = clock
    this.projects = new Map()
  }

  #ensure(projectId) {
    if (!this.projects.has(projectId)) {
      const state = initialState(projectId, this.clock())
      const version = emptyVersion({ projectId, revision: 1, now: this.clock() })
      state.activeRevision = 1
      state.activeVersionId = version.versionId
      this.projects.set(projectId, {
        state,
        versions: new Map([[1, version]]),
        audit: [
          {
            at: state.updatedAt,
            action: 'init',
            projectId,
            revision: 1,
            versionId: version.versionId,
            publishId: version.publishId,
            planHash: version.planHash,
            actor: 'system'
          }
        ]
      })
    }
    return this.projects.get(projectId)
  }

  async ensureProject(projectId) {
    this.#ensure(projectId)
    return { state: deepClone(this.#ensure(projectId).state), version: deepClone(await this.getActive(projectId)) }
  }

  async getActive(projectId) {
    const project = this.#ensure(projectId)
    return deepClone(project.versions.get(project.state.activeRevision))
  }

  async getVersion(projectId, revision) {
    const project = this.#ensure(projectId)
    const version = project.versions.get(revision)
    return version ? deepClone(version) : null
  }

  async listVersions(projectId) {
    const project = this.#ensure(projectId)
    return [...project.versions.values()]
      .sort((a, b) => b.revision - a.revision)
      .map((version) => ({
        versionId: version.versionId,
        revision: version.revision,
        active: version.revision === project.state.activeRevision,
        createdAt: version.createdAt,
        createdBy: version.createdBy,
        kind: version.kind,
        publishId: version.publishId,
        planHash: version.planHash,
        entryCount: version.entries.length,
        orphan: version.revision > project.state.activeRevision
      }))
  }

  async commit(projectId, { expectedRevision, version, approval = null }) {
    structuralCheck(projectId, version)
    const project = this.#ensure(projectId)
    const existing = [...project.versions.values()].find((candidate) => candidate.publishId === version.publishId)
    if (existing) {
      if (existing.planHash !== version.planHash) {
        throw new DreamError('PUBLISH_IDEMPOTENT_MISMATCH', 'publishId was already used by a different plan')
      }
      if (project.state.activeRevision < existing.revision) {
        project.state.activeRevision = existing.revision
        project.state.activeVersionId = existing.versionId
        project.state.lastPublishId = existing.publishId
        project.state.updatedAt = this.clock()
      }
      return { kind: 'idempotent', version: deepClone(existing) }
    }
    if (project.state.activeRevision !== expectedRevision) {
      throw new DreamError('PUBLISH_CONFLICT', 'Active revision changed since the plan was built', {
        details: { activeRevision: project.state.activeRevision, expectedRevision }
      })
    }
    if (version.revision !== expectedRevision + 1) {
      throw new DreamError('PUBLISH_CONFLICT', 'New version revision must follow the active revision', {
        details: { activeRevision: expectedRevision, incomingRevision: version.revision }
      })
    }
    if (version.parentRevision !== expectedRevision) {
      throw new DreamError('PUBLISH_CONFLICT', 'Version parent does not match the active revision')
    }
    project.versions.set(version.revision, deepClone(version))
    project.state.activeRevision = version.revision
    project.state.activeVersionId = version.versionId
    project.state.lastPublishId = version.publishId
    project.state.updatedAt = this.clock()
    project.audit.push({
      at: project.state.updatedAt,
      action: version.kind === 'rollback' ? 'rollback' : 'publish',
      projectId,
      revision: version.revision,
      parentRevision: version.parentRevision,
      versionId: version.versionId,
      publishId: version.publishId,
      planHash: version.planHash,
      actor: approval?.approvedBy ?? version.approval?.approvedBy ?? 'user',
      reason: version.reason ?? null,
      entryCount: version.entries.length,
      l3Hash: version.l3.hash
    })
    return { kind: 'applied', version: deepClone(version) }
  }

  async readAudit(projectId, { limit = 100 } = {}) {
    const project = this.#ensure(projectId)
    return deepClone(project.audit.slice(-limit))
  }

  async close() {}
}

export class FileDreamStore {
  constructor({ root, clock = Date.now } = {}) {
    if (!root) throw new DreamError('VALIDATION', 'FileDreamStore needs a root directory')
    this.root = root
    this.clock = clock
    this.locks = new Map()
  }

  #dir(projectId) {
    return join(this.root, `project-${contentHash(projectId).slice(0, 16)}`)
  }

  #stateFile(projectId) {
    return join(this.#dir(projectId), 'state.json')
  }

  #versionsDir(projectId) {
    return join(this.#dir(projectId), 'versions')
  }

  #versionFile(projectId, revision) {
    return join(this.#versionsDir(projectId), versionFileName(revision))
  }

  #auditFile(projectId) {
    return join(this.#dir(projectId), 'audit.jsonl')
  }

  async #lock(projectId, fn) {
    const prior = this.locks.get(projectId) ?? Promise.resolve()
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const chained = prior.then(() => gate)
    this.locks.set(projectId, chained)
    await prior
    try {
      return await fn()
    } finally {
      release()
      if (this.locks.get(projectId) === chained) this.locks.delete(projectId)
    }
  }

  async #readJson(file) {
    try {
      return JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw new DreamError('STORE_IO', `Cannot read ${file}`, { cause: error })
    }
  }

  async #writeJson(file, value) {
    try {
      await atomicWrite(file, JSON.stringify(value, null, 2))
    } catch (error) {
      throw new DreamError('STORE_IO', `Cannot write ${file}`, { cause: error })
    }
  }

  async #readState(projectId) {
    return this.#readJson(this.#stateFile(projectId))
  }

  async #listVersionFiles(projectId) {
    try {
      return (await readdir(this.#versionsDir(projectId)))
        .filter((name) => /^v\d{6}\.json$/.test(name))
        .sort()
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw new DreamError('STORE_IO', 'Cannot list version files', { cause: error })
    }
  }

  async #ensure(projectId) {
    const dir = this.#dir(projectId)
    await mkdir(this.#versionsDir(projectId), { recursive: true })
    let state = await this.#readState(projectId)
    const files = await this.#listVersionFiles(projectId)
    if (!state) {
      if (files.length === 0) {
        const version = emptyVersion({ projectId, revision: 1, now: this.clock() })
        await this.#writeVersion(projectId, version)
        state = initialState(projectId, this.clock())
        state.activeRevision = 1
        state.activeVersionId = version.versionId
        state.lastPublishId = version.publishId
        await this.#writeJson(this.#stateFile(projectId), state)
        await this.#appendAudit(projectId, {
          at: state.updatedAt,
          action: 'init',
          projectId,
          revision: 1,
          versionId: version.versionId,
          publishId: version.publishId,
          planHash: version.planHash,
          actor: 'system'
        })
      } else {
        const versions = await Promise.all(
          files.map((name) => this.#readJson(join(this.#versionsDir(projectId), name)))
        )
        const highest = versions.sort((a, b) => b.revision - a.revision)[0]
        state = initialState(projectId, this.clock())
        state.activeRevision = highest.revision
        state.activeVersionId = highest.versionId
        state.lastPublishId = highest.publishId
        await this.#writeJson(this.#stateFile(projectId), state)
      }
    }
    if (state.projectId !== projectId) throw new DreamError('PROJECT_MISMATCH', 'State file belongs to another project')
    if (!state.activeVersionId) throw new DreamError('STORE_IO', 'State has no active version')
    return state
  }

  async #writeVersion(projectId, version) {
    structuralCheck(projectId, version)
    await mkdir(this.#versionsDir(projectId), { recursive: true })
    await this.#writeJson(this.#versionFile(projectId, version.revision), {
      ...version,
      projectDir: undefined
    })
  }

  async #appendAudit(projectId, event) {
    const file = this.#auditFile(projectId)
    await mkdir(this.#dir(projectId), { recursive: true })
    const handle = await open(file, 'a')
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  async #writeState(projectId, state) {
    await this.#writeJson(this.#stateFile(projectId), state)
  }

  async #loadVersion(projectId, revision) {
    const version = await this.#readJson(this.#versionFile(projectId, revision))
    if (!version) return null
    structuralCheck(projectId, version)
    return version
  }

  async #listVersions(projectId, state) {
    const files = await this.#listVersionFiles(projectId)
    const out = []
    for (const name of files) {
      const version = await this.#readJson(join(this.#versionsDir(projectId), name))
      if (!version) continue
      out.push({
        versionId: version.versionId,
        revision: version.revision,
        active: version.revision === state.activeRevision,
        createdAt: version.createdAt,
        createdBy: version.createdBy,
        kind: version.kind,
        publishId: version.publishId,
        planHash: version.planHash,
        entryCount: version.entries.length,
        orphan: version.revision > state.activeRevision
      })
    }
    return out.sort((a, b) => b.revision - a.revision)
  }

  async ensureProject(projectId) {
    return this.#lock(projectId, async () => {
      const state = await this.#ensure(projectId)
      const version = await this.#loadVersion(projectId, state.activeRevision)
      if (!version) throw new DreamError('STORE_IO', 'Active version file is missing')
      return { state: structuredClone(state), version }
    })
  }

  async getActive(projectId) {
    return this.#lock(projectId, async () => {
      const state = await this.#ensure(projectId)
      const version = await this.#loadVersion(projectId, state.activeRevision)
      if (!version) throw new DreamError('STORE_IO', 'Active version file is missing')
      return version
    })
  }

  async getVersion(projectId, revision) {
    return this.#lock(projectId, async () => {
      await this.#ensure(projectId)
      return this.#loadVersion(projectId, revision)
    })
  }

  async listVersions(projectId) {
    return this.#lock(projectId, async () => {
      const state = await this.#ensure(projectId)
      return this.#listVersions(projectId, state)
    })
  }

  async readAudit(projectId, { limit = 100 } = {}) {
    return this.#lock(projectId, async () => {
      await this.#ensure(projectId)
      try {
        const text = await readFile(this.#auditFile(projectId), 'utf8')
        return text
          .split('\n')
          .filter(Boolean)
          .slice(-limit)
          .map((line) => JSON.parse(line))
      } catch (error) {
        if (error?.code === 'ENOENT') return []
        throw new DreamError('STORE_IO', 'Cannot read audit log', { cause: error })
      }
    })
  }

  async commit(projectId, { expectedRevision, version, approval = null }) {
    return this.#lock(projectId, async () => {
      structuralCheck(projectId, version)
      const state = await this.#ensure(projectId)
      const versions = await this.#listVersions(projectId, state)
      const existingMeta = versions.find((candidate) => candidate.publishId === version.publishId)
      if (existingMeta) {
        const existing = await this.#loadVersion(projectId, existingMeta.revision)
        if (existing.planHash !== version.planHash) {
          throw new DreamError('PUBLISH_IDEMPOTENT_MISMATCH', 'publishId was already used by a different plan')
        }
        if (state.activeRevision < existing.revision) {
          state.activeRevision = existing.revision
          state.activeVersionId = existing.versionId
          state.lastPublishId = existing.publishId
          state.updatedAt = this.clock()
          await this.#writeState(projectId, state)
        }
        return { kind: 'idempotent', version: existing }
      }
      if (state.activeRevision !== expectedRevision) {
        throw new DreamError('PUBLISH_CONFLICT', 'Active revision changed since the plan was built', {
          details: { activeRevision: state.activeRevision, expectedRevision }
        })
      }
      if (version.revision !== expectedRevision + 1) {
        throw new DreamError('PUBLISH_CONFLICT', 'New version revision must follow the active revision', {
          details: { activeRevision: expectedRevision, incomingRevision: version.revision }
        })
      }
      if (version.parentRevision !== expectedRevision) {
        throw new DreamError('PUBLISH_CONFLICT', 'Version parent does not match the active revision')
      }
      await this.#writeVersion(projectId, version)
      const event = {
        at: this.clock(),
        action: version.kind === 'rollback' ? 'rollback' : 'publish',
        projectId,
        revision: version.revision,
        parentRevision: version.parentRevision,
        versionId: version.versionId,
        publishId: version.publishId,
        planHash: version.planHash,
        actor: approval?.approvedBy ?? version.approval?.approvedBy ?? 'user',
        reason: version.reason ?? null,
        entryCount: version.entries.length,
        l3Hash: version.l3.hash
      }
      await this.#appendAudit(projectId, event)
      state.activeRevision = version.revision
      state.activeVersionId = version.versionId
      state.lastPublishId = version.publishId
      state.updatedAt = this.clock()
      await this.#writeState(projectId, state)
      return { kind: 'applied', version }
    })
  }

  /** Test hook: simulate a crash after the version file, before the pointer. */
  async simulateCrashAfterVersion(projectId, version) {
    return this.#lock(projectId, async () => {
      const state = await this.#ensure(projectId)
      if (version.revision !== state.activeRevision + 1) {
        throw new DreamError('PUBLISH_CONFLICT', 'Crash simulation needs the next revision')
      }
      await this.#writeVersion(projectId, version)
      throw new Error('simulated crash after version write')
    })
  }

  async statProject(projectId) {
    const dir = this.#dir(projectId)
    const files = await this.#listVersionFiles(projectId)
    return {
      dir,
      versionFiles: files.length,
      size: files.length === 0 ? 0 : (await stat(join(dir, 'versions'))).size
    }
  }

  async close() {}
}
