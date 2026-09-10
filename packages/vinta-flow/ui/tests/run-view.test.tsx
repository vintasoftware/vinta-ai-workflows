import { cleanup, waitFor } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { harness, node, resource, RUN_ID, runSummary, snapshot, statusEvent } from './fixtures.ts'
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
