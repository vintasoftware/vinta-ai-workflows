/**
 * A stand-in for the browser's Notification API.
 *
 * jsdom does not implement it, and there is no package here that does — nor
 * should there be: the two things §9.1 and §10 actually claim are *when*
 * permission is asked for and *what* happens when it is refused, and both are
 * properties of this app's call sequence rather than of a notification centre.
 * So the double records the sequence: every constructed notification, every
 * permission request, and the answer the user gave.
 *
 * `permission` is a static on the constructor because that is where the real
 * API puts it, which is what makes "asked on first use, not on load" an
 * assertion about the same thing the browser would see.
 */
export class FakeNotification {
  static permission: NotificationPermission = 'default'
  /** What the operator answers when the page finally asks. */
  static answer: NotificationPermission = 'granted'
  static requests = 0
  static shown: FakeNotification[] = []

  onclick: (() => void) | null = null
  closed = false

  constructor(
    readonly title: string,
    readonly options: NotificationOptions = {},
  ) {
    FakeNotification.shown.push(this)
  }

  get body(): string {
    return this.options.body ?? ''
  }

  close(): void {
    this.closed = true
  }

  static async requestPermission(): Promise<NotificationPermission> {
    FakeNotification.requests += 1
    FakeNotification.permission = FakeNotification.answer
    return FakeNotification.answer
  }
}

/** Installs the double, at the permission a fresh browser would report. */
export function installNotifications(
  permission: NotificationPermission = 'default',
  answer: NotificationPermission = 'granted',
): typeof FakeNotification {
  FakeNotification.permission = permission
  FakeNotification.answer = answer
  FakeNotification.requests = 0
  FakeNotification.shown = []
  ;(globalThis as { Notification?: unknown }).Notification = FakeNotification
  return FakeNotification
}

/** Back to a browser with no Notification API at all — jsdom's own state. */
export function uninstallNotifications(): void {
  delete (globalThis as { Notification?: unknown }).Notification
  FakeNotification.requests = 0
  FakeNotification.shown = []
}

/** Drains the microtask queue the permission prompt resolves on. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}
