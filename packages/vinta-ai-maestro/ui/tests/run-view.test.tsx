import { cleanup, waitFor } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import {
  harness,
  leaseEvent,
  node,
  resource,
  RUN_ID,
  runSummary,
  runUsage,
  snapshot,
  statusEvent,
} from './fixtures.ts'
import { cardColorOf, cardLabelOf, renderApp, textOf, toneOf } from './render-app.tsx'
import { startStubDaemon, type StubDaemon } from './stub-daemon.ts'

const RUN_ROUTE = `#/runs/${RUN_ID}`

let daemon: StubDaemon | null = null

afterEach(async () => {
  cleanup()
  sessionStorage.clear()
  await daemon?.close()
  daemon = null
})

test('the graph reflects every node-status transition delivered over the stream', async () => {
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: { [RUN_ID]: snapshot({ nodes: [node('impl', 'pending'), node('review', 'pending', 1)] }) },
  })
  daemon = stub
  const { container } = renderApp(stub, RUN_ROUTE)

  await waitFor(() => expect(cardColorOf(container, 'impl')).toBe('var(--vdag-status-pending)'))

  // Every transition, one frame at a time: the canvas is a projection of the
  // stream, so each one has to land on its own rather than being collapsed.
  for (const status of ['running', 'waiting_on_capacity', 'awaiting_human', 'done'] as const) {
    stub.emit(statusEvent('impl', status))
    await waitFor(() => expect(cardColorOf(container, 'impl')).toBe(`var(--vdag-status-${status})`))
    expect(toneOf(container, 'impl')).not.toBe(null)
  }

  stub.emit(statusEvent('review', 'running'))
  await waitFor(() => expect(cardColorOf(container, 'review')).toBe('var(--vdag-status-running)'))
  // The snapshot still says `pending` for both; the fold is what moved them.
  expect(cardColorOf(container, 'impl')).toBe('var(--vdag-status-done)')
})

test('a node waiting on capacity reads as waiting, not as a failure', async () => {
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: { [RUN_ID]: snapshot({ nodes: [node('impl', 'pending'), node('docs', 'pending')] }) },
  })
  daemon = stub
  const { container } = renderApp(stub, RUN_ROUTE)
  await waitFor(() => expect(container.querySelector('tr[data-node="impl"]')).not.toBe(null))

  stub.emit(statusEvent('impl', 'waiting_on_capacity'), statusEvent('docs', 'failed'))
  await waitFor(() => expect(cardColorOf(container, 'impl')).toBe('var(--vdag-status-waiting_on_capacity)'))
  expect(toneOf(container, 'impl')).toBe('wait')

  // §6.1: backpressure is not failure. The two must not share a tone, a colour
  // or a word, or the operator kills a run that was going to recover.
  expect(toneOf(container, 'docs')).toBe('error')
  expect(toneOf(container, 'impl')).not.toBe(toneOf(container, 'docs'))
  expect(cardColorOf(container, 'impl')).toBe('var(--vdag-status-waiting_on_capacity)')
  expect(cardColorOf(container, 'docs')).toBe('var(--vdag-status-failed)')
  expect(cardColorOf(container, 'impl')).not.toBe(cardColorOf(container, 'docs'))
  expect(cardLabelOf(container, 'impl')).toContain('Waiting on capacity')
  expect(cardLabelOf(container, 'docs')).toContain('Failed')
})

test('a harness parked on a quota window reads as waiting, not as a failure', async () => {
  const wakeAt = Date.now() + 90_000
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: {
      [RUN_ID]: snapshot({
        nodes: [node('impl', 'waiting_on_capacity')],
        harnesses: [harness('claude-code', 3, 3, wakeAt), harness('codex', 2, 1)],
      }),
    },
  })
  daemon = stub
  const { container } = renderApp(stub, RUN_ROUTE)

  await waitFor(() => expect(textOf(container, '[data-harness="claude-code"]')).toContain('3 / 3'))
  const parked = container.querySelector('[data-harness="claude-code"] .chip')
  expect(parked?.getAttribute('data-tone')).toBe('wait')
  expect(parked?.textContent).toContain('waiting on capacity')
  expect(
    container.querySelector('[data-harness="codex"] .chip')?.getAttribute('data-tone'),
  ).toBe('ok')
})

