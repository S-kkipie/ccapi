import { describe, expect, test } from 'bun:test'
import { ATTACHMENTS_TOOL, modelVisibleName, schemaKey, stripPrefix, ToolNameRegistry } from '../tool-names.ts'

describe('ToolNameRegistry', () => {
  test('the same name and schema reuse one registration', () => {
    const names = new ToolNameRegistry()
    expect(names.bind('get_weather', 'k1')).toEqual({ registered: 'get_weather', isNew: true })
    expect(names.bind('get_weather', 'k1')).toEqual({ registered: 'get_weather', isNew: false })
  })

  test('the same name with another schema gets a suffix', () => {
    const names = new ToolNameRegistry()
    names.bind('get_weather', 'k1')
    expect(names.bind('get_weather', 'k2').registered).toBe('get_weather_v2')
  })

  test('the internal tool name is never handed to a client tool', () => {
    expect(new ToolNameRegistry().bind(ATTACHMENTS_TOOL, 'k').registered).toBe(`${ATTACHMENTS_TOOL}_v2`)
  })

  test('long names are shortened deterministically to 52 characters', () => {
    const long = 'x'.repeat(64)
    const a = new ToolNameRegistry().bind(long, 'k').registered
    const b = new ToolNameRegistry().bind(long, 'k').registered
    expect(a.length).toBeLessThanOrEqual(52)
    expect(a).toBe(b)
  })
})

describe('prefix helpers', () => {
  test('round trip', () => {
    expect(modelVisibleName('get_weather')).toBe('mcp__ccapi__get_weather')
    expect(stripPrefix('mcp__ccapi__get_weather')).toBe('get_weather')
    expect(stripPrefix('Read')).toBeUndefined()
  })

  test('schemaKey is stable for equal schemas', () => {
    expect(schemaKey({ type: 'object' })).toBe(schemaKey({ type: 'object' }))
  })
})
