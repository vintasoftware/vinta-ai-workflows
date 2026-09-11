/**
 * The one seam admission control needs into time.
 *
 * A capacity wait is measured in minutes and hours (§6.1), so a test that
 * exercised it against the real clock would either sleep for a quota window or
 * shrink the constants until it stopped testing the thing it was named after.
 * Injecting time instead keeps the suite fast *and* deterministic: a fake clock
 * fires timers in a defined order, so "two harnesses waited independently" is
 * an assertion rather than a race.
 *
 * `at` takes an absolute epoch-millisecond deadline rather than a duration
 * because that is what survives a restart. A wake time reloaded from disk is a
 * point in time; converting it to a delay at the call site would be the one
 * place a restored wait could silently re-fire from zero.
 */
export interface Clock {
  now(): number
  /** Fires `wake` at or after epoch-ms `at`. The returned function cancels it. */
  at(at: number, wake: () => void): () => void
}

export const systemClock: Clock = {
  now: () => Date.now(),
  at: (at, wake) => {
    const timer = setTimeout(wake, Math.max(0, at - Date.now()))
    return () => clearTimeout(timer)
  },
}
