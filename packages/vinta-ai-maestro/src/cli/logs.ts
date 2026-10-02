/**
 * `vinta-ai-maestro logs <runId>` — what a run's job has said.
 *
 * The job's console, from `runs/<id>/job.log`: everything `run` used to print
 * to the terminal it no longer holds — the preflight report, warnings, the
 * start and end lines — and the daemon's own records for that process, one per
 * line. Every attempt at the run appends to the same file, so a resumed run
 * reads as one history.
 *
 * `--follow` tails it until the job exits, which is how a pause or a stop is
 * watched to its end. It is a poll of the file's size, because a follow that
 * depended on a filesystem watcher would behave differently on every platform
 * this package runs on, and a quarter-second is fast enough for a human.
 *
 * The file is read and printed as the job wrote it, and nothing here adds to
 * it. What is in it is what §11 allows on a stream — identifiers and the
 * operator's own command lines — and it sits under `runs/`, so `purge` takes
 * it with the run.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { isAlive, jobLogPathFor, readJob } from '../job/job.ts'
import { FAILED, OK, USAGE, type Io } from './io.ts'

export const LOGS_USAGE = `usage: vinta-ai-maestro logs <runId> [--repo <dir>] [--follow] [--lines <n>]

  Prints the run's job log: what the run would have printed to a terminal,
  and its daemon's records, one per line. Every attempt — the original and
  each resume — is in the same file.

  --repo <dir>     The project. Defaults to the current directory.
  -f, --follow     Keep printing as the job writes, until it exits.
  -n, --lines <n>  Only the last n lines. Defaults to all of them.`

export interface LogsDeps {
  readonly alive?: (pid: number) => boolean
  readonly sleep?: (ms: number) => Promise<void>
}

export async function logsCommand(
  argv: readonly string[],
  io: Io,
  deps: LogsDeps = {},
): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        repo: { type: 'string' },
        follow: { type: 'boolean', short: 'f' },
        lines: { type: 'string', short: 'n' },
      },
      allowPositionals: true,
    })
  } catch {
    io.err(LOGS_USAGE)
    return USAGE
  }
  const runId = parsed.positionals[0]
  if (runId === undefined || parsed.positionals.length > 1) {
    io.err(LOGS_USAGE)
    return USAGE
  }
  const rawLines = parsed.values.lines
  const lines = rawLines === undefined ? undefined : Number(rawLines)
  if (lines !== undefined && (!Number.isInteger(lines) || lines < 0)) {
    io.err('vinta-ai-maestro: --lines must be a whole number')
    return USAGE
  }

  const repoPath = resolve(parsed.values.repo ?? process.cwd())
  const path = jobLogPathFor(repoPath, runId)
  if (!existsSync(path)) {
    io.err(`vinta-ai-maestro: run "${runId}" has no job log in ${repoPath}.`)
    return FAILED
  }

  let offset = 0
  const initial = readFrom(path, 0)
  offset = initial.length
  let text = initial.toString('utf8')
  if (lines !== undefined) {
    const all = text.split('\n')
    if (all.at(-1) === '') all.pop()
    text = all.slice(Math.max(0, all.length - lines)).join('\n')
  }
  // A partial last line waits for the rest of itself before it is printed.
  let pending = ''
  const emit = (chunk: string): void => {
    const parts = (pending + chunk).split('\n')
    pending = parts.pop() ?? ''
    for (const line of parts) io.out(line)
  }
  emit(lines === undefined || text === '' ? text : `${text}\n`)

  if (parsed.values.follow !== true) {
    if (pending !== '') io.out(pending)
    return OK
  }

  const alive = deps.alive ?? isAlive
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  for (;;) {
    const job = readJob(repoPath, runId)
    const chunk = readFrom(path, offset)
    offset += chunk.length
    if (chunk.length > 0) emit(chunk.toString('utf8'))
    // Read once more after the job is gone, so its last words are not lost to
    // the race between its final write and its exit.
    if (job === null || !alive(job.pid)) {
      const last = readFrom(path, offset)
      if (last.length > 0) emit(last.toString('utf8'))
      if (pending !== '') io.out(pending)
      return OK
    }
    await sleep(250)
  }
}

function readFrom(path: string, offset: number): Buffer {
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return Buffer.alloc(0)
  }
  if (size <= offset) return Buffer.alloc(0)
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(size - offset)
    const read = readSync(fd, buffer, 0, buffer.length, offset)
    return buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}
