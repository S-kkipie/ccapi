export type SenderOptions = {
  // Extra attempts for a failed send before it is reported and dropped.
  retries?: number
  sleep?: (ms: number) => Promise<void>
}

// Sends items in order with at most one request in flight; items pushed meanwhile ride the next batch.
export class OrderedSender<T> {
  private readonly send: (batch: T[]) => Promise<void>
  private readonly onError: (err: unknown) => void
  private readonly retries: number
  private readonly sleep: (ms: number) => Promise<void>
  private queue: T[] = []
  private pumping: Promise<void> | undefined

  constructor(send: (batch: T[]) => Promise<void>, onError: (err: unknown) => void, options: SenderOptions = {}) {
    this.send = send
    this.onError = onError
    this.retries = options.retries ?? 0
    this.sleep = options.sleep ?? (() => Promise.resolve())
  }

  push(item: T): void {
    this.queue.push(item)
    if (this.pumping === undefined) this.start()
  }

  flushed(): Promise<void> {
    return this.pumping ?? Promise.resolve()
  }

  private start(): void {
    this.pumping = this.pump().finally(() => {
      this.pumping = undefined
      if (this.queue.length > 0) this.start()
    })
  }

  private async pump(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue
      this.queue = []
      for (let attempt = 0; ; attempt++) {
        try {
          await this.send(batch)
          break
        } catch (err) {
          if (attempt >= this.retries) {
            this.onError(err)
            break
          }
          await this.sleep(100 * 2 ** attempt)
        }
      }
    }
  }
}
