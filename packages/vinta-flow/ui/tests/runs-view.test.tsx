import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { node, RUN_ID, runSummary, snapshot } from './fixtures.ts'
import { renderApp, textOf } from './render-app.tsx'
import { startStubDaemon, type StubDaemon } from './stub-daemon.ts'

let daemon: StubDaemon | null = null

afterEach(async () => {
  cleanup()
  sessionStorage.clear()
  window.location.hash = ''
  await daemon?.close()
  daemon = null
})

test('an empty run list renders', async () => {
  daemon = await startStubDaemon({ runs: [], snapshots: {} })
  const { container } = renderApp(daemon, '#/')
  await waitFor(() => expect(container.textContent).toContain('No runs yet.'))
})

test('the list shows status and elapsed, and opens a run without carrying the token', async () => {
  const started = Date.now() - 125_000
  const stub = await startStubDaemon({
    runs: [
      runSummary({ startedAt: started }),
      runSummary({ runId: 'run-0', workflowId: 'older', status: 'done', startedAt: started, endedAt: started + 61_000 }),
    ],
    snapshots: { [RUN_ID]: snapshot({ nodes: [node('impl', 'running')] }) },
  })
  daemon = stub
  const { container } = renderApp(stub, '#/')

  await waitFor(() => expect(container.querySelector(`tr[data-run="${RUN_ID}"]`)).not.toBe(null))
  expect(textOf(container, `tr[data-run="${RUN_ID}"] .chip`)).toBe('running')
  expect(textOf(container, 'tr[data-run="run-0"] .chip')).toBe('done')
  // A finished run's clock stops at `endedAt` rather than running forever.
  expect(textOf(container, 'tr[data-run="run-0"] td:nth-child(4)')).toBe('1m 01s')

  const open = container.querySelector(`tr[data-run="${RUN_ID}"] a`)
  expect(open?.getAttribute('href')).toBe(`#/runs/${RUN_ID}`)
  // §11: the token is in the page's query string and must not be copied into
  // anything rendered.
  expect(container.innerHTML).not.toContain(stub.token)

  if (open === null) throw new Error('no link')
  fireEvent.click(open)
  await waitFor(() => expect(screen.getByText('add-billing')).toBeDefined())
  expect(container.querySelector('tr[data-node="impl"]')).not.toBe(null)
})
