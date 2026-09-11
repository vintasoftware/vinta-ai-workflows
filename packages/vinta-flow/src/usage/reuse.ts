/**
 * Session reuse, counted across a run (§15.6).
 *
 * `usage.ts` folds what the *harnesses* reported; this folds what the
 * *scheduler decided*. They answer the two halves of one question and neither
 * can answer it alone: the cache figures say what the prompts cost, and these
 * counts say how often the machinery that was supposed to make them cheap
 * actually engaged. A run with a dismal hit rate and a run whose reuse quietly
 * stopped look identical in tokens alone, and only one of them is a bug.
 *
 * A fold over journal rows, like everything else in this file's neighbourhood,
 * and pure over them: the rows come in, the counts come out. The query is the
 * journal's (`sessionDecisions`), so this module needs no database and its
 * tests need no disk.
 *
 * **The reason tally is open, not a fixed set of fields.** The journal's reason
 * vocabulary is closed *today*, and a counter with one field per token would
 * silently drop a token added later — the exact failure this rollup exists to
 * surface. A record keyed by whatever arrived cannot lose one.
 *
 * Nothing here reads a prompt, a transcript or a vendor's words: a row is a
 * slot name, a disposition and a reason token (§11).
 */
import type { StoredEvent } from '../journal/events.ts'

export interface ReuseTotals {
  /** Agent turns that recorded a decision. Turns on a slotless pipeline record none. */
  readonly turns: number
  /** Turns that continued a session. */
  readonly reused: number
  /**
   * Cold turns by reason token, descending by count then by token so the order
   * is stable for a caller that renders it.
   *
   * `turns - reused` is the total; this says why. Most of it is normally
   * `no_prior_session`, which is not a degradation — a slot's first turn has
   * nothing to continue, and every node has at least one.
   */
  readonly fresh: readonly ReuseReasonCount[]
}

export interface ReuseReasonCount {
  readonly reason: string
  readonly count: number
}

export interface NodeReuse {
  readonly nodeId: string
  readonly totals: ReuseTotals
}

export interface RunReuse {
  readonly runId: string
  readonly totals: ReuseTotals
  /** One entry per node that recorded at least one decision, in first-seen order. */
  readonly nodes: readonly NodeReuse[]
}

/** The journal slice this needs. Structural, so a fake is one method. */
export interface ReuseSource {
  sessionDecisions(runId: string): readonly StoredEvent[]
}

export function collectRunReuse(source: ReuseSource, runId: string): RunReuse {
  const run = newTally()
  const byNode = new Map<string, Tally>()

  for (const event of source.sessionDecisions(runId)) {
    const decision = read(event)
    // A row that does not parse is skipped rather than counted as cold. These
    // come back off disk, and inventing a fresh turn out of an unreadable row
    // would understate reuse — which is the direction that reads as a bug.
    if (decision === null) continue

    const node = byNode.get(decision.nodeId) ?? newTally()
    byNode.set(decision.nodeId, node)
    for (const tally of [run, node]) count(tally, decision.reused, decision.reason)
  }

  return {
    runId,
    totals: seal(run),
    nodes: [...byNode.entries()].map(([nodeId, tally]) => ({ nodeId, totals: seal(tally) })),
  }
}

/** Adds independent tallies — e.g. one wave's nodes, or a hand-picked set. */
export function sumReuse(totals: readonly ReuseTotals[]): ReuseTotals {
  const tally = newTally()
  for (const one of totals) {
    tally.turns += one.turns
    tally.reused += one.reused
    for (const entry of one.fresh) {
      tally.fresh.set(entry.reason, (tally.fresh.get(entry.reason) ?? 0) + entry.count)
    }
  }
  return seal(tally)
}

/**
 * The share of turns that continued a session, or `undefined` when no turn
 * recorded a decision.
 *
 * Undefined rather than 0, for `cacheReadShare`'s reason (§15.6): a run whose
 * pipeline names no slots reused nothing because it asked for nothing, and
 * reporting that as 0% would read as a feature that broke. The two cases are
 * only distinguishable here, so they must not be flattened here.
 */
export function reuseShare(totals: ReuseTotals): number | undefined {
  return totals.turns === 0 ? undefined : totals.reused / totals.turns
}

interface Tally {
  turns: number
  reused: number
  readonly fresh: Map<string, number>
}

const newTally = (): Tally => ({ turns: 0, reused: 0, fresh: new Map() })

function count(tally: Tally, reused: boolean, reason: string | null): void {
  tally.turns += 1
  if (reused) {
    tally.reused += 1
    return
  }
  // A cold row with no reason is still a cold turn. It cannot happen through
  // the scheduler, which always states one, but the count must not depend on
  // that: a missing reason should cost the tally its explanation, not its turn.
  const key = reason ?? 'unstated'
  tally.fresh.set(key, (tally.fresh.get(key) ?? 0) + 1)
}

function seal(tally: Tally): ReuseTotals {
  return {
    turns: tally.turns,
    reused: tally.reused,
    fresh: [...tally.fresh.entries()]
      .map(([reason, count_]) => ({ reason, count: count_ }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
  }
}

interface Decision {
  readonly nodeId: string
  readonly reused: boolean
  readonly reason: string | null
}

/** One journal row, narrowed. Structural rather than schema-parsed: the fields
 * are three strings and the caller has already selected the row's type. */
function read(event: StoredEvent): Decision | null {
  if (event.type !== 'node_session') return null
  const nodeId = event.nodeId
  const payload: unknown = event.payload
  if (typeof nodeId !== 'string' || payload === null || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  const disposition = record['disposition']
  if (disposition !== 'reused' && disposition !== 'fresh') return null
  const reason = record['reason']
  return {
    nodeId,
    reused: disposition === 'reused',
    reason: typeof reason === 'string' ? reason : null,
  }
}
