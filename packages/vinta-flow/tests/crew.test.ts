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

import {
  assignCrew,
  assignReviewer,
  type CrewAssignInput,
  type ReviewAssignInput,
  type ReviewDecision,
  roster,
} from '../src/scheduler/crew.ts'
import type { CrewMember } from '../src/types.ts'

const impl = (tier: number, model: string, extra: Partial<CrewMember> = {}): CrewMember => ({
  role: 'implementer',
  tier,
  model,
  ...extra,
})

const reviewer = (tier: number, model: string): CrewMember => ({ role: 'reviewer', tier, model })

const CREW: Record<string, CrewMember> = {
  junior: impl(1, 'cheap-1'),
  'mid-a': impl(2, 'mid-1'),
  'mid-b': impl(2, 'mid-1'),
  senior: impl(4, 'dear-1'),
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
    const crew = { ...CREW, senior: impl(4, 'dear-1', { harness: 'codex' }) }
    const decision = assignCrew(input({ assigned: 'senior', crew }))

    expect(decision).toMatchObject({ member: 'senior', harness: 'codex' })
  })

  it('refuses to staff a phase to a reviewer, whatever the document said', () => {
    // `validate.ts` catches this before a run starts. Asserted here too, because
    // a scheduler that silently accepted it is how a reviewer ends up holding a
    // phase and then reading its own diff.
    const crew = { ...CREW, checker: reviewer(4, 'dear-1') }

    expect(assignCrew(input({ assigned: 'checker', crew }))).toEqual({ kind: 'unstaffed' })
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

describe('assignReviewer — a person, not a tier', () => {
  const STAFFED: Record<string, CrewMember> = {
    ...CREW,
    'check-mid': reviewer(2, 'mid-1'),
    'check-senior': reviewer(4, 'dear-1'),
  }

  const review = (overrides: Partial<ReviewAssignInput> = {}): ReviewDecision =>
    assignReviewer({
      crew: STAFFED,
      authorTier: 1,
      author: 'junior',
      busy: new Set(),
      ...overrides,
    })

  it('picks the cheapest reviewer qualified for the phase', () => {
    expect(review()).toEqual({
      kind: 'assigned',
      member: 'check-mid',
      tier: 2,
      model: 'mid-1',
      harness: null,
    })
  })

  /**
   * The floor is the author's tier, not one above it. A peer-tier review is a
   * review by someone the plan judged equally capable, which is what an
   * independent second pair of eyes is — the independence comes from the role.
   */
  it('lets a reviewer at the author’s own tier take it', () => {
    expect(review({ authorTier: 2, author: 'mid-a' })).toMatchObject({ member: 'check-mid' })
  })

  it('reaches up when the phase is above the cheaper reviewer', () => {
    expect(review({ authorTier: 4, author: 'senior' })).toMatchObject({ member: 'check-senior' })
  })

  it('waits for a busy reviewer rather than dropping below the author’s tier', () => {
    const decision = review({
      authorTier: 4,
      author: 'senior',
      busy: new Set(['check-senior']),
    })

    expect(decision).toEqual({ kind: 'wait', requiredTier: 4 })
  })

  it('covers with the next qualified reviewer when the cheapest is busy', () => {
    expect(review({ busy: new Set(['check-mid']) })).toMatchObject({ member: 'check-senior' })
  })

  it('is unstaffed when the roster has no reviewer, so the project default applies', () => {
    expect(review({ crew: CREW })).toEqual({ kind: 'unstaffed' })
  })

  /**
   * The invariant the two roles exist to guarantee. Unreachable through the
   * parser — a reviewer cannot be assigned a phase — so this builds the state
   * by hand and checks the assertion fires rather than the review proceeding.
   */
  it('throws rather than let a member review its own phase', () => {
    expect(() =>
      assignReviewer({
        crew: { solo: reviewer(3, 'mid-1') },
        authorTier: 3,
        author: 'solo',
        busy: new Set(),
      }),
    ).toThrow(/review its own phase/)
  })
})
