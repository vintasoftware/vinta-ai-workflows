/**
 * §15's session-reuse decision: which session a spawn continues, if any.
 *
 * A pure function over explicit inputs, deliberately, rather than a private
 * method reading the scheduler's fields. The rule set in §15.2 is a list of
 * ways reuse becomes *wrong* — a session resumed into the wrong worktree, onto
 * the wrong vendor, or past the point its context still fits — and a list of
 * conditions is exactly the thing that has to be checked case by case rather
 * than through whichever handful of them an end-to-end run happens to reach.
 * Some of them the shipped host makes unreachable by construction — it clears a
 * node's whole ledger before re-attempting, which is the only way to catch a
 * lane that was recycled under an unchanged name. Those rules stay anyway, and
 * are tested here: the host that has to remember to clear is the fragile half,
 * and a decision function that cannot express the mistake is what keeps a
 * future host from having to remember.
 *
 * Nothing here touches a prompt, a transcript or a vendor's words. Its inputs
 * are identifiers, counters and booleans, and its output is a plan plus a
 * reason token from a closed set (§11).
 */
import type { SessionFreshReason } from '../journal/events.ts'

/**
 * One slot's session, as the ledger holds it.
 *
 * The harness and the lane are stored *with* the id rather than assumed,
 * because both can change under a node between one turn and the next and
 * neither change is visible from the id itself.
 */
export interface SessionEntry {
  readonly harnessId: string
  readonly sessionId: string
  /** The lane the session ran in. A session is about a worktree. */
  readonly lane: string
  /** Turns taken on this slot, against `defaults.max_session_turns`. */
  readonly turns: number
}

/**
 * What one spawn decided. Taken before the task is built, because the prompt
 * depends on it: a continuation gets a delta and a fresh session gets the whole
 * brief (§15.3).
 */
export interface SessionPlan {
  /** The slot to record under, or null when the effect named none. */
  readonly slot: string | null
  /** The id to continue, or null to start cold. */
  readonly resumeSessionId: string | null
  readonly continuation: boolean
  /** Why this is not a continuation. Null exactly when `continuation` is true. */
  readonly reason: SessionFreshReason | null
  /** What the slot's turn count becomes if this spawn is granted. */
  readonly turns: number
}

export interface SessionPlanInput {
  /** `spawn_agent`'s `session` param, exactly as the pipeline wrote it. */
  readonly declaredSlot: unknown
  /** `spawn_agent`'s `role` param, likewise unvalidated. */
  readonly role: unknown
  /** The adapter's `capabilities.resume`. */
  readonly canResume: boolean
  readonly harnessId: string
  /** The lane this turn runs in. Null only in a projection with no worktrees. */
  readonly lane: string | null
  readonly ledger: ReadonlyMap<string, SessionEntry>
  /** `defaults.max_session_turns`. */
  readonly maxTurns: number
  /** Fixers that have already *finished* on this node. */
  readonly fixRounds: number
  readonly maxFixRounds: number
  /**
   * §9's takeover handoff, for a pipeline that named no slot: an operator drove
   * this node by hand and detached, leaving the id their terminal held.
   */
  readonly takeoverSessionId: string | null
}

export function planSession(input: SessionPlanInput): SessionPlan {
  const slot =
    typeof input.declaredSlot === 'string' && input.declaredSlot.length > 0
      ? input.declaredSlot
      : null

  const fresh = (reason: SessionFreshReason): SessionPlan => ({
    slot,
    resumeSessionId: null,
    continuation: false,
    reason,
    turns: 1,
  })

  if (slot === null) {
    // No slot, so the ledger is not in play. The one id that can still be
    // waiting is §9's: an operator took this node over and detached, and their
    // session is the only place that work exists. It is a continuation for the
    // same reason a slot's is — that session has the brief, and has since been
    // driven by hand on top of it.
    if (input.takeoverSessionId !== null && input.canResume) {
      return {
        slot: null,
        resumeSessionId: input.takeoverSessionId,
        continuation: true,
        reason: null,
        // A takeover spends no slot budget: the operator continued the turn
        // that was already running rather than buying a new one.
        turns: 0,
      }
    }
    return fresh('no_slot')
  }

  // Ordered so the reasons that do not depend on the ledger come first. Both
  // are true whatever the ledger holds, and checking them first keeps the
  // reason token *accurate* rather than merely true: a node whose slot is empty
  // and whose harness cannot resume should report the capability, because that
  // is the one that will still be true on the next turn.
  if (!input.canResume) return fresh('no_resume_capability')
  if (isLastFixRound(input)) return fresh('final_fix_round')

  const entry = input.ledger.get(slot)
  if (entry === undefined) return fresh('no_prior_session')
  if (entry.harnessId !== input.harnessId) return fresh('harness_changed')
  // The scheduler clears the whole ledger when a node re-attempts, because a
  // recycled lane is invisible from its name — so in the shipped host this is
  // the second line of defence rather than the first. It stays because it is
  // the one that states the invariant: an entry is about a worktree, and a
  // session resumed into a different one reasons about paths and file states
  // that are not there. A host that forgets to clear is wrong; a host that
  // cannot express the mistake is better.
  if (input.lane === null || entry.lane !== input.lane) return fresh('lane_changed')
  if (entry.turns >= input.maxTurns) return fresh('turn_ceiling')

  return {
    slot,
    resumeSessionId: entry.sessionId,
    continuation: true,
    reason: null,
    turns: entry.turns + 1,
  }
}

/**
 * Whether this fixer is the last one the node is allowed (§15.5), in which case
 * it gets a session that has never seen the work.
 *
 * `fixRounds` counts fixers that have *finished*, so the turn about to be
 * spawned is number `fixRounds + 1`. The `>= 1` is the load-bearing half:
 * escalation means "the author already tried and failed", so a node whose
 * budget is a single round keeps that round on the implementer's session rather
 * than never reusing on the fix path at all.
 */
function isLastFixRound(input: SessionPlanInput): boolean {
  if (input.role !== 'fixer') return false
  return input.fixRounds >= 1 && input.fixRounds + 1 >= input.maxFixRounds
}
