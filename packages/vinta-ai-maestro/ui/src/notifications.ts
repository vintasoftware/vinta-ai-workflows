/**
 * §9.1's browser channel.
 *
 * The daemon already fires the OS channel from the `await_human` effect. This
 * is the other half, and the two are deliberately independent: the OS one
 * covers a closed UI, this one covers a backgrounded tab, and neither is told
 * about the other. Both fire, because the failure mode of missing one is a
 * lane idle for hours (§9.1).
 *
 * **The journalled question is the delivery record.** There is no `notified`
 * flag anywhere — not in the journal, not on the wire, not here. A pause is
 * one `human_question` event, and `effect_id` makes it identifiable, so
 * "already delivered" is a property of the event log rather than state
 * something has to remember to write. Three mechanisms fall out of that:
 *
 * - **Once per pause.** The key is the run, the node and the effect id — and
 *   for the two events that are not pauses, the journalled event's own id. A
 *   frame that replays — a reconnect, a second view of the same run — raises
 *   nothing new.
 * - **A daemon restart does not re-fire.** A restarted daemon appends no new
 *   `human_question` for a pause it already journalled: it reads the pending
 *   question out of the projection. No new event, no new notification, and
 *   the reconnecting socket resumes from its cursor besides.
 * - **A reload does not re-fire**, even one that lost its cursor and replays
 *   the log, because the delivered keys are kept in `sessionStorage` beside
 *   it. That is a browser's memory of what it showed, not a fact about the
 *   run, which is exactly why it does not belong in the journal.
 *
 * **Reminders are off** (O7). An interval is opt-in, and only an unanswered
 * pause repeats: a system that nags gets trained out of attention.
 *
 * **The body is a node id and a fixed reason, and nothing else.** A
 * notification renders outside the browser, on a lock screen, in a screen
 * share — it is the most exposed surface in the product. No question text, no
 * gate output, no diff, no branch name (§11).
 */
import { useSyncExternalStore } from 'react'
import { z } from 'zod'
import type { EventFrame } from '../../src/daemon/schemas.ts'

/** The whole vocabulary a body may carry, mirroring the daemon's OS channel. */
export const NOTIFY_REASONS = ['waiting for the operator', 'gate failed', 'run finished'] as const

export type NotifyReason = (typeof NOTIFY_REASONS)[number]

export interface NotifyItem {
  /** Identity of the thing being announced: run, node and the journalled pause. */
  readonly key: string
  readonly runId: string
  /** Null for a run-scoped notification. */
  readonly nodeId: string | null
  readonly reason: NotifyReason
}

const TITLE = 'vinta-ai-maestro'
const SEEN_KEY = 'vinta-ai-maestro:notified'
const REMINDER_KEY = 'vinta-ai-maestro:reminder-ms'
/** Bounded, because a long run parks many times and this is a browser's memory. */
const SEEN_LIMIT = 200

type StoredEvent = EventFrame['events'][number]

/** Only the field the channel reads. The rest of the pause is the UI's job. */
const QuestionEventSchema = z.object({ effect_id: z.string() })
const AnsweredEventSchema = z.object({ effect_id: z.string() })
/** A gate's verdict. The log stays where it is: this reads a status, never output. */
const GateResultSchema = z.object({ gate: z.string(), status: z.string() })
const StatusEventSchema = z.object({ status: z.string() })

/** Past these a pause cannot still be pending, so its reminder stops. */
const SETTLED: ReadonlySet<string> = new Set(['done', 'failed', 'blocked'])

export interface NotifierState {
  /** Pauses that had to be shown in the page because the OS channel was refused. */
  readonly banners: readonly NotifyItem[]
  /** 0 is off, which is the default (O7). */
  readonly reminderMs: number
}

const EMPTY: NotifierState = { banners: [], reminderMs: 0 }

/** `node p1: gate failed` — the whole body, and the only shape it takes. */
export function notificationBody(item: NotifyItem): string {
  const scope = item.nodeId === null ? 'run' : 'node'
  return `${scope} ${identifier(item.nodeId ?? item.runId)}: ${item.reason}`
}

