import { describe, expect, test } from 'bun:test'
import { StopCutter } from '../stop-cutter.ts'

describe('StopCutter', () => {
  test('passes text through when there are no stop sequences', () => {
    expect(new StopCutter([]).push('abc')).toEqual({ emit: 'abc' })
  })

  test('cuts at a stop sequence inside one chunk', () => {
    expect(new StopCutter(['END']).push('one END two')).toEqual({ emit: 'one ', matched: 'END' })
  })

  test('cuts at a stop sequence split across chunks', () => {
    const cutter = new StopCutter(['STOP'])
    expect(cutter.push('abc ST')).toEqual({ emit: 'abc' })
    expect(cutter.push('OP def')).toEqual({ emit: ' ', matched: 'STOP' })
  })

  test('held-back text comes out on flush', () => {
    const cutter = new StopCutter(['STOP'])
    cutter.push('abc ST')
    expect(cutter.flush()).toBe(' ST')
  })

  test('the earliest of several stop sequences wins', () => {
    expect(new StopCutter(['zz', 'b']).push('abzz')).toEqual({ emit: 'a', matched: 'b' })
  })
})
