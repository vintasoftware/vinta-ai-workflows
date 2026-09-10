/**
 * `vinta-flow run <workflow.json>` — start the daemon, then execute.
 *
 * The daemon comes up *before* the scheduler starts, and its URL is printed
 * before the first node dispatches. A run lasts hours; an operator who could
 * only reach the UI after the run finished would have no way to watch, steer or
 * answer an `await_human` gate — which is the entire §9 interaction model.
 *
 * This command composes; it decides nothing. The journal freezes the workflow
 * snapshot, `ResourcePools` owns capacity, `AdmissionControl` owns backpressure,
 * and `Scheduler` owns dispatch. What is assembled here is only the wiring, and
 * the one thing wiring can get wrong — teardown — is done in a `finally` so a
 * failed run does not leave a bound port and an open database behind.
 *
 * **What this composes.** The scheduler implements two effect verbs itself
 * (`spawn_agent`, and the pools around `run_gate`) and delegates every other
 * verb body to an `EffectExecutor`. The production one is `src/executor/`, and
 * it needs two things this command owns: the lanes its gates and agents run in
 * (`LanePool`) and the integration worktree its merges happen in
 * (`Integrator`). Both are built here, before the first node dispatches, and
 * both are handed to the same `RunEffectExecutor`. `RunDeps.executor` replaces
 * all of it — a host that injects one owns its own lanes, so neither the
 * preflight nor the pool runs.
 *
 * **Preflight, then provision, and never the other way round.** `doctor` runs
 * before anything is created and a single `fail` refuses the run (§13.5): every
 * minute-zero failure reported in one pass beats discovering them one at a time
 * across a half-started run. `LanePool`'s own N× disk probe is the same rule
 * one level down (§8) — it refuses before the first worktree exists rather than
 * filling the filesystem partway through wave 1.
 *
 * **Teardown is asymmetric on purpose.** The port, the databases and the caches
 * are closed in a `finally`; the *lanes are not*. §8 is explicit that a
 * finished run leaves its worktrees, branches and databases in place — they are
 * the evidence a human reads when something went wrong.
 *
 * **The post-mortem is emitted here.** It is true at exactly one moment —
 * after `run_ended` — and the scheduler journals that as it returns, so this
 * is the only place that moment is reachable while the journal is still open.
 * Conflicts are not journalled by anything, so they are read back off the
 * `Integrator` this file built (`deps.waveResults` overrides); with neither the
 * artifact says "unrecorded" rather than "none".
 */
import { parseArgs } from 'node:util'

import { AdmissionControl } from '../admission/admission.ts'
import type { AmendRunner } from '../amend/amend.ts'
import { createRebaser } from '../amend/rebase.ts'
import { runControl, startDaemon, type Daemon, type DaemonRun } from '../daemon/index.ts'
import { takeovers } from '../daemon/pty.ts'
import { formatDoctorReport, referencedHarnesses, runDoctor } from '../doctor/index.ts'
import { createRunExecutor } from '../executor/index.ts'
import { GateCache } from '../gates/cache.ts'
import type { HarnessAdapter } from '../harness/adapter.ts'
import { ClaudeCodeAdapter } from '../harness/claude-code.ts'
import { CodexAdapter } from '../harness/codex.ts'
import { OpencodeAdapter } from '../harness/opencode.ts'
import { createAgentConflictFixer, type ConflictFixer } from '../integration/fixer.ts'
import { Integrator, type WaveResult } from '../integration/integrator.ts'
import { openJournal, type Journal } from '../journal/journal.ts'
import type { DatabaseSpec } from '../lanes/database.ts'
import { DiskProbeError } from '../lanes/disk.ts'
import { LanePool, type ProjectSpec } from '../lanes/pool.ts'
import type { EffectExecutor } from '../pipeline/effects.ts'
import {
  postMortem,
  writePostMortem,
  type IntegrationWaveRecord,
} from '../postmortem/postmortem.ts'
import { ResourcePools } from '../resources/pools.ts'
import { createScheduler, type RunStop } from '../scheduler/index.ts'
import type { Project, ProjectDatabase, Workflow } from '../types.ts'
import type { DoctorOverrides } from './doctor.ts'
import { FAILED, OK, USAGE, loadWorkflow, type Io } from './io.ts'
import { laneRootFor } from './paths.ts'
import { SERVE_USAGE, announce, toBind } from './serve.ts'

