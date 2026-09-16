/**
 * `vinta-ai-maestro run <workflow.json>` — start the daemon, then execute.
 *
 * The daemon comes up *before* the scheduler starts, and its URL is printed
 * before the first node dispatches. A run lasts hours; an operator who could
 * only reach the UI after the run finished would have no way to watch, steer or
 * answer an `await_human` gate — which is the entire §9 interaction model.
 *
 * **What is left here.** The composition moved to `src/run/`, where `serve`'s
 * `POST /api/runs` reaches it too. What stays is everything that is genuinely
 * about a command line: parsing flags, bringing up a daemon this process owns,
 * printing, turning an outcome into an exit code — and deciding to wait, which
 * is the one thing that distinguishes this host from the daemon-hosted one.
 *
 * **This command no longer owns the run's durability.** It used to be the only
 * way to start a run, which made the terminal the run's lifetime: closing it
 * killed the daemon, the scheduler and every agent, and left the `runs` row
 * saying `running` forever with nothing able to pick it up. Two things changed
 * that. A run can now be submitted to a daemon that was already up (`serve`),
 * and a run that *was* interrupted can be picked up again (`--resume`). What is
 * left in this file for the operator who does neither is the signal handling
 * below: SIGHUP, SIGINT and SIGTERM end the run through the same path a
 * finished one takes, so the journal says what actually happened.
 *
 * **Teardown is asymmetric on purpose.** The port, the databases and the caches
 * are closed in a `finally`; the *lanes are not*. §8 is explicit that a
 * finished run leaves its worktrees, branches and databases in place — they are
 * the evidence a human reads when something went wrong, and since `--resume`
 * they are also what the next attempt continues in.
 */
import { parseArgs } from 'node:util'

import { startDaemon, type Daemon, type DaemonRun } from '../daemon/index.ts'
import { formatDoctorReport } from '../doctor/index.ts'
import type { HarnessAdapter } from '../harness/adapter.ts'
import {
  AGENT_PERMISSIONS,
  DEFAULT_PERMISSION,
  isAgentPermission,
} from '../harness/permissions.ts'
import { openJournal, type Journal } from '../journal/journal.ts'
import type { EffectExecutor } from '../pipeline/effects.ts'
import type { IntegrationWaveRecord } from '../postmortem/postmortem.ts'
import { preflightRun, startRun, type StartedRun } from '../run/index.ts'
import type { RunStop } from '../scheduler/index.ts'
import type { DoctorOverrides } from './doctor.ts'
import { FAILED, OK, USAGE, loadWorkflow, type Io } from './io.ts'
import { errorFields, installCrashHandlers, redactValue } from '../log/index.ts'
import { reportLogFailures, toLogSetup } from './logging.ts'
import { SERVE_USAGE, announce, monitorFactory, toBind, untilSignalled } from './serve.ts'