test('pool occupancy and the gate queue update live', async () => {
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: {
      [RUN_ID]: snapshot({
        nodes: [node('impl', 'running')],
        resources: [resource('test-suite', 2, 0)],
      }),
    },
  })
  daemon = stub
  const { container } = renderApp(stub, RUN_ROUTE)
  await waitFor(() =>
    expect(textOf(container, '[data-resource="test-suite"] [data-occupancy]')).toBe('0 / 2'),
  )
  expect(textOf(container, '[data-waiting]')).toBe('0 waiting')

  // Pools are live scheduler state, not journalled facts: the daemon's next
  // snapshot carries them, and the frame is what says to go and read it.
  stub.setSnapshot(
    RUN_ID,
    snapshot({
      nodes: [node('impl', 'running'), node('review', 'pending')],
      resources: [resource('test-suite', 2, 2, ['impl', 'review'])],
      gateQueue: {
        waiting: 3,
        holders: [{ resource: 'test-suite', nodeId: 'impl', acquiredAt: Date.now() - 12_000 }],
      },
    }),
  )
  stub.emit(statusEvent('review', 'pending'))

  await waitFor(() =>
    expect(textOf(container, '[data-resource="test-suite"] [data-occupancy]')).toBe('2 / 2'),
  )
  expect(textOf(container, '[data-waiting]')).toBe('3 waiting')
  expect(container.querySelector('[data-waiting] .chip')?.getAttribute('data-tone')).toBe('wait')
  expect(textOf(container, '[data-holder="impl"]')).toContain('impl holds test-suite')
})

/**
 * The same panel, moved by the agent's own lease rather than by something
 * else that happened to be journalled at the same time.
 *
 * The test above emits a `node_status` to make the snapshot be re-read, which
 * is how this panel used to update at all: an agent taking a semaphore wrote a
 * `leases` row and nothing else, so the holders on screen were whatever they
 * had been the last time an unrelated event arrived. Here the lease event is
 * the only traffic on the socket, and the panel still has to follow it — no
 * new polling, and no new handling in the projection, which folds node status
 * and nothing else.
 */
test('an agent taking and dropping a lease moves the panel on its own', async () => {
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: {
      [RUN_ID]: snapshot({
        nodes: [node('impl', 'running')],
        resources: [resource('test-suite', 1, 0)],
      }),
    },
  })
  daemon = stub
  const { container } = renderApp(stub, RUN_ROUTE)
  await waitFor(() =>
    expect(textOf(container, '[data-resource="test-suite"] [data-occupancy]')).toBe('0 / 1'),
  )

  stub.setSnapshot(
    RUN_ID,
    snapshot({
      nodes: [node('impl', 'running')],
      resources: [resource('test-suite', 1, 1, ['impl'])],
      gateQueue: {
        waiting: 1,
        holders: [{ resource: 'test-suite', nodeId: 'impl', acquiredAt: Date.now() }],
      },
    }),
  )
  stub.emit(leaseEvent('impl', 'acquired', ['test-suite']))

  await waitFor(() =>
    expect(textOf(container, '[data-resource="test-suite"] [data-occupancy]')).toBe('1 / 1'),
  )
  expect(textOf(container, '[data-holder="impl"]')).toContain('impl holds test-suite')
  expect(textOf(container, '[data-waiting]')).toBe('1 waiting')

  // And back again on release, which is the half that makes a queue look like
  // it is draining rather than wedged.
  stub.setSnapshot(
    RUN_ID,
    snapshot({
      nodes: [node('impl', 'running')],
      resources: [resource('test-suite', 1, 0)],
    }),
  )
  stub.emit(leaseEvent('impl', 'released', ['test-suite']))

  await waitFor(() =>
    expect(textOf(container, '[data-resource="test-suite"] [data-occupancy]')).toBe('0 / 1'),
  )
  expect(textOf(container, '[data-waiting]')).toBe('0 waiting')
  expect(container.textContent).toContain('No gate held.')

  // The node is untouched by all of it: a lease is capacity, not status, and
  // the graph must not have invented a transition from these frames.
  expect(cardColorOf(container, 'impl')).toBe('var(--vdag-status-running)')
  // One socket, and every event went down it — no second connection, and
  // nothing here added a timer.
  expect(stub.connections).toHaveLength(1)
})

