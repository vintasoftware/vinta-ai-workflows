/**
 * Starting a run, for whoever is hosting it.
 *
 * This used to be the middle of `cli/run.ts`, where it was inseparable from the
 * process that typed the command: the daemon was built by the run, so the run
 * could not outlive it, so closing a terminal threw away hours of agent work
 * with no way back. Everything below is the same composition with one thing
 * taken out of it — the decision about *who waits*.
 *
 * Three callers now share it, and the sharing is the point:
 *
 * - `run` starts a daemon, starts a run on it, and awaits the report.
 * - `POST /api/runs` starts a run on a daemon that is already up and answers
 *   with its id. Nobody awaits; the terminal that submitted it is irrelevant.
 * - `run --resume` / `POST /api/runs {"resume": id}` do either of the above
 *   against a run the journal already knows, rather than creating one.
 *
 * **Nothing here prints.** A daemon-hosted run has no stdout to print to, and a
 * composition that reached for `io` would be one the API could only call by
 * inventing a fake terminal. Refusals come back as values, the run's own
 * narration goes to the journal, and formatting is the caller's business.
 *
 * **What a resume is, exactly.** The journal is the run: node statuses,
 * branches, lanes and session ids all survive the process that wrote them, and
 * §8 leaves the worktrees standing. So resuming is not replay — it is the same
 * composition pointed at state that already exists. Finished phases stay
 * finished, their worktrees are adopted rather than recreated, and a phase that
 * was mid-turn when the process died runs again from the top of its pipeline,
 * because the turn it was in the middle of belonged to a process that is gone.
 */
import { AdmissionControl } from '../admission/admission.ts'
import type { AmendRunner } from '../amend/amend.ts'
import type { Daemon, DaemonRun } from '../daemon/index.ts'
import { runControl } from '../daemon/index.ts'
import { takeovers } from '../daemon/pty.ts'
import { runDoctor, type DoctorReport } from '../doctor/index.ts'
import type { DoctorOverrides } from '../cli/doctor.ts'
import type { HarnessAdapter } from '../harness/adapter.ts'
import type { AgentPermission } from '../harness/permissions.ts'
import type { Journal } from '../journal/journal.ts'
import { LanePrepareError, prepareInfrastructure } from '../lanes/pool.ts'
import type { EffectExecutor } from '../pipeline/effects.ts'
import {
  postMortem,
  writePostMortem,
  type IntegrationWaveRecord,
} from '../postmortem/postmortem.ts'
import { ResourcePools } from '../resources/pools.ts'
import {
  AgentLeaseBroker,
  MAESTRO_RUN_ENV,
  MAESTRO_TOKEN_ENV,
  MAESTRO_URL_ENV,
} from '../resources/agent-leases.ts'
import type { Logger } from '../log/index.ts'
import { createScheduler, type RunReport } from '../scheduler/index.ts'
import type { Workflow } from '../types.ts'
import { laneRootFor } from '../cli/paths.ts'
import { projectSpec } from '../cli/project.ts'
import { defaultAdapters, provision, refusal, type HostWiring } from './host.ts'
import { startSupervisor, type Supervisor } from '../intervention/supervisor.ts'
import type { Monitor } from '../monitor/monitor.ts'

