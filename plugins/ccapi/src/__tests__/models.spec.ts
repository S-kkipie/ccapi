import { describe, expect, test } from 'bun:test'
import { fnv1a } from '../hash.ts'
import { familyAlias, MODELS, resolveModel } from '../models.ts'

describe('fnv1a', () => {
  test('matches the FNV-1a 32-bit reference values', () => {
    expect(fnv1a('')).toBe('811c9dc5')
    expect(fnv1a('a')).toBe('e40c292c')
  })
})

describe('models', () => {
  test('full Claude ids and aliases pass through', () => {
    expect(resolveModel('claude-sonnet-5-5')).toBe('claude-sonnet-5-5')
    expect(resolveModel('haiku')).toBe('haiku')
  })

  test('anything else is a 400', () => {
    expect(() => resolveModel('gpt-4o')).toThrow('not a Claude model')
  })

  test('familyAlias finds the family inside a full id', () => {
    expect(familyAlias('claude-opus-5-5')).toBe('opus')
    expect(familyAlias('claude-haiku-4-5-20251001')).toBe('haiku')
    expect(familyAlias('mystery')).toBeUndefined()
  })

  test('the model list is not empty', () => {
    expect(MODELS.length).toBeGreaterThan(0)
  })
})
