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
import { type CodegenCache, codegenLogName, codegenPools, runCodegen } from '../codegen/codegen.ts'
import { gateConfigKey, laneTreeHash, runGateCached, type GateCache } from '../gates/cache.ts'
import { TIMEOUT_EXIT } from '../gates/runner.ts'
import { changedFiles, phaseGate } from '../gates/scope.ts'
import type { Journal } from '../journal/journal.ts'
import { GATE_ROLE } from '../journal/transcript.ts'
import { CODEGEN_GATE_PREFIX, isJudgeGate, type Workflow } from '../types.ts'
import type { AgentLeaseHeld } from './agent-leases.ts'
import { AcquireAborted, type ResourcePools } from './pools.ts'

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
  /**
   * `held` is set on `holds_required`: the caller's own leases on the gate's
   * pools, so the refusal can say which command is holding them.
   */
  constructor(
    readonly code: string,
    readonly held: readonly AgentLeaseHeld[] = [],
  ) {
    super(code)
  }
}

export interface AgentGateBrokerOptions {
  readonly workflow: Workflow
  readonly runId: string
  readonly journal: Pick<Journal, 'nodes' | 'append' | 'appendTranscript' | 'gateLogPath'>
  readonly pools: ResourcePools
  readonly cache: GateCache
  /**
   * The codegen steps' skip cache — the one the lanes' gate step reads, so a
   * step an agent ran on a tree is a skip for the gate step afterwards.
   */
  readonly codegenCache?: CodegenCache
  /**
   * The leases agents hold through `with`, by holder. A gate asked for by a
   * node that already holds one of its pools would queue behind that node's
   * own lease, and when the gate was asked for from *inside* the `with`
   * (`with test-suite -- vinta-ai-maestro gate test`) the lease is never let
   * go: every lane's gates queued behind it for fifty-five minutes in one run.
   * Absent for a host with no lease broker, and then nothing is checked.
   */
  readonly leases?: { held(): readonly AgentLeaseHeld[] }
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
  /**
   * `queued` until the gate's pools are granted, `running` after. An agent
   * told "running" about a gate that is only queued reads the wait as the
   * suite being slow, and nobody looks at what is holding the pool.
   */
  readonly state: GateFlightState
}

export type GateFlightState = 'queued' | 'running'

/** One gate, queued or running, with whoever is watching it sharing the one promise. */
interface GateFlight {
  readonly settled: Promise<AgentGateResult>
  readonly holderNode: string
  readonly gateId: string
  readonly requires: readonly string[]
  state: GateFlightState
  /** The session that last asked for it. A queued flight goes when that session ends. */
  turn: string | undefined
  /** Takes the gate out of the pool queue. Too late, and harmless, once it runs. */
  readonly abort: AbortController
}

/** A gate an agent asked for that holds its pools now, for naming to a waiter. */
export interface AgentGateRunning {
  readonly holderNode: string
  readonly gateId: string
  readonly requires: readonly string[]
}

export interface AgentGateHopOptions {
  /** How long this hop may hold the request open before answering "not yet". */
  readonly withinMs: number
  /**
   * `gate <id> --no-cache`: skip the lookup and let the run replace the entry.
   * Read only when this hop starts the flight; a hop that attaches to one
   * already running gets that run's answer, which is a fresh run's anyway —
   * a hit never stays in flight long enough to be attached to.
   */
  readonly noCache?: boolean
  /**
   * `gate <id> --full`: the gate's whole `cmd`, whatever `gate_scope` says —
   * how a fixer sees the failure `verify` found in full. A flight of its own,
   * never attached to a scoped run of the same gate.
   */
  readonly full?: boolean
  /** The session asking (`MAESTRO_TURN_ENV`), when the client knows it. */
  readonly turn?: string
}

export class AgentGateBroker {
  readonly #options: AgentGateBrokerOptions
  /** The run's definition as it stands now. Replaced by `adopt` — see below. */
  #workflow: Workflow
  readonly #setTimer: (callback: () => void, delayMs: number) => NodeJS.Timeout
  readonly #clearTimer: (timer: NodeJS.Timeout) => void
  /** Keyed by `(holderNode, gateId)` — see `AgentGateWaiting` for why that is the key. */
  readonly #inFlight = new Map<string, GateFlight>()
  /** `AgentLeaseBroker`'s, for the same orphaned clients. */
  readonly #endedTurns = new Set<string>()
  /** Set by `halt`: the code every gate not already running is refused with. */
  #halted: string | null = null

  constructor(options: AgentGateBrokerOptions) {
    this.#options = options
    this.#workflow = options.workflow
    this.#setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.#clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer))
  }

