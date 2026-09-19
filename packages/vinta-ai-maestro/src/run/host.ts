/**
 * The host composition: lanes, the integrator, and the executor over both.
 *
 * Split out of `cli/run.ts` when a run stopped being a thing a terminal owns.
 * Everything here is the *inside* of a run — the worktrees it works in, the
 * integration worktree its waves merge on, the adapters its phases dispatch to
 * — and none of it knows whether the process that built it is a CLI awaiting a
 * report or a daemon that will outlive the request that asked for the run.
 *
 * That ignorance is the point. `run` and `POST /api/runs` compose the identical
 * thing through `startRun`, so a run submitted to a daemon cannot drift into
 * being a second, subtly different kind of run.
 */
import { join } from 'node:path'

import type { AmendRunner } from '../amend/amend.ts'
import { createRebaser } from '../amend/rebase.ts'
import type { AgentGatePort } from '../daemon/index.ts'
import { referencedHarnesses } from '../doctor/index.ts'
import { createRunExecutor } from '../executor/index.ts'
import { GateCache } from '../gates/cache.ts'
import { executeGate } from '../gates/runner.ts'
import type { HarnessAdapter } from '../harness/adapter.ts'
import { ClaudeCodeAdapter } from '../harness/claude-code.ts'
import { CodexAdapter } from '../harness/codex.ts'
import { OpencodeAdapter } from '../harness/opencode.ts'
import type { AgentPermission } from '../harness/permissions.ts'
import type { ConflictFixer } from '../integration/fixer.ts'
import { gitLines } from '../integration/git.ts'
import { Integrator, type WaveResult } from '../integration/integrator.ts'
import { createCrewConflictFixer } from '../integration/staffing.ts'
import type { StoredEvent } from '../journal/events.ts'
import type { TranscriptEntry } from '../journal/transcript.ts'
import type { Journal } from '../journal/journal.ts'
import { DiskProbeError } from '../lanes/disk.ts'
import { LaneEnvFileError, LanePool, LaneSetupError } from '../lanes/pool.ts'
import type { EffectExecutor } from '../pipeline/effects.ts'
import type { IntegrationWaveRecord } from '../postmortem/postmortem.ts'
import type { ResourcePools } from '../resources/pools.ts'
import { AgentGateBroker } from '../resources/agent-gates.ts'
import { laneHolders } from '../scheduler/crew.ts'
import type { Gate, Workflow } from '../types.ts'
import { storeFor } from '../cli/paths.ts'
import { projectSpec } from '../cli/project.ts'

/**
 * Where a merge gate's log is filed.
 *
 * Its own pseudo-node rather than the incoming phase's, so a gate run against
 * the *merge* never overwrites that phase's own log for the same gate id — two
 * different trees, two different answers, and the phase's is the one its review
 * was based on. Leading underscore for `MONITOR_NODE`'s reason: it must not
 * collide with a node id a workflow could declare, and it must be a legal path
 * segment on Windows.
 */
const INTEGRATION_NODE = '_integration'

