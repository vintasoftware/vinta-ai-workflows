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

/**
 * A wait that was abandoned before it was granted. Not a failure of the pool:
 * the caller left the queue, and nothing was taken.
 */
export class AcquireAborted extends Error {
  constructor() {
    super('the wait for resources was abandoned before it was granted')
    this.name = 'AcquireAborted'
  }
}

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
  /**
   * Source of the wall clock the aging window is measured against. Defaults to
   * the system clock.
   *
   * It is a seam because aging is the one policy here that depends on time
   * passing, and a consumer driving a virtual clock (the dry-run projection,
   * §13.1) could otherwise never reach the bypass — it would silently run
   * strict FIFO and report a schedule the real pool would not produce.
   */
  readonly now?: () => number
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
  readonly #now: () => number
  #queue: Waiter[] = []

  constructor(resources: Readonly<Record<string, Resource>>, options: ResourcePoolsOptions = {}) {
    this.#pools = new Map(
      Object.entries(resources).map(([id, r]) => [id, { capacity: r.capacity, held: 0 }]),
    )
    this.#agingMs = options.agingMs ?? DEFAULT_AGING_MS
    this.#now = options.now ?? (() => Date.now())
  }

  /**
   * Resolves once every pool in `needs` has a free slot, all taken together.
   * The declared order is discarded in favour of the canonical one.
   *
   * `signal` gives a caller a way *out of the queue*, which the agent lease
   * endpoint needs: it answers a waiting client every few seconds rather than
   * holding one HTTP request open for an hour, and a caller that walks away
   * without leaving the queue would be granted a slot nobody is waiting for.
   * Aborting after the grant is too late by construction — the waiter is off
   * the queue and holding real capacity — so it is ignored there, and the lease
   * is released by whoever owns it.
   */
  acquire(needs: readonly string[], options: { readonly signal?: AbortSignal } = {}): Promise<Lease> {
    const canonical = [...new Set(needs)].sort()
    for (const name of canonical) this.#pool(name)
    const { signal } = options

    return new Promise<Lease>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new AcquireAborted())
        return
      }

      const waiter: Waiter = {
        needs: canonical,
        enqueuedAt: this.#now(),
        grant: (lease) => {
          signal?.removeEventListener('abort', leave)
          resolve(lease)
        },
      }
      // Named, so the grant path can take it off again: a listener left on a
      // long-lived signal is a leak per acquisition, and this one runs once per
      // heavy command in every lane.
      const leave = (): void => {
        const at = this.#queue.indexOf(waiter)
        if (at === -1) return
        this.#queue.splice(at, 1)
        reject(new AcquireAborted())
      }
      signal?.addEventListener('abort', leave, { once: true })

      this.#queue.push(waiter)
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
    const now = this.#now()
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
