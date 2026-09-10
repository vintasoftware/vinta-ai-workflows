/**
 * OS notifications, with no new dependency (§9.1).
 *
 * §9.1 requires both channels to fire on a pause: the browser channel belongs
 * to the UI, and this is the other one — the case where the UI is closed
 * entirely. A notification daemon is a two-line `execFile` on both platforms
 * that have one, so taking a package for it would add a dependency to a CLI
 * whose zero-runtime-deps property §2 calls load-bearing.
 *
 * - **macOS**: `osascript -e 'display notification …'`.
 * - **Linux**: `notify-send`.
 * - **Anywhere else**: a documented no-op. Windows' `msg`/toast surface needs a
 *   PowerShell round trip and is not worth guessing at from here; a missing
 *   notification must never be the thing that fails a run.
 *
 * **The body is not free text.** It is a node (or run) identifier plus a reason
 * drawn from a fixed vocabulary, and nothing else — never a gate's output, an
 * agent's transcript, a diff or a prompt. `notify`'s `text` param is plan data,
 * so it is *matched* against that vocabulary rather than interpolated: an
 * unrecognised value degrades to the generic reason instead of reaching the
 * notification centre. That also makes shell-quoting a non-issue by
 * construction, because the only characters that can occur are the ones this
 * module and `Id`'s kebab-case regex allow.
 *
 * Nothing here throws. A missing `osascript`, a headless Linux box with no
 * notification daemon, and an unsupported platform are all the same outcome:
 * `delivered: false`, and the run carries on.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** Every reason a notification body may carry. Anything else becomes `OTHER_REASON`. */
export const NOTIFY_REASONS = [
  'phase failed',
  'gate failed',
  'waiting for the operator',
  'run finished',
] as const

export type NotifyReason = (typeof NOTIFY_REASONS)[number] | 'attention required'

const OTHER_REASON: NotifyReason = 'attention required'

const KNOWN: ReadonlySet<string> = new Set(NOTIFY_REASONS)

/** Maps an author-supplied `text` param onto the fixed vocabulary. */
export function notifyReason(text: unknown): NotifyReason {
  return typeof text === 'string' && KNOWN.has(text) ? (text as NotifyReason) : OTHER_REASON
}

export interface Notification {
  /** `node` for a node-scoped notification, `run` for a run-scoped one. */
  readonly scope: 'node' | 'run'
  /** The node id, or the run id. An identifier — never a name or a description. */
  readonly id: string
  readonly reason: NotifyReason
}

export interface Notifier {
  /** Resolves whether or not anything was shown. `false` means nothing was. */
  notify(notification: Notification): Promise<boolean>
}

/** `node p1: gate failed`. The whole body, and the only shape it takes. */
export function notificationBody(notification: Notification): string {
  return `${notification.scope} ${identifier(notification.id)}: ${notification.reason}`
}

/** Belt and braces over `Id`'s regex: the body can carry no quoting at all. */
function identifier(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '')
}

const TITLE = 'vinta-flow'

/**
 * The real notifier. `platform` is injectable so the unsupported-platform path
 * is testable on a machine that supports notifications.
 */
export function createOsNotifier(platform: NodeJS.Platform = process.platform): Notifier {
  return {
    async notify(notification: Notification): Promise<boolean> {
      const body = notificationBody(notification)
      try {
        if (platform === 'darwin') {
          await exec('osascript', ['-e', `display notification "${body}" with title "${TITLE}"`])
          return true
        }
        if (platform === 'linux') {
          await exec('notify-send', [TITLE, body])
          return true
        }
        // Documented no-op: every other platform.
        return false
      } catch {
        // No `osascript`, no notification daemon, no session bus. Not a failure.
        return false
      }
    },
  }
}
