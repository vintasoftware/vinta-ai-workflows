/**
 * Gate result caching (§13.4). A gate result is keyed on
 * `(gate id, git tree hash of the lane)`.
 *
 * Fix loops re-run the same suite against an unchanged tree constantly: a
 * review round that changes nothing, a retry after a merge that was a no-op, a
 * node re-entering the gate after a human said "go ahead". The test suite is by
 * construction the most expensive resource in the system, so a hit here is a
 * direct release of the pressure §6's queue exists to manage.
 *
 * Which is why the lookup happens *before* `runGate`, not inside it. `runGate`
 * acquires the gate's pools as its first act; calling it and discarding the
 * answer would still have queued behind `test-suite`. Skipping the queue is
 * most of the value, so this module wraps the runner rather than living in it —
 * and the runner stays a thing that runs gates.
 *
 * ## What the tree hash captures
 *
 * `git add -A` into a *temporary* index (`GIT_INDEX_FILE`), then `git
 * write-tree`. The temp index is the whole reason this is safe: it never
 * touches the lane's real index, so an agent's staged work is undisturbed.
 *
 * It was chosen over the two alternatives because of what they miss:
 *
 * - `git stash create` builds a commit from tracked changes only. A gate that
 *   reads a fixture the agent just created — untracked — would get a stale hit.
 * - Hashing `git status --porcelain` plus `HEAD` records *that* a file changed,
 *   never *how*. Two different edits to one file produce the same ` M path`
 *   line, so a fix that changed the code would hit the pre-fix result. That is
 *   not a weaker key, it is a wrong one.
 *
 * `git add -A` hashes content, so it captures: every tracked file's contents,
 * the executable bit, additions, deletions, renames, and **untracked files**
 * that git would add. Any of those changing changes the tree hash.
 *
 * It deliberately does not capture:
 *
 * - **Ignored files.** `.gitignore` is respected, so `node_modules/`, build
 *   output and `.env` are invisible. This is the right default — those are
 *   derived or secret, and hashing `node_modules/` would cost more than the
 *   gate — but it means a gate whose result depends on an ignored file (an
 *   uninstalled dependency, a changed `.env`) can hit staleley. `--no-cache` is
 *   the escape hatch.
 * - **Submodule contents.** A submodule is recorded as its HEAD gitlink;
 *   uncommitted work inside one does not move the hash.
 * - **Everything outside the worktree**: environment, database state, the
 *   clock. The key is the tree, per §13.4, so a gate that is a pure function of
 *   its tree caches correctly and one that is not can be told not to.
 *
 * Gate *output* is repository content and never leaves the log file; the rows
 * here carry gate ids, a tree hash and an exit code only.
 */
import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGate } from './runner.ts'
import type { GateResult, GateStatus, RunGateOptions } from './runner.ts'

/**
 * A `GateResult` plus the one bit the UI and the journal need to tell "passed"
 * from "passed earlier". On a hit `durationMs` and `logPath` are the original
 * run's: the log lives where the gate that produced it wrote it, and the
 * duration is what the cache just saved.
 */
export type CachedGateResult = GateResult & { readonly cached: boolean }

interface CacheRow {
  readonly status: GateStatus
  readonly exit_code: number | null
  readonly duration_ms: number
  readonly log_path: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gate_results (
  gate_id TEXT NOT NULL,
  tree_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  duration_ms INTEGER NOT NULL,
  log_path TEXT NOT NULL,
  cached_at INTEGER NOT NULL,
  PRIMARY KEY (gate_id, tree_hash)
);
`

/**
 * SQLite beside the journal's store, so a daemon restart keeps the hits — the
 * fix loop that benefits most is exactly the one a restart interrupts.
 *
 * The pragmas match `Journal`'s deliberately: one directory, one set of
 * durability rules to reason about. `synchronous = FULL` is stricter than a
 * cache needs (a lost row costs one re-run, not correctness), and it is cheap
 * here regardless — writes happen once per gate, not once per event.
 */
export class GateCache {
  private readonly db: Database.Database

  constructor(projectDir: string) {
    const root = join(projectDir, '.vinta-ai-maestro')
    mkdirSync(root, { recursive: true })
    this.db = new Database(join(root, 'gate-cache.db'))
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = FULL')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(SCHEMA)
  }

  lookup(gateId: string, treeHash: string): GateResult | undefined {
    const row = this.db
      .prepare('SELECT * FROM gate_results WHERE gate_id = ? AND tree_hash = ?')
      .get(gateId, treeHash) as CacheRow | undefined
    if (row === undefined) return undefined
    return {
      gateId,
      status: row.status,
      exitCode: row.exit_code,
      durationMs: row.duration_ms,
      logPath: row.log_path,
    }
  }

  /**
   * A `timed_out` result is never stored. A timeout says the gate did not
   * finish, not that the tree is bad — caching it would turn one transient hang
   * into a permanent verdict on that tree, and the retry that would have proved
   * it transient never runs.
   */
  store(treeHash: string, result: GateResult): void {
    if (result.status === 'timed_out') return
    this.db
      .prepare(
        'INSERT OR REPLACE INTO gate_results' +
          ' (gate_id, tree_hash, status, exit_code, duration_ms, log_path, cached_at)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        result.gateId,
        treeHash,
        result.status,
        result.exitCode,
        result.durationMs,
        result.logPath,
        Date.now(),
      )
  }

  close(): void {
    this.db.close()
  }
}

export interface RunGateCachedOptions extends RunGateOptions {
  readonly cache: GateCache
  /** `--no-cache`: run the gate anyway, and refresh the entry with the result. */
  readonly noCache?: boolean
}

/**
 * `runGate` with the cache in front of it. Composes rather than modifies: the
 * options are a superset, so the miss path hands them straight through.
 */
export async function runGateCached(options: RunGateCachedOptions): Promise<CachedGateResult> {
  const treeHash = laneTreeHash(options.cwd)

  if (options.noCache !== true) {
    const hit = options.cache.lookup(options.gateId, treeHash)
    // Returning here is what keeps the gate's pools untouched: `runGate` is the
    // only thing that acquires them, and it is never called.
    if (hit !== undefined) return { ...hit, cached: true }
  }

  const result = await runGate(options)
  options.cache.store(treeHash, result)
  return { ...result, cached: false }
}

/**
 * The tree hash of `cwd`'s working tree, uncommitted work included. See the
 * module comment for what that does and does not reach.
 *
 * The temp index is thrown away; the blobs `add` wrote stay in the object
 * store, where they are unreferenced loose objects that `git gc` collects like
 * any other. That is the price of hashing content rather than status lines.
 */
export function laneTreeHash(cwd: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-tree-'))
  const indexFile = join(dir, 'index')
  try {
    // A fresh empty index plus `-A` means "whatever the worktree holds now",
    // with no dependence on HEAD — so this works in a repo without a commit.
    git(['add', '-A'], cwd, indexFile)
    return git(['write-tree'], cwd, indexFile)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function git(args: readonly string[], cwd: string, indexFile: string): string {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_INDEX_FILE: indexFile },
    encoding: 'utf8',
  }).trim()
}
