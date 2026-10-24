// Protocol between the bridge and the two mods (JSON over the bridge's /internal routes).
import type { Effort } from './api.ts'

export type EngineUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export type ToolToRegister = { name: string; description: string; inputSchema: Record<string, unknown> }

export type AgentToRegister = {
  name: string
  prompt: string
  tools: string[]
  model: string
  modelFallback?: string
  effort?: Effort | number
}

export type RequestJob = { convId: string; newTools: ToolToRegister[]; agent: AgentToRegister; registerAgent: boolean }
export type SpawnJob = { convId: string; agentType: string; prompt: string; description: string }

export type RegisteredReport = { convId: string; agentType: string } | { convId: string; error: string }
export type SpawnedReport = { convId: string; agentId: string } | { convId: string; error: string }

export type TurnEndReason = 'answer' | 'aborted' | 'refusal' | 'error'

export type AgentEvent =
  | { kind: 'text'; agentId: string; index: number; text: string }
  | { kind: 'thinking'; agentId: string; index: number; text: string }
  | { kind: 'tool'; agentId: string; index: number; id: string; name: string }
  | { kind: 'input'; agentId: string; index: number; json: string }
  | {
      kind: 'step-end'
      agentId: string
      stopReason: string | null
      usage: EngineUsage | null
      toolUseIds: string[]
      toolNames: string[]
    }
  | { kind: 'turn-end'; agentId: string; reason: TurnEndReason }

export type EngineToolResult = { result: string | Array<Record<string, unknown>> } | { deny: string }