test('a run with no nodes and no events renders', async () => {
  const stub = await startStubDaemon({
    runs: [runSummary({ workflowId: 'empty' })],
    snapshots: { [RUN_ID]: snapshot() },
  })
  daemon = stub
  const { container } = renderApp(stub, RUN_ROUTE)

  await waitFor(() => expect(container.textContent).toContain('No nodes registered yet.'))
  expect(container.textContent).toContain('No pools declared.')
  expect(container.textContent).toContain('No harness in use.')
  expect(container.textContent).toContain('No gate held.')
  await waitFor(() => expect(stub.connections).toHaveLength(1))
  expect(stub.connections[0]?.sent).toEqual([])
})

// ---------------------------------------------------------------------------
// §15.6: the run-level rollup
// ---------------------------------------------------------------------------

const oneNode = () => ({
  runs: [runSummary()],
  snapshots: { [RUN_ID]: snapshot({ nodes: [node('impl', 'running')] }) },
})

test('the rollup states what reuse engaged and what the prompts cost', async () => {
  const stub = await startStubDaemon({ ...oneNode(), usage: { [RUN_ID]: runUsage() } })
  daemon = stub
  const { container } = renderApp(stub, RUN_ROUTE)

  await waitFor(() => expect(container.querySelector('[data-reuse]')).not.toBe(null))

  // 5 of 8 turns continued a session.
  expect(textOf(container, '[data-reuse]')).toContain('63% of 8 turns')
  // 61,000 of 100,000 prompt tokens came off the cache.
  expect(textOf(container, '[data-cache]')).toContain('61%')
  expect(textOf(container, '[data-tokens]')).toContain('12.4k in')
  expect(textOf(container, '[data-tokens]')).toContain('3.1k out')
  expect(textOf(container, '[data-cost]')).toContain('$1.42')

  // And why the cold turns were cold, commonest first — under a label, because
  // a column of bare counts directly beneath the cost rows reads as more cost.
  expect(textOf(container, '.fresh-head')).toContain('Cold turns')
  const reasons = [...container.querySelectorAll('[data-fresh-reason]')].map((row) =>
    row.getAttribute('data-fresh-reason'),
  )
  expect(reasons).toEqual(['no_prior_session', 'final_fix_round'])
})

test('a harness that reports no cost gives an unknown bill, never a free one', async () => {
  // The §15.6 rule where it is most likely to be broken: a `?? 0` in the view
  // would render a confident $0.00 for a run nobody has been billed for yet.
  const stub = await startStubDaemon({
    ...oneNode(),
    usage: {
      [RUN_ID]: runUsage({
        cost: { status: 'unreported', missingSessions: 4 },
        cache: { status: 'unreported', missingSessions: 4 },
      }),
    },
  })
  daemon = stub
  const { container } = renderApp(stub, RUN_ROUTE)

  await waitFor(() => expect(container.querySelector('[data-cost]')).not.toBe(null))

  expect(textOf(container, '[data-cost]')).toContain('Not reported')
  expect(textOf(container, '[data-cost]')).not.toContain('$')
  expect(textOf(container, '[data-cache]')).toContain('Not reported')
  expect(textOf(container, '[data-cache]')).not.toContain('0%')
})

