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
 * statuses, counts and times — plus, for one run, its pending questions and
 * the decisions made without the operator, since a terminal on the operator's
 * own machine is where they are read when the UI is not open.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { describeUnattended, runAgentDetails, unattendedDecisions } from '../decisions/index.ts'
import { jobLogPathFor, liveJob, type JobRecord } from '../job/job.ts'
import { describeStep } from '../journal/integration-steps.ts'
import {
  type IntegrationWait,
  type IntegrationWorktreeState,
  openJournal,
  type Journal,
  type PendingQuestion,
  type RunRow,
} from '../journal/journal.ts'
import type { StoredEvent } from '../journal/events.ts'
import { describeOutage, openOutages } from '../monitor/monitor.ts'
import { FAILED, OK, USAGE, type Io } from './io.ts'
import { storeFor } from './paths.ts'
import { warnStaleUis } from './ui-record.ts'
import { describeLeftovers, findLeftovers, type LeftoverDeps } from '../run/leftovers.ts'

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

export async function statusCommand(
  argv: readonly string[],
  io: Io,
  deps: LeftoverDeps = {},
): Promise<number> {
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

  warnStaleUis(repoPath, io)
  const journal = openJournal(repoPath)
  try {
    return runId === undefined
      ? await listRuns(journal, repoPath, json, io, deps)
      : showRun(journal, repoPath, runId, json, io)
  } finally {
    journal.close()
  }
}

