/**
 * Named capacity pools — the generalization that makes the costly-gate queue
 * fall out for free. The worktree lane pool is just the pool named `lane`;
 * nothing here knows what a lane is.
 *
 * Four properties from §6 are enforced rather than documented, because each
 * one is a bug that only shows up under load:
 *
 * - **Canonical acquisition order.** Callers declare what they need in
 *   whatever order reads well; we sort it. Two holders wanting the same pair
 *   in opposite declared orders is the textbook deadlock, and normalizing the
 *   order at the door is what makes it unreachable.
 * - **All-or-nothing.** A holder that cannot get everything acquires nothing.
 *   A partial acquisition that then waits holds slots hostage to a wait it
 *   cannot end.
 * - **FIFO with aging.** Strict FIFO head-of-line-blocks: a phase queued for a
 *   single `test-suite` slot would stall a phase that only wants a free lane,
 *   and `capacity(lane) > capacity(test-suite)` is the normal configuration
 *   because a node holds its lane while queued for a gate. So later holders
 *   may bypass a blocked one — but only until it has aged, at which point it
 *   reserves what it needs and nobody passes it again. Bypass is therefore
 *   bounded in time, which is what "not starved" actually means.
 * - **Idempotent release.** A slot released twice must not widen the pool, and
 *   a slot never released narrows it permanently.
 */
import type { Resource } from '../types.ts'

/** Grant token. `release` is idempotent, so `finally { lease.release() }` is safe. */
export interface Lease {
  release(): void
}

export interface ResourcePoolsOptions {
  /**
   * How long a blocked holder may be bypassed before it reserves what it
   * needs. Zero is strict FIFO; the default trades a small bounded unfairness
   * for keeping otherwise-idle capacity busy.
   */
  readonly agingMs?: number
}

const DEFAULT_AGING_MS = 500

interface Pool {
  readonly capacity: number
  held: number
}

interface Waiter {
  /** Deduplicated and lexicographically sorted — the canonical order. */
  readonly needs: readonly string[]
  readonly enqueuedAt: number
  readonly grant: (lease: Lease) => void
}

export class ResourcePools {
  readonly #pools: Map<string, Pool>
  readonly #agingMs: number
  #queue: Waiter[] = []

  constructor(resources: Readonly<Record<string, Resource>>, options: ResourcePoolsOptions = {}) {
    this.#pools = new Map(
      Object.entries(resources).map(([id, r]) => [id, { capacity: r.capacity, held: 0 }]),
    )
    this.#agingMs = options.agingMs ?? DEFAULT_AGING_MS
  }

  /**
   * Resolves once every pool in `needs` has a free slot, all taken together.
   * The declared order is discarded in favour of the canonical one.
   */
  acquire(needs: readonly string[]): Promise<Lease> {
    const canonical = [...new Set(needs)].sort()
    for (const name of canonical) this.#pool(name)

    return new Promise<Lease>((grant) => {
      this.#queue.push({ needs: canonical, enqueuedAt: Date.now(), grant })
      this.#pump()
    })
  }

  /** Slots currently taken in `name`. Never exceeds its capacity. */
  held(name: string): number {
    return this.#pool(name).held
  }

  capacity(name: string): number {
    return this.#pool(name).capacity
  }

  /** Holders enqueued and not yet granted. */
  get waiting(): number {
    return this.#queue.length
  }

  /**
   * Walks the queue in arrival order granting whoever fits. A blocked holder
   * that has aged past `agingMs` reserves its pools against everyone behind
   * it, so the scan can only ever bypass holders that are still young.
   */
  #pump(): void {
    const now = Date.now()
    const reserved = new Set<string>()
    const granted = new Set<Waiter>()

    for (const waiter of this.#queue) {
      const fits = waiter.needs.every(
        (name) => !reserved.has(name) && this.#pool(name).held < this.#pool(name).capacity,
      )
      if (fits) {
        for (const name of waiter.needs) this.#pool(name).held += 1
        granted.add(waiter)
        continue
      }
      if (now - waiter.enqueuedAt >= this.#agingMs) {
        for (const name of waiter.needs) reserved.add(name)
      }
    }

    if (granted.size === 0) return
    this.#queue = this.#queue.filter((waiter) => !granted.has(waiter))
    // Resolving is a microtask, so no waiter re-enters #pump mid-scan.
    for (const waiter of granted) waiter.grant(this.#lease(waiter.needs))
  }

  #lease(needs: readonly string[]): Lease {
    let released = false
    return {
      release: (): void => {
        if (released) return
        released = true
        for (const name of needs) this.#pool(name).held -= 1
        this.#pump()
      },
    }
  }

  #pool(name: string): Pool {
    const pool = this.#pools.get(name)
    if (pool === undefined) throw new Error(`unknown resource pool "${name}"`)
    return pool
  }
}
