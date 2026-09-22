/**
 * Admission control: everything between the scheduler deciding to dispatch a
 * node and an adapter's `spawn` actually starting a session.
 *
 * §6.1 in one sentence: a vendor saying "not right now" is backpressure, not
 * failure. Only `fatal` — a missing binary, an unauthenticated CLI — fails a
 * node; every other refusal returns it to the ready set after a wait. This
 * module is where that distinction is made exactly once, so no scheduler,
 * pipeline or UI has to re-derive it from a message string.
 *
 * **Why the return type looks like this.** §6.1 requires a refused node to
 * release its lane and gate slots *before* it waits: holding a lane while
 * blocked on a vendor limit starves the pool to do no work, and on a shared
 * quota it deadlocks the whole run — every lane held by a node that cannot
 * start. So `admit` never blocks on a capacity wait. A refusal comes back as a
 * `retry` outcome carrying a `wait()` the *caller* invokes, which puts the
 * release between the two:
 *
 *     const outcome = await admission.admit(adapter, task)
 *     if (outcome.status === 'failed') { lease.release(); fail(node); return }
 *     if (outcome.status === 'retry') {
 *       lease.release()                       // lane + gate slots, before waiting
 *       void outcome.wait().then(() => returnToReady(node))
 *       return
 *     }
 *     run(outcome.session).finally(outcome.release)   // frees the harness slot
 *
 * The only way to hold resources across the wait is to write the release after
 * the await on purpose; there is no accidental path to it, because the outcome
 * that says "wait" carries no session and does nothing on its own.
 *
 * **AIMD, not configuration.** The real per-account limit is undocumented,
 * varies by plan, and changes under us, so the effective ceiling is discovered:
 * halve on a `concurrency` or `rate_limit` refusal, add one back after a run of
 * clean spawns, never below 1, never above the configured value. A ceiling is
 * kept per `adapter.id` — two harnesses share nothing, and pressure on one must
 * not throttle the other.
 *
 * The ceiling itself is deliberately in-memory and not journaled. It is a
 * guess about a number the vendor never told us; a restarted daemon
 * re-discovers it within a few spawns, and reloading a stale one would be
 * carrying a guess across the very event most likely to invalidate it. The
 * *wake time* is journaled, because that is a fact the vendor reported.
 *
 * **One timer per harness, never a poll.** A refusal parks the harness, not the
 * node: every later node for that harness joins the same wait instead of
 * discovering the refusal for itself, which is what keeps a hundred waiting
 * nodes from becoming a hundred timers and a hundred re-probes.
 *
 * Nothing here logs prompt text, file contents or agent output. Refusal
 * messages come from the adapter, which is bound by the same rule; everything
 * this module adds is a run, node or harness identifier.
 */
import type {
  AgentSession,
  AgentTask,
  HarnessAdapter,
  SpawnRefusalKind,
  TurnRefusal,
} from '../harness/adapter.ts'
import type { Journal } from '../journal/journal.ts'
import { type Clock, systemClock } from './clock.ts'
import { CapacityWaitLog } from './waits.ts'

/**
 * Every refusal that is a wait.
 *
 * Two kinds are excluded and for opposite reasons. `fatal` is not a wait
 * because waiting will not fix a missing binary. `stale_session` is not a wait
 * because there is nothing to wait *for*: the harness is healthy, has capacity,
 * and has simply forgotten the session this task asked to continue (§15.4).
 * Parking the harness on it would stall every other node behind one node's
 * expired token, and letting it reach the AIMD controller would shrink the
 * ceiling in response to something that says nothing about concurrency.
 */
export type CapacityRefusalKind = Exclude<SpawnRefusalKind, 'fatal' | 'stale_session'>

/** Narrows a kind read back off disk to the ones that mean "wait". */
const isWait = (kind: SpawnRefusalKind): kind is CapacityRefusalKind =>
  kind !== 'fatal' && kind !== 'stale_session'

/** What a harness is waiting on, for the UI and the one-shot notification. */
export interface CapacityWait {
  readonly harness: string
  readonly kind: CapacityRefusalKind
  /** Epoch ms. */
  readonly wakeAt: number
}

