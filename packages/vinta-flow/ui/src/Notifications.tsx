/**
 * The two visible parts of §9.1's browser channel: the degrade, and the opt-in.
 *
 * It sits in the app header rather than in a view because neither belongs to a
 * run. A banner is what a refused permission turns into — the notification the
 * operator would otherwise never see — so it has to be on screen whatever they
 * are looking at, and it says the same thing the notification would have:
 * which node, and which reason. Nothing else (§11).
 *
 * The reminder control is the whole of O7's "opt-in". Off is the default and
 * the first option, because a system that nags gets trained out of attention.
 * It is a real `<select>` — the design system's native one — so it keeps the
 * keyboard, the form semantics and a test's `change` event.
 */
import { BellIcon } from 'lucide-react'
import { Button } from 'vinta-design-system/ui/button'
import { NativeSelect, NativeSelectOption } from 'vinta-design-system/ui/native-select'
import { notifier, notificationBody, routeOf, useNotifications } from './notifications.ts'

/** Minutes, as an operator thinks about them. `0` is off, and is the default. */
const INTERVALS: readonly { readonly label: string; readonly ms: number }[] = [
  { label: 'Reminders off', ms: 0 },
  { label: 'Remind every 5 min', ms: 5 * 60_000 },
  { label: 'Remind every 15 min', ms: 15 * 60_000 },
  { label: 'Remind every 30 min', ms: 30 * 60_000 },
]

export function Notifications() {
  const { banners, reminderMs } = useNotifications()

  return (
    <div className="notifications flex flex-wrap items-center gap-2" data-notifications>
      <span className="relative">
        <BellIcon
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <NativeSelect
          size="sm"
          aria-label="Notification reminders"
          data-field="reminder"
          className="pl-8 text-[13px]"
          value={String(reminderMs)}
          onChange={(event) => notifier.setReminderMs(Number(event.target.value))}
        >
          {INTERVALS.map((interval) => (
            <NativeSelectOption key={interval.ms} value={String(interval.ms)}>
              {interval.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </span>

      {banners.map((banner) => (
        <p
          className="banner flex items-center gap-2 rounded-md border border-tone-attention bg-tone-attention-soft px-2.5 py-1 text-[13px] text-tone-attention-foreground"
          key={banner.key}
          data-banner={banner.key}
        >
          {/* A fragment, so the token stays where the daemon put it (§10). */}
          <a className="font-medium underline-offset-4 hover:underline" href={routeOf(banner)}>
            {notificationBody(banner)}
          </a>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-op="dismiss"
            onClick={() => notifier.dismiss(banner.key)}
          >
            Dismiss
          </Button>
        </p>
      ))}
    </div>
  )
}
