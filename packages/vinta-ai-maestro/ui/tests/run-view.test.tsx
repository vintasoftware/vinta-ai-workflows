import { cleanup, fireEvent, waitFor } from '@testing-library/react'
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

test('each rollup figure explains itself, down to the counts it was summed from', async () => {
  const stub = await startStubDaemon({ ...oneNode(), usage: { [RUN_ID]: runUsage() } })
  daemon = stub
  const { container } = renderApp(stub, RUN_ROUTE)

  await waitFor(() => expect(container.querySelector('[data-cost]')).not.toBe(null))

  // A click pins it open; the popover renders through a portal.
  fireEvent.click(container.querySelector('[data-explain="How tokens are counted"]')!)
  await waitFor(() => expect(document.body.querySelector('[data-explain-tokens]')).not.toBe(null))
  // Exact, where the row rounds to 12.4k — the sum has to be checkable.
  expect(textOf(document.body, '[data-explain-tokens]')).toContain('12,400 in')
  expect(textOf(document.body, '[data-explain-tokens]')).toContain('over 8 sessions')
  expect(document.body.textContent).toContain('100,000 tokens in all')

  // A second click on the same icon unpins and closes it.
  fireEvent.click(container.querySelector('[data-explain="How tokens are counted"]')!)
  await waitFor(() => expect(document.body.querySelector('[data-explain-tokens]')).toBe(null))

  fireEvent.click(container.querySelector('[data-explain="Where the cost comes from"]')!)
  await waitFor(() => expect(document.body.querySelector('[data-explain-cost]')).not.toBe(null))
  expect(textOf(document.body, '[data-explain-cost]')).toContain('All 8 sessions reported a cost')
  expect(document.body.textContent).toContain('API list price')

  fireEvent.click(container.querySelector('[data-explain="How the cache share is calculated"]')!)
  await waitFor(() => expect(document.body.querySelector('[data-explain-cache]')).not.toBe(null))
  expect(textOf(document.body, '[data-explain-cache]')).toContain('61,000 read ÷ 100,000')
})

test('a partial cost explains which sessions are missing from it', async () => {
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
  fireEvent.click(container.querySelector('[data-explain="Where the cost comes from"]')!)
  await waitFor(() => expect(document.body.querySelector('[data-explain-cost]')).not.toBe(null))

  expect(textOf(document.body, '[data-explain-cost]')).toContain('5 of 8 sessions reported a cost')
  expect(textOf(document.body, '[data-explain-cost]')).toContain('lower bound')
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
            { member: 'tier1', tier: 1, nodes: 2, coveredFor: 0 },
            { member: 'tier4', tier: 4, nodes: 3, coveredFor: 1 },
          ],
          asPlanned: 4,
          substituted: 1,
          warmReuse: 0,
          promoted: 1,
          idle: ['tier2-1'],
        },
      }),
    },
  })
  daemon = stub
  const { container } = renderApp(stub, RUN_ROUTE)

  await waitFor(() => expect(container.querySelector('[data-crew-member]')).not.toBe(null))

  expect(textOf(container, '[data-crew-member="tier1"]')).toContain('tier 1')
  // The number that matters next to the cost: a covered phase ran at or above
  // the tier the plan budgeted for.
  expect(textOf(container, '[data-crew-member="tier4"]')).toContain('1 covering')
  expect(textOf(container, '.crew-head')).toContain('1 of 5 phases covered')
  // And how many of them ran dearer than planned, which nothing showed when a
  // run moved 73 phases up a tier.
  expect(textOf(container, '[data-crew-promoted]')).toContain('1 ran above their planned tier')
  // A declared member with nothing yet is "not reached", not "overstaffed" —
  // a validated workflow cannot declare one nobody is assigned to.
  expect(textOf(container, '[data-crew-idle="tier2-1"]')).toContain('not reached')
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

