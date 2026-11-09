/**
 * Versioned transport types for the desktop integration contract.
 *
 * This module is deliberately transport-only: it does not know about the UI,
 * the project center or a model provider. The desktop shell consumes these
 * envelopes and can evolve independently as long as the contract version is
 * negotiated through GET /v1/contract.
 */

import type { ArtifactRef, IntegrationReport, MemoryView, RunStatus } from '../core/types.ts'

export const DESKTOP_CONTRACT_VERSION = '1.0'
export const DESKTOP_BRIDGE_PORT = 19744
export const DESKTOP_CONTRACT_NAME = 'openfuture-desktop-contract'

export interface ContractEnvelope<T> {
  schemaVersion: typeof DESKTOP_CONTRACT_VERSION
  kind: string
  projectId: string
  runId?: string
  generatedAt: number
  data: T
}

export interface ContractErrorBody {
  schemaVersion: typeof DESKTOP_CONTRACT_VERSION
  kind: 'error'
  generatedAt: number
  error: {
    code: string
    message: string
    details?: Record<string, unknown>
  }
}

export interface ContractEndpoint {
  method: 'GET' | 'POST'
  path: string
  description: string
  auth: boolean
}

export interface ContractManifest {
  contractVersion: typeof DESKTOP_CONTRACT_VERSION
  name: typeof DESKTOP_CONTRACT_NAME
  defaultPort: number
  eventSchemaVersion: string
  capabilities: string[]
  endpoints: ContractEndpoint[]
  memoryViews: MemoryView[]
  notes: string[]
}

export interface RunSummary {
  runId: string
  projectId: string
  planId: string
  mainGoal: string
  status: RunStatus
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  stopReason?: string
  tasks: number
  artifacts: number
  messages: number
  events: number
  integrationStatus?: IntegrationReport['status']
}

export interface MemoryRef {
  kind: 'plan' | 'run' | 'question' | 'intent' | 'task' | 'artifact' | 'integration' | 'event'
  id: string
  label?: string
}

export interface MemoryEntry {
  id: string
  kind: 'goal' | 'question' | 'intent' | 'decision' | 'artifact' | 'task' | 'failure'
  title: string
  text: string
  refs: MemoryRef[]
  runId?: string
  sha256?: string
}

export interface RunMemoryView {
  schemaVersion: typeof DESKTOP_CONTRACT_VERSION
  projectId: string
  runId: string
  view: MemoryView
  generatedAt: number
  entries: MemoryEntry[]
  redactions: number
}

export interface ProjectMemoryView {
  schemaVersion: typeof DESKTOP_CONTRACT_VERSION
  projectId: string
  view: MemoryView
  generatedAt: number
  runs: string[]
  entries: MemoryEntry[]
  redactions: number
}

export interface ExternalTestCheck {
  id: string
  status: 'passed' | 'failed'
  detail?: string
}

export interface ExternalTestReportInput {
  taskId?: string
  name: string
  framework?: string
  status: 'passed' | 'failed' | 'blocked'
  checks: ExternalTestCheck[]
  startedAt?: number
  finishedAt?: number
  evidence?: string[]
}

export interface ExternalTestReport extends ExternalTestReportInput {
  schemaVersion: typeof DESKTOP_CONTRACT_VERSION
  reportId: string
  projectId: string
  runId: string
  receivedAt: number
  ownerRole?: string
}

export interface TestIntegrationSummary {
  artifacts: number
  reports: number
  passed: number
  failed: number
  blocked: number
}

export interface TestIntegrationView {
  artifacts: ArtifactRef[]
  reports: ExternalTestReport[]
  summary: TestIntegrationSummary
}

export type DesktopEnvelopeKind =
  | 'contract'
  | 'runs'
  | 'board'
  | 'events'
  | 'artifacts'
  | 'artifact'
  | 'memory'
  | 'test-integration'
  | 'test-report'
  | 'health'
