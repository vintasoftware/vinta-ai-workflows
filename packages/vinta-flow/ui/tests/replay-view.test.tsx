/**
 * §13.2's replay, against the same stub listener the live view is tested on.
 *
 * The two claims worth testing here are not "a slider moves". They are:
 *
 * - **What replay shows is what happened.** Asserted by reconstructing the
 *   state after specific events and, more strongly, by rendering the live view
 *   of a run and the replay of the same run *to its end* and requiring the two
 *   screens to agree node for node. Similar would not be evidence; equal is.
 * - **Scrubbing is not refetching.** Asserted against the stub's record of the
 *   reads it served, because request count is the property and a stopwatch is
 *   not. A run of three thousand events is scrubbed end to end and back, and
 *   the log is read exactly as many times as it has pages.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { App } from '../src/App.tsx'
import { createClient } from '../src/client.ts'
import { createReplayClient } from '../src/replay-client.ts'
import { REPLAY_PAGE } from '../src/replay.ts'
import { node, RUN_ID, runSummary, snapshot, statusEvent } from './fixtures.ts'
import { cardColorOf, labelOf, renderApp, toneOf } from './render-app.tsx'
import { startStubDaemon, type NewEvent, type StubDaemon } from './stub-daemon.ts'

const RUN_ROUTE = `#/runs/${RUN_ID}`
const REPLAY_ROUTE = `#/runs/${RUN_ID}/replay`

let daemon: StubDaemon | null = null

afterEach(async () => {
  cleanup()
  sessionStorage.clear()
  await daemon?.close()
  daemon = null
})

/** The app at a fragment, with the replay client pointed at the stub. */
function renderReplay(stub: StubDaemon, hash = REPLAY_ROUTE) {
  window.location.hash = hash
  return render(
    <App
      client={createClient(stub.origin, stub.token)}
      replay={createReplayClient(stub.origin, stub.token)}
    />,
  )
}

function slider(container: HTMLElement): HTMLInputElement {
  const element = container.querySelector('input[data-slider]')
  if (!(element instanceof HTMLInputElement)) throw new Error('no replay slider')
  return element
}

async function scrubTo(container: HTMLElement, position: number): Promise<void> {
  // A range input clamps to its own `max`, and `max` is the run's length —
  // which is only known once the first page has landed.
  await waitFor(() => expect(Number(slider(container).max)).toBeGreaterThanOrEqual(position))
  fireEvent.change(slider(container), { target: { value: String(position) } })
  await waitFor(() =>
    expect(container.querySelector('[data-position]')?.textContent).toContain(`event ${position} `),
  )
}

/** The run as the screen shows it: one entry per node, plus the run chip. */
function screenState(container: HTMLElement, nodeIds: readonly string[]) {
  return {
    run: container.querySelector('.run-head .chip')?.textContent ?? '',
    nodes: nodeIds.map((nodeId) => ({
      nodeId,
      color: cardColorOf(container, nodeId),
      tone: toneOf(container, nodeId),
      label: labelOf(container, nodeId),
    })),
  }
}

/**
 * A short history with a non-status event in the middle, so a position is
 * proved to be a position in the *log* rather than a count of transitions.
 */
const HISTORY: readonly NewEvent[] = [
  statusEvent('impl', 'running'),
  { nodeId: 'impl', type: 'node_assigned', payload: { lane: 'lane-1' } },
  statusEvent('impl', 'done'),
  statusEvent('review', 'running'),
  statusEvent('review', 'failed'),
  { nodeId: null, type: 'run_ended', payload: { status: 'failed' } },
]

const NODES = [node('impl', 'failed'), node('review', 'failed', 1)]

