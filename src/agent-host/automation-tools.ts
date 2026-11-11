/**
 * Automation tools exposed to the interactive Pi agent.
 *
 * The tools only describe the request. The main process resolves the current
 * workspace to its project, validates the schedule, and writes the task to the
 * same AutomationStore used by the desktop automation panel. A scheduled task
 * always runs in a fresh conversation under that project, never by mutating the
 * user's live conversation.
 */
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { requestHostTool } from './tool-bridge'

function textResult(value: unknown): { content: Array<{ type: 'text'; text: string }>; details: unknown } {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return { content: [{ type: 'text', text }], details: value }
}

function tool(
  name: string,
  label: string,
  description: string,
  parameters: Record<string, unknown>
): ToolDefinition<any, any, any> {
  return {
    name,
    label,
    description,
    parameters,
    execute: async (_toolCallId: string, params: any, signal?: AbortSignal) =>
      textResult(await requestHostTool(name, params, signal, 20_000))
  } as unknown as ToolDefinition<any, any, any>
}

const SCHEDULE_KIND = {
  type: 'string',
  enum: ['once', 'interval', 'daily', 'weekly'],
  description: 'once=只执行一次；interval=每隔 N 分钟；daily=每天固定时间；weekly=每周固定星期和时间。'
} as const

export function createAutomationTools(): Array<ToolDefinition<any, any, any>> {
  return [
    tool(
      'automation_create',
      'Create scheduled task',
      'Create a scheduled task in the current project. The task runs later in a fresh conversation under the same project and can use the project memory, tools, and Computer Use settings. Use this when the user asks you to do something after a delay or on a recurring schedule. The task prompt should be complete and self-contained because the later run will not see this chat.',
      {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: '短任务名，便于在自动化面板识别；省略时根据 prompt 生成。'
          },
          prompt: {
            type: 'string',
            description: '到点后执行的完整指令。必须自包含，不能依赖当前对话的上下文。'
          },
          scheduleKind: SCHEDULE_KIND,
          delayMinutes: {
            type: 'number',
            description: 'once 任务延迟多少分钟执行，1–10080；与 runAt 二选一。例如“一分钟后”传 1。',
            minimum: 1,
            maximum: 10080
          },
          runAt: {
            type: 'string',
            description: 'once 任务的 ISO 时间；如果用户给了明确时间可用。与 delayMinutes 二选一。'
          },
          everyMinutes: {
            type: 'number',
            description: 'interval 任务的间隔分钟，1–10080。',
            minimum: 1,
            maximum: 10080
          },
          timeOfDay: {
            type: 'string',
            description: 'daily/weekly 的本地时间，格式 HH:mm。',
            pattern: '^([01]\\d|2[0-3]):[0-5]\\d$'
          },
          weekday: {
            type: 'number',
            description: 'weekly 的星期：0=周日，1=周一 … 6=周六。',
            minimum: 0,
            maximum: 6
          }
        },
        required: ['prompt', 'scheduleKind'],
        additionalProperties: false
      }
    ),
    tool(
      'automation_list',
      'List scheduled tasks',
      'List scheduled tasks belonging to the current project, including their next run time, status, and recent runs.',
      {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    ),
    tool(
      'automation_set_active',
      'Pause or resume task',
      'Pause or resume one scheduled task in the current project by its task id. Resuming an expired one-off task is rejected.',
      {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'automation_list 返回的任务 id。' },
          active: { type: 'boolean', description: 'true=启用，false=暂停。' }
        },
        required: ['id', 'active'],
        additionalProperties: false
      }
    ),
    tool(
      'automation_cancel',
      'Cancel scheduled task',
      'Delete one scheduled task and its run history from the current project.',
      {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'automation_list 返回的任务 id。' }
        },
        required: ['id'],
        additionalProperties: false
      }
    )
  ]
}
