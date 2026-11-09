/**
 * Evidence registry: the only source of truth the Dreaming worker trusts.
 *
 * Identity contract (shared with the main line):
 *   { projectId, sourceId, sourceRevision, evidenceId, locator, quote, quoteHash }
 *
 * - `evidenceId` is content-addressed over project/source/revision/locator/text.
 * - `locator` is typed: page, lines, chars for documents and `message` for a
 *   completed Pi session message (a documented session extension of the same
 *   typed-locator rule).
 * - A reference is only valid while its exact source revision is the latest
 *   authorized, completed and non-revoked revision of that source.
 */

import { DreamError } from './errors.mjs'
import { contentHash, normalizeSpace, shortId, stableStringify } from './util.mjs'

const SOURCE_KINDS = new Set(['session', 'document', 'wiki'])
const INJECTION_PATTERNS = [
  {
    id: 'ignore-instructions',
    re: /\b(ignore|disregard|forget)\b[^\n]{0,40}\b(previous|prior|above|earlier|all)\b[^\n]{0,20}\b(instructions?|prompts?|rules?|directions?)\b/i
  },
  { id: 'role-hijack', re: /\b(you are now|act as|pretend (to be|you are))\b/i },
  { id: 'system-tag', re: /(<\|?im_start\|?>|\[\/?INST\]|<\|system\|>|###\s*system\b)/i },
  {
    id: 'memory-authority',
    re: /\b(promote|mark|treat|make)\b[^\n]{0,30}\b(as\s+)?(system|admin|trusted|root)\b/i
  },
  { id: 'zh-ignore', re: /(忽略|无视|忘记)[^\n]{0,30}(之前|以上|先前|所有)[^\n]{0,10}(指令|提示|规则|要求)/ },
  { id: 'zh-role', re: /(你现在是|从现在起你是|扮演)/ }
]

/** @param {string} text @returns {{id:string,index:number}[]} */
export function detectInjection(text) {
  const value = String(text ?? '')
  const flags = []
  for (const pattern of INJECTION_PATTERNS) {
    const match = pattern.re.exec(value)
    if (match) flags.push({ id: pattern.id, index: match.index })
  }
  return flags
}

/** @param {unknown} locator */
export function validateLocator(locator) {
  if (!locator || typeof locator !== 'object') return false
  const value = /** @type {Record<string, unknown>} */ (locator)
  switch (value.type) {
    case 'page':
      return Number.isInteger(value.page) && Number(value.page) >= 1
    case 'lines':
      return (
        Number.isInteger(value.startLine) &&
        Number.isInteger(value.endLine) &&
        Number(value.startLine) >= 1 &&
        Number(value.endLine) >= Number(value.startLine)
      )
    case 'chars':
      return (
        Number.isInteger(value.start) &&
        Number.isInteger(value.end) &&
        Number(value.start) >= 0 &&
        Number(value.end) >= Number(value.start)
      )
    case 'message':
      return (
        typeof value.sessionId === 'string' &&
        value.sessionId.length > 0 &&
        typeof value.messageId === 'string' &&
        value.messageId.length > 0
      )
    default:
      return false
  }
}

export function makeEvidenceId({ projectId, sourceId, sourceRevision, locator, text }) {
  return shortId('ev', {
    projectId,
    sourceId,
    sourceRevision,
    locator,
    textHash: contentHash(text)
  })
}

/** Public evidence reference (JSON serializable, includes the quoted text). */
export function toEvidenceRef(record) {
  return {
    projectId: record.projectId,
    sourceId: record.sourceId,
    sourceRevision: record.sourceRevision,
    evidenceId: record.evidenceId,
    locator: structuredClone(record.locator),
    quote: record.text,
    quoteHash: record.contentHash
  }
}

export class EvidenceRegistry {
  /** @param {string} projectId */
  constructor(projectId) {
    if (typeof projectId !== 'string' || projectId.length === 0) {
      throw new DreamError('VALIDATION', 'EvidenceRegistry requires a projectId')
    }
    this.projectId = projectId
    /** @type {Map<string, any>} */
    this.sources = new Map()
    /** @type {Map<string, any>} */
    this.evidence = new Map()
  }

  /**
   * Register (or update) one source revision. Content changes must bump
   * `revision`; evidence from older revisions then becomes EVIDENCE_STALE.
   */
  addSource({
    sourceId,
    kind,
    revision = 1,
    title = '',
    origin = '',
    contentHash = null,
    authorized = true,
    completed = true,
    meta = {},
    at = Date.now()
  }) {
    if (typeof sourceId !== 'string' || sourceId.length === 0) {
      throw new DreamError('VALIDATION', 'sourceId is required')
    }
    if (!SOURCE_KINDS.has(kind)) {
      throw new DreamError('VALIDATION', `Unsupported source kind: ${String(kind)}`, {
        details: { kind }
      })
    }
    if (!Number.isInteger(revision) || revision < 1) {
      throw new DreamError('VALIDATION', 'Source revision must be a positive integer')
    }
    let source = this.sources.get(sourceId)
    if (!source) {
      source = {
        sourceId,
        kind,
        title,
        origin,
        status: 'active',
        revokedAt: null,
        revokeReason: null,
        revisions: new Map(),
        createdAt: at,
        updatedAt: at
      }
      this.sources.set(sourceId, source)
    }
    if (source.kind !== kind) {
      throw new DreamError('VALIDATION', `Source kind cannot change for ${sourceId}`, {
        details: { sourceId, current: source.kind, incoming: kind }
      })
    }
    source.title = title || source.title
    source.origin = origin || source.origin
    source.revisions.set(revision, {
      revision,
      contentHash,
      authorized: authorized === true,
      completed: completed === true,
      meta: structuredClone(meta),
      at
    })
    source.updatedAt = at
    return this.getSource(sourceId)
  }

  revokeSource(sourceId, { at = Date.now(), reason = 'revoked' } = {}) {
    const source = this.sources.get(sourceId)
    if (!source) throw new DreamError('EVIDENCE_UNKNOWN', `Unknown source: ${sourceId}`)
    source.status = 'revoked'
    source.revokedAt = at
    source.revokeReason = String(reason).slice(0, 500)
    source.updatedAt = at
    return this.getSource(sourceId)
  }

  getSource(sourceId) {
    const source = this.sources.get(sourceId)
    if (!source) return null
    const revisions = [...source.revisions.keys()].sort((a, b) => b - a)
    const latestRevision = revisions[0] ?? 0
    const latest = source.revisions.get(latestRevision) ?? null
    return {
      sourceId: source.sourceId,
      kind: source.kind,
      title: source.title,
      origin: source.origin,
      status: source.status,
      revokedAt: source.revokedAt,
      revokeReason: source.revokeReason,
      latestRevision,
      authorized: latest?.authorized === true,
      completed: latest?.completed === true,
      revisionCount: source.revisions.size,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt
    }
  }

  listSources() {
    return [...this.sources.keys()].map((sourceId) => this.getSource(sourceId))
  }

  /**
   * Add one immutable evidence record. Re-adding identical content returns the
   * existing record so incremental ingestion is idempotent.
   */
  addEvidence({
    sourceId,
    sourceRevision,
    locator,
    text,
    role = null,
    speaker = null,
    sessionId = null,
    messageId = null,
    timestamp = null,
    meta = {},
    at = Date.now()
  }) {
    const source = this.sources.get(sourceId)
    if (!source) throw new DreamError('EVIDENCE_UNKNOWN', `Unknown source: ${sourceId}`)
    if (!source.revisions.has(sourceRevision)) {
      throw new DreamError('EVIDENCE_UNKNOWN', `Unknown revision ${sourceRevision} for ${sourceId}`)
    }
    if (!validateLocator(locator)) {
      throw new DreamError('VALIDATION', 'Invalid evidence locator', { details: { locator } })
    }
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new DreamError('VALIDATION', 'Evidence text must be a non-empty string')
    }
    const evidenceId = makeEvidenceId({
      projectId: this.projectId,
      sourceId,
      sourceRevision,
      locator,
      text
    })
    const existing = this.evidence.get(evidenceId)
    if (existing) return existing

    const flags = detectInjection(text)
    const record = {
      evidenceId,
      projectId: this.projectId,
      sourceId,
      sourceRevision,
      locator: structuredClone(locator),
      text,
      contentHash: contentHash(text),
      role,
      speaker,
      sessionId,
      messageId,
      timestamp,
      sourceKind: source.kind,
      quarantined: meta.quarantined === true || flags.length > 0,
      injectionFlags: flags,
      meta: structuredClone(meta),
      createdAt: at
    }
    this.evidence.set(evidenceId, record)
    return record
  }

  addSessionMessage({ session, message, revision, at }) {
    const text = typeof message.text === 'string' ? normalizeSpace(message.text) : ''
    return this.addEvidence({
      sourceId: session.sourceId,
      sourceRevision: revision,
      locator: {
        type: 'message',
        sessionId: session.sessionId,
        messageId: message.id,
        charRange: { start: 0, end: text.length }
      },
      text,
      role: message.role ?? null,
      speaker: message.speaker ?? message.role ?? null,
      sessionId: session.sessionId,
      messageId: message.id,
      timestamp: message.timestamp ?? null,
      meta: {
        kind: message.kind ?? 'message',
        toolCallId: message.toolCallId ?? null,
        injected: message.injected === true
      },
      at
    })
  }

  getEvidence(evidenceId) {
    return this.evidence.get(evidenceId) ?? null
  }

  findEvidence({ sessionId, messageId }) {
    for (const record of this.evidence.values()) {
      if (record.sessionId === sessionId && record.messageId === messageId) return record
    }
    return null
  }

  listEvidence({ sourceIds, includeQuarantined = true } = {}) {
    const filter = sourceIds ? new Set(sourceIds) : null
    const out = []
    for (const record of this.evidence.values()) {
      if (filter && !filter.has(record.sourceId)) continue
      if (!includeQuarantined && record.quarantined) continue
      out.push(record)
    }
    return out
  }

  /**
   * Verify a reference against the live registry.
   * @returns {{ok:true,evidence:any} | {ok:false,code:string,message:string}}
   */
  verifyRef(ref, { requireQuote = true, requireActive = true } = {}) {
    if (!ref || typeof ref !== 'object') {
      return { ok: false, code: 'EVIDENCE_UNKNOWN', message: 'Evidence reference must be an object' }
    }
    if (ref.projectId !== this.projectId) {
      return {
        ok: false,
        code: 'PROJECT_MISMATCH',
        message: `Evidence belongs to ${String(ref.projectId)}, expected ${this.projectId}`
      }
    }
    const record = this.evidence.get(ref.evidenceId)
    if (!record) {
      return {
        ok: false,
        code: 'EVIDENCE_UNKNOWN',
        message: `Unknown evidence id: ${String(ref.evidenceId)}`
      }
    }
    if (record.sourceId !== ref.sourceId || record.sourceRevision !== ref.sourceRevision) {
      return {
        ok: false,
        code: 'EVIDENCE_UNKNOWN',
        message: 'Evidence id does not match the claimed source revision'
      }
    }
    if (stableStringify(record.locator) !== stableStringify(ref.locator)) {
      return {
        ok: false,
        code: 'EVIDENCE_UNKNOWN',
        message: 'Evidence locator does not match the registered locator'
      }
    }
    if (requireQuote) {
      if (typeof ref.quote !== 'string' || ref.quote !== record.text) {
        return {
          ok: false,
          code: 'QUOTE_MISMATCH',
          message: 'Quoted text does not match the immutable evidence text',
          details: { evidenceId: record.evidenceId }
        }
      }
      if (ref.quoteHash !== undefined && ref.quoteHash !== record.contentHash) {
        return {
          ok: false,
          code: 'QUOTE_MISMATCH',
          message: 'Quote hash does not match the immutable evidence text'
        }
      }
    } else if (ref.quote !== undefined && ref.quote !== record.text) {
      return {
        ok: false,
        code: 'QUOTE_MISMATCH',
        message: 'Quoted text does not match the immutable evidence text'
      }
    }
    const source = this.sources.get(record.sourceId)
    if (!source) {
      return { ok: false, code: 'EVIDENCE_UNKNOWN', message: 'Source is no longer registered' }
    }
    if (requireActive) {
      if (source.status === 'revoked') {
        return {
          ok: false,
          code: 'EVIDENCE_REVOKED',
          message: `Source ${record.sourceId} is revoked`
        }
      }
      const latestRevision = Math.max(...source.revisions.keys())
      if (record.sourceRevision !== latestRevision) {
        return {
          ok: false,
          code: 'EVIDENCE_STALE',
          message: `Source ${record.sourceId} has a newer revision (${latestRevision})`
        }
      }
      const revisionRecord = source.revisions.get(record.sourceRevision)
      if (!revisionRecord?.authorized) {
        return { ok: false, code: 'EVIDENCE_INACTIVE', message: 'Source revision is not authorized' }
      }
      if (!revisionRecord?.completed) {
        return { ok: false, code: 'EVIDENCE_INACTIVE', message: 'Source revision is not completed' }
      }
    }
    return { ok: true, evidence: record }
  }

  /** Compact deterministic view for prompts and tests. */
  snapshot() {
    return {
      projectId: this.projectId,
      sources: this.listSources(),
      evidence: this.listEvidence().map((record) => ({
        evidenceId: record.evidenceId,
        sourceId: record.sourceId,
        sourceRevision: record.sourceRevision,
        locator: record.locator,
        contentHash: record.contentHash,
        role: record.role,
        sessionId: record.sessionId,
        messageId: record.messageId,
        quarantined: record.quarantined,
        injectionFlags: record.injectionFlags
      }))
    }
  }
}
