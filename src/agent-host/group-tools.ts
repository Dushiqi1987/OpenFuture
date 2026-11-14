/**
 * `start_group_chat` tool: run one serial group chat (lead + critic + chair).
 *
 * The tool is deliberately synchronous from the parent model's point of view:
 * the parent asks a question, the group argues, and the tool returns the whole
 * transcript plus the chair's synthesis. That keeps the parent turn simple and
 * mirrors how `delegate_tasks` aggregates parallel work.
 */
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { GroupChatResult, GroupChatRuntime } from './group-chat'
import { GROUP_CHAT_MAX_ROUNDS, GROUP_CHAT_MIN_ROUNDS } from './group-chat'
import type { GroupChatStatus } from '../shared/protocol'

const MAX_GOAL_CHARS = 4_000
const MAX_CONSTRAINTS_CHARS = 2_000
const MAX_FOCUS_CHARS = 1_000
const MAX_OUTPUT_CHARS = 30_000

const STATUS_LABELS: Record<GroupChatStatus, string> = {
  running: '进行中',
  consensus: '已达成共识',
  unresolved: '未收敛',
  stalled: '停滞',
  aborted: '已取消',
  failed: '失败'
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function capture(text: unknown, limit: number, label: string): string {
  if (text === undefined || text === null) return ''
  if (typeof text !== 'string') throw new Error(`${label}必须是字符串`)
  const trimmed = text.trim()
  if (trimmed.length > limit) throw new Error(`${label}过长（最多 ${limit} 字）`)
  return trimmed
}

function formatTranscript(result: GroupChatResult): string {
  const header = `群聊结束：${STATUS_LABELS[result.status]}（${result.rounds} 轮，${(result.durationMs / 1000).toFixed(1)}s）`
  const transcript = result.messages.map((message) => {
    const evidence = message.tools.length > 0 ? `\n（工具：${message.tools.join('、')}）` : ''
    return `### [#${message.seq} ${message.roleLabel}/${message.stage}]\n${message.text}${evidence}`
  })
  const parts = [header, '', '## 群聊记录', '', ...transcript, '', '## 最终结论', '', result.summary]
  if (result.error) parts.push('', `错误：${result.error}`)
  const text = parts.join('\n')
  if (text.length <= MAX_OUTPUT_CHARS) return text
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n…（群聊记录已截断，共 ${text.length} 字符；完整记录见子会话文件）`
}

export function createGroupChatTools(runtime: GroupChatRuntime): Array<ToolDefinition<any, any, any>> {
  return [
    {
      name: 'start_group_chat',
      label: 'Start a group chat',
      description: [
        '发起一次「群聊」：主研（lead）先实际调查并汇报，评审（critic）基于任务目标与证据逐条质疑，主研回应修订，最多 3 轮，最后由主持（chair）综合成共识或未收敛结论。',
        '适用：方案取舍、设计评审、需要自我审查的高风险判断、用户明确要求"多角色讨论/开会"的任务。',
        '不适用：确定性查询、单步操作、需要修改文件的实现类任务（群聊不开放写权限，且同一工作区里只应有一个执行者）。',
        '群聊是串行的：同一时刻只有一个角色发言和调用工具；每个角色是独立会话，只看到注入的群聊增量与台账，不继承当前对话历史。',
        '代价：一轮群聊约等于 3-4 次完整推理，比直接回答贵得多；只有确实需要对抗性审查时再使用。'
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          goal: {
            type: 'string',
            description: `要讨论的目标或问题，写清背景、期望产出与判断标准（最多 ${MAX_GOAL_CHARS} 字）。`
          },
          constraints: {
            type: 'string',
            description: '硬约束：技术栈、兼容性、时间/成本上限、不可触碰的文件或接口。'
          },
          focus: {
            type: 'string',
            description: '希望评审重点盯住的风险面，例如「并发安全」「迁移成本」「与现有协议的兼容性」。'
          },
          rounds: {
            type: 'number',
            minimum: GROUP_CHAT_MIN_ROUNDS,
            maximum: GROUP_CHAT_MAX_ROUNDS,
            description: `工作/质疑/回应轮数，默认 2，最多 ${GROUP_CHAT_MAX_ROUNDS}。`
          }
        },
        required: ['goal'],
        additionalProperties: false
      },
      execute: async (_toolCallId: string, params: any, signal?: AbortSignal) => {
        const goal = capture(params?.goal, MAX_GOAL_CHARS, 'goal')
        if (goal === '') throw new Error('goal 不能为空')
        const constraints = capture(params?.constraints, MAX_CONSTRAINTS_CHARS, 'constraints')
        const focus = capture(params?.focus, MAX_FOCUS_CHARS, 'focus')
        const rounds = clampInteger(params?.rounds, 2, GROUP_CHAT_MIN_ROUNDS, GROUP_CHAT_MAX_ROUNDS)
        const result = await runtime.run(
          {
            goal,
            ...(constraints === '' ? {} : { constraints }),
            ...(focus === '' ? {} : { focus }),
            rounds
          },
          { signal }
        )
        return {
          content: [{ type: 'text' as const, text: formatTranscript(result) }],
          details: {
            chatId: result.chatId,
            status: result.status,
            rounds: result.rounds,
            durationMs: result.durationMs,
            messages: result.messages.length
          }
        }
      }
    } as unknown as ToolDefinition<any, any, any>
  ]
}