export interface StartRunOptions {
  /** The frozen snapshot to execute. On a resume, read back from the journal. */
  readonly workflow: Workflow
  readonly runId: string
  readonly journal: Journal
  /** Already listening. This function never starts one — see the module note. */
  readonly daemon: Daemon
  readonly repoPath: string
  readonly permission: AgentPermission
  readonly onFailure?: 'stop' | 'retry' | 'ask'
  readonly retries?: number
  /**
   * Milliseconds an unanswered *failure* question waits before retrying itself.
   * Absent waits for a person, which is what every run did before the flag.
   */
  readonly retryAfterMs?: number
  /**
   * Pick up a run the journal already holds instead of creating one.
   *
   * The caller has already established that the run exists and read its frozen
   * workflow back; what this changes here is the three things that would
   * otherwise destroy the work being resumed — the run is not re-created, the
   * lanes are adopted rather than provisioned over, and the scheduler is seeded
   * from the journal instead of starting every node `pending`.
   */
  readonly resume?: boolean
  /** Replaces the whole host composition. Tests and out-of-tree hosts. */
  readonly executor?: EffectExecutor
  readonly adapters?: Readonly<Record<string, HarnessAdapter>>
  readonly perLaneBytes?: number
  readonly waveResults?: () => readonly IntegrationWaveRecord[]
  /**
   * The daemon's log, handed on to the scheduler this composes. Absent for a
   * host that wired none, and then nothing is written.
   */
  readonly logger?: Logger
  /**
   * Builds the run's monitor, for the watchdog that lets a run tune itself
   * (`intervention/`).
   *
   * Passed in rather than imported, because the factory lives in `cli/serve.ts`
   * and that module imports this one. It is also what makes the feature
   * optional in one place: a caller that supplies no monitor gets no watchdog,
   * which is what every test host and every out-of-tree host wants.
   */
  readonly monitorFor?: (runId: string) => Monitor | null
  /**
   * `--no-intervene`. The kill switch for a run that must execute exactly the
   * plan it was given, whatever it costs.
   */
  readonly intervene?: boolean
  /** Overrides the watchdog's thresholds. Tests, and an operator who wants a tighter leash. */
  readonly watchdog?: { readonly phaseThresholdMs?: number; readonly gateCostCeilingMs?: number }
  /** Autonomous amendments this run may make in total. */
  readonly interventionBudget?: number
}

/**
 * §13.5's preflight, as its own step because its callers can afford to refuse
 * at different moments.
 *
 * It is *not* part of `startRun`, and that is deliberate. `run` must be able to
 * refuse having created nothing at all — no lane root, no store, not even a
 * journal — which means checking before it opens one. A daemon already has its
 * journal open before any request arrives, so the earliest it can refuse is
 * after. Folding the check into `startRun` would have quietly cost `run` the
 * stronger guarantee to give the daemon one it cannot have.
 *
 * Both callers run it; neither duplicates it.
 */
export interface PreflightOptions {
  readonly workflow: Workflow
  readonly repoPath: string
  readonly doctor?: DoctorOverrides
}

export type PreflightResult =
  | { readonly ok: true; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly message: string; readonly report?: DoctorReport }

export async function preflightRun(options: PreflightOptions): Promise<PreflightResult> {
  const { workflow, repoPath } = options
  const project = projectSpec(workflow.project)

  try {
    // **Before the checks, not after them.** The hook's job is to make the
    // shared servers reachable and the preflight's is to check that they are;
    // in the other order the check reports the world as it was, and a project
    // that can bring its own stack up still fails to start.
    await prepareInfrastructure(project, repoPath)
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof LanePrepareError
          ? `vinta-ai-maestro: ${error.message}`
          : 'vinta-ai-maestro: the project’s prepare_cmd could not be run.',
    }
  }

  const report = await runDoctor({
    workflow,
    repoPath,
    poolRoot: laneRootFor(repoPath),
    // Without this the compose check is dead: `needsCompose(undefined)` is
    // false, so a workflow with a compose-delivered database was preflighted as
    // though docker were irrelevant to it.
    project,
    ...options.doctor,
  })
  if (!report.ok) {
    return {
      ok: false,
      message: 'vinta-ai-maestro: refusing to start — this environment cannot run this workflow.',
      report,
    }
  }

  const warnings = report.checks
    .filter((check) => check.status === 'warn')
    .map((check) => `vinta-ai-maestro: ${check.label}`)
  return { ok: true, warnings }
}

/**
 * Why a run did not start. Identifiers and a message, never a tool's output
 * (§11) — `refusal` in `host.ts` is what keeps git's stderr out of this.
 *
 * There is no doctor report here: by the time `startRun` is reached the
 * preflight has already passed, because its caller ran it at the last moment it
 * could still refuse having built nothing. What can fail from here on is the
 * lane pool, and its own errors already name the lane and the step.
 */