test('lists what the run decided without a person, each linked to its phase', async () => {
  const stub = await startStubDaemon({
    ...oneNode(),
    unattended: {
      [RUN_ID]: [
        {
          at: 1_700_000_000_000,
          node: 'impl',
          by: 'unattended',
          category: 'agent_question',
          summary: 'impl · unattended after 30m 00s · agent question → Migration: Add published_at (Recommended)',
        },
        { at: 1_700_000_100_000, node: null, by: 'coordinator', category: 'action', summary: 'run · coordinator · amended gate:unit' },
      ],
    },
  })
  daemon = stub
  const { container } = renderApp(stub, RUN_ROUTE)

  await waitFor(() => expect(container.querySelector('[data-unattended-row]')).not.toBe(null))
  const rows = [...container.querySelectorAll('[data-unattended-row]')]
  // Newest first: the decision made since you last looked is the one to read.
  expect(rows.map((row) => row.getAttribute('data-unattended-row'))).toEqual(['action', 'agent_question'])
  expect(rows[1]?.textContent).toContain('agent question → Migration: Add published_at (Recommended)')
  expect(rows[1]?.querySelector('a')?.getAttribute('href')).toBe(`#/runs/${RUN_ID}/nodes/impl`)
  expect(rows[0]?.textContent).toContain('amended gate:unit')
})

test('a run that decided nothing on its own says so', async () => {
  const stub = await startStubDaemon(oneNode())
  daemon = stub
  const { container } = renderApp(stub, RUN_ROUTE)
  await waitFor(() => expect(textOf(container, '[data-unattended]')).toContain('Nothing decided without a person yet.'))
})

test('the lane column drops the run id every lane name repeats', async () => {
  // Lane names are `${runId}-...`, so spelled in full the column is the same
  // prefix on every row — width the table has to scroll for, carrying nothing
  // the operator can tell two lanes apart by.
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: {
      [RUN_ID]: snapshot({
        nodes: [
          { ...node('impl', 'running'), lane: `${RUN_ID}-crew-3-tier4` },
          { ...node('review', 'pending', 1), lane: null },
        ],
      }),
    },
  })
  daemon = stub
  const { container } = renderApp(stub, RUN_ROUTE)

  await waitFor(() => expect(container.querySelector('tr[data-node="impl"]')).not.toBe(null))

  const cell = 'tr[data-node="impl"] td:nth-child(4)'
  expect(textOf(container, cell)).toBe('crew-3-tier4')
  // The full name is still there to read and to copy: it is what the worktree
  // directory and the branch are called.
  expect(container.querySelector(`${cell} span`)?.getAttribute('title')).toBe(
    `${RUN_ID}-crew-3-tier4`,
  )
  // A node the scheduler has not placed yet still reads as having no lane.
  expect(textOf(container, 'tr[data-node="review"] td:nth-child(4)')).toBe('—')
})

test('double-clicking a node on the graph opens its node view', async () => {
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: { [RUN_ID]: snapshot({ nodes: [node('impl', 'running')] }) },
  })
  daemon = stub
  const { container } = renderApp(stub, RUN_ROUTE)
  await waitFor(() => expect(cardColorOf(container, 'impl')).toBe('var(--vdag-status-running)'))

  const card = container
    .querySelector('vinta-dag')
    ?.shadowRoot?.querySelector('button[data-action="select-node"][data-id="impl"]')
  card?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  expect(window.location.hash).toBe(`#/runs/${RUN_ID}/nodes/impl`)
  await waitFor(() => expect(container.querySelector('section.node')).not.toBe(null))
})

/**
 * One worktree, one merge at a time, and a phase waiting on it looked exactly
 * like a phase working. The panel names who has it, what they are doing and
 * who waits; the roster says where each running phase is in its pipeline.
 */
test('the integration worktree panel names its holder, its step and its queue', async () => {
  const startedAt = Date.now() - 125_000
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: {
      [RUN_ID]: snapshot({
        nodes: [{ ...node('p4', 'running'), step: 'integrate' }, node('p5', 'running'), node('p7', 'running')],
        integration: {
          holder: 'p4',
          since: startedAt - 10_000,
          step: {
            step: 'wave_gate',
            branch: null,
            incoming: null,
            wave: 2,
            gate: 'test',
            round: null,
            log: null,
            startedAt,
            finishedAt: null,
            outcome: null,
          },
          queue: ['p5', 'p7'],
        },
      }),
    },
  })
  daemon = stub
  const { container } = renderApp(stub, RUN_ROUTE)

  await waitFor(() => expect(container.querySelector('[data-integration-worktree] [data-holder="p4"]')).not.toBe(null))
  const panel = textOf(container, '[data-integration-worktree]')
  expect(panel).toContain('wave 2 gate test')
  expect(panel).toContain('2m 0')
  expect(textOf(container, '[data-integration-worktree] [data-queue]')).toContain('p5, p7')
  expect(container.querySelector('tr[data-node="p4"] [data-step="integrate"]')).not.toBe(null)
})

