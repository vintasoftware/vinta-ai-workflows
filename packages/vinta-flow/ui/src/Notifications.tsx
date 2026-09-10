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
 */
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
    <div className="notifications" data-notifications>
      <select
        aria-label="Notification reminders"
        data-field="reminder"
        value={String(reminderMs)}
        onChange={(event) => notifier.setReminderMs(Number(event.target.value))}
      >
        {INTERVALS.map((interval) => (
          <option key={interval.ms} value={String(interval.ms)}>
            {interval.label}
          </option>
        ))}
      </select>

      {banners.map((banner) => (
        <p className="banner" key={banner.key} data-banner={banner.key}>
          {/* A fragment, so the token stays where the daemon put it (§10). */}
          <a href={routeOf(banner)}>{notificationBody(banner)}</a>
          <button type="button" data-op="dismiss" onClick={() => notifier.dismiss(banner.key)}>
            Dismiss
          </button>
        </p>
      ))}
    </div>
  )
}
