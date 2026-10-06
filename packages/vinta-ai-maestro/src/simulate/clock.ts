/**
 * The virtual clock a simulated run lives on (§13.1).
 *
 * A projection of a six-hour run has to finish in milliseconds, so nothing in
 * a simulation may wait on real time. This implements the same `Clock` seam
 * admission control already takes, and adds the two things a discrete-event
 * driver needs: a `sleep` that parks on the same timer queue, and an `advance`
 * that jumps straight to the next deadline once the run has gone quiescent.
 *
 * Time only ever moves inside `advance`, which the driver calls when every
 * microtask has drained. That is what makes a simulation deterministic: two
 * runs of the same workflow fire the same timers at the same virtual instants,
 * in the same order, regardless of how fast the machine underneath is.
 */
import type { Clock } from '../admission/clock.ts'

interface Timer {
  readonly at: number
  /** Registration order, so timers due at one instant fire deterministically. */
  readonly seq: number
  readonly wake: () => void
}

export class VirtualClock implements Clock {
  #now = 0
  #seq = 0
  readonly #timers = new Map<number, Timer>()

  now(): number {
    return this.#now
  }

  at(at: number, wake: () => void): () => void {
    const id = (this.#seq += 1)
    this.#timers.set(id, { at, seq: id, wake })
    return () => {
      this.#timers.delete(id)
    }
  }

  /** Parks for `ms` of virtual time. The one way a simulated effect costs time. */
  sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.at(this.#now + Math.max(0, ms), resolve)
    })
  }

  /**
   * Jumps to the earliest pending deadline and fires everything due there.
   * Returns false when nothing is pending — which means the run is either
   * finished or stalled on something no amount of time will resolve.
   */
  advance(): boolean {
    if (this.#timers.size === 0) return false

    let due = Number.POSITIVE_INFINITY
    for (const timer of this.#timers.values()) due = Math.min(due, timer.at)
    this.#now = Math.max(this.#now, due)

    const ready = [...this.#timers]
      .filter(([, timer]) => timer.at <= this.#now)
      .sort((a, b) => a[1].seq - b[1].seq)
    for (const [id, timer] of ready) {
      this.#timers.delete(id)
      timer.wake()
    }
    return true
  }
}
