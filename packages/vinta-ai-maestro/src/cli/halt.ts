/**
 * `vinta-ai-maestro pause <runId>` and `vinta-ai-maestro stop <runId>`.
 *
 * Both end a run before its DAG does, and both reach it the same way: through
 * the run's own job, found by its `job.json` and asked over the API its agents
 * already use. Not by signal — a signal means "interrupted" to the job, and on
 * Windows there is no signal to send that the job could catch at all.
 *
 * - **pause** drains. No new phase starts, each running phase finishes the step
 *   it is in, and the job exits with the run `paused` and every lane in place.
 *   `run --resume` picks it up.
 * - **stop** kills: every live agent turn and every running gate ends now, and
 *   the run is `cancelled`, which `--resume` refuses.
 *
 * Both return as soon as the job has the request; `--wait` stays until it has
 * exited. A pause can take as long as the longest step in flight.
 *
 * **When there is no job to ask.** A run whose job died is already as
 * resumable as a pause would make it, so `pause` says so and changes nothing.
 * `stop` still has something to do — make the run final — and does it
 * directly in the journal. A job that is alive and not answering is the one
 * case `stop` ends by force: its process tree is signalled, and the
 * cancellation is written once it is gone.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { isAlive, liveJob, type JobRecord } from '../job/job.ts'
import { openJournal, type Journal } from '../journal/journal.ts'
import { killTree } from '../platform/platform.ts'
import { FAILED, OK, USAGE, type Io } from './io.ts'
import { storeFor } from './paths.ts'
import { isResumable, runState } from './status.ts'

export const PAUSE_USAGE = `usage: vinta-ai-maestro pause <runId> [--repo <dir>] [--wait]

  Pauses a running run. Nothing new starts; each running phase finishes the
  step it is in — the agent turn or gate under way — and then the run's job
  exits, leaving every lane as it was. Resume it with
  \`vinta-ai-maestro run --resume <runId>\`.

  --repo <dir>   The project. Defaults to the current directory.
  --wait         Return once the job has exited, not once it has the request.`

export const STOP_USAGE = `usage: vinta-ai-maestro stop <runId> [--repo <dir>] [--wait]

  Stops a run for good. Every live agent turn and every running gate is
  killed, and the run ends "cancelled": it cannot be resumed. Lanes and
  branches are left in place, as for any finished run. A paused or
  interrupted run can be stopped too, which makes it final.

  --repo <dir>   The project. Defaults to the current directory.
  --wait         Return once the job has exited, not once it has the request.`

export interface HaltDeps {
  readonly fetch?: typeof fetch
  readonly alive?: (pid: number) => boolean
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void
  readonly sleep?: (ms: number) => Promise<void>
}

type Mode = 'pause' | 'stop'

export const pauseCommand = (argv: readonly string[], io: Io, deps: HaltDeps = {}) =>
  haltCommand('pause', argv, io, deps)

export const stopCommand = (argv: readonly string[], io: Io, deps: HaltDeps = {}) =>
  haltCommand('stop', argv, io, deps)

async function haltCommand(
  mode: Mode,
  argv: readonly string[],
  io: Io,
  deps: HaltDeps,
): Promise<number> {
  const usage = mode === 'pause' ? PAUSE_USAGE : STOP_USAGE
  let parsed
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { repo: { type: 'string' }, wait: { type: 'boolean' } },
      allowPositionals: true,
    })
  } catch {
    io.err(usage)
    return USAGE
  }
  const runId = parsed.positionals[0]
  if (runId === undefined || parsed.positionals.length > 1) {
    io.err(usage)
    return USAGE
  }
  const repoPath = resolve(parsed.values.repo ?? process.cwd())
  if (!existsSync(storeFor(repoPath))) {
    io.err(`vinta-ai-maestro: no run "${runId}" in ${repoPath}`)
    return FAILED
  }

  const alive = deps.alive ?? isAlive
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  const journal = openJournal(repoPath)
  try {
    const row = journal.run(runId)
    if (row === undefined) {
      io.err(`vinta-ai-maestro: no run "${runId}" in ${repoPath}`)
      return FAILED
    }
    const job = liveJob(repoPath, runId, alive)
    const state = runState(row, job)

    if (job === null) return haltUnhosted(mode, journal, runId, state, io)

    const asked = await ask(job, mode, deps.fetch ?? fetch)
    if (asked === 'unreachable') {
      if (mode === 'pause') {
        io.err(
          `vinta-ai-maestro: run ${runId}'s job (pid ${job.pid}) is not answering. ` +
            `\`vinta-ai-maestro stop ${runId}\` ends it regardless.`,
        )
        return FAILED
      }
      return await forceStop(journal, runId, job, io, { alive, sleep, kill: deps.kill ?? signalTree })
    }
    if (asked === 'refused') {
      io.err(`vinta-ai-maestro: run ${runId} is ${state}; there is nothing to ${mode}.`)
      return FAILED
    }

    io.out(
      mode === 'pause'
        ? `vinta-ai-maestro: pausing run ${runId}. Running phases finish their current step, then the job exits.`
        : `vinta-ai-maestro: stopping run ${runId}.`,
    )
    if (parsed.values.wait !== true) {
      io.out(`vinta-ai-maestro: follow it with: vinta-ai-maestro logs ${runId} --follow`)
      return OK
    }
    while (alive(job.pid)) await sleep(250)
    const ended = journal.run(runId)?.status ?? 'unknown'
    io.out(`vinta-ai-maestro: run ${runId} is ${ended}.`)
    return OK
  } finally {
    journal.close()
  }
}

/** The run's own API, asked. `refused` is a 409: the run is not running. */
async function ask(
  job: JobRecord,
  mode: Mode,
  fetchImpl: typeof fetch,
): Promise<'accepted' | 'refused' | 'unreachable'> {
  try {
    const response = await fetchImpl(
      `${job.url}/api/runs/${encodeURIComponent(job.runId)}/${mode}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${job.token}`, 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (response.ok) return 'accepted'
    return response.status === 409 ? 'refused' : 'unreachable'
  } catch {
    return 'unreachable'
  }
}

function haltUnhosted(
  mode: Mode,
  journal: Journal,
  runId: string,
  state: ReturnType<typeof runState>,
  io: Io,
): number {
  if (state === 'done' || state === 'cancelled') {
    io.err(`vinta-ai-maestro: run ${runId} already ended (${state}).`)
    return FAILED
  }
  if (mode === 'pause') {
    // Nothing is running it, so there is nothing to drain — and it is already
    // exactly as resumable as a pause would leave it.
    io.err(`vinta-ai-maestro: run ${runId} is ${state} — nothing is running it, so there is nothing to pause.`)
    if (isResumable(state)) io.err(`vinta-ai-maestro: resume it with: vinta-ai-maestro run --resume ${runId}`)
    return FAILED
  }
  journal.append({ runId, type: 'run_ended', payload: { status: 'cancelled' } })
  io.out(`vinta-ai-maestro: run ${runId} cancelled (it was ${state}). It can no longer be resumed.`)
  return OK
}

/**
 * A job that is alive and will not answer: ended from outside. SIGTERM first —
 * the job's own handler records the run as interrupted — then SIGKILL if it
 * will not go, and the cancellation written over whatever it managed to say.
 */
async function forceStop(
  journal: Journal,
  runId: string,
  job: JobRecord,
  io: Io,
  deps: {
    readonly alive: (pid: number) => boolean
    readonly sleep: (ms: number) => Promise<void>
    readonly kill: (pid: number, signal: NodeJS.Signals) => void
  },
): Promise<number> {
  io.err(`vinta-ai-maestro: run ${runId}'s job (pid ${job.pid}) is not answering; ending it.`)
  deps.kill(job.pid, 'SIGTERM')
  for (let waited = 0; waited < 10_000 && deps.alive(job.pid); waited += 250) await deps.sleep(250)
  if (deps.alive(job.pid)) deps.kill(job.pid, 'SIGKILL')
  journal.append({ runId, type: 'run_ended', payload: { status: 'cancelled' } })
  io.out(`vinta-ai-maestro: run ${runId} cancelled.`)
  // Agents and gates lead process groups of their own, which a job killed from
  // outside never got the chance to end.
  io.err('vinta-ai-maestro: agent or gate processes it started may still be running.')
  return OK
}

/** The job leads its own session (it was spawned detached), so its group is its tree. */
function signalTree(pid: number, signal: NodeJS.Signals): void {
  if (!killTree(pid, signal)) {
    try {
      process.kill(pid, signal)
    } catch {
      // Already gone.
    }
  }
}
