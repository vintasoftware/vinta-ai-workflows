/**
 * The conflict fixer's round by hand: ended as a round spent, handed to
 * another agent, and moved with the run when it switches harness.
 *
 * Driven against a hanging adapter rather than a merge: what is under test is
 * which agent a round spawns on and how the round ends, and both are answered
 * before the integrator reads the worktree.
 */
import { describe, expect, it } from 'vitest'

import { fixerControl, UnknownHarness } from '../src/daemon/index.ts'
import type { AgentEvent, AgentSession, AgentTask, HarnessAdapter, SpawnOutcome } from '../src/harness/adapter.ts'
import { MockAdapter } from '../src/harness/mock.ts'
import { ConflictFixerInterrupted, createAgentConflictFixer, type ConflictRequest } from '../src/integration/fixer.ts'

const REQUEST: ConflictRequest = {
  cwd: '/tmp/integration',
  into: 'wave-1',
  incoming: 'phase-b',
  nodeId: 'b',
  nodes: ['a', 'b'],
  paths: ['app.ts'],
  promptRefs: ['plan.md#a', 'plan.md#b'],
  round: 1,
}

/** An adapter whose sessions run until they are killed, recording every task. */
function hanging(id: string): HarnessAdapter & { readonly spawned: AgentTask[]; live(): boolean } {
  const base = new MockAdapter({ id })
  const spawned: AgentTask[] = []
  let open = 0
  return {
    id,
    capabilities: base.capabilities,
    preflight: () => base.preflight(),
    spawned,
    live: () => open > 0,
    async spawn(task: AgentTask): Promise<SpawnOutcome> {
      spawned.push(task)
      let kill = (): void => {}
      const killed = new Promise<void>((resolve) => {
        kill = resolve
      })
      const session: AgentSession = {
        id: `${id}-${spawned.length}`,
        events: {
          async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
            open += 1
            try {
              yield { type: 'session_started', sessionId: `${id}-${spawned.length}` } as AgentEvent
              await killed
            } finally {
              open -= 1
            }
          },
        },
        send: async () => {},
        interrupt: async () => kill(),
        kill: async () => kill(),
      }
      return { ok: true, session }
    },
  }
}

async function until(read: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (read()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error('timed out')
}

describe('the conflict fixer, by hand', () => {
  it('ends a running round as a round spent, not a teardown', async () => {
    const adapter = hanging('codex')
    const fixer = createAgentConflictFixer({ adapter, model: 'gpt-5' })
    const round = fixer.fix(REQUEST)
    await until(() => adapter.live())

    expect(fixer.running?.()).toEqual({ harness: 'codex', model: 'gpt-5' })
    expect(await fixer.endRound?.()).toBe(true)
    // Resolves: the integrator reads the worktree, as after any round.
    await expect(round).resolves.toBeUndefined()
    expect(fixer.running?.()).toBeNull()
    expect(await fixer.endRound?.()).toBe(false)
  })

  it('still reads a teardown as an interrupted round', async () => {
    const adapter = hanging('codex')
    const fixer = createAgentConflictFixer({ adapter, model: 'gpt-5' })
    const round = fixer.fix(REQUEST)
    await until(() => adapter.live())
    await fixer.interrupt?.()
    await expect(round).rejects.toBeInstanceOf(ConflictFixerInterrupted)
  })

  it('hands later rounds to the agent it is reassigned to, and moves with a harness switch', async () => {
    const codex = hanging('codex')
    const claude = hanging('claude-code')
    const opencode = hanging('opencode')
    const fixer = createAgentConflictFixer({ adapter: codex, model: 'gpt-5' })
    const control = fixerControl(fixer, { codex, 'claude-code': claude, opencode })

    const first = fixer.fix(REQUEST)
    await until(() => codex.live())
    // `now` ends the running round, so the next starts on the new agent.
    expect(await control.reassign('claude-code', 'opus', true)).toBe(true)
    await first

    const second = fixer.fix({ ...REQUEST, round: 2 })
    await until(() => claude.live())
    expect(claude.spawned.map((task) => task.model)).toEqual(['opus'])
    await control.interrupt()
    await second

    // The run moved off claude-code: the reassigned agent moves with it.
    fixer.reroute?.('claude-code', { adapter: opencode, model: 'big-pickle' })
    const third = fixer.fix({ ...REQUEST, round: 3 })
    await until(() => opencode.live())
    expect(opencode.spawned.map((task) => task.model)).toEqual(['big-pickle'])
    await control.interrupt()
    await third

    await expect(control.reassign('nowhere', 'x', true)).rejects.toBeInstanceOf(UnknownHarness)
  })
})
