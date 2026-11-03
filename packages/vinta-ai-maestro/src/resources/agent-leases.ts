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
/**
 * The agent session a command was started from, one id per session the
 * scheduler drains. A node outlives its sessions, so the node alone cannot say
 * whether the process asking is still part of the work: a command backgrounded
 * with `&` is reparented when its session ends and keeps asking for as long as
 * nobody stops it. The id is what lets the daemon tell that command apart from
 * the node's next session, and refuse it.
 */
export const MAESTRO_TURN_ENV = 'VINTA_AI_MAESTRO_TURN_ID'

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

/**
 * Who is asking, past the node: the session it was started from and the
 * process doing the asking. Both optional, because a client built before
 * either existed still gets a lease — it just cannot be told apart from the
 * node's other commands, or named to a waiter.
 */
export interface AgentLeaseCaller {
  readonly turn?: string
  readonly pid?: number
}

/** One lease this broker has granted, as a waiter or a gate is told about it. */
export interface AgentLeaseHeld {
  readonly leaseId: string
  readonly holderNode: string
  readonly resources: readonly string[]
  readonly turn?: string
  readonly pid?: number
}

/**
 * A wait the broker ended rather than granted, as a code the route relays.
 *
 * `turn_ended`: the session the command came from has ended, so nothing is
 * waiting for its answer. `run_pausing` / `run_stopping`: the run is draining,
 * and a pause waits for every node to reach a step boundary, which an agent
 * turn blocked behind a semaphore never does.
 */
export class AgentLeaseRefusal extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

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
  readonly caller: AgentLeaseCaller
  expiresAt: number
  timer: NodeJS.Timeout
}

