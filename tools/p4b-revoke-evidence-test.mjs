#!/usr/bin/env node
/** Verify that a pending fix proposal is rejected after its evidence source is revoked. */
const PORT = Number(process.env.CDP_PORT || 9242)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!page) throw new Error('CDP target not found')
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
const send = (method, params = {}) => {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
await send('Runtime.enable')
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result?.value
}
const unwrap = (res) => {
  if (!res || res.ok !== true) throw new Error(JSON.stringify(res))
  return res.value
}

const out = {}
try {
  if ((await evaluate('window.openfuture.memoryState().then(r=>r)')).value?.mode === 'off') {
    unwrap(await evaluate('window.openfuture.memorySetMode("both")'))
    await sleep(2000)
  }
  const notes = unwrap(await evaluate('window.openfuture.memoryListNotes()'))
  const note = notes.find((n) => n.status === 'active')
  if (!note) throw new Error('no active note')
  const search = unwrap(await evaluate('window.openfuture.memorySearch({query:"会话取证",limit:10})'))
  const hit = (search.hits || []).find((h) => h.kind === 'evidence')
  if (!hit?.citation?.sourceId) throw new Error('no evidence sourceId')
  out.note = { id: note.id, title: note.title, revision: note.revision }
  out.evidence = { id: hit.id, sourceId: hit.citation.sourceId }
  const proposal = unwrap(
    await evaluate(
      `window.openfuture.memoryCorrectNote(${JSON.stringify({
        noteId: note.id,
        body: 'SHOULD_NOT_APPLY：证据撤销后不得应用。',
        evidenceIds: [hit.id],
        reason: 'revocation guard test'
      })})`
    )
  )
  out.proposal = { id: proposal.id, status: proposal.status, kind: proposal.kind }
  unwrap(await evaluate(`window.openfuture.memoryRevokeSource(${JSON.stringify(hit.citation.sourceId)})`))
  out.revoked = true
  const result = await evaluate(
    `window.openfuture.memoryDecideProposal(${JSON.stringify({ id: proposal.id, approve: true })})`
  )
  out.decision = result
  out.rejected = result?.ok === false
  out.message = result?.error?.message
  const after = unwrap(await evaluate('window.openfuture.memoryListNotes()')).find((n) => n.id === note.id)
  out.noteAfter = { revision: after?.revision, body: after?.body }
  out.ok = Boolean(out.rejected && after?.body === note.body)
} catch (error) {
  out.ok = false
  out.error = error instanceof Error ? error.message : String(error)
} finally {
  ws.close()
}
console.log(JSON.stringify(out, null, 2))
