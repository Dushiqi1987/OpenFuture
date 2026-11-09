/**
 * Phase 1: Ingest (deterministic, no model calls).
 *
 * Reads only sessions that an explicit project policy marks authorized and
 * completed, keeps originals, and records message-level evidence incrementally.
 * The following are never ingested as evidence:
 *   - sessions from another project or without authorization
 *   - incomplete sessions / incomplete branches
 *   - system prompts
 *   - reasoning / hidden thoughts
 *   - application-injected context from an older turn
 *   - duplicate tool results
 *   - revoked messages and sources
 */

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DreamError } from './errors.mjs'
import { contentHash, normalizeSpace, shortId, stableStringify } from './util.mjs'

const BASIS_BY_ROLE = {
  user: 'user-confirmed',
  tool: 'tool-result',
  assistant: 'model-statement'
}

function isReasoning(message) {
  return (
    message?.kind === 'reasoning' ||
    message?.kind === 'thought' ||
    message?.reasoning === true ||
    message?.visibility === 'hidden'
  )
}

function isInjectedContext(message) {
  return message?.injected === true || message?.kind === 'injection' || message?.kind === 'injected-context'
}

function isRevoked(message) {
  return message?.revoked === true
}

function digestSession(session, messages) {
  return contentHash({
    sessionId: session.sessionId,
    projectId: session.projectId,
    status: session.status,
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      branchId: message.branchId ?? null,
      kind: message.kind ?? 'message',
      text: normalizeSpace(message.text ?? ''),
      toolCallId: message.toolCallId ?? null,
      timestamp: message.timestamp ?? null
    }))
  })
}

async function persistOriginal(originalsDir, session, digest) {
  await mkdir(originalsDir, { recursive: true })
  // Source ids contain characters such as ':' that are not valid Windows file
  // names; keep a readable prefix and add a stable hash to avoid collisions.
  const prefix = String(session.sourceId).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)
  const file = join(originalsDir, `${prefix}-${contentHash(session.sourceId).slice(0, 12)}.json`)
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  const payload = stableStringify({ digest, capturedAt: new Date().toISOString(), session })
  await writeFile(temp, payload, 'utf8')
  await rename(temp, file)
  return file
}

/**
 * @param {{
 *   registry: import('./evidence.mjs').EvidenceRegistry,
 *   projectId: string,
 *   sessions: any[],
 *   materials?: any[],
 *   now?: number,
 *   originalsDir?: string | null
 * }} options
 */
