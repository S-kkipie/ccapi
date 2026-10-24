import { describe, expect, test } from 'bun:test'
import { ATTACHMENTS_ADDENDUM, buildAgentPlan, effortOf, toolChoiceAddendum } from '../agent-spec.ts'
import { estimateRequestTokens, estimateTokens } from '../token-estimate.ts'

describe('effortOf', () => {
  test('output_config.effort wins, then thinking budget', () => {
    expect(effortOf({ output_config: { effort: 'high' }, thinking: { type: 'enabled', budget_tokens: 2048 } })).toBe('high')
    expect(effortOf({ thinking: { type: 'enabled', budget_tokens: 2048 } })).toBe(2048)
    expect(effortOf({})).toBeUndefined()
  })
})

describe('toolChoiceAddendum', () => {
  const toModel = (n: string) => `mcp__ccapi__${n}`
  test('auto and none add nothing', () => {
    expect(toolChoiceAddendum({ type: 'auto' }, toModel)).toBeUndefined()
    expect(toolChoiceAddendum({ type: 'none' }, toModel)).toBeUndefined()
  })
  test('any and tool become instructions', () => {
    expect(toolChoiceAddendum({ type: 'any' }, toModel)).toContain('at least one')
    expect(toolChoiceAddendum({ type: 'tool', name: 'get_weather' }, toModel)).toContain('mcp__ccapi__get_weather')
  })
})

describe('buildAgentPlan', () => {
  const base = { system: 'Be brief.', addenda: [], tools: ['mcp__ccapi__get_weather'], toolSchemaKeys: ['k1'], model: 'haiku' }
  test('same inputs give the same agent name', () => {
    expect(buildAgentPlan(base).name).toBe(buildAgentPlan(base).name)
    expect(buildAgentPlan(base).name).toMatch(/^a[0-9a-f]{8}$/)
  })
  test('a different system prompt gives another agent', () => {
    expect(buildAgentPlan({ ...base, system: 'Be long.' }).name).not.toBe(buildAgentPlan(base).name)
  })
  test('addenda are appended to the system prompt', () => {
    expect(buildAgentPlan({ ...base, addenda: [ATTACHMENTS_ADDENDUM] }).prompt).toBe(`Be brief.\n\n${ATTACHMENTS_ADDENDUM}`)
  })
  test('an empty system prompt gets a neutral default', () => {
    expect(buildAgentPlan({ ...base, system: '' }).prompt).toBe('You are a helpful assistant.')
  })
  test('effort is carried only when given', () => {
    expect('effort' in buildAgentPlan(base)).toBe(false)
    expect(buildAgentPlan({ ...base, effort: 'low' }).effort).toBe('low')
  })
})

describe('token estimates', () => {
  test('about 3.5 characters per token', () => {
    expect(estimateTokens('x'.repeat(35))).toBe(10)
  })
  test('base64 media counts as a flat 1600 tokens', () => {
    const data = 'A'.repeat(100_000)
    const n = estimateRequestTokens({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data } }] }] })
    expect(n).toBeGreaterThan(1600)
    expect(n).toBeLessThan(1700)
  })
})