test('an idle integration worktree says so', async () => {
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: { [RUN_ID]: snapshot({ nodes: [node('impl', 'running')] }) },
  })
  daemon = stub
  const { container } = renderApp(stub, RUN_ROUTE)
  await waitFor(() => expect(textOf(container, '[data-integration-worktree]')).toContain('Idle'))
})

/**
 * The widgets a run grows without limit — the roster, the decisions, the
 * integration record — are bounded in the page: the newest few rows, a
 * scroller for the rest, and the whole record in a paged dialog.
 */
test('the roster is bounded and scrolls the selected node into view', async () => {
  const scrolled: string[] = []
  const original = HTMLElement.prototype.scrollIntoView
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
    scrolled.push(this.getAttribute('data-node') ?? '?')
  }
  try {
    const stub = await startStubDaemon({
      runs: [runSummary()],
      snapshots: { [RUN_ID]: snapshot({ nodes: [node('impl', 'running'), node('docs', 'pending', 1)] }) },
    })
    daemon = stub
    const { container } = renderApp(stub, RUN_ROUTE)
    await waitFor(() => expect(container.querySelector('tr[data-node="docs"]')).not.toBe(null))

    // The roster's content is a bounded scroller, as are the other lists.
    expect(container.querySelector('tr[data-node="docs"]')?.closest('[data-bounded]')).not.toBe(null)
    expect(container.querySelectorAll('.panels [data-bounded]').length).toBeGreaterThanOrEqual(4)

    fireEvent.click(container.querySelector('tr[data-node="docs"] button.link') as Element)
    await waitFor(() => expect(scrolled).toContain('docs'))
    expect(container.querySelector('tr[data-node="docs"]')?.getAttribute('aria-current')).toBe('true')
  } finally {
    HTMLElement.prototype.scrollIntoView = original
  }
})

test('a long list of decisions shows the newest five and pages the rest in a dialog', async () => {
  const decisions = Array.from({ length: 32 }, (_, index) => ({
    at: 1_700_000_000_000 + index * 60_000,
    node: 'impl',
    by: 'unattended' as const,
    category: 'retry' as const,
    summary: `impl · unattended after 30m 00s · retry ${index + 1}`,
  }))
  const stub = await startStubDaemon({ ...oneNode(), unattended: { [RUN_ID]: decisions } })
  daemon = stub
  const { container } = renderApp(stub, RUN_ROUTE)

  await waitFor(() => expect(container.querySelector('[data-unattended-row]')).not.toBe(null))
  const rows = [...container.querySelectorAll('[data-unattended] [data-unattended-row]')]
  expect(rows).toHaveLength(5)
  expect(rows[0]?.textContent).toContain('retry 32')
  expect(rows[4]?.textContent).toContain('retry 28')

  fireEvent.click(container.querySelector('[data-unattended] [data-action="show-all"]') as Element)
  await waitFor(() => expect(document.querySelector('[data-all-dialog]')).not.toBe(null))
  const dialog = document.querySelector('[data-all-dialog]') as HTMLElement
  expect(dialog.querySelectorAll('[data-unattended-row]')).toHaveLength(25)
  expect(textOf(dialog, '[data-page-range]')).toBe('1–25 of 32')

  fireEvent.click(dialog.querySelector('[data-action="page-next"]') as Element)
  await waitFor(() => expect(textOf(dialog, '[data-page-range]')).toBe('26–32 of 32'))
  expect(dialog.querySelectorAll('[data-unattended-row]')).toHaveLength(7)
  const paged = [...dialog.querySelectorAll('[data-unattended-row]')]
  expect(paged[paged.length - 1]?.textContent).toContain('retry 1')
  expect((dialog.querySelector('[data-action="page-next"]') as HTMLButtonElement).disabled).toBe(true)
})