test('a partial cost says so, and names how many sessions are missing', async () => {
  const stub = await startStubDaemon({
    ...oneNode(),
    usage: {
      [RUN_ID]: runUsage({
        cost: { status: 'partial', usdSoFar: 0.8, reportedSessions: 5, missingSessions: 3 },
      }),
    },
  })
  daemon = stub
  const { container } = renderApp(stub, RUN_ROUTE)

  await waitFor(() => expect(container.querySelector('[data-cost]')).not.toBe(null))

  // A floor, and labelled as one — the run cost at least this much.
  expect(textOf(container, '[data-cost]')).toContain('$0.80 so far')
  expect(textOf(container, '[data-cost]')).toContain('3 of 8')
})

test('a run that asked for no reuse says so, rather than reporting 0%', async () => {
  // A pipeline naming no session slots records no decisions. "0%" would read
  // as a feature that broke; it was never switched on (§15.6).
  const stub = await startStubDaemon({
    ...oneNode(),
    usage: { [RUN_ID]: runUsage({ reuse: { turns: 0, reused: 0, fresh: [] } }) },
  })
  daemon = stub
  const { container } = renderApp(stub, RUN_ROUTE)

  await waitFor(() => expect(container.querySelector('[data-reuse]')).not.toBe(null))

  expect(textOf(container, '[data-reuse]')).toContain('No agent turn asked to continue')
  expect(textOf(container, '[data-reuse]')).not.toContain('0%')
  expect(container.querySelector('[data-fresh-reason]')).toBe(null)
})

test('the rollup names who worked, and flags the phases a peer covered', async () => {
  const stub = await startStubDaemon({
    ...oneNode(),
    usage: {
      [RUN_ID]: runUsage({
        crew: {
          members: [
            { member: 'junior', tier: 1, nodes: 2, coveredFor: 0 },
            { member: 'senior', tier: 4, nodes: 3, coveredFor: 1 },
          ],
          asPlanned: 4,
          substituted: 1,
          idle: ['mid-a'],
        },
      }),
    },
  })
  daemon = stub
  const { container } = renderApp(stub, RUN_ROUTE)

  await waitFor(() => expect(container.querySelector('[data-crew-member]')).not.toBe(null))

  expect(textOf(container, '[data-crew-member="junior"]')).toContain('tier 1')
  // The number that matters next to the cost: a covered phase ran at or above
  // the tier the plan budgeted for.
  expect(textOf(container, '[data-crew-member="senior"]')).toContain('1 covering')
  expect(textOf(container, '.crew-head')).toContain('1 of 5 phases covered')
  // A declared member with nothing yet is "not reached", not "overstaffed" —
  // a validated workflow cannot declare one nobody is assigned to.
  expect(textOf(container, '[data-crew-idle="mid-a"]')).toContain('not reached')
})

test('an unstaffed run shows no crew panel at all', async () => {
  // Every workflow written before rosters existed. An empty list would read as
  // a roster that lost its members.
  const stub = await startStubDaemon({ ...oneNode(), usage: { [RUN_ID]: runUsage() } })
  daemon = stub
  const { container } = renderApp(stub, RUN_ROUTE)

  await waitFor(() => expect(container.querySelector('[data-reuse]')).not.toBe(null))

  expect(container.querySelector('.crew-head')).toBe(null)
  expect(container.querySelector('[data-crew-member]')).toBe(null)
})

test('a daemon that cannot serve the rollup does not stop the run view drawing', async () => {
  // An older daemon 404s this route. The graph and the capacity panels are why
  // an operator opened this page; a missing total must not cost them either.
  const stub = await startStubDaemon(oneNode())
  daemon = stub
  const { container } = renderApp(stub, RUN_ROUTE)

  await waitFor(() => expect(cardColorOf(container, 'impl')).toBe('var(--vdag-status-running)'))

  expect(container.querySelector('[data-rollup]')).not.toBe(null)
  expect(container.querySelector('[data-reuse]')).toBe(null)
  // And no error banner: the rollup is not what this screen is for.
  expect(container.querySelector('.error')).toBe(null)
})
