// ccapi usage [days]: what the request log says about the last few days, per client and model.
import { readFileSync } from 'node:fs'

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
type Window = { kind: string; percentUsed: number; resetsAt: string }
type Entry = {
  t: string
  client?: string
  model: string
  route: 'fresh' | 'continue'
  ms: number
  stopReason: string | null
  usage: Usage
  error?: { status: number; type: string; message: string }
  limits?: Window[]
}

const args = process.argv.slice(2)
const plan = args.includes('--plan')
const days = Number(args.find(a => a !== '--plan') ?? 7)
if (!Number.isFinite(days) || days <= 0) {
  console.error('usage: ccapi usage [days] [--plan]')
  process.exit(2)
}

// The plan's own windows, read the one way Claude Code exposes them outside its status line: the
// rate_limit_event of a one-word Haiku turn. Opt-in, since it spends that turn.
const planWindows = (): string[] => {
  const out = Bun.spawnSync(['claude', '-p', 'ok', '--model', 'haiku', '--output-format', 'stream-json', '--verbose'], {
    cwd: '/tmp',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  for (const line of out.stdout.toString().split('\n')) {
    try {
      const ev = JSON.parse(line) as {
        type?: string
        rate_limit_info?: { unifiedWindows?: Record<string, { utilization: number; resetsAt: number; status: string }> }
      }
      const windows = ev.type === 'rate_limit_event' ? ev.rate_limit_info?.unifiedWindows : undefined
      if (windows)
        return Object.entries(windows).map(
          ([kind, w]) =>
            `  ${kind.padEnd(10)} ${String(Math.round(w.utilization * 100)).padStart(4)}% used, ${w.status}, resets ${new Date(w.resetsAt * 1000).toISOString()}`,
        )
    } catch {}
  }
  return ['  (claude reported no rate-limit windows)']
}
const logPath = process.env.CCAPI_LOG ?? `${process.env.HOME}/.local/state/ccapi/requests.jsonl`
const since = Date.now() - days * 86_400_000

let raw = ''
try {
  raw = readFileSync(logPath, 'utf8')
} catch {
  console.log(`no request log at ${logPath}`)
  process.exit(0)
}
const entries: Entry[] = raw
  .split('\n')
  .filter(line => line.trim() !== '')
  .flatMap(line => {
    try {
      return [JSON.parse(line) as Entry]
    } catch {
      return []
    }
  })
  .filter(e => Date.parse(e.t) >= since)

// An entry with no stop reason is a failure, whether or not it was logged with its error.
const failed = (e: Entry) => e.stopReason === null
const n = (x: number) => x.toLocaleString('en-US')
const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '-')
const median = (xs: number[]) => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] ?? 0
}

const table = (rows: string[][]) => {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map(r => r[i]!.length)))
  for (const r of rows) console.log(r.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  '))
}

const summarize = (label: (e: Entry) => string) => {
  const groups = new Map<string, Entry[]>()
  for (const e of entries) groups.set(label(e), [...(groups.get(label(e)) ?? []), e])
  const rows = [['', 'requests', 'failed', 'input', 'cache read', 'cache write', 'output', 'cache hit', 'p50']]
  for (const [key, es] of [...groups].sort()) {
    const ok = es.filter(e => !failed(e))
    const sum = (k: keyof Usage) => ok.reduce((a, e) => a + (e.usage?.[k] ?? 0), 0)
    const prompt = sum('input_tokens') + sum('cache_read_input_tokens') + sum('cache_creation_input_tokens')
    rows.push([
      key,
      n(es.length),
      n(es.length - ok.length),
      n(sum('input_tokens')),
      n(sum('cache_read_input_tokens')),
      n(sum('cache_creation_input_tokens')),
      n(sum('output_tokens')),
      pct(sum('cache_read_input_tokens'), prompt),
      `${(median(ok.map(e => e.ms)) / 1000).toFixed(1)}s`,
    ])
  }
  table(rows)
}

console.log(`ccapi usage, last ${days} day${days === 1 ? '' : 's'}: ${n(entries.length)} requests\n`)
if (entries.length === 0) process.exit(0)

console.log('by client and model')
summarize(e => `${e.client ?? '(unlabelled)'} ${e.model}`)
console.log('\nby day (UTC)')
summarize(e => e.t.slice(0, 10))

// Fresh requests whose history is exactly an earlier request's history plus its reply: turns that
// carried on a conversation, but started a new subagent and re-sent the whole history to do it.
const seen = new Set<string>()
let fresh = 0
let followUps = 0
let rewritten = 0
for (const e of entries) {
  const k = e as Entry & { prefix?: string; next?: string }
  if (k.prefix === undefined) continue
  if (e.route === 'fresh' && !failed(e)) {
    fresh++
    if (seen.has(`${e.client}:${k.prefix}`)) {
      followUps++
      rewritten += e.usage?.cache_creation_input_tokens ?? 0
    }
  }
  if (k.next !== undefined) seen.add(`${e.client}:${k.next}`)
}
if (fresh > 0) {
  console.log(
    `\nconversation follow-ups: ${n(followUps)} of ${n(fresh)} new turns carried on an earlier conversation (${pct(followUps, fresh)}), rewriting ${n(rewritten)} tokens of cache that resuming the same subagent would have read instead`,
  )
}

const errors = new Map<string, number>()
for (const e of entries.filter(failed)) {
  const key = e.error ? `${e.error.status} ${e.error.type}: ${e.error.message}` : '(failed before errors were logged)'
  errors.set(key, (errors.get(key) ?? 0) + 1)
}
if (errors.size > 0) {
  console.log('\nfailures')
  for (const [key, count] of [...errors].sort((a, b) => b[1] - a[1])) console.log(`${String(count).padStart(6)}  ${key}`)
}

const latest = [...entries].reverse().find(e => e.limits && e.limits.length > 0)
if (latest?.limits) {
  console.log(`\nplan windows as of ${latest.t}`)
  for (const w of latest.limits) console.log(`  ${w.kind.padEnd(10)} ${String(w.percentUsed).padStart(5)}% used, resets ${w.resetsAt || '?'}`)
}
if (plan) {
  console.log('\nplan windows now')
  for (const line of planWindows()) console.log(line)
}
