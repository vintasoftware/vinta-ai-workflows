/**
 * Running a declared gate on an agent's behalf, from inside its own turn.
 *
 * A phase was observed running its full gate suite five and six times over for
 * one fix round: the implementer at the end of its working instructions, the
 * reviewer's first layer, the fixer, the reviewer again on the next round, and
 * finally the `gate` node whose exit code the pipeline guard actually reads.
 * Only the last of those went near `GateCache`. The other four were bare shell
 * lines inside an agent turn — invisible to the cache, and inside the pool only
 * if the agent remembered `vinta-ai-maestro with`.
 *
 * So the gate command stops being something an agent types. It asks the daemon
 * for a gate *by id*, and the daemon does what the `gate` node does. Three
 * things follow from moving it, and each of them is the point:
 *
 * - **The result is cached, on the same key, in the same database.** An
 *   implementer's run of `unit` against a tree it then commits unchanged is a
 *   hit when the reviewer runs `unit`, and a hit again when the authoritative
 *   `gate` node runs it. The repetition the prompts ask for stops being the
 *   expensive thing about them.
 * - **The lease cannot be forgotten.** `with` puts the pool in the agent's
 *   hands, which is as reliable as the agent's memory; here the daemon holds
 *   it, and an agent that skipped the wrapper has no way to reach the gate
 *   without one.
 * - **The command cannot be improvised.** A gate id resolves to the declared
 *   `cmd`. An agent that half-remembers the suite and runs a scoped `pytest`
 *   instead cannot do that through this door, and the reviewer reading "I ran
 *   the unit gate" is reading about the command the gate node will run.
 *
 * ## Why this calls `runGateCached` and the executor does not
 *
 * They want the same composition and differ in exactly one thing: who holds the
 * gate's pools. The scheduler takes them around the whole `run_gate` effect
 * (§6, §9.1), so `RunEffectExecutor` must not call `runGate` — it would acquire
 * them a second time and self-deadlock on any pool of capacity 1 — and rebuilds
 * the cache around `executeGate` instead. Nothing holds them here: this runs
 * inside a `spawn_agent` turn, and the scheduler holds only the node's lane.
 * `runGateCached` is precisely the standalone form — lookup before the acquire,
 * `runGate` behind it, store after — so it is used as it stands rather than
 * copied into a third spelling that could drift from the other two.
 */
import { runGateCached, type GateCache } from '../gates/cache.ts'
import { TIMEOUT_EXIT } from '../gates/runner.ts'
import type { Journal } from '../journal/journal.ts'
import { GATE_ROLE } from '../journal/transcript.ts'
import type { Workflow } from '../types.ts'
import type { ResourcePools } from './pools.ts'

/** The lane a node was assigned, as the host already describes one. */
export interface GateLane {
  readonly path: string
  readonly env: Readonly<Record<string, string>>
}

export interface AgentGateResult {
  readonly gateId: string
  readonly status: string
  /** A timed-out gate exits nothing of its own; `TIMEOUT_EXIT` stands in. */
  readonly exitCode: number
  /** Whether this answer came from the cache rather than from a run. */
  readonly cached: boolean
  /** Where the gate's output is. A path, never the output — §11. */
  readonly logRef: string
}

/**
 * A refusal the agent can act on, carried as a code rather than a message.
 *
 * The codes are the wire's, and the CLI turns each one into the sentence that
 * says what to change. Nothing thrown from a gate command, a lane or the
 * journal is relayed: those carry repository content and this is the layer
 * that must not leak it.
 */
export class AgentGateRefusal extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

