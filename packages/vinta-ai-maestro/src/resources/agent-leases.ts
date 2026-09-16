/**
 * Renewable resource leases for commands an agent runs inside its turn.
 *
 * The scheduler already takes gate resources through `ResourcePools`, but an
 * agent's inner loop used to have no route to the same pools. This broker is
 * that route. It deliberately owns no capacity itself: every grant is the
 * existing pool's all-or-nothing, canonically ordered lease.
 *
 * A grant expires unless its client renews it. The CLI renews while its child
 * command is alive, so expiry means the process that knew about the lease is
 * gone or disconnected. Releasing the pool lease and the journal rows in one
 * place keeps those two views from drifting.
 *
 * That same place is where the grant is *announced*. The `leases` table is not
 * a projection of anything, so a row written into it tells no watching client
 * that capacity moved — and the run view only re-reads the daemon's snapshot
 * when an event arrives. An agent taking and dropping a semaphore therefore
 * used to be invisible until some unrelated event happened along, which made a
 * moving queue look stalled for exactly the waits that are longest. Both edges
 * are journalled here, next to the table write they describe.
 */
import { randomUUID } from 'node:crypto'
import type { AgentLeasePhase } from '../journal/events.ts'
import type { Journal } from '../journal/journal.ts'
import type { Lease, PoolWait, ResourcePools } from './pools.ts'

export const DEFAULT_AGENT_LEASE_TTL_MS = 30_000

/**
 * How long a parked wait survives with nobody hopping on it.
 *
 * The client's cadence sets the floor: it is away for `RETRY_MS` (500ms)
 * between hops, so anything in that neighbourhood would reap waits that are
 * behaving perfectly and hand the starvation straight back. The ceiling is only
 * how long a pool may hold a slot for a client that died mid-wait — a grant
 * that lands on a parked wait is real capacity, so this cannot be unbounded.
 * A minute is two orders of magnitude clear of the cadence and still short
 * enough that a killed agent does not wedge a capacity-1 semaphore for long.
 */
export const DEFAULT_PARKED_WAIT_TTL_MS = 60_000
export const MAESTRO_URL_ENV = 'VINTA_AI_MAESTRO_URL'
export const MAESTRO_TOKEN_ENV = 'VINTA_AI_MAESTRO_TOKEN'
export const MAESTRO_RUN_ENV = 'VINTA_AI_MAESTRO_RUN_ID'
export const MAESTRO_NODE_ENV = 'VINTA_AI_MAESTRO_NODE_ID'

export interface AgentLeaseGrant {
  readonly leaseId: string
  readonly expiresAt: number
  readonly ttlMs: number
}

/**
 * Still queued — and `waitToken` is the place in the queue, not just a
 * correlation id. Handing it back on the next hop is what stops the wait from
 * being re-queued at the tail.
 */
export interface AgentLeaseWaiting {
  readonly waiting: true
  readonly waitToken: string
}

export type AgentLeaseHop = AgentLeaseGrant | AgentLeaseWaiting

export interface AgentLeaseBrokerOptions {
  readonly ttlMs?: number
  /** How long a parked wait survives unattended. See `DEFAULT_PARKED_WAIT_TTL_MS`. */
  readonly parkedWaitTtlMs?: number
  readonly now?: () => number
  readonly id?: () => string
  readonly setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout
  readonly clearTimer?: (timer: NodeJS.Timeout) => void
}

interface HeldLease {
  readonly id: string
  readonly holderNode: string
  readonly resources: readonly string[]
  readonly lease: Lease
  expiresAt: number
  timer: NodeJS.Timeout
}

/** One client's place in the pool queue, between two of its hops. */
interface ParkedWait {
  readonly id: string
  readonly holderNode: string
  readonly resources: readonly string[]
  readonly wait: PoolWait
  /** Absent while a hop is actually watching; set when the client is away. */
  reaper: NodeJS.Timeout | undefined
}

export class AgentLeaseBroker {
  readonly #pools: Pick<ResourcePools, 'acquire' | 'wait'>
  readonly #journal: Pick<Journal, 'acquireLease' | 'releaseLease' | 'append'>
  readonly #runId: string
  readonly #ttlMs: number
  readonly #parkedWaitTtlMs: number
  readonly #now: () => number
  readonly #id: () => string
  readonly #setTimer: (callback: () => void, delayMs: number) => NodeJS.Timeout
  readonly #clearTimer: (timer: NodeJS.Timeout) => void
  readonly #held = new Map<string, HeldLease>()
  readonly #parked = new Map<string, ParkedWait>()
  #closed = false

