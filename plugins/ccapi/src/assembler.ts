import type { MessageResponse, ResponseBlock, SseEvent, StopReason, Usage } from './api.ts'
import type { EngineUsage } from './wire.ts'
import { StopCutter } from './stop-cutter.ts'
import { estimateTokens } from './token-estimate.ts'

export type AssemblerOptions = {
  id: string
  model: string
  inputTokensEstimate: number
  maxTokens: number
  stopSequences: readonly string[]
  exposeThinking: boolean
  clientToolName: (modelVisibleName: string) => string | undefined
}

export type StepEnd = { stopReason: string | null; usage: EngineUsage | null; toolUseIds: readonly string[] }
export type Outcome = { kind: 'continue' } | { kind: 'done'; stopReason: StopReason }

export const UNSIGNED = 'ccapi-unsigned'

type TextContent = { type: 'text'; text: string }
type ThinkingContent = { type: 'thinking'; thinking: string; signature: string }
type ToolContent = { type: 'tool_use'; id: string; name: string; input: unknown }

type TextBlockState = { kind: 'text'; out: number; cutter: StopCutter; content: TextContent }
type Block =
  | { kind: 'skip' }
  | TextBlockState
  | { kind: 'thinking'; out: number; content: ThinkingContent }
  | { kind: 'tool'; out: number; json: string; content: ToolContent }

// How an engine step's stop reason maps onto the client's message; 'continue' keeps the message open.
const STEP_STOP: Readonly<Record<string, StopReason | 'continue'>> = {
  end_turn: 'end_turn',
  max_tokens: 'max_tokens',
  stop_sequence: 'end_turn',
  // Claude Code tells the model a safety classifier stopped it and retries within the turn;
  // a refusal it does not retry ends the turn, and turn-end finishes the message with it.
  refusal: 'continue',
  model_context_window_exceeded: 'max_tokens',
  tool_use: 'continue',
  pause_turn: 'continue',
  compaction: 'continue',
}

const zeroUsage = (): Usage => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text === '' ? '{}' : text)
  } catch {
    return {}
  }
}

export class MessageAssembler {
  readonly clientToolUseIds: string[] = []
  private readonly opts: AssemblerOptions
  private readonly onEvent: (ev: SseEvent) => void
  private readonly content: ResponseBlock[] = []
  private readonly usage: Usage = zeroUsage()
  private blocks = new Map<number, Block>()
  private open: Block | undefined
  private nextOut = 0
  private emitted = 0
  private finalUsage: Usage | undefined
  private stopReason: StopReason | null = null
  private stopSequence: string | null = null
  private finished = false

  constructor(opts: AssemblerOptions, onEvent: (ev: SseEvent) => void) {
    this.opts = opts
    this.onEvent = onEvent
  }

  get isFinished(): boolean {
    return this.finished
  }