export interface AgentGateBrokerOptions {
  readonly workflow: Workflow
  readonly runId: string
  readonly journal: Pick<Journal, 'nodes' | 'append' | 'appendTranscript' | 'gateLogPath'>
  readonly pools: ResourcePools
  readonly cache: GateCache
  /** The lane behind a slot name, read through the pool: a recycled slot is a new object. */
  readonly lane: (name: string) => GateLane
  /**
   * Injected so a test of the hop does not pay for the hop. Real sleeping is
   * the slowest thing about a wait loop, and a test that spends it asleep is
   * one that flakes on a loaded machine for reasons unrelated to what it
   * asserts. `agent-leases.ts` takes the same pair for the same reason.
   */
  readonly setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout
  readonly clearTimer?: (timer: NodeJS.Timeout) => void
}

/**
 * Still running — come back. The gate's half of `POST /leases`' `202`.
 *
 * It carries no wait token, and the difference from a lease is the reason. A
 * lease wait is a *place in a queue*: two hops that lose it are two positions
 * lost, so the token is what the client must hand back to keep the one it
 * bought. A gate run is a single job, identified by who asked and for what —
 * so `(holderNode, gateId)` is the whole of its identity, and attaching by
 * that alone is precisely the property wanted here. A client killed
 * mid-wait — which is the ordinary case, because agent harnesses cap how long
 * one command may run — re-invokes with nothing in hand and still finds its
 * own gate rather than starting a second one beside it.
 */
export interface AgentGateWaiting {
  readonly waiting: true
  readonly gateId: string
}

/** One gate, running, with whoever is watching it sharing the one promise. */
interface GateFlight {
  readonly settled: Promise<AgentGateResult>
}

export interface AgentGateHopOptions {
  /** How long this hop may hold the request open before answering "not yet". */
  readonly withinMs: number
}

export class AgentGateBroker {
  readonly #options: AgentGateBrokerOptions
  readonly #setTimer: (callback: () => void, delayMs: number) => NodeJS.Timeout
  readonly #clearTimer: (timer: NodeJS.Timeout) => void
  /** Keyed by `(holderNode, gateId)` — see `AgentGateWaiting` for why that is the key. */
  readonly #inFlight = new Map<string, GateFlight>()

  constructor(options: AgentGateBrokerOptions) {
    this.#options = options
    this.#setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.#clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer))
  }