/** What the run needs from whoever owns the lanes — this file, or `RunDeps`. */
export interface HostWiring {
  readonly executor: EffectExecutor
  /** Read after `run_ended`. Absent for an injected executor, which owns its own. */
  readonly waveResults?: () => readonly IntegrationWaveRecord[]
  /** `DaemonRun.amend`'s rebase. Absent means an amendment that needs one is refused. */
  readonly rebase?: NonNullable<AmendRunner['rebase']>
  /** The scheduler's lane hand-over (§8). Absent for a host that owns its lanes. */
  readonly recycleLane?: (name: string) => Promise<void>
  /** One lane's environment, for the agent about to run in it. */
  readonly laneEnv?: (name: string) => Readonly<Record<string, string>>
  readonly laneDelta?: (lane: string, sinceRef: string) => Promise<readonly string[]>
  /**
   * The `gate` verb's port, once the run's pools exist.
   *
   * A factory rather than a value because the two things it needs are owned on
   * opposite sides of this seam: the lane pool and the gate cache are
   * `provision`'s and stay private to it, and `ResourcePools` is built out
   * there, after. Handing the pools in is cheaper than moving either of the
   * others out, and it keeps the cache closed by the same `close` that opened
   * it. Absent for an injected executor, which provisions no lanes to run a
   * gate against.
   */
  readonly gatesFor?: (pools: ResourcePools) => AgentGatePort
  /**
   * Hand an amended workflow (§9) to everything on this side of the seam.
   *
   * The scheduler has always taken one; nothing else did, and the run's
   * definition is read by three objects rather than one. The executor resolves
   * `gates[id].cmd` per gate run and the gate broker resolves it for a gate an
   * agent asks for, so an amendment that stopped at the scheduler moved the
   * snapshot, the journal and the pool reservations while leaving the command
   * that actually runs exactly as it was.
   *
   * The integrator takes one too. It was left out at first on the argument
   * that topology amendments are refused while the nodes they reach are in
   * flight — which holds for those nodes and not for the *wave* they sit in, so
   * a phase nobody depends on lands freely beside running wave-mates. See
   * `Integrator.adopt`.
   *
   * Absent for an injected executor, which owns whatever definition it was
   * built with.
   */
  readonly adopt?: (workflow: Workflow) => void
  /**
   * Handles this process opened. Never the lanes: §8 leaves worktrees, branches
   * and databases in place for the human who has to read what happened — and,
   * since runs became resumable, for the attempt that picks the run back up.
   */
  close(): void
}

/**
 * The `Integrator` the run uses, keeping what `mergeWave` returns.
 *
 * A wave's `ConflictRecord`s exist for the duration of that call and reach no
 * event, so §13.6's `wave_conflicts` is either captured at the one moment it
 * passes through or reported as unrecorded. Subclassed rather than wrapped
 * because `Integrator` calls its own methods on `this`.
 */
class RecordingIntegrator extends Integrator {
  readonly records: IntegrationWaveRecord[] = []

  override async mergeWave(wave: number): Promise<WaveResult> {
    const result = await super.mergeWave(wave)
    // Identifiers only, as `ConflictRecord` already is: node ids, paths, rounds.
    this.records.push({ wave: result.wave, conflicts: result.conflicts })
    return result
  }
}

export interface ProvisionOptions {
  readonly workflow: Workflow
  readonly runId: string
  readonly journal: Journal
  readonly repoPath: string
  readonly laneRoot: string
  readonly adapters: Readonly<Record<string, HarnessAdapter>>
  readonly agentEnv: Readonly<Record<string, string>>
  readonly perLaneBytes?: number
  /**
   * Reuse the lane worktrees already on disk instead of creating them.
   *
   * Set on a resume, and only there. The worktrees an interrupted run left
   * behind hold the one thing the journal does not: whatever its agents had
   * written and not committed. Provisioning over them is what `reap` exists to
   * make possible *deliberately*, and doing it implicitly on every resume would
   * silently eat the work the resume was meant to save.
   */
  readonly adopt?: boolean
}

/**
 * Provisions the pool and builds the production executor over it.
 *
 * The order is the one §8 requires: the pool's disk probe runs first and
 * throws before a single worktree exists, so a refusal costs nothing to
 * recover from. Everything after it is pure wiring.
 */
