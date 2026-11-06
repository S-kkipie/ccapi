import { readFileSync, statSync } from 'node:fs'
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

// Extra API keys, one `<name> <key>` a line (`ccapi key add`). Re-read whenever the file changes, so
// adding or revoking a key needs no restart. Keys shorter than 32 characters are ignored.
const keysPath = env('CCAPI_KEYS_FILE', `${process.env.HOME}/.config/ccapi/keys`)
let keysCache = { mtimeMs: -1, keys: new Map<string, string>() }
const keys = (): ReadonlyMap<string, string> => {
  let mtimeMs: number
  try {
    mtimeMs = statSync(keysPath).mtimeMs
  } catch {
    keysCache = { mtimeMs: 0, keys: new Map() }
    return keysCache.keys
  }
  if (mtimeMs !== keysCache.mtimeMs) {
    const parsed = new Map<string, string>()
    for (const line of readFileSync(keysPath, 'utf8').split('\n')) {
      const [name, key] = line.trim().split(/\s+/)
      if (!name || !key || name.startsWith('#') || key.length < 32) continue
      parsed.set(key, name)
    }
    keysCache = { mtimeMs, keys: parsed }
  }
  return keysCache.keys
}
await mkdir(dirname(logPath), { recursive: true })

const bridge = createBridge({
  token,
  keys,
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
