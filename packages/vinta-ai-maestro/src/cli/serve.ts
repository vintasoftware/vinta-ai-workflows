/**
 * `vinta-ai-maestro ui` — serve the browser UI and hand the operator its URL.
 * `serve` is the same command under its older name.
 *
 * **It hosts no runs.** Every run is a background job of its own (`run`,
 * `job/job.ts`), so this process can be started after a run, closed in the
 * middle of one, and opened again tomorrow without the run noticing. What it
 * serves is the journal — every run on disk, finished or not — and, for a run
 * whose job is alive, a forwarding of that run's traffic to the job
 * (`daemon/proxy.ts`), so the live graph, steering and PTY takeover work
 * exactly as they did when the UI and the run shared a process. A run started
 * from the browser is launched as a job like any other.
 *
 * That URL is the whole point of the command. There is no login, no account
 * and no session (§11): the token minted at boot *is* the access to the UI,
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
 *   of the URL. The jobs it forwards to stay on loopback whatever this binds.
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
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import {
  TOKEN_QUERY,
  WORKFLOW_SUFFIX,
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
import { launchJob, liveJob, type LaunchResult } from '../job/job.ts'
import { errorFields, installCrashHandlers, nullLogger, redactValue, type Logger } from '../log/index.ts'
import { reportLogFailures, toLogSetup, type LogValues } from './logging.ts'
import { ClaudeCodeAdapter } from '../harness/claude-code.ts'
import type { AgentPermission } from '../harness/permissions.ts'
import { Monitor, monitorModel } from '../monitor/monitor.ts'
import type { Workflow } from '../types.ts'
import { parseWorkflow } from '../validate.ts'
import { FAILED, OK, USAGE, type Io } from './io.ts'
import { jobArgs, resumeRefusal, toRunPolicy, type JobTarget, type RunPolicy } from './policy.ts'

export const SERVE_USAGE = `usage: vinta-ai-maestro ui [--repo <dir>] [--host <host>] [--port <n>]
                           [--permission <ask|auto|full|judged>]
                           [--system-one <config.json>]
                           [--on-failure <stop|retry|ask>] [--retries <n>]
                           [--retry-after <15m>] [--no-intervene]
                           [--log-level <debug|info|warn|error>] [--log-stderr]
                           [--log-detail <kind|message>]
       vinta-ai-maestro serve …   (the same command)

  Serves the browser UI for every run in this project and prints the URL to
  open. Runs are not hosted here — each one is a background job of its own —
  so closing this, or never opening it, does not touch them. A run started or
  resumed from the UI is launched as such a job, with the run settings below.

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
                 max_fix_rounds (default 4), which counts fix rounds rather
                 than findings: a first review raising four blockers spends one.
                 When it runs out the phase asks whether to continue, and only
                 "stop" brings it here.
  --retry-after  How long an unanswered failure question waits before it
                 answers itself "retry". Unset — the default — waits for a
                 person, which is what a run did before this existed. Accepts
                 minutes bare or a unit: 15, 15m, 90s, 2h.
                 Beyond the failure question it reaches only a plan question
                 that names its own unattended answer — the shipped pipeline's
                 scope questions take each item's default, and its exhausted
                 budget takes "stop". A plan question that names none, like
                 whether a migration is safe, always waits for a person.
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
                 with no network, which a lane is not. judged is full with a
                 System One classifier asked about every shell command before
                 it runs, and anything it cannot clear denied — faster than
                 auto's vendor checks, and not a sandbox. It needs
                 --system-one with a permission judge, and claude-code.
  --system-one   The operator's System One classifier: which adapter, how to
                 reach it, the environment variable holding its key, and which
                 built-in judges consult it (gate triage, the permission
                 judge). A JSON file on this machine, never part of the plan.
                 Without it a plan's judge gates answer as unavailable. With it,
                 diffs, gate logs and commands are sent to that classifier —
                 point it at a local one where that must not happen.
  --no-intervene Execute the plan exactly as written, whatever it costs.
                 By default a run that is dragging wakes its monitor, which
                 reads the gate logs and may amend how the run *executes* — a
                 gate's command or timeout, a phase's fix budget or model. It
                 can never change what a phase builds, it is bounded by each
                 gate's own tuning.allowed_flags, and a run gets three such
                 amendments in its life. Pass this to turn it off entirely.
                 The operator sets this, never the workflow document.`

/** One name for one command; `ui` is the one the help leads with. */
export const UI_USAGE = SERVE_USAGE

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
   * How long the daemon stays up. Defaults to "until SIGINT, SIGTERM or
   * SIGHUP", which is the only sensible answer for a foreground server and the
   * only one a test cannot wait for.
   */
  readonly wait?: (daemon: Daemon) => Promise<void>
  /**
   * How a run started from the UI is launched. Defaults to `launchJob`, which
   * spawns a detached `run --foreground`; a test hosts the job in-process.
   */
  readonly launch?: (args: readonly string[], runId: string) => Promise<LaunchResult>
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
        'system-one': { type: 'string' },
        'on-failure': { type: 'string' },
        retries: { type: 'string' },
        'retry-after': { type: 'string' },
        'no-intervene': { type: 'boolean' },
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

  // The settings for runs started from the browser, validated exactly as `run`
  // validates them — they are the same settings reaching the same scheduler,
  // one process further away. `--permission` also decides how the monitor is
  // spawned for a run that has no job any more.
  const policy = toRunPolicy(parsed.values, io)
  if (policy === null) return USAGE

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
      monitorFor: monitorFactory(journal, bind.repoPath, policy.permission),
      // A live run's traffic goes to its job. Read per request, so a run
      // started — or ended — after this process came up is routed correctly
      // without anyone telling it.
      upstream: (runId) => {
        const job = liveJob(bind.repoPath, runId)
        return job === null ? null : { url: job.url, token: job.token }
      },
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
  // carried it is written as `<redacted>` rather than as access to the UI.
  redactValue(daemon.token)

  daemon.acceptRuns(
    jobStarter({
      journal,
      repoPath: bind.repoPath,
      policy,
      log: parsed.values,
      logger: log,
      ...(deps.launch === undefined ? {} : { launch: deps.launch }),
    }),
  )

  // Nothing in flight here is lost if this process dies — the runs are in
  // their own jobs — so there is nothing for a fatal handler to record but the
  // crash itself.
  const uninstallCrashHandlers = installCrashHandlers({
    logger: log,
    detail: logging.detail,
    inFlight: () => [],
    onFatal: () => {},
  })

  announce(daemon, io)
  io.out(`Daemon log: ${logging.path}`)

  try {
    await (deps.wait ?? (() => untilSignalled().signalled))(daemon)
  } finally {
    uninstallCrashHandlers()
    await daemon.close()
    log.info('serve.stopped')
    reportLogFailures(logging.sink, io)
    journal.close()
  }
  return OK
}