export async function provision(options: ProvisionOptions): Promise<HostWiring> {
  const { workflow, runId, journal, repoPath, laneRoot, adapters } = options

  // A staffed run gives every *implementer* its own worktree for the whole run —
  // the thing that lets a member's session outlive a phase, because a session is
  // about a directory. Reviewers get none: a review runs in the lane it is
  // reviewing, so that it reads the working tree before anything is committed.
  // The names are derived from the roster here and in the scheduler, from the
  // same function, so neither can drift from the other.
  const crewLanes = laneHolders(workflow.crew).map(
    (member, i) => `${runId}-crew-${i + 1}-${member.id}`,
  )

  const pool = await LanePool.provision({
    repoPath,
    poolRoot: laneRoot,
    runId,
    // The scheduler names its lane slots the same way, so a node's assigned
    // lane is one of these worktrees rather than a directory nobody made.
    laneCount: crewLanes.length > 0 ? crewLanes.length : (workflow.resources['lane']?.capacity ?? 1),
    ...(crewLanes.length === 0 ? {} : { laneNames: crewLanes }),
    baseRef: workflow.base_branch,
    // With no `project` block a lane is a worktree and nothing else, and
    // `migrateCmd` is never reached — templates are built per declared role.
    project: projectSpec(workflow.project),
    ...(options.adopt === true ? { adopt: true } : {}),
    ...(options.perLaneBytes === undefined ? {} : { perLaneBytes: options.perLaneBytes }),
  })

  // Read once, as one object, rather than through `pool.integration` twice.
  // `laneEnv` below goes through the pool on every call because a *lane* slot
  // can be handed back as a different `Lane` after a recycle re-provisions it —
  // but nothing recycles the integration worktree. `LanePool.recycle` is
  // reachable only through `HostWiring.recycleLane`, which the scheduler calls
  // with a node's lane slot, never `${runId}-integ`. So the object is stable
  // for the pool's life, and taking the path and the environment from the same
  // read is what keeps them describing the same tree: a fixer pointed at one
  // directory while carrying another one's compose project would be a worse
  // failure than a stale pair, and harder to see.
  const integration = pool.integration
  const integrationPath = integration.path
  const integrator = new RecordingIntegrator({
    // `Workflow` satisfies `IntegrationPlan` structurally.
    plan: workflow,
    integrationPath,
    fixer: conflictFixer(
      workflow,
      adapters,
      // The same overlay every lane's agent gets. The fixer is an agent: it
      // reports progress and asks for gates over the same `MAESTRO_URL` /
      // `MAESTRO_TOKEN` / `MAESTRO_RUN` triple, and without it a fix round is
      // the one agent turn in a run that cannot talk back to the daemon.
      { ...integration.env, ...options.agentEnv },
      () => journal.crewAssignments(runId),
      // Into the incoming phase's own transcript, beside the implementer and
      // reviewer turns that produced the branches now being merged — which is
      // where somebody asking "why does the merge look like this" is already
      // reading. Its `by.role` is what keeps it distinguishable from them.
      (nodeId, entry) => journal.appendTranscript(runId, nodeId, entry),
    ),
    /**
     * The gate a conflict resolution has to pass before it is committed.
     *
     * This seam has existed since the conflict loop did, documented as "a
     * resolution that does not build is not a resolution" — and nothing ever
     * supplied it. So every merge an agent resolved went in ungated: six of
     * them in one observed run, all in the same two files, none of them run
     * past a linter or a test before they became the base the next phase built
     * on. The phases either side were gated to the hilt; the merge between them
     * was not.
     *
     * Runs the *union* of the conflicting nodes' declared gates, in the
     * integration worktree, with that worktree's own environment — the same
     * environment the fixer agent gets, for the same reason: without it the
     * commands resolve to the wrong compose project and the wrong database.
     *
     * Deliberately not cached. `GateCache` keys on the lane's tree hash, and a
     * merge produces a tree nothing has ever gated, so a lookup could only ever
     * miss — and asking would put an entry under the integration worktree's
     * hash that no lane will ever match.
     *
     * A red gate returns false, which spends another fix round rather than
     * failing the phase: the fixer gets told, and the round budget is what
     * bounds it.
     */
    verify: async (cwd: string): Promise<boolean> => {
      const gates = [...new Set(workflow.nodes.flatMap((node) => node.gates))].filter(
        (id) => workflow.gates[id] !== undefined,
      )
      for (const id of gates) {
        const result = await executeGate({
          gateId: id,
          gate: workflow.gates[id] as Gate,
          cwd,
          env: { ...integration.env, ...options.agentEnv },
          // Filed under the integration worktree's own pseudo-node, so a merge
          // gate's log never overwrites a phase's log for the same gate id.
          logPath: journal.gateLogPath(runId, INTEGRATION_NODE, id),
        })
        if (result.exitCode !== 0) return false
      }
      return true
    },
    // Filed against the incoming node — the last of `nodes`, which is the one
    // whose merge hit the conflict and the one an operator is watching. The
    // other participants are in the payload, because a conflict is never one
    // phase's alone and a report naming only the second arrival reads as a
    // verdict on it.
    onConflict: (conflict) => {
      journal.append({
        runId,
        nodeId: conflict.nodes[conflict.nodes.length - 1] ?? conflict.branch,
        type: 'node_conflict',
        payload: {
          where: conflict.where,
          branch: conflict.branch,
          nodes: conflict.nodes,
          paths: conflict.paths,
          rounds: conflict.rounds,
        },
      })
    },
  })

  const cache = new GateCache(repoPath)
  // Every gate broker `gatesFor` hands out, so `adopt` can reach all of them.
  const brokers: AgentGateBroker[] = []
  const executor = createRunExecutor({
    workflow,
    runId,
    journal,
    integrator,
    integrationPath,
    laneRoot,
    lanes: pool.lanes.map(({ name, path, env }) => ({
      name,
      path,
      env: { ...env, ...options.agentEnv },
    })),
    cache,
  })

  const rebasePlan = createRebaser({
    integrationPath,
    // The base the run recorded, not the one the amended graph implies: it is
    // the fork point the rebase replays from.
    baseOf: (nodeId) =>
      journal.nodes(runId).find((row) => row.node_id === nodeId)?.base_branch ?? null,
    onRebased: (nodeId, base) => {
      journal.append({
        runId,
        nodeId,
        type: 'node_assigned',
        payload: { branch: integrator.nodeBranch(nodeId), base_branch: base },
      })
    },
  })

  return {
    executor,
    waveResults: () => integrator.records,
    // Through the executor's queue: the rebase and the wave merges write in
    // the same worktree, and an amendment lands whenever the nodes it blocks
    // are idle — which says nothing about whether another wave's merge is in
    // flight in that directory.
    rebase: async (request) => await executor.integration(() => rebasePlan(request)),
    adopt: (amended: Workflow) => {
      executor.adopt(amended)
      integrator.adopt(amended)
      for (const broker of brokers) broker.adopt(amended)
    },
    recycleLane: async (name: string) => {
      await pool.recycle(name)
    },
    // Read through the pool rather than captured, because a recycle that had to
    // re-provision hands back a different `Lane` object for the same slot.
    laneEnv: (name: string) => ({ ...pool.lane(name).env, ...options.agentEnv }),
    // The same cache the executor was given, so a gate an agent ran is a hit
    // for the `gate` node afterwards. Two caches over one project would be two
    // databases in one file's place and the hits would land in whichever one
    // nobody asked.
    gatesFor: (pools) => {
      const broker = new AgentGateBroker({
        workflow,
        runId,
        journal,
        pools,
        cache,
        // Through the pool for `laneEnv`'s reason, and with the same agent
        // environment overlaid: a gate run from inside a turn must see the
        // lane's forked database and compose project, exactly as the gate node's
        // run of it will.
        lane: (name: string) => {
          const lane = pool.lane(name)
          return { path: lane.path, env: { ...lane.env, ...options.agentEnv } }
        },
      })
      // Kept so an amendment reaches it. `gatesFor` is called once per run
      // today, but a broker this function forgot would be a broker running
      // last week's gate command with nothing anywhere saying so.
      brokers.push(broker)
      return broker
    },
    // What changed under a member while it was away: the files that differ
    // between the phase it last worked on and what is checked out now. It is
    // the whole safety argument for continuing a session across a phase, so a
    // failure here is reported as "unknown" by the caller rather than swallowed
    // into "nothing changed".
    laneDelta: async (name: string, priorNodeId: string) => {
      const lane = pool.lane(name)
      return await gitLines(lane.path, [
        'diff',
        '--name-only',
        integrator.nodeBranch(priorNodeId),
        'HEAD',
      ])
    },
    close: () => cache.close(),
  }
}

