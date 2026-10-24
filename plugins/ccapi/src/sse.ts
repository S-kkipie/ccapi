import type { SseEvent } from './api.ts'

export const encodeSse = (ev: SseEvent): string => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`
