/**
 * `vinta-ai-maestro status [runId]` — what the runs in this project are doing.
 *
 * Read-only, and read from disk alone: the journal for what each run has done,
 * and `job.json` for whether anything is still hosting it. No running process
 * is asked anything, so this works the same whether a run is live, paused,
 * finished or orphaned by a crash — and it never changes any of them.
 *
 * **One status the journal cannot give.** A row that says `running` with no
 * live job behind it is a run whose host died — a reboot, a `kill -9`. The
 * journal is right that it never ended and wrong that it is running, so it is
 * shown as `interrupted`, with the command that picks it up.
 *
 * Identifiers only, as everywhere else on a stream (§11): run and node ids,
 * statuses, counts and times. Questions are counted, not quoted — their text
 * is the plan's prose about the repository, and the UI is where it is read.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { jobLogPathFor, liveJob, type JobRecord } from '../job/job.ts'
import { openJournal, type Journal, type RunRow } from '../journal/journal.ts'
import { FAILED, OK, USAGE, type Io } from './io.ts'
import { storeFor } from './paths.ts'

export const STATUS_USAGE = `usage: vinta-ai-maestro status [runId] [--repo <dir>] [--json]

  Without a run id, lists every run in this project, newest first. With one,
  shows that run's phases and how to reach it.

  --repo <dir>   The project. Defaults to the current directory.
  --json         The same facts as JSON, for a script.

  States: starting, running, paused, done, failed, cancelled — and
  interrupted, for a run whose job is gone without having ended it.`

/** The journal's status, corrected by whether a job is actually hosting it. */
export type RunState = RunRow['status'] | 'starting' | 'interrupted'

export function runState(row: RunRow, job: JobRecord | null): RunState {
  if (row.status !== 'running') return row.status
  if (job === null) return 'interrupted'
  return job.state === 'starting' ? 'starting' : 'running'
}

/** A run that `run --resume` would accept. */
export const isResumable = (state: RunState): boolean =>
  state === 'paused' || state === 'failed' || state === 'interrupted'

export async function statusCommand(argv: readonly string[], io: Io): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { repo: { type: 'string' }, json: { type: 'boolean' } },
      allowPositionals: true,
    })
  } catch {
    io.err(STATUS_USAGE)
    return USAGE
  }
  if (parsed.positionals.length > 1) {
    io.err(STATUS_USAGE)
    return USAGE
  }
  const repoPath = resolve(parsed.values.repo ?? process.cwd())
  const runId = parsed.positionals[0]
  const json = parsed.values.json === true

  // Not opened when there is nothing to open: the journal creates its store,
  // and asking what is running should not leave a directory behind.
  if (!existsSync(storeFor(repoPath))) {
    if (runId !== undefined) {
      io.err(`vinta-ai-maestro: no run "${runId}" in ${repoPath}`)
      return FAILED
    }
    io.out(json ? '{"runs":[]}' : 'vinta-ai-maestro: no runs in this project yet.')
    return OK
  }

  const journal = openJournal(repoPath)
  try {
    return runId === undefined
      ? listRuns(journal, repoPath, json, io)
      : showRun(journal, repoPath, runId, json, io)
  } finally {
    journal.close()
  }
}

function listRuns(journal: Journal, repoPath: string, json: boolean, io: Io): number {
  const now = Date.now()
  const rows = journal.runs().map((row) => {
    const nodes = journal.nodes(row.id)
    const state = runState(row, liveJob(repoPath, row.id))
    return {
      runId: row.id,
      workflowId: row.workflow_id,
      state,
      done: nodes.filter((node) => node.status === 'done').length,
      total: nodes.length,
      questions: journal.pendingQuestions(row.id).length,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    }
  })

  if (json) {
    io.out(JSON.stringify({ runs: rows }))
    return OK
  }
  if (rows.length === 0) {
    io.out('vinta-ai-maestro: no runs in this project yet.')
    return OK
  }
  io.out(
    table(
      ['RUN', 'STATE', 'PHASES', 'STARTED', 'ELAPSED'],
      rows.map((row) => [
        row.runId,
        row.questions > 0 ? `${row.state} (${row.questions} asking)` : row.state,
        `${row.done}/${row.total}`,
        new Date(row.startedAt).toLocaleString(),
        duration((row.endedAt ?? now) - row.startedAt),
      ]),
    ),
  )
  return OK
}

function showRun(
  journal: Journal,
  repoPath: string,
  runId: string,
  json: boolean,
  io: Io,
): number {
  const row = journal.run(runId)
  if (row === undefined) {
    io.err(`vinta-ai-maestro: no run "${runId}" in ${repoPath}`)
    return FAILED
  }
  const job = liveJob(repoPath, runId)
  const state = runState(row, job)
  const nodes = journal.nodes(runId)
  const asking = new Set(journal.pendingQuestions(runId).map((question) => question.nodeId))
  const waiting = state === 'running' ? journal.integrationWaits(runId) : new Map<string, string | null>()
  const waitNote = (nodeId: string): string => {
    if (!waiting.has(nodeId)) return ''
    const holder = waiting.get(nodeId)
    return ` — waiting for the integration worktree${holder === null || holder === undefined ? '' : ` (held by ${holder})`}`
  }

  if (json) {
    io.out(
      JSON.stringify({
        runId,
        workflowId: row.workflow_id,
        state,
        pid: job?.pid ?? null,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        nodes: nodes.map((node) => ({
          nodeId: node.node_id,
          status: node.status,
          wave: node.wave,
          harness: node.harness,
          asking: asking.has(node.node_id),
          waitingOn: waiting.has(node.node_id) ? 'integration_worktree' : null,
          heldBy: waiting.get(node.node_id) ?? null,
        })),
      }),
    )
    return OK
  }

  const ended = row.ended_at === null ? null : new Date(row.ended_at).toLocaleString()
  io.out(`run       ${runId}`)
  io.out(`workflow  ${row.workflow_id}`)
  io.out(`state     ${state}${job === null ? '' : ` (job pid ${job.pid})`}`)
  io.out(`started   ${new Date(row.started_at).toLocaleString()}`)
  if (ended !== null) io.out(`ended     ${ended}`)
  io.out(`elapsed   ${duration((row.ended_at ?? Date.now()) - row.started_at)}`)
  io.out('')
  io.out(
    table(
      ['PHASE', 'STATUS', 'WAVE', 'HARNESS'],
      nodes.map((node) => [
        node.node_id,
        (asking.has(node.node_id) ? `${node.status} — asking` : node.status) + waitNote(node.node_id),
        String(node.wave),
        node.harness,
      ]),
    ),
  )
  io.out('')
  if (asking.size > 0) {
    io.out(`${asking.size} phase(s) waiting on an answer — open \`vinta-ai-maestro ui\` to answer.`)
  }
  io.out(`log       ${jobLogPathFor(repoPath, runId)}`)
  if (isResumable(state)) io.out(`resume    vinta-ai-maestro run --resume ${runId}`)
  return OK
}

/** Left-aligned columns, two spaces apart. Plain text: it is read in a terminal. */
function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = header.map((title, i) =>
    Math.max(title.length, ...rows.map((row) => (row[i] ?? '').length)),
  )
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i] as number)))
      .join('  ')
  return [line(header), ...rows.map(line)].join('\n')
}

/** `3h 12m`, `4m 05s`, `12s`. */
export function duration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}
