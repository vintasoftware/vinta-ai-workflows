/**
 * The visible half of §9.1's browser channel: the inbox, the opt-in, and the
 * reminders.
 *
 * It sits in the app header rather than in a view because none of it belongs
 * to a run. The header carries one bell with an unread count; everything else
 * is in a side sheet, because a list that grows with the run cannot live in a
 * top bar. The old row of banners there could only be read one at a time, by
 * dismissing whichever was in front, which made "what did I miss" a question
 * the page could not answer.
 *
 * Each row says what a notification would have said — which node, which
 * reason — and nothing else (§11), plus when, and for a pause whether it is
 * still waiting. A row is a fragment link, so the token stays where the daemon
 * put it (§10).
 *
 * The browser opt-in is a button because it has to be: Firefox and Safari only
 * show a permission prompt a click raised, so the first-use ask alone would
 * leave the channel off there for good. While the browser has not been asked,
 * that button also sits in the top bar beside the bell — an opt-in hidden in a
 * panel is one nobody finds before the pause it was for. Once answered it
 * leaves the bar, and the panel says what each state that is not "on" would
 * need, since "blocked" alone leaves the operator guessing where.
 *
 * The reminder control is O7's opt-in. Off is the default and the first
 * option, because a system that nags gets trained out of attention. Its
 * options name the thing being repeated and the condition that ends it — only
 * an *unanswered pause* repeats, and answering is what stops it. It is a real
 * `<select>` — the design system's native one — so it keeps the keyboard, the
 * form semantics and a test's `change` event.
 */
import { BellIcon, BellRingIcon, CheckCheckIcon, XIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from 'vinta-design-system/ui/button'
import { NativeSelect, NativeSelectOption } from 'vinta-design-system/ui/native-select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from 'vinta-design-system/ui/sheet'
import { cn } from 'vinta-design-system/lib/utils'
import { Chip, ToneDot } from './Chip.tsx'
import {
  type BrowserChannel,
  type InboxEntry,
  notificationBody,
  notifier,
  routeOf,
  useNotifications,
} from './notifications.ts'
import type { Tone } from './status.ts'
import { useNow } from './time.ts'

/** Minutes, as an operator thinks about them. `0` is off, and is the default. */
const INTERVALS: readonly { readonly label: string; readonly ms: number }[] = [
  { label: 'No reminders', ms: 0 },
  { label: 'Remind every 5 min until answered', ms: 5 * 60_000 },
  { label: 'Remind every 15 min until answered', ms: 15 * 60_000 },
  { label: 'Remind every 30 min until answered', ms: 30 * 60_000 },
]

type Filter = 'all' | 'unread' | 'waiting'

const FILTERS: readonly { readonly id: Filter; readonly label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'waiting', label: 'Waiting' },
]

