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
      { member: 'junior', tier: 1, nodes: 2, coveredFor: 0 },
      { member: 'senior', tier: 4, nodes: 1, coveredFor: 0 },
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
