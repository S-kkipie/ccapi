import { describe, expect, test } from 'bun:test'
import type { Message } from '../api.ts'
import { renderConversation, systemText } from '../render.ts'

const png = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'AAAA' } }

describe('systemText', () => {
  test('joins text blocks', () => {
    expect(systemText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\n\nb')
    expect(systemText(undefined)).toBe('')
  })
})

describe('renderConversation', () => {
  test('a single user message is the prompt itself', () => {
    const r = renderConversation([{ role: 'user', content: 'hola' }])
    expect(r.prompt).toBe('hola')
    expect(r.attachments.items).toHaveLength(0)
  })

  test('earlier turns go inside conversation_history', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Weather in Paris?' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '22C' }] },
      { role: 'assistant', content: 'It is 22C.' },
      { role: 'user', content: 'And tomorrow?' },
    ]
    const r = renderConversation(messages)
    expect(r.prompt).toContain('<conversation_history>')
    expect(r.prompt).toContain('<tool_call name="get_weather" id="toolu_1">{"city":"Paris"}</tool_call>')
    expect(r.prompt).toContain('<tool_result id="toolu_1">22C</tool_result>')
    expect(r.prompt.endsWith('And tomorrow?')).toBe(true)
  })

  test('images in the latest message become attachments', () => {
    const r = renderConversation([{ role: 'user', content: [png, { type: 'text', text: 'what is this?' }] }])
    expect(r.prompt).toContain('[attachment #1: image]')
    expect(r.latestHasAttachments).toBe(true)
    expect(r.attachments.toToolResult()).toEqual([{ type: 'text', text: 'attachment #1:' }, png])
  })

  test('images only in history do not flag the latest message', () => {
    const r = renderConversation([
      { role: 'user', content: [png] },
      { role: 'assistant', content: 'a red square' },
      { role: 'user', content: 'thanks' },
    ])
    expect(r.attachments.items).toHaveLength(1)
    expect(r.latestHasAttachments).toBe(false)
  })

  test('a trailing assistant message is a prefill', () => {
    const r = renderConversation([
      { role: 'user', content: 'Say a color' },
      { role: 'assistant', content: 'The color is' },
    ])
    expect(r.prefill).toBe('The color is')
    expect(r.prompt).toContain('Continue your reply exactly from where this text stops')
  })

  test('thinking blocks are dropped', () => {
    const r = renderConversation([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'a' }] },
      { role: 'user', content: 'q2' },
    ])
    expect(r.prompt).not.toContain('secret')
  })
})
