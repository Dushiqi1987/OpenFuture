/**
 * Worker boundary. M0 ships SimulatedWorker; M1 substitutes a Pi-backed
 * implementation without changing the scheduler or permissions model.
 */

import type { ArtifactStore } from './artifacts.ts'
import type { Inbox, InboxSendResult, InboxWaitOptions } from './inbox.ts'
import type {
  AgentSendInput,
  ArtifactDraft,
  ArtifactRef,
  EffectivePermissions,
  InboxMessage,
  IntegrationReport,
  ProjectPolicy,
  RoleCard,
  RoleId,
  TaskRecord,
  TaskResult
} from './types.ts'

export interface WorkerWaitOptions extends Omit<InboxWaitOptions, 'timeoutMs' | 'signal'> {
  timeoutMs?: number
}

export interface WorkerContext {
  readonly runId: string
  readonly project: ProjectPolicy
  readonly task: Readonly<TaskRecord>
  readonly agentId: string
  readonly role: RoleId
  readonly card: RoleCard
  readonly permissions: EffectivePermissions
  readonly resolvedInputs: readonly ArtifactRef[]
  readonly signal: AbortSignal
  readonly inbox: Inbox
  readonly artifacts: ArtifactStore

  log(message: string, fraction?: number): void
  publish(draft: ArtifactDraft): Promise<ArtifactRef>
  findArtifact(name: string, version?: string): ArtifactRef | undefined
  findArtifactById(artifactId: string): ArtifactRef | undefined
  readArtifactText(refOrName: ArtifactRef | string, version?: string): Promise<string>
  verifyArtifact(ref: ArtifactRef): Promise<boolean>
  send(input: AgentSendInput): InboxSendResult
  wait(options?: WorkerWaitOptions): Promise<InboxMessage[]>
  /** Read a repository file through the project read policy. */
  readRepoFile(relativePath: string): Promise<string | null>
  /** Read from the isolated integration copy produced by the gate. */
  readIntegrationFile(relativePath: string): Promise<string | null>
  listTaskSnapshots(): readonly TaskRecord[]
  integrationReport(): IntegrationReport | undefined
  /** True when the path is inside both the project and the task's write scopes. */
  canWrite(relativePath: string): boolean
}

export interface Worker {
  readonly id: string
  run(context: WorkerContext): Promise<TaskResult>
}

export type WorkerFactory = (task: TaskRecord) => Worker