interface StarterOptions {
  readonly journal: Journal
  readonly repoPath: string
  /** The settings every job this starts is launched with. */
  readonly policy: RunPolicy
  readonly log: LogValues
  /** `ui`'s own log: a start that never happened leaves no run to read. */
  readonly logger?: Logger
  readonly launch?: (args: readonly string[], runId: string) => Promise<LaunchResult>
}

/**
 * `POST /api/runs`, implemented: resolve what was asked for, then launch it as
 * a background job and answer once the job says the run is under way.
 *
 * **The checks are `run`'s, in `run`'s order, through `run`'s functions** —
 * `resumeRefusal`, `jobArgs` — and the preflight is the job's, exactly as it
 * is for `run`. A daemon that was more permissive than the command line would
 * be a second, quieter way to start a run that `run` would have refused.
 *
 * A job that refuses — a failed preflight, a lane pool that would not
 * provision — answers `environment`, and the reason is in the run's job log,
 * which is where the message points. Its text is not relayed: it is the
 * job's console, and the API's refusals are identifiers.
 */
export function jobStarter(options: StarterOptions): RunStartPort {
  const { journal, repoPath, policy } = options
  const log = options.logger ?? nullLogger()
  const plansDir = plansDirFor(repoPath)
  // The same directory the API lists workflows from, derived the same way, so
  // an id the editor offered is an id this can start.
  const store = createWorkflowStore(plansDir)
  const launch =
    options.launch ??
    ((args: readonly string[], runId: string) => launchJob({ repoPath, runId, args }))

  return {
    async start(request: RunStartRequest): Promise<RunStartOutcome> {
      let target: JobTarget

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
        const workflow: Workflow = parsed.workflow
        target = {
          kind: 'workflow',
          path: join(plansDir, `${workflow.id}${WORKFLOW_SUFFIX}`),
          runId: `${workflow.id}-${Date.now().toString(36)}`,
        }
      } else {
        const refusal = resumeRefusal(journal, repoPath, request.runId)
        if (refusal !== null) return { ok: false, code: refusal.code, message: refusal.message }
        target = { kind: 'resume', runId: request.runId }
      }

      const launched = await launch(jobArgs(target, { repoPath }, policy, options.log), target.runId)
      if (!launched.ok) {
        log.warn('run.job_refused', { run: target.runId, kind: request.kind })
        return {
          ok: false,
          code: 'environment',
          message: `run did not start; see: vinta-ai-maestro logs ${target.runId}`,
        }
      }
      log.info('run.job_started', { run: target.runId, pid: launched.record.pid })
      return { ok: true, runId: target.runId }
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
      // `judged` needs a hook only a run's lanes are given (§17.6); the monitor
      // never writes, so it runs at `auto` rather than refusing to start.
      adapter: new ClaudeCodeAdapter({ permission: permission === 'judged' ? 'auto' : permission }),
      model: monitorModel(workflow),
      cwd: repoPath,
      // The conversation is written here, so it survives the tab it was had in.
      journal,
    })
  }
}
