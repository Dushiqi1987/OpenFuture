/**
 * Cost/task budget meter. A call must reserve budget BEFORE it is made; actual
 * usage is committed after. Per-run and per-day counters are both enforced.
 * The ledger is shared by jobs so a scheduled round cannot bypass the daily cap.
 */

import { DreamError } from './errors.mjs'
import { dayKey, estimateTokens } from './util.mjs'

export const DEFAULT_LIMITS = Object.freeze({
  maxCallsPerRun: 8,
  maxTokensPerRun: 40000,
  maxCallsPerDay: 60,
  maxTokensPerDay: 300000
})

export function tokensOf(value) {
  return estimateTokens(typeof value === 'string' ? value : JSON.stringify(value))
}

export class BudgetMeter {
  /**
   * @param {{limits?:any, clock?:()=>number, dailyLedger?:Map<string,{calls:number,tokens:number}>}} options
   */
  constructor({ limits = {}, clock = Date.now, dailyLedger = new Map() } = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits }
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isInteger(value) || value < 0) {
        throw new DreamError('VALIDATION', `Budget limit ${key} must be a non-negative integer`)
      }
    }
    this.clock = clock
    this.dailyLedger = dailyLedger
    this.run = { calls: 0, tokens: 0, startedAt: null }
  }

  beginRun(at = this.clock()) {
    this.run = { calls: 0, tokens: 0, startedAt: at }
    return this.snapshot()
  }

  #daily() {
    const key = dayKey(this.clock())
    if (!this.dailyLedger.has(key)) this.dailyLedger.set(key, { calls: 0, tokens: 0 })
    return { key, usage: this.dailyLedger.get(key) }
  }

  snapshot() {
    const { key, usage } = this.#daily()
    return {
      limits: { ...this.limits },
      run: { ...this.run },
      daily: { day: key, calls: usage.calls, tokens: usage.tokens },
      remaining: {
        calls: Math.max(0, this.limits.maxCallsPerRun - this.run.calls),
        tokens: Math.max(0, this.limits.maxTokensPerRun - this.run.tokens),
        dailyCalls: Math.max(0, this.limits.maxCallsPerDay - usage.calls),
        dailyTokens: Math.max(0, this.limits.maxTokensPerDay - usage.tokens)
      }
    }
  }

  /** Reserve one model call and its estimated request tokens. */
  begin({ calls = 1, tokens = 0, phase = null } = {}) {
    const { key, usage } = this.#daily()
    const next = {
      runCalls: this.run.calls + calls,
      runTokens: this.run.tokens + tokens,
      dailyCalls: usage.calls + calls,
      dailyTokens: usage.tokens + tokens
    }
    if (
      next.runCalls > this.limits.maxCallsPerRun ||
      next.runTokens > this.limits.maxTokensPerRun ||
      next.dailyCalls > this.limits.maxCallsPerDay ||
      next.dailyTokens > this.limits.maxTokensPerDay
    ) {
      throw new DreamError('BUDGET_EXCEEDED', 'Model call budget would be exceeded', {
        details: {
          phase,
          requested: { calls, tokens },
          limits: this.limits,
          run: this.run,
          daily: { day: key, ...usage }
        }
      })
    }
    this.run.calls = next.runCalls
    this.run.tokens = next.runTokens
    usage.calls = next.dailyCalls
    usage.tokens = next.dailyTokens
    return this.snapshot()
  }

  /** Commit actual response tokens (request tokens were reserved in begin). */
  finish({ tokens = 0, phase = null } = {}) {
    this.run.tokens += tokens
    const { usage } = this.#daily()
    usage.tokens += tokens
    if (
      this.run.tokens > this.limits.maxTokensPerRun ||
      usage.tokens > this.limits.maxTokensPerDay
    ) {
      throw new DreamError('BUDGET_EXCEEDED', 'Actual model usage exceeded the token budget', {
        details: { phase, tokens, run: this.run, limits: this.limits }
      })
    }
    return this.snapshot()
  }
}
