/**
 * When a gate in the integration worktree has to start from fresh state.
 *
 * The integration worktree is one directory that every merge in a run passes
 * through, one tree after another — `integ-p10`, then `wave-2`, then `integ-p6`.
 * Its gates run with the worktree's one environment, so they share its test
 * databases too, and a test runner that keeps its database between runs
 * (`pytest --reuse-db`, any "keep the schema" flag) applies the migrations a
 * tree adds and never takes away the ones it lacks. One observed run had three
 * merges fail that way in both directions — NOT NULL on a column another
 * branch added, `relation … does not exist` for a table another branch
 * dropped — each one two fixer rounds and a fifteen-minute verify spent on a
 * database left behind by the previous tree. The fixers said so, and nothing
 * acted on it.
 *
 * A gate may declare `fresh_cmd`: the same check, run from fresh state (the
 * test database recreated, typically `--create-db`). It runs in place of
 * `cmd`, in the integration worktree only, whenever the state the gate left
 * behind may not belong to this tree:
 *
 * - **The tree moved anywhere but forward.** The last commit this gate ran on
 *   here is not an ancestor of `HEAD`. Forward is safe — a reused database
 *   applies the new migrations — and every other move is the case above.
 * - **It has not run here in this process.** What a previous process, or an
 *   operator's `exec`, left in the database is unknown.
 * - **Its red output reads as a stale schema** (`STALE_SCHEMA`): missing or
 *   extra columns and relations. Run once more from fresh state before the red
 *   is believed, so no fix round is charged for the database's mistake.
 * - **A fixer said so** (`ENVIRONMENT_STALE`), handled by the integrator.
 * - **Its last run was killed** (`interrupted`): a suite stopped mid-way can
 *   leave a database half-migrated — one observed worker database had 71 of
 *   134 migrations after a timeout — and a run reusing it fails on columns
 *   that are simply not there yet.
 *
 * `fresh_cmd` checks at least what `cmd` does, so running it never weakens a
 * gate; a gate without one runs `cmd` everywhere, as before.
 */
import { readFile } from 'node:fs/promises'

import { gitOk, git } from './git.ts'
import type { CommandGate } from '../types.ts'

export type FreshReason = 'tree_moved' | 'first_run' | 'stale_schema' | 'fixer_reported' | 'interrupted'

/**
 * Errors a database left by another tree produces, across the usual drivers:
 * Postgres (`relation "x" does not exist`, `column "x" … does not exist`,
 * psycopg's `UndefinedColumn` / `UndefinedTable`, a NOT NULL on a column the
 * tree never defines), SQLite (`no such table`, `no such column`) and MySQL
 * (`Unknown column`, `Table '…' doesn't exist`).
 */
export const STALE_SCHEMA: readonly RegExp[] = [
  /relation "[^"]+" does not exist/i,
  /column "?[\w.]+"? (of relation "[^"]+" )?does not exist/i,
  /\bUndefined(Column|Table)\b/,
  /null value in column "[^"]+"( of relation "[^"]+")? violates not-null constraint/i,
  /no such (table|column)/i,
  /Unknown column '[^']+'/i,
  /Table '[^']+' doesn't exist/i,
]

/** Whether a gate log reads as a stale schema. Only its tail: a suite can be long. */
export async function looksStale(logPath: string): Promise<boolean> {
  try {
    const text = await readFile(logPath, 'utf8')
    const tail = text.length > 200_000 ? text.slice(-200_000) : text
    return STALE_SCHEMA.some((pattern) => pattern.test(tail))
  } catch {
    return false
  }
}

export interface FreshDecision {
  /** The gate to run: `cmd` swapped for `fresh_cmd` when `reason` is set. */
  readonly gate: CommandGate
  readonly reason: FreshReason | null
  /** The commit checked out, which the gate's state belongs to once it has run. */
  readonly head: string
}

/** What `run` needs back from a gate: whether it passed, where it logged, and whether it ran at all. */
export interface FreshRun {
  readonly status: string
  readonly logPath: string
  /** A cached verdict touched no state, so the state still belongs to the tree before. */
  readonly cached?: boolean
}

/** One run's view of the integration worktree's gate state, shared by every caller that gates there. */
export class IntegrationFreshness {
  readonly #last = new Map<string, string>()
  /** Gates whose last run here was killed, so their state is unknown whatever the tree. */
  readonly #interrupted = new Set<string>()
  readonly #onFresh: ((gateId: string, reason: FreshReason) => void) | undefined

  constructor(options: { readonly onFresh?: (gateId: string, reason: FreshReason) => void } = {}) {
    this.#onFresh = options.onFresh
  }

  /**
   * Which command `gateId` runs on the tree checked out in `cwd`. `force` asks
   * for fresh state whatever the history says.
   */
  async decide(gateId: string, gate: CommandGate, cwd: string, force?: FreshReason): Promise<FreshDecision> {
    const head = (await git(cwd, ['rev-parse', 'HEAD']).catch(() => '')).trim()
    if (gate.fresh_cmd === undefined) return { gate, reason: null, head }
    const last = this.#last.get(gateId)
    let reason: FreshReason | null = force ?? null
    if (reason === null && this.#interrupted.has(gateId)) reason = 'interrupted'
    if (reason === null && (head === '' || last === undefined)) reason = 'first_run'
    if (reason === null && last !== undefined && last !== head) {
      if (!(await gitOk(cwd, ['merge-base', '--is-ancestor', last, head]))) reason = 'tree_moved'
    }
    if (reason === null) return { gate, reason: null, head }
    return { gate: { ...gate, cmd: gate.fresh_cmd }, reason, head }
  }

  /**
   * Runs `gateId` in the integration worktree through `execute`, from fresh
   * state when `decide` says so, and once more from fresh state when a red
   * result reads as a stale schema. The second answer is the gate's.
   */
  async run<R extends FreshRun>(
    gateId: string,
    gate: CommandGate,
    cwd: string,
    execute: (gate: CommandGate) => Promise<R>,
    force?: FreshReason,
  ): Promise<R> {
    const first = await this.#execute(gateId, gate, cwd, execute, force)
    if (first.result.status === 'passed' || first.reason !== null || gate.fresh_cmd === undefined) {
      return first.result
    }
    if (!(await looksStale(first.result.logPath))) return first.result
    return (await this.#execute(gateId, gate, cwd, execute, 'stale_schema')).result
  }

  async #execute<R extends FreshRun>(
    gateId: string,
    gate: CommandGate,
    cwd: string,
    execute: (gate: CommandGate) => Promise<R>,
    force: FreshReason | undefined,
  ): Promise<{ result: R; reason: FreshReason | null }> {
    const decision = await this.decide(gateId, gate, cwd, force)
    if (decision.reason !== null) this.#onFresh?.(gateId, decision.reason)
    const result = await execute(decision.gate)
    if (result.cached === true) return { result, reason: decision.reason }
    if (result.status === 'timed_out') {
      this.#interrupted.add(gateId)
      this.#last.delete(gateId)
    } else {
      this.#interrupted.delete(gateId)
      if (decision.head !== '') this.#last.set(gateId, decision.head)
    }
    return { result, reason: decision.reason }
  }
}
