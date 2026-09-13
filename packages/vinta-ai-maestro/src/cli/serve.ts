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
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { TOKEN_QUERY, startDaemon, type Daemon } from '../daemon/index.ts'
import { openJournal } from '../journal/journal.ts'
import { FAILED, OK, USAGE, type Io } from './io.ts'

export const SERVE_USAGE = `usage: vinta-ai-maestro serve [--repo <dir>] [--host <host>] [--port <n>]
                              [--permission <ask|auto|full>]
                              [--on-failure <stop|ask>]

  --repo <dir>   The project whose .vinta-ai-maestro/ store is served, and whose
                 ai-plans/*.workflow.json the editor opens.
                 Defaults to the current directory.
  --host <host>  Bind address. Defaults to 127.0.0.1. Any other value makes the
                 daemon reachable from other machines and prints a warning.
  --port <n>     Defaults to 0 — an OS-assigned port, printed with the URL.
  --on-failure   What a failed phase does. "stop" (default) ends it and blocks
                 whatever depended on it, as runs have always done. "ask" parks
                 it on a question instead — retry, retry with another member of
                 the crew, or stop — so an environmental failure can be fixed
                 and the phase tried again without re-running the whole plan.
                 Only pass "ask" when somebody is watching: the run waits.
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
  io.out(`vinta-ai-maestro: daemon listening on ${daemon.url}`)
  io.out('Open this URL. It carries the access token, so treat it as a secret:')
  io.out(`  ${daemon.url}/?${TOKEN_QUERY}=${daemon.token}`)
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