async function listRuns(
  journal: Journal,
  repoPath: string,
  json: boolean,
  io: Io,
  deps: LeftoverDeps,
): Promise<number> {
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

  // What finished runs left running or on disk: a run that is over should not
  // still hold containers, worktrees or a process, and nothing else says so.
  const leftovers = await findLeftovers(repoPath, journal, deps)

  if (json) {
    io.out(JSON.stringify({ runs: rows, leftovers }))
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
  if (leftovers.length > 0) {
    io.out('')
    io.out('Left behind by finished runs:')
    for (const line of describeLeftovers(leftovers)) io.out(`  ${line}`)
  }
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
  // The question itself, not only that there is one: an operator answering
  // from the terminal had to read it out of `flow.db`.
  const questions = new Map(journal.pendingQuestions(runId).map((pending) => [pending.nodeId, pending]))
  const asking = new Set(questions.keys())
  const waiting = state === 'running' ? journal.integrationWaits(runId) : new Map<string, IntegrationWait>()
  const held = state === 'running' ? journal.heldNodes(runId) : new Set<string>()
  const substituted = journal.substitutions(runId)
  // Where each phase is in its pipeline, and who has the integration
  // worktree: a phase in `integrate` runs no agent, and read as frozen.
  const steps = journal.nodeSteps(runId)
  const worktree = state === 'running' ? journal.integrationWorktree(runId) : null
  // What the run decided with nobody watching (F5's list): retries, agents'
  // questions and plan questions a timer or the coordinator answered.
  const decided = unattendedDecisions(journal.events(runId))
  const details = runAgentDetails(journal, runId)
  const crewNote = (nodeId: string): string => {
    const row = substituted.get(nodeId)
    if (row === undefined) return ''
    const dearer = row.plannedTier !== null && row.tier > row.plannedTier ? `, tier ${row.plannedTier} → ${row.tier}` : ''
    return ` — on ${row.member} instead of ${row.insteadOf ?? '?'}${dearer}${row.reason === null ? '' : ` (${row.reason})`}`
  }
  const waitNote = (nodeId: string): string => {
    if (held.has(nodeId)) return ' — paused by operator'
    const wait = waiting.get(nodeId)
    if (wait === undefined) return ''
    if (wait.paused) return ' — paused in the queue for the integration worktree'
    // Whoever holds it now, when a phase does: the holder recorded at queue
    // time may have let go long since.
    const holder = worktree?.holder ?? wait.holder
    return ` — waiting for the integration worktree${holder === null ? '' : ` (held by ${holder})`}`
  }

  const outages = openOutages(journal.events(runId))
  const unhealthy = unhealthyLanes(journal.events(runId))
  if (json) {
    io.out(
      JSON.stringify({
        runId,
        outages,
        unhealthyLanes: unhealthy,
        workflowId: row.workflow_id,
        state,
        pid: job?.pid ?? null,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        integration: worktree,
        nodes: nodes.map((node) => ({
          nodeId: node.node_id,
          status: node.status,
          wave: node.wave,
          harness: node.harness,
          asking: asking.has(node.node_id),
          question: questionOf(questions.get(node.node_id)),
          waitingOn: waiting.has(node.node_id) ? 'integration_worktree' : null,
          heldBy: waiting.get(node.node_id)?.paused === true ? null : (worktree?.holder ?? waiting.get(node.node_id)?.holder ?? null),
          pausedInQueue: waiting.get(node.node_id)?.paused === true,
          pausedByOperator: held.has(node.node_id),
          step: steps.get(node.node_id) ?? null,
          substitution: substituted.get(node.node_id) ?? null,
        })),
        unattended: decided.map((entry) => ({ ...entry, summary: describeUnattended(entry, { details }) })),
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
  for (const outage of outages) io.out(`outage    ${describeOutage(outage)}`)
  for (const lane of unhealthy) io.out(`lane      ${describeUnhealthyLane(lane)}`)
  if (state === 'running') for (const line of describePoolQueues(poolQueues(journal.events(runId)))) io.out(`pool      ${line}`)
  io.out('')
  io.out(
    table(
      ['PHASE', 'STATUS', 'WAVE', 'HARNESS'],
      nodes.map((node) => [
        node.node_id,
        (asking.has(node.node_id) ? `${node.status} — asking` : node.status) +
          (node.status === 'running' && steps.has(node.node_id) ? ` · ${steps.get(node.node_id)}` : '') +
          waitNote(node.node_id) +
          crewNote(node.node_id),
        String(node.wave),
        node.harness,
      ]),
    ),
  )
  io.out('')
  if (worktree !== null && (worktree.holder !== null || worktree.queue.length > 0)) io.out(integrationLine(worktree))
  if (decided.length > 0) {
    io.out(`Decided without you (${decided.length}):`)
    for (const entry of decided) io.out(`  ${new Date(entry.at).toLocaleString()}  ${describeUnattended(entry, { details })}`)
    io.out('')
  }
  for (const [nodeId, pending] of questions) {
    const choices = pending.question.choices ?? []
    io.out(`${nodeId} asks: ${pending.question.question}${choices.length === 0 ? '' : ` [${choices.join(' | ')}]`}`)
  }
  if (asking.size > 0) {
    io.out(
      `${asking.size} phase(s) waiting on an answer — \`vinta-ai-maestro node answer <run> <phase> <choice>\`, ` +
        'or open `vinta-ai-maestro ui`.',
    )
  }
  io.out(`log       ${jobLogPathFor(repoPath, runId)}`)
  if (isResumable(state)) io.out(`resume    vinta-ai-maestro run --resume ${runId}`)
  return OK
}

/**
 * `integration  p4 · wave 2 gate test · 6:13 · 2 queued (p5, p7)`: the one
 * worktree every merge goes through, and whether it is busy or stuck.
 */
function integrationLine(worktree: IntegrationWorktreeState, now = Date.now()): string {
  const parts = [worktree.holder ?? 'free']
  if (worktree.holder !== null) {
    parts.push(worktree.step === null ? 'between steps' : describeStep(worktree.step))
    const since = worktree.step?.startedAt ?? worktree.since
    if (since !== null) parts.push(duration(now - since))
  }
  if (worktree.queue.length > 0) parts.push(`${worktree.queue.length} queued (${worktree.queue.join(', ')})`)
  return `integration  ${parts.join(' · ')}`
}

/** A pending question as `status --json` gives it: what is asked, how, and the effect it parked on. */
function questionOf(pending: PendingQuestion | undefined): Record<string, unknown> | null {
  if (pending === undefined) return null
  return {
    effectId: pending.effectId,
    question: pending.question.question,
    kind: pending.question.kind,
    choices: pending.question.choices ?? null,
    askedAt: pending.askedAt,
  }
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

type UnhealthyLane = Extract<StoredEvent, { type: 'lane_unhealthy' }>['payload']

/** Lanes taken out of the run because they could not be recycled (`lane_unhealthy`). */
export function unhealthyLanes(events: readonly StoredEvent[]): readonly UnhealthyLane[] {
  return events.flatMap((event) => (event.type === 'lane_unhealthy' ? [event.payload] : []))
}

/** One line per unhealthy lane: what replaced it, and what is in the way of cleaning it. */
export function describeUnhealthyLane(lane: UnhealthyLane): string {
  const blocked = (lane.unremovable ?? []).map((entry) =>
    entry.uid < 0 ? entry.path : `${entry.path} (owned by uid ${entry.uid})`,
  )
  return (
    `${lane.lane} is unhealthy (${lane.stage} would not recycle) and was replaced by ${lane.replacement}` +
    (blocked.length === 0 ? '' : `; could not remove ${blocked.join(', ')}`)
  )
}

export interface PoolQueue {
  readonly resource: string
  /** Who holds it, oldest first, and since when. */
  readonly holders: readonly { readonly node: string; readonly since: number }[]
  /** Who waits for it, in the order they asked. */
  readonly waiting: readonly { readonly node: string; readonly since: number }[]
}

/**
 * Who holds each pool and who waits for it, from the journal: a phase's gate
 * step (`gate_pool`) and an agent's `with` (`agent_lease`). Nobody had to read
 * `ps` and `lsof` to see that a capacity-1 `test-suite` had four phases in
 * line behind it.
 */
export function poolQueues(events: readonly StoredEvent[]): readonly PoolQueue[] {
  const holding = new Map<string, Map<string, number>>()
  const waiting = new Map<string, Map<string, number>>()
  const leases = new Map<string, { node: string; resources: readonly string[] }>()
  const at = (map: Map<string, Map<string, number>>, resource: string): Map<string, number> => {
    const found = map.get(resource) ?? new Map<string, number>()
    map.set(resource, found)
    return found
  }
  for (const event of events) {
    if (event.type === 'run_resumed' || event.type === 'run_ended') {
      holding.clear()
      waiting.clear()
      leases.clear()
      continue
    }
    if (event.type === 'gate_pool') {
      for (const resource of event.payload.resources) {
        if (event.payload.phase === 'requested') at(waiting, resource).set(event.nodeId, event.ts)
        if (event.payload.phase === 'granted') {
          at(waiting, resource).delete(event.nodeId)
          at(holding, resource).set(event.nodeId, event.ts)
        }
        if (event.payload.phase === 'released') {
          at(waiting, resource).delete(event.nodeId)
          at(holding, resource).delete(event.nodeId)
        }
      }
    } else if (event.type === 'agent_lease') {
      if (event.payload.phase === 'acquired') {
        leases.set(event.payload.lease_id, { node: event.nodeId, resources: event.payload.resources })
        for (const resource of event.payload.resources) at(holding, resource).set(event.nodeId, event.ts)
      } else {
        const lease = leases.get(event.payload.lease_id)
        leases.delete(event.payload.lease_id)
        for (const resource of lease?.resources ?? []) at(holding, resource).delete(lease?.node ?? '')
      }
    }
  }
  const resources = [...new Set([...holding.keys(), ...waiting.keys()])].sort()
  return resources.flatMap((resource) => {
    const held = [...(holding.get(resource) ?? new Map<string, number>())].map(([node, since]) => ({ node, since }))
    const queued = [...(waiting.get(resource) ?? new Map<string, number>())].map(([node, since]) => ({ node, since }))
    return held.length === 0 && queued.length === 0 ? [] : [{ resource, holders: held, waiting: queued }]
  })
}

/** `test-suite: p3b (holds 4m) → p5b (waits 22m) → p5c (waits 3m)`. */
export function describePoolQueues(queues: readonly PoolQueue[], now: number = Date.now()): string[] {
  const minutes = (since: number): string => `${Math.max(0, Math.round((now - since) / 60_000))}m`
  return queues
    .filter((queue) => queue.waiting.length > 0)
    .map(
      (queue) =>
        `${queue.resource}: ` +
        [
          ...queue.holders.map((entry) => `${entry.node} (holds ${minutes(entry.since)})`),
          ...queue.waiting.map((entry) => `${entry.node} (waits ${minutes(entry.since)})`),
        ].join(' → '),
    )
}
