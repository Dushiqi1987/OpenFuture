import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  GroupChatEvent,
  GroupChatMembers,
  GroupChatRecord,
  GroupChatSummary
} from '../shared/protocol'
import { toErrorMessage } from './errors'

/**
 * Persists group chat transcripts so the sidebar can list past discussions.
 * The agent host emits `group` events; main folds them into one JSON file per
 * chat instead of keeping the transcript only in renderer memory.
 */
export class GroupChatStore {
  private readonly dir: string

  constructor(userDataDir: string, private readonly members: () => GroupChatMembers) {
    this.dir = join(userDataDir, 'config', 'group-chats')
  }

  init(): void {
    mkdirSync(this.dir, { recursive: true })
  }

  /** Fold one host event into the persisted record. */

  applyEvent(event: GroupChatEvent): void {
    try {
      if (event.type === 'start') {
        const now = Date.now()
        const record: GroupChatRecord = {
          chatId: event.chatId,
          goal: event.goal,
          status: 'running',
          rounds: event.rounds,
          members: this.members(),
          createdAt: now,
          updatedAt: now,
          messageCount: 0,
          messages: []
        }
        this.write(record)
        return
      }
      const record = this.read(event.chatId)
      if (!record) return
      if (event.type === 'message') {
        if (record.messages.some((message) => message.seq === event.message.seq)) return
        record.messages.push(event.message)
        record.messageCount = record.messages.length
      } else {
        record.status = event.status
        record.rounds = event.rounds
        if (event.error) record.error = event.error
      }
      record.updatedAt = Date.now()
      this.write(record)
    } catch (error) {
      console.error('[group-chats] failed to persist event:', toErrorMessage(error))
    }
  }

  list(limit = 100): GroupChatSummary[] {
    if (!existsSync(this.dir)) return []
    const summaries: GroupChatSummary[] = []
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue
      const record = this.read(name.slice(0, -'.json'.length))
      if (!record) continue
      summaries.push({
        chatId: record.chatId,
        goal: record.goal,
        status: record.status,
        rounds: record.rounds,
        members: record.members,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        messageCount: record.messageCount
      })
    }
    summaries.sort((a, b) => b.updatedAt - a.updatedAt)
    return summaries.slice(0, limit)
  }

  get(chatId: string): GroupChatRecord | null {
    return this.read(chatId)
  }

  delete(chatId: string): void {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(chatId)) return
    rmSync(join(this.dir, `${chatId}.json`), { force: true })
  }

  private path(chatId: string): string {
    return join(this.dir, `${chatId}.json`)
  }

  private read(chatId: string): GroupChatRecord | null {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(chatId)) return null
    const path = this.path(chatId)
    if (!existsSync(path)) return null
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as GroupChatRecord
      if (!parsed || parsed.chatId !== chatId || !Array.isArray(parsed.messages)) return null
      return parsed
    } catch {
      return null
    }
  }

  private write(record: GroupChatRecord): void {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.path(record.chatId), JSON.stringify(record, null, 2), 'utf8')
  }
}