export type AdmissionOutcome =
  | {
      readonly status: 'admitted'
      readonly session: AgentSession
      /**
       * Frees the harness in-flight slot. The scheduler calls it when the
       * session ends — the ceiling counts running agents, not spawn calls.
       * Idempotent, so `finally { outcome.release() }` is safe.
       */
      readonly release: () => void
    }
  /** `fatal` only: the harness is broken, and the node fails (§6.1). */
  | { readonly status: 'failed'; readonly message: string }
  /**
   * The `resumeSessionId` the task carried is gone (§15.4). Not a failure and
   * not a wait: the caller drops the token, composes the full prompt instead of
   * a continuation, and spawns again immediately. Nothing was parked and the
   * ceiling did not move, so that retry is free to proceed.
   */
  | { readonly status: 'stale_session'; readonly message: string }
  | {
      readonly status: 'retry'
      readonly kind: CapacityRefusalKind
      /** Epoch ms, already journaled. */
      readonly wakeAt: number
      /** Resolves at `wakeAt`. Call it only after releasing every resource. */
      readonly wait: () => Promise<void>
    }

export interface AdmissionOptions {
  readonly journal: Journal
  readonly runId: string
  /** Configured in-flight ceiling per `adapter.id`. The AIMD maximum. */
  readonly ceilings: Readonly<Record<string, number>>
  readonly clock?: Clock
  /** The jitter source. Injected so a backoff sequence can be reproduced. */
  readonly random?: () => number
  /** Consecutive clean spawns before the ceiling grows by one. */
  readonly increaseAfter?: number
  readonly baseBackoffMs?: number
  readonly maxBackoffMs?: number
  /** Fired once per wait window, per harness — §6.1's single notification. */
  readonly onWait?: (wait: CapacityWait) => void
}

/**
 * How many clean spawns count as "a run" before additive increase. §6.1 says
 * "a run of clean spawns" without fixing a number; three is small enough to
 * recover a halved ceiling quickly and large enough that one lucky spawn during
 * a rate-limit window does not undo the decrease that just happened.
 */
const DEFAULT_INCREASE_AFTER = 3
const DEFAULT_BASE_BACKOFF_MS = 1_000
/**
 * The cap is a re-probe interval, not a guess at the reset. A `quota` window
 * with no reported reset time may last hours; capping the wait at five minutes
 * costs one spawn attempt per five minutes and discovers a window that ended
 * early, instead of sleeping past it.
 */
const DEFAULT_MAX_BACKOFF_MS = 300_000

/**
 * Exponential backoff with full jitter: uniform over `[0, cap]` where the cap
 * doubles per attempt. Uniform rather than "cap minus a bit of jitter" because
 * the nodes being backed off were all refused by the same harness at the same
 * moment — anything less than full spread re-synchronizes them into the next
 * refusal. Exported for direct testing; the distribution is the contract.
 */
export function backoffMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number,
): number {
  const cap = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1))
  return Math.round(random() * cap)
}

interface HarnessState {
  /** The configured ceiling: AIMD's upper bound, never exceeded. */
  readonly configured: number
  ceiling: number
  inFlight: number
  /** Consecutive clean spawns since the last refusal or increase. */
  cleanRun: number
  /** Consecutive refusals, the exponent in the backoff. */
  attempt: number
  /** Epoch ms, or 0 when the harness is not parked. */
  wakeAt: number
  kind: CapacityRefusalKind
  /** §6.1 notifies once per wait window, not once per node that joins it. */
  notified: boolean
  cancelTimer: (() => void) | null
  /** Resolvers for nodes parked on this harness. One timer serves them all. */
  waiters: (() => void)[]
  /** Resolvers for nodes queued behind the ceiling, in arrival order. */
  slots: (() => void)[]
}

export class AdmissionControl {
  readonly #options: AdmissionOptions
  readonly #clock: Clock
  readonly #waitLog: CapacityWaitLog
  readonly #states = new Map<string, HarnessState>()

  constructor(options: AdmissionOptions) {
    this.#options = options
    this.#clock = options.clock ?? systemClock
    this.#waitLog = new CapacityWaitLog(options.journal.root)

    // Boot: a wait recorded before the restart resumes at its original wake
    // time. `notified` starts true because the operator was already told about
    // this window — a restart is not news to them.
    for (const [harness, stored] of this.#waitLog.load(options.runId)) {
      // A harness the current configuration no longer knows about cannot be
      // spawned on anyway, so its wait is nothing to resume. Neither kind that
      // is not a wait can legitimately be in this table — `#park` is the only
      // writer and it is never reached by either — but the rows come back off
      // disk as text, and a row that should not exist must not be able to park
      // a healthy harness forever after a restart.
      if (!isWait(stored.kind) || options.ceilings[harness] === undefined) continue
      const state = this.#state(harness)
      state.wakeAt = stored.wakeAt
      state.kind = stored.kind
      state.notified = true
      this.#arm(harness, state)
    }
  }