  /**
   * Waits up to `withinMs` for `gateId` in `holderNode`'s lane, starting it if
   * it is not already running, and answers either the result or "not yet".
   *
   * This exists because `run` could not be awaited over HTTP. One held request
   * is the obvious shape and it is the wrong one: Node's own `fetch` stops
   * waiting for a response header after five minutes, and a gate that acquires
   * a capacity-1 semaphore and then runs a test suite is routinely slower than
   * that. The client's error said the daemon could not be reached, about a
   * gate that was running perfectly well and would cache a green result
   * minutes later — and agents did the reasonable thing with an error that
   * names no alternative, which was to invent polling loops around a command
   * documented as having none. `with` learned this first and the `202` here is
   * its lesson, arrived at a second time.
   *
   * The second property is the one `with` does not need. A hop that never
   * comes back is the *expected* ending, not a failure: an agent harness kills
   * a command at its own ceiling regardless of what the daemon is doing. So
   * the flight outlives its watcher, and the re-invocation that follows
   * attaches to it. Without that, every kill started another full suite
   * against the same unchanged tree, behind the semaphore its own predecessor
   * was still holding.
   */
  async hop(
    gateId: string,
    holderNode: string,
    options: AgentGateHopOptions,
  ): Promise<AgentGateWaiting | AgentGateResult> {
    const key = `${holderNode} ${gateId}`
    let flight = this.#inFlight.get(key)

    if (flight === undefined) {
      // A refusal — `unknown_gate`, `no_lane`, `gate_needs_lane` — rejects
      // before anything is acquired, so it lands inside `withinMs` and reaches
      // the hop that asked, which is the one whose route can turn it into a
      // status. The retirement below means a later hop re-asks and is refused
      // the same way rather than inheriting a dead flight.
      const started = this.run(gateId, holderNode)
      flight = { settled: started }
      this.#inFlight.set(key, flight)

      // Retired the moment it settles, however it settles. A later invocation
      // then finds no flight and starts one — which, for a tree that has not
      // moved, is a `GateCache` hit and returns at once. Nothing has to decide
      // how long to keep a finished answer, because the cache already is that
      // decision. The handler is also what keeps a rejection nobody is
      // watching from surfacing as an unhandled one between hops.
      const retire = (): void => {
        if (this.#inFlight.get(key) === flight) this.#inFlight.delete(key)
      }
      started.then(retire, retire)
    }

    const result = await this.#within(flight.settled, options.withinMs)
    return result ?? { waiting: true, gateId }
  }

  /**
   * Runs `gateId` in `holderNode`'s lane and records that it ran.
   *
   * The journal rows are the same two `run_gate` writes, deliberately: a
   * `gate_result` event, which is what §13.6's post-mortem reads to say a gate
   * failed and later passed, and a `gate_run` transcript entry attributed to
   * `gate`, which is what somebody reading the phase sees. A gate an agent ran
   * is a gate that ran; filing it anywhere else would make the transcript's
   * GATE band a record of only some of them.
   */
  async run(gateId: string, holderNode: string): Promise<AgentGateResult> {
    const { workflow, runId, journal } = this.#options

    const gate = workflow.gates[gateId]
    if (gate === undefined) throw new AgentGateRefusal('unknown_gate')

    // The node holds `lane` from its first admission to its last turn
    // (`Scheduler`'s `laneLease`). Acquiring it again on the node's own behalf
    // would queue behind the node itself and never return — the same
    // self-deadlock the lease endpoint refuses `lane` to avoid, arrived at
    // through a gate's `requires` instead of through an agent's request.
    if (gate.requires.includes(LANE)) throw new AgentGateRefusal('gate_needs_lane')

    const laneName = journal.nodes(runId).find((row) => row.node_id === holderNode)?.lane
    if (laneName === null || laneName === undefined) throw new AgentGateRefusal('no_lane')
    const lane = this.#options.lane(laneName)

    const result = await runGateCached({
      gateId,
      gate,
      cwd: lane.path,
      env: lane.env,
      logPath: journal.gateLogPath(runId, holderNode, gateId),
      pools: this.#options.pools,
      cache: this.#options.cache,
    })

    const exitCode = result.status === 'passed' ? 0 : (result.exitCode ?? TIMEOUT_EXIT)
    journal.append({
      runId,
      nodeId: holderNode,
      type: 'gate_result',
      payload: { gate: gateId, exit_code: exitCode, status: result.status },
    })
    journal.appendTranscript(runId, holderNode, {
      type: 'gate_run',
      gate: gateId,
      exitCode,
      status: result.status,
      cached: result.cached,
      by: { role: GATE_ROLE },
    })

    return {
      gateId,
      status: result.status,
      exitCode,
      cached: result.cached,
      logRef: result.logPath,
    }
  }

  /**
   * The result if it lands inside `ms`, else `null` — the run itself untouched.
   *
   * Untouched is the whole point: a hop that gives up must leave a running
   * gate running. Cancelling it at the hop boundary would make a client's
   * ceiling into the gate's, and the suite would restart from nothing every
   * time the harness reached for its timer.
   */
  #within(settled: Promise<AgentGateResult>, ms: number): Promise<AgentGateResult | null> {
    return new Promise<AgentGateResult | null>((resolve, reject) => {
      let done = false
      const timer = this.#setTimer(() => {
        if (done) return
        done = true
        resolve(null)
      }, ms)
      settled.then(
        (result) => {
          if (done) return
          done = true
          this.#clearTimer(timer)
          resolve(result)
        },
        (error: unknown) => {
          if (done) return
          done = true
          this.#clearTimer(timer)
          reject(error instanceof Error ? error : new Error('gate failed to start'))
        },
      )
    })
  }
}

/** The pool a node holds for its whole life. Spelled once, here and in the scheduler. */
const LANE = 'lane'
