import type { ContentBlock, Message, MessagesRequest, ResponseBlock, Tool } from './api.ts'
import { systemText } from './render.ts'

// A conversation as a string that two requests share exactly when one continues the other: the same
// system prompt and tools, and messages that agree block for block. Thinking blocks are left out
// (clients drop or keep them freely), string content counts as one text block, and tool input is
// compared with its keys sorted. The bridge hashes it; nothing here may reach a Node or DOM API.

type AnyBlock = ContentBlock | ResponseBlock

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, stable(v)]),
    )
  return value
}

const block = (b: AnyBlock): unknown => {
  switch (b.type) {
    case 'text':
      return ['text', b.text]
    case 'tool_use':
      return ['tool_use', b.id, b.name, stable(b.input)]
    case 'tool_result':
      return [
        'tool_result',
        b.tool_use_id,
        b.is_error === true,
        typeof b.content === 'string' ? [['text', b.content]] : (b.content ?? []).map(block),
      ]
    case 'image':
    case 'document':
      return [b.type, stable(b.source)]
    default:
      return null
  }
}

const content = (c: string | readonly AnyBlock[]): unknown[] =>
  typeof c === 'string' ? [['text', c]] : c.map(block).filter(x => x !== null)

export const canonicalConversation = (
  system: MessagesRequest['system'],
  tools: readonly Pick<Tool, 'name' | 'input_schema'>[] | undefined,
  messages: readonly (Message | { role: 'assistant'; content: readonly ResponseBlock[] })[],
): string =>
  JSON.stringify([
    systemText(system),
    [...(tools ?? [])].map(t => [t.name, stable(t.input_schema)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    messages.map(m => [m.role, content(m.content)]),
  ])
