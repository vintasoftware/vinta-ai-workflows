/**
 * A run as a background job.
 *
 * A run lasts hours, and the terminal that started it should not have to stay
 * open for them. So `run` hands the run to a detached copy of itself — the
 * *job* — and returns as soon as that copy reports the run started. The job is
 * the run's only host: it holds the scheduler, the lanes' agents, and the
 * loopback API those agents call back into (`with`, `gate`, the judged hook).
 *
 * Everything else that wants the run finds the job through one file,
 * `runs/<id>/job.json`: its pid, the URL it listens on and the token it
 * expects. `status`, `pause`, `stop`, `logs` and `ui` all read it; only the job
 * writes it.
 *
 * **That file is a secret.** The token in it is the access to the run — the
 * same access §11 keeps out of every log line — so it is written `0600`,
 * atomically, inside the gitignored store, and removed when the job ends. It is
 * never printed.
 *
 * **Liveness is the pid, checked.** A job killed with `-9`, or a machine that
 * rebooted, leaves the file behind. A record whose process is gone is treated
 * as no job at all, which is exactly how the journal's own `running` row is
 * read when nothing is hosting it: interrupted, and resumable.
 */
import { spawn as spawnChild, type ChildProcess } from 'node:child_process'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { runsRootFor } from '../cli/paths.ts'

/** `.vinta-ai-maestro/runs/<id>/job.json`. */
export const jobPathFor = (repoPath: string, runId: string): string =>
  join(runsRootFor(repoPath), runId, 'job.json')

/**
 * `.vinta-ai-maestro/runs/<id>/job.log` — the job's stdout and stderr, which
 * is everything `run` used to print to the terminal plus the daemon's records
 * rendered one per line. Appended across resumes, so one file tells the whole
 * run. Inside `runs/`, so `purge` removes it with the run.
 */
export const jobLogPathFor = (repoPath: string, runId: string): string =>
  join(runsRootFor(repoPath), runId, 'job.log')

const JobRecordSchema = z.object({
  runId: z.string(),
  pid: z.number().int().positive(),
  url: z.string(),
  token: z.string(),
  /** `starting` while lanes are provisioned; `running` once the scheduler is. */
  state: z.enum(['starting', 'running']),
  startedAt: z.number(),
})

export type JobRecord = z.infer<typeof JobRecordSchema>

/** Writes the record atomically, readable by this user only. */
export function writeJob(repoPath: string, record: JobRecord): void {
  const path = jobPathFor(repoPath, record.runId)
  mkdirSync(join(runsRootFor(repoPath), record.runId), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  renameSync(temp, path)
}

/** The record as written, or `null` when there is none or it does not parse. */
export function readJob(repoPath: string, runId: string): JobRecord | null {
  let text: string
  try {
    text = readFileSync(jobPathFor(repoPath, runId), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JobRecordSchema.safeParse(JSON.parse(text))
    return parsed.success && parsed.data.runId === runId ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * Removes the record — but only the one `pid` wrote. A job that is slow to die
 * must not delete the file a resume of the same run has already replaced.
 */
export function removeJob(repoPath: string, runId: string, pid: number): void {
  if (readJob(repoPath, runId)?.pid !== pid) return
  rmSync(jobPathFor(repoPath, runId), { force: true })
}

/** Whether `pid` is a process that exists. `EPERM` is somebody else's, but alive. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The run's job, when its process is still there. */
export function liveJob(
  repoPath: string,
  runId: string,
  alive: (pid: number) => boolean = isAlive,
): JobRecord | null {
  const record = readJob(repoPath, runId)
  return record !== null && alive(record.pid) ? record : null
}

/** Spawns the detached job. Injected in tests; the default re-executes this CLI. */
export type JobSpawner = (args: readonly string[], logPath: string, cwd: string) => ChildProcess

/**
 * A spawner that runs `entry` under `node` with `execArgv` — by default the
 * same entry point and the same Node flags this process was started with, so a
 * job launched from `dist/cli/bin.js` runs `dist/cli/bin.js` and one launched
 * from `bin.ts` keeps `--experimental-transform-types`.
 *
 * Detached, so it leads its own session and no terminal's hangup reaches it;
 * stdio goes to the job log, never to this process's pipes, so this process can
 * exit without the job losing its stdout.
 */
export function cliSpawner(
  entry: string = process.argv[1] as string,
  execArgv: readonly string[] = process.execArgv,
): JobSpawner {
  return (args, logPath, cwd) => {
    const fd = openSync(logPath, 'a', 0o600)
    try {
      const child = spawnChild(process.execPath, [...execArgv, entry, ...args], {
        cwd,
        detached: true,
        stdio: ['ignore', fd, fd],
        windowsHide: true,
        env: process.env,
      })
      child.unref()
      return child
    } finally {
      // The child has its own copy of the descriptor by now.
      closeSync(fd)
    }
  }
}

export type LaunchResult =
  | { readonly ok: true; readonly record: JobRecord }
  | {
      readonly ok: false
      /** What the job printed before it exited — the refusal, in its own words. */
      readonly output: string
    }

export interface LaunchOptions {
  readonly repoPath: string
  readonly runId: string
  /** `run`'s own arguments for the job, `--foreground` and `--run-id` included. */
  readonly args: readonly string[]
  readonly spawn?: JobSpawner
  /** Defaults to 100 ms. */
  readonly pollMs?: number
}

/**
 * Starts the job and waits until it says the run is under way — or until it
 * exits, which means it refused.
 *
 * No timeout, deliberately. Between the spawn and "running" sit the project's
 * own `prepare_cmd` (often a `docker compose up`), the preflight, and the lane
 * pool; any of them can take minutes, and a launcher that gave up first would
 * report a failure for a run that then started without anyone watching.
 */
export async function launchJob(options: LaunchOptions): Promise<LaunchResult> {
  const { repoPath, runId } = options
  const logPath = jobLogPathFor(repoPath, runId)
  mkdirSync(join(runsRootFor(repoPath), runId), { recursive: true })
  // Only what this attempt writes is this attempt's refusal: a resumed run's
  // log already holds every attempt before it.
  const offset = sizeOf(logPath)

  const child = (options.spawn ?? cliSpawner())(options.args, logPath, repoPath)
  let exited = false
  child.once('exit', () => {
    exited = true
  })
  child.once('error', () => {
    exited = true
  })

  const pollMs = options.pollMs ?? 100
  for (;;) {
    const record = readJob(repoPath, runId)
    if (record !== null && record.pid === child.pid && record.state === 'running') {
      return { ok: true, record }
    }
    if (exited) return { ok: false, output: readFrom(logPath, offset) }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function readFrom(path: string, offset: number): string {
  try {
    return readFileSync(path).subarray(offset).toString('utf8')
  } catch {
    return ''
  }
}
