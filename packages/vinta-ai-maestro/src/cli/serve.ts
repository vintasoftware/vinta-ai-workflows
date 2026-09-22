/**
 * `vinta-ai-maestro serve` — start the daemon and hand the operator its URL.
 *
 * That URL is the whole point of the command. There is no login, no account
 * and no session (§11): the token minted at boot *is* the access to the run,
 * so a daemon whose URL was not printed would be a port nobody can open. It is
 * therefore printed exactly once, on stdout, and it is the only place in this
 * package's output where the token appears.
 *
 * The rules that follow from that, all enforced below:
 *
 * - **The token is never logged.** Not in the "listening on" line, not in the
 *   `--host` warning, not in an error. `announce` is the single writer, and
 *   everything else prints `daemon.url`, which by construction carries no
 *   token.
 * - **Loopback unless asked otherwise.** `--host` is a named flag; omitting it
 *   binds `127.0.0.1`. The daemon warns on a non-loopback bind and names the
 *   host, and that warning goes to stderr where it cannot be mistaken for part
 *   of the URL.
 * - **The URL is a secret.** The line above it says so, because an operator who
 *   pastes it into a ticket has published the run.
 *
 * `--repo` is the only thing this command tells the daemon about the project,
 * and it settles both halves of §10's Editor row: the journal it serves lives
 * under `<repo>/.vinta-ai-maestro`, and the workflows it lists are
 * `<repo>/ai-plans/*.workflow.json` — the committed documents `plan-feature`
 * wrote and `vinta-ai-maestro run` is pointed at. Neither is passed separately, so
 * they cannot come to disagree about which checkout is open.
 */
import { networkInterfaces } from 'node:os'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import {
  TOKEN_QUERY,
  createWorkflowStore,
  isWorkflowId,
  plansDirFor,
  startDaemon,
  type Daemon,
  type RunStartOutcome,
  type RunStartPort,
  type RunStartRequest,
} from '../daemon/index.ts'
import type { Journal } from '../journal/journal.ts'
import { openJournal } from '../journal/journal.ts'
import {
  errorFields,
  installCrashHandlers,
  nullLogger,
  redactValue,
  type Logger,
} from '../log/index.ts'
import { reportLogFailures, toLogSetup } from './logging.ts'
import { ClaudeCodeAdapter } from '../harness/claude-code.ts'
import {
  AGENT_PERMISSIONS,
  DEFAULT_PERMISSION,
  isAgentPermission,
  type AgentPermission,
} from '../harness/permissions.ts'
import { Monitor, monitorModel } from '../monitor/monitor.ts'
import { preflightRun, startRun } from '../run/index.ts'
import type { Workflow } from '../types.ts'
import { parseWorkflow } from '../validate.ts'
import type { DoctorOverrides } from './doctor.ts'
import { FAILED, OK, USAGE, type Io } from './io.ts'

