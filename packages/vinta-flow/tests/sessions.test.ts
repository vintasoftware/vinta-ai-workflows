/**
 * §15.2's validity rules, one at a time.
 *
 * Every entry in this file is a way reuse becomes wrong. That matters more
 * than the happy path: continuing the right session saves tokens, and
 * continuing the *wrong* one hands an agent a context describing a worktree it
 * is not standing in, or a vendor that never issued the id. So each rule gets
 * its own case rather than being reached incidentally by an end-to-end run —
 * `lane_changed` in particular is only reachable there through a capacity
 * refusal racing a lane hand-off, which is a schedule no test should assert on.
 *
 * The reason token is asserted alongside the disposition throughout. A plan
 * that refuses to reuse for the wrong stated reason is still a bug: the tokens
 * are what an operator reads when reuse silently stops happening.
 */
import { describe, expect, it } from 'vitest'

import { planSession, type SessionEntry, type SessionPlanInput } from '../src/scheduler/sessions.ts'

const ENTRY: SessionEntry = {
  harnessId: 'claude-code',
  sessionId: 'session-abc',
  lane: 'run-1-lane-1',
  turns: 1,
}

/** A spawn that should reuse. Each test breaks exactly one thing about it. */
function input(overrides: Partial<SessionPlanInput> = {}): SessionPlanInput {
  return {
    declaredSlot: 'main',
    role: 'implementer',
    canResume: true,
    harnessId: 'claude-code',
    lane: 'run-1-lane-1',
    ledger: new Map([['main', ENTRY]]),
    maxTurns: 12,
    fixRounds: 0,
    maxFixRounds: 2,
    takeoverSessionId: null,
    ...overrides,
  }
}

describe('planSession — reuse', () => {
  it('continues the slot it was given, and advances that slot’s turn count', () => {
    const plan = planSession(input())

    expect(plan).toEqual({
      slot: 'main',
      resumeSessionId: 'session-abc',
      continuation: true,
      reason: null,
      turns: 2,
    })
  })

  it('reads the slot it was named, not whatever the ledger happens to hold', () => {
    const ledger = new Map<string, SessionEntry>([
      ['main', ENTRY],
      ['review', { ...ENTRY, sessionId: 'session-review' }],
    ])

    expect(planSession(input({ declaredSlot: 'review', ledger })).resumeSessionId).toBe(
      'session-review',
    )
    // The guarantee that matters for the standard pipeline: a reviewer never
    // lands inside the session it is supposed to be reviewing.
    expect(planSession(input({ declaredSlot: 'review', ledger })).resumeSessionId).not.toBe(
      ENTRY.sessionId,
    )
  })

  it('starts a fresh session for a slot nothing has run yet', () => {
    const plan = planSession(input({ ledger: new Map() }))

    expect(plan.continuation).toBe(false)
    expect(plan.reason).toBe('no_prior_session')
    expect(plan.resumeSessionId).toBeNull()
    // Still recorded under the slot: this turn is what the next one continues.
    expect(plan.slot).toBe('main')
    expect(plan.turns).toBe(1)
  })
})

