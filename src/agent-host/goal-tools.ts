/**
 * `update_goal` lets the model report progress on the long-running objective
 * the user started. The host owns the loop; this tool only mutates the record
 * and lets the UI show the latest note/status.
 */
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentGoal, AgentGoalStatus, GoalUpdateInput } from '../shared/protocol'

export function createGoalTool(update: (input: GoalUpdateInput) => AgentGoal | null): ToolDefinition<any, any, any> {
  return {
    name: 'update_goal',
    label: 'Update goal',
    description:
      'Record progress on the user-visible long-running goal. Call it at the end of every goal round: write one short note about what you changed or verified. Set status to "complete" only when the whole objective is achieved, or "blocked" when a concrete external condition stops progress.',
    parameters: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description: '一句话进度：本轮做了什么、验证了什么（≤300 字）。'
        },
        status: {
          type: 'string',
          enum: ['active', 'paused', 'complete', 'blocked'],
          description: 'complete=目标全部达成；blocked=被外部条件卡住（需在 note 写明）；active=继续。'
        }
      },
      additionalProperties: false
    },
    execute: async (_toolCallId: string, params: any) => {
      const input: GoalUpdateInput = {}
      if (typeof params?.note === 'string' && params.note.trim() !== '') input.note = params.note.trim().slice(0, 300)
      if (typeof params?.status === 'string') input.status = params.status as AgentGoalStatus
      const goal = update(input)
      return {
        content: [
          {
            type: 'text',
            text: goal
              ? `目标已更新：第 ${goal.round}/${goal.maxRounds} 轮 · ${goal.status}${goal.note ? ` · ${goal.note}` : ''}`
              : '当前没有进行中的目标，update_goal 已忽略。'
          }
        ],
        details: goal
      }
    }
  } as unknown as ToolDefinition<any, any, any>
}
