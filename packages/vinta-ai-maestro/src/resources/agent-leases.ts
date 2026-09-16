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
import type { Lease, ResourcePools } from './pools.ts'

export const DEFAULT_AGENT_LEASE_TTL_MS = 30_000
export const MAESTRO_URL_ENV = 'VINTA_AI_MAESTRO_URL'
export const MAESTRO_TOKEN_ENV = 'VINTA_AI_MAESTRO_TOKEN'
export const MAESTRO_RUN_ENV = 'VINTA_AI_MAESTRO_RUN_ID'
export const MAESTRO_NODE_ENV = 'VINTA_AI_MAESTRO_NODE_ID'

export interface AgentLeaseGrant {
  readonly leaseId: string
  readonly expiresAt: number
  readonly ttlMs: number
}

export interface AgentLeaseBrokerOptions {
  readonly ttlMs?: number
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

export class AgentLeaseBroker {
  readonly #pools: Pick<ResourcePools, 'acquire'>
  readonly #journal: Pick<Journal, 'acquireLease' | 'releaseLease' | 'append'>
  readonly #runId: string
  readonly #ttlMs: number
  readonly #now: () => number
  readonly #id: () => string
  readonly #setTimer: (callback: () => void, delayMs: number) => NodeJS.Timeout
  readonly #clearTimer: (timer: NodeJS.Timeout) => void
  readonly #held = new Map<string, HeldLease>()
  #closed = false

  /**
   * `runId` is required rather than inferred from the holder node: an event is
   * keyed by its run, and a broker serves exactly one — the daemon holds one
   * per `DaemonRun`. Deriving it from the journal per grant would be a lookup
   * to recover something the caller already knew.
   */
  constructor(
    pools: Pick<ResourcePools, 'acquire'>,
    journal: Pick<Journal, 'acquireLease' | 'releaseLease' | 'append'>,
    runId: string,
    options: AgentLeaseBrokerOptions = {},
  ) {
    this.#pools = pools
    this.#journal = journal
    this.#runId = runId
    this.#ttlMs = options.ttlMs ?? DEFAULT_AGENT_LEASE_TTL_MS
    this.#now = options.now ?? (() => Date.now())
    this.#id = options.id ?? randomUUID
    this.#setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.#clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer))
  }

  /**
   * `signal` leaves the queue rather than cancelling a grant. The endpoint uses
   * it to answer a waiting client on a short cycle instead of holding one HTTP
   * request open for the whole wait — see `AcquireAborted`.
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
