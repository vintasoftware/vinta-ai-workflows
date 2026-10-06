/**
 * `vinta-ai-maestro run <workflow.json>` — start a run as a background job.
 *
 * **Two halves, one command.** Without `--foreground`, this process does the
 * cheap checks — the flags, the workflow, whether a resume is possible at all
 * — then hands the run to a detached copy of itself and waits only until that
 * copy reports the run started (`job/job.ts`). It then prints the run id and
 * the commands that reach it, and exits. The terminal is free; the run is not
 * tied to it.
 *
 * With `--foreground`, this process *is* the job: it brings up the run's
 * loopback API — which its agents call back into for `with`, `gate` and the
 * judged hook — composes the run on it, and waits for it to end. That is what
 * the detached copy runs, and it is also how CI runs a plan, because there the
 * exit code is the point and nothing else is watching.
 *
 * **The job serves no UI.** `vinta-ai-maestro ui` is the process that serves
 * the app, and it forwards a live run's traffic to the job that hosts it. The
 * job's token is written to `runs/<id>/job.json` and nowhere else: never
 * printed, never logged.
 *
 * **How a job ends.** Four ways, and each leaves the journal saying which:
 *
 * - the DAG settles — `done` or `failed`, with a post-mortem;
 * - `pause` — running phases finish their current step, nothing new starts,
 *   and the run ends `paused`, resumable;
 * - `stop` — live turns and gates are killed and the run ends `cancelled`,
 *   which `--resume` refuses;
 * - a signal (SIGHUP, SIGINT, SIGTERM) — every live agent turn and gate is
 *   killed, a fix round and any merge standing in the integration worktree
 *   are ended, and the run ends `interrupted`, resumable. It used to end
 *   `failed` with the agents left running as orphans, still editing the
 *   worktree mid-merge.
 *
 * **Teardown is asymmetric on purpose.** The port, the databases and the caches
 * are closed in a `finally`; the *lanes are not*. §8 is explicit that a
 * finished run leaves its worktrees, branches and databases in place — they are
 * the evidence a human reads when something went wrong, and since `--resume`
 * they are also what the next attempt continues in.
 */
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { startDaemon, type Daemon, type DaemonRun } from '../daemon/index.ts'
import { formatDoctorReport } from '../doctor/index.ts'
import type { HarnessAdapter } from '../harness/adapter.ts'
import { launchJob, removeJob, writeJob, type LaunchResult } from '../job/job.ts'
import { openJournal, type Journal } from '../journal/journal.ts'
import type { EffectExecutor } from '../pipeline/effects.ts'
import type { IntegrationWaveRecord } from '../postmortem/postmortem.ts'
import { preflightRun, startRun, type RunSourcesInput, type StartedRun } from '../run/index.ts'
import type { RunStop } from '../scheduler/index.ts'
import type { DoctorOverrides } from './doctor.ts'
import { FAILED, OK, USAGE, loadPlan, loadWorkflow, type Io } from './io.ts'
import { errorFields, installCrashHandlers, redactValue } from '../log/index.ts'
import { reportLogFailures, toLogSetup, type LogValues } from './logging.ts'
import { jobArgs, resumeRefusal, toRunPolicy, type JobTarget, type RunPolicy } from './policy.ts'
import { monitorFactory, toBind, untilSignalled, type Bind } from './serve.ts'
import { createErrorFeed, tapErrors } from '../coordinator/errors.ts'
import { MAESTRO_RUN_ENV, MAESTRO_TOKEN_ENV, MAESTRO_URL_ENV } from '../resources/agent-leases.ts'
import { launcherPath } from '../run/start.ts'

/** How long a signalled run gets to kill its agents and drain before the process goes anyway. */
const INTERRUPT_DEADLINE_MS = 15_000
/** How long the daemon's port and sockets get to close on the way out. */
const CLOSE_DEADLINE_MS = 5_000