  /**
   * Take an amended workflow (§9), exactly as the scheduler, the executor and
   * the integrator do. The broker is a reader of `gates[id].cmd` in its own
   * right: a gate an agent asks for comes through here rather than through
   * `run_gate`. An amendment that reached the others and not this one would
   * leave a run whose gate node runs the new command and whose agents run the
   * old one — the same gate id, two commands, and a cache keyed on both.
   *
   * A flight already in `#inFlight` is deliberately left alone. It is a gate
   * that is *running*, with the old command, and its result is the answer to
   * the question that was asked; replacing the command underneath it would
   * report one gate's verdict under another's definition. The next hop after
   * it retires starts from the amended table.
   */
  adopt(workflow: Workflow): void {
    this.#workflow = workflow
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
    const key = `${holderNode} ${gateId}${options.full === true ? ` full` : ''}`
    let flight = this.#inFlight.get(key)
    const { turn } = options

    if (turn !== undefined && this.#endedTurns.has(turn)) throw new AgentGateRefusal('turn_ended')
    // A draining run lets a gate that is already running finish, and a client
    // watching it may keep watching: that is a step in flight. Nothing starts.
    if (this.#halted !== null && flight?.state !== 'running') {
      throw new AgentGateRefusal(this.#halted)
    }

    if (flight !== undefined) {
      if (turn !== undefined) flight.turn = turn
    } else {
      // A refusal — `unknown_gate`, `no_lane`, `gate_needs_lane` — rejects
      // before anything is acquired, so it lands inside `withinMs` and reaches
      // the hop that asked, which is the one whose route can turn it into a
      // status. The retirement below means a later hop re-asks and is refused
      // the same way rather than inheriting a dead flight.
      const abort = new AbortController()
      let created: GateFlight | undefined
      // `onRunning` cannot fire before `created` is set: `run` awaits before
      // it reaches the pools.
      const started = this.run(gateId, holderNode, {
        noCache: options.noCache === true,
        full: options.full === true,
        signal: abort.signal,
        onRunning: () => {
          if (created !== undefined) created.state = 'running'
        },
      })
      const declared = this.#workflow.gates[gateId]
      created = {
        settled: started,
        holderNode,
        gateId,
        requires: gateId.startsWith(CODEGEN_GATE_PREFIX)
          ? this.#codegenRequires(gateId.slice(CODEGEN_GATE_PREFIX.length))
          : declared === undefined || isJudgeGate(declared)
            ? []
            : declared.requires,
        state: 'queued',
        turn,
        abort,
      }
      flight = created
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
    return result ?? { waiting: true, gateId, state: flight.state }
  }

  /** The agent-run gates holding their pools right now. */
  running(): readonly AgentGateRunning[] {
    return [...this.#inFlight.values()]
      .filter((flight) => flight.state === 'running')
      .map(({ holderNode, gateId, requires }) => ({ holderNode, gateId, requires }))
  }

  /**
   * A session has ended: its gates still queued for their pools leave the
   * queue, and it is refused from now on. One already running is left to
   * finish. Its result is cached, so the gate node's run of the same tree is
   * a hit, and killing it would throw away the part that was paid for.
   */
  endTurn(holderNode: string, turn: string): void {
    this.#endedTurns.add(turn)
    for (const flight of this.#inFlight.values()) {
      if (flight.holderNode === holderNode && flight.turn === turn && flight.state === 'queued') {
        flight.abort.abort('turn_ended')
      }
    }
  }

  /**
   * The run is draining (§9.3). Queued gates leave the queue with `code`, and
   * no gate starts from now on. A running one finishes: it is a step in
   * flight, and its client may keep watching it.
   */
  halt(code: string): void {
    if (this.#halted !== null) return
    this.#halted = code
    for (const flight of this.#inFlight.values()) {
      if (flight.state === 'queued') flight.abort.abort(code)
    }
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
  async run(
    gateId: string,
    holderNode: string,
    flight: {
      readonly noCache?: boolean
      readonly full?: boolean
      readonly signal?: AbortSignal
      readonly onRunning?: () => void
    } = {},
  ): Promise<AgentGateResult> {
    const { runId, journal } = this.#options

    if (gateId.startsWith(CODEGEN_GATE_PREFIX)) {
      return await this.#codegen(gateId, gateId.slice(CODEGEN_GATE_PREFIX.length), holderNode, flight)
    }

    const gate = this.#workflow.gates[gateId]
    if (gate === undefined) throw new AgentGateRefusal('unknown_gate')
    // A judge gate's question is about the finished phase, and asking it of a
    // tree mid-turn spends a classifier call on a diff that is about to move.
    if (isJudgeGate(gate)) throw new AgentGateRefusal('judge_gate')

    // The node holds `lane` from its first admission to its last turn
    // (`Scheduler`'s `laneLease`). Acquiring it again on the node's own behalf
    // would queue behind the node itself and never return — the same
    // self-deadlock the lease endpoint refuses `lane` to avoid, arrived at
    // through a gate's `requires` instead of through an agent's request.
    if (gate.requires.includes(LANE)) throw new AgentGateRefusal('gate_needs_lane')

    // The same self-deadlock through the other door: a pool this node already
    // holds through `with`. Typically the gate was asked for from inside that
    // `with`, which cannot let go until the gate returns, while the gate cannot
    // start until it does. Refused rather than made re-entrant: a gate holding
    // its pools is what tells the other lanes they are not sharing them.
    const own = (this.#options.leases?.held() ?? []).filter(
      (held) =>
        held.holderNode === holderNode && held.resources.some((name) => gate.requires.includes(name)),
    )
    const taken = own[0]?.resources.find((name) => gate.requires.includes(name))
    if (taken !== undefined) throw new AgentGateRefusal(`holds_required:${taken}`, own)

    const row = journal.nodes(runId).find((candidate) => candidate.node_id === holderNode)
    const laneName = row?.lane
    if (laneName === null || laneName === undefined) throw new AgentGateRefusal('no_lane')
    const lane = this.#options.lane(laneName)

    // The same line the gate node will run for this phase — scoped or full by
    // the same rule — so "I ran the unit gate" in a report is still a claim
    // about the command the gate node runs, and its result is still a hit for
    // it on an unchanged tree.
    const effective =
      row?.base_branch === null || row?.base_branch === undefined
        ? gate
        : await phaseGate(gate, flight.full === true ? 'full' : this.#workflow.defaults.gate_scope, {
            lanePath: lane.path,
            base: row.base_branch,
            touches: this.#workflow.nodes.find((node) => node.id === holderNode)?.touches ?? [],
          })

    // A later gate behind a red one is refused, not run. Agents check their
    // work gate by gate — `for g in lint typecheck test` — and the red
    // typecheck did not stop the loop: observed as a 400-second suite run
    // against a tree that had already failed, whose result the next round
    // threw away. The gate node stops at the first red gate (`#runGate`);
    // this is the same rule for the gates a turn asks for. Read off the cache,
    // so it costs no run: a red result for this exact tree and command is
    // already there, or the earlier gate has not been run on it at all.
    const node = this.#workflow.nodes.find((candidate) => candidate.id === holderNode)
    const red = await this.#earlierRed(gateId, node?.gates ?? [], lane, row?.base_branch ?? null, node?.touches ?? [])
    if (red !== null) throw new AgentGateRefusal(`earlier_gate_red:${red}`)

    const result = await runGateCached({
      gateId,
      gate: effective,
      cwd: lane.path,
      env: lane.env,
      logPath: journal.gateLogPath(runId, holderNode, gateId),
      pools: {
        // Through the flight's signal, so a session that ends or a run that
        // drains takes the gate out of the queue rather than leaving it to run
        // later against a tree nobody is waiting on.
        acquire: (needs) =>
          (flight.signal === undefined
            ? this.#options.pools.acquire(needs)
            : this.#options.pools.acquire(needs, { signal: flight.signal })
          ).catch((error: unknown) => {
              const reason: unknown = flight.signal?.reason
              if (error instanceof AcquireAborted && typeof reason === 'string') {
                throw new AgentGateRefusal(reason)
              }
              throw error
            }),
      },
      cache: this.#options.cache,
      noCache: flight.noCache === true,
      // Fires at the spawn, after the pools are granted — so the distance to
      // the result below is the gate's runtime and not the queue in front of
      // it, which for an agent-run gate can be the larger of the two.
      onStart: () => {
        flight.onRunning?.()
        journal.append({
          runId,
          nodeId: holderNode,
          type: 'gate_started',
          payload: { gate: gateId },
        })
      },
    })

    const exitCode = result.status === 'passed' ? 0 : (result.exitCode ?? TIMEOUT_EXIT)
    journal.append({
      runId,
      nodeId: holderNode,
      type: 'gate_result',
      payload: {
        gate: gateId,
        exit_code: exitCode,
        status: result.status,
        duration_ms: result.durationMs,
        cached: result.cached,
      },
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

  /** The pools the codegen steps `vinta-ai-maestro codegen [<step>]` runs hold. */
  #codegenRequires(stepId: string): string[] {
    return codegenPools(this.#workflow, stepId)
  }

  /**
   * `vinta-ai-maestro codegen [<step>]`: the plan's codegen steps — or one,
   * with the steps it comes after — in the asking node's lane, under their
   * pools, through the same flight as a gate so a killed client attaches to
   * the run on its next call. Nothing is committed: the outputs land in the
   * agent's tree, which it commits with its work, and the gate step commits
   * whatever is left. `--no-cache` runs a step its skip cache would skip.
   */
  async #codegen(
    gateId: string,
    stepId: string,
    holderNode: string,
    flight: { readonly noCache?: boolean; readonly signal?: AbortSignal; readonly onRunning?: () => void },
  ): Promise<AgentGateResult> {
    const { runId, journal } = this.#options
    const steps = this.#workflow.codegen
    if (Object.keys(steps).length === 0 || (stepId !== '' && steps[stepId] === undefined)) {
      throw new AgentGateRefusal('unknown_gate')
    }
    const requires = this.#codegenRequires(stepId)
    const own = (this.#options.leases?.held() ?? []).filter(
      (held) => held.holderNode === holderNode && held.resources.some((name) => requires.includes(name)),
    )
    const taken = own[0]?.resources.find((name) => requires.includes(name))
    if (taken !== undefined) throw new AgentGateRefusal(`holds_required:${taken}`, own)

    const row = journal.nodes(runId).find((candidate) => candidate.node_id === holderNode)
    const laneName = row?.lane
    if (laneName === null || laneName === undefined) throw new AgentGateRefusal('no_lane')
    const lane = this.#options.lane(laneName)
    const base = row?.base_branch ?? null

    const lease = await (flight.signal === undefined
      ? this.#options.pools.acquire(requires)
      : this.#options.pools.acquire(requires, { signal: flight.signal })
    ).catch((error: unknown) => {
      const reason: unknown = flight.signal?.reason
      if (error instanceof AcquireAborted && typeof reason === 'string') throw new AgentGateRefusal(reason)
      throw error
    })
    let outcome: Awaited<ReturnType<typeof runCodegen>>
    try {
      flight.onRunning?.()
      outcome = await runCodegen({
        steps,
        ...(stepId === '' ? {} : { only: [stepId] }),
        cwd: lane.path,
        env: lane.env,
        logPath: (id) => journal.gateLogPath(runId, holderNode, codegenLogName(id)),
        ...(this.#options.codegenCache === undefined ? {} : { cache: this.#options.codegenCache }),
        force: flight.noCache === true,
        ...(base === null ? {} : { changedFiles: () => changedFiles({ lanePath: lane.path, base, touches: [] }) }),
        onResult: (run) => {
          journal.append({
            runId,
            nodeId: holderNode,
            type: 'codegen_result',
            payload: {
              step: run.id,
              where: 'agent',
              status: run.status,
              exit_code: run.exitCode,
              duration_ms: run.durationMs,
              ...(run.skipped === undefined ? {} : { skipped: run.skipped }),
              ...(run.nondeterministic === true ? { nondeterministic: true } : {}),
            },
          })
        },
      })
    } finally {
      lease.release()
    }
    const failed = outcome.failed
    const last = failed ?? outcome.runs[outcome.runs.length - 1]
    return {
      gateId,
      status: failed === null ? 'passed' : failed.status,
      exitCode: failed === null ? 0 : failed.exitCode,
      cached: outcome.runs.every((run) => run.status === 'skipped'),
      logRef: last?.logPath ?? journal.gateLogPath(runId, holderNode, codegenLogName(stepId === '' ? 'all' : stepId)),
    }
  }

  /**
   * The first gate declared before `gateId` on this node whose cached result
   * for the lane's current tree is red, or null. Only command gates: a judge
   * gate is never run from inside a turn, so it has no result here to read.
   */
  async #earlierRed(
    gateId: string,
    declared: readonly string[],
    lane: GateLane,
    base: string | null,
    touches: readonly string[],
  ): Promise<string | null> {
    const index = declared.indexOf(gateId)
    if (index <= 0) return null
    let tree: string | null = null
    for (const earlier of declared.slice(0, index)) {
      const gate = this.#workflow.gates[earlier]
      if (gate === undefined || isJudgeGate(gate)) continue
      const effective =
        base === null
          ? gate
          : await phaseGate(gate, this.#workflow.defaults.gate_scope, { lanePath: lane.path, base, touches })
      tree ??= laneTreeHash(lane.path)
      const hit = this.#options.cache.lookup(earlier, tree, gateConfigKey(effective))
      if (hit !== undefined && hit.status !== 'passed') return earlier
    }
    return null
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
