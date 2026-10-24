export type CutResult = { emit: string; matched?: string }

// Streams text while holding back just enough characters to catch a stop sequence split across chunks.
export class StopCutter {
  private held = ''
  private readonly stops: readonly string[]
  private readonly maxLen: number

  constructor(stops: readonly string[]) {
    this.stops = stops
    this.maxLen = stops.reduce((max, s) => Math.max(max, s.length), 0)
  }

  push(text: string): CutResult {
    if (this.stops.length === 0) return { emit: text }
    const buf = this.held + text
    let best: { at: number; stop: string } | undefined
    for (const stop of this.stops) {
      const at = buf.indexOf(stop)
      if (at >= 0 && (best === undefined || at < best.at)) best = { at, stop }
    }
    if (best) {
      this.held = ''
      return { emit: buf.slice(0, best.at), matched: best.stop }
    }
    const keep = Math.min(buf.length, this.maxLen - 1)
    this.held = buf.slice(buf.length - keep)
    return { emit: buf.slice(0, buf.length - keep) }
  }

  flush(): string {
    const out = this.held
    this.held = ''
    return out
  }
}