export const RUN_USAGE = `usage: vinta-ai-maestro run <workflow.json> [options]
       vinta-ai-maestro run --resume <runId> [options]

  Starts the run as a background job and returns once it is under way. The
  run carries on after this terminal closes. Reach it with:

    vinta-ai-maestro status [runId]     what it is doing
    vinta-ai-maestro logs <runId> -f    what it is saying
    vinta-ai-maestro ui                 the browser UI, for every run
    vinta-ai-maestro pause <runId>      finish current steps, then stop; resumable
    vinta-ai-maestro stop <runId>       kill it now; final

  <workflow.json>  Usually ai-plans/<feature>.workflow.json — the committed
                 document plan-feature wrote and the editor edits.
  --resume <id>  Pick up a run that was interrupted or paused, instead of
                 starting one. Phases already done stay done, their lane
                 worktrees are reused rather than recreated — whatever an agent
                 had written and not committed is still there — and a phase that
                 was mid-step when the run stopped runs again from the top of
                 its pipeline. The plan comes from the run's frozen snapshot,
                 not from the file it was written from: editing that file
                 afterwards does not reach back into a run already under way.
                 A run that finished, or was stopped, cannot be resumed.
  --foreground   Host the run in this process and wait for it to end, exiting
                 0 only when every phase completed. For CI, where the exit
                 code is the point. Closing the terminal then interrupts the
                 run, which stays resumable.

  --repo <dir>   The project whose .vinta-ai-maestro/ store holds the run.
                 Defaults to the current directory.
  --host <host>  The run's API bind address — what its agents call back into.
                 Defaults to 127.0.0.1; there is no reason to change it unless
                 agents run somewhere that cannot reach loopback.
  --port <n>     Defaults to 0 — an OS-assigned port.
  --on-failure, --retries, --retry-after, --permission, --system-one,
  --no-coordinator, --log-level, --log-stderr, --log-detail
                 As for \`vinta-ai-maestro ui --help\`, which documents each.`

export interface RunDeps {
  /**
   * Replaces the whole host composition: the effect bodies, the lane pool the
   * production ones run in, and the preflight that guards it. Present, this
   * command starts a daemon and schedules; absent, it builds the real thing.
   * Only meaningful with `--foreground`: a detached job is another process.
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
   * that, and is the only source for a run whose executor was injected.
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
  /**
   * How a background run is launched. Defaults to `launchJob`, which spawns a
   * detached copy of this CLI; a test hosts the job in its own process.
   */
  readonly launch?: (args: readonly string[], runId: string) => Promise<LaunchResult>
  /** How long a cancelled run may take to drain before it is ended anyway. */
  readonly cancelDeadlineMs?: number
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
        permission: { type: 'string' },
        'system-one': { type: 'string' },
        'on-failure': { type: 'string' },
        retries: { type: 'string' },
        'retry-after': { type: 'string' },
        resume: { type: 'string' },
        foreground: { type: 'boolean' },
        // Internal: the id the launcher chose, so it can say which run it
        // started before the job has written anything.
        'run-id': { type: 'string' },
        'log-level': { type: 'string' },
        'log-stderr': { type: 'boolean' },
        'log-detail': { type: 'string' },
        'no-intervene': { type: 'boolean' },
        'no-coordinator': { type: 'boolean' },
      },
      allowPositionals: true,
    })
  } catch {
    io.err(RUN_USAGE)
    return USAGE
  }

  // Exactly one of the two, because they name the run in incompatible ways: a
  // path starts a new run from a document, an id continues one whose plan is
  // already frozen. Accepting both would raise the question of which wins, and
  // every answer to that is a way to run the wrong plan.
  const path = parsed.positionals[0]
  const resumeId = parsed.values['resume']
  if (parsed.positionals.length > 1 || (path === undefined) === (resumeId === undefined)) {
    io.err(RUN_USAGE)
    return USAGE
  }

  const bind = toBind(parsed.values, io)
  if (bind === null) return USAGE
  const policy = toRunPolicy(parsed.values, io)
  if (policy === null) return USAGE

  if (parsed.values.foreground !== true) {
    return await launchRun({ path, resumeId, bind, policy, log: parsed.values, io, deps })
  }
  return await hostRun({
    path,
    resumeId,
    runId: parsed.values['run-id'],
    bind,
    policy,
    log: parsed.values,
    io,
    deps,
  })
}

interface RunRequest {
  readonly path: string | undefined
  readonly resumeId: string | undefined
  readonly bind: Bind
  readonly policy: RunPolicy
  readonly log: LogValues
  readonly io: Io
  readonly deps: RunDeps
}

/**
 * The background half: check what can be checked cheaply, launch the job,
 * wait for it to report the run started, say how to reach it.
 *
 * The preflight is the job's, not this process's. It runs the project's own
 * `prepare_cmd` — often a `docker compose up` — and running that twice per
 * start would be a real cost paid for nothing. The job's refusal comes back as
 * the text it printed, which is the same text a foreground run prints.
 */
