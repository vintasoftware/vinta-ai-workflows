/**
 * The daemon's schemas are the contract, and this is what proves the UI is
 * actually holding it: a response that stops matching has to break a test, not
 * render as a blank panel.
 */
import { cleanup, waitFor } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { node, RUN_ID, runSummary, snapshot, statusEvent } from './fixtures.ts'
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

test('a snapshot that does not match the daemon schema is refused, not rendered', async () => {
  daemon = await startStubDaemon({
    runs: [runSummary()],
    snapshots: { [RUN_ID]: snapshot({ nodes: [node('impl', 'running')] }) },
    corrupt: 'snapshot',
  })
  const { container } = renderApp(daemon, RUN_ROUTE)

  await waitFor(() =>
    expect(container.textContent).toContain('response did not match the daemon schema'),
  )
  // The endpoint is named; the body is not. A response may hold transcript
  // text, and an error message is the last place it should be copied to (§11).
  expect(container.textContent).toContain(`/api/runs/${RUN_ID}`)
  expect(container.querySelector('tr[data-node="impl"]')).toBe(null)
})

test('a frame that does not match the daemon schema stops the stream instead of looping', async () => {
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: { [RUN_ID]: snapshot({ nodes: [node('impl', 'pending')] }) },
    corrupt: 'frame',
  })
  daemon = stub
  const { container } = renderApp(stub, RUN_ROUTE)
  await waitFor(() => expect(container.querySelector('tr[data-node="impl"]')).not.toBe(null))

  stub.emit(statusEvent('impl', 'running'))
  await waitFor(() =>
    expect(container.textContent).toContain('event stream did not match the daemon schema'),
  )

  // A server this client cannot read will not become readable by retrying.
  const seen = stub.connections.length
  await new Promise((resolve) => setTimeout(resolve, 600))
  expect(stub.connections).toHaveLength(seen)
})
