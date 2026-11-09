/**
 * Role cards and permission convergence.
 *
 * A role card describes how a helper works (duties, output contract, model
 * defaults). It never grants permissions by itself: the effective permission
 * set is the intersection of the project policy and the role request, and the
 * runtime applies that intersection when a task starts and when it writes.
 */

import { TeamError } from './errors.ts'
import type {
  EffectivePermissions,
  MemoryView,
  ProjectPolicy,
  RoleCard,
  RoleId,
  ToolName,
  TrimRecord
} from './types.ts'
import { intersection, normalizePosixPath, unique } from './util.ts'

export const DEFAULT_ROLE_CARDS: Record<RoleId, RoleCard> = {
  researcher: {
    id: 'researcher',
    displayName: '研究助手',
    specialty: '公开资料检索、出处核验与未知项标注',
    duties: [
      '把需求转成可核验的检索问题，返回出处链接、关键结论、可信度和未知项',
      '只发送完成任务所需的最小关键词，不发送项目私密内容',
      '收到后端或前端的资料请求后，用同一 correlationId 回复并附产物引用'
    ],
    language: 'zh-CN',
    outputContract: '研究简报：问题、结论、出处（URL/标题/访问日期）、可信度、未知项',
    tools: ['read', 'network'],
    memoryView: 'rag',
    writeScopes: [],
    integrationOnly: false,
    model: { providerId: 'openfuture-local', modelId: 'pi-researcher', temperature: 0.2 },
    budget: {
      maxTurns: 6,
      maxTokens: 12_000,
      timeoutMs: 60_000,
      maxAttempts: 2,
      requestTimeoutMs: 8_000
    }
  },
  backend: {
    id: 'backend',
    displayName: '后端助手',
    specialty: '服务、存储、接口合同与迁移',
    duties: [
      '先交接口合同与样例，再交代码差异、迁移和测试证据',
      '需要外部事实时向研究助手发请求，等待带出处的回复',
      '只写自己的副本与授权目录，合同变更后通知前端与测试'
    ],
    language: 'zh-CN',
    outputContract: 'versioned openapi.json 合同 + 后端代码差异 + 测试报告 + 迁移说明',
    tools: ['read', 'write', 'network', 'shell', 'git', 'test'],
    memoryView: 'rag',
    writeScopes: ['src/server/**', 'contracts/**', 'tests/server/**'],
    integrationOnly: false,
    model: { providerId: 'openfuture-local', modelId: 'pi-backend', temperature: 0.1 },
    budget: {
      maxTurns: 12,
      maxTokens: 24_000,
      timeoutMs: 90_000,
      maxAttempts: 2,
      requestTimeoutMs: 8_000
    }
  },
  frontend: {
    id: 'frontend',
    displayName: '前端助手',
    specialty: '界面、交互与合同消费',
    duties: [
      '只使用指定版本的接口合同；合同未就绪时用 mock 先行',
      '交页面差异、测试证据和使用的合同版本',
      '发现合同缺口时向 Super-Agent 或后端发请求，不自行改共享合同'
    ],
    language: 'zh-CN',
    outputContract: '页面代码差异 + 组件/页面测试证据 + 合同版本号',
    tools: ['read', 'write', 'shell', 'test'],
    memoryView: 'off',
    writeScopes: ['src/web/**', 'tests/web/**'],
    integrationOnly: false,
    model: { providerId: 'openfuture-local', modelId: 'pi-frontend', temperature: 0.2 },
    budget: {
      maxTurns: 10,
      maxTokens: 20_000,
      timeoutMs: 75_000,
      maxAttempts: 2,
      requestTimeoutMs: 8_000
    }
  },
  tester: {
    id: 'tester',
    displayName: '测试与集成助手',
    specialty: '独立集成、构建回归与验收证据',
    duties: [
      '先检查基线、文件白名单、哈希和依赖，再在独立集成副本逐项应用差异',
      '串行试合、构建、静态检查和端到端回归；失败退回责任人并保留证据',
      '清单缺失或冲突时不标完成；最终给出可审查差异、证据和剩余项'
    ],
    language: 'zh-CN',
    outputContract: '集成报告：应用清单、冲突、构建/回归结果、失败负责人、剩余项',
    tools: ['read', 'shell', 'git', 'test'],
    memoryView: 'rag',
    writeScopes: [],
    integrationOnly: true,
    model: { providerId: 'openfuture-local', modelId: 'pi-tester', temperature: 0.1 },
    budget: {
      maxTurns: 10,
      maxTokens: 18_000,
      timeoutMs: 90_000,
      maxAttempts: 2,
      requestTimeoutMs: 8_000
    }
  }
}

