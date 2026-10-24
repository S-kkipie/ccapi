import type { DocumentBlock, ImageBlock, MessagesRequest, TextBlock, ToolResultBlock } from './api.ts'
import type { EngineToolResult } from './wire.ts'
import { appendBlocks, toEngineToolResult } from './tool-results.ts'

export type Route = { kind: 'continue'; convId: string; results: Array<[string, EngineToolResult]> } | { kind: 'fresh' }
export type FindParked = (ids: readonly string[]) => { convId: string; parked: readonly string[] } | undefined

export const routeRequest = (req: Pick<MessagesRequest, 'messages'>, findParked: FindParked): Route => {
  const last = req.messages[req.messages.length - 1]
  if (!last || last.role !== 'user' || typeof last.content === 'string') return { kind: 'fresh' }
  const toolResults = last.content.filter((b): b is ToolResultBlock => b.type === 'tool_result')
  if (toolResults.length === 0) return { kind: 'fresh' }
  const found = findParked(toolResults.map(b => b.tool_use_id))
  if (!found) return { kind: 'fresh' }
  const byId = new Map(toolResults.map(b => [b.tool_use_id, b]))
  const results = found.parked.map((id): [string, EngineToolResult] => {
    const block = byId.get(id)
    return [id, block ? toEngineToolResult(block) : { deny: 'no result provided by client' }]
  })
  const extra = last.content.filter(
    (b): b is TextBlock | ImageBlock | DocumentBlock => b.type === 'text' || b.type === 'image' || b.type === 'document',
  )
  const tail = results[results.length - 1]
  if (tail && extra.length > 0) tail[1] = appendBlocks(tail[1], extra)
  return { kind: 'continue', convId: found.convId, results }
}
