/**
 * The journal: an append-only event log, the projections folded out of it, and
 * the run directory that holds everything too large to be a row.
 *
 * `events` is the source of truth. `runs` and `nodes` are caches of a fold over
 * it: they can be dropped at any moment and replayed, which is the entire
 * crash-safety story. A daemon that dies mid-run never has to reason about what
 * its in-memory state was — it deletes the projections and re-derives them from
 * the events that committed.
 *
 * `leases` is neither derived nor replayed. A lease records that a live process
 * holds a pool slot; after a restart no such process exists, so carrying leases
 * across a boot would leak capacity permanently. The table is cleared on open.
 *
 * Because it is not derived, nothing about a lease reaches a watching client on
 * its own. Writing the row is only half of taking one: the browser re-reads the
 * snapshot when an event arrives, so a holder set that changes with no event
 * behind it changes on disk and not on screen. `acquireLease` and
 * `releaseLease` below are therefore deliberately *only* the table write — the
 * callers that own a transition journal it, and the one that does not own a
 * transition (a renewal, which repeats a lease already announced) journals
 * nothing. Putting an `append` in here instead would have emitted a row for
 * every heartbeat, and a second row for every gate pool the scheduler already
 * announces as `gate_pool`.
 *
 * Transcripts are files, not rows: they grow to megabytes, are written once and
 * read by tailing, and putting them in SQLite would make every agent token
 * compete with the event log for one write lock.
 *
 * The store lives inside the project directory because transcripts and gate
 * logs capture repository contents verbatim — that data belongs where the
 * repository's own retention rules already reach, never in a global cache dir.
 * Nothing else here records content: rows, arguments and error messages carry
 * run, node, gate and session identifiers only.
 */
import Database from 'better-sqlite3'
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { type Decision, parseDecision } from '../decisions/index.ts'
import { computeWaves } from '../graph.ts'
import type { Workflow } from '../types.ts'
import { formatIssues, parseWorkflow } from '../validate.ts'
import type {
  HumanQuestion,
  IntegrationStepKind,
  IntegrationStepPayload,
  NewEvent,
  NodeStatus,
  RunStatus,
  StoredEvent,
} from './events.ts'

export interface RunRow {
  readonly id: string
  readonly workflow_id: string
  readonly status: RunStatus
  readonly base_branch: string
  readonly started_at: number
  readonly ended_at: number | null
}

export interface NodeRow {
  readonly run_id: string
  readonly node_id: string
  readonly status: NodeStatus
  readonly wave: number
  readonly lane: string | null
  readonly branch: string | null
  readonly base_branch: string | null
  readonly harness: string
  readonly session_id: string | null
}

/**
 * A pause nobody has answered yet (§9.1). Folded out of `human_question` and
 * unfolded by `human_answered` or by the node settling some other way, so it
 * is a cache of the log like every other projection here — never a second
 * source of truth.
 */
/** One step a node took in the integration worktree, as `integrationTimeline` pairs it. */
export interface IntegrationStepRow {
  readonly step: IntegrationStepKind
  readonly branch: string | null
  readonly incoming: string | null
  readonly wave: number | null
  readonly gate: string | null
  readonly round: number | null
  readonly log: string | null
  readonly startedAt: number
  /** Null while it is still going. */
  readonly finishedAt: number | null
  /** `interrupted`: the process holding it ended before it finished. */
  readonly outcome: 'ok' | 'resolved' | 'failed' | 'interrupted' | null
}

/** The integration worktree as `integrationWorktree` folds it. */
export interface IntegrationWorktreeState {
  readonly holder: string | null
  /** Epoch ms the holder took it. */
  readonly since: number | null
  /** The holder's step in progress, when it is inside one. */
  readonly step: IntegrationStepRow | null
  /** Nodes queued behind it, in the order they queued. */
  readonly queue: readonly string[]
}

export interface PendingQuestion {
  readonly runId: string
  readonly nodeId: string
  /** The `await_human` effect the node parked on, or the operator pause id. */
  readonly effectId: string
  readonly askedAt: number
  readonly question: HumanQuestion
}

export interface LeaseRow {
  readonly resource: string
  readonly holder_node: string
  readonly lease_id: string
  readonly acquired_at: number
  readonly expires_at: number | null
}

/** `transcript.jsonl` is the normalized AgentEvent stream; `raw.jsonl` is harness-native. */
export type TranscriptStream = 'transcript' | 'raw'

