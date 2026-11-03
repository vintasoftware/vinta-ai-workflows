import { cleanup, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { node, RUN_ID, runSummary, snapshot } from './fixtures.ts'
import { renderApp } from './render-app.tsx'
import { startStubDaemon, type StubDaemon } from './stub-daemon.ts'

const RUN_ROUTE = `#/runs/${RUN_ID}`

let daemon: StubDaemon | null = null

afterEach(async () => {
  cleanup()
  sessionStorage.clear()
  await daemon?.close()
  daemon = null
})

const start = async (status: 'running' | 'done' = 'running') => {
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: {
      [RUN_ID]: snapshot({
        run: { ...snapshot().run, status },
        nodes: [node('impl', status === 'done' ? 'done' : 'running')],
      }),
    },
  })
  daemon = stub
  const view = renderApp(stub, RUN_ROUTE)
  return { stub, ...view }
}

const op = (container: HTMLElement, name: string): HTMLButtonElement | null =>
  container.querySelector(`button[data-run-op="${name}"]`)

test('pause asks the run to drain, and says so until the run ends', async () => {
  const { stub, container } = await start()
  await waitFor(() => expect(op(container, 'pause')).not.toBe(null))

  fireEvent.click(op(container, 'pause') as HTMLButtonElement)

  await waitFor(() => expect(stub.halts).toEqual([{ runId: RUN_ID, mode: 'pause' }]))
  await waitFor(() => expect(container.querySelector('[data-halting="pause"]')).not.toBe(null))
  expect(op(container, 'pause')).toBe(null)

  // The run's own end is what takes the controls away.
  stub.emit({ nodeId: null, type: 'run_ended', payload: { status: 'paused' } })
  await waitFor(() => expect(container.querySelector('[data-halting]')).toBe(null))
})

test('stop is asked twice, and keeping the run sends nothing', async () => {
  const { stub, container } = await start()
  await waitFor(() => expect(op(container, 'stop')).not.toBe(null))

  fireEvent.click(op(container, 'stop') as HTMLButtonElement)
  expect(stub.halts).toEqual([])
  fireEvent.click(op(container, 'stop-cancel') as HTMLButtonElement)
  expect(op(container, 'stop')).not.toBe(null)

  fireEvent.click(op(container, 'stop') as HTMLButtonElement)
  fireEvent.click(op(container, 'stop-confirm') as HTMLButtonElement)
  await waitFor(() => expect(stub.halts).toEqual([{ runId: RUN_ID, mode: 'stop' }]))
})

test('a run nothing is hosting says so instead of pretending to pause', async () => {
  const { stub, container } = await start()
  await waitFor(() => expect(op(container, 'pause')).not.toBe(null))
  stub.refuseHalt('run_not_live')

  fireEvent.click(op(container, 'pause') as HTMLButtonElement)

  await waitFor(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('its job has exited'),
  )
  // Still offered: the refusal changed nothing, and stop can still make it final.
  expect(op(container, 'stop')).not.toBe(null)
})

test('a finished run offers neither', async () => {
  const { container } = await start('done')
  await waitFor(() => expect(container.querySelector('tr[data-node="impl"]')).not.toBe(null))
  expect(op(container, 'pause')).toBe(null)
  expect(op(container, 'stop')).toBe(null)
})
