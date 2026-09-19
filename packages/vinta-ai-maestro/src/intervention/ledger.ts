/**
 * What the run has already done to itself, and what that leaves it allowed to
 * do next.
 *
 * An autonomous editor with a timer oscillates unless something stops it. The
 * failure is not dramatic and is worse for it: the monitor raises a gate's
 * timeout, the gate still fails, an hour later it raises it again, and the run
 * spends the afternoon converging on nothing while every individual decision
 * reads as reasonable. Nobody is watching — that is the premise of the feature
 * — so nobody notices until the bill.
 *
 * Three rules, all folded out of `workflow_amended` rows that already exist.
 * Nothing here has its own durable state, which matters for the same reason it
 * matters everywhere else in this package: a budget kept in memory is a budget
 * a daemon restart refunds, and the restart is exactly when a thrashing run is
 * most likely to be picked back up.
 *
 * - **A budget.** A run gets `DEFAULT_BUDGET` autonomous amendments. Not per
 *   hour — per run, because the thing being bounded is how far a run may drift
 *   from the plan a person approved, and a long run should not be allowed to
 *   drift further than a short one merely by lasting.
 * - **A cooldown per target.** One gate, one phase, one change. A second
 *   opinion about the same gate is the oscillation, not a refinement: the
 *   monitor cannot see whether its last change helped, because the evidence it
 *   would need is a comparison across a boundary it has no memory of.
 * - **No self-reversal.** Implied by the cooldown and stated separately
 *   because it is the rule that would survive a decision to relax the other
 *   two. A monitor undoing its own amendment is a monitor with no ground to
 *   stand on.
 *
 * The three are deliberately blunt. A cleverer policy — decay, per-verb
 * budgets, reinstatement once a gate has been green for a while — needs
 * evidence about how this behaves in real runs, and there is none yet. The
 * cost of being too strict is an intervention that does not happen and a run
 * that costs what it would have cost anyway; the cost of being too loose is a
 * run editing itself in a loop with nobody in the room.
 */
import type { Journal } from '../journal/journal.ts'
import type { InterventionVerb } from './intervention.ts'

/**
 * Autonomous amendments one run may make.
 *
 * Three, which is a judgement and not a measurement. It is enough for the
 * shape this exists for — a mis-tuned gate, a fix budget that is too tight, a
 * phase staffed too junior — and few enough that a run which has spent it is a
 * run somebody should look at rather than one that should keep going.
 */
export const DEFAULT_BUDGET = 3

/** What a verb is *about*: the thing the cooldown is keyed on. */
export function targetOf(verb: InterventionVerb): string {
  switch (verb.verb) {
    case 'retune_gate':
    case 'retime_gate':
      return `gate:${verb.gate}`
    case 'rebudget_fixes':
    case 'retier_phase':
      return `node:${verb.node}`
  }
}

export interface Ledger {
  /** Autonomous amendments already made to this run. */
  readonly spent: number
  /** Autonomous amendments still available. */
  readonly remaining: number
  /** Targets the monitor has already changed — `gate:unit`, `node:p3`. */
  readonly touched: ReadonlySet<string>
}

/** Folds the run's own history. Rows with no `author` are an operator's (§9). */
export function readLedger(journal: Journal, runId: string, budget = DEFAULT_BUDGET): Ledger {
  let spent = 0
  const touched = new Set<string>()

  for (const event of journal.events(runId)) {
    if (event.type !== 'workflow_amended') continue
    const payload = event.payload as { author?: string; targets?: readonly string[] }
    if (payload.author !== 'monitor') continue
    spent += 1
    for (const target of payload.targets ?? []) touched.add(target)
  }

  return { spent, remaining: Math.max(0, budget - spent), touched }
}

/** Why a proposed verb may not be applied right now. */
export type LedgerRefusalCode = 'budget_spent' | 'target_already_changed'

export interface LedgerVerdict {
  /** Verbs this run may still apply, in the order proposed. */
  readonly allowed: readonly InterventionVerb[]
  /** Verbs held back, each with the reason, for the record. */
  readonly held: readonly { readonly verb: InterventionVerb; readonly code: LedgerRefusalCode }[]
}

/**
 * Filters a proposal against the ledger.
 *
 * The budget is spent per *amendment*, not per verb — a proposal of three
 * changes is one decision and lands as one `workflow_amended` row — so the
 * budget question is asked once, before the verbs, rather than counted down
 * inside the loop.
 */
export function admit(ledger: Ledger, verbs: readonly InterventionVerb[]): LedgerVerdict {
  if (ledger.remaining <= 0) {
    return { allowed: [], held: verbs.map((verb) => ({ verb, code: 'budget_spent' as const })) }
  }

  const allowed: InterventionVerb[] = []
  const held: { verb: InterventionVerb; code: LedgerRefusalCode }[] = []
  // Seeded from history and added to as we go, so two verbs in *one* proposal
  // that both target the same gate do not both land — the second is the same
  // oscillation as a second proposal would be, an hour earlier.
  const seen = new Set(ledger.touched)

  for (const verb of verbs) {
    const target = targetOf(verb)
    if (seen.has(target)) {
      held.push({ verb, code: 'target_already_changed' })
      continue
    }
    seen.add(target)
    allowed.push(verb)
  }

  return { allowed, held }
}
