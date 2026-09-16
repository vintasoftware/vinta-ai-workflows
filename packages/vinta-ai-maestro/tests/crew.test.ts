/**
 * Staffing decisions, one at a time.
 *
 * The two rules pull against each other — a floor that must never be crossed
 * and an idleness that should never be tolerated — so the cases that matter are
 * the ones where they disagree. A wrong answer here is silent: a phase run one
 * tier below what it needs produces plausible code and fails review later, and
 * a phase that waited when it needn't have just looks like a slow machine.
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
  tier1: impl(1, 'cheap-1'),
  'tier2-1': impl(2, 'medium-1'),
  'tier2-2': impl(2, 'medium-1'),
  tier4: impl(4, 'dear-1'),
}

function input(overrides: Partial<CrewAssignInput> = {}): CrewAssignInput {
  return { assigned: 'tier2-1', crew: CREW, busy: new Set(), ...overrides }
}

describe('assignCrew — the plan’s own staffing', () => {
  it('gives the phase to the member the plan named', () => {
    expect(assignCrew(input())).toEqual({
      kind: 'assigned',
      member: 'tier2-1',
      tier: 2,
      model: 'medium-1',
      harness: null,
      substitute: false,
      insteadOf: null,
      reason: null,
    })
  })

  it('carries a member’s harness override, so a roster can be mixed-vendor', () => {
    const crew = { ...CREW, tier4: impl(4, 'dear-1', { harness: 'codex' }) }
    const decision = assignCrew(input({ assigned: 'tier4', crew }))

    expect(decision).toMatchObject({ member: 'tier4', harness: 'codex' })
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
    const decision = assignCrew(input({ busy: new Set(['tier2-1']) }))

    expect(decision).toEqual({
      kind: 'assigned',
      member: 'tier2-2',
      tier: 2,
      model: 'medium-1',
      harness: null,
      substitute: true,
      insteadOf: 'tier2-1',
      reason: 'peer_busy',
    })
  })

  it('reaches up when it has to, and records that it did', () => {
    const decision = assignCrew(input({ busy: new Set(['tier2-1', 'tier2-2']) }))

    expect(decision).toMatchObject({ member: 'tier4', substitute: true, insteadOf: 'tier2-1' })
  })

  /**
   * The half that makes the floor worth having. A Tier 1 member is free, the
   * phase is ready, a lane is free — and the answer is still no.
   */
  it('never reaches down, even with the cheaper member sitting idle', () => {
    const decision = assignCrew(input({ busy: new Set(['tier2-1', 'tier2-2', 'tier4']) }))

    expect(decision).toEqual({ kind: 'wait', requiredTier: 2 })
  })

  /**
   * Covering should not silently promote the phase. With both a peer and a
   * Tier 4 member free, the peer takes it — otherwise a busy wave quietly runs
   * every Tier 2 phase on the top-tier model and the plan's cost estimate is
   * fiction.
   */
  it('takes the cheapest qualified member, not the best available one', () => {
    const decision = assignCrew(input({ assigned: 'tier1', busy: new Set(['tier1']) }))

    expect(decision).toMatchObject({ member: 'tier2-1', tier: 2 })
  })

  it('waits for the only member who qualifies rather than demoting the phase', () => {
    const decision = assignCrew(input({ assigned: 'tier4', busy: new Set(['tier4']) }))

    expect(decision).toEqual({ kind: 'wait', requiredTier: 4 })
  })
})