export const SERVE_USAGE = `usage: vinta-ai-maestro serve [--repo <dir>] [--host <host>] [--port <n>]
                              [--permission <ask|auto|full>]
                              [--on-failure <stop|retry|ask>] [--retries <n>]
                              [--retry-after <15m>]
                              [--log-level <debug|info|warn|error>] [--log-stderr]
                              [--log-detail <kind|message>]

  --repo <dir>   The project whose .vinta-ai-maestro/ store is served, and whose
                 ai-plans/*.workflow.json the editor opens.
                 Defaults to the current directory.
  --host <host>  Bind address. Defaults to 127.0.0.1 — this machine only.
                 Pass 0.0.0.0 to reach it from the local network; the printed
                 URL then names this machine's LAN address rather than the
                 wildcard, so it can be opened from another device. The daemon
                 warns, because the token in that URL is the only thing standing
                 between the run — transcripts, diffs, gate logs — and anyone
                 who can reach the port.
  --port <n>     Defaults to 0 — an OS-assigned port, printed with the URL.
  --on-failure   What a failed phase does. "retry" is the default: it tries the
                 phase again, cold, and then parks it on a question — retry,
                 retry with another member of the crew, or stop. The failures
                 this produces are mostly environmental and are gone by the
                 second attempt; the ones that are not are worth a person.
                 "ask" skips the automatic attempt and parks straight away.
                 "stop" ends the phase and blocks whatever depended on it, which
                 is the right choice for CI — everything else eventually waits,
                 and nobody is watching there.
  --retries <n>  Automatic attempts before the question, under "retry".
                 Defaults to 1, and 0 to 5 are accepted. Raising it multiplies
                 the cost of a phase that is simply broken. A re-attempt keeps
                 the previous one's commits and starts a fresh agent session —
                 "cold" is about the session, not the branch.
                 This is the *outer* budget. The inner one is each phase's own
                 max_fix_rounds (default 2), which counts review rounds rather
                 than findings: a first review raising four blockers can use it
                 up while every round makes progress. A phase that keeps
                 arriving here usually wants that raised, not this.
  --retry-after  How long an unanswered failure question waits before it
                 answers itself "retry". Unset — the default — waits for a
                 person, which is what a run did before this existed. Accepts
                 minutes bare or a unit: 15, 15m, 90s, 2h.
                 It reaches only the *failure* question, never a plan's own
                 await_human gate: a plan that stops to ask whether a migration
                 is safe wants a person, and answering that on their behalf is
                 not this flag's business.
                 Deliberately unbounded — it fires again on each new question,
                 because the thing it exists for is a run that stopped making
                 progress at 7pm and was still stopped at 11. Every firing is a
                 full phase attempt, so the interval is the throttle: a short
                 one on an expensive plan retries a broken phase all night.
                 An attempt that fails faster than the interval doubles the
                 next wait, up to 8x (15m becomes 2h); one that runs at least
                 the interval long puts it back to 15m.
  --log-level    How much the daemon records about itself, in
                 .vinta-ai-maestro/logs/daemon.ndjson and in the UI's Logs view.
                 Defaults to info: what it bound, what it refused, every node
                 transition, and anything that threw. debug adds one line per
                 HTTP request and per socket, which is what you want when the
                 question is "did the browser even reach it". The file rotates
                 at 8 MiB and five rotations are kept, so this is bounded
                 whatever you set it to.
  --log-stderr   Also print each record to stderr, one line each, for watching
                 the daemon in the terminal it is running in. The file is
                 written either way.
  --log-detail   How much of an error is recorded. Defaults to message: the
                 error's kind and its own words, plus stack frames on a crash.
                 kind drops the message and keeps the name and the frames, for
                 a checkout under a data-handling obligation stricter than this
                 store's own — a message is composed by whoever threw it, so it
                 can carry a git diagnostic or a line of a source file. That is
                 not the default because runs/ already holds every transcript
                 and gate log verbatim, in this same directory.
  --permission   How much an agent may do without being asked. Defaults to
                 auto — it works in its own lane unattended, which is what a
                 lane is for. ask makes every tool use need approval, and
                 nothing answers those in a headless run. full removes the
                 checks entirely; both CLIs recommend that only for a sandbox
                 with no network, which a lane is not.
  --no-intervene Execute the plan exactly as written, whatever it costs.
                 By default a run that is dragging wakes its monitor, which
                 reads the gate logs and may amend how the run *executes* — a
                 gate's command or timeout, a phase's fix budget or model. It
                 can never change what a phase builds, it is bounded by each
                 gate's own tuning.allowed_flags, and a run gets three such
                 amendments in its life. Pass this to turn it off entirely.
                 The operator sets this, never the workflow document.`

/** The bind and store settings `serve` and `run` share. */
export interface Bind {
  readonly repoPath: string
  readonly host?: string
  readonly port?: number
}

/** Flag values both commands accept, already parsed by `parseArgs`. */
export interface BindValues {
  readonly repo?: string | undefined
  readonly host?: string | undefined
  readonly port?: string | undefined
}