export function Notifications() {
  const { unread, inbox, channel } = useNotifications()
  const [open, setOpen] = useState(false)
  const waiting = inbox.some((entry) => entry.waiting && !entry.read)

  // Whether to offer the opt-in is read when the bar appears, not when the
  // module loaded: the permission is the browser's, and it moves on its own.
  useEffect(() => {
    notifier.refreshChannel()
  }, [])

  return (
    <div className="notifications flex items-center gap-1" data-notifications>
      {channel === 'default' && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="text-[13px]"
          data-op="enable-browser"
          title="Get a system notification when a run needs you, even with this tab in the background."
          onClick={() => void notifier.enableBrowser()}
        >
          <BellRingIcon />
          Enable notifications
        </Button>
      )}
      <Sheet
        open={open}
        onOpenChange={(next) => {
          // The browser's settings may have changed since the page last looked.
          if (next) notifier.refreshChannel()
          setOpen(next)
        }}
      >
        <SheetTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="relative"
            data-op="inbox"
            aria-label={unread === 0 ? 'Notifications' : `Notifications, ${unread} unread`}
          >
            <BellIcon />
            {unread > 0 && (
              <span
                data-unread={unread}
                className={cn(
                  'pointer-events-none absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] leading-none font-semibold tabular-nums',
                  waiting ? 'bg-tone-attention text-white' : 'bg-primary text-primary-foreground',
                )}
              >
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </Button>
        </SheetTrigger>
        <SheetContent className="w-full gap-0 sm:max-w-md" data-inbox>
          <Inbox onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
    </div>
  )
}

/** Mounted only while the sheet is open, so its clock ticks only then. */
function Inbox({ onNavigate }: { readonly onNavigate: () => void }) {
  const { inbox, unread, reminderMs, channel } = useNotifications()
  const [filter, setFilter] = useState<Filter>('all')
  const now = useNow(30_000)

  const counts: Readonly<Record<Filter, number>> = {
    all: inbox.length,
    unread,
    waiting: inbox.filter((entry) => entry.waiting).length,
  }
  const shown = inbox.filter((entry) =>
    filter === 'unread' ? !entry.read : filter === 'waiting' ? entry.waiting : true,
  )

  return (
    <>
      <SheetHeader className="border-b pr-12">
        <SheetTitle>Notifications</SheetTitle>
        <SheetDescription>
          Pauses, failed gates and finished runs. Kept until you clear them.
        </SheetDescription>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-1" role="group" aria-label="Show">
            {FILTERS.map((option) => (
              <Button
                key={option.id}
                type="button"
                size="xs"
                variant={filter === option.id ? 'secondary' : 'ghost'}
                aria-pressed={filter === option.id}
                data-filter={option.id}
                onClick={() => setFilter(option.id)}
              >
                {option.label}
                <span className="text-muted-foreground tabular-nums">{counts[option.id]}</span>
              </Button>
            ))}
          </div>
          <div className="flex gap-1">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              data-op="read-all"
              disabled={unread === 0}
              onClick={() => notifier.markAllRead()}
            >
              <CheckCheckIcon />
              Mark all read
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              data-op="clear"
              disabled={inbox.length === 0}
              onClick={() => notifier.clear()}
            >
              Clear all
            </Button>
          </div>
        </div>
      </SheetHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 ? (
          <p className="empty px-4 py-10 text-center text-sm text-muted-foreground">
            {inbox.length === 0
              ? 'Nothing yet. A phase that stops to ask you something, a failed gate or a finished run will show up here.'
              : 'Nothing matches this filter.'}
          </p>
        ) : (
          <ul className="divide-y">
            {shown.map((entry) => (
              <Row key={entry.key} entry={entry} now={now} onNavigate={onNavigate} />
            ))}
          </ul>
        )}
      </div>

      <SheetFooter className="mt-0 gap-3 border-t">
        <BrowserStatus channel={channel} />
        <NativeSelect
          size="sm"
          aria-label="Reminders while a phase waits for your answer"
          title="A phase that stops to ask you something raises one notification. This repeats it until you answer."
          data-field="reminder"
          className="w-full text-[13px]"
          value={String(reminderMs)}
          onChange={(event) => notifier.setReminderMs(Number(event.target.value))}
        >
          {INTERVALS.map((interval) => (
            <NativeSelectOption key={interval.ms} value={String(interval.ms)}>
              {interval.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </SheetFooter>
    </>
  )
}

function Row({
  entry,
  now,
  onNavigate,
}: {
  readonly entry: InboxEntry
  readonly now: number
  readonly onNavigate: () => void
}) {
  return (
    <li
      className={cn('group flex items-start gap-3 px-4 py-3', !entry.read && 'bg-accent/40')}
      data-entry={entry.key}
      data-read={entry.read}
      data-waiting={entry.waiting}
    >
      <span className="mt-1.5">
        <ToneDot tone={toneOf(entry)} />
      </span>
      <div className="min-w-0 flex-1">
        <a
          className={cn(
            'block text-sm underline-offset-4 hover:underline',
            entry.read ? 'text-muted-foreground' : 'font-medium text-foreground',
          )}
          href={routeOf(entry)}
          onClick={() => {
            notifier.markRead(entry.key)
            onNavigate()
          }}
        >
          {notificationBody(entry)}
        </a>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {/* A run-scoped body already names the run. */}
          {entry.nodeId !== null && (
            <>
              <span className="max-w-[16rem] truncate font-mono" title={entry.runId}>
                {entry.runId}
              </span>
              <span aria-hidden="true">·</span>
            </>
          )}
          <time dateTime={new Date(entry.at).toISOString()} title={new Date(entry.at).toLocaleString()}>
            {ago(entry.at, now)}
          </time>
          {entry.reason === 'waiting for the operator' &&
            (entry.waiting ? <Chip tone="attention">Waiting for you</Chip> : <Chip tone="idle">Answered</Chip>)}
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="opacity-60 group-hover:opacity-100 focus-visible:opacity-100"
        aria-label={`Dismiss ${notificationBody(entry)}`}
        data-op="dismiss"
        onClick={() => notifier.dismiss(entry.key)}
      >
        <XIcon />
      </Button>
    </li>
  )
}

function BrowserStatus({ channel }: { readonly channel: BrowserChannel }) {
  if (channel === 'granted') {
    return (
      <p className="flex items-center gap-2 text-[13px]" data-channel={channel}>
        <ToneDot tone="ok" />
        Browser notifications are on.
      </p>
    )
  }
  if (channel === 'default') {
    return (
      <div className="flex flex-col gap-2" data-channel={channel}>
        <p className="text-[13px] text-muted-foreground">
          Get a system notification when a run needs you, even with this tab in the background.
        </p>
        <Button type="button" size="sm" data-op="enable-browser" onClick={() => void notifier.enableBrowser()}>
          <BellIcon />
          Enable browser notifications
        </Button>
      </div>
    )
  }
  return (
    <p className="flex items-start gap-2 text-[13px] text-muted-foreground" data-channel={channel}>
      <span className="mt-1.5">
        <ToneDot tone="wait" />
      </span>
      {channel === 'denied'
        ? 'Browser notifications are blocked for this site. Allow them in the browser’s site settings (the icon left of the address bar), then reopen this panel.'
        : channel === 'insecure'
          ? 'Browser notifications need HTTPS or localhost, and this page is served over plain HTTP. This list still collects everything.'
          : 'This browser has no notification support. This list still collects everything.'}
    </p>
  )
}

function toneOf(entry: InboxEntry): Tone {
  if (entry.reason === 'gate failed') return 'error'
  // Finished is not the same as passed, so a finished run gets no colour of its own.
  if (entry.reason === 'run finished') return 'idle'
  return entry.waiting ? 'attention' : 'idle'
}

/** `just now`, `4m ago`, `3h ago`, `2d ago`; the exact time is the title. */
function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
