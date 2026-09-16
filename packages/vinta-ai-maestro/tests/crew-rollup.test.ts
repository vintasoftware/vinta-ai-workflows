/**
 * The staffing rollup.
 *
 * What makes this worth its own file is that every way it can be wrong reads
 * as a plausible number. A substitution counted as planned says the roster held
 * when it did not; an unreadable row folded in as planned says the same thing
 * more quietly. Both leave a run that overspent looking like one that did not,
 * which is the single question this rollup exists to answer.
 */
import { describe, expect, it } from 'vitest'

import type { StoredEvent } from '../src/journal/events.ts'
import { collectRunCrew, type CrewSource } from '../src/usage/crew.ts'

let nextId = 0

function claim(nodeId: string, payload: Record<string, unknown>): StoredEvent {
  nextId += 1
  return {
    id: nextId,
    ts: 1_000 + nextId,
    runId: 'r1',
    nodeId,
    type: 'node_crew',
    payload,
  } as StoredEvent
}

const source = (events: readonly StoredEvent[]): CrewSource => ({
  crewAssignments: () => events,
})

describe('collectRunCrew', () => {
  it('counts what each member took, cheapest tier first', () => {
    const run = collectRunCrew(
      source([
        claim('p1', { member: 'senior', tier: 4, substitute: false }),
        claim('p2', { member: 'junior', tier: 1, substitute: false }),
        claim('p3', { member: 'junior', tier: 1, substitute: false }),
      ]),
      'r1',
    )

    expect(run.members).toEqual([
      { member: 'junior', tier: 1, nodes: 2, coveredFor: 0, reviews: 0 },
      { member: 'senior', tier: 4, nodes: 1, coveredFor: 0, reviews: 0 },
    ])
    expect(run.asPlanned).toBe(3)
    expect(run.substituted).toBe(0)
  })

  /**
   * The number to read next to a cost that overran. Every substitution ran at
   * or above the tier the plan budgeted for, so a run can be entirely green and
   * still have been staffed dearer than the roster said.
   */
  it('separates the phases a peer covered from the ones the plan assigned', () => {
    const run = collectRunCrew(
      source([
        claim('p1', { member: 'mid-a', tier: 2, substitute: false }),
        claim('p2', { member: 'mid-b', tier: 2, substitute: true, instead_of: 'mid-a' }),
        claim('p3', { member: 'senior', tier: 4, substitute: true, instead_of: 'mid-a' }),
      ]),
      'r1',
    )

    expect(run.asPlanned).toBe(1)
    expect(run.substituted).toBe(2)
    expect(run.members.find((member) => member.member === 'senior')?.coveredFor).toBe(1)
  })

  /**
   * The two kinds of substitution do not cost the same thing to explain. A
   * peer covering for a busy member is the roster absorbing its own load; a
   * warm promotion is the scheduler choosing to pay a dearer model to avoid a
   * cold start, on a phase that could have run as planned. Folded into one
   * number, a run that promoted everything to the top tier reads as an
   * ordinary busy wave.
   */
  it('counts warm promotions inside the substitutions, not beside them', () => {
    const run = collectRunCrew(
      source([
        claim('p1', { member: 'mid-a', tier: 2, substitute: false }),
        claim('p2', { member: 'mid-b', tier: 2, substitute: true, instead_of: 'mid-a', reason: 'peer_busy' }),
        claim('p3', { member: 'senior', tier: 4, substitute: true, instead_of: 'mid-a', reason: 'warm_session' }),
      ]),
      'r1',
    )

    expect(run.substituted).toBe(2)
    expect(run.warmReuse).toBe(1)
  })

  /**
   * A `substitute` row from before there were two ways to be one. `peer_busy`
   * was the only kind then, so an absent reason is that — never a warm
   * promotion, which is the direction that would invent an overspend.
   */
  it('reads a substitution with no reason as a peer covering, not a promotion', () => {
    const run = collectRunCrew(
      source([claim('p1', { member: 'senior', tier: 4, substitute: true, instead_of: 'mid-a' })]),
      'r1',
    )

    expect(run.substituted).toBe(1)
    expect(run.warmReuse).toBe(0)
  })

  it('names the declared members who took nothing', () => {
    const run = collectRunCrew(
      source([claim('p1', { member: 'junior', tier: 1, substitute: false })]),
      'r1',
      ['junior', 'senior', 'mid-a'],
    )

    expect(run.idle).toEqual(['mid-a', 'senior'])
  })

  it('has nobody idle when the roster all worked', () => {
    const run = collectRunCrew(
      source([
        claim('p1', { member: 'junior', tier: 1, substitute: false }),
        claim('p2', { member: 'senior', tier: 4, substitute: false }),
      ]),
      'r1',
      ['junior', 'senior'],
    )

    expect(run.idle).toEqual([])
  })

  it('is empty for an unstaffed run rather than inventing a member', () => {
    expect(collectRunCrew(source([]), 'r1')).toEqual({
      runId: 'r1',
      members: [],
      asPlanned: 0,
      substituted: 0,
      warmReuse: 0,
      idle: [],
    })
  })

  /**
   * Skipped, not counted as planned. Folding an unreadable row into `asPlanned`
   * would understate substitution — the direction that reads as "the estimate
   * held".
   */
  it('skips a row it cannot read instead of guessing at it', () => {
    const run = collectRunCrew(
      source([
        claim('p1', { member: 'junior', tier: 1, substitute: false }),
        claim('p2', { member: '', tier: 1, substitute: true }),
        claim('p3', { tier: 2, substitute: true }),
        claim('p4', { member: 'mid-a', tier: 'two', substitute: false }),
      ]),
      'r1',
    )

    expect(run.asPlanned).toBe(1)
    expect(run.substituted).toBe(0)
    expect(run.members).toHaveLength(1)
  })

  /** A missing `substitute` is planned work, not a third state. */
  it('treats an absent substitute flag as the plan’s own assignment', () => {
    const run = collectRunCrew(source([claim('p1', { member: 'junior', tier: 1 })]), 'r1')

    expect(run.asPlanned).toBe(1)
    expect(run.members[0]?.coveredFor).toBe(0)
  })
})

