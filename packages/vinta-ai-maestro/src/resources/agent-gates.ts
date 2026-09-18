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
}

export class AgentGateBroker {
  readonly #options: AgentGateBrokerOptions

  constructor(options: AgentGateBrokerOptions) {
    this.#options = options
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
      // Fires at the spawn, after the pools are granted — so the distance to
      // the result below is the gate's runtime and not the queue in front of
      // it, which for an agent-run gate can be the larger of the two.
      onStart: () => {
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
}

/** The pool a node holds for its whole life. Spelled once, here and in the scheduler. */
const LANE = 'lane'
