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
 *   the log, because the delivered keys are kept in `localStorage`. That is a
 *   browser's memory of what it showed, not a fact about the run, which is
 *   exactly why it does not belong in the journal.
 *
 * **Everything raised lands in the inbox**, whichever channel carried it. A
 * browser notification is gone once the OS tray drops it, and a row of banners
 * that had to be dismissed to see the one behind was a queue with no way to
 * read it. So the inbox is the durable half: kept in `localStorage`, shared by
 * every tab on the origin, and emptied by the operator rather than by time. It
 * is also §10's degrade — a refused permission leaves the inbox and its unread
 * count as the in-page surface.
 *
 * **Reminders are off** (O7). An interval is opt-in, and only an unanswered
 * pause repeats: a system that nags gets trained out of attention.
 *
 * **The body is a node id and a fixed reason, and nothing else.** A
 * notification renders outside the browser, on a lock screen, in a screen
 * share — it is the most exposed surface in the product. No question text, no
 * gate output, no diff, no branch name (§11). The inbox persists exactly that
 * and a timestamp, so storing it exposes nothing the tray did not.
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

/** One inbox row: the item, when it happened, and what became of it. */
export interface InboxEntry extends NotifyItem {
  /** The journalled event's timestamp — the run's clock, not the tab's. */
  readonly at: number
  readonly read: boolean
  /** A pause nobody has answered yet. Always false for what is not a pause. */
  readonly waiting: boolean
}

/**
 * What the browser channel can do right now. `insecure` is named on its own
 * because it is the one no prompt can fix: a daemon reached over plain HTTP
 * on a remote `--host` is not a secure context, and browsers withhold the
 * Notification API from those.
 */
export type BrowserChannel = NotificationPermission | 'unsupported' | 'insecure'

const TITLE = 'vinta-ai-maestro'
const SEEN_KEY = 'vinta-ai-maestro:notified'
const INBOX_KEY = 'vinta-ai-maestro:inbox'
const REMINDER_KEY = 'vinta-ai-maestro:reminder-ms'
/** Bounded, because a long run parks many times and this is a browser's memory. */
const SEEN_LIMIT = 500
const INBOX_LIMIT = 200

type StoredEvent = EventFrame['events'][number]

/** Only the field the channel reads. The rest of the pause is the UI's job. */
const QuestionEventSchema = z.object({ effect_id: z.string() })
const AnsweredEventSchema = z.object({ effect_id: z.string() })
/** A gate's verdict. The log stays where it is: this reads a status, never output. */
const GateResultSchema = z.object({ gate: z.string(), status: z.string() })
const StatusEventSchema = z.object({ status: z.string() })

/** Past these a pause cannot still be pending, so its reminder stops. */
const SETTLED: ReadonlySet<string> = new Set(['done', 'failed', 'blocked'])

const InboxSchema = z.array(
  z.object({
    key: z.string(),
    runId: z.string(),
    nodeId: z.string().nullable(),
    reason: z.enum(NOTIFY_REASONS),
    at: z.number(),
    read: z.boolean(),
    waiting: z.boolean(),
  }),
)

export interface NotifierState {
  /** Newest first. Survives a reload and is shared by every tab. */
  readonly inbox: readonly InboxEntry[]
  readonly unread: number
  /** 0 is off, which is the default (O7). */
  readonly reminderMs: number
  readonly channel: BrowserChannel
}