/**
 * `--retry-after`, in milliseconds. `null` is a refusal the caller reports.
 *
 * Accepts a bare number of minutes or an explicit unit — `15`, `15m`, `90s`,
 * `2h` — because the flag is written by a person choosing how long they are
 * willing to be away, and every one of those spellings is what somebody
 * reaches for. Minutes is the bare unit for the same reason: nobody sets this
 * to fifteen seconds, and reading `--retry-after 15` as a quarter of a minute
 * would be a surprise that costs an overnight run.
 */
export function toRetryAfterMs(raw: string | undefined, io: Io): number | null | undefined {
  if (raw === undefined) return undefined
  const match = /^(\d+)(s|m|h)?$/.exec(raw.trim())
  if (match === null) {
    io.err('vinta-ai-maestro: --retry-after must be a whole number of minutes, or 30s / 15m / 2h')
    return null
  }
  const value = Number(match[1])
  const unit = match[2] ?? 'm'
  const ms = value * (unit === 's' ? 1_000 : unit === 'h' ? 3_600_000 : 60_000)
  // Zero is meaningful and is *off*, not "immediately": an unattended retry
  // with no delay would spend a phase attempt the instant the question appears,
  // which is the automatic budget's job and not this one's.
  if (ms === 0) return undefined
  return ms
}

/** `null` on a bad `--port`; the message names the flag, never a file. */
export function toBind(values: BindValues, io: Io): Bind | null {
  const repoPath = resolve(values.repo ?? process.cwd())

  if (values.port === undefined) {
    return values.host === undefined ? { repoPath } : { repoPath, host: values.host }
  }

  const port = Number(values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    io.err('vinta-ai-maestro: --port must be an integer between 0 and 65535')
    return null
  }
  return values.host === undefined ? { repoPath, port } : { repoPath, host: values.host, port }
}

/**
 * The only place a token is ever written. One line, on stdout, labelled as the
 * secret it is.
 */
export function announce(daemon: Daemon, io: Io): void {
  const open = reachableUrl(daemon.url)
  io.out(`vinta-ai-maestro: daemon listening on ${daemon.url}`)
  io.out('Open this URL. It carries the access token, so treat it as a secret:')
  io.out(`  ${open}/?${TOKEN_QUERY}=${daemon.token}`)
}

/**
 * A URL another machine can actually open.
 *
 * `--host 0.0.0.0` binds every interface, and the address the server reports
 * back is the wildcard itself — so the line printed for the operator to share
 * was `http://0.0.0.0:<port>`, which resolves for nobody. The flag worked and
 * the URL did not, which is the most annoying shape a feature can have.
 *
 * The bind address is left exactly as it was; only the *printed* host changes,
 * to this machine's first non-internal IPv4. Falls back to the wildcard when
 * there is no such interface, because inventing one would be worse than
 * printing the thing the operator can at least recognise as wrong.
 */
export function reachableUrl(url: string, interfaces = networkInterfaces()): string {
  const parsed = new URL(url)
  if (parsed.hostname !== '0.0.0.0' && parsed.hostname !== '::') return url

  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        parsed.hostname = address.address
        return parsed.origin
      }
    }
  }
  return url
}

export interface ServeDeps {
  /**
   * How long the daemon stays up. Defaults to "until SIGINT or SIGTERM", which
   * is the only sensible answer for a foreground daemon and the only one a test
   * cannot wait for.
   */
  readonly wait?: (daemon: Daemon) => Promise<void>
  /**
   * Preflight overrides for the runs this daemon hosts — the same injected
   * binaries and disk estimate `RunDeps.doctor` takes, and there for the same
   * reason: a preflight that read its answers from the command line would not
   * be one, so there is no flag and tests reach it here.
   */
  readonly doctor?: DoctorOverrides
}