export const RUN_USAGE = `usage: vinta-ai-maestro run <workflow.json> [--repo <dir>] [--host <host>] [--port <n>]
       vinta-ai-maestro run --resume <runId> [--repo <dir>] [--host <host>] [--port <n>]

  <workflow.json>  Usually ai-plans/<feature>.workflow.json — the committed
                 document plan-feature wrote and the editor edits.
  --resume <id>  Pick up a run that was interrupted, instead of starting one.
                 Phases already done stay done, their lane worktrees are reused
                 rather than recreated — whatever an agent had written and not
                 committed is still there — and a phase that was mid-turn when
                 the run stopped runs again from the top of its pipeline.
                 The plan comes from the run's frozen snapshot, not from the
                 file it was written from: editing that file afterwards does not
                 reach back into a run already under way.
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
        'on-failure': { type: 'string' },
        retries: { type: 'string' },
        resume: { type: 'string' },
        'log-level': { type: 'string' },
        'log-stderr': { type: 'boolean' },
        'log-detail': { type: 'string' },
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

  // Rejected here rather than passed through: an unrecognised value must not
  // quietly become the default, because the default is the permissive end of
  // the range and the typo most worth catching is `--permission ful`.
  const requested = parsed.values['permission']
  if (requested !== undefined && !isAgentPermission(requested)) {
    io.err(`vinta-ai-maestro: --permission must be one of ${AGENT_PERMISSIONS.join(', ')}`)
    return USAGE
  }
  const permission = requested ?? DEFAULT_PERMISSION

  // Rejected rather than defaulted, for the reason `--permission` is: a typo
  // that quietly became `stop` would look like the flag worked, and the
  // operator would find out by watching a failed run end without asking them.
  const onFailure = parsed.values['on-failure']
  if (
    onFailure !== undefined &&
    onFailure !== 'stop' &&
    onFailure !== 'retry' &&
    onFailure !== 'ask'
  ) {
    io.err('vinta-ai-maestro: --on-failure must be one of stop, retry, ask')
    return USAGE
  }

  // A budget, so it is bounded and finite. Zero is meaningful — it is `ask`
  // spelled through this flag — and anything unparseable is a typo worth
  // catching rather than a silent fallback to the default.
  const rawRetries = parsed.values['retries']
  const retries = rawRetries === undefined ? undefined : Number(rawRetries)
  if (retries !== undefined && (!Number.isInteger(retries) || retries < 0 || retries > 5)) {
    io.err('vinta-ai-maestro: --retries must be a whole number from 0 to 5')
    return USAGE
  }

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
  if (resumeId === undefined) {
    const loaded = await loadWorkflow(path as string, io)
    if (loaded === null) return FAILED
    workflow = loaded
    runId = deps.runId ?? `${workflow.id}-${Date.now().toString(36)}`
  } else {
    resumeJournal = openJournal(bind.repoPath)
    const row = resumeJournal.runs().find((candidate) => candidate.id === resumeId)
    if (row === undefined) {
      resumeJournal.close()
      io.err(`vinta-ai-maestro: no run "${resumeId}" in ${bind.repoPath}`)
      return FAILED
    }
    if (row.status === 'done') {
      resumeJournal.close()
      // Refused rather than started, because there is nothing to resume: every
      // node settled and a resume would do nothing but write a second
      // `run_ended` over a finished history. Re-running the plan is a different
      // request with a different answer.
      io.err(`vinta-ai-maestro: run "${resumeId}" already finished. Run the plan again instead.`)
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
      ...(deps.doctor === undefined ? {} : { doctor: deps.doctor }),
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

  // Same log the daemon-hosted path writes, in the same file. A run started
  // from a terminal and one submitted over HTTP are the same run to whoever is
  // debugging it a day later, and two log locations would be a question they
  // have to answer before they can start.
  const logging = toLogSetup(parsed.values, bind.repoPath, io)
  if (logging === null) {
    journal.close()
    return USAGE
  }
  const log = logging.logger

  let daemon: Daemon
  try {
    daemon = await startDaemon({
      journal,
      logger: log,
      warn: (message) => io.err(message),
      monitorFor: monitorFactory(journal, bind.repoPath, permission),
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

  // Installed before the run exists, so an exception during provisioning is
  // caught too — that is where a run spends its first minute, and a crash
  // there leaves the least behind.
  const uninstallCrashHandlers = installCrashHandlers({
    logger: log,
    detail: logging.detail,
    inFlight: () => [runId],
    onFatal: () => {
      journal.append({ runId, type: 'run_ended', payload: { status: 'failed' } })
    },
  })

  // Before the pool, which takes real time: an operator whose lanes are being
  // provisioned can already open the UI and watch them appear.
  announce(daemon, io)
  io.out(`Daemon log: ${logging.path}`)

  let started: StartedRun
  try {
    const result = await startRun({
      workflow,
      runId,
      journal,
      daemon,
      repoPath: bind.repoPath,
      permission,
      logger: log,
      ...(resumeId === undefined ? {} : { resume: true }),
      ...(onFailure === undefined ? {} : { onFailure }),
      ...(retries === undefined ? {} : { retries }),
      ...(deps.executor === undefined ? {} : { executor: deps.executor }),
      ...(deps.adapters === undefined ? {} : { adapters: deps.adapters }),
      ...(deps.perLaneBytes === undefined ? {} : { perLaneBytes: deps.perLaneBytes }),
      ...(deps.waveResults === undefined ? {} : { waveResults: deps.waveResults }),
    })
    if (!result.ok) {
      log.error('run.provision_failed', { run: runId, reason: result.message })
      uninstallCrashHandlers()
      reportLogFailures(logging.sink, io)
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
    await daemon.close()
    journal.close()
    io.err(`vinta-ai-maestro: run ${runId} could not be started.`)
    return FAILED
  }

  for (const warning of warnings) io.err(warning)
  io.out(
    resumeId === undefined
      ? `vinta-ai-maestro: run ${runId} started (${workflow.nodes.length} nodes).`
      : `vinta-ai-maestro: run ${runId} resumed (${workflow.nodes.length} nodes).`,
  )
  deps.onStarted?.(daemon, started.registered)

  const signals = untilSignalled()
  // Declared out here because the `finally` has to know which way the race
  // below went — the two paths tear down differently.
  let interrupted = false
  try {
    // Whichever comes first. A run that finishes normally resolves on the left;
    // an operator closing the terminal resolves on the right.
    interrupted = await Promise.race([
      started.finished.then(() => false),
      signals.signalled.then(() => true),
    ])

    if (interrupted) {
      // **Written before anything is closed, and this is the whole point of
      // handling the signal at all.** The scheduler is still mid-run and will
      // never reach its own `run_ended`, because this process is about to end
      // underneath it. Without this line the run stays `running` in the journal
      // for ever — indistinguishable, to the run list and to the UI, from one
      // still in flight — and the operator has a zombie instead of something
      // they can pick up again.
      //
      // `failed` rather than a status of its own: the run did not complete, and
      // the node rows say exactly how far it got. `--resume` refuses only a
      // `done` run, so this is precisely the state a resume expects to find.
      journal.append({ runId, type: 'run_ended', payload: { status: 'failed' } })
      log.warn('run.interrupted', { run: runId })
      io.err(`vinta-ai-maestro: run ${runId} interrupted.`)
      io.err(`vinta-ai-maestro: resume it with: vinta-ai-maestro run --resume ${runId}`)
      return FAILED
    }

    const { report, postMortem } = await started.finished
    if (postMortem !== null) io.out(`vinta-ai-maestro: post-mortem written to ${postMortem}`)
    if (report === null) {
      io.err(`vinta-ai-maestro: run ${runId} aborted. Its journal is intact and can be inspected.`)
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
    uninstallCrashHandlers()
    reportLogFailures(logging.sink, io)
    // The run's own handles are closed by `started.finished`, which owns them
    // whether or not anyone awaits it. What is left is what *this process*
    // opened around the run: the port and the journal.
    await daemon.close()
    // **Not closed on the interrupt path, and this is not an oversight.** The
    // scheduler is still running there — nobody awaited `finished` — and it
    // holds this exact journal: closing it underneath a live run turns every
    // in-flight `releaseLease` into "the database connection is not open",
    // which is a crash report standing where an interruption should be. The
    // process is exiting within milliseconds either way, and SQLite commits per
    // transaction, so the `run_ended` written above is already durable.
    if (!interrupted) journal.close()
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
