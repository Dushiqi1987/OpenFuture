/**
 * Deterministic worker used by the M0 end-to-end fixture. It implements the
 * same Worker contract a Pi-backed worker will use in M1, including inbox
 * requests, immutable contracts and role-scoped diffs.
 */

import { TaskFailureError } from './errors.ts'
import { isTerminalTaskState, type TaskResult } from './types.ts'
import type { Worker, WorkerContext } from './worker.ts'

function contractDocument(): Record<string, unknown> {
  return {
    openapi: '3.0.3',
    info: {
      title: 'OpenFuture Settings API',
      version: '1.0.0',
      description: 'Synthetic contract used by the M0 multi-agent fixture'
    },
    paths: {
      '/api/settings': {
        get: {
          operationId: 'getSettings',
          responses: {
            '200': {
              description: 'Current settings',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Settings' }
                }
              }
            }
          }
        },
        put: {
          operationId: 'updateSettings',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Settings' }
              }
            }
          },
          responses: {
            '200': { description: 'Updated settings' }
          }
        }
      },
      '/health': {
        get: {
          operationId: 'health',
          responses: { '200': { description: 'Service is healthy' } }
        }
      }
    },
    components: {
      schemas: {
        Settings: {
          type: 'object',
          required: ['theme', 'language'],
          properties: {
            theme: { type: 'string', enum: ['light', 'dark'] },
            language: { type: 'string' }
          }
        }
      }
    }
  }
}

const SETTINGS_SERVICE = `import type { Settings } from '../../contracts/settings-types.ts'

const defaults: Settings = { theme: 'light', language: 'zh-CN' }
let current: Settings = { ...defaults }

export function getSettings(): Settings {
  return { ...current }
}

export function updateSettings(next: Partial<Settings>): Settings {
  current = { ...current, ...next }
  return { ...current }
}
`

const SETTINGS_TYPES = `export interface Settings {
  theme: 'light' | 'dark'
  language: string
}
`

const SERVER_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getSettings, updateSettings } from '../../src/server/settings.ts'

test('defaults are stable', () => {
  assert.equal(getSettings().theme, 'light')
})

test('update merges settings', () => {
  assert.equal(updateSettings({ theme: 'dark' }).theme, 'dark')
})
`

const FRONTEND_SETTINGS = `import type { Settings } from '../../contracts/settings-types.ts'

export interface SettingsViewModel {
  title: string
  fields: Array<{ key: keyof Settings; label: string; value: string }>
}

export function buildSettingsView(settings: Settings): SettingsViewModel {
  return {
    title: '设置',
    fields: [
      { key: 'theme', label: '主题', value: settings.theme },
      { key: 'language', label: '语言', value: settings.language }
    ]
  }
}
`

const FRONTEND_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSettingsView } from '../../src/web/settings.ts'

test('settings view follows the contract fields', () => {
  const view = buildSettingsView({ theme: 'dark', language: 'zh-CN' })
  assert.equal(view.fields.length, 2)
  assert.equal(view.fields[0]?.key, 'theme')
})
`

class ResearcherWorker implements Worker {
  readonly id = 'simulated-researcher'