describe('assignCrew — reusing a session that is already open', () => {
  /**
   * The trade the whole feature is: a Tier 4 model on a Tier 2 phase costs more
   * per token, and it buys not starting a fifth session that would re-read the
   * repository before writing a line. The plan's own member is free here and is
   * passed over anyway, which is the part that has to be deliberate rather than
   * incidental — so it is asserted as a substitution with its own reason, not
   * merely as "`tier4` took it".
   */
  it('gives a phase to a warm higher-tier member rather than cold-starting the plan’s member', () => {
    const decision = assignCrew(input({ warm: new Set(['tier4']) }))

    expect(decision).toEqual({
      kind: 'assigned',
      member: 'tier4',
      tier: 4,
      model: 'dear-1',
      harness: null,
      substitute: true,
      insteadOf: 'tier2-1',
      reason: 'warm_session',
    })
  })

  /**
   * The case that pins "only if we already have started sessions". Nobody is
   * warm, so a session is being opened whichever member takes this — there is
   * no cold start left to save, and the Tier 4 rate would buy nothing at all.
   * The pre-defined level wins.
   */
  it('leaves a cold higher-tier member alone and staffs the phase as the plan wrote it', () => {
    expect(assignCrew(input({ warm: new Set() }))).toMatchObject({
      member: 'tier2-1',
      substitute: false,
      reason: null,
    })
  })

  /**
   * The floor, against the one pressure designed to cross it. A Tier 1
   * member's session is open, warm and free, and running a Tier 2 phase on it
   * would save a cold start — and the answer is still no. Warmth reorders the
   * qualified; it never enlarges them.
   */
  it('never reaches down to a warm member below the phase’s tier', () => {
    const decision = assignCrew(input({ warm: new Set(['tier1']) }))

    expect(decision).toMatchObject({ member: 'tier2-1', tier: 2, substitute: false })
  })

  it('waits rather than take a warm member below the floor', () => {
    const decision = assignCrew(
      input({ busy: new Set(['tier2-1', 'tier2-2', 'tier4']), warm: new Set(['tier1']) }),
    )

    expect(decision).toEqual({ kind: 'wait', requiredTier: 2 })
  })

  /** A warm member holding another node is not available to be reused. */
  it('does not reach for a warm member who is busy', () => {
    const decision = assignCrew(input({ busy: new Set(['tier4']), warm: new Set(['tier4']) }))

    expect(decision).toMatchObject({ member: 'tier2-1', substitute: false })
  })

  /**
   * Warmth is the primary key and cost is the tiebreak, not the other way
   * round — but between two warm members, neither of whom would cold-start,
   * there is nothing left to buy and the cheaper one takes it.
   */
  it('takes the cheapest warm member when more than one would resume', () => {
    const decision = assignCrew(
      input({ assigned: 'tier1', busy: new Set(['tier1']), warm: new Set(['tier2-2', 'tier4']) }),
    )

    expect(decision).toMatchObject({ member: 'tier2-2', tier: 2, reason: 'warm_session' })
  })

  /**
   * The plan's own member wins among equals. Without this, a roster where both
   * peers are warm would hand `tier2-2`'s phase to `tier2-1` on alphabetical
   * order and journal it as a substitution — a divergence from the plan
   * recorded for a saving that was never on offer, since neither would have
   * started cold.
   */
  it('prefers the plan’s member over an equally warm peer, recording no substitution', () => {
    const decision = assignCrew(
      input({ assigned: 'tier2-2', warm: new Set(['tier2-1', 'tier2-2', 'tier4']) }),
    )

    expect(decision).toMatchObject({ member: 'tier2-2', substitute: false, reason: null })
  })

  /**
   * Covering and reuse can want different people. `tier2-1` is busy, `tier2-2`
   * is free and cheap, and `tier4` is warm — the old rule says `tier2-2`, the
   * new one says `tier4`. The reason token is what keeps the two distinguishable
   * afterwards: both are `substitute: true`, and only one of them was a choice.
   */
  it('prefers a warm higher-tier member over a cheaper cold peer when covering', () => {
    const decision = assignCrew(input({ busy: new Set(['tier2-1']), warm: new Set(['tier4']) }))

    expect(decision).toMatchObject({
      member: 'tier4',
      substitute: true,
      insteadOf: 'tier2-1',
      reason: 'warm_session',
    })
  })

  /**
   * Warmth is asked of implementers only, and `warm` is an input this module
   * does not get to sanity-check. A reviewer id in it must still be unable to
   * take a phase: disjoint roles are what make an agent reviewing its own diff
   * unrepresentable, and a staffing shortcut is exactly the kind of thing that
   * would breach that one layer down.
   */
  it('cannot staff a phase to a warm reviewer', () => {
    const crew = { ...CREW, checker: reviewer(4, 'dear-1') }
    const decision = assignCrew(input({ crew, warm: new Set(['checker']) }))

    expect(decision).toMatchObject({ member: 'tier2-1', substitute: false })
  })

  /** No `warm` at all is the pre-warmth behaviour, not "everyone is warm". */
  it('behaves exactly as before when the caller cannot answer the question', () => {
    expect(assignCrew(input())).toMatchObject({ member: 'tier2-1', substitute: false })
  })
})

describe('roster order', () => {
  /**
   * Ties break on id, so two runs of one plan substitute identically. A stable
   * order is what makes "this phase cost more than the roster said" a question
   * with an answer.
   */
  it('is cheapest first, ties broken on id', () => {
    expect(roster(CREW).map((member) => member.id)).toEqual([
      'tier1',
      'tier2-1',
      'tier2-2',
      'tier4',
    ])
  })
})

describe('assignReviewer — a person, not a tier', () => {
  const STAFFED: Record<string, CrewMember> = {
    ...CREW,
    'reviewer-1': reviewer(2, 'medium-1'),
    'reviewer-2': reviewer(4, 'dear-1'),
  }

  const review = (overrides: Partial<ReviewAssignInput> = {}): ReviewDecision =>
    assignReviewer({
      crew: STAFFED,
      authorTier: 1,
      author: 'tier1',
      busy: new Set(),
      ...overrides,
    })

  it('picks the cheapest reviewer qualified for the phase', () => {
    expect(review()).toEqual({
      kind: 'assigned',
      member: 'reviewer-1',
      tier: 2,
      model: 'medium-1',
      harness: null,
    })
  })

  /**
   * The floor is the author's tier, not one above it. A peer-tier review is a
   * review by someone the plan judged equally capable, which is what an
   * independent second pair of eyes is — the independence comes from the role.
   */
  it('lets a reviewer at the author’s own tier take it', () => {
    expect(review({ authorTier: 2, author: 'tier2-1' })).toMatchObject({ member: 'reviewer-1' })
  })

  it('reaches up when the phase is above the cheaper reviewer', () => {
    expect(review({ authorTier: 4, author: 'tier4' })).toMatchObject({ member: 'reviewer-2' })
  })

  it('waits for a busy reviewer rather than dropping below the author’s tier', () => {
    const decision = review({
      authorTier: 4,
      author: 'tier4',
      busy: new Set(['reviewer-2']),
    })

    expect(decision).toEqual({ kind: 'wait', requiredTier: 4 })
  })

  it('covers with the next qualified reviewer when the cheapest is busy', () => {
    expect(review({ busy: new Set(['reviewer-1']) })).toMatchObject({ member: 'reviewer-2' })
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
        crew: { solo: reviewer(3, 'medium-1') },
        authorTier: 3,
        author: 'solo',
        busy: new Set(),
      }),
    ).toThrow(/review its own phase/)
  })
})
