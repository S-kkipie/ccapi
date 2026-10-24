import { describe, expect, test } from 'bun:test'
import { AttachmentList } from '../../src/attachments.ts'
import { type Conversation, ConversationStore } from '../conversations.ts'
import { Limiter } from '../limiter.ts'
import { JobQueue } from '../queue.ts'

const conv = (convId: string, release = () => {}): Conversation => ({
  convId,
  model: 'haiku',
  prompt: 'p',
  toolNames: {},
  attachments: new AttachmentList(),
  parked: [],
  detached: false,
  startedAt: 0,
  release,
})

describe('JobQueue', () => {
  test('hands a queued item to the next taker', async () => {
    const q = new JobQueue<number>()
    q.push(1)
    expect(await q.take(10)).toBe(1)
  })
  test('a waiting taker gets the next push', async () => {
    const q = new JobQueue<number>()
    const taken = q.take(1000)
    q.push(7)
    expect(await taken).toBe(7)
  })
  test('times out with undefined', async () => {
    expect(await new JobQueue<number>().take(10)).toBeUndefined()
  })
  test('an aborted taker does not swallow the next item', async () => {
    const q = new JobQueue<number>()
    const ac = new AbortController()
    const taken = q.take(1000, ac.signal)
    ac.abort()
    expect(await taken).toBeUndefined()
    q.push(3)
    expect(await q.take(10)).toBe(3)
  })
})

describe('Limiter', () => {
  test('admits up to max, queues up to queueSize, then refuses', async () => {
    const limiter = new Limiter(1, 1)
    await limiter.acquire()
    const queued = limiter.acquire()
    expect(limiter.stats()).toEqual({ active: 1, queued: 1 })
    await expect(limiter.acquire()).rejects.toThrow('concurrency limit')
    limiter.release()
    await queued
    expect(limiter.stats()).toEqual({ active: 1, queued: 0 })
    limiter.release()
    expect(limiter.stats()).toEqual({ active: 0, queued: 0 })
  })
})

describe('Limiter abort', () => {
  test('a queued acquire leaves the queue when its client aborts', async () => {
    const limiter = new Limiter(1, 1)
    await limiter.acquire()
    const ac = new AbortController()
    const queued = limiter.acquire(ac.signal)
    ac.abort()
    await expect(queued).rejects.toThrow('client closed')
    expect(limiter.stats()).toEqual({ active: 1, queued: 0 })
    limiter.release()
    expect(limiter.stats()).toEqual({ active: 0, queued: 0 })
  })
})

describe('ConversationStore', () => {
  test('a result handed to a waiter is still there for one more wait', async () => {
    const store = new ConversationStore()
    const first = store.wait('t1', 1000)
    store.deliver('t1', { result: 'x' })
    expect(await first).toEqual({ result: 'x' })
    expect(await store.wait('t1', 10)).toEqual({ result: 'x' })
  })

  test('prune drops results nobody collected', async () => {
    const store = new ConversationStore()
    store.deliver('t1', { result: 'x' })
    store.prune(Date.now() + 60 * 60_000)
    expect(await store.wait('t1', 10)).toBeUndefined()
  })

  test('parkedConversationIds lists the oldest parked first', () => {
    const store = new ConversationStore()
    store.add(conv('c1'))
    store.add(conv('c2'))
    store.park('c2', ['t2'], 1)
    store.park('c1', ['t1'], 1)
    expect(store.parkedConversationIds()).toEqual(['c2', 'c1'])
  })

  test('parks tool calls and finds the conversation by any of their ids', () => {
    const store = new ConversationStore()
    store.add(conv('c1'))
    store.park('c1', ['t1', 't2'], Date.now() + 1000)
    expect(store.findParked(['tx', 't2'])).toEqual({ convId: 'c1', parked: ['t1', 't2'] })
    expect(store.findParked(['tx'])).toBeUndefined()
  })

  test('a result delivered before the wait is kept for it', async () => {
    const store = new ConversationStore()
    store.deliver('t1', { result: 'a' })
    expect(await store.wait('t1', 10)).toEqual({ result: 'a' })
  })

  test('a waiting call gets the result when it is delivered', async () => {
    const store = new ConversationStore()
    store.add(conv('c1'))
    store.park('c1', ['t1'], Date.now() + 1000)
    const waiting = store.wait('t1', 1000)
    store.deliver('t1', { result: 'b' })
    expect(await waiting).toEqual({ result: 'b' })
    expect(store.get('c1')?.parked).toEqual([])
  })

  test('a wait times out with undefined', async () => {
    expect(await new ConversationStore().wait('t9', 10)).toBeUndefined()
  })

  test('bindAgent links the agent id', () => {
    const store = new ConversationStore()
    store.add(conv('c1'))
    store.bindAgent('c1', 'ag1')
    expect(store.byAgent('ag1')?.convId).toBe('c1')
  })

  test('remove denies parked calls, marks the agent dead and releases the slot', async () => {
    let released = 0
    const store = new ConversationStore()
    store.add(conv('c1', () => released++))
    store.bindAgent('c1', 'ag1')
    store.park('c1', ['t1'], Date.now() + 1000)
    const waiting = store.wait('t1', 1000)
    store.remove('c1', 'gone')
    expect(await waiting).toEqual({ deny: 'gone' })
    expect(store.byAgent('ag1')).toBeUndefined()
    expect(store.isDeadAgent('ag1')).toBe(true)
    expect(released).toBe(1)
    expect(store.size).toBe(0)
  })

  test('expired lists conversations with a parked call past its deadline', () => {
    const store = new ConversationStore()
    store.add(conv('c1'))
    store.add(conv('c2'))
    store.park('c1', ['t1'], 100)
    store.park('c2', ['t2'], 10_000)
    expect(store.expired(500)).toEqual(['c1'])
  })
})
