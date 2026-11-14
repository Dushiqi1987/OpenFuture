/**
 * `ask_user` tool: let the model stop and ask the user a structured question
 * (clarify requirements, or confirm a risky step) before continuing.
 *
 * The tool promise stays pending until the renderer posts an answer through the
 * `promptAnswer` RPC, the turn is stopped, or the session closes. Only one
 * question may be open at a time so the UI never has to queue cards.
 */
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { UserPromptAnswerInput, UserPromptOption, UserPromptRequest } from '../shared/protocol'

const MAX_QUESTION_CHARS = 2_000
const MAX_OPTIONS = 6
const MIN_OPTIONS = 2
const MAX_LABEL_CHARS = 120

interface PendingPrompt {
  options: UserPromptOption[]
  resolve: (answer: string) => void
  reject: (error: Error) => void
}

export interface AskToolsOptions {
  onPrompt: (prompt: UserPromptRequest) => void
  onDone: (id: string, answer: string | undefined, cancelled: boolean) => void
}

export interface AskTools {
  tools: Array<ToolDefinition<any, any, any>>
  answer: (input: UserPromptAnswerInput) => string
  rejectAll: (reason: string) => void
  pendingCount: () => number
}

function normalizeOptions(value: unknown): UserPromptOption[] {
  if (!Array.isArray(value)) throw new Error('options 必须是数组')
  if (value.length < MIN_OPTIONS) throw new Error(`至少提供 ${MIN_OPTIONS} 个选项`)
  if (value.length > MAX_OPTIONS) throw new Error(`最多提供 ${MAX_OPTIONS} 个选项`)
  return value.map((entry, index) => {
    const raw = typeof entry === 'string' ? { label: entry } : entry
    if (!raw || typeof raw !== 'object') throw new Error(`第 ${index + 1} 个选项格式不正确`)
    const record = raw as Record<string, unknown>
    const label = typeof record.label === 'string' ? record.label.trim() : ''
    if (label === '') throw new Error(`第 ${index + 1} 个选项缺少 label`)
    if (label.length > MAX_LABEL_CHARS) throw new Error(`选项文字过长（最多 ${MAX_LABEL_CHARS} 字）`)
    const description = typeof record.description === 'string' ? record.description.trim() : ''
    return description === '' ? { label } : { label, description }
  })
}

export function createAskTools({ onPrompt, onDone }: AskToolsOptions): AskTools {
  let sequence = 0
  const pending = new Map<string, PendingPrompt>()

  function settle(id: string, answer: string, cancelled: boolean): void {
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    try {
      onDone(id, cancelled ? undefined : answer, cancelled)
    } catch {
      /* renderer already gone */
    }
    if (cancelled) entry.reject(new Error(answer))
    else entry.resolve(answer)
  }

  function rejectAll(reason: string): void {
    for (const id of [...pending.keys()]) settle(id, reason, true)
  }

  function answer(input: UserPromptAnswerInput): string {
    const entry = pending.get(input.id)
    if (!entry) throw new Error('这个提问已经结束或不存在')
    if (input.cancelled === true) {
      settle(input.id, '用户取消了提问', true)
      return '用户取消了提问'
    }
    if (typeof input.text === 'string' && input.text.trim() !== '') {
      const text = input.text.trim().slice(0, 4_000)
      settle(input.id, `用户自定义回答：${text}`, false)
      return text
    }
    if (typeof input.optionIndex === 'number') {
      const option = entry.options[input.optionIndex]
      if (!option) throw new Error('选项不存在')
      settle(input.id, `用户选择了「${option.label}」`, false)
      return option.label
    }
    throw new Error('需要选择一个选项或填写回答')
  }

  const tool = {
    name: 'ask_user',
    label: 'Ask the user',
    description: [
      '向用户提一个结构化问题，等用户回答后再继续。用于澄清需求（例如"想做哪种游戏"）或在不可逆操作前确认。',
      `提供 ${MIN_OPTIONS}-${MAX_OPTIONS} 个互斥选项，可附一句说明；默认允许用户自定义回答。`,
      '用户会看到一张带选项按钮的卡片，可以点选项、写自定义回答，或取消。',
      '一次只能问一个问题；问题要具体、可行动，不要用它确认自己已经能查到的信息。',
      '确认型提问（kind=confirm）通常给「允许」「拒绝」两个选项，并说明将执行的动作与影响。'
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: `要问用户的问题，写清需要用户决定什么（最多 ${MAX_QUESTION_CHARS} 字）。`
        },
        options: {
          type: 'array',
          minItems: MIN_OPTIONS,
          maxItems: MAX_OPTIONS,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '选项标题' },
              description: { type: 'string', description: '可选的补充说明' }
            },
            required: ['label'],
            additionalProperties: false
          },
          description: '互斥选项，用户点一个即可。'
        },
        allowCustom: {
          type: 'boolean',
          description: '是否允许用户写自定义回答，默认 true。'
        },
        kind: {
          type: 'string',
          enum: ['choice', 'confirm'],
          description: 'choice 用于澄清需求；confirm 用于确认高风险或不可逆操作。'
        }
      },
      required: ['question', 'options'],
      additionalProperties: false
    },
    execute: async (_toolCallId: string, params: any, signal?: AbortSignal) => {
      const question = typeof params?.question === 'string' ? params.question.trim() : ''
      if (question === '') throw new Error('question 不能为空')
      if (question.length > MAX_QUESTION_CHARS) throw new Error(`question 过长（最多 ${MAX_QUESTION_CHARS} 字）`)
      if (pending.size > 0) throw new Error('已有一个未回答的提问，请等待用户回答后再问')
      const options = normalizeOptions(params?.options)
      const allowCustom = params?.allowCustom !== false
      const kind = params?.kind === 'confirm' ? 'confirm' : 'choice'
      const id = `q-${Date.now().toString(36)}-${++sequence}`

      const answerPromise = new Promise<string>((resolve, reject) => {
        pending.set(id, { options, resolve, reject })
      })

      const onAbort = (): void => {
        if (!pending.has(id)) return
        settle(id, '用户已停止，提问被取消', true)
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      onPrompt({ id, kind, question, options, allowCustom })

      let answerText: string
      try {
        answerText = await answerPromise
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
      return {
        content: [{ type: 'text' as const, text: answerText }],
        details: { promptId: id, answer: answerText }
      }
    }
  } as unknown as ToolDefinition<any, any, any>

  return {
    tools: [tool],
    answer,
    rejectAll,
    pendingCount: () => pending.size
  }
}
