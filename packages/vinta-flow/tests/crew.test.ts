/**
 * Staffing decisions, one at a time.
 *
 * The two rules pull against each other — a floor that must never be crossed
 * and an idleness that should never be tolerated — so the cases that matter are
 * the ones where they disagree. A wrong answer here is silent: a phase run one
 * tier too junior produces plausible code and fails review later, and a phase
 * that waited when it needn't have just looks like a slow machine.
 */
import { describe, expect, it } from 'vitest'

import { assignCrew, type CrewAssignInput, reviewerModel, roster } from '../src/scheduler/crew.ts'
import type { CrewMember } from '../src/types.ts'

const CREW: Record<string, CrewMember> = {
  junior: { tier: 1, model: 'cheap-1' },
  'mid-a': { tier: 2, model: 'mid-1' },
  'mid-b': { tier: 2, model: 'mid-1' },
  senior: { tier: 4, model: 'dear-1' },
}

function input(overrides: Partial<CrewAssignInput> = {}): CrewAssignInput {
  return { assigned: 'mid-a', crew: CREW, busy: new Set(), ...overrides }
}

describe('assignCrew — the plan’s own staffing', () => {
  it('gives the phase to the member the plan named', () => {
    expect(assignCrew(input())).toEqual({
      kind: 'assigned',
      member: 'mid-a',
      tier: 2,
      model: 'mid-1',
      harness: null,
      substitute: false,
      insteadOf: null,
    })
  })

  it('carries a member’s harness override, so a roster can be mixed-vendor', () => {
    const crew = { ...CREW, senior: { tier: 4, model: 'dear-1', harness: 'codex' as const } }
    const decision = assignCrew(input({ assigned: 'senior', crew }))

    expect(decision).toMatchObject({ member: 'senior', harness: 'codex' })
  })

  it('is unstaffed when there is no roster — every workflow written before one', () => {
    expect(assignCrew(input({ crew: {}, assigned: undefined }))).toEqual({ kind: 'unstaffed' })
  })
})

describe('assignCrew — covering for a busy peer', () => {
  it('hands the phase to a free peer at the same tier rather than idling', () => {
    const decision = assignCrew(input({ busy: new Set(['mid-a']) }))

    expect(decision).toEqual({
      kind: 'assigned',
      member: 'mid-b',
      tier: 2,
      model: 'mid-1',
      harness: null,
      substitute: true,
      insteadOf: 'mid-a',
    })
  })

  it('reaches up when it has to, and records that it did', () => {
    const decision = assignCrew(input({ busy: new Set(['mid-a', 'mid-b']) }))

    expect(decision).toMatchObject({ member: 'senior', substitute: true, insteadOf: 'mid-a' })
  })

  /**
   * The half that makes the floor worth having. A junior is free, the phase is
   * ready, a lane is free — and the answer is still no.
   */
  it('never reaches down, even with the cheaper member sitting idle', () => {
    const decision = assignCrew(input({ busy: new Set(['mid-a', 'mid-b', 'senior']) }))

    expect(decision).toEqual({ kind: 'wait', requiredTier: 2 })
  })

  /**
   * Covering should not silently promote the phase. With both a peer and a
   * senior free, the peer takes it — otherwise a busy wave quietly runs every
   * mid-tier phase on the top-tier model and the plan's cost estimate is
   * fiction.
   */
  it('takes the cheapest qualified member, not the best available one', () => {
    const decision = assignCrew(input({ assigned: 'junior', busy: new Set(['junior']) }))

    expect(decision).toMatchObject({ member: 'mid-a', tier: 2 })
  })

  it('waits for the only member who qualifies rather than demoting the phase', () => {
    const decision = assignCrew(input({ assigned: 'senior', busy: new Set(['senior']) }))

    expect(decision).toEqual({ kind: 'wait', requiredTier: 4 })
  })
})

describe('roster order', () => {
  /**
   * Ties break on id, so two runs of one plan substitute identically. A stable
   * order is what makes "this phase cost more than the roster said" a question
   * with an answer.
   */
  it('is cheapest first, ties broken on id', () => {
    expect(roster(CREW).map((member) => member.id)).toEqual(['junior', 'mid-a', 'mid-b', 'senior'])
  })
})

describe('reviewerModel — a tier above the author', () => {
  it('reviews a junior’s work on the next tier up, not on the top of the roster', () => {
    expect(reviewerModel(CREW, 1)).toEqual({ member: 'mid-a', model: 'mid-1', tier: 2 })
  })

  it('skips peers at the author’s own tier — a review is not a second opinion', () => {
    expect(reviewerModel(CREW, 2)).toEqual({ member: 'senior', model: 'dear-1', tier: 4 })
  })

  it('has nobody above the top tier, and says so instead of inventing one', () => {
    expect(reviewerModel(CREW, 4)).toBeNull()
  })

  it('has nobody above a single-tier team either', () => {
    expect(reviewerModel({ solo: { tier: 3, model: 'mid-1' } }, 3)).toBeNull()
  })
})
