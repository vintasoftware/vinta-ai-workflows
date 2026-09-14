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
 */
import { randomUUID } from 'node:crypto'
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
  readonly #journal: Pick<Journal, 'acquireLease' | 'releaseLease'>
  readonly #ttlMs: number
  readonly #now: () => number
  readonly #id: () => string
  readonly #setTimer: (callback: () => void, delayMs: number) => NodeJS.Timeout
  readonly #clearTimer: (timer: NodeJS.Timeout) => void
  readonly #held = new Map<string, HeldLease>()
  #closed = false

  constructor(
    pools: Pick<ResourcePools, 'acquire'>,
    journal: Pick<Journal, 'acquireLease' | 'releaseLease'>,
    options: AgentLeaseBrokerOptions = {},
  ) {
    this.#pools = pools
    this.#journal = journal
    this.#ttlMs = options.ttlMs ?? DEFAULT_AGENT_LEASE_TTL_MS
    this.#now = options.now ?? (() => Date.now())
    this.#id = options.id ?? randomUUID
    this.#setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.#clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer))
  }

  async acquire(resources: readonly string[], holderNode: string): Promise<AgentLeaseGrant> {
    if (this.#closed) throw new Error('agent lease broker is closed')

    const canonical = [...new Set(resources)].sort()
    const lease = await this.#pools.acquire(canonical)
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
    return { leaseId: id, expiresAt, ttlMs: this.#ttlMs }
  }

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
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const id of [...this.#held.keys()]) this.release(id)
  }

  #timer(id: string, expiresAt: number): NodeJS.Timeout {
    return this.#setTimer(() => {
      const held = this.#held.get(id)
      // A stale timer from before a renewal must not release the renewed grant.
      if (held !== undefined && held.expiresAt === expiresAt) this.release(id)
    }, Math.max(0, expiresAt - this.#now()))
  }
}