describe('planSession — §15.2 invalidation', () => {
  it('refuses a session the harness cannot continue', () => {
    const plan = planSession(input({ canResume: false }))

    expect([plan.continuation, plan.reason]).toEqual([false, 'no_resume_capability'])
  })

  it('reports the capability rather than the empty slot when both are true', () => {
    // Accuracy, not pedantry: `no_prior_session` reads as "it will reuse next
    // turn", and on a harness that cannot resume it never will.
    const plan = planSession(input({ canResume: false, ledger: new Map() }))

    expect(plan.reason).toBe('no_resume_capability')
  })

  it('refuses a session that belongs to a different harness', () => {
    const plan = planSession(input({ harnessId: 'codex' }))

    expect([plan.continuation, plan.reason]).toEqual([false, 'harness_changed'])
    expect(plan.resumeSessionId).toBeNull()
  })

  it('refuses a session that ran in a different lane', () => {
    // The case a capacity refusal produces: the node re-drives its pipeline in
    // whatever lane it gets next, and the session's history describes the old
    // worktree.
    const plan = planSession(input({ lane: 'run-1-lane-2' }))

    expect([plan.continuation, plan.reason]).toEqual([false, 'lane_changed'])
  })

  it('refuses a session when the node holds no lane at all', () => {
    const plan = planSession(input({ lane: null }))

    expect([plan.continuation, plan.reason]).toEqual([false, 'lane_changed'])
  })

  it('starts fresh once the slot reaches its turn ceiling', () => {
    const ledger = new Map([['main', { ...ENTRY, turns: 12 }]])
    const plan = planSession(input({ ledger, maxTurns: 12 }))

    expect([plan.continuation, plan.reason]).toEqual([false, 'turn_ceiling'])
    // The counter restarts with the session it restarts.
    expect(plan.turns).toBe(1)
  })

  it('keeps reusing right up to the ceiling', () => {
    const ledger = new Map([['main', { ...ENTRY, turns: 11 }]])

    expect(planSession(input({ ledger, maxTurns: 12 })).continuation).toBe(true)
  })
})

describe('planSession — §15.5 the last fix round', () => {
  it('reuses the implementer’s session for a fixer that is not the last', () => {
    const plan = planSession(input({ role: 'fixer', fixRounds: 0, maxFixRounds: 2 }))

    expect(plan.continuation).toBe(true)
    expect(plan.resumeSessionId).toBe('session-abc')
  })

  it('hands the last fix round to a session that has not seen the work', () => {
    const plan = planSession(input({ role: 'fixer', fixRounds: 1, maxFixRounds: 2 }))

    expect([plan.continuation, plan.reason]).toEqual([false, 'final_fix_round'])
  })

  it('does not escalate a single-round budget, because nobody has failed yet', () => {
    // `>= 1` in `isLastFixRound`: escalation means "the author already tried".
    // Treating round one as the last would mean never reusing on the fix path
    // at all for a node with `max_fix_rounds: 1`.
    const plan = planSession(input({ role: 'fixer', fixRounds: 0, maxFixRounds: 1 }))

    expect(plan.continuation).toBe(true)
  })

  it('escalates only fixers — a reviewer on its last round keeps its session', () => {
    const plan = planSession(input({ role: 'reviewer', fixRounds: 1, maxFixRounds: 2 }))

    expect(plan.continuation).toBe(true)
  })
})

describe('planSession — pipelines that named no slot', () => {
  it('starts fresh every time, which is what a slotless pipeline asked for', () => {
    const plan = planSession(input({ declaredSlot: undefined }))

    expect(plan).toEqual({
      slot: null,
      resumeSessionId: null,
      continuation: false,
      reason: 'no_slot',
      turns: 1,
    })
  })

  it('treats a non-string or empty `session` param as no slot at all', () => {
    for (const declaredSlot of [42, '', null, {}, []]) {
      expect(planSession(input({ declaredSlot })).slot).toBeNull()
    }
  })

  it('ignores the ledger even when a slot of that name has a session', () => {
    // The ledger is keyed by slot; without one there is nothing to look up, and
    // guessing (say, by role) would resume a session the pipeline never asked
    // this turn to continue.
    const plan = planSession(input({ declaredSlot: undefined }))

    expect(plan.resumeSessionId).toBeNull()
  })

  it('still continues §9’s takeover handoff', () => {
    const plan = planSession(input({ declaredSlot: undefined, takeoverSessionId: 'operator-1' }))

    expect(plan.continuation).toBe(true)
    expect(plan.resumeSessionId).toBe('operator-1')
    // Nothing to record it under, and no slot budget spent.
    expect([plan.slot, plan.turns]).toEqual([null, 0])
  })

  it('drops the takeover handoff on a harness that cannot resume', () => {
    const plan = planSession(
      input({ declaredSlot: undefined, takeoverSessionId: 'operator-1', canResume: false }),
    )

    expect([plan.continuation, plan.reason]).toEqual([false, 'no_slot'])
    expect(plan.resumeSessionId).toBeNull()
  })
})