  start(): void {
    this.onEvent({
      type: 'message_start',
      message: {
        id: this.opts.id,
        type: 'message',
        role: 'assistant',
        model: this.opts.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...zeroUsage(), input_tokens: this.opts.inputTokensEstimate },
      },
    })
  }

  text(index: number, text: string): void {
    if (this.finished) return
    const block = this.blockAt(index, 'text')
    if (block.kind !== 'text') return
    const cut = block.cutter.push(text)
    if (cut.emit !== '') this.emitText(block, cut.emit, true)
    if (cut.matched !== undefined) this.finish('stop_sequence', cut.matched)
  }

  thinking(index: number, text: string): void {
    if (this.finished) return
    // Subagents often stream thinking with no visible text; an empty block would only carry the fake signature.
    if (text === '' && !this.blocks.has(index)) return
    const block = this.blockAt(index, 'thinking')
    if (block.kind !== 'thinking') return
    block.content.thinking += text
    this.onEvent({ type: 'content_block_delta', index: block.out, delta: { type: 'thinking_delta', thinking: text } })
    this.count(text, true)
  }

  tool(index: number, id: string, name: string): void {
    if (this.finished) return
    const client = this.opts.clientToolName(name)
    if (client === undefined) this.blockAt(index, 'skip')
    else this.blockAt(index, 'tool', { id, name: client })
  }

  input(index: number, json: string): void {
    if (this.finished) return
    const block = this.blocks.get(index)
    if (block?.kind !== 'tool') return
    block.json += json
    this.onEvent({ type: 'content_block_delta', index: block.out, delta: { type: 'input_json_delta', partial_json: json } })
    this.count(json, true)
  }

  stepEnd(end: StepEnd): Outcome {
    if (end.usage) {
      this.usage.input_tokens += end.usage.input_tokens
      this.usage.output_tokens += end.usage.output_tokens
      this.usage.cache_read_input_tokens += end.usage.cache_read_input_tokens
      this.usage.cache_creation_input_tokens += end.usage.cache_creation_input_tokens
    }
    if (this.finished) return { kind: 'done', stopReason: this.stopReason ?? 'end_turn' }
    this.closeOpen(true)
    this.blocks = new Map()
    if (this.clientToolUseIds.length > 0) {
      this.finish('tool_use')
      return { kind: 'done', stopReason: 'tool_use' }
    }
    const mapped = end.stopReason === null ? 'continue' : (STEP_STOP[end.stopReason] ?? 'end_turn')
    if (mapped === 'continue') return { kind: 'continue' }
    this.finish(mapped)
    return { kind: 'done', stopReason: mapped }
  }

  finish(stopReason: StopReason, stopSequence: string | null = null): void {
    if (this.finished) return
    this.closeOpen(false)
    this.finished = true
    this.stopReason = stopReason
    this.stopSequence = stopSequence
    const usage: Usage = {
      ...this.usage,
      input_tokens: this.usage.input_tokens || this.opts.inputTokensEstimate,
      output_tokens: Math.max(this.usage.output_tokens, this.emitted),
    }
    this.finalUsage = usage
    this.onEvent({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: stopSequence }, usage: { ...usage } })
    this.onEvent({ type: 'message_stop' })
  }

  fail(type: string, message: string): void {
    if (this.finished) return
    this.finished = true
    this.onEvent({ type: 'error', error: { type, message } })
  }

  message(): MessageResponse {
    return {
      id: this.opts.id,
      type: 'message',
      role: 'assistant',
      model: this.opts.model,
      content: this.content,
      stop_reason: this.stopReason,
      stop_sequence: this.stopSequence,
      usage: this.finalUsage ?? { ...this.usage },
    }
  }

  private blockAt(index: number, kind: 'skip' | 'text' | 'thinking' | 'tool', tool?: { id: string; name: string }): Block {
    const existing = this.blocks.get(index)
    if (existing) return existing
    this.closeOpen(true)
    let block: Block
    if (kind === 'skip' || (kind === 'thinking' && !this.opts.exposeThinking)) {
      block = { kind: 'skip' }
    } else if (kind === 'text') {
      const content: TextContent = { type: 'text', text: '' }
      block = { kind: 'text', out: this.nextOut++, cutter: new StopCutter(this.opts.stopSequences), content }
      this.content.push(content)
      this.onEvent({ type: 'content_block_start', index: block.out, content_block: { type: 'text', text: '' } })
    } else if (kind === 'thinking') {
      const content: ThinkingContent = { type: 'thinking', thinking: '', signature: UNSIGNED }
      block = { kind: 'thinking', out: this.nextOut++, content }
      this.content.push(content)
      this.onEvent({ type: 'content_block_start', index: block.out, content_block: { type: 'thinking', thinking: '', signature: '' } })
    } else {
      const t = tool ?? { id: '', name: '' }
      const content: ToolContent = { type: 'tool_use', id: t.id, name: t.name, input: {} }
      block = { kind: 'tool', out: this.nextOut++, json: '', content }
      this.content.push(content)
      this.clientToolUseIds.push(t.id)
      this.onEvent({ type: 'content_block_start', index: block.out, content_block: { type: 'tool_use', id: t.id, name: t.name, input: {} } })
    }
    this.blocks.set(index, block)
    this.open = block.kind === 'skip' ? undefined : block
    return block
  }

  private closeOpen(flush: boolean): void {
    const block = this.open
    this.open = undefined
    if (!block || block.kind === 'skip') return
    if (block.kind === 'text' && flush) {
      const rest = block.cutter.flush()
      if (rest !== '') this.emitText(block, rest, false)
    }
    if (block.kind === 'thinking')
      this.onEvent({ type: 'content_block_delta', index: block.out, delta: { type: 'signature_delta', signature: UNSIGNED } })
    if (block.kind === 'tool') block.content.input = parseJson(block.json)
    this.onEvent({ type: 'content_block_stop', index: block.out })
  }

  private emitText(block: TextBlockState, text: string, check: boolean): void {
    block.content.text += text
    this.onEvent({ type: 'content_block_delta', index: block.out, delta: { type: 'text_delta', text } })
    this.count(text, check)
  }

  private count(text: string, check: boolean): void {
    this.emitted += estimateTokens(text)
    if (check && !this.finished && this.emitted > this.opts.maxTokens) this.finish('max_tokens')
  }
}