export async function serveCommand(
  argv: readonly string[],
  io: Io,
  deps: ServeDeps = {},
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
        'retry-after': { type: 'string' },
        'log-level': { type: 'string' },
        'log-stderr': { type: 'boolean' },
        'log-detail': { type: 'string' },
      },
      allowPositionals: true,
    })
  } catch {
    io.err(SERVE_USAGE)
    return USAGE
  }
  if (parsed.positionals.length > 0) {
    io.err(SERVE_USAGE)
    return USAGE
  }

  // `serve` has accepted `--permission` since the flag existed and never read
  // it. It matters now: the monitor is an agent, and the operator's policy is
  // what decides how it is spawned.
  const requested = parsed.values['permission']
  if (requested !== undefined && !isAgentPermission(requested)) {
    io.err(`vinta-ai-maestro: --permission must be one of ${AGENT_PERMISSIONS.join(', ')}`)
    return USAGE
  }
  const permission = requested ?? DEFAULT_PERMISSION

  // Parsed at last. Both flags have been in `SERVE_USAGE` since `run` and
  // `serve` started sharing it, and until this command could host a run they
  // were documentation for something it did not do. Validated exactly as `run`
  // validates them, because they are now the same settings reaching the same
  // scheduler.
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

  const retryAfterMs = toRetryAfterMs(parsed.values['retry-after'], io)
  if (retryAfterMs === null) return USAGE

  const rawRetries = parsed.values['retries']
  const retries = rawRetries === undefined ? undefined : Number(rawRetries)
  if (retries !== undefined && (!Number.isInteger(retries) || retries < 0 || retries > 5)) {
    io.err('vinta-ai-maestro: --retries must be a whole number from 0 to 5')
    return USAGE
  }

  const bind = toBind(parsed.values, io)
  if (bind === null) return USAGE

  // The token is minted inside `startDaemon`, so it cannot be registered as a
  // secret before the logger exists — which is why the log is built first and
  // the registration happens at the bind below, before any record naming a URL
  // could be written.
  const logging = toLogSetup(parsed.values, bind.repoPath, io)
  if (logging === null) return USAGE
  const log = logging.logger

  const journal = openJournal(bind.repoPath)
  let daemon: Daemon
  try {
    daemon = await startDaemon({
      journal,
      logger: log,
      // The daemon's own `--host` warning (§11). Routed to stderr; it names the
      // host and, by contract, never the token.
      warn: (message) => io.err(message),
      monitorFor: monitorFactory(journal, bind.repoPath, permission),
      ...(bind.host === undefined ? {} : { host: bind.host }),
      ...(bind.port === undefined ? {} : { port: bind.port }),
    })
  } catch (error) {
    log.error('serve.bind_failed', {
      host: bind.host ?? '127.0.0.1',
      port: bind.port ?? 0,
      ...errorFields(error),
    })
    reportLogFailures(logging.sink, io)
    journal.close()
    // Identifiers only: the host and port the operator asked for, no internals.
    io.err(`vinta-ai-maestro: could not bind ${bind.host ?? '127.0.0.1'}:${bind.port ?? 0}`)
    return FAILED
  }

  // From here on the token is a registered secret: a field that somehow
  // carried it is written as `<redacted>` rather than as access to the run.
  redactValue(daemon.token)

  // What turns this from a window onto the journal into a host for runs. Until
  // this line the daemon serves history and refuses `POST /api/runs`.
  const host = runStarter({
      journal,
      daemon,
      repoPath: bind.repoPath,
      permission,
      logger: log,
      warn: (message) => io.err(message),
      ...(onFailure === undefined ? {} : { onFailure }),
      ...(retries === undefined ? {} : { retries }),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      ...(deps.doctor === undefined ? {} : { doctor: deps.doctor }),
  })
  daemon.acceptRuns(host)

  /**
   * The handlers that make a crash explicable, installed once the daemon can
   * actually host runs and removed again on the way out.
   *
   * `onFatal` is the important half. A process dying on an uncaught exception
   * leaves every run it was driving marked `running` in the journal for ever —
   * the exact zombie a closed terminal used to produce, and the reason
   * `--resume` exists. The `finally` below does this for an orderly shutdown;
   * this does it for the disorderly one, synchronously, because there is no
   * second chance after it.
   */
  const uninstallCrashHandlers = installCrashHandlers({
    logger: log,
    detail: logging.detail,
    inFlight: () => host.inFlight(),
    onFatal: () => {
      for (const runId of host.inFlight()) {
        journal.append({ runId, type: 'run_ended', payload: { status: 'failed' } })
      }
    },
  })

  announce(daemon, io)
  io.out(`Daemon log: ${logging.path}`)

  try {
    await (deps.wait ?? (() => untilSignalled().signalled))(daemon)
  } finally {
    uninstallCrashHandlers()
    await daemon.close()
    // **The runs this daemon was driving are ending with it**, and each one is
    // recorded as interrupted before anything is closed. Without this they stay
    // `running` in the journal for ever — the exact zombie that made a closed
    // terminal unrecoverable — and with it they are resumable, which is the
    // whole point of hosting them here.
    //
    // `failed` rather than a status of its own: the run did not complete, and
    // its node rows say how far it got. `--resume` refuses only a `done` run.
    const interrupted = host.inFlight()
    for (const runId of interrupted) {
      journal.append({ runId, type: 'run_ended', payload: { status: 'failed' } })
      log.warn('serve.run_interrupted', { run: runId })
      io.err(`vinta-ai-maestro: run ${runId} interrupted.`)
      io.err(`vinta-ai-maestro: resume it with: vinta-ai-maestro run --resume ${runId}`)
    }
    log.info('serve.stopped', { interrupted: interrupted.length })
    reportLogFailures(logging.sink, io)
    // Closed only when nothing is still holding it. A daemon-hosted run is
    // awaited by nobody, and closing under a live scheduler turns every
    // in-flight lease release into "the database connection is not open" —
    // a crash report standing where an orderly shutdown should be.
    //
    // Shutdown deliberately does not *wait* for those runs: they last hours,
    // the agents under them die with this process anyway, and a `serve` that
    // hung until its runs finished would be a `serve` nobody can stop. So the
    // handle is left to the exiting process and the OS reclaims it — safe,
    // because SQLite commits per transaction and the rows written above are
    // already durable.
    if (interrupted.length === 0) journal.close()
  }
  return OK
}

