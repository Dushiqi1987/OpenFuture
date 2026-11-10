import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ComputerToolContent, ComputerToolInfo, ComputerToolResult } from '../shared/protocol'
import { requestHostTool } from './tool-bridge'

const COMPUTER_TOOL_TIMEOUT_MS = 60_000

function contentOf(value: unknown): { content: ComputerToolContent[]; details: unknown } {
  if (value && typeof value === 'object') {
    const record = value as Partial<ComputerToolResult>
    if (Array.isArray(record.content)) {
      const content: ComputerToolContent[] = []
      for (const item of record.content) {
        if (!item || typeof item !== 'object') continue
        const entry = item as Record<string, unknown>
        if (entry.type === 'text' && typeof entry.text === 'string') {
          content.push({ type: 'text', text: entry.text })
        } else if (entry.type === 'image' && typeof entry.data === 'string') {
          content.push({
            type: 'image',
            data: entry.data,
            mimeType: typeof entry.mimeType === 'string' ? entry.mimeType : 'image/png'
          })
        }
      }
      if (content.length > 0) return { content, details: value }
    }
  }
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    details: value
  }
}

function computerTool(info: ComputerToolInfo): ToolDefinition<any, any, any> {
  return {
    name: info.name,
    label: info.label,
    description: info.description,
    parameters: info.parameters,
    execute: async (_toolCallId: string, params: any, signal?: AbortSignal) =>
      contentOf(
        await requestHostTool(info.name, params, signal, COMPUTER_TOOL_TIMEOUT_MS)
      )
  } as unknown as ToolDefinition<any, any, any>
}

export function createComputerTools(tools: ComputerToolInfo[]): Array<ToolDefinition<any, any, any>> {
  return tools
    .filter(
      (tool) =>
        tool &&
        typeof tool.name === 'string' &&
        tool.name.startsWith('computer_') &&
        typeof tool.description === 'string' &&
        tool.parameters &&
        typeof tool.parameters === 'object'
    )
    .map(computerTool)
}