/** The fragment route the notification opens: the node, or the run (§10). */
export function routeOf(item: NotifyItem): string {
  const run = `#/runs/${encodeURIComponent(item.runId)}`
  return item.nodeId === null ? run : `${run}/nodes/${encodeURIComponent(item.nodeId)}`
}

class Notifier {
  #state: NotifierState = { banners: [], reminderMs: readReminder() }
  readonly #listeners = new Set<() => void>()
  /** Unanswered pauses, so a reminder has something to repeat and to stop at. */
  readonly #pending = new Map<string, NotifyItem>()
  readonly #timers = new Map<string, ReturnType<typeof setInterval>>()
  #seen: Set<string> = readSeen()
  #asking: Promise<NotificationPermission> | null = null

  get state(): NotifierState {
    return this.#state
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Folds a frame's events into notifications. Called for every frame (§10). */
  ingest(runId: string, events: readonly StoredEvent[]): void {
    for (const event of events) {
      if (event.type === 'run_ended') {
        this.#raise({ key: `${runId}|run`, runId, nodeId: null, reason: 'run finished' })
        continue
      }
      if (event.nodeId === null) continue
      if (event.type === 'human_question') {
        const parsed = QuestionEventSchema.safeParse(event.payload)
        if (!parsed.success) continue
        this.#raise(
          {
            key: pauseKey(runId, event.nodeId, parsed.data.effect_id),
            runId,
            nodeId: event.nodeId,
            reason: 'waiting for the operator',
          },
          // The one notification that repeats, if the operator asked it to:
          // a pause is unanswered until it is answered.
          { pending: true },
        )
        continue
      }
      if (event.type === 'gate_result') {
        const parsed = GateResultSchema.safeParse(event.payload)
        if (!parsed.success || parsed.data.status === 'passed') continue
        // Keyed by the event, not by the gate: a gate that fails, is fixed and
        // fails again in a later round has failed twice, and saying so once
        // would be the same silence this channel exists to prevent.
        this.#raise({
          key: `${runId}|gate|${event.id}`,
          runId,
          nodeId: event.nodeId,
          reason: 'gate failed',
        })
        continue
      }
      if (event.type === 'human_answered') {
        const parsed = AnsweredEventSchema.safeParse(event.payload)
        if (parsed.success) this.#settle(pauseKey(runId, event.nodeId, parsed.data.effect_id))
        continue
      }
      if (event.type === 'node_status') {
        const parsed = StatusEventSchema.safeParse(event.payload)
        if (!parsed.success || !SETTLED.has(parsed.data.status)) continue
        for (const [key, item] of this.#pending) {
          if (item.runId === runId && item.nodeId === event.nodeId) this.#settle(key)
        }
      }
    }
  }

  /** Opt in to reminders, or set 0 to turn them off again. Persisted per browser. */
  setReminderMs(ms: number): void {
    const next = Number.isSafeInteger(ms) && ms > 0 ? ms : 0
    if (next === this.#state.reminderMs) return
    write(REMINDER_KEY, String(next), localStorage)
    this.#publish({ reminderMs: next })
    for (const key of [...this.#timers.keys()]) this.#disarm(key)
    if (next > 0) for (const item of this.#pending.values()) this.#arm(item)
  }

  dismiss(key: string): void {
    if (!this.#state.banners.some((banner) => banner.key === key)) return
    this.#publish({ banners: this.#state.banners.filter((banner) => banner.key !== key) })
  }

  /** A fresh page, and the reset a test needs between two of them. */
  reset(): void {
    for (const key of [...this.#timers.keys()]) this.#disarm(key)
    this.#pending.clear()
    this.#seen = readSeen()
    this.#asking = null
    this.#state = EMPTY
    this.#publish({ reminderMs: readReminder() })
  }

  // -------------------------------------------------------------------------

  #raise(item: NotifyItem, options: { readonly pending?: boolean } = {}): void {
    if (this.#seen.has(item.key)) return
    this.#remember(item.key)
    if (options.pending === true) {
      this.#pending.set(item.key, item)
      this.#arm(item)
    }
    this.#show(item)
  }

  /** Delivery, and the only place permission is ever asked for. */
  #show(item: NotifyItem): void {
    const api = notificationApi()
    if (api === null) return this.#fallback(item)
    if (api.permission === 'granted') return this.#post(api, item)
    if (api.permission === 'denied') return this.#fallback(item)

    // 'default': §10 — the ask happens here, on first use, never on page load.
    // One ask at a time, so a burst of pauses is one prompt.
    this.#asking ??= request(api)
    void this.#asking.then(
      (result) => {
        this.#asking = null
        if (result === 'granted') this.#post(api, item)
        else this.#fallback(item)
      },
      () => {
        this.#asking = null
        this.#fallback(item)
      },
    )
  }

  #post(api: typeof Notification, item: NotifyItem): void {
    try {
      // `tag` is the pause: a reminder replaces its own notification in the
      // tray rather than stacking a fifth copy of the same sentence.
      const notification = new api(TITLE, { body: notificationBody(item), tag: item.key })
      notification.onclick = () => {
        // §9.1: clicking lands on the node that is waiting. The route is set
        // first, so a browser that refuses to focus the tab still navigates.
        location.hash = routeOf(item)
        notification.close()
        try {
          window.focus()
        } catch {
          // Focusing is a courtesy; the operator is already clicking.
        }
      }
    } catch {
      // A browser that refuses the constructor is a refused channel, not a
      // crash: the page says it instead.
      this.#fallback(item)
    }
  }

  /** §10's degrade: refused permission becomes an in-page banner, never a throw. */
  #fallback(item: NotifyItem): void {
    if (this.#state.banners.some((banner) => banner.key === item.key)) return
    this.#publish({ banners: [...this.#state.banners, item] })
  }

  #arm(item: NotifyItem): void {
    const { reminderMs } = this.#state
    if (reminderMs <= 0 || this.#timers.has(item.key)) return
    this.#timers.set(
      item.key,
      setInterval(() => {
        // Repeats are deliberate, so they bypass the delivered set — but only
        // while the pause is still unanswered.
        if (this.#pending.has(item.key)) this.#show(item)
      }, reminderMs),
    )
  }

  #disarm(key: string): void {
    const timer = this.#timers.get(key)
    if (timer === undefined) return
    clearInterval(timer)
    this.#timers.delete(key)
  }

  #settle(key: string): void {
    this.#disarm(key)
    this.#pending.delete(key)
    this.dismiss(key)
  }

  #remember(key: string): void {
    this.#seen.add(key)
    const kept = [...this.#seen].slice(-SEEN_LIMIT)
    this.#seen = new Set(kept)
    write(SEEN_KEY, JSON.stringify(kept), sessionStorage)
  }

  #publish(patch: Partial<NotifierState>): void {
    this.#state = { ...this.#state, ...patch }
    for (const listener of this.#listeners) listener()
  }
}

/** One per page: reminders and delivered keys outlive any single view. */
export const notifier = new Notifier()

export function useNotifications(): NotifierState {
  return useSyncExternalStore(
    notifier.subscribe,
    () => notifier.state,
    () => EMPTY,
  )
}

// ---------------------------------------------------------------------------

function pauseKey(runId: string, nodeId: string, effectId: string): string {
  return `${runId}|${nodeId}|${effectId}`
}

/** Belt and braces: the body can carry no quoting and no path at all. */
function identifier(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '')
}

/** The browser global, or null where there is none — an old browser, a test. */
function notificationApi(): typeof Notification | null {
  const api = (globalThis as { Notification?: typeof Notification }).Notification
  return typeof api === 'function' ? api : null
}

/** `requestPermission` is a promise in every browser this app targets, and a
 *  callback in one that does not; either way nothing here may throw. */
async function request(api: typeof Notification): Promise<NotificationPermission> {
  return await api.requestPermission()
}

function readReminder(): number {
  const stored = Number(read(REMINDER_KEY, localStorage))
  return Number.isSafeInteger(stored) && stored > 0 ? stored : 0
}

function readSeen(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(read(SEEN_KEY, sessionStorage) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((key) => typeof key === 'string') : [])
  } catch {
    return new Set()
  }
}

function read(key: string, store: Storage): string | null {
  try {
    return store.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string, store: Storage): void {
  try {
    store.setItem(key, value)
  } catch {
    // A tab that cannot store this shows one notification twice at worst.
  }
}