interface StarterOptions {
  readonly journal: Journal
  readonly daemon: Daemon
  readonly repoPath: string
  readonly permission: AgentPermission
  readonly onFailure?: 'stop' | 'retry' | 'ask'
  readonly retries?: number
  readonly retryAfterMs?: number
  /** Where a preflight warning goes. A daemon-hosted run has no stdout of its own. */
  readonly warn: (message: string) => void
  readonly doctor?: DoctorOverrides
  /**
   * The daemon's log, passed down to every run this host starts.
   *
   * It is the only channel a daemon-hosted run has. `run` prints its progress
   * to a terminal; a run submitted over HTTP has no terminal, and `warn` above
   * goes to the stderr of a `serve` process nobody is watching. Without this,
   * a preflight warning or a provisioning refusal on a daemon-hosted run went
   * to a stream that scrolled past hours ago.
   */
  readonly logger?: Logger
  /** `--no-intervene`: runs this daemon hosts execute the plan exactly as given. */
  readonly intervene?: boolean
}

/**
 * `POST /api/runs`, implemented: resolve what was asked for, preflight it, and
 * compose a run on the daemon that is already listening.
 *
 * This is the half of daemon-hosted runs that could not live in `src/daemon/`.
 * Starting a run means a lane pool, a harness, a preflight and a scheduler —
 * none of which an HTTP module should know about — so the daemon declares the
 * narrow `RunStartPort` and this supplies it.
 *
 * **It resolves as soon as the run is registered.** Nothing here awaits
 * `finished`: a run takes hours and the request that submitted it must not.
 * The run tidies up after itself (see `StartedRun.finished`), which is what
 * makes it safe for nobody to be holding it.
 *
 * **What it deliberately does not do is decide.** Every refusal below is the
 * same check `run` makes, in the same order, through the same functions — a
 * daemon that was more permissive than the command line would be a second,
 * quieter way to start a run that `run` would have refused.
 */
