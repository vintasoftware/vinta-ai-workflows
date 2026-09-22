/**
 * §9.1's browser channel, from the socket to the notification centre.
 *
 * The fold itself is unit-tested in `notifications.test.ts`. What this file
 * proves is the wiring the operator depends on: that a pause journalled by the
 * daemon and pushed down the run's stream reaches the notification API of the
 * page watching it, that the page had not asked for permission before there
 * was something to say, that a refusal turns into something visible on
 * screen instead of silence, and that a run is heard from whichever view is
 * open — not only from its own.
 */
import { cleanup, fireEvent, waitFor, type RenderResult } from '@testing-library/react'
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

/** The inbox is a sheet, portalled out of the app's container into the body. */
async function openInbox(): Promise<HTMLElement> {
  const bell = view?.container.querySelector('[data-op="inbox"]') as HTMLButtonElement
  fireEvent.click(bell)
  return await waitFor(() => {
    const sheet = document.querySelector('[data-inbox]')
    expect(sheet).not.toBeNull()
    return sheet as HTMLElement
  })
}

test('a refused permission puts the same words in the page instead', async () => {
  installNotifications('default', 'denied')
  const stub = await watching()

  stub.emit(PAUSE, PARKED)
  // The bell counts it, so it is visible whatever the operator is looking at.
  await waitFor(() =>
    expect(view?.container.querySelector('[data-unread]')?.textContent).toBe('1'),
  )

  // The OS channel is the daemon's and is unaffected; this one said nothing to
  // the browser, threw nothing, and left the run view alive.
  expect(FakeNotification.shown).toHaveLength(0)
  expect(view?.container.querySelector('[data-notifications]')).not.toBeNull()

  const sheet = await openInbox()
  const entry = sheet.querySelector(`[data-entry="${RUN_ID}|impl|e-ask"]`)
  expect(entry?.textContent).toContain('node impl: waiting for the operator')
  expect(entry?.textContent).toContain('Waiting for you')
  expect(entry?.textContent).not.toContain('invoice')
  // And the sheet says why nothing reached the desktop.
  expect(sheet.querySelector('[data-channel="denied"]')).not.toBeNull()
})

test('notifications accumulate in the inbox, and none has to be dismissed to see another', async () => {
  installNotifications('granted')
  const stub = await watching()

  stub.emit(
    PAUSE,
    { nodeId: 'impl', type: 'gate_result', payload: { gate: 'unit', exit_code: 1, status: 'failed' } },
    { nodeId: null, type: 'run_ended', payload: { status: 'failed' } },
  )
  await waitFor(() =>
    expect(view?.container.querySelector('[data-unread]')?.textContent).toBe('3'),
  )

  const sheet = await openInbox()
  expect([...sheet.querySelectorAll('[data-entry]')].map((row) => row.querySelector('a')?.textContent)).toEqual([
    `run ${RUN_ID}: run finished`,
    'node impl: gate failed',
    'node impl: waiting for the operator',
  ])

  fireEvent.click(sheet.querySelector('[data-filter="waiting"]') as HTMLButtonElement)
  await waitFor(() => expect(sheet.querySelectorAll('[data-entry]')).toHaveLength(1))

  fireEvent.click(sheet.querySelector('[data-filter="all"]') as HTMLButtonElement)
  fireEvent.click(sheet.querySelector('[data-op="read-all"]') as HTMLButtonElement)
  await waitFor(() => expect(view?.container.querySelector('[data-unread]')).toBeNull())
  expect(sheet.querySelectorAll('[data-entry]')).toHaveLength(3)

  // Dismissing one leaves the others where they were.
  fireEvent.click(sheet.querySelector('[data-entry] [data-op="dismiss"]') as HTMLButtonElement)
  await waitFor(() => expect(sheet.querySelectorAll('[data-entry]')).toHaveLength(2))
})

test('a run is heard from the runs list, not only from its own view', async () => {
  installNotifications('granted')
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: { [RUN_ID]: snapshot({ nodes: [node('impl', 'running')] }) },
    details: { [`${RUN_ID}/impl`]: nodeDetail() },
  })
  daemon = stub
  view = renderApp(stub, '#/')
  await waitFor(() => expect(stub.connections).toHaveLength(1))

  stub.emit(PAUSE, PARKED)
  await waitFor(() => expect(FakeNotification.shown).toHaveLength(1))
  expect(FakeNotification.shown[0]?.body).toBe('node impl: waiting for the operator')
})

test('opening the run hands its stream over rather than opening a second', async () => {
  installNotifications('granted')
  const stub = await startStubDaemon({
    runs: [runSummary()],
    snapshots: { [RUN_ID]: snapshot({ nodes: [node('impl', 'running')] }) },
    details: { [`${RUN_ID}/impl`]: nodeDetail() },
  })
  daemon = stub
  view = renderApp(stub, '#/')
  await waitFor(() => expect(stub.connections).toHaveLength(1))

  window.location.hash = `#/runs/${RUN_ID}`
  window.dispatchEvent(new HashChangeEvent('hashchange'))
  await waitFor(() => expect(stub.connections).toHaveLength(2))
  // Let a stray reopen show itself, if there is one.
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(stub.connections).toHaveLength(2)

  stub.emit(PAUSE, PARKED)
  await waitFor(() => expect(FakeNotification.shown).toHaveLength(1))
  await flush()
  expect(FakeNotification.shown).toHaveLength(1)
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

  const sheet = await openInbox()
  const select = sheet.querySelector('[data-field="reminder"]')
  expect((select as HTMLSelectElement).value).toBe('0')
  expect(notifier.state.reminderMs).toBe(0)
})

test('the browser channel can be turned on from the inbox', async () => {
  installNotifications('default', 'granted')
  await watching()

  const sheet = await openInbox()
  fireEvent.click(sheet.querySelector('[data-op="enable-browser"]') as HTMLButtonElement)

  await waitFor(() => expect(document.querySelector('[data-channel="granted"]')).not.toBeNull())
  expect(FakeNotification.requests).toBe(1)
})

test('the top bar offers the opt-in until the browser has been asked', async () => {
  installNotifications('default', 'granted')
  await watching()

  const bar = () => view?.container.querySelector('[data-notifications] > [data-op="enable-browser"]')
  expect(bar()).not.toBeNull()
  // Offering it is not asking: nothing is requested until the click (§10).
  expect(FakeNotification.requests).toBe(0)

  fireEvent.click(bar() as HTMLButtonElement)
  await waitFor(() => expect(bar()).toBeNull())
  expect(FakeNotification.requests).toBe(1)
  expect(FakeNotification.shown.map((shown) => shown.body)).toEqual(['Browser notifications are on.'])
})

test('the top bar says nothing once the browser has answered', async () => {
  installNotifications('denied')
  await watching()
  expect(view?.container.querySelector('[data-notifications] > [data-op="enable-browser"]')).toBeNull()
})