export const RUN_USAGE = `usage: vinta-flow run <workflow.json> [--repo <dir>] [--host <host>] [--port <n>]

${SERVE_USAGE.split('\n').slice(1).join('\n')}`

export interface RunDeps {
  /**
   * Replaces the whole host composition: the effect bodies, the lane pool the
   * production ones run in, and the preflight that guards it. Present, this
   * command starts a daemon and schedules; absent, it builds the real thing.
   */
  readonly executor?: EffectExecutor
  /** Adapters by harness id. Defaults to the real CLI-driving ones. */
  readonly adapters?: Readonly<Record<string, HarnessAdapter>>
  /** Defaults to `<workflow id>-<base36 timestamp>`. */
  readonly runId?: string
  /**
   * The integrator's wave results, read once the run has ended (§13.6).
   * Conflicts are returned by `mergeWave` in process and no event carries
   * them. The composed run reads them off its own `Integrator`; this overrides
   * that, and is the only source for a run whose executor was injected. A
   * callback rather than a value because the merges have not happened yet when
   * this is passed. With neither, the post-mortem records
   * `integration_record_unavailable` — "unrecorded", never "clean".
   */
  readonly waveResults?: () => readonly IntegrationWaveRecord[]
  /**
   * Preflight overrides — the injected binaries and disk estimate `runDoctor`
   * already takes. There is no flag for them, for `doctor`'s own reason: a
   * preflight that reads its answers from the command line is not one.
   */
  readonly doctor?: DoctorOverrides
  /** Overrides the pool's measured per-lane disk estimate (§8's N× probe). */
  readonly perLaneBytes?: number
  /** Called once the daemon is up and the run has been registered. */
  readonly onStarted?: (daemon: Daemon, run: DaemonRun) => void
}