export interface StartRunRefusal {
  readonly ok: false
  readonly message: string
}

export interface StartedRun {
  readonly ok: true
  readonly runId: string
  /** Registered on the daemon before this returns, so the UI is reachable at once. */
  readonly registered: DaemonRun
  /**
   * Settles when the run does, having already written the post-mortem and
   * closed this run's handles.
   *
   * The whole point of the split: `run` awaits it, the daemon does not. A
   * daemon-hosted run therefore tidies up after itself — nothing is waiting to
   * do it on the way out of a request that returned hours ago.
   */
  readonly finished: Promise<RunOutcome>
}

export interface RunOutcome {
  /** `null` when the scheduler threw. The journal is intact either way. */
  readonly report: RunReport | null
  /** Where §13.6's artifact was written, or `null` when it could not be. */
  readonly postMortem: string | null
}

export type StartRunResult = StartedRun | StartRunRefusal

export async function startRun(options: StartRunOptions): Promise<StartRunResult> {
  const { workflow, runId, journal, daemon, repoPath, permission } = options
  const resume = options.resume === true
  const adapters = options.adapters ?? defaultAdapters(workflow, permission, repoPath)
  const laneRoot = laneRootFor(repoPath)
  // Freezes the snapshot and journals `run_started` plus one `node_registered`
  // per node — the log the projections are rebuilt from (§5.3). Skipped on a
  // resume, where all of that is already written: `createRun` would rewrite the
  // frozen workflow and reset every node row to `pending`, which is the precise
  // opposite of resuming.
  if (resume) {
    journal.append({ runId, type: 'run_resumed', payload: { attempt: attemptOf(journal, runId) } })
  } else {
    journal.createRun(runId, workflow)
  }

  let host: HostWiring
  try {
    host =
      options.executor === undefined
        ? await provision({
            workflow,
            runId,
            journal,
            repoPath,
            laneRoot,
            adapters,
            // The lanes are still on disk from the attempt that died, and the
            // uncommitted work inside them is the thing being resumed.
            adopt: resume,
            agentEnv: {
              [MAESTRO_URL_ENV]: daemon.url,
              [MAESTRO_TOKEN_ENV]: daemon.token,
              [MAESTRO_RUN_ENV]: runId,
            },
            ...(options.perLaneBytes === undefined ? {} : { perLaneBytes: options.perLaneBytes }),
          })
        : { executor: options.executor, close: () => {} }
  } catch (error) {
    return { ok: false, message: refusal(error, workflow, laneRoot) }
  }

  const pools = new ResourcePools(workflow.resources)
  const agentLeases = new AgentLeaseBroker(pools, journal, runId)
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
    ...(options.onFailure === undefined ? {} : { onFailure: options.onFailure }),
    ...(options.retries === undefined ? {} : { retries: options.retries }),
    ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
    // §9's take over, wired: the scheduler offers each live turn here and the
    // daemon's PTY channel resolves an `attach` against the same registry.
    takeovers,
    // What makes this a resume rather than a re-run: the node rows as the
    // interrupted process left them. Done phases stay done.
    ...(resume ? { resumeFrom: journal.nodes(runId) } : {}),
    // §8: a lane slot outlives the phase that used it, and the next phase must
    // not start in the last one's worktree or against its rows.
    ...(host.recycleLane === undefined ? {} : { recycleLane: host.recycleLane }),
    // The lane's isolation, reaching the process that needs it. Without this a
    // turn runs in the right directory with the wrong compose project.
    ...(host.laneEnv === undefined ? {} : { laneEnv: host.laneEnv }),
    // §15.2: an implementer keeps one worktree, so continuing across a phase is
    // safe as long as the agent is told which files moved under it.
    ...(host.laneDelta === undefined ? {} : { laneDelta: host.laneDelta }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  })

  // §9's amend needs two things this composition owns: the integration worktree
  // a `done` node's branch is moved in, and the live scheduler that hands an
  // amended definition to its unstarted nodes.
  // The run's definition as it stands, which is not `workflow` after the first
  // amendment. The watchdog proposes against this: a supervisor holding the
  // snapshot the run started with would offer its second intervention against
  // a document its first one already replaced.
  let current = workflow

  const amend: AmendRunner | undefined =
    host.rebase === undefined
      ? undefined
      : {
          rebase: host.rebase,
          adopt: (amended: Workflow) => {
            current = amended
            // The host side first, deliberately. `Scheduler.adopt` ends by
            // waking the dispatch loop, and a node it dispatches on that wake
            // reaches the executor immediately — so an executor still holding
            // the old definition would serve the very first node the amendment
            // made runnable. Doing the passive side first costs nothing: no
            // work starts because the executor learned something.
            host.adopt?.(amended)
            scheduler.adopt(amended)
          },
        }

  const registered: DaemonRun = {
    runId,
    control: runControl(scheduler),
    pools,
    admission,
    agentLeases,
    // The `gate` verb's route in. Absent for a host with no lanes, and then the
    // verb refuses rather than running a gate against a directory it guessed.
    ...(host.gatesFor === undefined ? {} : { agentGates: host.gatesFor(pools) }),
    ...(amend === undefined ? {} : { amend }),
  }
  daemon.register(registered)

  // The watchdog (`intervention/`). Off unless a monitor was supplied and the
  // operator did not say no, and off outright for a host that cannot amend —
  // a supervisor with no `AmendRunner` would spend model turns producing
  // proposals that `amendRun` refuses for want of somewhere to rebase.
  const monitor = options.intervene === false ? null : (options.monitorFor?.(runId) ?? null)
  const supervisor: Supervisor | null =
    monitor === null || amend === undefined
      ? null
      : startSupervisor({
          journal,
          runId,
          workflow: () => current,
          monitor,
          runner: amend,
          ...(options.watchdog === undefined ? {} : { watchdog: options.watchdog }),
          ...(options.interventionBudget === undefined
            ? {}
            : { budget: options.interventionBudget }),
        })

  // Started, not awaited. The promise carries its own teardown so that the one
  // caller who never looks at it — the daemon — still gets it.
  const finished = (async (): Promise<RunOutcome> => {
    try {
      const report = await scheduler.run()
      // `scheduler.run` journalled `run_ended`, which is the one moment a
      // post-mortem is true (§13.6).
      return { report, postMortem: emitPostMortem(journal, runId, options.waveResults ?? host.waveResults) }
    } catch {
      return { report: null, postMortem: null }
    } finally {
      // Everything closed here is a handle this run opened. The lanes are
      // deliberately absent — see `HostWiring.close`.
      supervisor?.stop()
      admission.close()
      agentLeases.close()
      host.close()
    }
  })()

  return { ok: true, runId, registered, finished }
}

/**
 * Which hosting process this is: 1 for the original, one more per resume.
 *
 * Counted off the log rather than kept in the `runs` row, for §5.3's reason —
 * dropping every projection and replaying reproduces it. Reading the whole
 * event list to count two kinds of row is affordable exactly once per process.
 */
function attemptOf(journal: Journal, runId: string): number {
  let resumes = 0
  for (const event of journal.events(runId)) {
    if (event.type === 'run_resumed') resumes += 1
  }
  // The original attempt, plus the ones already recorded, plus this one.
  return resumes + 2
}

/**
 * Writes `runs/<id>/postmortem.json` (§13.6), the artifact `plan-feature` reads
 * when planning the next feature in this repo.
 *
 * Never fatal. The run is over and its journal is intact by the time this runs;
 * failing because a derived report could not be written would throw away the
 * work in order to report on the reporting.
 */
function emitPostMortem(
  journal: Journal,
  runId: string,
  waveResults: (() => readonly IntegrationWaveRecord[]) | undefined,
): string | null {
  try {
    const integration = waveResults?.()
    const report = postMortem(journal, runId, integration === undefined ? {} : { integration })
    return writePostMortem(journal.root, report)
  } catch {
    return null
  }
}
