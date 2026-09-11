/**
 * §9.1's browser channel, as a fold over the journal's events.
 *
 * These are unit tests on purpose. The properties under test — once per pause,
 * nothing on a replay, a reminder that stops when the pause is answered — are
 * properties of what the channel does with a sequence of journalled events,
 * and the socket that carries them is tested next door. Driving them through
 * a real WebSocket would test the same fold with a timing hazard attached.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { notifier } from '../src/notifications.ts'
import { flush, FakeNotification, installNotifications, uninstallNotifications } from './fake-notification.ts'

const RUN = 'run-1'
let id = 0

/** One event as the stream delivers it. */
function event(type: string, nodeId: string | null, payload: unknown) {
  id += 1
  return { id, ts: 1_700_000_000_000 + id, runId: RUN, nodeId, type, payload }
}

function question(nodeId: string, effectId: string) {
  return event('human_question', nodeId, {
    effect_id: effectId,
    // The question text is deliberately quotable: no assertion below may ever
    // find it in a notification body (§11).
    question: 'The invoice serializer changed. Ship it?',
    kind: 'confirm',
  })
}

beforeEach(() => {
  id = 0
  sessionStorage.clear()
  localStorage.clear()
  notifier.reset()
  installNotifications('granted')
})

afterEach(() => {
  vi.useRealTimers()
  uninstallNotifications()
  sessionStorage.clear()
  localStorage.clear()
  notifier.reset()
})

test('a journalled pause fires one notification, and a replay of it fires none', async () => {
  notifier.ingest(RUN, [question('impl', 'e-ask')])
  await flush()

  expect(FakeNotification.shown).toHaveLength(1)
  expect(FakeNotification.shown[0]?.body).toBe('node impl: waiting for the operator')
  // The most exposed surface in the product carries an id and a reason (§11).
  expect(FakeNotification.shown[0]?.body).not.toContain('invoice')

  // The same frame again — a reconnect that overlapped, a second view of the
  // run. The key is the pause, so there is nothing new to say.
  notifier.ingest(RUN, [question('impl', 'e-ask')])
  await flush()
  expect(FakeNotification.shown).toHaveLength(1)
})

test('a reload that replays the whole log re-fires nothing', async () => {
  notifier.ingest(RUN, [question('impl', 'e-ask')])
  await flush()
  expect(FakeNotification.shown).toHaveLength(1)

  // A fresh page against the same tab: the cursor may be gone and the daemon
  // may have restarted, so the log arrives from the beginning. Delivery is
  // remembered by the pause's identity, which the journal already assigns.
  notifier.reset()
  notifier.ingest(RUN, [question('impl', 'e-ask'), event('node_status', 'impl', { status: 'awaiting_human' })])
  await flush()
  expect(FakeNotification.shown).toHaveLength(1)
})

test('a failed gate and a finished run each announce themselves', async () => {
  notifier.ingest(RUN, [
    event('gate_result', 'impl', { gate: 'unit', exit_code: 0, status: 'passed' }),
    event('gate_result', 'impl', { gate: 'e2e', exit_code: 1, status: 'failed' }),
    event('gate_result', 'impl', { gate: 'e2e', exit_code: 124, status: 'timed_out' }),
    event('run_ended', null, { status: 'failed' }),
  ])
  await flush()

  // A gate that passed is not news. A gate id is not in the body either: the
  // body is a node and a reason, and the gate's log stays where it is (§11).
  expect(FakeNotification.shown.map((shown) => shown.body)).toEqual([
    'node impl: gate failed',
    'node impl: gate failed',
    'run run-1: run finished',
  ])

  // …and a failed gate is not a pause, so it does not become a reminder.
  notifier.setReminderMs(60_000)
  expect(FakeNotification.shown).toHaveLength(3)
})

test('clicking a notification opens the node that is waiting', async () => {
  notifier.ingest(RUN, [question('impl', 'e-ask')])
  await flush()

  location.hash = '#/'
  FakeNotification.shown[0]?.onclick?.()

  expect(location.hash).toBe('#/runs/run-1/nodes/impl')
  expect(FakeNotification.shown[0]?.closed).toBe(true)
})

test('permission is asked for on first use, and never before there is one', async () => {
  installNotifications('default', 'granted')

  // Nothing has happened yet: the page has not asked, which is §10's rule.
  expect(FakeNotification.requests).toBe(0)

  notifier.ingest(RUN, [question('impl', 'e-ask')])
  await flush()

  expect(FakeNotification.requests).toBe(1)
  expect(FakeNotification.shown).toHaveLength(1)
})

test('a refused permission degrades to an in-page banner, and throws nothing', async () => {
  installNotifications('default', 'denied')

  notifier.ingest(RUN, [question('impl', 'e-ask')])
  await flush()

  expect(FakeNotification.shown).toHaveLength(0)
  expect(notifier.state.banners.map((banner) => banner.nodeId)).toEqual(['impl'])

  // A browser with no Notification API at all takes the same path.
  uninstallNotifications()
  notifier.ingest(RUN, [question('other', 'e-ask')])
  await flush()
  expect(notifier.state.banners.map((banner) => banner.nodeId)).toEqual(['impl', 'other'])
})

test('reminders are off by default', async () => {
  vi.useFakeTimers()
  notifier.ingest(RUN, [question('impl', 'e-ask')])
  await flush()

  vi.advanceTimersByTime(60 * 60_000)
  await flush()

  expect(notifier.state.reminderMs).toBe(0)
  expect(FakeNotification.shown).toHaveLength(1)
})

test('an opted-in interval repeats an unanswered pause, and stops at the answer', async () => {
  vi.useFakeTimers()
  notifier.setReminderMs(60_000)
  notifier.ingest(RUN, [question('impl', 'e-ask')])
  await flush()
  expect(FakeNotification.shown).toHaveLength(1)

  vi.advanceTimersByTime(3 * 60_000)
  await flush()
  expect(FakeNotification.shown).toHaveLength(4)
  expect(FakeNotification.shown.at(-1)?.body).toBe('node impl: waiting for the operator')

  // §9.1: the answer is journalled, and the reminder is a fold over that too.
  notifier.ingest(RUN, [event('human_answered', 'impl', { effect_id: 'e-ask', answer: true })])
  vi.advanceTimersByTime(10 * 60_000)
  await flush()
  expect(FakeNotification.shown).toHaveLength(4)
})

test('a pause that settles some other way stops reminding too', async () => {
  vi.useFakeTimers()
  notifier.setReminderMs(60_000)
  notifier.ingest(RUN, [question('impl', 'e-ask')])
  await flush()

  // Aborted, not answered: there is no `human_answered`, and nobody is waiting
  // on a question about a node that has settled.
  notifier.ingest(RUN, [event('node_status', 'impl', { status: 'failed' })])
  vi.advanceTimersByTime(10 * 60_000)
  await flush()

  expect(FakeNotification.shown).toHaveLength(1)
})
