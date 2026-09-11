/**
 * The run-level reuse rollup (§15.6).
 *
 * The counts exist to answer one question — "did reuse actually engage" — and
 * the ways they can lie are the tests worth writing: a share that reads 0% for
 * a run that never asked for reuse, a reason tally that drops a token the
 * daemon learned after the browser did, an unreadable row inflating the cold
 * count. Each of those looks like a plausible number rather than an error,
 * which is why none of them can be left to an end-to-end run to notice.
 */
import { describe, expect, it } from 'vitest'

import type { StoredEvent } from '../src/journal/events.ts'
import {
  collectRunReuse,
  reuseShare,
  sumReuse,
  type ReuseSource,
  type ReuseTotals,
} from '../src/usage/reuse.ts'

let nextId = 0

/** One journalled decision, in the shape the journal reads back off disk. */
function decision(
  nodeId: string,
  disposition: 'reused' | 'fresh',
  extra: Record<string, unknown> = {},
): StoredEvent {
  nextId += 1
  return {
    id: nextId,
    ts: 1_000 + nextId,
    runId: 'r1',
    nodeId,
    type: 'node_session',
    payload: { slot: 'main', disposition, ...extra },
  } as StoredEvent
}

const source = (events: readonly StoredEvent[]): ReuseSource => ({
  sessionDecisions: () => events,
})

describe('collectRunReuse', () => {
  it('counts turns and continuations across every node', () => {
    const run = collectRunReuse(
      source([
        decision('p1', 'fresh', { reason: 'no_prior_session' }),
        decision('p1', 'reused'),
        decision('p2', 'fresh', { reason: 'no_prior_session' }),
        decision('p2', 'reused'),
        decision('p2', 'reused'),
      ]),
      'r1',
    )

    expect(run.totals.turns).toBe(5)
    expect(run.totals.reused).toBe(3)
    expect(run.nodes.map((node) => [node.nodeId, node.totals.reused, node.totals.turns])).toEqual([
      ['p1', 1, 2],
      ['p2', 2, 3],
    ])
  })

  it('tallies why the cold turns were cold, commonest first', () => {
    const run = collectRunReuse(
      source([
        decision('p1', 'fresh', { reason: 'no_prior_session' }),
        decision('p2', 'fresh', { reason: 'no_prior_session' }),
        decision('p3', 'fresh', { reason: 'final_fix_round' }),
        decision('p1', 'fresh', { reason: 'no_prior_session' }),
        decision('p2', 'fresh', { reason: 'stale_session' }),
      ]),
      'r1',
    )

    expect(run.totals.fresh).toEqual([
      { reason: 'no_prior_session', count: 3 },
      { reason: 'final_fix_round', count: 1 },
      { reason: 'stale_session', count: 1 },
    ])
    // The tally accounts for every cold turn and no others.
    const cold = run.totals.fresh.reduce((sum, entry) => sum + entry.count, 0)
    expect(cold).toBe(run.totals.turns - run.totals.reused)
  })

  it('counts a reason it has never heard of', () => {
    // The failure this rollup exists to surface is reuse quietly stopping. A
    // counter with one field per known token would drop the very row that says
    // a *new* thing started stopping it.
    const run = collectRunReuse(source([decision('p1', 'fresh', { reason: 'invented_later' })]), 'r1')

    expect(run.totals.fresh).toEqual([{ reason: 'invented_later', count: 1 }])
  })

  it('keeps a cold turn that states no reason, as a turn without an explanation', () => {
    const run = collectRunReuse(source([decision('p1', 'fresh')]), 'r1')

    expect([run.totals.turns, run.totals.reused]).toEqual([1, 0])
    expect(run.totals.fresh).toEqual([{ reason: 'unstated', count: 1 }])
  })

  it('skips a row it cannot read rather than counting it cold', () => {
    // These come back off disk. Turning an unreadable row into a cold turn
    // would understate reuse, which is the direction that reads as a bug.
    const broken = { ...decision('p1', 'fresh'), payload: { slot: 'main' } } as StoredEvent
    const run = collectRunReuse(source([broken, decision('p1', 'reused')]), 'r1')

    expect([run.totals.turns, run.totals.reused]).toEqual([1, 1])
  })

  it('reports nothing for a run that recorded no decisions', () => {
    const run = collectRunReuse(source([]), 'r1')

    expect(run.totals).toEqual({ turns: 0, reused: 0, fresh: [] })
    expect(run.nodes).toEqual([])
  })
})

describe('reuseShare', () => {
  it('is the fraction of turns that continued a session', () => {
    const run = collectRunReuse(
      source([decision('p1', 'reused'), decision('p1', 'reused'), decision('p1', 'fresh')]),
      'r1',
    )

    expect(reuseShare(run.totals)).toBeCloseTo(2 / 3)
  })

  it('is undefined, never zero, for a run that asked for no reuse', () => {
    // A pipeline that names no slots records no decisions. Reporting 0% would
    // say a feature broke; it was never switched on. Only this layer can still
    // tell the two apart, so it must not flatten them (§15.6).
    expect(reuseShare(collectRunReuse(source([]), 'r1').totals)).toBeUndefined()
  })

  it('is zero when reuse was asked for and never happened', () => {
    const run = collectRunReuse(
      source([decision('p1', 'fresh', { reason: 'no_resume_capability' })]),
      'r1',
    )

    expect(reuseShare(run.totals)).toBe(0)
  })
})

describe('sumReuse', () => {
  it('adds tallies and merges their reasons', () => {
    const a: ReuseTotals = { turns: 3, reused: 1, fresh: [{ reason: 'no_prior_session', count: 2 }] }
    const b: ReuseTotals = {
      turns: 2,
      reused: 0,
      fresh: [
        { reason: 'no_prior_session', count: 1 },
        { reason: 'stale_session', count: 1 },
      ],
    }

    expect(sumReuse([a, b])).toEqual({
      turns: 5,
      reused: 1,
      fresh: [
        { reason: 'no_prior_session', count: 3 },
        { reason: 'stale_session', count: 1 },
      ],
    })
  })

  it('sums to nothing over an empty list', () => {
    expect(sumReuse([])).toEqual({ turns: 0, reused: 0, fresh: [] })
  })
})