test('scrubbing to a position reproduces the state that event produced', async () => {
  const stub = await startStubDaemon({
    runs: [runSummary({ status: 'failed', endedAt: 1_700_000_600_000 })],
    snapshots: {
      [RUN_ID]: snapshot({
        run: runSummary({ status: 'failed', endedAt: 1_700_000_600_000 }),
        cursor: HISTORY.length,
        nodes: NODES,
      }),
    },
    events: HISTORY,
  })
  daemon = stub
  const { container } = renderReplay(stub)

  // Position 0 is the run before its first event: nothing has moved, and the
  // snapshot's final statuses must not have leaked onto the screen.
  await waitFor(() => expect(container.querySelector('[data-slider]')).not.toBe(null))
  await waitFor(() => expect(cardColorOf(container, 'impl')).toBe('var(--vdag-status-pending)'))
  expect(cardColorOf(container, 'review')).toBe('var(--vdag-status-pending)')
  expect(container.querySelector('.run-head .chip')?.textContent).toBe('running')

  await scrubTo(container, 1)
  expect(cardColorOf(container, 'impl')).toBe('var(--vdag-status-running)')
  expect(cardColorOf(container, 'review')).toBe('var(--vdag-status-pending)')

  // The assignment carries no status, so the graph is unchanged — but the
  // position moved, which is what proves the slider indexes the log.
  await scrubTo(container, 2)
  expect(cardColorOf(container, 'impl')).toBe('var(--vdag-status-running)')
  expect(container.querySelector('[data-event]')?.textContent).toBe('node_assigned · impl')

  await scrubTo(container, 3)
  expect(cardColorOf(container, 'impl')).toBe('var(--vdag-status-done)')
  expect(cardColorOf(container, 'review')).toBe('var(--vdag-status-pending)')

  await scrubTo(container, 5)
  expect(cardColorOf(container, 'review')).toBe('var(--vdag-status-failed)')
  // The run has not ended yet at position 5; the last event is what ends it.
  expect(container.querySelector('.run-head .chip')?.textContent).toBe('running')

  await scrubTo(container, HISTORY.length)
  expect(container.querySelector('.run-head .chip')?.textContent).toBe('failed')
  expect(cardColorOf(container, 'impl')).toBe('var(--vdag-status-done)')
})

test('the position carries a wall clock and an elapsed time', async () => {
  const startedAt = 1_700_000_000_000
  const stub = await startStubDaemon({
    runs: [runSummary({ startedAt })],
    snapshots: { [RUN_ID]: snapshot({ run: runSummary({ startedAt }), nodes: NODES }) },
    events: [statusEvent('impl', 'running')],
  })
  daemon = stub
  const { container } = renderReplay(stub)

  // Position 0 is the run's own start: the clock reads it, and elapsed is zero.
  await waitFor(() =>
    expect(container.querySelector('[data-at]')?.getAttribute('data-at')).toBe(String(startedAt)),
  )
  expect(container.querySelector('[data-elapsed]')?.textContent).toBe('+0s')

  await scrubTo(container, 1)
  // The stub stamps events with the wall clock, so the assertion is that the
  // readout is the event's own `ts` and the offset from the run's start.
  const at = Number(container.querySelector('[data-at]')?.getAttribute('data-at'))
  expect(at).toBeGreaterThan(startedAt)
  expect(container.querySelector('[data-at]')?.getAttribute('dateTime')).toBe(
    new Date(at).toISOString(),
  )
  expect(container.querySelector('[data-elapsed]')?.textContent).toMatch(/^\+/)
})

test('a run replayed to its end is the live view of that run', async () => {
  // `orphan` never appears in the log. Live falls back to the snapshot for it
  // and replay falls back to the fold's own `pending`; both are `pending`,
  // because only `node_status` ever moves a node — which is the reason the two
  // screens can be required to be equal rather than merely alike.
  const nodes = [...NODES, node('orphan', 'pending', 2)]
  const finished = runSummary({ status: 'failed', endedAt: 1_700_000_600_000 })
  const stub = await startStubDaemon({
    runs: [finished],
    snapshots: { [RUN_ID]: snapshot({ run: finished, cursor: 0, nodes }) },
    events: HISTORY,
  })
  daemon = stub
  const ids = nodes.map((entry) => entry.nodeId)

  // The live view, folding the same log off the socket.
  const live = renderApp(stub, RUN_ROUTE)
  await waitFor(() =>
    expect(cardColorOf(live.container, 'review')).toBe('var(--vdag-status-failed)'),
  )
  await waitFor(() => expect(live.container.querySelector('.run-head .chip')?.textContent).toBe('failed'))
  const liveState = screenState(live.container, ids)

  cleanup()
  sessionStorage.clear()

  const { container } = renderReplay(stub)
  await waitFor(() => expect(container.querySelector('[data-slider]')).not.toBe(null))
  await scrubTo(container, HISTORY.length)
  await waitFor(() =>
    expect(cardColorOf(container, 'review')).toBe('var(--vdag-status-failed)'),
  )

  expect(screenState(container, ids)).toEqual(liveState)
})

