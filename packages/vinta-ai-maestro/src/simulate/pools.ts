/**
 * `ResourcePools` with a tape recorder attached.
 *
 * §13.1's whole point is answering "should `max_parallel_lanes` be 3 or 6 on
 * *this* plan", and that answer is contention: how long each pool sat at its
 * capacity, and how long holders spent queued for it. Measuring it at the pool
 * itself rather than inferring it from the schedule means the numbers describe
 * what the real allocator actually did — the same FIFO, the same all-or-nothing
 * acquisition — instead of a model of it.
 *
 * A subclass rather than a wrapper because the scheduler takes a
 * `ResourcePools` and must keep taking the real one; the only overridden
 * behaviour is bookkeeping around `acquire` and the lease it hands back.
 *
 * Identifiers only: a pool name and two virtual timestamps per event.
 */
import { ResourcePools, type Lease, type ResourcePoolsOptions } from '../resources/pools.ts'
import type { Resource } from '../types.ts'
import type { VirtualClock } from './clock.ts'

/** What one pool cost the run. Every duration is virtual milliseconds. */
export interface PoolContention {
  readonly resource: string
  readonly capacity: number
  /** Most slots held at once. Below capacity means the pool was never the constraint. */
  readonly peakHeld: number
  /** How long at least one slot was held. */
  readonly busyMs: number
  /** How long every slot was held — the window in which the pool blocked someone. */
  readonly saturatedMs: number
  /** Summed time holders spent queued for this pool before being granted. */
  readonly queuedMs: number
}

interface Occupancy {
  readonly resource: string
  readonly at: number
  readonly delta: 1 | -1
  readonly seq: number
}

export class MeasuredPools extends ResourcePools {
  readonly #clock: VirtualClock
  readonly #resources: readonly string[]
  readonly #occupancy: Occupancy[] = []
  readonly #queued = new Map<string, number>()
  #seq = 0

  constructor(
    resources: Readonly<Record<string, Resource>>,
    clock: VirtualClock,
    options: ResourcePoolsOptions = {},
  ) {
    super(resources, options)
    this.#clock = clock
    this.#resources = Object.keys(resources)
  }

  override acquire(needs: readonly string[]): Promise<Lease> {
    const canonical = [...new Set(needs)].sort()
    const enqueuedAt = this.#clock.now()

    return super.acquire(needs).then((lease) => {
      const grantedAt = this.#clock.now()
      for (const resource of canonical) {
        this.#queued.set(resource, (this.#queued.get(resource) ?? 0) + (grantedAt - enqueuedAt))
        this.#mark(resource, grantedAt, 1)
      }
      // Mirrors the real lease's idempotent release, so a double release can
      // neither widen the pool nor the tape.
      let released = false
      return {
        release: (): void => {
          if (released) return
          released = true
          const at = this.#clock.now()
          for (const resource of canonical) this.#mark(resource, at, -1)
          lease.release()
        },
      }
    })
  }

  /** Contention per pool, in declaration order. Safe to call once the run ended. */
  contention(): PoolContention[] {
    return this.#resources.map((resource) => this.#summarize(resource))
  }

  #mark(resource: string, at: number, delta: 1 | -1): void {
    this.#occupancy.push({ resource, at, delta, seq: (this.#seq += 1) })
  }

  #summarize(resource: string): PoolContention {
    const events = this.#occupancy
      .filter((event) => event.resource === resource)
      .sort((a, b) => a.at - b.at || a.seq - b.seq)

    const capacity = this.capacity(resource)
    let held = 0
    let peakHeld = 0
    let busyMs = 0
    let saturatedMs = 0
    let previous = events[0]?.at ?? 0

    for (const event of events) {
      const span = event.at - previous
      if (held > 0) busyMs += span
      if (held >= capacity) saturatedMs += span
      previous = event.at
      held += event.delta
      peakHeld = Math.max(peakHeld, held)
    }

    return {
      resource,
      capacity,
      peakHeld,
      busyMs,
      saturatedMs,
      queuedMs: this.#queued.get(resource) ?? 0,
    }
  }
}
