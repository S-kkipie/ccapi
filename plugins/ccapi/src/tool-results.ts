import type { DocumentBlock, ImageBlock, TextBlock, ToolResultBlock } from './api.ts'
import type { EngineToolResult } from './wire.ts'

const isText = (b: { type: string }): b is TextBlock => b.type === 'text'

export const toEngineToolResult = (block: ToolResultBlock): EngineToolResult => {
  const content = block.content ?? ''
  const blocks: Array<TextBlock | ImageBlock | DocumentBlock> = typeof content === 'string' ? [{ type: 'text', text: content }] : content
  if (block.is_error) {
    const text = blocks.filter(isText).map(b => b.text).join('\n')
    return { deny: text || 'the tool reported an error' }
  }
  if (blocks.every(isText)) {
    const text = blocks.map(b => b.text).join('\n')
    return { result: text === '' ? '(empty result)' : text }
  }
  // Media inside a tool result only reaches the model as an array of Anthropic blocks (spike finding 4b).
  return { result: blocks.map(b => ({ ...b })) }
}

export const appendBlocks = (
  result: EngineToolResult,
  extra: ReadonlyArray<TextBlock | ImageBlock | DocumentBlock>,
): EngineToolResult => {
  if ('deny' in result) return { deny: [result.deny, ...extra.filter(isText).map(b => b.text)].join('\n') }
  if (typeof result.result === 'string' && extra.every(isText))
    return { result: [result.result, ...extra.map(b => b.text)].join('\n\n') }
  const head: Array<Record<string, unknown>> = typeof result.result === 'string' ? [{ type: 'text', text: result.result }] : result.result
  return { result: [...head, ...extra.map(b => ({ ...b }))] }
}