export interface RunHost extends RunStartPort {
  /**
   * Runs this host is still driving, newest last.
   *
   * Exists for shutdown. A daemon-hosted run is not awaited by anybody, so
   * without this the process on its way out has no idea it is about to close a
   * journal three schedulers are still writing to — which surfaces as
   * "the database connection is not open" from whichever lease released last,
   * a crash report standing where an orderly interruption should be.
   */
  inFlight(): readonly string[]
}

export function runStarter(options: StarterOptions): RunHost {
  const { journal, daemon, repoPath, permission } = options
  const log = options.logger ?? nullLogger()
  // The same directory the API lists workflows from, derived the same way, so
  // an id the editor offered is an id this can start.
  const store = createWorkflowStore(plansDirFor(repoPath))
  // Insertion-ordered, and entries are removed as runs settle, so this is the
  // set of runs that would be lost if the process ended right now.
  const live = new Set<string>()

  return {
    inFlight: () => [...live],
    async start(request: RunStartRequest): Promise<RunStartOutcome> {
      let workflow: Workflow
      let runId: string

      if (request.kind === 'workflow') {
        // Checked before the read, for the reason `isWorkflowId` exists: an id
        // is turned into a path, and a path is the one thing a caller must not
        // be able to choose.
        if (!isWorkflowId(request.workflowId)) {
          return { ok: false, code: 'unknown_workflow', message: 'no such workflow' }
        }
        const read = store.read(request.workflowId)
        if (!read.ok) {
          return read.reason === 'missing'
            ? { ok: false, code: 'unknown_workflow', message: 'no such workflow' }
            : { ok: false, code: 'invalid_workflow', message: 'workflow file is not valid JSON' }
        }
        const parsed = parseWorkflow(read.value)
        if (!parsed.ok || parsed.workflow.id !== request.workflowId) {
          return { ok: false, code: 'invalid_workflow', message: 'workflow is not valid' }
        }
        workflow = parsed.workflow
        runId = `${workflow.id}-${Date.now().toString(36)}`
      } else {
        const row = journal.runs().find((candidate) => candidate.id === request.runId)
        if (row === undefined) {
          return { ok: false, code: 'unknown_run', message: 'no such run' }
        }
        if (row.status === 'done') {
          // Nothing to resume: every node settled, and a resume would write a
          // second `run_ended` over a finished history. Running the plan again
          // is a different request with a different answer.
          return { ok: false, code: 'run_finished', message: 'run already finished' }
        }
        try {
          // The *frozen* snapshot, never the file it came from: that document
          // may have been edited in the hours since, and a resume that silently
          // switched plans mid-run is the worst version of this feature.
          workflow = journal.readWorkflow(request.runId)
        } catch {
          return { ok: false, code: 'invalid_workflow', message: 'frozen workflow is unreadable' }
        }
        runId = request.runId
      }

      const preflight = await preflightRun({
        workflow,
        repoPath,
        // `runId` is `request.runId` on this branch, and the same condition
        // decides `startRun`'s `resume` below.
        ...(request.kind === 'resume' ? { resumeRunId: runId } : {}),
        ...(options.doctor === undefined ? {} : { doctor: options.doctor }),
      })
      if (!preflight.ok) {
        // A preflight refusal is the most common way a run does not happen,
        // and the message is built from identifiers — a harness id and the
        // command the *user* runs to log in (§8's "hard gate"), never a
        // credential and never repository content.
        log.warn('run.preflight_refused', { run: runId, reason: preflight.message })
        return { ok: false, code: 'environment', message: preflight.message }
      }
      for (const warning of preflight.warnings) {
        log.warn('run.preflight_warning', { run: runId, warning })
        options.warn(warning)
      }

      const started = await startRun({
        workflow,
        runId,
        journal,
        daemon,
        repoPath,
        permission,
        logger: log,
        ...(request.kind === 'resume' ? { resume: true } : {}),
        ...(options.onFailure === undefined ? {} : { onFailure: options.onFailure }),
        ...(options.retries === undefined ? {} : { retries: options.retries }),
        ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
        // Same factory the monitor endpoint is built from, so a run the daemon
        // hosts can tune itself exactly as one `run` hosts can.
        monitorFor: monitorFactory(journal, repoPath, permission),
        ...(options.intervene === false ? { intervene: false } : {}),
      })
      if (!started.ok) {
        log.error('run.provision_failed', { run: runId, reason: started.message })
        options.warn(started.message)
        return { ok: false, code: 'provision', message: started.message }
      }

      live.add(started.runId)
      // Deliberately not awaited — see the docstring. The run outlives this call.
      void started.finished
        .then(({ postMortem }) => {
          live.delete(started.runId)
          log.info('run.finished', {
            run: started.runId,
            post_mortem: postMortem === null ? 'none' : postMortem,
          })
          options.warn(
            postMortem === null
              ? `vinta-ai-maestro: run ${started.runId} ended; no post-mortem could be written.`
              : `vinta-ai-maestro: run ${started.runId} ended; post-mortem at ${postMortem}`,
          )
        })
        .catch((error: unknown) => {
          // Previously this promise had no rejection handler at all, which made
          // a throw anywhere in a run's teardown an unhandled rejection — and
          // an unhandled rejection ends the daemon, taking every *other* run
          // with it. The run is left in `live` on purpose: shutdown then
          // records it as interrupted, which is the truth, and `--resume` can
          // pick it up.
          log.error('run.settle_threw', { run: started.runId, ...errorFields(error) })
        })

      return { ok: true, runId: started.runId }
    },
  }
}

