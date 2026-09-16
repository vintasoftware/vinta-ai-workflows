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
import { join } from 'node:path'
import { computeWaves } from '../graph.ts'
import type { Workflow } from '../types.ts'
import { formatIssues, parseWorkflow } from '../validate.ts'
import type { HumanQuestion, NewEvent, NodeStatus, RunStatus, StoredEvent } from './events.ts'

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

  /** Where the gate runner streams its output. The directory is created here. */
  gateLogPath(runId: string, nodeId: string, gateId: string): string {
    const dir = join(this.nodeDir(runId, nodeId), 'gates')
    mkdirSync(dir, { recursive: true })
    return join(dir, `${gateId}.log`)
  }

  close(): void {
    this.db.close()
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
        if (SETTLED.has(event.payload.status)) this.dropQuestion(event.runId, event.nodeId)
        return
      case 'node_assigned':
        // COALESCE so a patch that omits a field leaves the projected one alone.
        this.db
          .prepare(
            'UPDATE nodes SET lane = COALESCE(?, lane), branch = COALESCE(?, branch),' +
              ' base_branch = COALESCE(?, base_branch), session_id = COALESCE(?, session_id)' +
              ' WHERE run_id = ? AND node_id = ?',
          )
          .run(
            event.payload.lane ?? null,
            event.payload.branch ?? null,
            event.payload.base_branch ?? null,
            event.payload.session_id ?? null,
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
      case 'gate_result':
      case 'agent_lease':
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

/** Statuses past which a pending question cannot still be pending. */
const SETTLED: ReadonlySet<NodeStatus> = new Set<NodeStatus>(['done', 'failed', 'blocked'])

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
