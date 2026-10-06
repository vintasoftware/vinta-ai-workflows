/**
 * The durable half of a capacity wait: when a harness may be tried again.
 *
 * §6.1 requires this to survive a daemon restart. A `quota` wait can last
 * hours, which is long enough to span a laptop sleep, a crash or a deliberate
 * restart; a wake time held only in memory would come back as either a lost
 * wait (nodes parked forever) or a re-fired one (every node stampeding the
 * vendor that just refused them).
 *
 * It lives in the journal's own database file, next to `leases`, because it is
 * the same kind of fact: small, current, and about capacity rather than about
 * what happened. It is deliberately *not* an `events` row. The event
 * vocabulary is closed and owned elsewhere, and none of its payloads can carry
 * a wake time — see the note in `admission.ts` about that gap.
 *
 * Unlike `leases`, this table is not cleared on open. A lease describes a live
 * process and cannot outlive it; a wake time describes the vendor's clock,
 * which does not care that we restarted.
 *
 * The same connection keeps `capacity_ceilings`: the last ceiling AIMD
 * discovered per harness, and when. Keyed by harness alone, not by run — the
 * limit it describes belongs to the account, and a run that starts an hour
 * after another was throttled is talking to the same account. It is a hint,
 * not a fact, so `AdmissionControl` only trusts a row while it is fresh.
 *
 * Identifiers only: run id, harness id, a refusal kind, a count and timestamps.
 */
import Database from 'better-sqlite3'
import { join } from 'node:path'
import type { SpawnRefusalKind } from '../harness/adapter.ts'

export interface StoredWait {
  readonly kind: SpawnRefusalKind
  readonly wakeAt: number
}

export interface StoredCeiling {
  readonly ceiling: number
  /** Epoch ms of the refusal or increase that produced it. */
  readonly observedAt: number
}

interface CeilingRow {
  readonly harness: string
  readonly ceiling: number
  readonly observed_at: number
}

interface WaitRow {
  readonly harness: string
  readonly kind: string
  readonly wake_at: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS capacity_waits (
  run_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  kind TEXT NOT NULL,
  wake_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, harness)
);
CREATE TABLE IF NOT EXISTS capacity_ceilings (
  harness TEXT PRIMARY KEY,
  ceiling INTEGER NOT NULL,
  observed_at INTEGER NOT NULL
);
`

export class CapacityWaitLog {
  readonly #db: Database.Database

  /** `journalRoot` is `Journal.root` — the `.vinta-ai-maestro/` directory. */
  constructor(journalRoot: string) {
    this.#db = new Database(join(journalRoot, 'flow.db'))
    // Matching the journal's pragmas: this is a second connection to the same
    // file, and a wake time that is not fsynced is exactly as lost as an event.
    this.#db.pragma('journal_mode = WAL')
    this.#db.pragma('synchronous = FULL')
    this.#db.pragma('busy_timeout = 5000')
    this.#db.exec(SCHEMA)
  }

  record(runId: string, harness: string, wait: StoredWait): void {
    this.#db
      .prepare(
        'INSERT OR REPLACE INTO capacity_waits (run_id, harness, kind, wake_at) VALUES (?, ?, ?, ?)',
      )
      .run(runId, harness, wait.kind, wait.wakeAt)
  }

  /** Called when the wait elapses. Idempotent. */
  clear(runId: string, harness: string): void {
    this.#db.prepare('DELETE FROM capacity_waits WHERE run_id = ? AND harness = ?').run(runId, harness)
  }

  /** Every wait still recorded for a run, by harness id. The boot path. */
  load(runId: string): Map<string, StoredWait> {
    const rows = this.#db
      .prepare('SELECT harness, kind, wake_at FROM capacity_waits WHERE run_id = ?')
      .all(runId) as WaitRow[]
    return new Map(
      rows.map((row) => [row.harness, { kind: row.kind as SpawnRefusalKind, wakeAt: row.wake_at }]),
    )
  }

  recordCeiling(harness: string, stored: StoredCeiling): void {
    this.#db
      .prepare(
        'INSERT OR REPLACE INTO capacity_ceilings (harness, ceiling, observed_at) VALUES (?, ?, ?)',
      )
      .run(harness, stored.ceiling, stored.observedAt)
  }

  /** Called when the ceiling is back at its configured value. Idempotent. */
  clearCeiling(harness: string): void {
    this.#db.prepare('DELETE FROM capacity_ceilings WHERE harness = ?').run(harness)
  }

  /** Every discovered ceiling, by harness id, regardless of age. */
  loadCeilings(): Map<string, StoredCeiling> {
    const rows = this.#db
      .prepare('SELECT harness, ceiling, observed_at FROM capacity_ceilings')
      .all() as CeilingRow[]
    return new Map(
      rows.map((row) => [row.harness, { ceiling: row.ceiling, observedAt: row.observed_at }]),
    )
  }

  close(): void {
    this.#db.close()
  }
}
