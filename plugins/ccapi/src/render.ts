import type { ContentBlock, Message, MessagesRequest, TextBlock } from './api.ts'
import { AttachmentList } from './attachments.ts'

export type Rendered = { prompt: string; attachments: AttachmentList; latestHasAttachments: boolean; prefill?: string }

export const systemText = (system: MessagesRequest['system']): string =>
  system === undefined ? '' : typeof system === 'string' ? system : system.map(b => b.text).join('\n\n')

const blocksOf = (m: Message): ContentBlock[] => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content)

const renderBlock = (block: ContentBlock, attachments: AttachmentList): string => {
  switch (block.type) {
    case 'text':
      return block.text
    case 'image':
    case 'document':
      return `[attachment #${attachments.add(block)}: ${block.type}]`
    case 'tool_use':
      return `<tool_call name="${block.name}" id="${block.id}">${JSON.stringify(block.input ?? {})}</tool_call>`
    case 'tool_result': {
      const inner =
        block.content === undefined
          ? ''
          : typeof block.content === 'string'
            ? block.content
            : block.content.map(c => renderBlock(c, attachments)).join('\n')
      return `<tool_result id="${block.tool_use_id}"${block.is_error ? ' is_error="true"' : ''}>${inner}</tool_result>`
    }
    case 'thinking':
    case 'redacted_thinking':
      return ''
  }
}

const renderBlocks = (m: Message, attachments: AttachmentList): string =>
  blocksOf(m)
    .map(b => renderBlock(b, attachments))
    .filter(s => s !== '')
    .join('\n')

export const renderConversation = (messages: readonly Message[]): Rendered => {
  const attachments = new AttachmentList()
  let list = [...messages]
  let prefill: string | undefined
  const last = list[list.length - 1]
  if (last?.role === 'assistant') {
    prefill = blocksOf(last)
      .filter((b): b is TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')
    list = list.slice(0, -1)
  }
  const latest = list[list.length - 1]
  const history = list.slice(0, -1)
  const parts: string[] = []
  if (history.length > 0) {
    parts.push(
      '<conversation_history>',
      ...history.map(m => `<${m.role}>\n${renderBlocks(m, attachments)}\n</${m.role}>`),
      '</conversation_history>',
      '',
      'Continue the conversation. Latest user message:',
      '',
    )
  }
  const before = attachments.items.length
  if (latest) parts.push(renderBlocks(latest, attachments))
  const latestHasAttachments = attachments.items.length > before
  if (prefill) parts.push('', `Continue your reply exactly from where this text stops, without repeating it:\n${prefill}`)
  const prompt = parts.join('\n') || '(empty message)'
  return { prompt, attachments, latestHasAttachments, ...(prefill ? { prefill } : {}) }
}