/** One client's place in the pool queue, between two of its hops. */
interface ParkedWait {
  readonly id: string
  readonly holderNode: string
  readonly resources: readonly string[]
  readonly wait: PoolWait
  readonly turn: string | undefined
  /** Absent while a hop is actually watching; set when the client is away. */
  reaper: NodeJS.Timeout | undefined
  /** Settles with a refusal code when the wait is ended without a grant. */
  readonly cancelled: Promise<string>
  readonly cancel: (code: string) => void
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
  /**
   * Sessions that have ended. Kept for the run, because the requests this
   * exists to refuse arrive *after* the end — an orphaned command's next hop —
   * and an id is a few dozen bytes against a run's few hundred sessions.
   */
  readonly #endedTurns = new Set<string>()
  /** Set by `halt`: the code every wait is now answered with. */
  #halted: string | null = null
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
    options: AgentLeaseCaller & { readonly waitToken?: string; readonly withinMs: number },
  ): Promise<AgentLeaseHop> {
    if (this.#closed) throw new Error('agent lease broker is closed')
    this.#admit(options.turn)

    const canonical = [...new Set(resources)].sort()
    const parked =
      this.#resume(options.waitToken, canonical, holderNode) ??
      this.#fresh(canonical, holderNode, options.turn)
    this.#parked.set(parked.id, parked)
    // Attended again: the client is demonstrably alive for the length of this
    // hop, so the reaper has nothing to decide until it goes away once more.
    if (parked.reaper !== undefined) {
      this.#clearTimer(parked.reaper)
      parked.reaper = undefined
    }

    const lease = await this.#within(parked, options.withinMs)
    if (lease === null) return this.#park(parked)
    if (typeof lease === 'string') throw new AgentLeaseRefusal(lease)

    // One wait is one place in the queue and therefore one lease. Two hops can
    // be watching the same token — a client that retried without waiting for
    // its answer — and they share a single `granted` promise, so both see this
    // lease. Only the one that still owns the parked entry may mint a grant
    // from it; the other must not, and must not release it either, because the
    // object it is holding is the winner's capacity. It starts a new wait.
    if (this.#parked.get(parked.id) !== parked) {
      return this.#park(this.#fresh(canonical, holderNode, options.turn))
    }

    this.#parked.delete(parked.id)
    if (this.#closed) {
      lease.release()
      throw new Error('agent lease broker is closed')
    }
    return this.#grant(lease, canonical, holderNode, options)
  }

  /**
   * Refuses a caller whose answer nobody is waiting for: a session that has
   * ended, or anyone once the run is draining. Checked on every hop, so a
   * client that slept through the moment its wait was cancelled is told the
   * same thing when it comes back.
   */
  #admit(turn: string | undefined): void {
    if (this.#halted !== null) throw new AgentLeaseRefusal(this.#halted)
    if (turn !== undefined && this.#endedTurns.has(turn)) throw new AgentLeaseRefusal('turn_ended')
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
    options: AgentLeaseCaller & { readonly signal?: AbortSignal } = {},
  ): Promise<AgentLeaseGrant> {
    if (this.#closed) throw new Error('agent lease broker is closed')
    this.#admit(options.turn)

    const canonical = [...new Set(resources)].sort()
    const lease = await this.#pools.acquire(
      canonical,
      options.signal === undefined ? {} : { signal: options.signal },
    )
    if (this.#closed) {
      lease.release()
      throw new Error('agent lease broker is closed')
    }
    return this.#grant(lease, canonical, holderNode, options)
  }

  /** A new place in the queue. Taken now — the position is the thing being bought. */
  #fresh(canonical: readonly string[], holderNode: string, turn: string | undefined): ParkedWait {
    let cancel!: (code: string) => void
    const cancelled = new Promise<string>((resolve) => {
      cancel = resolve
    })
    return {
      id: this.#id(),
      holderNode,
      resources: canonical,
      wait: this.#pools.wait(canonical),
      turn,
      reaper: undefined,
      cancelled,
      cancel,
    }
  }

  /** Takes a wait out of the queue for good, telling any hop watching it why. */
  #cancel(entry: ParkedWait, code: string): void {
    if (this.#parked.get(entry.id) !== entry) return
    this.#parked.delete(entry.id)
    if (entry.reaper !== undefined) this.#clearTimer(entry.reaper)
    entry.wait.abandon()
    entry.cancel(code)
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
   * different one would let a node inherit someone else's place in line.
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

  /**
   * The lease if it lands inside `ms`, `null` if it does not, or the code the
   * wait was cancelled with. A timeout leaves the wait itself untouched.
   */
  #within(entry: ParkedWait, ms: number): Promise<Lease | string | null> {
    return new Promise<Lease | string | null>((resolve) => {
      let settled = false
      const timer = this.#setTimer(() => {
        if (settled) return
        settled = true
        resolve(null)
      }, ms)
      const settle = (outcome: Lease | string): void => {
        if (settled) return
        settled = true
        this.#clearTimer(timer)
        resolve(outcome)
      }
      void entry.wait.granted.then(settle)
      void entry.cancelled.then(settle)
    })
  }

  /** Bookkeeping shared by both routes to a grant: expiry timer and journal. */
  #grant(
    lease: Lease,
    canonical: readonly string[],
    holderNode: string,
    caller: AgentLeaseCaller,
  ): AgentLeaseGrant {
    const id = this.#id()
    const expiresAt = this.#now() + this.#ttlMs
    const held: HeldLease = {
      id,
      holderNode,
      resources: canonical,
      lease,
      caller: {
        ...(caller.turn === undefined ? {} : { turn: caller.turn }),
        ...(caller.pid === undefined ? {} : { pid: caller.pid }),
      },
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

  /**
   * Every lease granted and not yet released, in grant order: the holder index
   * a waiter is told about and a gate is checked against. A node asking for a
   * gate whose pool it already holds through `with` is asking to wait on
   * itself.
   */
  held(): readonly AgentLeaseHeld[] {
    return [...this.#held.values()].map((held) => ({
      leaseId: held.id,
      holderNode: held.holderNode,
      resources: held.resources,
      ...held.caller,
    }))
  }

  /**
   * A session has ended, so its commands have nobody to answer to: what they
   * hold is released, what they are queued for is cancelled, and whatever they
   * ask from now on is refused `turn_ended`.
   *
   * Adapters cancel the background work they track when a session ends (§7),
   * but a command an agent backgrounded with a shell `&` is not tracked. It is
   * reparented and keeps its lease, or its place in the queue, for as long as
   * it lives. One run had nine of these, up to fifty-five minutes old, queued
   * in front of the lanes that were still working. A held lease is released
   * too: the process holding it belongs to nobody now, and its client stops
   * the command when the next renewal is refused.
   */
  endTurn(holderNode: string, turn: string): void {
    this.#endedTurns.add(turn)
    for (const held of [...this.#held.values()]) {
      if (held.holderNode === holderNode && held.caller.turn === turn) this.release(held.id)
    }
    for (const parked of [...this.#parked.values()]) {
      if (parked.holderNode === holderNode && parked.turn === turn) this.#cancel(parked, 'turn_ended')
    }
  }

  /**
   * The run is draining (§9.3). Every queued wait is cancelled with `code`, and
   * every later ask is refused with it. Held leases are left alone: the command
   * under one is a step in flight, and a pause lets those finish.
   *
   * Without this a pause never finished while an agent was queued. The drain
   * waits for each node to reach a step boundary, and an agent turn blocked in
   * `with` behind a semaphore never reaches one. The client turns the code into
   * an instruction to end the turn, and the end of the turn is the boundary.
   */
  halt(code: string): void {
    if (this.#halted !== null) return
    this.#halted = code
    for (const parked of [...this.#parked.values()]) this.#cancel(parked, code)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const id of [...this.#held.keys()]) this.release(id)
    // Parked waits are queue entries, and one of them may already have been
    // granted while nobody was watching it. Both are the run's capacity.
    for (const parked of [...this.#parked.values()]) this.#cancel(parked, 'run_not_live')
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
