/**
 * Per-conversation goal persistence.
 *
 * The agent host owns the round loop; every goal change is mirrored here so a
 * restart or a conversation switch can show the same objective and progress.
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentGoal } from '../shared/protocol'

function goalsDir(): string {
  const dir = join(app.getPath('userData'), 'config', 'goals')
  mkdirSync(dir, { recursive: true })
  return dir
}

function fileFor(key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'default'
  return join(goalsDir(), `${safe}.json`)
}

export function getGoal(key: string): AgentGoal | null {
  if (!key) return null
  try {
    const file = fileFor(key)
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as AgentGoal
    if (!parsed || typeof parsed.objective !== 'string' || parsed.objective.trim() === '') return null
    return parsed
  } catch {
    return null
  }
}

export function saveGoal(key: string, goal: AgentGoal | null): void {
  if (!key) return
  try {
    const file = fileFor(key)
    if (!goal) {
      if (existsSync(file)) rmSync(file, { force: true })
      return
    }
    writeFileSync(file, JSON.stringify(goal, null, 2), 'utf8')
  } catch {
    // Persistence is best-effort: the live host still holds the goal.
  }
}
