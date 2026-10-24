// A FIFO the mods long-poll: take() waits up to timeoutMs for the next item.
export class JobQueue<T> {
  private items: T[] = []
  private waiters: Array<(item: T) => void> = []

  push(item: T): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter(item)
    else this.items.push(item)
  }

  unshift(item: T): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter(item)
    else this.items.unshift(item)
  }

  take(timeoutMs: number, signal?: AbortSignal): Promise<T | undefined> {
    const item = this.items.shift()
    if (item !== undefined) return Promise.resolve(item)
    return new Promise(resolve => {
      let settled = false
      const settle = (value: T | undefined) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.waiters = this.waiters.filter(w => w !== waiter)
        resolve(value)
      }
      const waiter = (value: T) => settle(value)
      const timer = setTimeout(() => settle(undefined), timeoutMs)
      signal?.addEventListener('abort', () => settle(undefined), { once: true })
      this.waiters.push(waiter)
    })
  }
}
