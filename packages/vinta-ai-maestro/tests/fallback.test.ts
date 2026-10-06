import { describe, expect, it } from 'vitest'
import type { AgentTask } from '../src/harness/adapter.ts'
import { nextFallback, spawnWithFallbacks } from '../src/harness/fallback.ts'
import { MockAdapter } from '../src/harness/mock.ts'

describe('nextFallback', () => {
  it('follows a chain past the models it is told to skip', () => {
    const fallbacks = { fable: 'opus', opus: 'sonnet' }
    expect(nextFallback('fable', fallbacks)).toBe('opus')
    expect(nextFallback('fable', fallbacks, (model) => model === 'opus')).toBe('sonnet')
    expect(nextFallback('sonnet', fallbacks)).toBeUndefined()
    expect(nextFallback('fable', undefined)).toBeUndefined()
  })

  it('stops at a cycle rather than looping on it', () => {
    const fallbacks = { a: 'b', b: 'a', self: 'self' }
    expect(nextFallback('a', fallbacks, () => true)).toBeUndefined()
    expect(nextFallback('self', fallbacks)).toBeUndefined()
  })
})

describe('spawnWithFallbacks', () => {
  const task: AgentTask = { nodeId: 'monitor:run-1', cwd: '/tmp', prompt: 'how is the run', model: 'fable' }

  it('retries on the fallback after a quota refusal and says which model it landed on', async () => {
    const adapter = new MockAdapter({ spawns: ['quota'] })
    const { outcome, model } = await spawnWithFallbacks(adapter, task, { fable: 'opus' })
    expect(outcome.ok).toBe(true)
    expect(model).toBe('opus')
    expect(adapter.spawned.map((spawned) => spawned.model)).toEqual(['opus'])
  })

  it('returns any other refusal as it came', async () => {
    const adapter = new MockAdapter({ spawns: ['rate_limit'] })
    const { outcome, model } = await spawnWithFallbacks(adapter, task, { fable: 'opus' })
    expect(outcome.ok === false && outcome.kind).toBe('rate_limit')
    expect(model).toBe('fable')
  })

  it('gives up once the chain is spent', async () => {
    const adapter = new MockAdapter({ spawns: ['quota', 'quota'] })
    const { outcome, model } = await spawnWithFallbacks(adapter, task, { fable: 'opus', opus: 'fable' })
    expect(outcome.ok === false && outcome.kind).toBe('quota')
    expect(model).toBe('opus')
  })
})