/**
 * The agent a conflicted merge is handed to, in the integration worktree.
 *
 * A run whose adapters were injected need not carry the default harness. The
 * orchestrator never resolves a conflict itself, so with no agent to hand it
 * to the merge exhausts its rounds and stops as the plan defect it is.
 *
 * On a staffed run the model comes off the roster rather than `defaults`, and
 * the journal is read at conflict time to find whose work is in the conflict —
 * both decided in `integration/staffing.ts`, which is also where the reason a
 * member's *session* is left behind is written down.
 *
 * `env` is the integration worktree's own, agent overlay included, and it is
 * not optional in practice: it was the one agent spawn in the run that did not
 * get its tree's environment, and the missing `COMPOSE_PROJECT_NAME` and
 * `COMPOSE_FILE` let a fix round publish the project's ports on the host under
 * a compose project nobody had reserved. `AgentTask.env` describes the failure
 * class; this was the last instance of it.
 */
function conflictFixer(
  workflow: Workflow,
  adapters: Readonly<Record<string, HarnessAdapter>>,
  env: Readonly<Record<string, string>>,
  crewAssignments: () => readonly StoredEvent[],
  record: (nodeId: string, entry: TranscriptEntry) => void,
): ConflictFixer {
  return createCrewConflictFixer({
    adapters,
    defaults: { harness: workflow.defaults.harness, model: workflow.defaults.model },
    crew: workflow.crew,
    env,
    crewAssignments,
    record,
  })
}

