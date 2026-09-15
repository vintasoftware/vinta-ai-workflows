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

import { TOKEN_QUERY, startDaemon, type Daemon } from '../daemon/index.ts'
import type { Journal } from '../journal/journal.ts'
import { openJournal } from '../journal/journal.ts'
import { ClaudeCodeAdapter } from '../harness/claude-code.ts'
import {
  AGENT_PERMISSIONS,
  DEFAULT_PERMISSION,
  isAgentPermission,
  type AgentPermission,
} from '../harness/permissions.ts'
import { Monitor, monitorModel } from '../monitor/monitor.ts'
import type { Workflow } from '../types.ts'
import { FAILED, OK, USAGE, type Io } from './io.ts'

export const SERVE_USAGE = `usage: vinta-ai-maestro serve [--repo <dir>] [--host <host>] [--port <n>]
                              [--permission <ask|auto|full>]
                              [--on-failure <stop|retry|ask>] [--retries <n>]

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
  --permission   How much an agent may do without being asked. Defaults to
                 auto — it works in its own lane unattended, which is what a
                 lane is for. ask makes every tool use need approval, and
                 nothing answers those in a headless run. full removes the
                 checks entirely; both CLIs recommend that only for a sandbox
                 with no network, which a lane is not.
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

  const bind = toBind(parsed.values, io)
  if (bind === null) return USAGE

  const journal = openJournal(bind.repoPath)
  let daemon: Daemon
  try {
    daemon = await startDaemon({
      journal,
      // The daemon's own `--host` warning (§11). Routed to stderr; it names the
      // host and, by contract, never the token.
      warn: (message) => io.err(message),
      monitorFor: monitorFactory(journal, bind.repoPath, permission),
      ...(bind.host === undefined ? {} : { host: bind.host }),
      ...(bind.port === undefined ? {} : { port: bind.port }),
    })
  } catch {
    journal.close()
    // Identifiers only: the host and port the operator asked for, no internals.
    io.err(`vinta-ai-maestro: could not bind ${bind.host ?? '127.0.0.1'}:${bind.port ?? 0}`)
    return FAILED
  }

  announce(daemon, io)

  try {
    await (deps.wait ?? untilInterrupted)(daemon)
  } finally {
    await daemon.close()
    journal.close()
  }
  return OK
}

/** Resolves on the first SIGINT or SIGTERM, and unhooks itself either way. */
function untilInterrupted(): Promise<void> {
  return new Promise<void>((resolve_) => {
    const stop = (): void => {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      resolve_()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
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
function monitorFactory(
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
