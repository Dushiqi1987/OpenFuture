import { createHash, randomUUID } from 'node:crypto'

export const DEFAULT_CLOCK = () => Date.now()

/** Deterministic JSON used for hashing and revisions. */
export function stableStringify(value) {
  if (value === null || value === undefined) return JSON.stringify(value ?? null)
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

export function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

export function contentHash(value) {
  return sha256(typeof value === 'string' ? value : stableStringify(value))
}

/** Content-addressed identifier: the same input always yields the same id. */
export function shortId(prefix, value, length = 20) {
  return `${prefix}_${contentHash(value).slice(0, length)}`
}

/** Runtime identifier for objects that are not content-addressed. */
export function newId(prefix) {
  return `${prefix}_${randomUUID()}`
}

export function deepClone(value) {
  return structuredClone(value)
}

/**
 * Token estimate used for the L3 and model budgets.
 *
 * The model tokenizer is not part of this worker; the prototype counts every
 * CJK/full-width code point as one token and every other four characters as
 * one token. The bound is deliberately deterministic so tests and audits can
 * reproduce it. A real adapter may replace this with the provider tokenizer,
 * but must keep the same conservative rounding.
 */
export function estimateTokens(text) {
  if (!text) return 0
  let units = 0
  for (const char of String(text)) {
    const codePoint = char.codePointAt(0) ?? 0
    units += codePoint >= 0x2e80 ? 1 : 0.25
  }
  return Math.max(1, Math.ceil(units))
}

export function normalizeKey(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

export function normalizeSpace(text) {
  return String(text ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ')
}

export function uniqueBy(values, keyFn) {
  const seen = new Set()
  const out = []
  for (const value of values) {
    const key = keyFn(value)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

export function sortByKey(values, keyFn) {
  return [...values].sort((a, b) => {
    const ka = keyFn(a)
    const kb = keyFn(b)
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
}

export function dayKey(at) {
  return new Date(at).toISOString().slice(0, 10)
}

export function sleep(ms, { signal } = {}) {
  if (!ms || ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      cleanup()
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }
    const cleanup = () => {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
    if (signal) {
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

export function assertNever(value) {
  throw new Error(`unexpected value: ${String(value)}`)
}
