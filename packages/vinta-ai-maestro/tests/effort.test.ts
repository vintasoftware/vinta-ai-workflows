import { describe, expect, it } from 'vitest'

import { clampEffort } from '../src/harness/effort.ts'

describe('clampEffort', () => {
  it('keeps a level the model offers', () => {
    expect(clampEffort('high', ['low', 'medium', 'high', 'xhigh'])).toBe('high')
  })

  it('steps down to the nearest level the model has', () => {
    // The usual gap: a model with no `xhigh` runs an `xhigh` phase at `high`.
    expect(clampEffort('xhigh', ['low', 'medium', 'high'])).toBe('high')
    expect(clampEffort('max', ['medium', 'xhigh'])).toBe('xhigh')
  })

  it('steps up only when nothing at or below is offered', () => {
    expect(clampEffort('low', ['medium', 'high'])).toBe('medium')
  })

  it('never picks a level below the shared scale', () => {
    // `minimal` is below `low`; a plan that asked for `low` did not ask for it.
    expect(clampEffort('low', ['none', 'minimal', 'high'])).toBe('high')
    expect(clampEffort('medium', ['none', 'minimal'])).toBeUndefined()
  })

  it('has nothing to offer for a model with no levels', () => {
    expect(clampEffort('high', [])).toBeUndefined()
  })
})
