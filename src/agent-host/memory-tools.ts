/**
 * Read-only memory tools exposed to the Pi agent.
 *
 * Tool calls travel over the utilityProcess parentPort to the main process,
 * which owns the workspace check and talks to the memory host. The agent never
 * receives direct SQLite access and cannot publish or revoke anything.
 */
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { MemoryMode } from '../shared/protocol'
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
      textResult(await requestHostTool(name, params, signal))
  } as unknown as ToolDefinition<any, any, any>
}

const LIMIT_SCHEMA = {
  type: 'number',
  description: '最多返回多少条结果，1-50，默认 8。',
  minimum: 1,
  maximum: 50
} as const

export function createMemoryTools(workspace: string, mode: MemoryMode): Array<ToolDefinition<any, any, any>> {
  if (mode === 'off') return []
  const tools: Array<ToolDefinition<any, any, any>> = []

  if (mode === 'rag' || mode === 'both') {
    tools.push(
      tool(
        'memory_search',
        'Search memory',
        `Search the local evidence, notes and wiki memory of the current workspace (${workspace}). Returns citable hits with source titles and ids. This tool is read-only.`,
        {
          type: 'object',
          properties: {
            query: { type: 'string', description: '要检索的关键词或问题。' },
            limit: LIMIT_SCHEMA
          },
          required: ['query'],
          additionalProperties: false
        }
      ),
      tool(
        'memory_get',
        'Read memory item',
        'Read one memory hit by id (evidence, note or wiki page) from the current workspace.',
        {
          type: 'object',
          properties: { id: { type: 'string', description: '检索结果中的 id。' } },
          required: ['id'],
          additionalProperties: false
        }
      ),
      tool(
        'memory_propose',
        'Propose a memory note',
        'Propose a note candidate for the user to review later. It never publishes directly. Supply concrete evidence ids from memory_search when possible.',
        {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['fact', 'preference', 'decision', 'lesson'], description: '候选类型。' },
            title: { type: 'string', description: '候选标题。' },
            body: { type: 'string', description: '候选正文，使用 Markdown。' },
            evidenceIds: {
              type: 'array',
              items: { type: 'string' },
              description: '支撑这个候选的证据 id，可来自 memory_search。'
            }
          },
          required: ['type', 'title', 'body', 'evidenceIds'],
          additionalProperties: false
        }
      )
    )
  }

  if (mode === 'wiki' || mode === 'both') {
    tools.push(
      tool(
        'wiki_search',
        'Search wiki',
        `Search published wiki pages in the current workspace (${workspace}). Read-only.`,
        {
          type: 'object',
          properties: {
            query: { type: 'string', description: '要检索的关键词。' },
            limit: LIMIT_SCHEMA
          },
          required: ['query'],
          additionalProperties: false
        }
      ),
      tool(
        'wiki_get',
        'Read wiki page',
        'Read one wiki page by id from the current workspace.',
        {
          type: 'object',
          properties: { id: { type: 'string', description: '检索结果中的 wiki id。' } },
          required: ['id'],
          additionalProperties: false
        }
      )
    )
  }

  return tools
}
