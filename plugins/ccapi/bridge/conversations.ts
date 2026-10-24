import type { AttachmentList } from '../src/attachments.ts'
import type { EngineToolResult } from '../src/wire.ts'
import type { ResponseSink } from './sink.ts'

export type Conversation = {
  convId: string
  model: string
  prompt: string
  toolNames: Record<string, string>
  attachments: AttachmentList
  agentId?: string
  sink?: ResponseSink
  parked: string[]
  detached: boolean
  startedAt: number
  release: () => void
}

// A result nobody collected (its long-poll died, or nobody waits for it) is dropped after this.
const READY_TTL_MS = 15 * 60_000
const MAX_DEAD_AGENTS = 10_000

export class ConversationStore {
  private readonly convs = new Map<string, Conversation>()
  private readonly agents = new Map<string, string>()
  private readonly dead = new Set<string>()
  private readonly parkedIds = new Map<string, { convId: string; deadline: number }>()
  private readonly ready = new Map<string, { result: EngineToolResult; at: number }>()
  private readonly waiters = new Map<string, (result: EngineToolResult) => void>()

  get size(): number {
    return this.convs.size
  }

  get parkedCount(): number {
    return this.parkedIds.size
  }

  add(conv: Conversation): void {
    this.convs.set(conv.convId, conv)
  }

  get(convId: string): Conversation | undefined {
    return this.convs.get(convId)
  }

  byAgent(agentId: string): Conversation | undefined {
    const convId = this.agents.get(agentId)
    return convId === undefined ? undefined : this.convs.get(convId)
  }

  isDeadAgent(agentId: string): boolean {
    return this.dead.has(agentId)
  }

  bindAgent(convId: string, agentId: string): Conversation | undefined {
    const conv = this.convs.get(convId)
    if (conv) {
      conv.agentId = agentId
      this.agents.set(agentId, convId)
    }
    return conv
  }

  park(convId: string, ids: readonly string[], deadline: number): void {
    const conv = this.convs.get(convId)
    if (!conv) return
    conv.parked = [...ids]
    for (const id of ids) this.parkedIds.set(id, { convId, deadline })
  }

  findParked(ids: readonly string[]): { convId: string; parked: string[] } | undefined {
    for (const id of ids) {
      const entry = this.parkedIds.get(id)
      const conv = entry && this.convs.get(entry.convId)
      if (conv) return { convId: conv.convId, parked: [...conv.parked] }
    }
    return undefined
  }

  deliver(id: string, result: EngineToolResult): void {
    const entry = this.parkedIds.get(id)
    if (entry) {
      this.parkedIds.delete(id)
      const conv = this.convs.get(entry.convId)
      if (conv) conv.parked = conv.parked.filter(p => p !== id)
    }
    // Kept even when a waiter takes it: that long-poll's connection may already be gone, and the
    // hook's next poll must still find the result.
    this.ready.set(id, { result, at: Date.now() })
    const waiter = this.waiters.get(id)
    if (waiter) {
      this.waiters.delete(id)
      waiter(result)
    }
  }

  wait(id: string, timeoutMs: number, signal?: AbortSignal): Promise<EngineToolResult | undefined> {
    const ready = this.ready.get(id)
    if (ready) {
      this.ready.delete(id)
      return Promise.resolve(ready.result)
    }
    return new Promise(resolve => {
      let settled = false
      const settle = (value: EngineToolResult | undefined) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (this.waiters.get(id) === waiter) this.waiters.delete(id)
        resolve(value)
      }
      const waiter = (value: EngineToolResult) => settle(value)
      const timer = setTimeout(() => settle(undefined), timeoutMs)
      signal?.addEventListener('abort', () => settle(undefined), { once: true })
      this.waiters.set(id, waiter)
    })
  }

  list(): Conversation[] {
    return [...this.convs.values()]
  }

  // Conversations with parked tool calls, oldest parked first.
  parkedConversationIds(): string[] {
    return [...new Set([...this.parkedIds.values()].map(entry => entry.convId))]
  }

  prune(now: number): void {
    for (const [id, entry] of this.ready) if (now - entry.at > READY_TTL_MS) this.ready.delete(id)
  }

  expired(now: number): string[] {
    const out = new Set<string>()
    for (const entry of this.parkedIds.values()) if (entry.deadline < now) out.add(entry.convId)
    return [...out]
  }

  remove(convId: string, reason: string): void {
    const conv = this.convs.get(convId)
    if (!conv) return
    for (const id of [...conv.parked]) this.deliver(id, { deny: reason })
    if (conv.agentId !== undefined) {
      this.agents.delete(conv.agentId)
      this.dead.add(conv.agentId)
      if (this.dead.size > MAX_DEAD_AGENTS) {
        const oldest = this.dead.values().next().value
        if (oldest !== undefined) this.dead.delete(oldest)
      }
    }
    this.convs.delete(convId)
    conv.release()
  }
}
