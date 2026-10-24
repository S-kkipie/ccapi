import { ApiError } from '../src/errors.ts'

export class Limiter {
  private readonly max: number
  private readonly queueSize: number
  private active = 0
  private waiters: Array<() => void> = []

  constructor(max: number, queueSize: number) {
    this.max = max
    this.queueSize = queueSize
  }

  // A signal that aborts while queued takes the request out of the queue, so a client
  // that already left never starts a subagent.
  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw clientClosed()
    if (this.active < this.max) {
      this.active++
      return
    }
    if (this.waiters.length >= this.queueSize)
      throw new ApiError(429, 'rate_limit_error', 'ccapi is at its concurrency limit; retry later')
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.waiters = this.waiters.filter(w => w !== waiter)
        reject(clientClosed())
      }
      const waiter = () => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      this.waiters.push(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  // A released slot passes straight to the next waiter, so `active` stays the same.
  release(): void {
    const next = this.waiters.shift()
    if (next) next()
    else this.active = Math.max(0, this.active - 1)
  }

  stats(): { active: number; queued: number } {
    return { active: this.active, queued: this.waiters.length }
  }
}

const clientClosed = () => new ApiError(499, 'api_error', 'the client closed the request')