  async run(ctx: WorkerContext): Promise<TaskResult> {
    ctx.log('检索公开资料并整理出处', 0.2)
    const report = `# 研究简报：本地优先多 Agent 协作

## 结论
1. 本地优先的 Agent 编排通常把任务图、消息传递和工具权限分开建模，便于审计与恢复。
2. 受控收件箱需要 correlation id、幂等键和超时升级，否则并发等待会互相阻塞。
3. 合同先行（OpenAPI/类型）能显著降低前后端并行时的返工。

## 出处
- 合成夹具说明（原型内部资料）：docs/OpenFuture-多Agent协作设计-v0.4.md
- OpenAI Agents SDK 文档（公开，检索日期 2026-11-09）：https://openai.github.io/openai-agents-python/
- LangGraph 文档（公开，检索日期 2026-11-09）：https://langchain-ai.github.io/langgraph/

## 可信度与未知项
- 原型内使用合成数据，未访问真实项目私密内容。
- 未评估真实网络延迟和模型成本；后续 M1 再验证。
`
    const artifact = await ctx.publish({
      name: 'research-report',
      version: '1.0.0',
      kind: 'research-report',
      content: report
    })
    ctx.log('等待后端的研究请求', 0.6)
    try {
      const [request] = await ctx.wait({
        timeoutMs: Math.min(ctx.task.budget.requestTimeoutMs, 4000),
        consumes: [],
        issues: []
      })
      if (request && request.type === 'request' && request.fromAgentId) {
        await ctx.send({
          toAgentId: request.fromAgentId,
          correlationId: request.correlationId,
          clientMessageId: `${ctx.task.id}:reply:${request.id}`,
          type: 'reply',
          body: '研究简报已完成。关键结论：任务图与收件箱分离；合同先行；等待必须释放执行槽。出处见附件。',
          artifactRefs: [artifact.id]
        })
        ctx.log('已回复后端并附带出处', 0.9)
      }
    } catch (error) {
      if (error instanceof TaskFailureError && error.code === 'inbox-timeout') {
        ctx.log('没有收到研究请求，直接交付简报', 0.9)
      } else {
        throw error
      }
    }
    return {
      summary: '完成本地优先 Agent 协作研究简报，附 3 条出处与可信度说明。',
      checks: [{ id: 'research-citations', status: 'passed', detail: '3 sources declared' }]
    }
  }
}

class BackendWorker implements Worker {
  readonly id = 'simulated-backend'

  async run(ctx: WorkerContext): Promise<TaskResult> {
    ctx.log('确认研究输入', 0.1)
    let research = ctx.findArtifact('research-report')
    let citationNote = research ? '直接复用已完成的研究产物' : '未获得研究产物，仅使用本地设计文档'
    const researchTask = ctx.listTaskSnapshots().find((task) => task.role === 'researcher')
    const researchSettled = researchTask ? isTerminalTaskState(researchTask.state) : true
    if (!researchSettled) {
      const request = ctx.send({
        toRole: 'researcher',
        clientMessageId: `${ctx.task.id}:research-request`,
        type: 'request',
        body: `后端需要为设置页接口补充公开依据：${ctx.task.title}`
      })
      ctx.log('等待研究助手回复', 0.25)
      try {
        const replies = await ctx.wait({
          timeoutMs: Math.min(ctx.task.budget.requestTimeoutMs, 5000),
          correlationId: request.message.correlationId,
          consumes: [request.message.correlationId],
          issues: [request.message.correlationId]
        })
        const reply = replies[0]
        if (reply) {
          const attached = reply.artifactRefs
            .map((id) => ctx.findArtifactById(id))
            .find((ref) => ref !== undefined)
          research = attached ?? ctx.findArtifact('research-report')
          citationNote = `收到研究回复 ${reply.id}，引用产物 ${research?.name ?? 'unknown'}`
        }
      } catch (error) {
        if (error instanceof TaskFailureError && error.code === 'inbox-timeout') {
          citationNote = '研究回复超时，降级为本地资料并在报告中标注'
          ctx.log(citationNote, 0.35)
        } else {
          throw error
        }
      }
    } else if (research) {
      citationNote = `研究任务已完成，引用 ${research.name}@${research.version}`
    }

    ctx.log('发布 OpenAPI 合同', 0.45)
    const document = contractDocument()
    const contractText = `${JSON.stringify(document, null, 2)}\n`
    const contract = await ctx.publish({
      name: 'openapi.json',
      version: '1.0.0',
      kind: 'contract',
      content: contractText
    })
    ctx.send({
      toRole: 'frontend',
      clientMessageId: `${ctx.task.id}:contract:frontend:1.0.0`,
      correlationId: 'contract:openapi:1.0.0',
      type: 'contract',
      body: 'OpenAPI 1.0.0 已发布，前端只消费该版本；设置页字段为 theme/language。',
      artifactRefs: [contract.id]
    })
    ctx.send({
      toRole: 'tester',
      clientMessageId: `${ctx.task.id}:contract:tester:1.0.0`,
      correlationId: 'contract:openapi:1.0.0',
      type: 'contract',
      body: 'OpenAPI 1.0.0 已发布，集成验收需覆盖 GET/PUT /api/settings。',
      artifactRefs: [contract.id]
    })

    await ctx.publish({
      name: 'backend-notes',
      version: '1.0.0',
      kind: 'generic',
      content: `# 后端说明\n\n- 合同版本：1.0.0\n- ${citationNote}\n- 合同文件：contracts/openapi.json\n`
    })

    ctx.log('生成服务与测试差异', 0.8)
    return {
      summary: `后端交付 OpenAPI 1.0.0 与设置服务差异；${citationNote}。`,
      fileChanges: [
        { path: 'contracts/openapi.json', content: contractText },
        { path: 'contracts/settings-types.ts', content: SETTINGS_TYPES },
        { path: 'src/server/settings.ts', content: SETTINGS_SERVICE },
        { path: 'tests/server/settings.test.ts', content: SERVER_TEST }
      ],
      checks: [
        { id: 'contract-valid', status: 'passed', detail: 'openapi 3.0.3' },
        { id: 'server-unit-tests', status: 'passed', detail: '2 synthetic tests' }
      ],
      notes: [citationNote]
    }
  }
}

