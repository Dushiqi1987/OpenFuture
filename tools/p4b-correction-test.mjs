#!/usr/bin/env node
/**
 * P4b: verify note correction end to end through the renderer API.
 * Does not require a live model: it checks the approved note and the active L3
 * projection. If the mock endpoint is healthy it also checks a fresh session's
 * system prompt.
 */
import { readFileSync } from 'node:fs'

const PORT = Number(process.env.CDP_PORT || 9241)
const LOG = process.env.P01_MOCK_LOG || '.scratch/p01-mock-requests.jsonl'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function pageTarget() {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {}
    await sleep(300)
  }
  throw new Error('CDP target not found')
}

const page = await pageTarget()
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})
let nextId = 1
const pending = new Map()
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (!msg.id || !pending.has(msg.id)) return
  const { resolve, reject } = pending.get(msg.id)
  pending.delete(msg.id)
  if (msg.error) reject(new Error(msg.error.message))
  else resolve(msg.result)
})
function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
await send('Runtime.enable')
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result?.value
}
const unwrap = (res) => {
  if (!res || res.ok !== true) throw new Error(JSON.stringify(res))
  return res.value
}

const out = { steps: [] }
try {
  let state = await evaluate('window.openfuture.memoryState().then(r => r)')
  if (state.value?.mode !== 'both') {
    unwrap(await evaluate('window.openfuture.memorySetMode("both")'))
    await sleep(2500)
    state = await evaluate('window.openfuture.memoryState().then(r => r)')
  }
  out.steps.push({ mode: state.value?.mode, counts: state.value })

  const notes = unwrap(await evaluate('window.openfuture.memoryListNotes()'))
  let note = notes.find((n) => n.status === 'active' && n.title.includes('用户偏好')) || notes.find((n) => n.status === 'active')
  if (!note) {
    note = unwrap(await evaluate(`window.openfuture.memoryCreateNote({type:'preference',title:'用户偏好',body:'WRONG_FACT_SENTINEL'})`))
  }
  out.steps.push({ note: { id: note.id, title: note.title, revision: note.revision, body: note.body.slice(0, 80) } })

  let search = unwrap(await evaluate('window.openfuture.memorySearch({query:"会话取证",limit:10})'))
  let evidence = (search.hits || []).filter((h) => h.kind === 'evidence')
  if (evidence.length === 0) {
    search = unwrap(await evaluate('window.openfuture.memorySearch({query:"记忆",limit:20})'))
    evidence = (search.hits || []).filter((h) => h.kind === 'evidence')
  }
  out.steps.push({ evidenceHits: evidence.map((h) => ({ id: h.id, title: h.title })) })
  if (evidence.length === 0) throw new Error('no active evidence available for correction')

  const correctedBody = `CORRECTED_FACT_SENTINEL：用户偏好已纠正为浅色主题（revision ${note.revision + 1}）。`
  const proposal = unwrap(await evaluate(`window.openfuture.memoryCorrectNote(${JSON.stringify({ noteId: note.id, body: correctedBody, evidenceIds: [evidence[0].id], reason: 'P4b correction test' })})`))
  out.steps.push({ proposal: { id: proposal.id, kind: proposal.kind, status: proposal.status, target: proposal.targetNoteId } })

  const decided = unwrap(await evaluate(`window.openfuture.memoryDecideProposal(${JSON.stringify({ id: proposal.id, approve: true })})`))
  out.steps.push({ decided: decided.status })
  const after = unwrap(await evaluate('window.openfuture.memoryListNotes()')).find((n) => n.id === note.id)
  out.steps.push({ corrected: { revision: after?.revision, body: after?.body } })

  const dream = unwrap(await evaluate('window.openfuture.dreamState()'))
  const l3 = dream.active?.l3Content || ''
  out.l3 = {
    hasCorrected: l3.includes('CORRECTED_FACT_SENTINEL'),
    hasWrong: l3.includes('WRONG_FACT_SENTINEL'),
    bytes: Buffer.byteLength(l3, 'utf8')
  }

  try {
    const health = await fetch('http://127.0.0.1:8791/health').then((r) => r.json())
    out.mock = health
  } catch {
    out.mock = null
  }

  if (out.mock) {
    const opened = unwrap(await evaluate('window.openfuture.openSession({})'))
    await evaluate('window.openfuture.sendMessage("请回复 P4B_CORRECTION_OK，不需要调用工具。")')
    await sleep(5000)
    const lines = readFileSync(LOG, 'utf8').trim().split(/\r?\n/).filter(Boolean)
    const last = JSON.parse(lines.at(-1))
    out.system = {
      systemHasMemory: last.systemHasMemory,
      hasCorrected: String(last.systemMemoryExcerpt || '').includes('CORRECTED_FACT_SENTINEL'),
      hasWrong: String(last.systemMemoryExcerpt || '').includes('WRONG_FACT_SENTINEL'),
      excerpt: last.systemMemoryExcerpt
    }
    out.session = { id: opened.sessionId }
  }

  out.ok = Boolean(
    after?.body?.includes('CORRECTED_FACT_SENTINEL') &&
      !after?.body?.includes('WRONG_FACT_SENTINEL') &&
      out.l3.hasCorrected &&
      !out.l3.hasWrong &&
      (!out.system || (out.system.systemHasMemory && out.system.hasCorrected && !out.system.hasWrong))
  )
} catch (error) {
  out.ok = false
  out.error = error instanceof Error ? error.message : String(error)
} finally {
  ws.close()
}
console.log(JSON.stringify(out, null, 2))
