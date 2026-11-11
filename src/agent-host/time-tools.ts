/**
 * Minimal clock tool.
 *
 * The system prompt carries a date-only block so the provider's prefix cache
 * stays stable for the whole day. Exact minute-level time is available through
 * this tool instead, which keeps the cacheable prefix unchanged.
 */
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

function nowText(): string {
  const now = new Date()
  const date = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long'
  }).format(now)
  const time = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(now)
  return `当前时间：${date} ${time}（Asia/Shanghai）`
}

export function createTimeTools(): Array<ToolDefinition<any, any, any>> {
  return [
    {
      name: 'current_time',
      label: 'Get current time',
      description:
        'Return the exact current date and time in Asia/Shanghai. Use this when the user asks for the current time, when minute-level recency matters, or when the date block in the system prompt is not precise enough. Do not guess the time.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      execute: async () => ({
        content: [{ type: 'text', text: nowText() }],
        details: { timeZone: 'Asia/Shanghai' }
      })
    } as unknown as ToolDefinition<any, any, any>
  ]
}
