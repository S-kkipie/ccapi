import { ApiError } from './errors.ts'

export type ModelInfo = { id: string; display_name: string }

export const MODELS: readonly ModelInfo[] = [
  { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5' },
]

const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'] as const

export const resolveModel = (requested: string): string => {
  const model = requested.trim()
  if ((FAMILIES as readonly string[]).includes(model) || /^claude-[a-z0-9.-]+$/i.test(model)) return model
  throw new ApiError(400, 'invalid_request_error', `model: "${requested}" is not a Claude model id or alias`)
}

export const familyAlias = (model: string): string | undefined =>
  FAMILIES.find(family => model.toLowerCase().includes(family))