async function launchRun(request: RunRequest): Promise<number> {
  const { bind, policy, io, deps } = request
  let target: JobTarget
  if (request.resumeId === undefined) {
    const workflow = await loadWorkflow(request.path as string, io, bind.repoPath)
    if (workflow === null) return FAILED
    target = {
      kind: 'workflow',
      path: request.path as string,
      runId: deps.runId ?? `${workflow.id}-${Date.now().toString(36)}`,
    }
  } else {
    const journal = openJournal(bind.repoPath)
    try {
      const refusal = resumeRefusal(journal, bind.repoPath, request.resumeId)
      if (refusal !== null) {
        io.err(refusal.message)
        return FAILED
      }
    } finally {
      journal.close()
    }
    target = { kind: 'resume', runId: request.resumeId }
  }

  const { runId } = target
  io.out(`vinta-ai-maestro: starting run ${runId} in the background…`)
  const args = jobArgs(target, bind, policy, request.log)
  const launched = await (deps.launch ?? ((jobArgv, id) =>
    launchJob({ repoPath: bind.repoPath, runId: id, args: jobArgv })))(args, runId)

  if (!launched.ok) {
    // The job's own words — the doctor report, the refusal — because those
    // are what the operator would have seen had they run it in the foreground.
    const output = launched.output.trimEnd()
    if (output !== '') io.err(output)
    io.err(`vinta-ai-maestro: run ${runId} did not start.`)
    return FAILED
  }

  const repo = bind.repoPath === resolve(process.cwd()) ? '' : ` --repo ${bind.repoPath}`
  io.out(`vinta-ai-maestro: run ${runId} ${target.kind === 'resume' ? 'resumed' : 'started'} (job pid ${launched.record.pid}).`)
  io.out(`  status   vinta-ai-maestro status ${runId}${repo}`)
  io.out(`  logs     vinta-ai-maestro logs ${runId} --follow${repo}`)
  io.out(`  ui       vinta-ai-maestro ui${repo}`)
  io.out(`  pause    vinta-ai-maestro pause ${runId}${repo}`)
  io.out(`  stop     vinta-ai-maestro stop ${runId}${repo}`)
  // The store is the checkout's (§11), so a UI started in another checkout —
  // the main one, while this run is in a worktree — lists other runs.
  io.out(`  (this run's state lives in ${bind.repoPath}/.vinta-ai-maestro; from another checkout, pass --repo ${bind.repoPath})`)
  return OK
}

