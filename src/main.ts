import { createServer } from 'node:http'
import { serveWorkspace } from './serve.js'

/** Read a positive integer env var, or a default. */
function intEnv(name: string, def: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return def
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : def
}

async function main(): Promise<void> {
  const natsUrl = process.env['NATS_URL'] ?? 'nats://127.0.0.1:4222'
  const { stop } = await serveWorkspace({ natsUrl })
  console.log(
    '[workspace] serving over %s; configure worker-url / worker-token in tool settings',
    natsUrl,
  )

  // Minimal HTTP surface for Kubernetes probes (the extension itself speaks
  // only the abc protocol over NATS).
  const port = intEnv('PORT', 8080)
  const http = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/v1/health') {
      res.end(JSON.stringify({ ok: true, id: 'workspace' }))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  http.listen(port, () => console.log(`[workspace] http :${port}`))

  const shutdown = (): void => {
    http.close()
    void stop().finally(() => process.exit(0))
    setTimeout(() => process.exit(0), 5000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

void main().catch((e: unknown) => {
  console.error('[workspace] fatal:', e instanceof Error ? e.message : e)
  process.exit(1)
})
