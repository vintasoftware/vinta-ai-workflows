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
 *   bounded in time, which is what "not starved" actually means. Note the
 *   precondition: the bound is on a waiter that *stays queued*. One that leaves
 *   and comes back is a new arrival at the tail, and re-arriving often enough
 *   is unbounded bypass wearing the queue's clothes — see `PoolWait`.
 * - **Idempotent release.** A slot released twice must not widen the pool, and
 *   a slot never released narrows it permanently.
 */
import type { Resource } from '../types.ts'
import type { HostSlot, HostSlots } from './host-slots.ts'

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

/**
 * A place in the queue that outlives the caller currently watching it.
 *
 * `acquire`'s `signal` conflates two things a caller might mean by "stop
 * waiting": *I no longer want this*, and *I have to go answer an HTTP request,
 * but I am coming back*. It only ever implements the first — it splices the
 * waiter out — and the agent-lease endpoint means the second. Re-entering
 * afterwards is not the same wait: `#queue.push` appends, so a waiter that
 * steps out for one hop returns behind everyone who arrived while it was gone,
 * and under sustained contention it can be pushed back every hop forever.
 * Aging does not save it, because aging only reserves pools against waiters
 * *behind* it — the ones that overtook it are in front.
 *
 * So the position itself has to be holdable. A `PoolWait` keeps one queue entry
 * — one `enqueuedAt`, one slot in arrival order — while any number of bounded
 * waits look at it in turn.
 */
export interface PoolWait {
  /**
   * The grant, when the queue reaches this waiter. Awaiting it more than once,
   * or not at all for a while, is the point: it settles on the queue's
   * schedule, not the watcher's.
   */
  readonly granted: Promise<Lease>
  /**
   * Give up the place for good. Idempotent.
   *
   * A wait that was already granted releases the lease, because a grant nobody
   * is coming back for is capacity held by no one — the leak you would trade
   * the starvation for if parking had no way out.
   */
  abandon(): void
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
  /**
   * The machine's slots for the pools declared `scope: host`. Absent, those
   * pools count this run's holders only — which a projection and every test
   * want, since another run on the machine is none of their business.
   */
  readonly hostSlots?: HostSlots
}

const DEFAULT_AGING_MS = 500

/**
 * How often a queue waiting on a host-scoped pool looks again. Another run's
 * release says nothing to this process, so the wait is polled; a full suite
 * is minutes, and two seconds of it is noise.
 */
const HOST_POLL_MS = 2_000

interface Pool {
  capacity: number
  held: number
  /** `scope: host`: a grant also takes one of the machine's slots. */
  readonly host: boolean
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
  readonly #hostSlots: HostSlots | undefined
  #queue: Waiter[] = []
  #poll: ReturnType<typeof setTimeout> | null = null

  constructor(resources: Readonly<Record<string, Resource>>, options: ResourcePoolsOptions = {}) {
    this.#hostSlots = options.hostSlots
    this.#pools = new Map(
      Object.entries(resources).map(([id, r]) => [
        id,
        { capacity: r.capacity, held: 0, host: r.scope === 'host' && this.#hostSlots !== undefined },
      ]),
    )
    this.#agingMs = options.agingMs ?? DEFAULT_AGING_MS
    this.#now = options.now ?? (() => Date.now())
  }

  /**
   * Resolves once every pool in `needs` has a free slot, all taken together.
   * The declared order is discarded in favour of the canonical one.
   *
   * `signal` means *I no longer want this*: it leaves the queue for good and
   * takes nothing. Aborting after the grant is too late by construction — the
   * waiter is off the queue and holding real capacity — so it is ignored there,
   * and the lease is released by whoever owns it.
   *
   * A caller that intends to come back must not use this. Leaving and
   * re-entering appends, which costs it every waiter that arrived meanwhile;
   * `wait` exists so that a wait watched in instalments keeps one place in line.
   */
  acquire(needs: readonly string[], options: { readonly signal?: AbortSignal } = {}): Promise<Lease> {
    const canonical = this.#canonical(needs)
    const { signal } = options
    if (signal?.aborted === true) return Promise.reject(new AcquireAborted())

    const { waiter, granted } = this.#enqueue(canonical)
    if (signal === undefined) return granted

    return new Promise<Lease>((resolve, reject) => {
      // Named, so the grant path can take it off again: a listener left on a
      // long-lived signal is a leak per acquisition, and this one runs once per
      // heavy command in every lane.
      const leave = (): void => {
        if (this.#dequeue(waiter)) reject(new AcquireAborted())
      }
      signal.addEventListener('abort', leave, { once: true })
      void granted.then((lease) => {
        signal.removeEventListener('abort', leave)
        resolve(lease)
      })
    })
  }

  /**
   * Takes a place in the queue and hands back the handle to it, for a caller
   * that will watch the wait in instalments rather than in one `await`.
   *
   * The queue entry is created once, here. Nothing short of `abandon` removes
   * it, which is the whole difference from `acquire(needs, { signal })`.
   */
  wait(needs: readonly string[]): PoolWait {
    const canonical = this.#canonical(needs)
    const { waiter, granted } = this.#enqueue(canonical)
    let abandoned = false

    return {
      granted,
      abandon: (): void => {
        if (abandoned) return
        abandoned = true
        if (this.#dequeue(waiter)) return
        // Past the grant, so the place in the queue is already spent and what
        // is left is real capacity. Give it back.
        void granted.then((lease) => {
          lease.release()
        })
      },
    }
  }

  /** Slots currently taken in `name`. Never exceeds its capacity. */
  held(name: string): number {
    return this.#pool(name).held
  }

  capacity(name: string): number {
    return this.#pool(name).capacity
  }

  /**
   * One more slot in `name`, for good. The one way a capacity changes mid-run:
   * a spare crew member brings its own worktree (`defaults.max_spare_crew`), and
   * a lane pool that stayed at the roster's size would queue the member behind
   * the very phases it was taken on to stop waiting for.
   */
  grow(name: string, by = 1): void {
    this.#pool(name).capacity += by
    this.#pump()
  }

  /** Holders enqueued and not yet granted. */
  get waiting(): number {
    return this.#queue.length
  }

  /** Deduplicated, sorted, and proven to name real pools before anyone queues. */
  #canonical(needs: readonly string[]): readonly string[] {
    const canonical = [...new Set(needs)].sort()
    for (const name of canonical) this.#pool(name)
    return canonical
  }

  /** Takes the place in line. The returned promise settles only on a grant. */
  #enqueue(canonical: readonly string[]): { waiter: Waiter; granted: Promise<Lease> } {
    let grant!: (lease: Lease) => void
    const granted = new Promise<Lease>((resolve) => {
      grant = resolve
    })
    const waiter: Waiter = { needs: canonical, enqueuedAt: this.#now(), grant }
    this.#queue.push(waiter)
    this.#pump()
    return { waiter, granted }
  }

  /** Whether the waiter was still queued — false once it has been granted. */
  #dequeue(waiter: Waiter): boolean {
    const at = this.#queue.indexOf(waiter)
    if (at === -1) return false
    this.#queue.splice(at, 1)
    return true
  }