const EMPTY: NotifierState = { inbox: [], unread: 0, reminderMs: 0, channel: 'unsupported' }

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
  #state: NotifierState = fresh()
  readonly #listeners = new Set<() => void>()
  /** Unanswered pauses, so a reminder has something to repeat and to stop at. */
  readonly #pending = new Map<string, NotifyItem>()
  readonly #timers = new Map<string, ReturnType<typeof setInterval>>()
  #seen: Set<string> = readSeen()
  #asking: Promise<NotificationPermission> | null = null

  constructor() {
    // Another tab raised, read or cleared something. The inbox is one list
    // per origin, so this tab's copy follows.
    globalThis.addEventListener?.('storage', (event: StorageEvent) => {
      if (event.key === null || event.key === INBOX_KEY) this.#publish(withInbox(readInbox()))
      if (event.key === null || event.key === SEEN_KEY) this.#seen = readSeen()
    })
    // A grant or a block made in another tab or in the browser's settings is
    // noticed the next time the operator comes back to this one.
    globalThis.addEventListener?.('focus', () => this.refreshChannel())
  }

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
        this.#raise({ key: `${runId}|run`, runId, nodeId: null, reason: 'run finished' }, event.ts)
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
          event.ts,
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
        this.#raise(
          { key: `${runId}|gate|${event.id}`, runId, nodeId: event.nodeId, reason: 'gate failed' },
          event.ts,
        )
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
        // The inbox too, not only this page's pending set: a pause raised
        // before a reload is still listed as waiting until something says
        // otherwise.
        const keys = new Set(this.#pending.keys())
        for (const entry of this.#state.inbox) if (entry.waiting) keys.add(entry.key)
        for (const key of keys) {
          const item = this.#pending.get(key) ?? this.#state.inbox.find((entry) => entry.key === key)
          if (item?.runId === runId && item.nodeId === event.nodeId) this.#settle(key)
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

  markRead(key: string): void {
    this.#edit((inbox) => inbox.map((entry) => (entry.key === key && !entry.read ? { ...entry, read: true } : entry)))
  }

  markAllRead(): void {
    this.#edit((inbox) => inbox.map((entry) => (entry.read ? entry : { ...entry, read: true })))
  }

  /**
   * Out of the inbox, not out of memory: the key stays delivered, so a replay
   * cannot bring back what the operator cleared.
   */
  dismiss(key: string): void {
    this.#edit((inbox) => inbox.filter((entry) => entry.key !== key))
  }

  clear(): void {
    this.#edit(() => [])
  }

  /**
   * The operator's own opt-in, from a click. The first-use ask in `#show` is
   * not enough on its own: Firefox and Safari ignore a permission prompt that
   * no user gesture raised, so on those browsers a pause could never have
   * turned the channel on. A grant posts one notification, so the operator
   * sees the channel work before a run depends on it.
   */
  async enableBrowser(): Promise<BrowserChannel> {
    const api = notificationApi()
    if (api !== null && api.permission === 'default') {
      try {
        this.#asking ??= request(api)
        await this.#asking
      } catch {
        // Read back as whatever the browser now reports.
      } finally {
        this.#asking = null
      }
    }
    const channel = this.refreshChannel()
    if (api !== null && channel === 'granted') {
      try {
        new api(TITLE, { body: 'Browser notifications are on.', tag: `${TITLE}:enabled` })
      } catch {
        // The grant stands even when the browser declines this one.
      }
    }
    return channel
  }

  /** Permission changes in the browser's own settings, behind the page's back. */
  refreshChannel(): BrowserChannel {
    const channel = channelOf()
    if (channel !== this.#state.channel) this.#publish({ channel })
    return channel
  }

  /** A fresh page, and the reset a test needs between two of them. */
  reset(): void {
    for (const key of [...this.#timers.keys()]) this.#disarm(key)
    this.#pending.clear()
    this.#seen = readSeen()
    this.#asking = null
    this.#state = EMPTY
    this.#publish(fresh())
  }

  // -------------------------------------------------------------------------

  #raise(item: NotifyItem, at: number, options: { readonly pending?: boolean } = {}): void {
    if (this.#seen.has(item.key)) return
    this.#remember(item.key)
    const waiting = options.pending === true
    if (waiting) {
      this.#pending.set(item.key, item)
      this.#arm(item)
    }
    this.#edit((inbox) => [{ ...item, at, read: false, waiting }, ...inbox.filter((entry) => entry.key !== item.key)])
    this.#show(item)
  }

  /**
   * Delivery to the browser. The inbox already holds the item, so a refused or
   * missing channel returns quietly — that is §10's degrade, not a failure.
   */
  #show(item: NotifyItem): void {
    const api = notificationApi()
    if (api === null || api.permission === 'denied') return
    if (api.permission === 'granted') return this.#post(api, item)

    // 'default': §10 — the ask happens here, on first use, never on page load.
    // One ask at a time, so a burst of pauses is one prompt.
    this.#asking ??= request(api)
    void this.#asking.then(
      (result) => {
        this.#asking = null
        this.refreshChannel()
        if (result === 'granted') this.#post(api, item)
      },
      () => {
        this.#asking = null
        this.refreshChannel()
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
        this.markRead(item.key)
        notification.close()
        try {
          window.focus()
        } catch {
          // Focusing is a courtesy; the operator is already clicking.
        }
      }
    } catch {
      // A browser that refuses the constructor is a refused channel, not a
      // crash: the inbox already says it.
    }
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

  /** Answered, or moot. The reminder stops; the entry stays and says so. */
  #settle(key: string): void {
    this.#disarm(key)
    this.#pending.delete(key)
    this.#edit((inbox) => inbox.map((entry) => (entry.key === key && entry.waiting ? { ...entry, waiting: false } : entry)))
  }

  /** Every inbox change goes through here, so storage and every view agree. */
  #edit(change: (inbox: readonly InboxEntry[]) => readonly InboxEntry[]): void {
    const current = this.#state.inbox
    const next = change(current).slice(0, INBOX_LIMIT)
    if (next.length === current.length && next.every((entry, index) => entry === current[index])) return
    write(INBOX_KEY, JSON.stringify(next), localStorage)
    this.#publish(withInbox(next))
  }

  #remember(key: string): void {
    this.#seen.add(key)
    const kept = [...this.#seen].slice(-SEEN_LIMIT)
    this.#seen = new Set(kept)
    write(SEEN_KEY, JSON.stringify(kept), localStorage)
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

function fresh(): NotifierState {
  return { ...withInbox(readInbox()), reminderMs: readReminder(), channel: channelOf() }
}

function withInbox(inbox: readonly InboxEntry[]): Pick<NotifierState, 'inbox' | 'unread'> {
  return { inbox, unread: inbox.filter((entry) => !entry.read).length }
}

function channelOf(): BrowserChannel {
  const api = notificationApi()
  const secure = (globalThis as { isSecureContext?: boolean }).isSecureContext !== false
  if (api === null) return secure ? 'unsupported' : 'insecure'
  if (!secure && api.permission !== 'granted') return 'insecure'
  return api.permission
}

/** A stored inbox that does not parse is a browser's stale memory, not an error. */
function readInbox(): readonly InboxEntry[] {
  try {
    const parsed = InboxSchema.safeParse(JSON.parse(read(INBOX_KEY, localStorage) ?? '[]'))
    return parsed.success ? parsed.data.slice(0, INBOX_LIMIT) : []
  } catch {
    return []
  }
}

function readReminder(): number {
  const stored = Number(read(REMINDER_KEY, localStorage))
  return Number.isSafeInteger(stored) && stored > 0 ? stored : 0
}

function readSeen(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(read(SEEN_KEY, localStorage) ?? '[]')
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