  /**
   * Spawns `task` on `adapter` under that harness's current ceiling, and turns
   * a refusal into a wait. Never throws on capacity; never fails a node for
   * anything but `fatal`.
   */
  async admit(adapter: HarnessAdapter, task: AgentTask): Promise<AdmissionOutcome> {
    const state = this.#state(adapter.id)

    // The harness is already parked: park this node too rather than spending a
    // spawn to be told the same thing again.
    if (this.#parked(state)) return this.#retry(state, task.nodeId)

    await this.#acquireSlot(state)
    // Another node may have been refused while we queued for the slot.
    if (this.#parked(state)) {
      this.#releaseSlot(state)
      return this.#retry(state, task.nodeId)
    }

    const outcome = await adapter.spawn(task)
    if (outcome.ok) {
      this.#onClean(state)
      let released = false
      return {
        status: 'admitted',
        session: outcome.session,
        release: () => {
          if (released) return
          released = true
          this.#releaseSlot(state)
        },
      }
    }

    // The slot goes back before anything else: a refused spawn holds nothing.
    this.#releaseSlot(state)
    if (outcome.kind === 'fatal') return { status: 'failed', message: outcome.message }
    // Before `#park`, deliberately: this refusal is about one task's token, not
    // about the harness, and neither the park nor the AIMD step may see it.
    // `#onClean` is not called either — a stale token is no evidence the
    // ceiling was safe, only that it was never tested.
    if (outcome.kind === 'stale_session') {
      return { status: 'stale_session', message: outcome.message }
    }

    this.#park(adapter.id, state, outcome.kind, outcome.retryAfter)
    return this.#retry(state, task.nodeId)
  }

  /**
   * A capacity refusal the vendor announced *inside* a turn that had already
   * started (`TurnRefusal`), parked exactly as a refused spawn is.
   *
   * §6.1 is written about a spawn because that is where a vendor usually says
   * "not right now". It is the same condition either way: a plan window that
   * closes twenty minutes into a phase has not broken anything, it has ended
   * the turn, and the answer is the one this module already implements — park
   * the *harness*, so the fifty nodes behind it join one wait instead of each
   * spending a spawn to be told the same thing, and journal the wake time so a
   * daemon restart does not forget it.
   *
   * Without this the turn was an ordinary failure: the node burnt its retries
   * against a closed window and then failed, taking its dependent subtree with
   * it, which is precisely the outcome §6.1 exists to prevent.
   *
   * Not `admit`'s business, and deliberately a separate entry point: nothing
   * was spawned, so there is no slot to release and no AIMD signal to read
   * about a ceiling that was never tested. What it shares with `admit` is
   * everything after the refusal — the same `#park`, the same wait, the same
   * `waiting_on_capacity` row.
   */
  refusedMidTurn(harness: string, nodeId: string, refusal: TurnRefusal): AdmissionOutcome {
    const state = this.#state(harness)
    this.#park(harness, state, refusal.kind, refusal.retryAfter)
    return this.#retry(state, nodeId)
  }

  /** The effective ceiling — the discovered one, not the configured one. */
  ceiling(harness: string): number {
    return this.#state(harness).ceiling
  }

  /** Sessions admitted and not yet released. Never exceeds `ceiling`. */
  inFlight(harness: string): number {
    return this.#state(harness).inFlight
  }

  /** When this harness may be tried again, or undefined if it is not parked. */
  wakeAt(harness: string): number | undefined {
    const state = this.#state(harness)
    return this.#parked(state) ? state.wakeAt : undefined
  }

  close(): void {
    for (const state of this.#states.values()) state.cancelTimer?.()
    this.#waitLog.close()
  }

  /** Journals the node as waiting and hands back the deferred wait. */
  #retry(state: HarnessState, nodeId: string): AdmissionOutcome {
    // `waiting_on_capacity`, not an error: the UI renders it as a wait, and the
    // run is not failing.
    this.#options.journal.append({
      runId: this.#options.runId,
      nodeId,
      type: 'node_status',
      payload: { status: 'waiting_on_capacity' },
    })
    return {
      status: 'retry',
      kind: state.kind,
      wakeAt: state.wakeAt,
      wait: () =>
        this.#parked(state)
          ? new Promise<void>((resolve) => state.waiters.push(resolve))
          : Promise.resolve(),
    }
  }

  /** Multiplicative decrease, backoff, and the durable wake time. */
  #park(
    harness: string,
    state: HarnessState,
    kind: CapacityRefusalKind,
    retryAfter: Date | undefined,
  ): void {
    state.cleanRun = 0
    state.attempt += 1
    // Only the two kinds that mean "too many at once" move the ceiling. A
    // `quota` or `transient` refusal says nothing about concurrency, and
    // halving on them would shrink the run for a reason it cannot fix.
    if (kind === 'concurrency' || kind === 'rate_limit') {
      state.ceiling = Math.max(1, Math.floor(state.ceiling / 2))
    }

    const now = this.#clock.now()
    // A reported reset time is knowledge; the backoff is a guess. Prefer the
    // knowledge, and never wake before now for a reset time already past.
    const wakeAt =
      retryAfter === undefined
        ? now +
          backoffMs(
            state.attempt,
            this.#options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS,
            this.#options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
            this.#options.random ?? Math.random,
          )
        : Math.max(now, retryAfter.getTime())

    // Concurrent refusals: the longest wait wins, since the harness is refusing
    // either way and waking early only buys another refusal.
    state.wakeAt = Math.max(state.wakeAt, wakeAt)
    state.kind = kind
    this.#waitLog.record(this.#options.runId, harness, { kind, wakeAt: state.wakeAt })
    this.#arm(harness, state)

    if (!state.notified) {
      state.notified = true
      this.#options.onWait?.({ harness, kind, wakeAt: state.wakeAt })
    }
  }

  /** One timer per harness. Re-arming replaces it; it never accumulates. */
  #arm(harness: string, state: HarnessState): void {
    state.cancelTimer?.()
    state.cancelTimer = this.#clock.at(state.wakeAt, () => {
      state.cancelTimer = null
      state.wakeAt = 0
      state.notified = false
      this.#waitLog.clear(this.#options.runId, harness)
      const waiters = state.waiters
      state.waiters = []
      for (const resolve of waiters) resolve()
    })
  }

  #parked(state: HarnessState): boolean {
    return state.wakeAt > 0 && this.#clock.now() < state.wakeAt
  }

  /** Additive increase, back toward the configured ceiling and no further. */
  #onClean(state: HarnessState): void {
    state.attempt = 0
    state.cleanRun += 1
    if (state.cleanRun < (this.#options.increaseAfter ?? DEFAULT_INCREASE_AFTER)) return
    state.cleanRun = 0
    state.ceiling = Math.min(state.configured, state.ceiling + 1)
    this.#pump(state)
  }

  #acquireSlot(state: HarnessState): Promise<void> {
    if (state.inFlight < state.ceiling) {
      state.inFlight += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => state.slots.push(resolve))
  }

  #releaseSlot(state: HarnessState): void {
    state.inFlight -= 1
    this.#pump(state)
  }

  /**
   * Hands out freed slots in arrival order. `inFlight` is incremented here,
   * synchronously, rather than by the woken caller — a resolved promise runs a
   * microtask later, which is long enough for two waiters to both observe a
   * single free slot.
   */
  #pump(state: HarnessState): void {
    while (state.slots.length > 0 && state.inFlight < state.ceiling) {
      state.inFlight += 1
      state.slots.shift()?.()
    }
  }

  #state(harness: string): HarnessState {
    const existing = this.#states.get(harness)
    if (existing) return existing
    const configured = this.#options.ceilings[harness]
    if (configured === undefined) throw new Error(`unknown harness "${harness}"`)
    const state: HarnessState = {
      configured,
      ceiling: configured,
      inFlight: 0,
      cleanRun: 0,
      attempt: 0,
      wakeAt: 0,
      kind: 'transient',
      notified: false,
      cancelTimer: null,
      waiters: [],
      slots: [],
    }
    this.#states.set(harness, state)
    return state
  }
}
