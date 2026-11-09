/**
 * Public adapter surface for the Dreaming worker.
 *
 * The mainline owns project policy, Pi transcript access, the app data dir and
 * the approval UI. This module exposes pure JSON-serializable inputs/outputs and
 * a prototype publisher/rollback API; see README for the boundary.
 */

export { DreamError, ERROR_CODES, isDreamError, isRetryable, toPublicError } from './errors.mjs'
export {
  contentHash,
  estimateTokens,
  newId,
  normalizeKey,
  normalizeSpace,
  sha256,
  shortId,
  sleep,
  stableStringify
} from './util.mjs'
export { EvidenceRegistry, detectInjection, toEvidenceRef } from './evidence.mjs'
export { ingest } from './sessions.mjs'
export {
  HeuristicModel,
  adjudicateCandidates,
  basisForRoles,
  candidateDigest,
  candidateId,
  extractCandidates,
  parseMemorySentence
} from './heuristics.mjs'
export { FallbackModel, ModelClient } from './model-client.mjs'
export { buildRem, proposeWikiDraft } from './rem.mjs'
export { CANDIDATE_TYPES, validateCandidates } from './candidates.mjs'
export { ENTRY_TYPE_ORDER, NOTE_TYPES, applyOps, diffEntries, entryIdFor, readEntries, verifyEntry } from './l1.mjs'
export { DEFAULT_L3_BUDGET, buildL3Snapshot, renderL3, validateBudget } from './l3.mjs'
export { OP_TYPES, checkEntries, validateOps } from './ops.mjs'
export { buildPlan, planFingerprint } from './plan.mjs'
export {
  FileDreamStore,
  MemoryDreamStore,
  emptyVersion,
  versionIdFor
} from './store.mjs'
export { publishPlan, rollbackMemory } from './publishing.mjs'
export { BudgetMeter, DEFAULT_LIMITS, tokensOf } from './budget.mjs'
export { verifyAnswerCitations, verifyPublishedVersion } from './verify.mjs'
export { DreamingPipeline } from './pipeline.mjs'
export { DreamingScheduler } from './scheduler.mjs'
export {
  DOC_SOURCE_ID,
  OTHER_PROJECT_ID,
  PROJECT_ID,
  SESSION_1_ID,
  SESSION_2_ID,
  SYNTHETIC_BASE_TIME,
  UNAUTHORIZED_SENTINEL,
  buildMaterials,
  buildSession1,
  buildSession2,
  buildSyntheticInputs,
  buildUnauthorizedSessions
} from './synthetic.mjs'
export { MOCK_MODEL_PORT, createMockModelServer, startMockModelServer } from './mock-server.mjs'
