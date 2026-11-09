/**
 * L3: the only project-memory text allowed to leave the application.
 *
 * Triple budget: lines, UTF-8 bytes and model tokens. Only entries that are
 * `promoted` AND readable against the live evidence registry are rendered.
 * The snapshot is rebuilt on every read, so a revocation takes effect
 * immediately even if a version file still contains the old entry.
 */

import { DreamError } from './errors.mjs'
import { ENTRY_TYPE_ORDER } from './l1.mjs'
import { contentHash, estimateTokens, normalizeKey } from './util.mjs'

export const DEFAULT_L3_BUDGET = Object.freeze({
  maxLines: 40,
  maxBytes: 4096,
  maxTokens: 800
})

const HEADER = '# Dreaming L3 — approved project memory'

export function validateBudget(budget = {}) {
  const merged = { ...DEFAULT_L3_BUDGET, ...budget }
  for (const key of ['maxLines', 'maxBytes', 'maxTokens']) {
    if (!Number.isInteger(merged[key]) || merged[key] < 1) {
      throw new DreamError('VALIDATION', `L3 budget ${key} must be a positive integer`)
    }
  }
  return merged
}

function lineOf(entry) {
  const value = String(entry.value ?? '').replace(/\s+/g, ' ').trim()
  const subject = String(entry.subject ?? entry.title ?? '').replace(/\s+/g, ' ').trim()
  return `- [${entry.type}] ${subject}: ${value}`
}

function orderOf(entry) {
  const typeIndex = ENTRY_TYPE_ORDER.indexOf(entry.type)
  return `${String(typeIndex < 0 ? 99 : typeIndex).padStart(2, '0')}:${normalizeKey(entry.subject)}:${entry.id}`
}

/**
 * @param {any[]} entries already-readable entries
 * @param {{maxLines?:number,maxBytes?:number,maxTokens?:number}} budget
 */
export function renderL3(entries, budget = DEFAULT_L3_BUDGET) {
  const limits = validateBudget(budget)
  const candidates = [...(entries ?? [])]
    .filter((entry) => entry && entry.promoted === true && ENTRY_TYPE_ORDER.includes(entry.type))
    .sort((a, b) => (orderOf(a) < orderOf(b) ? -1 : orderOf(a) > orderOf(b) ? 1 : 0))

  const headerStats = {
    lines: HEADER.split('\n').length,
    bytes: Buffer.byteLength(HEADER, 'utf8'),
    tokens: estimateTokens(HEADER)
  }
  if (headerStats.lines > limits.maxLines || headerStats.bytes > limits.maxBytes || headerStats.tokens > limits.maxTokens) {
    return {
      ok: false,
      text: '',
      entries: [],
      omitted: candidates.length,
      truncated: true,
      reason: 'L3_BUDGET',
      stats: { ...headerStats, entries: 0, omitted: candidates.length }
    }
  }

  const lines = [HEADER]
  const included = []
  for (const entry of candidates) {
    const line = lineOf(entry)
    if (line.split('\n').length !== 1) continue
    const nextLines = [...lines, line]
    const text = nextLines.join('\n')
    if (
      nextLines.length > limits.maxLines ||
      Buffer.byteLength(text, 'utf8') > limits.maxBytes ||
      estimateTokens(text) > limits.maxTokens
    ) {
      break
    }
    lines.push(line)
    included.push(entry)
  }
  const text = lines.join('\n')
  return {
    ok: included.length === candidates.length,
    text,
    entries: included,
    omitted: candidates.length - included.length,
    truncated: included.length !== candidates.length,
    reason: included.length === candidates.length ? null : 'L3_BUDGET',
    stats: {
      lines: text.split('\n').length,
      bytes: Buffer.byteLength(text, 'utf8'),
      tokens: estimateTokens(text),
      entries: included.length,
      omitted: candidates.length - included.length,
      entryIds: included.map((entry) => entry.id)
    },
    hash: contentHash(text)
  }
}

/** Strict snapshot for persistence: an over-budget L3 must block publication. */
export function buildL3Snapshot(entries, budget) {
  const rendered = renderL3(entries, budget)
  if (!rendered.ok || rendered.truncated) {
    throw new DreamError('L3_BUDGET', 'L3 exceeds its lines/bytes/token budget', {
      details: { stats: rendered.stats, limits: validateBudget(budget) }
    })
  }
  return rendered
}