test('the integration worktree panel lists every phase’s recent steps, newest first', async () => {
  const now = Date.now()
  const stub = await startStubDaemon({
    ...oneNode(),
    integration: {
      [RUN_ID]: [
        { nodeId: 'impl', step: 'verify', branch: null, incoming: null, wave: null, gate: 'unit', round: null, log: '/l/unit.log', startedAt: now - 30_000, finishedAt: null, outcome: null },
        { nodeId: 'docs', step: 'merge', branch: 'plan/x/wave-1', incoming: 'docs', wave: null, gate: null, round: null, log: null, startedAt: now - 120_000, finishedAt: now - 60_000, outcome: 'ok' },
      ],
    },
  })
  daemon = stub
  const { container } = renderApp(stub, RUN_ROUTE)

  await waitFor(() => expect(container.querySelector('[data-integration-history] [data-history-step]')).not.toBe(null))
  const rows = [...container.querySelectorAll('[data-integration-history] [data-history-step]')]
  expect(rows.map((row) => row.getAttribute('data-history-node'))).toEqual(['impl', 'docs'])
  expect(rows[0]?.textContent).toContain('gate unit on the merged tree')
  expect(rows[0]?.querySelector('a')?.getAttribute('href')).toBe(`#/runs/${RUN_ID}/nodes/impl`)
  expect(rows[1]?.textContent).toContain('merge docs into plan/x/wave-1')
  expect(rows[1]?.textContent).toContain('1m 00s')
})

/**
 * The coordinator is a dock, not one card of eight: open beside the page by
 * default on a wide window, closed by the header button, and remembered.
 */
test('the coordinator docks beside the run and the header button toggles it', async () => {
  const stub = await startStubDaemon(oneNode())
  daemon = stub
  const { container } = renderApp(stub, RUN_ROUTE)

  await waitFor(() => expect(container.querySelector('[data-coordinator-dock="column"] [data-monitor]')).not.toBe(null))
  // Not in the grid any more.
  expect(container.querySelector('.panels [data-monitor]')).toBe(null)
  const button = container.querySelector('[data-action="coordinator"]') as HTMLButtonElement
  expect(button.getAttribute('aria-pressed')).toBe('true')

  fireEvent.click(button)
  await waitFor(() => expect(container.querySelector('[data-coordinator-dock]')).toBe(null))
  expect(button.getAttribute('aria-pressed')).toBe('false')
  expect(localStorage.getItem('vinta-ai-maestro-coordinator')).toBe('closed')

  fireEvent.click(button)
  await waitFor(() => expect(container.querySelector('[data-coordinator-dock="column"]')).not.toBe(null))
  localStorage.removeItem('vinta-ai-maestro-coordinator')
})

test('the pools panel shows the two that matter now, and the rest in a dialog', async () => {
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: {
      [RUN_ID]: snapshot({
        nodes: [node('impl', 'running')],
        resources: [
          resource('lane', 4, 0),
          resource('db-a', 1, 0),
          resource('test-suite', 2, 1, ['impl']),
          resource('db-b', 1, 1, ['impl']),
        ],
      }),
    },
  })
  daemon = stub
  const { container } = renderApp(stub, RUN_ROUTE)

  await waitFor(() => expect(container.querySelector('[data-pools] [data-resource]')).not.toBe(null))
  // In use first, fullest first; the idle ones wait in the dialog.
  expect([...container.querySelectorAll('[data-pools] [data-resource]')].map((row) => row.getAttribute('data-resource'))).toEqual([
    'db-b',
    'test-suite',
  ])
  fireEvent.click(container.querySelector('[data-pools] ~ [data-action="show-all"], [data-action="show-all"]') as Element)
  await waitFor(() => expect(document.querySelector('[data-all-dialog]')).not.toBe(null))
  expect([...document.querySelectorAll('[data-all-dialog] [data-resource]')].map((row) => row.getAttribute('data-resource'))).toEqual([
    'db-b',
    'test-suite',
    'lane',
    'db-a',
  ])
})

test('the graph goes full screen from its own button, and Escape brings it back', async () => {
  const stub = await startStubDaemon(oneNode())
  daemon = stub
  const { container } = renderApp(stub, RUN_ROUTE)
  await waitFor(() => expect(container.querySelector('[data-action="dag-fullscreen"]')).not.toBe(null))

  const button = container.querySelector('[data-action="dag-fullscreen"]') as HTMLButtonElement
  expect(container.querySelector('[data-dag-fullscreen]')).toBe(null)
  fireEvent.click(button)
  await waitFor(() => expect(container.querySelector('[data-dag-fullscreen]')).not.toBe(null))
  expect(container.querySelector('vinta-dag')?.hasAttribute('data-fullscreen')).toBe(true)
  expect(button.getAttribute('aria-pressed')).toBe('true')
  expect(document.body.style.overflow).toBe('hidden')

  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => expect(container.querySelector('[data-dag-fullscreen]')).toBe(null))
  expect(document.body.style.overflow).toBe('')
})
