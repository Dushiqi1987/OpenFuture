/**
 * `delegate_tasks` tool: the orchestration surface exposed to the main agent.
 *
 * The tool is intentionally one-shot per batch (1-4 tasks) instead of a
 * long-lived task graph. The parent model plans, fans out, and then reasons
 * over the aggregated text, which maps onto how coding agents actually use
 * subagents and keeps the tool contract small enough to stay reliable.
 */
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { SubagentRuntime, SubagentTaskInput, SubagentTaskResult } from './subagent-runtime'
import { SUBAGENT_MAX_TASKS } from './subagent-runtime'

const MAX_TITLE_CHARS = 120
const MAX_PROMPT_CHARS = 20_000
const MAX_OUTPUT_CHARS = 30_000

const OUTCOME_LABELS: Record<SubagentTaskResult['outcome'], string> = {
  done: '完成',
  failed: '失败',
  aborted: '已取消',
  timeout: '超时'
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function parseTasks(raw: unknown): SubagentTaskInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('tasks 必须是非空数组')
  }
  if (raw.length > SUBAGENT_MAX_TASKS) {
    throw new Error(`一次最多派发 ${SUBAGENT_MAX_TASKS} 个子任务`)
  }
  return raw.map((item, index) => {
    const record = (item ?? {}) as { title?: unknown; prompt?: unknown }
    const title = typeof record.title === 'string' ? record.title.trim() : ''
    const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : ''
    if (title === '') throw new Error(`tasks[${index}].title 不能为空`)
    if (prompt === '') throw new Error(`tasks[${index}].prompt 不能为空`)
    if (title.length > MAX_TITLE_CHARS) throw new Error(`tasks[${index}].title 过长`)
    if (prompt.length > MAX_PROMPT_CHARS) throw new Error(`tasks[${index}].prompt 过长`)
    return { title, prompt }
  })
}

function formatResults(results: SubagentTaskResult[], totalDurationMs: number): string {
  const succeeded = results.filter((result) => result.outcome === 'done').length
  const header = `子 Agent 执行完成：${results.length} 个任务，成功 ${succeeded}，用时 ${(totalDurationMs / 1000).toFixed(1)}s`
  const sections = results.map((result, index) => {
    const lines = [
      `## ${index + 1}. ${result.title} — ${OUTCOME_LABELS[result.outcome]}（${(result.durationMs / 1000).toFixed(1)}s）`
    ]
    if (result.error) lines.push(`错误：${result.error}`)
    if (result.text) lines.push('', result.text)
    if (result.sessionFile) lines.push('', `（完整记录：${result.sessionFile}）`)
    return lines.join('\n')
  })
  const text = [header, '', ...sections].join('\n')
  if (text.length <= MAX_OUTPUT_CHARS) return text
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n…（结果已截断，共 ${text.length} 字符；请缩小单个子任务的输出范围）`
}

export function createSubagentTools(runtime: SubagentRuntime): Array<ToolDefinition<any, any, any>> {
  return [
    {
      name: 'delegate_tasks',
      label: 'Delegate parallel subagents',
      description: [
        '把互不依赖的子任务并行派发给独立子 Agent（每个子 Agent 是独立上下文的 Pi 会话，共享当前工作区与模型，最多同时 3 个）。',
        '适用：并行调研/检索、分别定位多处代码、对比多套方案、独立复核结论。',
        '不适用：依赖当前对话历史的追问、必须按顺序执行的步骤、需要你亲自确认用户意图的操作。',
        '每个 prompt 必须自包含：子 Agent 看不到本对话，也没有 delegate_tasks，不能再次派发。',
        '子 Agent 与你在同一工作区，避免让多个子任务同时写同一批文件。全部任务结束后本工具一次返回汇总文本。',
        '一次派发 2-3 个粒度清晰的任务通常比串行更快；单个任务能直接完成时不要使用本工具。'
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            minItems: 1,
            maxItems: SUBAGENT_MAX_TASKS,
            description: '互相独立、可并行的子任务列表。',
            items: {
              type: 'object',
              properties: {
                title: {
                  type: 'string',
                  description: `简短标题（最多 ${MAX_TITLE_CHARS} 字），用于进度展示和结果索引。`
                },
                prompt: {
                  type: 'string',
                  description:
                    '交给子 Agent 的完整任务说明：背景、目标、约束、期望输出格式。子 Agent 看不到当前对话。'
                }
              },
              required: ['title', 'prompt'],
              additionalProperties: false
            }
          },
          timeoutSeconds: {
            type: 'number',
            minimum: 30,
            maximum: 600,
            description: '单个子任务的超时时间（秒），默认 180。'
          }
        },
        required: ['tasks'],
        additionalProperties: false
      },
      execute: async (_toolCallId: string, params: any, signal?: AbortSignal) => {
        const tasks = parseTasks(params?.tasks)
        const timeoutMs = clampInteger(params?.timeoutSeconds, 180, 30, 600) * 1000
        const startedAt = Date.now()
        const results = await runtime.run(tasks, { signal, timeoutMs })
        return {
          content: [{ type: 'text' as const, text: formatResults(results, Date.now() - startedAt) }],
          details: {
            tasks: results.map((result) => ({
              taskId: result.taskId,
              title: result.title,
              outcome: result.outcome,
              durationMs: result.durationMs,
              assistantMessages: result.assistantMessages,
              sessionFile: result.sessionFile
            }))
          }
        }
      }
    } as unknown as ToolDefinition<any, any, any>
  ]
}