  /**
   * `runId` is required rather than inferred from the holder node: an event is
   * keyed by its run, and a broker serves exactly one — the daemon holds one
   * per `DaemonRun`. Deriving it from the journal per grant would be a lookup
   * to recover something the caller already knew.
   */
  constructor(
    pools: Pick<ResourcePools, 'acquire' | 'wait'>,
    journal: Pick<Journal, 'acquireLease' | 'releaseLease' | 'append'>,
    runId: string,
    options: AgentLeaseBrokerOptions = {},
  ) {
    this.#pools = pools
    this.#journal = journal
    this.#runId = runId
    this.#ttlMs = options.ttlMs ?? DEFAULT_AGENT_LEASE_TTL_MS
    this.#parkedWaitTtlMs = options.parkedWaitTtlMs ?? DEFAULT_PARKED_WAIT_TTL_MS
    this.#now = options.now ?? (() => Date.now())
    this.#id = options.id ?? randomUUID
    this.#setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.#clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer))
  }

  /**
   * One instalment of a client-side wait: watch the queue for `withinMs`, and
   * if it has not reached us by then say so in a way the client can resume.
   *
   * The endpoint used to do this with `acquire(..., { signal })` and an abort
   * at the hop boundary, which left the queue and re-entered at the tail on the
   * next POST. A gate run holds a capacity-1 semaphore for minutes, so a client
   * hopping every fifteen seconds was overtaken by every in-process waiter that
   * arrived during a hop, over and over, with no bound on how long that lasts —
   * the `pools.ts` aging rule cannot help, because it reserves against waiters
   * *behind* the aged one and these are in front. Holding the `PoolWait` across
   * hops is what makes the arrival order the client actually experiences match
   * the one the pool promises.
   */
  async hop(
    resources: readonly string[],
    holderNode: string,
    options: { readonly waitToken?: string; readonly withinMs: number },
  ): Promise<AgentLeaseHop> {
    if (this.#closed) throw new Error('agent lease broker is closed')

    const canonical = [...new Set(resources)].sort()
    const parked =
      this.#resume(options.waitToken, canonical, holderNode) ?? this.#fresh(canonical, holderNode)
    this.#parked.set(parked.id, parked)
    // Attended again: the client is demonstrably alive for the length of this
    // hop, so the reaper has nothing to decide until it goes away once more.
    if (parked.reaper !== undefined) {
      this.#clearTimer(parked.reaper)
      parked.reaper = undefined
    }

    const lease = await this.#within(parked.wait.granted, options.withinMs)
    if (lease === null) return this.#park(parked)

    // One wait is one place in the queue and therefore one lease. Two hops can
    // be watching the same token — a client that retried without waiting for
    // its answer — and they share a single `granted` promise, so both see this
    // lease. Only the one that still owns the parked entry may mint a grant
    // from it; the other must not, and must not release it either, because the
    // object it is holding is the winner's capacity. It starts a new wait.
    if (this.#parked.get(parked.id) !== parked) {
      return this.#park(this.#fresh(canonical, holderNode))
    }

    this.#parked.delete(parked.id)
    if (this.#closed) {
      lease.release()
      throw new Error('agent lease broker is closed')
    }
    return this.#grant(lease, canonical, holderNode)
  }

  /**
   * An unbounded wait, for a caller that can hold one — in-process, with no
   * request timing out over its shoulder. `signal` leaves the queue rather than
   * cancelling a grant; a caller that means to come back wants `hop` instead,
   * which keeps the place in line that this one gives up.
   */
  async acquire(
    resources: readonly string[],
    holderNode: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<AgentLeaseGrant> {
    if (this.#closed) throw new Error('agent lease broker is closed')

    const canonical = [...new Set(resources)].sort()
    const lease = await this.#pools.acquire(
      canonical,
      options.signal === undefined ? {} : { signal: options.signal },
    )
    if (this.#closed) {
      lease.release()
      throw new Error('agent lease broker is closed')
    }
    return this.#grant(lease, canonical, holderNode)
  }

  /** A new place in the queue. Taken now — the position is the thing being bought. */
  #fresh(canonical: readonly string[], holderNode: string): ParkedWait {
    return {
      id: this.#id(),
      holderNode,
      resources: canonical,
      wait: this.#pools.wait(canonical),
      reaper: undefined,
    }
  }

  /** Leaves the wait in the queue, unattended, on a clock. */
  #park(entry: ParkedWait): AgentLeaseWaiting {
    this.#parked.set(entry.id, entry)
    entry.reaper = this.#setTimer(() => {
      if (this.#parked.get(entry.id) !== entry) return
      this.#parked.delete(entry.id)
      entry.wait.abandon()
    }, this.#parkedWaitTtlMs)
    return { waiting: true, waitToken: entry.id }
  }