interface QuestionRow {
  readonly run_id: string
  readonly node_id: string
  readonly effect_id: string
  readonly asked_at: number
  readonly question_json: string
}

interface EventRow {
  readonly id: number
  readonly run_id: string
  readonly node_id: string | null
  readonly ts: number
  readonly type: string
  readonly payload_json: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_id TEXT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_run ON events (run_id, id);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS nodes (
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL,
  wave INTEGER NOT NULL,
  lane TEXT,
  branch TEXT,
  base_branch TEXT,
  harness TEXT NOT NULL,
  session_id TEXT,
  PRIMARY KEY (run_id, node_id)
);

CREATE TABLE IF NOT EXISTS questions (
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  asked_at INTEGER NOT NULL,
  question_json TEXT NOT NULL,
  PRIMARY KEY (run_id, node_id)
);

`

// Leases describe live processes and are intentionally rebuilt empty on every
// open. Keeping their DDL separate means an alpha with the old two-column key
// migrates safely by replacement: there is no durable row to preserve.
const LEASE_SCHEMA = `
CREATE TABLE leases (
  resource TEXT NOT NULL,
  holder_node TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (lease_id, resource)
);
`

export class Journal {
  /** `.vinta-ai-maestro/` inside the project. */
  readonly root: string
  private readonly db: Database.Database

  constructor(projectDir: string) {
    this.root = join(projectDir, '.vinta-ai-maestro')
    mkdirSync(join(this.root, 'runs'), { recursive: true })
    this.db = new Database(join(this.root, 'flow.db'))

    // WAL, because the UI reads projections while the scheduler writes events,
    // and a rollback journal makes those two block each other for the whole
    // multi-hour run.
    //
    // synchronous=FULL rather than WAL's usual NORMAL companion. NORMAL only
    // fsyncs at checkpoints, so a power loss or kernel panic can drop the tail
    // of the WAL. Losing committed events is not losing rows — it is a run that
    // replays to a state that never happened, silently, which is precisely the
    // failure the event log exists to prevent. The price is one fsync per
    // append, affordable only because the high-rate stream (agent transcripts)
    // is in files: SQLite sees tens of events per node, not thousands a second.
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = FULL')
    // A recovering daemon and a still-draining one can briefly want the lock.
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(SCHEMA)
    this.db.exec('DROP TABLE IF EXISTS leases')
    this.db.exec(LEASE_SCHEMA)
  }

  /**
   * Freezes the workflow into the run directory and journals the run and its
   * nodes. The snapshot is what the run executes — editing the source workflow
   * afterwards does not reach back into it.
   */
  createRun(runId: string, workflow: Workflow): void {
    mkdirSync(this.runDir(runId), { recursive: true })
    writeFileSync(join(this.runDir(runId), 'workflow.json'), `${JSON.stringify(workflow, null, 2)}\n`)

    const waves = computeWaves(workflow.nodes)
    this.db.transaction(() => {
      this.write({
        runId,
        type: 'run_started',
        payload: { workflow_id: workflow.id, base_branch: workflow.base_branch },
      })
      for (const node of workflow.nodes) {
        this.write({
          runId,
          nodeId: node.id,
          type: 'node_registered',
          payload: {
            wave: waves.get(node.id) ?? 1,
            harness: node.harness ?? workflow.defaults.harness,
          },
        })
      }
    })()
  }

  /** Reads back the frozen snapshot. Throws if it is missing or no longer valid. */
  readWorkflow(runId: string): Workflow {
    const raw: unknown = JSON.parse(readFileSync(join(this.runDir(runId), 'workflow.json'), 'utf8'))
    const result = parseWorkflow(raw)
    if (!result.ok) {
      throw new Error(`run "${runId}": frozen workflow is invalid\n${formatIssues(result.issues)}`)
    }
    return result.workflow
  }

  /** Appends one event and advances the projections in the same transaction. */
  append(event: NewEvent): number {
    return this.db.transaction(() => this.write(event))()
  }

  /** Events for a run in commit order. `sinceId` is exclusive, for tailing. */
  events(runId: string, sinceId = 0): StoredEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE run_id = ? AND id > ? ORDER BY id')
      .all(runId, sinceId) as EventRow[]
    return rows.map(toStoredEvent)
  }

  /**
   * §15's per-turn session decisions for one node, oldest first.
   *
   * A narrow read rather than a filter over `events`, because the node view
   * asks for this on every refresh and on every event that arrives: folding a
   * whole run's log in JavaScript to keep four rows would make the cost of the
   * panel grow with the length of the run it is describing. The `WHERE` runs in
   * SQLite, and only the matching rows are ever turned into objects.
   *
   * Deliberately not a projection. These rows only mean anything as a
   * sequence — "is reuse working" is a question about a run, and a table keyed
   * by node would answer it with whichever turn happened to be last.
   */
  sessionHistory(runId: string, nodeId: string): StoredEvent[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM events WHERE run_id = ? AND node_id = ? AND type = 'node_session'" +
          ' ORDER BY id',
      )
      .all(runId, nodeId) as EventRow[]
    return rows.map(toStoredEvent)
  }

  /**
   * The last `node_pr` row for one node, or undefined when it never reached
   * `open_pr`. A narrow read for the same reason `sessionHistory` is one.
   */
  latestPr(runId: string, nodeId: string): StoredEvent | undefined {
    // The phase's own PR. A node based on an `integ-<id>` branch also journals
    // that branch's PR (`kind: integration`); rows from before `kind` existed
    // are all phase PRs.
    const row = this.db
      .prepare(
        "SELECT * FROM events WHERE run_id = ? AND node_id = ? AND type = 'node_pr'" +
          " AND coalesce(json_extract(payload_json, '$.kind'), 'phase') = 'phase'" +
          ' ORDER BY id DESC LIMIT 1',
      )
      .get(runId, nodeId) as EventRow | undefined
    return row === undefined ? undefined : toStoredEvent(row)
  }

  /**
   * Every gate edge for one node, oldest first: the `gate_started` rows and
   * the `gate_result` rows interleaved in commit order.
   *
   * A narrow read for the same reason `sessionHistory` is one — the node view
   * asks on every refresh and on every frame, and folding a whole run's log
   * to find four rows would make the panel cost grow with the run.
   *
   * Both types in one query rather than two reads, because the pairing is the
   * point: a `gate_started` with no `gate_result` after it is what "running"
   * means, and that is only visible in their order.
   */
  gateHistory(runId: string, nodeId: string): StoredEvent[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM events WHERE run_id = ? AND node_id = ?' +
          " AND type IN ('gate_started', 'gate_result') ORDER BY id",
      )
      .all(runId, nodeId) as EventRow[]
    return rows.map(toStoredEvent)
  }

  /**
   * §15's session decisions for a whole run, oldest first — the run-level
   * rollup's input (`usage/reuse.ts`).
   *
   * The same narrow read as `sessionHistory`, without the node. Both exist
   * rather than one taking an optional node id because the index each wants is
   * different, and because a caller that passes `undefined` by accident would
   * get a whole run's rows where it asked for one node's — a bug that reads as
   * a plausible number rather than as an error.
   */
  /** §15.6's sibling: who took each node, for the staffing rollup. */
  crewAssignments(runId: string): StoredEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE run_id = ? AND type = 'node_crew' ORDER BY id")
      .all(runId) as EventRow[]
    return rows.map(toStoredEvent)
  }

  sessionDecisions(runId: string): StoredEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE run_id = ? AND type = 'node_session' ORDER BY id")
      .all(runId) as EventRow[]
    return rows.map(toStoredEvent)
  }

  /**
   * Drops every projection and replays the log. This is the boot path, and it
   * is also the repair path: a projection can never be so wrong that deleting
   * it is not the fix.
   */
  rebuildProjections(): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM runs').run()
      this.db.prepare('DELETE FROM nodes').run()
      this.db.prepare('DELETE FROM questions').run()
      const rows = this.db.prepare('SELECT * FROM events ORDER BY id').all() as EventRow[]
      for (const row of rows) this.project(toStoredEvent(row))
    })()
  }

  run(runId: string): RunRow | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined
  }

  /**
   * Every run the store knows about, newest first.
   *
   * The daemon's run list is this, not its in-process registry: a run is a row
   * folded out of `run_started`, so it survives the process that started it.
   * Listing the registry instead would make a restart look like a machine with
   * no history — the runs are still on disk, still resumable, and invisible.
   */
  runs(): RunRow[] {
    return this.db
      .prepare('SELECT * FROM runs ORDER BY started_at DESC, id DESC')
      .all() as RunRow[]
  }

  /**
   * The id of the newest event for a run, or 0 when it has none.
   *
   * This is the cursor a snapshot reflects. Read it *before* the projections
   * it accompanies and the pair can only err towards a replay — the fold is
   * idempotent — never towards a gap.
   */
  lastEventId(runId: string): number {
    const row = this.db
      .prepare('SELECT MAX(id) AS id FROM events WHERE run_id = ?')
      .get(runId) as { id: number | null }
    return row.id ?? 0
  }

  nodes(runId: string): NodeRow[] {
    return this.db
      .prepare('SELECT * FROM nodes WHERE run_id = ? ORDER BY node_id')
      .all(runId) as NodeRow[]
  }

  /**
   * The question a node is parked on, or `undefined` when it is not parked.
   * This is the read that makes §9.1's pause survive a restart: the daemon
   * serves it from here rather than from whatever host happened to ask it.
   */
  pendingQuestion(runId: string, nodeId: string): PendingQuestion | undefined {
    const row = this.db
      .prepare('SELECT * FROM questions WHERE run_id = ? AND node_id = ?')
      .get(runId, nodeId) as QuestionRow | undefined
    return row === undefined ? undefined : toPendingQuestion(row)
  }

  /** Every unanswered pause in a run. The boot path for a daemon coming back up. */
  pendingQuestions(runId: string): PendingQuestion[] {
    const rows = this.db
      .prepare('SELECT * FROM questions WHERE run_id = ? ORDER BY node_id')
      .all(runId) as QuestionRow[]
    return rows.map(toPendingQuestion)
  }

  acquireLease(
    resource: string,
    holderNode: string,
    leaseId = `${resource}:${holderNode}`,
    expiresAt: number | null = null,
  ): void {
    this.db
      .prepare(
        'INSERT INTO leases ' +
          '(resource, holder_node, lease_id, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?) ' +
          'ON CONFLICT (lease_id, resource) DO UPDATE SET expires_at = excluded.expires_at',
      )
      .run(resource, holderNode, leaseId, Date.now(), expiresAt)
  }

  releaseLease(resource: string, holderNode: string, leaseId = `${resource}:${holderNode}`): void {
    this.db
      .prepare('DELETE FROM leases WHERE resource = ? AND holder_node = ? AND lease_id = ?')
      .run(resource, holderNode, leaseId)
  }

  leases(): LeaseRow[] {
    return this.db.prepare('SELECT * FROM leases ORDER BY resource, holder_node').all() as LeaseRow[]
  }

  /** One JSON value per line. O_APPEND, so a concurrent tail never sees half a line. */
  appendTranscript(
    runId: string,
    nodeId: string,
    entry: unknown,
    stream: TranscriptStream = 'transcript',
  ): void {
    mkdirSync(this.nodeDir(runId, nodeId), { recursive: true })
    appendFileSync(this.transcriptPath(runId, nodeId, stream), `${JSON.stringify(entry)}\n`)
  }

  /**
   * The last `limit` entries, read backwards from the end of the file.
   * Transcripts are the reason this is a file at all; reading the whole thing
   * to render the last screenful would hand that advantage straight back.
   */
  tailTranscript(
    runId: string,
    nodeId: string,
    limit = 100,
    stream: TranscriptStream = 'transcript',
  ): unknown[] {
    const path = this.transcriptPath(runId, nodeId, stream)
    let size: number
    try {
      size = statSync(path).size
    } catch {
      return []
    }

    const fd = openSync(path, 'r')
    try {
      // Grow the window until it holds more than `limit` complete lines or
      // reaches the start of the file. Entries are small: this reads once.
      for (let window = 8192; ; window *= 4) {
        const start = Math.max(0, size - window)
        const buffer = Buffer.allocUnsafe(size - start)
        readSync(fd, buffer, 0, buffer.length, start)
        const lines = buffer.toString('utf8').split('\n').filter(Boolean)
        // Unless we reached byte 0, the first line is a fragment — dropping it
        // is why the window has to hold `limit` + 1 of them.
        if (start === 0 || lines.length > limit) {
          return lines.slice(-limit).map((line) => JSON.parse(line) as unknown)
        }
      }
    } finally {
      closeSync(fd)
    }
  }

  /**
   * Records one of a node's decisions (`src/decisions`) in `decisions.jsonl`
   * beside its transcript. A file rather than an event for the reason the
   * transcript is one: a decision is the operator's or the agent's prose (§11).
   */
  appendDecision(runId: string, nodeId: string, decision: Decision): void {
    mkdirSync(this.nodeDir(runId, nodeId), { recursive: true })
    appendFileSync(join(this.nodeDir(runId, nodeId), 'decisions.jsonl'), `${JSON.stringify(decision)}\n`)
  }

  /**
   * A node's decisions, oldest first: what a resumed run hands every later
   * prompt. A line this build cannot read is skipped rather than failing the
   * resume over it — and so is a half-written last line from a killed process.
   */
  decisions(runId: string, nodeId: string): Decision[] {
    let text: string
    try {
      text = readFileSync(join(this.nodeDir(runId, nodeId), 'decisions.jsonl'), 'utf8')
    } catch {
      return []
    }
    const found: Decision[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        continue
      }
      const parsed = parseDecision(raw)
      if (parsed !== null) found.push(parsed)
    }
    return found
  }

  /** Where the gate runner streams its output. The directory is created here. */
  gateLogPath(runId: string, nodeId: string, gateId: string): string {
    const dir = join(this.nodeDir(runId, nodeId), 'gates')
    mkdirSync(dir, { recursive: true })
    return join(dir, `${gateId}.log`)
  }

  /**
   * Nodes queued behind the integration worktree right now, with the holder
   * each one was told about: the last `node_wait` per node, where it says
   * `queued`. For `status`, which otherwise shows such a node as `running`
   * with nothing running.
   */
  integrationWaits(runId: string): Map<string, string | null> {
    const rows = this.db
      .prepare("SELECT node_id, payload_json FROM events WHERE run_id = ? AND type = 'node_wait' ORDER BY id")
      .all(runId) as { node_id: string; payload_json: string }[]
    const waits = new Map<string, string | null>()
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as { state?: string; holder?: string | null }
      if (payload.state === 'queued') waits.set(row.node_id, payload.holder ?? null)
      else waits.delete(row.node_id)
    }
    return waits
  }

  /** The pipeline state each node last entered (`node_step`), for `status` and the run view. */
  nodeSteps(runId: string): Map<string, string> {
    const rows = this.db
      .prepare("SELECT node_id, payload_json FROM events WHERE run_id = ? AND type = 'node_step' ORDER BY id")
      .all(runId) as { node_id: string; payload_json: string }[]
    const steps = new Map<string, string>()
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as { state?: string }
      if (typeof payload.state === 'string') steps.set(row.node_id, payload.state)
    }
    return steps
  }

  /**
   * What a node has done in the integration worktree this attempt, oldest
   * first: each `integration_step` paired with its finish, the open one last.
   *
   * "This attempt" starts at the node's first `node_step` with a new attempt
   * number, or the first after the run resumed — an earlier attempt's merges
   * are not what the phase is doing now. A step a killed process left open is
   * closed `interrupted` at the next `run_resumed` or `run_ended`.
   */
  integrationTimeline(runId: string, nodeId: string): IntegrationStepRow[] {
    let rows: IntegrationStepRow[] = []
    let attempt: number | null = null
    let resumed = false
    for (const event of this.#integrationEvents(runId)) {
      if (event.type === 'run_resumed' || event.type === 'run_ended') {
        rows = rows.map((row) => (row.finishedAt === null ? { ...row, finishedAt: event.ts, outcome: 'interrupted' } : row))
        resumed = true
        continue
      }
      if (event.nodeId !== nodeId) continue
      if (event.type === 'node_step') {
        const next = typeof event.payload['attempt'] === 'number' ? event.payload['attempt'] : null
        if (attempt === null || next !== attempt || resumed) rows = []
        attempt = next
        resumed = false
        continue
      }
      if (event.type === 'integration_step') rows = foldStep(rows, event.payload as unknown as IntegrationStepPayload, event.ts)
    }
    return rows
  }

  /**
   * The integration worktree now: the node holding it and since when, the
   * step it is on, and the nodes queued behind it — folded from `hold` steps
   * and `node_wait`. Empty again whenever the run resumes or ends, because a
   * hold does not survive the process that took it.
   */
  integrationWorktree(runId: string): IntegrationWorktreeState {
    let holder: { node: string; since: number } | null = null
    let steps: IntegrationStepRow[] = []
    const queue = new Map<string, string | null>()
    for (const event of this.#integrationEvents(runId)) {
      if (event.type === 'run_resumed' || event.type === 'run_ended') {
        holder = null
        steps = []
        queue.clear()
        continue
      }
      if (event.nodeId === null) continue
      if (event.type === 'node_wait') {
        if (event.payload['state'] === 'queued') queue.set(event.nodeId, (event.payload['holder'] as string | null) ?? null)
        else queue.delete(event.nodeId)
        continue
      }
      if (event.type !== 'integration_step') continue
      const payload = event.payload as unknown as IntegrationStepPayload
      if (payload.step === 'hold') {
        if (payload.state === 'started') {
          holder = { node: event.nodeId, since: event.ts }
          steps = []
        } else if (holder?.node === event.nodeId) {
          holder = null
          steps = []
        }
        continue
      }
      if (holder?.node === event.nodeId) steps = foldStep(steps, payload, event.ts)
    }
    const step = [...steps].reverse().find((row) => row.finishedAt === null) ?? null
    return {
      holder: holder?.node ?? null,
      since: holder?.since ?? null,
      step,
      queue: [...queue.keys()],
    }
  }

  #integrationEvents(
    runId: string,
  ): { type: string; nodeId: string | null; ts: number; payload: Record<string, unknown> }[] {
    const rows = this.db
      .prepare(
        'SELECT node_id, type, ts, payload_json FROM events WHERE run_id = ? AND type IN ' +
          "('node_step', 'integration_step', 'node_wait', 'run_resumed', 'run_ended') ORDER BY id",
      )
      .all(runId) as { node_id: string | null; type: string; ts: number; payload_json: string }[]
    return rows.map((row) => ({
      type: row.type,
      nodeId: row.node_id,
      ts: row.ts,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    }))
  }

  /**
   * Nodes the operator paused while they were parked on a question
   * (`Scheduler.pause` — `held`), still held: no answer and no status change
   * since. For `status`, which would otherwise show them as merely asking.
   */
  heldNodes(runId: string): Set<string> {
    const rows = this.db
      .prepare(
        "SELECT node_id, type, payload_json FROM events WHERE run_id = ? AND node_id IS NOT NULL" +
          " AND type IN ('node_operation', 'human_answered', 'node_status') ORDER BY id",
      )
      .all(runId) as { node_id: string; type: string; payload_json: string }[]
    const held = new Set<string>()
    for (const row of rows) {
      if (row.type !== 'node_operation') {
        held.delete(row.node_id)
        continue
      }
      const payload = JSON.parse(row.payload_json) as { op?: string; delivery?: string }
      if (payload.op === 'pause' && payload.delivery === 'held') held.add(row.node_id)
      if (payload.op === 'resume' && payload.delivery === 'delivered') held.delete(row.node_id)
    }
    return held
  }

  /**
   * Each phase's current staffing when it is not the plan's: the latest
   * `node_crew` row per node, kept only when it is a substitution. For
   * `status`, which otherwise shows a phase running on a dearer model than its
   * plan named as if nothing were different.
   */
  substitutions(
    runId: string,
  ): Map<string, { member: string; tier: number; insteadOf: string | null; plannedTier: number | null; reason: string | null }> {
    const latest = new Map<
      string,
      { member: string; tier: number; insteadOf: string | null; plannedTier: number | null; reason: string | null } | null
    >()
    for (const event of this.crewAssignments(runId)) {
      if (!('nodeId' in event) || event.nodeId === null) continue
      const payload = event.payload as Record<string, unknown>
      latest.set(
        event.nodeId,
        payload['substitute'] === true && typeof payload['member'] === 'string'
          ? {
              member: payload['member'],
              tier: typeof payload['tier'] === 'number' ? payload['tier'] : 0,
              insteadOf: typeof payload['instead_of'] === 'string' ? payload['instead_of'] : null,
              plannedTier: typeof payload['planned_tier'] === 'number' ? payload['planned_tier'] : null,
              reason: typeof payload['reason'] === 'string' ? payload['reason'] : null,
            }
          : null,
      )
    }
    const found = new Map<string, NonNullable<ReturnType<typeof latest.get>>>()
    for (const [node, row] of latest) if (row !== null && row !== undefined) found.set(node, row)
    return found
  }

  /**
   * Forgets a run: its events and every projection folded from them. For
   * `purge`, which removes the run directory — and until this existed left
   * the rows behind, so the UI went on listing, and offering to resume, a run
   * whose transcripts, gate logs and frozen workflow were gone.
   */
  deleteRun(runId: string): void {
    this.db.transaction(() => {
      for (const table of ['events', 'runs', 'nodes', 'questions']) {
        this.db.prepare(`DELETE FROM ${table} WHERE ${table === 'runs' ? 'id' : 'run_id'} = ?`).run(runId)
      }
    })()
  }

  close(): void {
    this.db.close()
  }

  /**
   * Whether `path` is a file inside this run's own directory. A log path
   * read back out of an event is served only when it is: the API reads what
   * the journal points at, and must not read anything else on that word.
   */
  ownsRunFile(runId: string, path: string): boolean {
    const inside = relative(this.runDir(runId), resolve(path))
    return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)
  }

  private runDir(runId: string): string {
    return join(this.root, 'runs', runId)
  }

  private nodeDir(runId: string, nodeId: string): string {
    return join(this.runDir(runId), 'nodes', nodeId)
  }

  private transcriptPath(runId: string, nodeId: string, stream: TranscriptStream): string {
    return join(this.nodeDir(runId, nodeId), `${stream}.jsonl`)
  }

  /** Insert + project. Callers wrap this in a transaction; it is never called bare. */
  private write(event: NewEvent): number {
    const ts = Date.now()
    const nodeId = 'nodeId' in event ? event.nodeId : null
    const info = this.db
      .prepare('INSERT INTO events (run_id, node_id, ts, type, payload_json) VALUES (?, ?, ?, ?, ?)')
      .run(event.runId, nodeId, ts, event.type, JSON.stringify(event.payload))
    const id = Number(info.lastInsertRowid)
    this.project({ ...event, id, ts } as StoredEvent)
    return id
  }

  /**
   * The fold. Append and rebuild share it deliberately — two copies of this
   * function is how a projection quietly stops matching its log.
   */
  private project(event: StoredEvent): void {
    switch (event.type) {
      case 'run_started':
        this.db
          .prepare(
            'INSERT OR REPLACE INTO runs (id, workflow_id, status, base_branch, started_at, ended_at)' +
              " VALUES (?, ?, 'running', ?, ?, NULL)",
          )
          .run(event.runId, event.payload.workflow_id, event.payload.base_branch, event.ts)
        return
      case 'run_ended':
        this.db
          .prepare('UPDATE runs SET status = ?, ended_at = ? WHERE id = ?')
          .run(event.payload.status, event.ts, event.runId)
        return
      case 'run_resumed':
        // `started_at` is deliberately untouched — see the payload's docstring.
        // `ended_at` back to NULL because the run is in flight again, and a row
        // that kept the end of a previous attempt would read as a run that
        // finished before it was running.
        this.db
          .prepare("UPDATE runs SET status = 'running', ended_at = NULL WHERE id = ?")
          .run(event.runId)
        return
      case 'node_registered':
        this.db
          .prepare(
            'INSERT OR REPLACE INTO nodes (run_id, node_id, status, wave, harness)' +
              " VALUES (?, ?, 'pending', ?, ?)",
          )
          .run(event.runId, event.nodeId, event.payload.wave, event.payload.harness)
        return
      case 'node_status':
        this.db
          .prepare('UPDATE nodes SET status = ? WHERE run_id = ? AND node_id = ?')
          .run(event.payload.status, event.runId, event.nodeId)
        // A node that settled is no longer parked on anything, however it got
        // there — an abort while suspended ends the question without answering
        // it, and a pause left dangling in this table would outlive the run.
        // Back to `pending` is the same: a halted or resumed node starts its
        // pipeline again from the top, and asks again if it gets there.
        if (UNPARKED.has(event.payload.status)) this.dropQuestion(event.runId, event.nodeId)
        return
      case 'node_assigned':
        // COALESCE so a patch that omits a field leaves the projected one alone.
        this.db
          .prepare(
            'UPDATE nodes SET lane = COALESCE(?, lane), branch = COALESCE(?, branch),' +
              ' base_branch = COALESCE(?, base_branch), session_id = COALESCE(?, session_id),' +
              ' harness = COALESCE(?, harness)' +
              ' WHERE run_id = ? AND node_id = ?',
          )
          .run(
            event.payload.lane ?? null,
            event.payload.branch ?? null,
            event.payload.base_branch ?? null,
            event.payload.session_id ?? null,
            event.payload.harness ?? null,
            event.runId,
            event.nodeId,
          )
        return
      case 'human_question': {
        const { effect_id, ...question } = event.payload
        this.db
          .prepare(
            'INSERT OR REPLACE INTO questions (run_id, node_id, effect_id, asked_at, question_json)' +
              ' VALUES (?, ?, ?, ?, ?)',
          )
          .run(event.runId, event.nodeId, effect_id, event.ts, JSON.stringify(question))
        return
      }
      case 'human_answered':
        this.dropQuestion(event.runId, event.nodeId)
        return
      case 'node_operation':
        // Steering is journalled for the record, not projected: what it did to
        // the node shows up as the status and question events it caused.
        return
      case 'node_session':
        // History, like the gate rows below. The *current* session id is
        // already projected by `node_assigned`; this row is the per-turn
        // decision behind it, which only means anything as a sequence — one
        // `reused` row overwriting another in a projection would answer
        // "is reuse working" with the last turn rather than the run (§15).
        return
      case 'gate_pool':
      case 'gate_started':
      case 'gate_result':
      case 'wave_gate_result':
      case 'wave_built':
      case 'wave_deferred':
      case 'workspace_exec':
      case 'gate_cache_invalidated':
      case 'gate_stalled':
      case 'stacks_stopped':
      case 'integration_reclaimed':
      case 'coordinator_woke':
      case 'bare_gate_blocked':
      case 'bare_gate_detected':
      case 'chore_result':
      case 'agent_lease':
      case 'system_one_judged':
        // History, deliberately not a projection. `leases` is the *current*
        // holder set and must not survive a restart, so folding these into it
        // would resurrect capacity no live process holds; `analytics.ts` and
        // `postmortem.ts` read them from `events`, where the history is.
        //
        // `agent_lease` sits here for the same reason and not because it is an
        // afterthought: the row it announces is written by the broker beside
        // it, in the same call. The event is what makes the write *visible* —
        // it is not a second copy of the holder set, and a rebuild that folded
        // it would be reconstructing live process state from a log.
        return
    }
  }

  private dropQuestion(runId: string, nodeId: string): void {
    this.db.prepare('DELETE FROM questions WHERE run_id = ? AND node_id = ?').run(runId, nodeId)
  }
}

/**
 * A `started` step opens a row; a `finished` one closes the newest open row of
 * the same step — and the same round or gate where the start named one. What
 * only the finish knows (the gate `verify` found red, its log) is copied on.
 */
function foldStep(rows: IntegrationStepRow[], payload: IntegrationStepPayload, ts: number): IntegrationStepRow[] {
  if (payload.state === 'started') {
    return [
      ...rows,
      {
        step: payload.step,
        branch: payload.branch ?? null,
        incoming: payload.incoming ?? null,
        wave: payload.wave ?? null,
        gate: payload.gate ?? null,
        round: payload.round ?? null,
        log: payload.log ?? null,
        startedAt: ts,
        finishedAt: null,
        outcome: null,
      },
    ]
  }
  const index = rows.findLastIndex(
    (row) =>
      row.finishedAt === null &&
      row.step === payload.step &&
      (row.round === null || row.round === (payload.round ?? null)) &&
      (row.gate === null || payload.gate === undefined || row.gate === payload.gate),
  )
  if (index === -1) return rows
  const open = rows[index] as IntegrationStepRow
  const closed: IntegrationStepRow = {
    ...open,
    gate: open.gate ?? payload.gate ?? null,
    log: open.log ?? payload.log ?? null,
    finishedAt: ts,
    outcome: payload.outcome ?? 'ok',
  }
  return rows.map((row, i) => (i === index ? closed : row))
}

/** Statuses past which a pending question cannot still be pending. */
const UNPARKED: ReadonlySet<NodeStatus> = new Set<NodeStatus>(['done', 'failed', 'blocked', 'pending'])

function toPendingQuestion(row: QuestionRow): PendingQuestion {
  return {
    runId: row.run_id,
    nodeId: row.node_id,
    effectId: row.effect_id,
    askedAt: row.asked_at,
    question: JSON.parse(row.question_json) as HumanQuestion,
  }
}

function toStoredEvent(row: EventRow): StoredEvent {
  return {
    id: row.id,
    ts: row.ts,
    runId: row.run_id,
    ...(row.node_id === null ? {} : { nodeId: row.node_id }),
    type: row.type,
    payload: JSON.parse(row.payload_json),
  } as StoredEvent
}

export function openJournal(projectDir: string): Journal {
  return new Journal(projectDir)
}