/** A signal watch that can be called off, for a caller that stopped for another reason. */
export interface SignalWatch {
  /** Resolves on the first signal. Never rejects, and never resolves after `cancel`. */
  readonly signalled: Promise<void>
  /** Unhooks the handlers. Idempotent. */
  cancel(): void
}

/**
 * Resolves on the first SIGINT, SIGTERM or **SIGHUP**.
 *
 * SIGHUP is the one that matters here and the one that was missing. It is what
 * a terminal sends to its foreground process when the window closes, and with
 * no handler for it Node's default action is to die on the spot — no `finally`,
 * no teardown, and for `run` no `run_ended`, so a run whose operator simply
 * closed their terminal stayed `running` in the journal forever with nothing
 * able to tell it apart from one still in flight.
 *
 * Cancellable because `run` races it against the run finishing, and a watch
 * left hooked keeps a listener on a process that is trying to exit.
 */
export function untilSignalled(): SignalWatch {
  let cancel = (): void => {}
  const signalled = new Promise<void>((resolve_) => {
    const stop = (): void => {
      cancel()
      resolve_()
    }
    cancel = (): void => {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      process.off('SIGHUP', stop)
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    process.once('SIGHUP', stop)
  })
  return { signalled, cancel: () => cancel() }
}

/**
 * Builds the run's spokesperson, on demand and per run.
 *
 * Per call rather than cached, because a monitor holds a conversation and two
 * operators looking at two runs are having two of them. Cheap to build: it is a
 * model name, an adapter and a directory; the session only exists once someone
 * asks something.
 *
 * It reads the frozen workflow to pick its model — the dearest tier on the
 * roster — and to name the phases, so a run whose plan cannot be read has no
 * monitor rather than a confused one.
 */
export function monitorFactory(
  journal: Journal,
  repoPath: string,
  permission: AgentPermission,
): (runId: string) => Monitor | null {
  return (runId) => {
    let workflow: Workflow
    try {
      workflow = journal.readWorkflow(runId)
    } catch {
      return null
    }
    return new Monitor({
      // It answers questions; it does not touch the repository. The lane's read
      // grant and write guard are not its concern, and it is given neither.
      adapter: new ClaudeCodeAdapter({ permission }),
      model: monitorModel(workflow),
      cwd: repoPath,
      // The conversation is written here, so it survives the tab it was had in.
      journal,
    })
  }
}
