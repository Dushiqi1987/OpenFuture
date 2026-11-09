/**
 * Standalone loopback mock model for manual testing of the HTTP adapter.
 *
 * It listens on 127.0.0.1:19733 by default and prints one JSON line with the
 * runtime fake bearer token. This is a deterministic heuristic stand-in, not a
 * real language model. Stop it with Ctrl+C.
 *
 * Usage:
 *   node tools/mock-model.mjs
 *   MOCK_MODEL_PORT=19733 MOCK_MODEL_TOKEN=test-token node tools/mock-model.mjs
 */

import { startMockModelServer } from '../src/mock-server.mjs'

const port = Number(process.env.MOCK_MODEL_PORT ?? 19733)
const token = process.env.MOCK_MODEL_TOKEN
let server
try {
  server = await startMockModelServer({ port, token })
} catch (error) {
  console.error(JSON.stringify({ event: 'mock-model-failed', port, code: error?.code ?? 'ERROR', message: error?.message ?? String(error) }))
  process.exitCode = 1
  throw error
}

console.log(
  JSON.stringify({
    event: 'mock-model-listening',
    url: server.url,
    port: server.port,
    token: server.token,
    note: 'deterministic heuristic stand-in; fake runtime token'
  })
)

async function shutdown() {
  await server.close()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
await new Promise(() => {})