test('scrubbing backwards re-reads nothing, and a long run is read once per page', async () => {
  // Three thousand events: six pages, and the whole point is that six is all
  // the reads there ever are, however far the slider travels.
  const total = 3000
  const events: NewEvent[] = []
  for (let i = 0; i < total; i += 1) {
    events.push(
      i % 2 === 0
        ? statusEvent('impl', i % 4 === 0 ? 'running' : 'waiting_on_capacity')
        : { nodeId: 'impl', type: 'node_operation', payload: { op: 'add_context' } },
    )
  }
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: { [RUN_ID]: snapshot({ cursor: total, nodes: NODES }) },
    events,
  })
  daemon = stub
  const { container } = renderReplay(stub)

  await waitFor(() => expect(container.querySelector('[data-slider]')).not.toBe(null))
  // The first page alone tells the client how long the run is.
  await waitFor(() =>
    expect(container.querySelector('[data-position]')?.textContent).toBe(`event 0 of ${total}`),
  )
  expect(stub.eventReads).toHaveLength(1)

  // A tick inside the first page fetches nothing at all.
  await scrubTo(container, 120)
  expect(stub.eventReads).toHaveLength(1)

  // The end of the run: the pages between here and there, and no more.
  await scrubTo(container, total)
  const pages = Math.ceil(total / REPLAY_PAGE)
  await waitFor(() => expect(stub.eventReads).toHaveLength(pages))
  expect(cardColorOf(container, 'impl')).toBe('var(--vdag-status-waiting_on_capacity)')

  // Backwards, repeatedly, across every page boundary. Nothing is re-read —
  // and no read ever restarts from zero.
  for (const position of [2500, 1750, 900, 300, 0, 1999]) {
    await scrubTo(container, position)
    expect(stub.eventReads).toHaveLength(pages)
  }
  expect(stub.eventReads.filter((read) => read.since === 0)).toHaveLength(1)
  expect(stub.eventReads.every((read) => read.served <= REPLAY_PAGE)).toBe(true)
})

test('a run still in progress is replayable to its current end, and says so', async () => {
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: { [RUN_ID]: snapshot({ cursor: 2, nodes: NODES }) },
    events: [statusEvent('impl', 'running'), statusEvent('review', 'pending')],
  })
  daemon = stub
  const { container } = renderReplay(stub)

  await waitFor(() => expect(container.querySelector('[data-inprogress]')).not.toBe(null))
  expect(container.querySelector('[data-inprogress]')?.textContent).toContain(
    'still in progress',
  )
  // "up to its current end" is a claim about the log, so it names the count.
  expect(container.querySelector('[data-inprogress]')?.textContent).toContain('2 events')

  await scrubTo(container, 2)
  expect(cardColorOf(container, 'impl')).toBe('var(--vdag-status-running)')
  // The run itself is unfinished, so the run chip never reaches a verdict.
  expect(container.querySelector('.run-head .chip')?.textContent).toBe('running')
})

test('a finished run is not labelled as in progress', async () => {
  const finished = runSummary({ status: 'done', endedAt: 1_700_000_600_000 })
  const stub = await startStubDaemon({
    runs: [finished],
    snapshots: { [RUN_ID]: snapshot({ run: finished, cursor: 1, nodes: NODES }) },
    events: [{ nodeId: null, type: 'run_ended', payload: { status: 'done' } }],
  })
  daemon = stub
  const { container } = renderReplay(stub)

  await waitFor(() => expect(container.querySelector('[data-slider]')).not.toBe(null))
  expect(container.querySelector('[data-inprogress]')).toBe(null)
})

test('a run with no events renders, and offers nothing to scrub', async () => {
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: { [RUN_ID]: snapshot({ nodes: NODES }) },
  })
  daemon = stub
  const { container } = renderReplay(stub)

  await waitFor(() => expect(container.querySelector('.empty')?.textContent).toBe(
    'This run has no events yet.',
  ))
  expect(slider(container).disabled).toBe(true)
  expect(container.querySelector('[data-position]')?.textContent).toBe('event 0 of 0')
  // The graph still draws, from the snapshot, with every node untouched.
  expect(cardColorOf(container, 'impl')).toBe('var(--vdag-status-pending)')
  expect(stub.eventReads).toHaveLength(1)
})

test('replay survives a run the daemon is no longer holding a snapshot for', async () => {
  // The reviewer's case: the daemon restarted, the run is history. The log is
  // still readable, so replay degrades to node ids rather than to nothing.
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: { [RUN_ID]: snapshot({ nodes: NODES }), other: snapshot() },
    events: HISTORY,
    corrupt: 'snapshot',
  })
  daemon = stub
  const { container } = renderReplay(stub)

  await waitFor(() => expect(container.querySelector('[data-degraded]')).not.toBe(null))
  await scrubTo(container, 3)
  expect(toneOf(container, 'impl')).toBe('ok')
})