/**
 * The seat the fold ignored.
 *
 * `node_crew` is written for both — the reviewer's claim carries
 * `role: 'reviewer'`, the implementer's omits it — and `read()` looked at
 * neither, so a phase a member reviewed was counted as a phase they took. Every
 * run with reviewers reported an inflated node count, in the direction that
 * reads as "more of the roster was used than the plan budgeted".
 */
describe('the two seats a member can fill', () => {
  it('counts a phase reviewed apart from a phase taken', () => {
    const run = collectRunCrew(
      source([
        claim('p1', { member: 'alice', tier: 3, substitute: false }),
        claim('p2', { member: 'alice', tier: 3, substitute: false, role: 'reviewer' }),
        claim('p3', { member: 'alice', tier: 3, substitute: false, role: 'reviewer' }),
      ]),
      'r1',
    )

    // One phase implemented, two reviewed — not three taken.
    expect(run.members).toEqual([
      { member: 'alice', tier: 3, nodes: 1, coveredFor: 0, reviews: 2 },
    ])
    // And the divergence numbers measure staffing against the plan, which named
    // alice for `p1` and for nothing else.
    expect(run.asPlanned).toBe(1)
    expect(run.substituted).toBe(0)
  })

  /**
   * The case that decides this is a fix and not a second bug. `idle` means
   * "declared but never reached", and a member who reviewed six phases has been
   * reached. Dropping reviewer rows from the fold entirely would have moved the
   * inflation from one number into a plain falsehood in another.
   */
  it('does not report a member who only reviewed as idle', () => {
    const run = collectRunCrew(
      source([
        claim('p1', { member: 'alice', tier: 3, substitute: false }),
        claim('p1', { member: 'bob', tier: 4, substitute: false, role: 'reviewer' }),
      ]),
      'r1',
      ['alice', 'bob', 'carol'],
    )

    expect(run.idle).toEqual(['carol'])
    expect(run.members.find((m) => m.member === 'bob')).toEqual({
      member: 'bob',
      tier: 4,
      nodes: 0,
      coveredFor: 0,
      reviews: 1,
    })
  })

  /** An explicit `implementer` says what an absent role already meant. */
  it('reads an explicit implementer role the same as an absent one', () => {
    const run = collectRunCrew(
      source([
        claim('p1', { member: 'alice', tier: 2, substitute: false, role: 'implementer' }),
        claim('p2', { member: 'alice', tier: 2, substitute: false }),
      ]),
      'r1',
    )

    expect(run.members[0]).toEqual({
      member: 'alice',
      tier: 2,
      nodes: 2,
      coveredFor: 0,
      reviews: 0,
    })
  })

  /**
   * A reviewer claim carries `substitute: false` always, so folding the seats
   * together did not corrupt `substituted` — but it did corrupt `asPlanned`,
   * which is the denominator the run view divides by.
   */
  it('keeps reviewer claims out of the plan-versus-outcome counts', () => {
    const run = collectRunCrew(
      source([
        claim('p1', { member: 'mid-a', tier: 2, substitute: false }),
        claim('p2', { member: 'senior', tier: 4, substitute: true, instead_of: 'mid-a' }),
        claim('p1', { member: 'senior', tier: 4, substitute: false, role: 'reviewer' }),
        claim('p2', { member: 'mid-a', tier: 2, substitute: false, role: 'reviewer' }),
      ]),
      'r1',
    )

    // Two phases, one covered. The two reviews are not phases and are not in it.
    expect(run.asPlanned).toBe(1)
    expect(run.substituted).toBe(1)
    expect(run.asPlanned + run.substituted).toBe(2)
  })

  /**
   * A row from a newer daemon naming a seat this build has never heard of keeps
   * its member visible rather than vanishing them into `idle`. `SEATS` in
   * `crew.ts` is what stops that tolerance being a slow leak back into the bug
   * above: adding a seat to `CrewRole` fails its `satisfies` and forces the
   * choice to be made deliberately.
   */
  it('keeps a member whose seat this build does not recognise', () => {
    const run = collectRunCrew(
      source([claim('p1', { member: 'alice', tier: 3, substitute: false, role: 'archivist' })]),
      'r1',
      ['alice'],
    )

    expect(run.idle).toEqual([])
    expect(run.members[0]?.member).toBe('alice')
  })
})
