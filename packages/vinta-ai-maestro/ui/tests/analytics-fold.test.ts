/**
 * The browser-side folds behind the analytics page (`analytics.ts`): buckets
 * partition step time, nested activities stay out of it, open rows are timed
 * against `now`, and groups sum what their phases did.
 */
import { expect, test } from 'vitest'
import { bucketOf, byBucket, groupRows, NO_FILTERS, tally } from '../src/analytics.ts'
import { activity, analyticsNode, runAnalytics, T0 } from './fixtures.ts'

const MIN = 60_000

test('states fold into the pipeline buckets, and a custom state keeps its name', () => {
  expect(['implement', 'fix', 'gate', 'verify', 'review', 'unapproved', 'polish', 'integrate', 'smoke'].map(bucketOf)).toEqual([
    'Implementation',
    'Implementation',
    'Gates',
    'Gates',
    'Review',
    'Review',
    'Polish',
    'Integration',
    'smoke',
  ])
})

test('buckets sum steps only, in pipeline order, timing an open step against now', () => {
  const rows = [
    activity({ id: 'gate', startedAt: T0 + 5 * MIN, endedAt: T0 + 8 * MIN }),
    activity({ id: 'implement', startedAt: T0, endedAt: T0 + 5 * MIN }),
    activity({ kind: 'gate', id: 'unit', startedAt: T0 + 5 * MIN, endedAt: T0 + 8 * MIN, outcome: 'passed' }),
    activity({ id: 'fix', startedAt: T0 + 8 * MIN, endedAt: null }),
  ]
  const buckets = byBucket(rows, T0 + 10 * MIN)
  expect(buckets.map((bucket) => [bucket.key, bucket.ms, bucket.open])).toEqual([
    ['Implementation', 7 * MIN, 1],
    ['Gates', 3 * MIN, 0],
  ])
})

test('a tally counts a cached verdict without timing it, and keeps the slowest run', () => {
  const rows = [
    activity({ kind: 'gate', id: 'unit', startedAt: T0, endedAt: T0 + 2 * MIN, outcome: 'passed' }),
    activity({ kind: 'gate', id: 'unit', startedAt: T0 + 3 * MIN, endedAt: T0 + 4 * MIN, outcome: 'failed' }),
    activity({ kind: 'gate', id: 'unit', startedAt: T0 + 5 * MIN, endedAt: T0 + 5 * MIN, outcome: 'passed', cached: true }),
  ]
  const [unit] = tally(rows, (row) => row.id, T0 + 6 * MIN)
  expect(unit).toMatchObject({ key: 'unit', ms: 3 * MIN, count: 3, slowestMs: 2 * MIN, cached: 1 })
  expect([...(unit?.outcomes ?? [])]).toEqual([
    ['passed', 2],
    ['failed', 1],
  ])
})

test('groups sum their phases’ work and waiting, busiest first', () => {
  const report = runAnalytics({
    nodes: [
      analyticsNode('a', { harness: 'codex', split: { spanMs: 0, laneQueueMs: MIN, workingMs: 0, capacityWaitMs: 0, suspendedMs: 2 * MIN, gatePoolQueueMs: 0, gateRunMs: 0 } }),
      analyticsNode('b', { harness: 'claude-code' }),
      analyticsNode('c', { harness: 'claude-code', inFlight: false, status: 'done' }),
    ],
    activities: [
      activity({ node: 'a', harness: 'codex', id: 'implement', startedAt: T0, endedAt: T0 + MIN }),
      activity({ node: 'b', id: 'implement', startedAt: T0, endedAt: T0 + 3 * MIN }),
      activity({ node: 'b', id: 'integrate', startedAt: T0 + 3 * MIN, endedAt: T0 + 4 * MIN }),
      activity({ node: 'c', kind: 'chore', id: 'review', startedAt: T0, endedAt: T0 + 2 * MIN, outcome: 'ran' }),
      activity({ node: 'c', id: 'review', startedAt: T0, endedAt: T0 + 2 * MIN }),
    ],
  })
  const groups = groupRows(report, NO_FILTERS, 'harness', T0 + 10 * MIN)
  expect(groups.map((group) => [group.key, group.nodes, group.workingMs, group.implementationMs, group.choresMs, group.integrationMs, group.waitingMs])).toEqual([
    ['claude-code', 2, 6 * MIN, 3 * MIN, 2 * MIN, MIN, 0],
    ['codex', 1, MIN, MIN, 0, 0, 3 * MIN],
  ])
  const byNode = groupRows(report, { ...NO_FILTERS, harness: 'codex' }, 'node', T0 + 10 * MIN)
  expect(byNode.map((group) => group.key)).toEqual(['a'])
})
