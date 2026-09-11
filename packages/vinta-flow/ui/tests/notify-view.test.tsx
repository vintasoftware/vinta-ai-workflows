/**
 * §9.1's browser channel, from the socket to the notification centre.
 *
 * The fold itself is unit-tested in `notifications.test.ts`. What this file
 * proves is the wiring the operator depends on: that a pause journalled by the
 * daemon and pushed down the run's stream reaches the notification API of the
 * page watching it, that the page had not asked for permission before there
 * was something to say, and that a refusal turns into something visible on
 * screen instead of silence.
 */
import { cleanup, waitFor, type RenderResult } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { notifier } from '../src/notifications.ts'
import {
  FakeNotification,
  flush,
  installNotifications,
  uninstallNotifications,
} from './fake-notification.ts'
import { node, nodeDetail, RUN_ID, runSummary, snapshot } from './fixtures.ts'
import { renderApp } from './render-app.tsx'
import { startStubDaemon, type StubDaemon } from './stub-daemon.ts'

let daemon: StubDaemon | null = null
let view: RenderResult | null = null

afterEach(async () => {
  view = null
  cleanup()
  uninstallNotifications()
  sessionStorage.clear()
  localStorage.clear()
  notifier.reset()
  await daemon?.close()
  daemon = null
})

async function watching(): Promise<StubDaemon> {
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: { [RUN_ID]: snapshot({ nodes: [node('impl', 'running')] }) },
    details: { [`${RUN_ID}/impl`]: nodeDetail() },
  })
  daemon = stub
  view = renderApp(stub, `#/runs/${RUN_ID}`)
  // The socket has to be open before an emit means anything.
  await waitFor(() => expect(stub.connections).toHaveLength(1))
  return stub
}

/** The pause, exactly as the journal carries it (§9.1). */
const PAUSE = {
  nodeId: 'impl',
  type: 'human_question',
  payload: {
    effect_id: 'e-ask',
    question: 'The invoice serializer changed. Ship it?',
    kind: 'confirm',
  },
}

const PARKED = { nodeId: 'impl', type: 'node_status', payload: { status: 'awaiting_human' } }

test('a node entering awaiting_human notifies the browser, and the notification opens it', async () => {
  installNotifications('default', 'granted')
  const stub = await watching()

  // §10: the page has been open and streaming, and has asked for nothing.
  expect(FakeNotification.requests).toBe(0)

  stub.emit(PAUSE, PARKED)
  await waitFor(() => expect(FakeNotification.shown).toHaveLength(1))
  await flush()

  // Asked on first use, once.
  expect(FakeNotification.requests).toBe(1)
  const shown = FakeNotification.shown[0]
  expect(shown?.body).toBe('node impl: waiting for the operator')
  // Never the question, never a diff, never a branch (§11).
  expect(shown?.body).not.toContain('invoice')

  shown?.onclick?.()
  expect(location.hash).toBe(`#/runs/${RUN_ID}/nodes/impl`)
})

test('a refused permission puts the same words in the page instead', async () => {
  installNotifications('default', 'denied')
  const stub = await watching()

  stub.emit(PAUSE, PARKED)
  await waitFor(() =>
    expect(view?.container.querySelector('[data-banner]')?.textContent).toContain(
      'node impl: waiting for the operator',
    ),
  )

  // The OS channel is the daemon's and is unaffected; this one said nothing to
  // the browser, threw nothing, and left the run view alive.
  expect(FakeNotification.shown).toHaveLength(0)
  expect(view?.container.querySelector('[data-notifications]')).not.toBeNull()

  // And the banner is dismissible, because an operator who has read it should
  // not have to keep reading it.
  const dismiss = view?.container.querySelector('[data-banner] [data-op="dismiss"]')
  ;(dismiss as HTMLButtonElement).click()
  await waitFor(() => expect(view?.container.querySelector('[data-banner]')).toBeNull())
})

test('a failed gate and a finished run both reach the channel', async () => {
  installNotifications('granted')
  const stub = await watching()

  stub.emit(
    {
      nodeId: 'impl',
      type: 'gate_result',
      payload: { gate: 'unit', exit_code: 1, status: 'failed' },
    },
    { nodeId: null, type: 'run_ended', payload: { status: 'failed' } },
  )

  await waitFor(() => expect(FakeNotification.shown).toHaveLength(2))
  expect(FakeNotification.shown.map((entry) => entry.body)).toEqual([
    'node impl: gate failed',
    `run ${RUN_ID}: run finished`,
  ])
})

test('reminders are off until the operator opts in, and the control says so', async () => {
  installNotifications('granted')
  await watching()

  const select = view?.container.querySelector('[data-field="reminder"]')
  expect((select as HTMLSelectElement).value).toBe('0')
  expect(notifier.state.reminderMs).toBe(0)
})