export async function runCommand(
  argv: readonly string[],
  io: Io,
  deps: RunDeps = {},
): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        repo: { type: 'string' },
        host: { type: 'string' },
        port: { type: 'string' },
      },
      allowPositionals: true,
    })
  } catch {
    io.err(RUN_USAGE)
    return USAGE
  }

  const path = parsed.positionals[0]
  if (path === undefined || parsed.positionals.length > 1) {
    io.err(RUN_USAGE)
    return USAGE
  }

  const bind = toBind(parsed.values, io)
  if (bind === null) return USAGE

  const workflow = await loadWorkflow(path, io)
  if (workflow === null) return FAILED

  const runId = deps.runId ?? `${workflow.id}-${Date.now().toString(36)}`
  const adapters = deps.adapters ?? defaultAdapters(workflow)
  const laneRoot = laneRootFor(bind.repoPath)

  // §13.5, before a port is bound, a journal is opened or a worktree exists: a
  // run that cannot possibly work says so now, in one report, rather than
  // failing three phases in. A `warn` is a degraded run, not a stopped one.
  if (deps.executor === undefined) {
    const report = await runDoctor({
      workflow,
      repoPath: bind.repoPath,
      poolRoot: laneRoot,
      ...deps.doctor,
    })
    if (!report.ok) {
      io.out(formatDoctorReport(report))
      io.err('vinta-flow: refusing to start — this environment cannot run this workflow.')
      return FAILED
    }
    for (const check of report.checks) {
      if (check.status === 'warn') io.err(`vinta-flow: ${check.label}`)
    }
  }

  const journal = openJournal(bind.repoPath)

  let daemon: Daemon
  try {
    daemon = await startDaemon({
      journal,
      warn: (message) => io.err(message),
      ...(bind.host === undefined ? {} : { host: bind.host }),
      ...(bind.port === undefined ? {} : { port: bind.port }),
    })
  } catch {
    journal.close()
    io.err(`vinta-flow: could not bind ${bind.host ?? '127.0.0.1'}:${bind.port ?? 0}`)
    return FAILED
  }

  // Freezes the snapshot and journals `run_started` plus one `node_registered`
  // per node — the log the projections are rebuilt from (§5.3).
  journal.createRun(runId, workflow)

  // Before the pool, which takes real time: an operator whose lanes are being
  // provisioned can already open the UI and watch them appear.
  announce(daemon, io)
  io.out(`vinta-flow: run ${runId} started (${workflow.nodes.length} nodes).`)

  let host: HostWiring
  try {
    host =
      deps.executor === undefined
        ? await provision({
            workflow,
            runId,
            journal,
            repoPath: bind.repoPath,
            laneRoot,
            adapters,
            ...(deps.perLaneBytes === undefined ? {} : { perLaneBytes: deps.perLaneBytes }),
          })
        : { executor: deps.executor, close: () => {} }
  } catch (error) {
    await daemon.close()
    journal.close()
    io.err(refusal(error, workflow, laneRoot))
    return FAILED
  }

  const pools = new ResourcePools(workflow.resources)
  const admission = new AdmissionControl({
    journal,
    runId,
    // A starting hint, not a contract: O1 settles that the real ceiling is
    // discovered at runtime, so the lane count is as good a first guess as any.
    ceilings: Object.fromEntries(
      Object.keys(adapters).map((id) => [id, workflow.resources['lane']?.capacity ?? 1]),
    ),
  })

  const scheduler = createScheduler({
    workflow,
    runId,
    journal,
    pools,
    admission,
    adapters,
    executor: host.executor,
    laneRoot,
    // §9's take over, wired: the scheduler offers each live turn here and the
    // daemon's PTY channel resolves an `attach` against the same registry.
    // Both sides default to this instance; naming it once is what makes the
    // button on a running node reach a session rather than an empty map.
    takeovers,
    // §8: a lane slot outlives the phase that used it, and the next phase must
    // not start in the last one's worktree or against its rows.
    ...(host.recycleLane === undefined ? {} : { recycleLane: host.recycleLane }),
  })

  // §9's amend needs two things this file owns: the integration worktree a
  // `done` node's branch is moved in, and the live scheduler that hands an
  // amended definition to its unstarted nodes. Without the rebaser an
  // amendment that moves a `done` node's base is refused (`rebase_unavailable`)
  // rather than half-applied.
  const amend: AmendRunner | undefined =
    host.rebase === undefined
      ? undefined
      : { rebase: host.rebase, adopt: (amended: Workflow) => scheduler.adopt(amended) }

  const run: DaemonRun = {
    runId,
    control: runControl(scheduler),
    pools,
    admission,
    ...(amend === undefined ? {} : { amend }),
  }
  daemon.register(run)
  deps.onStarted?.(daemon, run)

  try {
    const report = await scheduler.run()
    // `scheduler.run` journalled `run_ended`, which is the one moment a
    // post-mortem is true (§13.6). Emitted before the `finally` closes the
    // journal, and before the exit code is decided: a failed run is exactly
    // the run whose plan the next one most needs to learn from.
    emitPostMortem(journal, runId, deps.waveResults ?? host.waveResults, io)

    const failed = Object.entries(report.statuses)
      .filter(([, status]) => status === 'failed')
      .map(([id]) => id)

    if (report.stop !== undefined) {
      io.err(`vinta-flow: run ${runId} stopped — ${describeStop(report.stop)}`)
    }
    // Node ids only. Why a node failed is in its transcript, which stays on disk.
    if (failed.length > 0) io.err(`vinta-flow: failed nodes: ${failed.join(', ')}`)

    io.out(`vinta-flow: run ${runId} ${report.status}.`)
    return report.status === 'completed' && failed.length === 0 ? OK : FAILED
  } catch {
    io.err(`vinta-flow: run ${runId} aborted. Its journal is intact and can be inspected.`)
    return FAILED
  } finally {
    // Everything closed here is a handle this process opened. The lanes are
    // deliberately absent: §8 leaves worktrees, branches and databases in place
    // for the human who has to read what happened, and the skill's teardown
    // steps reverse them from the summary on disk.
    admission.close()
    host.close()
    await daemon.close()
    journal.close()
  }
}

