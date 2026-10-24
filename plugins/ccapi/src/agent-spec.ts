import type { Effort, MessagesRequest, ToolChoice } from './api.ts'
import type { AgentToRegister } from './wire.ts'
import { fnv1a } from './hash.ts'
import { ATTACHMENTS_TOOL, modelVisibleName } from './tool-names.ts'

export const effortOf = (req: Pick<MessagesRequest, 'thinking' | 'output_config'>): Effort | number | undefined => {
  if (req.output_config?.effort) return req.output_config.effort
  if (req.thinking?.type === 'enabled') return req.thinking.budget_tokens
  return undefined
}

export const toolChoiceAddendum = (
  choice: ToolChoice | undefined,
  clientToModel: (name: string) => string,
): string | undefined => {
  if (!choice || choice.type === 'auto' || choice.type === 'none') return undefined
  if (choice.type === 'any') return 'You must call at least one of your tools in your next response.'
  return `You must call the tool ${clientToModel(choice.name)} in your next response.`
}

export const ATTACHMENTS_ADDENDUM = `The latest user message includes attachments. Call ${modelVisibleName(ATTACHMENTS_TOOL)} to view them before you answer.`

export const buildAgentPlan = (input: {
  system: string
  addenda: string[]
  tools: string[]
  toolSchemaKeys: string[]
  model: string
  effort?: Effort | number
}): AgentToRegister => {
  const prompt = [input.system, ...input.addenda].filter(s => s !== '').join('\n\n') || 'You are a helpful assistant.'
  const key = fnv1a(
    JSON.stringify([prompt, [...input.tools].sort(), [...input.toolSchemaKeys].sort(), input.model, input.effort ?? null]),
  )
  return {
    name: `a${key}`,
    prompt,
    tools: input.tools,
    model: input.model,
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
  }
}