class FrontendWorker implements Worker {
  readonly id = 'simulated-frontend'

  async run(ctx: WorkerContext): Promise<TaskResult> {
    ctx.log('读取已固定的接口合同', 0.2)
    const pinned =
      ctx.resolvedInputs.find((ref) => ref.kind === 'contract') ??
      ctx.findArtifact('openapi.json')
    if (!pinned) {
      throw new TaskFailureError('contract-missing', 'frontend requires openapi.json from the backend', {
        retryable: false
      })
    }
    const contractText = await ctx.readArtifactText(pinned)
    let document: Record<string, unknown>
    try {
      document = JSON.parse(contractText) as Record<string, unknown>
    } catch {
      throw new TaskFailureError('contract-invalid', 'pinned contract is not valid JSON', { retryable: false })
    }
    const paths = (document.paths ?? {}) as Record<string, unknown>
    if (!paths['/api/settings']) {
      throw new TaskFailureError('contract-mismatch', 'pinned contract has no /api/settings path', {
        retryable: false,
        details: { contractVersion: pinned.version }
      })
    }
    const contractVersion = pinned.version
    ctx.log(`按合同 ${contractVersion} 生成设置页`, 0.5)

    const build = await ctx.publish({
      name: 'web-build',
      version: contractVersion,
      kind: 'code-diff',
      content: JSON.stringify(
        {
          contract: { name: pinned.name, version: contractVersion, sha256: pinned.sha256 },
          files: ['src/web/settings.ts', 'tests/web/settings.test.ts'],
          mockServer: 'in-memory contract mock'
        },
        null,
        2
      )
    })
    const report = await ctx.publish({
      name: 'frontend-report',
      version: '1.0.0',
      kind: 'test-report',
      content: JSON.stringify(
        {
          status: 'passed',
          contractVersion,
          checks: [
            { id: 'contract-pin', status: 'passed', detail: pinned.sha256 },
            { id: 'component-tests', status: 'passed', detail: '2 synthetic tests' }
          ]
        },
        null,
        2
      )
    })
    ctx.send({
      toRole: 'tester',
      clientMessageId: `${ctx.task.id}:review:1.0.0`,
      correlationId: 'review:web-build:1.0.0',
      type: 'review',
      body: `前端按 openapi.json@${contractVersion} 完成设置页，请验收。`,
      artifactRefs: [build.id, report.id]
    })
    return {
      summary: `前端按合同 ${contractVersion} 完成设置页与组件测试。`,
      fileChanges: [
        { path: 'src/web/settings.ts', content: FRONTEND_SETTINGS },
        { path: 'tests/web/settings.test.ts', content: FRONTEND_TEST }
      ],
      checks: [
        { id: 'contract-pin', status: 'passed', detail: `${pinned.name}@${pinned.version}` },
        { id: 'web-unit-tests', status: 'passed', detail: '2 synthetic tests' }
      ],
      notes: [`contract sha256 ${pinned.sha256.slice(0, 12)}`]
    }
  }
}

