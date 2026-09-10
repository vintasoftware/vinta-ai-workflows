/**
 * The two things §10 promises about the stream: a reload is free, and a
 * dropped socket costs nothing but the socket.
 *
 * Both are asserted from the server's side as well as the screen's. The stub
 * records the `since` of every upgrade and the ids it answered with, so
 * "resumed at the cursor" and "replayed nothing" are checked as facts about
 * the wire rather than inferred from a DOM that happens to look right.
 */
import { cleanup, waitFor } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { node, RUN_ID, runSummary, snapshot, statusEvent } from './fixtures.ts'
import { cardColorOf, renderApp, toneOf } from './render-app.tsx'
import { startStubDaemon, type StubDaemon } from './stub-daemon.ts'

const RUN_ROUTE = `#/runs/${RUN_ID}`

let daemon: StubDaemon | null = null

afterEach(async () => {
  cleanup()
  sessionStorage.clear()
  await daemon?.close()
  daemon = null
})

test('a reload mid-run rebuilds the same view from a snapshot and its cursor', async () => {
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: { [RUN_ID]: snapshot({ nodes: [node('impl', 'pending'), node('review', 'pending', 1)] }) },
  })
  daemon = stub
  const first = renderApp(stub, RUN_ROUTE)

  stub.emit(statusEvent('impl', 'running'), statusEvent('impl', 'waiting_on_capacity'))
  await waitFor(() =>
    expect(cardColorOf(first.container, 'impl')).toBe('var(--vdag-status-waiting_on_capacity)'),
  )
  expect(stub.connections[0]?.since).toBe(0)
  expect(stub.connections[0]?.sent).toEqual([1, 2])

  // The tab goes away. The journal does not, and neither does the daemon's
  // projection of it — which is what the reloaded page reads first.
  first.unmount()
  stub.setSnapshot(
    RUN_ID,
    snapshot({ nodes: [node('impl', 'waiting_on_capacity'), node('review', 'pending', 1)] }),
  )

  const second = renderApp(stub, RUN_ROUTE)
  await waitFor(() =>
    expect(cardColorOf(second.container, 'impl')).toBe('var(--vdag-status-waiting_on_capacity)'),
  )
  expect(toneOf(second.container, 'impl')).toBe('wait')
  expect(toneOf(second.container, 'review')).toBe('idle')

  // Resumed exactly where the tab left off: no gap, and not one event twice.
  await waitFor(() => expect(stub.connections).toHaveLength(2))
  expect(stub.connections[1]?.since).toBe(2)
  expect(stub.connections[1]?.sent).toEqual([])

  // And the resumed socket is a live one, not a corpse.
  stub.emit(statusEvent('impl', 'done'))
  await waitFor(() => expect(cardColorOf(second.container, 'impl')).toBe('var(--vdag-status-done)'))
  expect(stub.connections[1]?.sent).toEqual([3])
})

test('a dropped socket reconnects from its cursor and replays nothing', async () => {
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: { [RUN_ID]: snapshot({ nodes: [node('impl', 'pending')] }) },
  })
  daemon = stub
  const { container } = renderApp(stub, RUN_ROUTE)

  stub.emit(statusEvent('impl', 'running'), statusEvent('impl', 'waiting_on_capacity'))
  await waitFor(() =>
    expect(cardColorOf(container, 'impl')).toBe('var(--vdag-status-waiting_on_capacity)'),
  )

  stub.drop()
  await waitFor(() => expect(container.textContent).toContain('Reconnecting…'))
  await waitFor(() => expect(stub.connections).toHaveLength(2))

  expect(stub.connections[1]?.since).toBe(2)
  expect(stub.connections[1]?.sent).toEqual([])
  // Nothing regressed while the socket was gone: the view is still the fold.
  expect(cardColorOf(container, 'impl')).toBe('var(--vdag-status-waiting_on_capacity)')

  stub.emit(statusEvent('impl', 'running'))
  await waitFor(() => expect(cardColorOf(container, 'impl')).toBe('var(--vdag-status-running)'))
  expect(stub.connections[1]?.sent).toEqual([3])
  await waitFor(() => expect(container.textContent).toContain('Live'))
})