  /**
   * The parked wait a token names, if it is still ours to resume.
   *
   * A token that does not match is not an error worth refusing over — a daemon
   * restart, or a reaped wait, leaves a client holding one — so the caller
   * simply starts a fresh wait. The resources and holder are checked because a
   * token is a place in the queue for *one* request: honouring it for a
   * different one would let a node inherit someone else's seniority.
   */
  #resume(
    token: string | undefined,
    canonical: readonly string[],
    holderNode: string,
  ): ParkedWait | undefined {
    if (token === undefined) return undefined
    const parked = this.#parked.get(token)
    if (parked === undefined) return undefined
    if (parked.holderNode !== holderNode) return undefined
    if (parked.resources.length !== canonical.length) return undefined
    if (parked.resources.some((name, at) => name !== canonical[at])) return undefined
    return parked
  }

  /** The lease if it lands inside `ms`, else `null` — the wait itself is untouched. */
  #within(granted: Promise<Lease>, ms: number): Promise<Lease | null> {
    return new Promise<Lease | null>((resolve) => {
      let settled = false
      const timer = this.#setTimer(() => {
        if (settled) return
        settled = true
        resolve(null)
      }, ms)
      void granted.then((lease) => {
        if (settled) return
        settled = true
        this.#clearTimer(timer)
        resolve(lease)
      })
    })
  }

  /** Bookkeeping shared by both routes to a grant: expiry timer and journal. */
  #grant(lease: Lease, canonical: readonly string[], holderNode: string): AgentLeaseGrant {
    const id = this.#id()
    const expiresAt = this.#now() + this.#ttlMs
    const held: HeldLease = {
      id,
      holderNode,
      resources: canonical,
      lease,
      expiresAt,
      timer: this.#timer(id, expiresAt),
    }
    this.#held.set(id, held)
    for (const resource of canonical) {
      this.#journal.acquireLease(resource, holderNode, id, expiresAt)
    }
    // After the rows, so a client woken by this event and reading the snapshot
    // finds the holder it was told about already there.
    this.#announce(holderNode, 'acquired', id, canonical)
    return { leaseId: id, expiresAt, ttlMs: this.#ttlMs }
  }

  /**
   * No event. A renewal moves `expires_at` on a lease whose holder set was
   * announced when it was granted, so there is no transition to report — and
   * one row per heartbeat, per lease, for the length of every command an agent
   * runs would drown the two edges that are transitions.
   */
  renew(id: string): AgentLeaseGrant | null {
    const held = this.#held.get(id)
    if (held === undefined) return null

    this.#clearTimer(held.timer)
    held.expiresAt = this.#now() + this.#ttlMs
    held.timer = this.#timer(id, held.expiresAt)
    for (const resource of held.resources) {
      this.#journal.acquireLease(resource, held.holderNode, id, held.expiresAt)
    }
    return { leaseId: id, expiresAt: held.expiresAt, ttlMs: this.#ttlMs }
  }

  /** Idempotent: expiry and a client's `finally` may race. */
  release(id: string): void {
    const held = this.#held.get(id)
    if (held === undefined) return

    this.#held.delete(id)
    this.#clearTimer(held.timer)
    held.lease.release()
    for (const resource of held.resources) {
      this.#journal.releaseLease(resource, held.holderNode, id)
    }
    // The `#held` delete above is what makes this idempotent, so the event is
    // written once per lease however the release arrived — a client's
    // `finally`, the expiry timer, or `close` — and never twice when two of
    // them race.
    this.#announce(held.holderNode, 'released', id, held.resources)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const id of [...this.#held.keys()]) this.release(id)
    // Parked waits are queue entries, and one of them may already have been
    // granted while nobody was watching it. Both are the run's capacity.
    for (const parked of [...this.#parked.values()]) {
      this.#parked.delete(parked.id)
      if (parked.reaper !== undefined) this.#clearTimer(parked.reaper)
      parked.wait.abandon()
    }
  }

  /** One edge, as identifiers: pool ids, the holder's node id, the lease id. */
  #announce(
    holderNode: string,
    phase: AgentLeasePhase,
    leaseId: string,
    resources: readonly string[],
  ): void {
    this.#journal.append({
      runId: this.#runId,
      nodeId: holderNode,
      type: 'agent_lease',
      payload: { phase, lease_id: leaseId, resources: [...resources] },
    })
  }

  #timer(id: string, expiresAt: number): NodeJS.Timeout {
    return this.#setTimer(() => {
      const held = this.#held.get(id)
      // A stale timer from before a renewal must not release the renewed grant.
      if (held !== undefined && held.expiresAt === expiresAt) this.release(id)
    }, Math.max(0, expiresAt - this.#now()))
  }
}