/**
 * Why the pool refused. Byte counts and a path — never git's output, which
 * carries repository content (§11).
 */
export function refusal(error: unknown, workflow: Workflow, laneRoot: string): string {
  const lanes = workflow.resources['lane']?.capacity ?? 1
  if (error instanceof DiskProbeError) {
    const { requiredBytes, availableBytes } = error.probe
    return (
      `vinta-ai-maestro: refusing to provision ${lanes} lanes + 1 integration worktree — ` +
      `${requiredBytes} bytes needed, ${availableBytes} available under ${laneRoot}. ` +
      'Free space, or lower resources.lane.capacity.'
    )
  }
  // The pool's own errors already say which lane and what went wrong; a generic
  // line over the top of them is what made a failing `setup_cmd` take an
  // afternoon to identify. Anything else stays generic, because anything else
  // may be carrying repository content in its message.
  if (error instanceof LaneSetupError || error instanceof LaneEnvFileError) {
    return `vinta-ai-maestro: ${error.message}`
  }
  return `vinta-ai-maestro: could not provision the lane pool under ${laneRoot}.`
}

/**
 * One real adapter per harness the workflow could dispatch to, each carrying
 * the operator's permission policy.
 *
 * The policy reaches the adapters here and nowhere else: it is an argument to
 * the command, not a field in the plan. A committed document that could say
 * "run agents without approvals" would say it on every machine that ever runs
 * it, including ones whose owner never agreed to that.
 *
 * The repository root goes with it, as the directory every agent may read.
 * Lanes are worktrees of a branch, so whatever the operator has not committed
 * is in their checkout and not in any lane — and a phase that reaches for it
 * is refused with a message that reads like a question nobody can answer.
 * Writing there stays impossible; `claude-code.ts` pairs the grant with the
 * deny list that keeps it to reading.
 */
export function defaultAdapters(
  workflow: Workflow,
  permission: AgentPermission,
  repoPath: string,
): Record<string, HarnessAdapter> {
  const adapters: Record<string, HarnessAdapter> = {}
  for (const id of referencedHarnesses(workflow)) {
    adapters[id] =
      id === 'claude-code'
        ? new ClaudeCodeAdapter({
            permission,
            readRoots: [repoPath],
            settingsDir: join(storeFor(repoPath), 'harness'),
          })
        : id === 'codex'
          ? new CodexAdapter({ permission })
          : new OpencodeAdapter()
  }
  return adapters
}