/**
 * Writes `runs/<id>/postmortem.json` (§13.6), the artifact `plan-feature`
 * reads when planning the next feature in this repo.
 *
 * Never fatal. The run is over and its journal is intact by the time this
 * runs; failing the command because a derived report could not be written
 * would throw away the work to report on the reporting. The message carries
 * identifiers and a path, like every other line here.
 */
function emitPostMortem(
  journal: Journal,
  runId: string,
  waveResults: (() => readonly IntegrationWaveRecord[]) | undefined,
  io: Io,
): void {
  try {
    const integration = waveResults?.()
    const report = postMortem(journal, runId, integration === undefined ? {} : { integration })
    io.out(`vinta-flow: post-mortem written to ${writePostMortem(journal.root, report)}`)
  } catch {
    io.err(`vinta-flow: run ${runId} produced no post-mortem.`)
  }
}

// ---------------------------------------------------------------------------
// The host composition: lanes, the integrator, and the executor over both
// ---------------------------------------------------------------------------

/** What the run needs from whoever owns the lanes — this file, or `RunDeps`. */
interface HostWiring {
  readonly executor: EffectExecutor
  /** Read after `run_ended`. Absent for an injected executor, which owns its own. */
  readonly waveResults?: () => readonly IntegrationWaveRecord[]
  /** `DaemonRun.amend`'s rebase. Absent means an amendment that needs one is refused. */
  readonly rebase?: NonNullable<AmendRunner['rebase']>
  /** The scheduler's lane hand-over (§8). Absent for a host that owns its lanes. */
  readonly recycleLane?: (name: string) => Promise<void>
  /** Handles this process opened. Never the lanes — see the `finally` above. */
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

interface ProvisionOptions {
  readonly workflow: Workflow
  readonly runId: string
  readonly journal: Journal
  readonly repoPath: string
  readonly laneRoot: string
  readonly adapters: Readonly<Record<string, HarnessAdapter>>
  readonly perLaneBytes?: number
}

/**
 * Provisions the pool and builds the production executor over it.
 *
 * The order is the one §8 requires: the pool's disk probe runs first and
 * throws before a single worktree exists, so a refusal costs nothing to
 * recover from. Everything after it is pure wiring.
 */
async function provision(options: ProvisionOptions): Promise<HostWiring> {
  const { workflow, runId, journal, repoPath, laneRoot, adapters } = options

  const pool = await LanePool.provision({
    repoPath,
    poolRoot: laneRoot,
    runId,
    // The scheduler names its lane slots the same way, so a node's assigned
    // lane is one of these worktrees rather than a directory nobody made.
    laneCount: workflow.resources['lane']?.capacity ?? 1,
    baseRef: workflow.base_branch,
    // With no `project` block a lane is a worktree and nothing else, and
    // `migrateCmd` is never reached — templates are built per declared role.
    project: projectSpec(workflow.project),
    ...(options.perLaneBytes === undefined ? {} : { perLaneBytes: options.perLaneBytes }),
  })

  const integrationPath = pool.integration.path
  const integrator = new RecordingIntegrator({
    // `Workflow` satisfies `IntegrationPlan` structurally.
    plan: workflow,
    integrationPath,
    fixer: conflictFixer(workflow, adapters),
  })

  const cache = new GateCache(repoPath)
  const executor = createRunExecutor({
    workflow,
    runId,
    journal,
    integrator,
    integrationPath,
    laneRoot,
    lanes: pool.lanes.map(({ name, path, env }) => ({ name, path, env })),
    cache,
  })

  const rebase = createRebaser({
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
    rebase,
    recycleLane: async (name: string) => {
      await pool.recycle(name)
    },
    close: () => cache.close(),
  }
}

/**
 * The workflow's `project` block in `LanePool`'s terms.
 *
 * The two shapes differ only in casing, which is deliberate: the document is
 * snake_case like every other field a skill writes, and the pool's is the
 * package's own. `delivery: 'file'` is not a field a workflow may state — it
 * is what a SQLite database *is*, and offering the choice would only let a
 * document say something untrue.
 */
function projectSpec(project: Project | undefined): ProjectSpec {
  if (project === undefined) return { databases: {}, migrateCmd: 'true' }
  const { dev, test } = project.databases
  return {
    migrateCmd: project.migrate_cmd,
    databases: {
      ...(dev === undefined ? {} : { dev: databaseSpec(dev) }),
      ...(test === undefined ? {} : { test: databaseSpec(test) }),
    },
  }
}

function databaseSpec(database: ProjectDatabase): DatabaseSpec {
  if (database.engine === 'sqlite') {
    return {
      engine: 'sqlite',
      delivery: 'file',
      path: database.path,
      connectionUrlVar: database.connection_url_var,
    }
  }
  return {
    engine: 'postgres',
    delivery: database.delivery,
    name: database.name,
    serverUrl: database.server_url,
    connectionUrlVar: database.connection_url_var,
  }
}

/**
 * The agent a conflicted merge is handed to, in the integration worktree.
 *
 * A run whose adapters were injected need not carry the default harness. The
 * orchestrator never resolves a conflict itself, so with no agent to hand it
 * to the merge exhausts its rounds and stops as the plan defect it is.
 */
function conflictFixer(
  workflow: Workflow,
  adapters: Readonly<Record<string, HarnessAdapter>>,
): ConflictFixer {
  const adapter = adapters[workflow.defaults.harness] ?? Object.values(adapters)[0]
  if (adapter === undefined) return { fix: async () => {} }
  return createAgentConflictFixer({ adapter, model: workflow.defaults.model })
}

/**
 * Why the pool refused. Byte counts and a path — never git's output, which
 * carries repository content (§11).
 */
function refusal(error: unknown, workflow: Workflow, laneRoot: string): string {
  const lanes = workflow.resources['lane']?.capacity ?? 1
  if (error instanceof DiskProbeError) {
    const { requiredBytes, availableBytes } = error.probe
    return (
      `vinta-flow: refusing to provision ${lanes} lanes + 1 integration worktree — ` +
      `${requiredBytes} bytes needed, ${availableBytes} available under ${laneRoot}. ` +
      'Free space, or lower resources.lane.capacity.'
    )
  }
  return `vinta-flow: could not provision the lane pool under ${laneRoot}.`
}

/** One real adapter per harness the workflow could dispatch to. */
function defaultAdapters(workflow: Workflow): Record<string, HarnessAdapter> {
  const adapters: Record<string, HarnessAdapter> = {}
  for (const id of referencedHarnesses(workflow)) {
    adapters[id] =
      id === 'claude-code'
        ? new ClaudeCodeAdapter()
        : id === 'codex'
          ? new CodexAdapter()
          : new OpencodeAdapter()
  }
  return adapters
}

/** Identifiers only, matching what `formatSimulation` says about the same union. */
function describeStop(stop: RunStop): string {
  if (stop.kind === 'cycle') return `dependency cycle: ${stop.cycle.join(' → ')}`
  if (stop.kind === 'unsatisfiable') {
    return `node "${stop.nodeId}" requires unknown resource pool "${stop.resource}"`
  }
  return `deadlock, pending: ${stop.pending.join(', ')}`
}
