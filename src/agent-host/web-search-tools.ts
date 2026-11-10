/**
 * Free web search tools.
 *
 * The public dsh-free-search project wraps several keyless search providers for
 * DeepSeek Harness. OpenFuture uses the same keyless idea directly here:
 * Exa's public MCP endpoint first, AnySearch's anonymous tier as a fallback.
 * Exa is materially better for Chinese entity/company queries; AnySearch's
 * anonymous corpus is legal-document heavy and is therefore only a fallback.
 * No API key is required and nothing is written to disk.
 */
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

const ANYSEARCH_URL = 'https://api.anysearch.com/v1/search'
const EXA_MCP_URL = 'https://mcp.exa.ai/mcp'
const SEARCH_TIMEOUT_MS = 20_000

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

interface SearchPayload {
  provider: 'anysearch' | 'exa'
  query: string
  results: WebSearchResult[]
  note?: string
}

function clean(value: unknown, max = 500): string {
  return typeof value === 'string'
    ? value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
    : ''
}

function unique(results: WebSearchResult[], limit: number): WebSearchResult[] {
  const seen = new Set<string>()
  const output: WebSearchResult[] = []
  for (const item of results) {
    const url = item.url.trim()
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
    seen.add(url)
    output.push({ ...item, url })
    if (output.length >= limit) break
  }
  return output
}

async function anysearch(query: string, limit: number, signal?: AbortSignal): Promise<WebSearchResult[]> {
  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS)
  const response = await fetch(ANYSEARCH_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'OpenFuture/0.1 web-search'
    },
    body: JSON.stringify({ query, max_results: limit }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  })
  if (!response.ok) throw new Error(`AnySearch HTTP ${response.status}`)
  const body = (await response.json()) as {
    code?: number
    message?: string
    data?: { results?: Array<Record<string, unknown>> }
  }
  if (body.code !== 0) throw new Error(`AnySearch: ${body.message ?? body.code ?? 'unknown error'}`)
  return unique(
    (body.data?.results ?? []).map((item) => ({
      title: clean(item.title, 200),
      url: clean(item.url, 2000),
      snippet: clean(item.snippet ?? item.content, 500)
    })),
    limit
  ).filter((item) => item.title.length > 0)
}

function parseExaText(text: string): WebSearchResult[] {
  const results: WebSearchResult[] = []
  for (const block of text.split(/\n(?=Title:)/)) {
    const title = block.match(/^Title: (.+)$/m)?.[1]?.trim() ?? ''
    const url = block.match(/^URL: (\S+)$/m)?.[1]?.trim() ?? ''
    const highlights = block.split(/^Highlights:$/m)[1] ?? ''
    const snippet = clean(highlights.split('\n').filter((line) => line.trim() && !line.trim().startsWith('...')).join(' '), 500)
    if (url) results.push({ title: clean(title, 200), url, snippet })
  }
  return results
}

async function exaSearch(query: string, limit: number, signal?: AbortSignal): Promise<WebSearchResult[]> {
  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS)
  const response = await fetch(EXA_MCP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'web_search_exa', arguments: { query, numResults: limit } }
    }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  })
  if (!response.ok) throw new Error(`Exa MCP HTTP ${response.status}`)
  const raw = await response.text()
  let payload: any = null
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue
    try {
      payload = JSON.parse(line.slice(6))
      break
    } catch {
      // keep the final parse error below
    }
  }
  if (!payload) throw new Error('Exa MCP: invalid response')
  if (payload.error) throw new Error(`Exa MCP: ${payload.error.message ?? 'unknown error'}`)
  const content = Array.isArray(payload.result?.content) ? payload.result.content : []
  const text = content
    .filter((item: any) => item?.type === 'text' && typeof item.text === 'string')
    .map((item: any) => item.text)
    .join('\n')
  return unique(parseExaText(text), limit)
}

function format(payload: SearchPayload): string {
  if (payload.results.length === 0) {
    return `No web results for "${payload.query}" (${payload.provider}).`
  }
  const lines = [`Web search: ${payload.query} (provider: ${payload.provider})`]
  payload.results.forEach((item, index) => {
    lines.push('', `${index + 1}. ${item.title || item.url}`, item.url, item.snippet)
  })
  if (payload.note) lines.push('', payload.note)
  return lines.join('\n')
}

export function createWebSearchTools(): Array<ToolDefinition<any, any, any>> {
  return [
    {
      name: 'web_search',
      label: 'Search the web',
      description:
        'Search the public web for current information. Use this for news, company/entity lookups, recent facts, or anything the local workspace cannot answer. Results include title, URL and snippet; cite the URLs in the answer.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query, in the user’s language when possible.' },
          limit: { type: 'number', minimum: 1, maximum: 10, description: 'Number of results, default 6.' }
        },
        required: ['query'],
        additionalProperties: false
      },
      execute: async (_toolCallId: string, params: any, signal?: AbortSignal) => {
        const query = typeof params?.query === 'string' ? params.query.trim() : ''
        if (!query) throw new Error('web_search requires a non-empty query')
        const limit = Math.max(1, Math.min(10, Number(params?.limit) || 6))
        let provider: SearchPayload['provider'] = 'exa'
        let results: WebSearchResult[] = []
        let note: string | undefined
        try {
          results = await exaSearch(query, limit, signal)
        } catch (error) {
          note = `Exa unavailable: ${error instanceof Error ? error.message : String(error)}`
        }
        if (results.length === 0) {
          try {
            provider = 'anysearch'
            results = await anysearch(query, limit, signal)
          } catch (error) {
            const anysearchMessage = error instanceof Error ? error.message : String(error)
            throw new Error(`Web search failed. ${note ?? ''} ${anysearchMessage}`.trim())
          }
        }
        const payload: SearchPayload = { provider, query, results, ...(note ? { note } : {}) }
        return {
          content: [{ type: 'text', text: format(payload) }],
          details: payload
        }
      }
    } as unknown as ToolDefinition<any, any, any>
  ]
}