export const ROLE_IDS: readonly RoleId[] = ['researcher', 'backend', 'frontend', 'tester']

export function roleCardsWithDefaults(overrides?: Partial<Record<RoleId, RoleCard>>): Record<RoleId, RoleCard> {
  if (!overrides) return DEFAULT_ROLE_CARDS
  return {
    researcher: overrides.researcher ?? DEFAULT_ROLE_CARDS.researcher,
    backend: overrides.backend ?? DEFAULT_ROLE_CARDS.backend,
    frontend: overrides.frontend ?? DEFAULT_ROLE_CARDS.frontend,
    tester: overrides.tester ?? DEFAULT_ROLE_CARDS.tester
  }
}

export function isRoleId(value: unknown): value is RoleId {
  return typeof value === 'string' && (ROLE_IDS as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// Glob handling (repository-relative POSIX patterns)
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function normalizeScope(scope: string): string {
  const trimmed = scope.trim()
  if (trimmed === '') throw new TeamError('write-scope-invalid', 'write scope cannot be empty')
  if (/^[a-zA-Z]:/.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    throw new TeamError('write-scope-invalid', `write scope must be repository-relative: ${scope}`)
  }
  if (trimmed.includes('..')) {
    throw new TeamError('write-scope-invalid', `write scope may not contain ..: ${scope}`)
  }
  return trimmed.replaceAll('\\', '/').replace(/\/+$/, '')
}

export function globToRegExp(pattern: string): RegExp {
  const glob = normalizeScope(pattern)
  let source = '^'
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index += 1
        if (glob[index + 1] === '/') {
          index += 1
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    source += escapeRegExp(char ?? '')
  }
  source += '$'
  return new RegExp(source)
}

export function matchesScope(pattern: string, path: string): boolean {
  let normalized: string
  try {
    normalized = normalizePosixPath(path)
  } catch {
    return false
  }
  return globToRegExp(pattern).test(normalized)
}

export function staticPrefix(pattern: string): string {
  const normalized = normalizeScope(pattern)
  const wildcard = normalized.search(/[*?]/)
  if (wildcard === -1) return normalized
  const before = normalized.slice(0, wildcard)
  const slash = before.lastIndexOf('/')
  return slash === -1 ? '' : before.slice(0, slash)
}

function sampleFromScope(pattern: string): string {
  const normalized = normalizeScope(pattern)
  return normalized
    .replaceAll('**', 'sample/sub')
    .replaceAll('*', 'sample')
    .replaceAll('?', 's')
}

/** Conservative coverage check used at plan-validation time. */
export function scopeCoveredBy(scope: string, allowedScopes: readonly string[]): boolean {
  const sample = sampleFromScope(scope)
  if (allowedScopes.some((allowed) => matchesScope(allowed, sample))) return true
  const prefix = staticPrefix(scope)
  if (prefix === '') return false
  return allowedScopes.some((allowed) => {
    const allowedPrefix = staticPrefix(allowed)
    return allowedPrefix !== '' && (prefix === allowedPrefix || prefix.startsWith(`${allowedPrefix}/`))
  })
}

export function scopesOverlap(left: string, right: string): boolean {
  const leftSample = sampleFromScope(left)
  const rightSample = sampleFromScope(right)
  return matchesScope(left, rightSample) || matchesScope(right, leftSample)
}

export function anyScopeOverlap(left: readonly string[], right: readonly string[]): boolean {
  for (const a of left) {
    for (const b of right) {
      if (scopesOverlap(a, b)) return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Permission convergence
// ---------------------------------------------------------------------------

function trim(
  field: TrimRecord['field'],
  requested: string,
  granted: string[],
  reason: string
): TrimRecord {
  return { field, requested, granted, reason }
}

export function resolveEffectivePermissions(project: ProjectPolicy, card: RoleCard): EffectivePermissions {
  const trimmed: TrimRecord[] = []
  const denied: TrimRecord[] = []

  let tools: ToolName[] = []
  for (const tool of card.tools) {
    if (!project.allowedTools.includes(tool)) {
      denied.push(trim('tool', tool, [], 'project policy does not allow this tool'))
      continue
    }
    if (tool === 'network' && !project.allowResearchNetwork) {
      denied.push(trim('tool', 'network', [], 'external research is disabled for this project'))
      continue
    }
    tools.push(tool)
  }
  tools = unique(tools)

  const writeScopes: string[] = []
  for (const scope of card.writeScopes) {
    try {
      const normalized = normalizeScope(scope)
      if (scopeCoveredBy(normalized, project.allowedWritePaths)) {
        writeScopes.push(normalized)
      } else {
        denied.push(trim('write', normalized, [], 'write scope is outside the project allow-list'))
      }
    } catch (error) {
      denied.push(trim('write', scope, [], error instanceof Error ? error.message : 'invalid scope'))
    }
  }

  if (card.writeScopes.length > 0 && writeScopes.length === 0) {
    tools = tools.filter((tool) => tool !== 'write')
    trimmed.push(trim('write', card.writeScopes.join(','), [], 'all requested write scopes were denied'))
  }

  let memoryView: MemoryView = 'off'
  if (project.memoryViews.includes(card.memoryView)) {
    memoryView = card.memoryView
  } else if (card.memoryView !== 'off') {
    trimmed.push(
      trim('memory', card.memoryView, ['off'], 'project memory policy does not expose the requested view')
    )
  }

  if (card.integrationOnly) {
    // The tester writes only through the isolated integration gate, never into
    // the task worktrees. Keep the runtime flag explicit.
    trimmed.push(trim('write', 'integration-only', [project.integrationRoot], 'writes are confined to the integration copy'))
  }

  return {
    roleId: card.id,
    tools,
    writeScopes: unique(writeScopes),
    memoryView,
    integrationOnly: card.integrationOnly,
    trimmed,
    denied
  }
}

export function resolveAllPermissions(
  project: ProjectPolicy,
  cards: Record<RoleId, RoleCard>
): Record<RoleId, EffectivePermissions> {
  return {
    researcher: resolveEffectivePermissions(project, cards.researcher),
    backend: resolveEffectivePermissions(project, cards.backend),
    frontend: resolveEffectivePermissions(project, cards.frontend),
    tester: resolveEffectivePermissions(project, cards.tester)
  }
}

export function canWritePath(permissions: EffectivePermissions, path: string): boolean {
  if (permissions.integrationOnly) return false
  if (!permissions.tools.includes('write')) return false
  return permissions.writeScopes.some((scope) => matchesScope(scope, path))
}

export function assertWritePath(permissions: EffectivePermissions, path: string): void {
  if (!canWritePath(permissions, path)) {
    throw new TeamError('write-denied', `${permissions.roleId} may not write ${path}`)
  }
}

export function toolGranted(permissions: EffectivePermissions, tool: ToolName): boolean {
  return permissions.tools.includes(tool)
}

/** All scopes declared by a plan must stay inside the role's granted scopes. */
export function taskWriteScopeDenied(
  taskScope: readonly string[],
  permissions: EffectivePermissions
): string | undefined {
  if (taskScope.length === 0) return undefined
  if (permissions.integrationOnly) return 'role may write only inside the integration copy'
  if (!permissions.tools.includes('write')) return 'role has no write tool after permission convergence'
  for (const scope of taskScope) {
    if (!permissions.writeScopes.some((granted) => scopeCoveredBy(scope, [granted]))) {
      return `scope ${scope} is not covered by the granted write scopes`
    }
  }
  return undefined
}

export function describePermissions(permissions: EffectivePermissions): string {
  const tools = permissions.tools.join(',') || 'none'
  const writes = permissions.writeScopes.join(',') || 'none'
  return `${permissions.roleId}: tools=[${tools}] memory=${permissions.memoryView} write=[${writes}]`
}

export function memoryViewsIntersection(project: ProjectPolicy, requested: MemoryView[]): MemoryView[] {
  return intersection(requested, project.memoryViews)
}