  /**
   * Walks the queue in arrival order granting whoever fits. A blocked holder
   * that has aged past `agingMs` reserves its pools against everyone behind
   * it, so the scan can only ever bypass holders that are still young.
   */
  #pump(): void {
    const now = this.#now()
    const reserved = new Set<string>()
    const granted = new Map<Waiter, readonly HostSlot[]>()

    for (const waiter of this.#queue) {
      const fits = waiter.needs.every(
        (name) => !reserved.has(name) && this.#pool(name).held < this.#pool(name).capacity,
      )
      // Taken after this run's own counts allow it, and all-or-nothing like
      // them: a waiter that gets one machine slot and not the next gives the
      // first straight back.
      const slots = fits ? this.#hostSlotsFor(waiter.needs) : null
      if (slots !== null) {
        for (const name of waiter.needs) this.#pool(name).held += 1
        granted.set(waiter, slots)
        continue
      }
      if (now - waiter.enqueuedAt >= this.#agingMs) {
        for (const name of waiter.needs) reserved.add(name)
      }
    }

    if (granted.size > 0) {
      this.#queue = this.#queue.filter((waiter) => !granted.has(waiter))
      // Resolving is a microtask, so no waiter re-enters #pump mid-scan.
      for (const [waiter, slots] of granted) waiter.grant(this.#lease(waiter.needs, slots))
    }
    this.#schedulePoll()
  }

  /** One machine slot per host-scoped pool in `needs`, or null with none kept. */
  #hostSlotsFor(needs: readonly string[]): readonly HostSlot[] | null {
    const taken: HostSlot[] = []
    for (const name of needs) {
      const pool = this.#pool(name)
      if (!pool.host || this.#hostSlots === undefined) continue
      const slot = this.#hostSlots.tryTake(name, pool.capacity)
      if (slot === null) {
        for (const kept of taken) kept.release()
        return null
      }
      taken.push(slot)
    }
    return taken
  }

  /** Polls while someone waits on a host-scoped pool; another run's release is not an event here. */
  #schedulePoll(): void {
    const waitingOnHost = this.#queue.some((waiter) => waiter.needs.some((name) => this.#pool(name).host))
    if (!waitingOnHost) {
      if (this.#poll !== null) clearTimeout(this.#poll)
      this.#poll = null
      return
    }
    if (this.#poll !== null) return
    this.#poll = setTimeout(() => {
      this.#poll = null
      this.#pump()
    }, HOST_POLL_MS)
    // A wait on another run must not keep this process alive by itself.
    this.#poll.unref?.()
  }

  #lease(needs: readonly string[], slots: readonly HostSlot[] = []): Lease {
    let released = false
    return {
      release: (): void => {
        if (released) return
        released = true
        for (const slot of slots) slot.release()
        for (const name of needs) this.#pool(name).held -= 1
        this.#pump()
      },
    }
  }

  /** Who else on this machine holds `name`'s slots, for a waiter to be told; empty for a run-scoped pool. */
  hostHolders(name: string): readonly { readonly pid: number; readonly run: string }[] {
    const pool = this.#pool(name)
    if (!pool.host || this.#hostSlots === undefined) return []
    return this.#hostSlots.holders(name, pool.capacity)
  }

  #pool(name: string): Pool {
    const pool = this.#pools.get(name)
    if (pool === undefined) throw new Error(`unknown resource pool "${name}"`)
    return pool
  }
}
