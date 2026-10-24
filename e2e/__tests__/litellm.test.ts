import { describe, expect, test } from 'bun:test'
import OpenAI from 'openai'

const enabled = process.env.CCAPI_E2E === '1' && process.env.LITELLM_URL !== undefined
const client = new OpenAI({ apiKey: process.env.LITELLM_KEY ?? 'sk-local', baseURL: `${process.env.LITELLM_URL ?? 'http://127.0.0.1:4000'}/v1`, maxRetries: 0, timeout: 300_000 })
const model = process.env.LITELLM_MODEL ?? 'claude-haiku'
const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get the current weather for a city.',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  },
]
const T = 240_000

describe.if(enabled)('ccapi e2e — OpenAI SDK through LiteLLM', () => {
  test('chat completion', async () => {
    const r = await client.chat.completions.create({ model, messages: [{ role: 'user', content: 'Reply with exactly the word PONG.' }] })
    expect(r.choices[0]?.message.content ?? '').toContain('PONG')
  }, T)

  test('streaming', async () => {
    const stream = await client.chat.completions.create({ model, stream: true, messages: [{ role: 'user', content: 'Count from 1 to 5.' }] })
    let text = ''
    for await (const chunk of stream) text += chunk.choices[0]?.delta.content ?? ''
    expect(text).toContain('3')
  }, T)

  test('tool calls round trip', async () => {
    const ask: OpenAI.Chat.Completions.ChatCompletionMessageParam = { role: 'user', content: 'What is the weather in Paris? Use the tool.' }
    const first = await client.chat.completions.create({ model, tools, messages: [ask] })
    const message = first.choices[0]?.message
    const call = message?.tool_calls?.[0]
    if (!message || call?.type !== 'function') throw new Error('no function tool call')
    expect(call.function.name).toBe('get_weather')
    const second = await client.chat.completions.create({
      model,
      tools,
      messages: [ask, message, { role: 'tool', tool_call_id: call.id, content: 'Paris: 22C, sunny' }],
    })
    expect(second.choices[0]?.message.content ?? '').toContain('22')
  }, T)
})
