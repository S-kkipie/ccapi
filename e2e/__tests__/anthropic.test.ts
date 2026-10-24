import { describe, expect, test } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'

const enabled = process.env.CCAPI_E2E === '1'
const baseURL = process.env.CCAPI_URL ?? 'http://127.0.0.1:18787'
const model = process.env.CCAPI_MODEL ?? 'claude-haiku-4-5-20251001'
const token = enabled ? (await Bun.file(`${process.env.HOME}/.config/ccapi/token`).text()).trim() : 'unused'
const client = new Anthropic({ apiKey: token, baseURL, maxRetries: 0, timeout: 300_000 })
const fixture = async (name: string) =>
  Buffer.from(await Bun.file(new URL(`../fixtures/${name}`, import.meta.url)).arrayBuffer()).toString('base64')
const textOf = (content: Anthropic.ContentBlock[]) => content.map(b => (b.type === 'text' ? b.text : '')).join('')
const weather: Anthropic.Tool = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
}
const T = 240_000

describe.if(enabled)('ccapi e2e — Anthropic SDK', () => {
  test('plain text', async () => {
    const m = await client.messages.create({ model, max_tokens: 256, messages: [{ role: 'user', content: 'Reply with exactly the word PONG and nothing else.' }] })
    expect(m.stop_reason).toBe('end_turn')
    expect(textOf(m.content)).toContain('PONG')
    expect(m.usage.output_tokens).toBeGreaterThan(0)
  }, T)

  test('streaming', async () => {
    const stream = client.messages.stream({ model, max_tokens: 256, messages: [{ role: 'user', content: 'Count from 1 to 5 separated by spaces.' }] })
    let deltas = 0
    stream.on('text', () => {
      deltas++
    })
    const m = await stream.finalMessage()
    expect(deltas).toBeGreaterThan(0)
    expect(textOf(m.content)).toContain('3')
  }, T)

  test('tool use with native continuation', async () => {
    const ask: Anthropic.MessageParam = { role: 'user', content: 'What is the weather in Paris? Use the tool.' }
    const first = await client.messages.create({ model, max_tokens: 512, tools: [weather], messages: [ask] })
    expect(first.stop_reason).toBe('tool_use')
    const call = first.content.find(b => b.type === 'tool_use')
    if (call?.type !== 'tool_use') throw new Error('no tool_use block')
    expect(call.name).toBe('get_weather')
    expect(call.id.startsWith('toolu_')).toBe(true)
    const second = await client.messages.create({
      model,
      max_tokens: 512,
      tools: [weather],
      messages: [
        ask,
        { role: 'assistant', content: first.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'Paris: 22C, sunny, station W-7781' }] },
      ],
    })
    expect(second.stop_reason).toBe('end_turn')
    expect(textOf(second.content)).toContain('22')
  }, T)

  test('image input', async () => {
    const m = await client.messages.create({
      model,
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: await fixture('zebra42.png') } },
            { type: 'text', text: 'What text is written in this image? Reply with the text only.' },
          ],
        },
      ],
    })
    expect(textOf(m.content).toUpperCase()).toContain('ZEBRA')
  }, T)

  test('image inside a tool_result', async () => {
    const shot: Anthropic.Tool = { name: 'take_screenshot', description: 'Takes a screenshot of the screen.', input_schema: { type: 'object', properties: {} } }
    const ask: Anthropic.MessageParam = { role: 'user', content: 'Take a screenshot and tell me what text it shows.' }
    const first = await client.messages.create({ model, max_tokens: 512, tools: [shot], messages: [ask] })
    const call = first.content.find(b => b.type === 'tool_use')
    if (call?.type !== 'tool_use') throw new Error('no tool_use block')
    const second = await client.messages.create({
      model,
      max_tokens: 512,
      tools: [shot],
      messages: [
        ask,
        { role: 'assistant', content: first.content },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: call.id,
              content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: await fixture('zebra42.png') } }],
            },
          ],
        },
      ],
    })
    expect(textOf(second.content).toUpperCase()).toContain('ZEBRA')
  }, T)

  test('PDF document input', async () => {
    const m = await client.messages.create({
      model,
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: await fixture('secret77.pdf') } },
            { type: 'text', text: 'What is the secret number in this PDF? Reply with the number only.' },
          ],
        },
      ],
    })
    expect(textOf(m.content)).toContain('77')
  }, T)

  test('stop sequences', async () => {
    const m = await client.messages.create({
      model,
      max_tokens: 256,
      stop_sequences: ['9'],
      messages: [{ role: 'user', content: 'Count from 1 to 20 separated by single spaces. Output only the numbers.' }],
    })
    expect(m.stop_reason).toBe('stop_sequence')
    expect(m.stop_sequence).toBe('9')
    expect(textOf(m.content)).not.toContain('10')
  }, T)

  test('max_tokens', async () => {
    const m = await client.messages.create({ model, max_tokens: 5, messages: [{ role: 'user', content: 'Write a 300 word story about a lighthouse.' }] })
    expect(m.stop_reason).toBe('max_tokens')
  }, T)

  test('models and count_tokens', async () => {
    const models = await client.models.list()
    expect(models.data.length).toBeGreaterThan(0)
    const count = await client.messages.countTokens({ model, messages: [{ role: 'user', content: 'hello there' }] })
    expect(count.input_tokens).toBeGreaterThan(0)
  }, T)

  test('a bad key is a 401', async () => {
    const res = await fetch(`${baseURL}/v1/messages`, { method: 'POST', headers: { 'x-api-key': 'nope', 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(401)
  })
})
