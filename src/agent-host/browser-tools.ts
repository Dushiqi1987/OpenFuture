/**
 * Browser tools exposed to the Pi agent.
 *
 * The browser itself is the docked `<webview>` in the renderer (the same page
 * the user sees). Calls travel host → main → renderer and back; the model never
 * gets Electron or Node access, only page text and screenshots.
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
  parameters: Record<string, unknown>,
  timeoutMs = 30_000
): ToolDefinition<any, any, any> {
  return {
    name,
    label,
    description,
    parameters,
    execute: async (_toolCallId: string, params: any, signal?: AbortSignal) =>
      textResult(await requestHostTool(name, params, signal, timeoutMs))
  } as unknown as ToolDefinition<any, any, any>
}

const TARGET_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: '要点击的链接/按钮文字（可见文本，支持部分匹配）。' },
    selector: { type: 'string', description: 'CSS 选择器（优先于 text）。' }
  },
  additionalProperties: false
} as const

export function createBrowserTools(): Array<ToolDefinition<any, any, any>> {
  return [
    tool(
      'browser_open',
      'Open browser',
      'Open a URL in the built-in browser dock (the page the user sees). Waits for the page to load and returns the title, final URL and a short text preview. Use it for documentation, localhost previews and web pages the user asked about.',
      {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'http(s) URL 或 file:// 路径。' },
          label: { type: 'string', description: '可选：标签栏显示的名字。' }
        },
        required: ['url'],
        additionalProperties: false
      },
      40_000
    ),
    tool(
      'browser_read',
      'Read browser page',
      'Return the visible text of the current browser page (title, URL and innerText). Use it after browser_open or when the user asks what is on screen.',
      {
        type: 'object',
        properties: {
          maxChars: { type: 'number', description: '最多返回多少字符，500-20000，默认 8000。' }
        },
        additionalProperties: false
      }
    ),
    tool(
      'browser_screenshot',
      'Screenshot browser',
      'Capture the current browser viewport as a PNG. Returns the saved file path; open it with the read tool when you need to inspect the layout visually.',
      { type: 'object', properties: {}, additionalProperties: false },
      40_000
    ),
    tool(
      'browser_click',
      'Click in browser',
      'Click an element in the current page by CSS selector or by its visible text. Returns the clicked element description.',
      TARGET_SCHEMA
    ),
    tool(
      'browser_type',
      'Type in browser',
      'Type text into an input/textarea/contenteditable on the current page (optionally by selector) and submit with Enter when submit=true.',
      {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要输入的文本。' },
          selector: { type: 'string', description: '可选：CSS 选择器；默认当前焦点元素或页面第一个输入框。' },
          submit: { type: 'boolean', description: '输入后按 Enter 提交，默认 false。' }
        },
        required: ['text'],
        additionalProperties: false
      }
    ),
    tool(
      'browser_press',
      'Press key in browser',
      'Press a key in the page (Enter, Tab, Escape, ArrowDown…).',
      {
        type: 'object',
        properties: { key: { type: 'string', description: '键名，默认 Enter。' } },
        additionalProperties: false
      }
    ),
    tool(
      'browser_scroll',
      'Scroll browser',
      'Scroll the current page vertically by deltaY pixels (positive = down).',
      {
        type: 'object',
        properties: { deltaY: { type: 'number', description: '滚动像素，默认 600。' } },
        additionalProperties: false
      }
    ),
    tool(
      'browser_back',
      'Browser back',
      'Go back one page in the built-in browser history.',
      { type: 'object', properties: {}, additionalProperties: false }
    ),
    tool(
      'browser_forward',
      'Browser forward',
      'Go forward one page in the built-in browser history.',
      { type: 'object', properties: {}, additionalProperties: false }
    ),
    tool(
      'browser_reload',
      'Reload browser',
      'Reload the current page.',
      { type: 'object', properties: {}, additionalProperties: false }
    )
  ]
}
