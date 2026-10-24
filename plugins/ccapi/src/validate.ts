import type { MessagesRequest } from './api.ts'
import { ApiError } from './errors.ts'

const SUPPORTED_BLOCKS = new Set(['text', 'image', 'document', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking'])
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/

const bad = (message: string) => new ApiError(400, 'invalid_request_error', message)
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const checkBlock = (block: unknown, where: string): void => {
  if (!isObject(block) || typeof block.type !== 'string') throw bad(`${where}: each content block needs a string "type"`)
  if (!SUPPORTED_BLOCKS.has(block.type)) throw bad(`${where}: content block type "${block.type}" is not supported by ccapi`)
  if (block.type === 'image' || block.type === 'document') {
    const source = block.source
    if (!isObject(source) || source.type === 'url')
      throw bad(`${where}: ${block.type} blocks need a base64 (or text) source; URL sources are not supported by ccapi`)
  }
  if (block.type === 'tool_result' && Array.isArray(block.content))
    block.content.forEach((inner, i) => checkBlock(inner, `${where}.content[${i}]`))
}

const checkMessage = (message: unknown, i: number): void => {
  const where = `messages[${i}]`
  if (!isObject(message) || (message.role !== 'user' && message.role !== 'assistant'))
    throw bad(`${where}: role must be "user" or "assistant"`)
  if (typeof message.content === 'string') return
  if (!Array.isArray(message.content)) throw bad(`${where}: content must be a string or an array of blocks`)
  message.content.forEach((block, j) => checkBlock(block, `${where}.content[${j}]`))
}

export const parseMessagesRequest = (body: unknown): MessagesRequest => {
  if (!isObject(body)) throw bad('body must be a JSON object')
  if (typeof body.model !== 'string' || body.model === '') throw bad('model: required string')
  if (typeof body.max_tokens !== 'number' || !Number.isInteger(body.max_tokens) || body.max_tokens < 1)
    throw bad('max_tokens: required positive integer')
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw bad('messages: required non-empty array')
  body.messages.forEach(checkMessage)
  if (
    body.system !== undefined &&
    typeof body.system !== 'string' &&
    !(Array.isArray(body.system) && body.system.every(b => isObject(b) && b.type === 'text' && typeof b.text === 'string'))
  )
    throw bad('system: must be a string or an array of text blocks')
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw bad('tools: must be an array')
    body.tools.forEach((tool, i) => {
      if (!isObject(tool)) throw bad(`tools[${i}]: must be an object`)
      if (tool.type !== undefined && tool.type !== 'custom')
        throw bad(`tools[${i}]: server tools ("${String(tool.type)}") are not supported by ccapi`)
      if (typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name)) throw bad(`tools[${i}].name: must match ${TOOL_NAME}`)
      if (!isObject(tool.input_schema)) throw bad(`tools[${i}].input_schema: required object`)
    })
  }
  if (body.tool_choice !== undefined) {
    const choice = body.tool_choice
    if (!isObject(choice) || !['auto', 'any', 'none', 'tool'].includes(String(choice.type)))
      throw bad('tool_choice.type: must be auto, any, none or tool')
    if (choice.type === 'tool' && typeof choice.name !== 'string') throw bad('tool_choice.name: required for type "tool"')
  }
  if (
    body.stop_sequences !== undefined &&
    !(Array.isArray(body.stop_sequences) && body.stop_sequences.every(s => typeof s === 'string' && s !== ''))
  )
    throw bad('stop_sequences: must be an array of non-empty strings')
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw bad('stream: must be a boolean')
  return body as MessagesRequest
}