export async function ingest({ registry, projectId, sessions, materials = [], now = Date.now(), originalsDir = null }) {
  if (registry.projectId !== projectId) {
    throw new DreamError('PROJECT_MISMATCH', 'Evidence registry belongs to another project')
  }
  if (!Array.isArray(sessions)) throw new DreamError('VALIDATION', 'sessions must be an array')

  const result = {
    projectId,
    at: now,
    sources: [],
    evidenceIds: [],
    excludedMessages: [],
    excludedSessions: [],
    stats: {
      sessionsSeen: sessions.length,
      sessionsIngested: 0,
      sessionsUnchanged: 0,
      messagesSeen: 0,
      messagesIngested: 0,
      messagesExcluded: 0,
      duplicateToolResults: 0
    }
  }

  for (const session of sessions) {
    const sourceId = session?.sourceId ?? (session?.sessionId ? `session:${session.sessionId}` : null)
    if (!session || typeof session.sessionId !== 'string' || !sourceId) {
      throw new DreamError('VALIDATION', 'Every session needs sessionId and sourceId')
    }
    const sessionExclusion = (reason, detail) => {
      result.excludedSessions.push({ sessionId: session.sessionId, sourceId, reason, detail: detail ?? null })
    }
    if (session.projectId !== projectId) {
      sessionExclusion('project-mismatch', { sessionProjectId: session.projectId })
      continue
    }
    const authorization = session.authorization
    if (
      !authorization ||
      authorization.authorized !== true ||
      (authorization.projectId !== undefined && authorization.projectId !== projectId) ||
      authorization.revoked === true
    ) {
      sessionExclusion('unauthorized')
      continue
    }
    if (session.status !== 'completed' || session.completed === false) {
      sessionExclusion('incomplete', { status: session.status ?? null })
      continue
    }
    const existingSource = registry.getSource(sourceId)
    if (existingSource?.status === 'revoked') {
      sessionExclusion('revoked')
      continue
    }

    const branchStatus = new Map(
      (Array.isArray(session.branches) ? session.branches : []).map((branch) => [branch.branchId, branch])
    )
    const allowedBranches =
      Array.isArray(authorization.allowedBranchIds) && authorization.allowedBranchIds.length > 0
        ? new Set(authorization.allowedBranchIds)
        : null

    const usableMessages = []
    const seenToolResults = new Set()
    const messages = Array.isArray(session.messages) ? session.messages : []
    result.stats.messagesSeen += messages.length

    for (const message of messages) {
      if (!message || typeof message.text !== 'string' || message.text.trim().length === 0) {
        result.stats.messagesExcluded += 1
        continue
      }
      const branch = message.branchId ? branchStatus.get(message.branchId) : null
      if (allowedBranches && message.branchId && !allowedBranches.has(message.branchId)) {
        result.excludedMessages.push({ sourceId, messageId: message.id, reason: 'branch-not-authorized' })
        result.stats.messagesExcluded += 1
        continue
      }
      if (branch && (branch.status !== 'completed' || branch.authorized === false)) {
        result.excludedMessages.push({ sourceId, messageId: message.id, reason: 'branch-incomplete' })
        result.stats.messagesExcluded += 1
        continue
      }
      if (message.role === 'system' || message.kind === 'system-prompt') {
        result.excludedMessages.push({ sourceId, messageId: message.id, reason: 'system-prompt' })
        result.stats.messagesExcluded += 1
        continue
      }
      if (isReasoning(message)) {
        result.excludedMessages.push({ sourceId, messageId: message.id, reason: 'reasoning' })
        result.stats.messagesExcluded += 1
        continue
      }
      if (isInjectedContext(message)) {
        result.excludedMessages.push({ sourceId, messageId: message.id, reason: 'injected-context' })
        result.stats.messagesExcluded += 1
        continue
      }
      if (isRevoked(message)) {
        result.excludedMessages.push({ sourceId, messageId: message.id, reason: 'revoked-message' })
        result.stats.messagesExcluded += 1
        continue
      }
      if (!Object.hasOwn(BASIS_BY_ROLE, message.role)) {
        result.excludedMessages.push({ sourceId, messageId: message.id, reason: 'unsupported-role' })
        result.stats.messagesExcluded += 1
        continue
      }
      if (message.role === 'tool') {
        const key = message.toolCallId ?? contentHash(normalizeSpace(message.text))
        if (seenToolResults.has(key)) {
          result.excludedMessages.push({ sourceId, messageId: message.id, reason: 'duplicate-tool-result' })
          result.stats.messagesExcluded += 1
          result.stats.duplicateToolResults += 1
          continue
        }
        seenToolResults.add(key)
      }
      usableMessages.push(message)
    }

    const digest = digestSession(session, usableMessages)
    const latest = existingSource?.latestRevision ?? 0
    const latestHash = existingSource ? latestContentHash(registry, sourceId, latest) : null
    let revision = latest + 1
    if (latest > 0 && latestHash === digest) {
      revision = latest
      result.stats.sessionsUnchanged += 1
      result.sources.push({
        sourceId,
        sessionId: session.sessionId,
        revision,
        status: 'unchanged',
        contentHash: digest,
        evidenceAdded: 0
      })
      result.stats.sessionsIngested += 1
      continue
    }
    if (session.revision !== undefined) {
      if (!Number.isInteger(session.revision) || session.revision < revision) {
        sessionExclusion('stale-revision', { provided: session.revision, expectedAtLeast: revision })
        continue
      }
      revision = session.revision
    }

    const original = {
      digest,
      capturedAt: new Date(now).toISOString(),
      messageCount: usableMessages.length,
      storedPath: null
    }
    if (originalsDir) {
      try {
        original.storedPath = await persistOriginal(originalsDir, session, digest)
      } catch (error) {
        throw new DreamError('STORE_IO', 'Failed to persist the original session', { cause: error })
      }
    }

    registry.addSource({
      sourceId,
      kind: 'session',
      revision,
      title: session.title ?? session.sessionId,
      origin: 'pi-session',
      contentHash: digest,
      authorized: true,
      completed: true,
      at: now,
      meta: {
        sessionId: session.sessionId,
        original,
        branches: [...branchStatus.keys()]
      }
    })

    let added = 0
    for (const message of usableMessages) {
      registry.addSessionMessage({ session: { sessionId: session.sessionId, sourceId }, message, revision, at: now })
      added += 1
      result.stats.messagesIngested += 1
      result.evidenceIds.push(
        shortId('ev', {
          projectId,
          sourceId,
          sourceRevision: revision,
          locator: {
            type: 'message',
            sessionId: session.sessionId,
            messageId: message.id,
            charRange: { start: 0, end: normalizeSpace(message.text).length }
          },
          textHash: contentHash(normalizeSpace(message.text))
        })
      )
    }

    result.sources.push({
      sourceId,
      sessionId: session.sessionId,
      revision,
      status: 'ingested',
      contentHash: digest,
      evidenceAdded: added,
      original
    })
    result.stats.sessionsIngested += 1
  }

  for (const material of materials) {
    if (!material || material.projectId !== projectId) {
      result.excludedSessions.push({
        sourceId: material?.sourceId ?? null,
        reason: 'material-project-mismatch'
      })
      continue
    }
    if (material.status === 'revoked' || material.authorization?.authorized === false) {
      result.excludedSessions.push({ sourceId: material.sourceId, reason: 'material-unauthorized-or-revoked' })
      continue
    }
    if (!Array.isArray(material.blocks) || material.blocks.length === 0) {
      throw new DreamError('VALIDATION', `Material ${material.sourceId} needs blocks`)
    }
    const digest = contentHash(
      material.blocks.map((block) => ({ locator: block.locator, text: block.text }))
    )
    const existing = registry.getSource(material.sourceId)
    const latest = existing?.latestRevision ?? 0
    if (latest > 0 && latestContentHash(registry, material.sourceId, latest) === digest) {
      result.sources.push({
        sourceId: material.sourceId,
        revision: latest,
        status: 'unchanged',
        contentHash: digest,
        evidenceAdded: 0
      })
      continue
    }
    const revision = latest + 1
    registry.addSource({
      sourceId: material.sourceId,
      kind: material.kind === 'wiki' ? 'wiki' : 'document',
      revision,
      title: material.title ?? material.sourceId,
      origin: material.origin ?? 'material',
      contentHash: digest,
      at: now,
      meta: { blocks: material.blocks.length }
    })
    let added = 0
    for (const block of material.blocks) {
      const evidence = registry.addEvidence({
        sourceId: material.sourceId,
        sourceRevision: revision,
        locator: block.locator,
        text: block.text,
        role: 'document',
        timestamp: block.timestamp ?? null,
        meta: { heading: block.heading ?? null },
        at: now
      })
      added += 1
      result.evidenceIds.push(evidence.evidenceId)
    }
    result.sources.push({
      sourceId: material.sourceId,
      revision,
      status: 'ingested',
      contentHash: digest,
      evidenceAdded: added
    })
  }

  return result
}

function latestContentHash(registry, sourceId, revision) {
  const source = registry.sources.get(sourceId)
  return source?.revisions.get(revision)?.contentHash ?? null
}
