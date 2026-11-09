/**
 * Local Pi session protocol used by the M1 adapter boundary.
 *
 * The real Pi SDK is intentionally not imported by this prototype. The adapter
 * speaks a narrow, versioned HTTP/SSE contract so the same lifecycle can be
 * exercised against the bundled mock endpoint on 127.0.0.1:19734 today, then
 * mapped onto Pi's session API without changing the scheduler or permissions.
 */
import type {
  AgentSendInput,
  ArtifactDraft,
  ArtifactRef,
  TaskResult,
  ToolName
} from '../core/types.ts'

export const PI_PROTOCOL_VERSION = '1.0'

export interface PiSessionSpec {
  protocolVersion: string
  projectId: string
  runId: string
  taskId: string
  agentId: string
  role: string
  attempt: number
  baseRevision: string
  prompt: string
  tools: ToolName[]
  writeScopes: string[]
  memoryView: string
  model?: string
  maxTurns: number
  maxTokens: number
  timeoutMs: number
  scenario?: string
}

export interface PiToolRequest {
  requestId: string
  tool: ToolName
  args: Record<string, unknown>
}

export interface PiInboxWait {
  requestId: string
  correlationId?: string
  consumes?: string[]
  issues?: string[]
  timeoutMs?: number
}

export interface PiArtifactPublish {
  requestId: string
  draft: ArtifactDraft
}

export type PiInput =
  | { type: 'tool.result'; requestId: string; ok: boolean; result?: unknown; error?: string }
  | { type: 'inbox.result'; requestId: string; messageId: string; duplicate: boolean }
  | { type: 'inbox.messages'; requestId: string; messages: unknown[] }
  | { type: 'inbox.error'; requestId: string; code: string; message: string; retryable?: boolean }
  | { type: 'artifact.result'; requestId: string; artifact: ArtifactRef }
  | { type: 'artifact.error'; requestId: string; code: string; message: string }

export type PiSessionEvent =
  | { seq: number; at: string; type: 'session.started'; sessionId: string }
  | { seq: number; at: string; type: 'session.resumed' }
  | { seq: number; at: string; type: 'message.delta'; text: string }
  | { seq: number; at: string; type: 'progress'; message: string; fraction?: number }
  | { seq: number; at: string; type: 'tool.request' } & PiToolRequest
  | { seq: number; at: string; type: 'inbox.wait' } & PiInboxWait
  | { seq: number; at: string; type: 'inbox.send'; requestId: string; input: AgentSendInput }
  | { seq: number; at: string; type: 'artifact.publish' } & PiArtifactPublish
  | { seq: number; at: string; type: 'session.completed'; result: TaskResult }
  | {
      seq: number
      at: string
      type: 'session.failed'
      error: { code: string; message: string; retryable?: boolean; retryAfterMs?: number }
    }
  | { seq: number; at: string; type: 'session.cancelled'; reason?: string }

export interface PiSessionSnapshot {
  sessionId: string
  status: 'created' | 'running' | 'disconnected' | 'completed' | 'failed' | 'cancelled'
  attempt: number
  role: string
  taskId: string
  events: number
  deltas: number
}

export interface PiStats {
  created: number
  active: number
  maxActive: number
  completed: number
  failed: number
  cancelled: number
  resumes: number
  sessions: PiSessionSnapshot[]
}

export interface PiClientOptions {
  baseUrl: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export function isTerminalPiEvent(event: PiSessionEvent): boolean {
  return event.type === 'session.completed' || event.type === 'session.failed' || event.type === 'session.cancelled'
}

export function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'name' in error && (error as { name?: string }).name === 'AbortError')
}
