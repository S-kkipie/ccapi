import { describe, expect, test } from 'bun:test'
import { OrderedSender } from '../event-sender.ts'

const tick = () => new Promise(r => setTimeout(r, 5))

describe('OrderedSender', () => {
  test('delivers items in order, batching what arrives while a send is in flight', async () => {
    const batches: number[][] = []
    const sender = new OrderedSender<number>(async batch => {
      batches.push(batch)
      await tick()
    }, () => {})
    sender.push(1)
    sender.push(2)
    sender.push(3)
    await sender.flushed()
    expect(batches.flat()).toEqual([1, 2, 3])
    expect(batches[0]).toEqual([1])
    expect(batches[1]).toEqual([2, 3])
  })

  test('reports a failed send and keeps going', async () => {
    const errors: unknown[] = []
    const seen: number[] = []
    const sender = new OrderedSender<number>(async batch => {
      if (batch.includes(1)) throw new Error('down')
      seen.push(...batch)
    }, err => errors.push(err))
    sender.push(1)
    await sender.flushed()
    sender.push(2)
    await sender.flushed()
    expect(errors).toHaveLength(1)
    expect(seen).toEqual([2])
  })

  test('retries a failed send before reporting it', async () => {
    const errors: unknown[] = []
    const seen: number[] = []
    let calls = 0
    const sender = new OrderedSender<number>(
      async batch => {
        if (++calls <= 2) throw new Error('blip')
        seen.push(...batch)
      },
      err => errors.push(err),
      { retries: 2, sleep: async () => {} },
    )
    sender.push(1)
    await sender.flushed()
    expect(seen).toEqual([1])
    expect(errors).toHaveLength(0)
  })

  test('reports once the retries run out', async () => {
    const errors: unknown[] = []
    const sender = new OrderedSender<number>(async () => {
      throw new Error('down')
    }, err => errors.push(err), { retries: 1, sleep: async () => {} })
    sender.push(1)
    await sender.flushed()
    expect(errors).toHaveLength(1)
  })

  test('flushed resolves at once when idle', async () => {
    await new OrderedSender<number>(async () => {}, () => {}).flushed()
  })
})
