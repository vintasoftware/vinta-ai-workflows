/**
 * The analytics page and the run view's time panel (§13.3), and the report
 * the page carries once the run has ended (§13.6).
 *
 * The stub serves the report the daemon would; what is under test is the
 * fold in the browser — buckets, filters, groups — and that an open activity
 * is timed against the page's own clock rather than shown as nothing.
 */
import { cleanup, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { activity, analyticsNode, node, postMortem, RUN_ID, runAnalytics, runSummary, snapshot, T0 } from './fixtures.ts'
import { renderApp, textOf } from './render-app.tsx'
import { startStubDaemon, type StubDaemon } from './stub-daemon.ts'

const ROUTE = `#/runs/${RUN_ID}/analytics`

let daemon: StubDaemon | null = null

afterEach(async () => {
  cleanup()
  sessionStorage.clear()
  await daemon?.close()
  daemon = null
})

const MIN = 60_000

/** Two phases on two harnesses, one still working. */
const twoPhases = () =>
  runAnalytics({
    nodes: [
      analyticsNode('impl', {
        split: { spanMs: 10 * MIN, laneQueueMs: 2 * MIN, workingMs: 8 * MIN, capacityWaitMs: 0, suspendedMs: 0, gatePoolQueueMs: 0, gateRunMs: 3 * MIN },
      }),
      analyticsNode('docs', { harness: 'codex', model: 'gpt-5', crew: 'junior', tier: 3, status: 'done', inFlight: false, finishedAt: T0 + 6 * MIN }),
    ],
    activities: [
      activity({ node: 'impl', id: 'implement', startedAt: T0, endedAt: T0 + 5 * MIN }),
      activity({ node: 'impl', id: 'gate', startedAt: T0 + 5 * MIN, endedAt: T0 + 8 * MIN }),
      activity({ node: 'impl', kind: 'gate', id: 'unit', startedAt: T0 + 5 * MIN, endedAt: T0 + 8 * MIN, outcome: 'passed' }),
      activity({ node: 'impl', kind: 'gate', id: 'unit', startedAt: T0 + 8 * MIN, endedAt: T0 + 8 * MIN, outcome: 'passed', cached: true }),
      // Still going: no end, timed against the page's clock.
      activity({ node: 'impl', id: 'review', startedAt: T0 + 8 * MIN, endedAt: null }),
      activity({ node: 'docs', harness: 'codex', model: 'gpt-5', crew: 'junior', tier: 3, id: 'implement', startedAt: T0, endedAt: T0 + 4 * MIN }),
      activity({ node: 'docs', harness: 'codex', model: 'gpt-5', crew: 'junior', tier: 3, kind: 'chore', id: 'review', startedAt: T0 + 4 * MIN, endedAt: T0 + 6 * MIN, outcome: 'ran' }),
    ],
    criticalPath: [{ nodeId: 'impl', wave: 1, gapMs: 0, startedAt: T0, endsAt: T0 + 2 * MIN, split: analyticsNode('impl').split }],
  })

test('the run view sums working time by bucket and links to the page', async () => {
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: { [RUN_ID]: snapshot({ nodes: [node('impl', 'running')] }) },
    analytics: { [RUN_ID]: twoPhases() },
  })
  daemon = stub
  const { container } = renderApp(stub, `#/runs/${RUN_ID}`)

  await waitFor(() => expect(container.querySelector('[data-time-panel] [data-time-split]')).not.toBe(null))
  const buckets = [...container.querySelectorAll('[data-time-panel] [data-bucket]')]
  expect(buckets.map((bucket) => bucket.getAttribute('data-bucket'))).toEqual(['Implementation', 'Gates', 'Review'])
  // 5m + 4m of implementation, 3m of gates.
  expect(buckets[0]?.querySelector('[data-bucket-ms]')?.textContent).toBe('9m 00s')
  expect(buckets[1]?.querySelector('[data-bucket-ms]')?.textContent).toBe('3m 00s')
  expect(textOf(container, '[data-time-panel] [data-waiting-split]')).toContain('2m 00s for a lane')
  expect(container.querySelector('[data-time-panel] a[data-action="open-analytics"]')?.getAttribute('href')).toBe(ROUTE)
  expect(container.querySelector('a[data-action="analytics"]')?.textContent).toContain('Analytics')
})