/** The foreground half: this process is the run's job. */
async function hostRun(request: RunRequest & { readonly runId: string | undefined }): Promise<number> {
  const { bind, policy, io, deps } = request
  const { permission, systemOne } = policy
  const resumeId = request.resumeId

  // The plan, and where it came from. A resume reads the *frozen* snapshot —
  // the document the run actually started with — rather than the file on disk,
  // which may well have been edited in the hours since.
  //
  // A resume has to open the journal to find any of that out, and a fresh run
  // deliberately does not: §13.5's refusal creates nothing at all, and a store
  // opened before the preflight would already have broken that.
  let workflow
  let runId: string
  let resumeJournal: Journal | undefined
  let sources: RunSourcesInput | undefined
  if (resumeId === undefined) {
    const loaded = await loadPlan(request.path as string, io, bind.repoPath)
    if (loaded === null) return FAILED
    workflow = loaded.workflow
    sources = { path: request.path as string, authored: loaded.authored, config: loaded.config }
    runId = request.runId ?? deps.runId ?? `${workflow.id}-${Date.now().toString(36)}`
  } else {
    resumeJournal = openJournal(bind.repoPath)
    const refusal = resumeRefusal(resumeJournal, bind.repoPath, resumeId, process.pid)
    if (refusal !== null) {
      resumeJournal.close()
      io.err(refusal.message)
      return FAILED
    }
    try {
      workflow = resumeJournal.readWorkflow(resumeId)
    } catch {
      resumeJournal.close()
      io.err(`vinta-ai-maestro: run "${resumeId}" has no readable frozen workflow.`)
      return FAILED
    }
    runId = resumeId
  }

  // §13.5, and the position is the guarantee: before a port is bound, before a
  // journal is created and before the first worktree exists. Every minute-zero
  // failure reported in one pass beats discovering them one at a time across a
  // half-started run — and a refusal here leaves the checkout exactly as it was.
  //
  // Skipped for an injected executor, which owns its own lanes and needs none
  // of what this checks.
  const warnings: string[] = []
  if (deps.executor === undefined) {
    const preflight = await preflightRun({
      workflow,
      repoPath: bind.repoPath,
      // The same condition `startRun` gets `resume` from, so the preflight and
      // the pool cannot disagree about whether these lanes are being adopted.
      ...(resumeId === undefined ? {} : { resumeRunId: resumeId }),
      ...(deps.doctor === undefined ? {} : { doctor: deps.doctor }),
      permission,
      ...(systemOne === undefined ? {} : { systemOne }),
    })
    if (!preflight.ok) {
      resumeJournal?.close()
      if (preflight.report !== undefined) io.out(formatDoctorReport(preflight.report))
      io.err(preflight.message)
      return FAILED
    }
    warnings.push(...preflight.warnings)
  }

  const journal = resumeJournal ?? openJournal(bind.repoPath)

  // Same log the other commands write, in the same file. A run is the same run
  // to whoever is debugging it a day later however it was started, and two log
  // locations would be a question they have to answer before they can start.
  const logging = toLogSetup(request.log, bind.repoPath, io)
  if (logging === null) {
    journal.close()
    return USAGE
  }
  // Errors maestro logs about this run's job wake its coordinator.
  const errors = createErrorFeed()
  const log = tapErrors(logging.logger, errors.push)

  // One coordinator for the run, behind both the conversation endpoint and the
  // loop that wakes it. Its powers — the job's API with a token of its own, and
  // the launcher on PATH — exist once the daemon is listening.
  let coordinatorEnv: Readonly<Record<string, string>> | undefined
  const coordinators = monitorFactory(journal, bind.repoPath, permission, (id) =>
    id === runId ? coordinatorEnv : undefined,
  )

  let daemon: Daemon
  try {
    daemon = await startDaemon({
      journal,
      logger: log,
      warn: (message) => io.err(message),
      monitorFor: coordinators,
      // The app is `ui`'s to serve. This listener is for the run's agents and
      // for the commands that reach the run through `job.json`.
      serveUi: false,
      ...(bind.host === undefined ? {} : { host: bind.host }),
      ...(bind.port === undefined ? {} : { port: bind.port }),
    })
  } catch (error) {
    log.error('run.bind_failed', {
      host: bind.host ?? '127.0.0.1',
      port: bind.port ?? 0,
      ...errorFields(error),
    })
    reportLogFailures(logging.sink, io)
    journal.close()
    io.err(`vinta-ai-maestro: could not bind ${bind.host ?? '127.0.0.1'}:${bind.port ?? 0}`)
    return FAILED
  }

  redactValue(daemon.token)
  redactValue(daemon.coordinatorToken)
  coordinatorEnv = {
    [MAESTRO_URL_ENV]: daemon.url,
    [MAESTRO_TOKEN_ENV]: daemon.coordinatorToken,
    [MAESTRO_RUN_ENV]: runId,
    ...launcherPath(journal.root),
  }
  const startedAt = Date.now()
  const record = (state: 'starting' | 'running'): void =>
    writeJob(bind.repoPath, {
      runId,
      pid: process.pid,
      url: daemon.url,
      token: daemon.token,
      state,
      startedAt,
    })
  // Before the pool, which takes real time: `status` can already say the run
  // is starting, and `stop` can already find it.
  record('starting')

  // Installed before the run exists, so an exception during provisioning is
  // caught too — that is where a run spends its first minute, and a crash
  // there leaves the least behind.
  const uninstallCrashHandlers = installCrashHandlers({
    logger: log,
    detail: logging.detail,
    inFlight: () => [runId],
    onFatal: () => {
      journal.append({ runId, type: 'run_ended', payload: { status: 'failed' } })
      removeJob(bind.repoPath, runId, process.pid)
    },
  })

  io.out(`Daemon log: ${logging.path}`)

  // A cancel is a kill followed by a drain, and the drain is only as quick as
  // the slowest effect noticing its process died. This is the bound on it.
  let forceCancel = (): void => {}
  const forced = new Promise<'forced'>((resolve_) => {
    forceCancel = () => resolve_('forced')
  })
  let deadline: NodeJS.Timeout | undefined

  let started: StartedRun
  try {
    const result = await startRun({
      workflow,
      runId,
      journal,
      daemon,
      repoPath: bind.repoPath,
      permission,
      ...(systemOne === undefined ? {} : { systemOne }),
      logger: log,
      ...(resumeId === undefined ? {} : { resume: true }),
      ...(sources === undefined ? {} : { sources }),
      ...(policy.onFailure === undefined ? {} : { onFailure: policy.onFailure }),
      ...(policy.retries === undefined ? {} : { retries: policy.retries }),
      ...(policy.retryAfterMs === undefined ? {} : { retryAfterMs: policy.retryAfterMs }),
      ...(deps.executor === undefined ? {} : { executor: deps.executor }),
      ...(deps.adapters === undefined ? {} : { adapters: deps.adapters }),
      ...(deps.perLaneBytes === undefined ? {} : { perLaneBytes: deps.perLaneBytes }),
      ...(deps.waveResults === undefined ? {} : { waveResults: deps.waveResults }),
      // The coordinator's loop (`coordinator/`). The same factory, and so the
      // same coordinator, the conversation endpoint above serves.
      monitorFor: coordinators,
      errors,
      ...(policy.intervene ? {} : { intervene: false }),
      onHalt: (mode) => {
        log.info('run.halt_requested', { run: runId, mode })
        io.out(
          mode === 'paused'
            ? `vinta-ai-maestro: pausing run ${runId} — running phases finish their current step first.`
            : `vinta-ai-maestro: stopping run ${runId}.`,
        )
        if (mode === 'cancelled' && deadline === undefined) {
          deadline = setTimeout(forceCancel, deps.cancelDeadlineMs ?? 30_000)
          deadline.unref()
        }
      },
    })
    if (!result.ok) {
      log.error('run.provision_failed', { run: runId, reason: result.message })
      uninstallCrashHandlers()
      reportLogFailures(logging.sink, io)
      removeJob(bind.repoPath, runId, process.pid)
      await daemon.close()
      journal.close()
      io.err(result.message)
      return FAILED
    }
    started = result
  } catch (error) {
    log.error('run.start_threw', { run: runId, ...errorFields(error) })
    uninstallCrashHandlers()
    reportLogFailures(logging.sink, io)
    removeJob(bind.repoPath, runId, process.pid)
    await daemon.close()
    journal.close()
    io.err(`vinta-ai-maestro: run ${runId} could not be started.`)
    return FAILED
  }

  for (const warning of warnings) io.err(warning)
  record('running')
  io.out(
    resumeId === undefined
      ? `vinta-ai-maestro: run ${runId} started (${workflow.nodes.length} nodes).`
      : `vinta-ai-maestro: run ${runId} resumed (${workflow.nodes.length} nodes).`,
  )
  deps.onStarted?.(daemon, started.registered)

  const signals = untilSignalled()
  // Declared out here because the `finally` has to know which way the race
  // below went — the two paths tear down differently.
  let abandoned = false
  try {
    // Whichever comes first. A run that ends on its own — settled, paused or
    // stopped — resolves on the left; a signal or a cancel that would not
    // drain resolves on the right.
    const ended = await Promise.race([
      started.finished.then(() => 'finished' as const),
      signals.signalled.then(() => 'signalled' as const),
      forced,
    ])

    if (ended !== 'finished') {
      abandoned = true
      if (ended === 'signalled') {
        // The agents first. They are their own process groups, and a process
        // that exits without ending them leaves them running: an implementer
        // and its test suite went on editing the integration worktree, mid-
        // merge, after the daemon they reported to was gone. `interrupt`
        // kills every live turn and gate, the fix round and the merge, and the
        // scheduler then ends the run `interrupted` itself. Bounded, because a
        // kill that does not land must not keep this process alive.
        log.warn('run.interrupted', { run: runId })
        const interrupted = await Promise.race([
          started.interrupt().then(() => started.finished).then(() => true),
          new Promise<false>((resolve_) => setTimeout(() => resolve_(false), INTERRUPT_DEADLINE_MS).unref()),
        ])
        if (!interrupted) log.warn('run.interrupt_forced', { run: runId })
      }
      // **Written before anything is closed, and this is the whole point of
      // handling the signal at all.** Without it the run stays `running` in
      // the journal for ever — indistinguishable, to the run list and to the
      // UI, from one still in flight — and the operator has a zombie instead
      // of something they can pick up again. The scheduler writes its own
      // `run_ended` when the interrupt drained in time; this is for when it did
      // not, or for a cancel that outlived its deadline.
      const status = ended === 'forced' ? 'cancelled' : 'interrupted'
      if (journal.run(runId)?.status === 'running') {
        journal.append({ runId, type: 'run_ended', payload: { status } })
      }
      if (ended === 'forced') {
        log.warn('run.cancel_forced', { run: runId })
        io.err(`vinta-ai-maestro: run ${runId} stopped; some steps did not wind down in time.`)
      } else {
        io.err(`vinta-ai-maestro: run ${runId} interrupted.`)
        io.err(`vinta-ai-maestro: resume it with: vinta-ai-maestro run --resume ${runId}`)
      }
      return FAILED
    }

    const { report, postMortem } = await started.finished
    if (postMortem !== null) io.out(`vinta-ai-maestro: post-mortem written to ${postMortem}`)
    if (report === null) {
      io.err(`vinta-ai-maestro: run ${runId} aborted. Its journal is intact and can be inspected.`)
      return FAILED
    }

    if (report.halted === 'paused') {
      io.out(`vinta-ai-maestro: run ${runId} paused.`)
      io.out(`vinta-ai-maestro: resume it with: vinta-ai-maestro run --resume ${runId}`)
      return FAILED
    }
    if (report.halted === 'cancelled') {
      io.out(`vinta-ai-maestro: run ${runId} stopped.`)
      return FAILED
    }

    const failed = Object.entries(report.statuses)
      .filter(([, status]) => status === 'failed')
      .map(([id]) => id)

    if (report.stop !== undefined) {
      io.err(`vinta-ai-maestro: run ${runId} stopped — ${describeStop(report.stop)}`)
    }
    // Ids, then the reason each one carries. `RunReport.failures` is
    // identifiers only by contract — a lane name, a pipeline state, a harness
    // id — so this adds nothing §11 keeps off a stream.
    //
    // It used to print the ids alone, on the grounds that *why* is in the
    // node's transcript. That is true right up until the node failed before an
    // agent ever ran: a lane that will not provision, a pipeline that ended in
    // a failure state, a harness with no adapter. Those have no transcript, and
    // the operator was left with a node id and nowhere to look.
    if (failed.length > 0) {
      io.err(`vinta-ai-maestro: failed nodes: ${failed.join(', ')}`)
      for (const id of failed) {
        const why = report.failures[id]
        if (why !== undefined) io.err(`vinta-ai-maestro:   ${id}: ${why}`)
      }
    }

    io.out(`vinta-ai-maestro: run ${runId} ${report.status}.`)
    return report.status === 'completed' && failed.length === 0 ? OK : FAILED
  } finally {
    // Unhooked whichever way the race went: a watch left on a process that is
    // trying to exit is a listener holding the event loop open. The crash
    // handlers go for the same reason — and only here, once the race is
    // decided, so an exception thrown during teardown is still recorded.
    signals.cancel()
    if (deadline !== undefined) clearTimeout(deadline)
    uninstallCrashHandlers()
    reportLogFailures(logging.sink, io)
    removeJob(bind.repoPath, runId, process.pid)
    // The run's own handles are closed by `started.finished`, which owns them
    // whether or not anyone awaits it. What is left is what *this process*
    // opened around the run: the port and the journal. Bounded: a browser
    // socket that will not close held one observed shutdown open indefinitely
    // (`daemon.closing sockets=1`), and a port is not worth a process.
    await Promise.race([
      daemon.close(),
      new Promise<void>((resolve_) => setTimeout(resolve_, CLOSE_DEADLINE_MS).unref()),
    ])
    // **Not closed on the abandoned paths, and this is not an oversight.** The
    // scheduler is still running there — nobody awaited `finished` — and it
    // holds this exact journal: closing it underneath a live run turns every
    // in-flight `releaseLease` into "the database connection is not open",
    // which is a crash report standing where an interruption should be. The
    // process is exiting within milliseconds either way, and SQLite commits per
    // transaction, so the `run_ended` written above is already durable.
    if (!abandoned) journal.close()
  }
}

/** Identifiers only, matching what `formatSimulation` says about the same union. */
function describeStop(stop: RunStop): string {
  if (stop.kind === 'cycle') return `dependency cycle: ${stop.cycle.join(' → ')}`
  if (stop.kind === 'unsatisfiable') {
    return `node "${stop.nodeId}" requires unknown resource pool "${stop.resource}"`
  }
  return `deadlock, pending: ${stop.pending.join(', ')}`
}
