/**
 * Runs one database command line — `createdb`, `dropdb`, or whatever the
 * project's `createdb_cmd` / `dropdb_cmd` redirected them to — so that a
 * password prompt becomes an error instead of an indefinite wait.
 *
 * The run host is a detached daemon: nothing can answer a prompt, so a child
 * that waits for one would hold the run at `starting` forever. Two things make
 * that impossible here. Stdin is closed, and the child gets its own process
 * group (a session on POSIX), so a client that opens `/dev/tty` to ask finds no
 * terminal to ask on. And a timeout ends the whole process tree — not just the
 * shell, whose orphaned `dropdb` would keep the output pipes open and the
 * promise pending.
 */
import { spawn } from 'node:child_process'

import { killTree, ownProcessGroup, shellInvocation, spawnOptionsFor } from '../platform/platform.ts'

/** Long enough for a template clone of a large database, short enough to notice. */
export const DB_COMMAND_TIMEOUT_MS = 120_000

/** How much of the child's stderr an error carries. */
const STDERR_LIMIT = 500

/** A database command that failed, was killed by the timeout, or could not start. */
export class DatabaseCommandError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number | null,
    readonly timedOut: boolean,
    readonly detail: string,
  ) {
    const how = timedOut
      ? 'timed out — it is most likely waiting for a password nobody can type'
      : exitCode === null
        ? 'was killed'
        : `exited ${exitCode}`
    super(
      `the database command ${how}: ${command}` +
        (detail === '' ? '' : `\n${detail}`) +
        (timedOut || /password/i.test(detail)
          ? '\nNo password reached it. Set PGPASSWORD or ~/.pgpass, or point `createdb_cmd` / ' +
            '`dropdb_cmd` at a command that needs none, e.g. `docker compose exec -T db createdb`.'
          : ''),
    )
    this.name = 'DatabaseCommandError'
  }
}

export interface DbCommandOptions {
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}

/** The tail of a stream, bounded: a stack trace puts the cause last. */
const tail = (text: string): string => {
  const trimmed = text.trimEnd()
  return trimmed.length <= STDERR_LIMIT ? trimmed : `…${trimmed.slice(-STDERR_LIMIT)}`
}

export async function runDatabaseCommand(
  command: string,
  options: DbCommandOptions,
): Promise<void> {
  const shell = shellInvocation(command)
  const child = spawn(shell.file, [...shell.args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: ownProcessGroup(),
    ...spawnOptionsFor(shell),
  })
  let stderr = ''
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    // Only the tail is ever reported, so never hold more than a bit past it.
    stderr = (stderr + chunk).slice(-STDERR_LIMIT * 4)
  })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    if (child.pid !== undefined && !killTree(child.pid, 'SIGKILL')) child.kill('SIGKILL')
  }, options.timeoutMs ?? DB_COMMAND_TIMEOUT_MS)

  try {
    const outcome = await new Promise<{ code: number | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => resolve({ code }))
    })
    if (outcome.code === 0 && !timedOut) return
    throw new DatabaseCommandError(command, outcome.code, timedOut, tail(stderr))
  } catch (error) {
    if (error instanceof DatabaseCommandError) throw error
    throw new DatabaseCommandError(command, null, false, (error as Error).message)
  } finally {
    clearTimeout(timer)
  }
}