test('the page filters by harness and groups by what was asked', async () => {
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: { [RUN_ID]: snapshot({ nodes: [node('impl', 'running'), node('docs', 'done')] }) },
    analytics: { [RUN_ID]: twoPhases() },
  })
  daemon = stub
  const { container } = renderApp(stub, ROUTE)

  await waitFor(() => expect(container.querySelector('[data-breakdown] [data-group="impl"]')).not.toBe(null))
  // One row per phase, the busiest first.
  expect([...container.querySelectorAll('[data-breakdown] [data-group]')].map((row) => row.getAttribute('data-group'))).toEqual([
    'impl',
    'docs',
  ])
  expect(textOf(container, '[data-group="docs"] [data-working]')).toBe('4m 00s')
  // Gates and chores are their own tables: the cached verdict is counted, not timed.
  expect(textOf(container, '[data-gates-table] [data-tally="unit"]')).toContain('2')
  expect(textOf(container, '[data-gates-table] [data-tally="unit"]')).toContain('1 cached')
  expect(textOf(container, '[data-gates-table] [data-tally="unit"] [data-tally-ms]')).toBe('3m 00s')
  expect(textOf(container, '[data-chores-table] [data-tally="review"] [data-tally-ms]')).toBe('2m 00s')

  // Group by harness: two rows, each with its phase count.
  fireEvent.click(container.querySelector('[data-breakdown] [role="tab"][data-tab="harness"]') as Element)
  await waitFor(() => expect(container.querySelector('[data-breakdown] [data-group="codex"]')).not.toBe(null))
  expect(textOf(container, '[data-group="codex"] [data-working]')).toBe('4m 00s')

  // Filter to codex: impl's work disappears from every figure.
  const select = container.querySelector('select[data-filter="harness"]') as HTMLSelectElement
  fireEvent.change(select, { target: { value: 'codex' } })
  await waitFor(() => expect(container.querySelector('[data-breakdown] [data-group="claude-code"]')).toBe(null))
  expect(container.querySelector('[data-gates-table] [data-tally="unit"]')).toBe(null)
  expect([...container.querySelectorAll('[data-time-panel] [data-bucket]')].map((bucket) => bucket.getAttribute('data-bucket'))).toEqual([
    'Implementation',
  ])
  expect(container.querySelector('[data-action="clear-filters"]')).not.toBe(null)
})

test('an activity still in progress is timed against the clock, not shown as nothing', async () => {
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: { [RUN_ID]: snapshot({ nodes: [node('impl', 'running')] }) },
    analytics: {
      [RUN_ID]: runAnalytics({
        activities: [activity({ id: 'implement', startedAt: Date.now() - 90_000, endedAt: null })],
      }),
    },
  })
  daemon = stub
  const { container } = renderApp(stub, ROUTE)

  await waitFor(() => expect(container.querySelector('[data-bucket="Implementation"]')).not.toBe(null))
  const shown = textOf(container, '[data-bucket="Implementation"] [data-bucket-ms]')
  expect(shown).toMatch(/^1m (2|3)\d/)
  expect(container.querySelector('[data-bucket="Implementation"] [aria-label="in progress"]')).not.toBe(null)
})

test('a finished run leads with its report, and the run view offers it by name', async () => {
  const stub = await startStubDaemon({
    runs: [runSummary({ status: 'done', endedAt: T0 + 3_600_000 })],
    snapshots: {
      [RUN_ID]: snapshot({
        run: runSummary({ status: 'done', endedAt: T0 + 3_600_000 }),
        nodes: [node('impl', 'done'), node('docs', 'done')],
      }),
    },
    analytics: { [RUN_ID]: runAnalytics({ status: 'done', partial: false, endedAt: T0 + 3_600_000 }) },
    postmortems: {
      [RUN_ID]: postMortem(
        {},
        {
          wave_conflicts: [{ wave: 2, nodes: ['impl', 'docs'], paths: ['src/billing.ts'], fix_rounds: 2 }],
          gate_costs: [
            { gate: 'unit', runs: 6, cached_runs: 2, ran_ms: 1_500_000, slowest_ms: 400_000, cache_saved_ms: 300_000, failed_runs: 1, timed_out_runs: 0 },
          ],
          critical_path: { nodes: [{ node: 'impl', wave: 1, span_ms: 3_000_000 }], span_ms: 3_000_000, share_of_elapsed: 0.83 },
          idle_capacity: { lane_capacity: 4, peak_concurrency: 2, lane_ms_provisioned: 14_400_000, lane_ms_used: 5_000_000, idle_share: 0.65 },
        },
      ),
    },
  })
  daemon = stub

  const run = renderApp(stub, `#/runs/${RUN_ID}`)
  await waitFor(() => expect(run.container.querySelector('a[data-action="analytics"]')).not.toBe(null))
  expect(run.container.querySelector('a[data-action="analytics"]')?.textContent).toContain('Report')
  run.unmount()

  const { container } = renderApp(stub, ROUTE)
  await waitFor(() => expect(container.querySelector('[data-report="ready"]')).not.toBe(null))
  expect(textOf(container, '[data-critical-share]')).toContain('83%')
  expect(textOf(container, '[data-idle-share]')).toContain('65%')
  const diagnosis = textOf(container, '[data-diagnosis]')
  expect(diagnosis).toContain('One chain set the clock: impl')
  expect(diagnosis).toContain('impl and docs fought over 1 path at wave 2')
  expect(diagnosis).toContain('Gate unit alone ran for 25m 00s')
  expect(textOf(container, '[data-finding="conflicts"]')).toContain('src/billing.ts')
  expect(textOf(container, '[data-finding="gates"] [data-gate-cost="unit"]')).toContain('2 cached')
  expect(textOf(container, '[data-finding="failures"]')).toContain('No attempt failed.')
})

test('a finished run that wrote no post-mortem says so rather than inventing one', async () => {
  const stub = await startStubDaemon({
    runs: [runSummary({ status: 'cancelled', endedAt: T0 + 100 })],
    snapshots: { [RUN_ID]: snapshot({ run: runSummary({ status: 'cancelled', endedAt: T0 + 100 }), nodes: [node('impl', 'failed')] }) },
    analytics: { [RUN_ID]: runAnalytics({ status: 'cancelled', partial: false, endedAt: T0 + 100 }) },
  })
  daemon = stub
  const { container } = renderApp(stub, ROUTE)

  await waitFor(() => expect(container.querySelector('[data-report="none"]')).not.toBe(null))
  expect(textOf(container, '[data-report="none"]')).toContain('this one is cancelled')
})
