import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createBridge } from './app.ts'

const env = (name: string, fallback: string): string => process.env[name] ?? fallback
const token = process.env.CCAPI_TOKEN
const internalToken = process.env.CCAPI_INTERNAL_TOKEN
if (!token || !internalToken) {
  console.error('ccapi bridge: CCAPI_TOKEN and CCAPI_INTERNAL_TOKEN are required')
  process.exit(1)
}

const exposeThinking = env('CCAPI_EXPOSE_THINKING', 'requested')
if (exposeThinking !== 'requested' && exposeThinking !== 'always' && exposeThinking !== 'never') {
  console.error(`ccapi bridge: CCAPI_EXPOSE_THINKING must be requested, always or never (got ${exposeThinking})`)
  process.exit(1)
}

const logPath = env('CCAPI_LOG', `${process.env.HOME}/.local/state/ccapi/requests.jsonl`)
await mkdir(dirname(logPath), { recursive: true })

const bridge = createBridge({
  token,
  internalToken,
  maxConcurrent: Number(env('CCAPI_MAX_CONCURRENT', '4')),
  queueSize: Number(env('CCAPI_QUEUE_SIZE', '16')),
  toolWaitMs: Number(env('CCAPI_TOOL_WAIT_MINUTES', '10')) * 60_000,
  exposeThinking,
  longPollMs: 20_000,
  maxParked: Number(env('CCAPI_MAX_PARKED', '32')),
  debugBodies: env('CCAPI_DEBUG_BODIES', 'false') === 'true',
  log: entry => {
    appendFile(logPath, `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`).catch(err => {
      console.error(`ccapi bridge: could not write the request log: ${String(err)}`)
    })
  },
})

// idleTimeout 0: non-stream answers and long-polls can stay silent for minutes.
const server = Bun.serve({ hostname: '127.0.0.1', port: Number(env('CCAPI_PORT', '18787')), idleTimeout: 0, fetch: req => bridge.fetch(req) })
setInterval(() => bridge.sweep(Date.now()), 5_000)
console.log(`ccapi bridge listening on http://127.0.0.1:${server.port}`)
