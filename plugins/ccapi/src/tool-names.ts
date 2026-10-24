import { fnv1a } from './hash.ts'

export const TOOL_PREFIX = 'mcp__ccapi__'
export const ATTACHMENTS_TOOL = 'view_attachments'

// Keeps TOOL_PREFIX + name within the API's 64-character tool name limit.
const MAX_NAME = 52

const fit = (name: string, suffix: string): string => {
  const room = MAX_NAME - suffix.length
  if (name.length <= room) return name + suffix
  return `${name.slice(0, room - 9)}_${fnv1a(name)}${suffix}`
}

export class ToolNameRegistry {
  private readonly bySchema = new Map<string, string>()
  private readonly taken = new Set<string>([ATTACHMENTS_TOOL])

  bind(clientName: string, schemaKey: string): { registered: string; isNew: boolean } {
    const key = `${clientName}\u0000${schemaKey}`
    const existing = this.bySchema.get(key)
    if (existing !== undefined) return { registered: existing, isNew: false }
    let registered = fit(clientName, '')
    for (let n = 2; this.taken.has(registered); n++) registered = fit(clientName, `_v${n}`)
    this.taken.add(registered)
    this.bySchema.set(key, registered)
    return { registered, isNew: true }
  }
}

export const modelVisibleName = (registered: string): string => TOOL_PREFIX + registered

export const stripPrefix = (name: string): string | undefined =>
  name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : undefined

export const schemaKey = (schema: unknown): string => fnv1a(JSON.stringify(schema ?? {}))