class TesterWorker implements Worker {
  readonly id = 'simulated-tester'

  async run(ctx: WorkerContext): Promise<TaskResult> {
    ctx.log('读取独立集成报告', 0.2)
    const report = ctx.integrationReport()
    if (!report) {
      throw new TaskFailureError('integration-missing', 'integration gate did not run before tester', {
        retryable: false
      })
    }
    if (report.status !== 'passed') {
      throw new TaskFailureError('integration-blocked', `integration gate is ${report.status}`, {
        retryable: false,
        details: { blockers: report.blockers }
      })
    }
    ctx.log('复核产物哈希与合同版本', 0.5)
    const verified: string[] = []
    for (const ref of ctx.resolvedInputs) {
      if (!(await ctx.verifyArtifact(ref))) {
        throw new TaskFailureError('artifact-corrupt', `artifact ${ref.name}@${ref.version} failed verification`, {
          retryable: false
        })
      }
      verified.push(`${ref.name}@${ref.version}`)
    }
    const checks = report.checks.map((check) => ({
      id: `integration:${check.id}`,
      status: check.status,
      ...(check.detail ? { detail: check.detail } : {})
    }))
    const testReport = {
      status: 'passed' as const,
      integrationRevision: report.evidence.integrationRevision,
      verifiedInputs: verified,
      checks,
      blockers: report.blockers
    }
    const artifact = await ctx.publish({
      name: 'test-report',
      version: '1.0.0',
      kind: 'test-report',
      content: JSON.stringify(testReport, null, 2)
    })
    ctx.send({
      toRole: 'backend',
      clientMessageId: `${ctx.task.id}:review:backend`,
      correlationId: 'review:integration:1.0.0',
      type: 'review',
      body: `集成验收通过，报告 ${artifact.id}，集成修订 ${report.evidence.integrationRevision.slice(0, 12)}。`,
      artifactRefs: [artifact.id]
    })
    ctx.log('集成验收通过', 0.95)
    return {
      summary: `独立集成验收通过：${report.evidence.files} 个文件、${verified.length} 个输入产物。`,
      checks: [{ id: 'synthetic-integration-suite', status: 'passed', detail: report.evidence.integrationRevision }],
      notes: [`integrationRevision ${report.evidence.integrationRevision}`]
    }
  }
}

export interface SimulatedWorkerOptions {
  /** Optional per-role override, mainly for failure injection tests. */
  overrides?: Partial<Record<'researcher' | 'backend' | 'frontend' | 'tester', Worker>>
}

export function simulatedWorkerFactory(options: SimulatedWorkerOptions = {}): (task: { role: string }) => Worker {
  const factory = new SimulatedWorkerFactory(options)
  return (task) => factory.workerFor(task.role)
}

export class SimulatedWorkerFactory {
  private readonly workers: Record<string, Worker>
  private readonly overrides: Partial<Record<string, Worker>>

  constructor(options: SimulatedWorkerOptions = {}) {
    this.workers = {
      researcher: new ResearcherWorker(),
      backend: new BackendWorker(),
      frontend: new FrontendWorker(),
      tester: new TesterWorker()
    }
    this.overrides = options.overrides ?? {}
  }

  workerFor(role: string): Worker {
    const override = this.overrides[role]
    if (override) return override
    const worker = this.workers[role]
    if (!worker) throw new Error(`no simulated worker for role ${role}`)
    return worker
  }
}
