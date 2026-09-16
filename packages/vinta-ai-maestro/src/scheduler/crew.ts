/**
 * Who runs a node, and at what tier.
 *
 * A pure function over explicit inputs, for the same reason `sessions.ts` is
 * one: the interesting cases are the ones an end-to-end run reaches rarely and
 * a wrong answer is invisible when it happens. A node dispatched to a member
 * one tier too junior does not fail — it produces plausible code that fails
 * review two rounds later, by which point nothing points back at the staffing
 * decision that caused it.
 *
 * Two rules, and they pull in opposite directions on purpose:
 *
 * - **The assigned member's tier is a floor.** A phase may be taken by someone
 *   more capable than the plan named; never by someone less. This is the half
 *   that survives a busy roster, and it has no exceptions — every branch below
 *   picks out of one list, and that list is filtered on the floor before
 *   anything else is asked about it.
 * - **A free member should not idle while work they could do is queued.** So a
 *   substitution is allowed, and it reaches for the *cheapest* qualified member
 *   rather than the best available one — covering for a peer should not
 *   silently promote a phase to the top tier.
 *
 * **The second rule has one exception, and it is about sessions rather than
 * tiers.** A member who is already *warm* — who holds a session this node would
 * genuinely resume — takes the phase ahead of a cheaper member who would have
 * to start cold, even when they are more senior than the phase needs. A cold
 * start is not free: the new session re-reads the repository, rebuilds the
 * context the warm one already has, and pays for all of it in input tokens
 * before it writes a line. Against that, a dearer model on a cheaper phase is
 * the smaller bill, and it is the one the operator asked to pay.
 *
 * Two things keep that exception from eating the rule it qualifies:
 *
 * - **Warm beats cheap; nothing beats the floor.** `warm` is consulted only
 *   among members already at or above the phase's tier. A warm Tier 1 session
 *   is not a reason to run a Tier 3 phase on it, and never can be — warmth is
 *   read off the same filtered list as everything else.
 * - **Warmth is a fact about a session, not about a member.** It means "this
 *   member's next turn on *this* node would resume", which is `sessions.ts`'s
 *   answer and not an approximation of it. A member promoted on a warmth that
 *   then fails to resume is the worst of both: the senior's price *and* a cold
 *   start. So the caller computes `warm` by asking `planSession` itself, with
 *   this node's lane, harness and ledger — see `Scheduler.#warmCrew`. A member
 *   who has merely run before is not warm.
 *
 * With nobody warm this is exactly what it was: the plan's member, else the
 * cheapest qualified cover. That matters — when nothing is warm we are opening
 * a session either way, and there is no cold start left to save. Paying for a
 * senior then would buy nothing at all, which is why the promotion is spelled
 * as "reuse what is already up" and not as "use the best free member".
 *
 * When neither rule holds — every qualified member busy — the answer is to
 * wait, even though a lane is free. That is the one place this module can cost
 * throughput, and it is deliberate: a lane is a worktree, not a licence to run
 * a Tier 4 phase on a Tier 1 model.
 *
 * **Implementers and reviewers are disjoint sets.** Not "the tier above the
 * author", which was a proxy for independence and leaked in both directions: a
 * phase substituted up to the top tier had nobody above it and fell back to
 * being reviewed at its own, and once members became durable agents rather than
 * borrowed models, "a tier above" stopped saying anything about *who*. Two
 * roles that cannot overlap make an agent reviewing its own diff unrepresentable
 * instead of merely unlikely.
 *
 * Nothing here reads a prompt, a transcript or a vendor's words. Its inputs are
 * identifiers, integers and two sets of member ids (§11) — warmth arrives as a
 * set of ids for that reason as much as for purity: the question "would this
 * session resume" is the scheduler's to answer, and its answer is a boolean per
 * member, never a session or anything a session said.
 */
import type { CrewSubstituteReason } from '../journal/events.ts'
import type { CrewMember } from '../types.ts'

/** One roster member, resolved with the id the workflow filed them under. */
export interface RosterMember extends CrewMember {
  readonly id: string
}

export type CrewDecision =
  /**
   * No roster. The caller falls back to `node.model ?? defaults.model` — which
   * is every workflow written before rosters existed, and stays supported.
   */
  | { readonly kind: 'unstaffed' }
  | {
      readonly kind: 'assigned'
      readonly member: string
      readonly tier: number
      readonly model: string
      readonly harness: string | null
      /** True when this is not the member the plan named. */
      readonly substitute: boolean
      /** Who the plan named, present only on a substitution. */
      readonly insteadOf: string | null
      /** Why somebody else took it. Null exactly when `substitute` is false. */
      readonly reason: CrewSubstituteReason | null
    }
  /**
   * Every member at or above the node's floor is busy. The node stays ready and
   * is retried; it does not fail and does not take a lane.
   */
  | { readonly kind: 'wait'; readonly requiredTier: number }

export interface CrewAssignInput {
  /** `nodes[].crew`, exactly as the document carries it. */
  readonly assigned: string | undefined
  /** The workflow's roster, by id. */
  readonly crew: Readonly<Record<string, CrewMember>>
  /** Members currently holding a node, in either role. */
  readonly busy: ReadonlySet<string>
  /**
   * Members whose next turn **on this node** would resume a session rather than
   * start one — `planSession(...).continuation`, asked of each of them with
   * this node's lane, harness and ledger, not guessed from "has run before".
   *
   * Optional, and absent means empty: a caller that cannot answer the question
   * gets the behaviour this module had before warmth existed, which is the
   * right failure. Over-reporting warmth is the expensive mistake — it buys a
   * senior model and a cold start — so the default is to claim none.
   */
  readonly warm?: ReadonlySet<string>
}

/**
 * Roster order, cheapest first. Ties break on id so the choice is stable across
 * runs — a substitution that picked a different peer each time would make two
 * runs of one plan cost differently for no reason anyone could see.
 */
export function roster(crew: Readonly<Record<string, CrewMember>>): RosterMember[] {
  return Object.entries(crew)
    .map(([id, member]) => ({ ...member, id }))
    .sort((a, b) => a.tier - b.tier || a.id.localeCompare(b.id))
}

/** The members who take phases. */
export function implementers(crew: Readonly<Record<string, CrewMember>>): RosterMember[] {
  return roster(crew).filter((member) => member.role === 'implementer')
}

/** The members who read them. Disjoint from the above, by construction. */
export function reviewers(crew: Readonly<Record<string, CrewMember>>): RosterMember[] {
  return roster(crew).filter((member) => member.role === 'reviewer')
}

/**
 * The members who own a worktree for the run: implementers, and only them.
 *
 * A reviewer works **in the tree it is reviewing** — the implementer's own lane,
 * with that phase's uncommitted changes still in it. That is the point rather
 * than a convenience: review happens before the commit, so findings are fixed
 * in the working tree instead of landing as a follow-up commit on a branch that
 * already recorded the mistake. Giving a reviewer its own checkout would mean
 * reading a committed snapshot, which is strictly less than what is there.
 *
 * The cost is that a reviewer's directory moves between phases, so its session
 * carries only when consecutive reviews happen to land in the same lane —
 * §15.2's `lane_changed` decides that per turn, and there is nothing to
 * configure.
 */
export function laneHolders(crew: Readonly<Record<string, CrewMember>>): RosterMember[] {
  return implementers(crew)
}

/** Shared rather than allocated per call: `assignCrew` runs in a claim loop. */
const EMPTY: ReadonlySet<string> = new Set()

export function assignCrew(input: CrewAssignInput): CrewDecision {
  const members = implementers(input.crew)
  if (roster(input.crew).length === 0) return { kind: 'unstaffed' }

  // A node with no `crew` line in a staffed workflow is a document defect that
  // `validate.ts` refuses before a run starts, as is one naming a reviewer.
  // Reaching either here means the scheduler was handed a workflow that never
  // went through the parser, so treat it as unstaffed rather than inventing a
  // member for it.
  const named = input.assigned === undefined ? undefined : input.crew[input.assigned]
  if (named === undefined || named.role !== 'implementer') return { kind: 'unstaffed' }

  const take = (member: RosterMember, reason: CrewSubstituteReason | null): CrewDecision => ({
    kind: 'assigned',
    member: member.id,
    tier: member.tier,
    model: member.model,
    harness: member.harness ?? null,
    substitute: reason !== null,
    insteadOf: reason === null ? null : (input.assigned as string),
    reason,
  })

  // The floor, applied once, to one list. Every branch below picks out of this
  // and nothing else, which is what makes "never below the phase's tier" a
  // property of the shape rather than of three conditions staying in step.
  // `members` is sorted cheapest-first, so `candidates` is too.
  const candidates = members.filter(
    (member) => member.tier >= named.tier && !input.busy.has(member.id),
  )
  const self = candidates.find((member) => member.id === input.assigned)
  const warm = input.warm ?? EMPTY

  // Warm first, and the plan's own member first among the warm. Without that
  // second half, a roster with two warm peers would hand `mid-b`'s phase to
  // `mid-a` on nothing but alphabetical order and journal it as a
  // substitution — a divergence from the plan bought for no saving at all,
  // since both were warm and neither would have started cold.
  const reuse =
    self !== undefined && warm.has(self.id) ? self : candidates.find((member) => warm.has(member.id))
  if (reuse !== undefined) return take(reuse, reuse.id === input.assigned ? null : 'warm_session')

  // Nobody warm. A session is being opened whatever we decide, so there is no
  // cold start on the table to pay a dearer model for, and the pre-defined
  // level wins: the plan's member, else the cheapest qualified cover.
  if (self !== undefined) return take(self, null)
  const cover = candidates[0]
  if (cover !== undefined) return take(cover, 'peer_busy')

  return { kind: 'wait', requiredTier: named.tier }
}

export type ReviewDecision =
  /** No reviewer on the roster. The caller falls back to the project default. */
  | { readonly kind: 'unstaffed' }
  | {
      readonly kind: 'assigned'
      readonly member: string
      readonly tier: number
      readonly model: string
      readonly harness: string | null
    }
  /** Every qualified reviewer is mid-review. The node waits its turn. */
  | { readonly kind: 'wait'; readonly requiredTier: number }

export interface ReviewAssignInput {
  readonly crew: Readonly<Record<string, CrewMember>>
  /** The tier of the agent that actually wrote this phase — not the plan's. */
  readonly authorTier: number
  /** Who wrote it. A reviewer is never this member; roles make that automatic. */
  readonly author: string
  readonly busy: ReadonlySet<string>
}

/**
 * Which reviewer reads this phase.
 *
 * **Claimed, not borrowed.** The previous design resolved a reviewer *model* a
 * tier above the author and spawned it without holding anything, on the
 * grounds that a review is short and a senior mid-phase should still be able to
 * read a junior's diff. That works for a model and not for an agent: a member
 * has one session ledger, and two reviews running as the same member would
 * either resume one session twice or overwrite each other's entry — so a
 * reviewer is held for its turn and a node whose reviewer is busy waits.
 *
 * Not for a worktree: a reviewer has none, and reads the lane it is reviewing.
 * A plan that finds one reviewer too serialising staffs a second.
 *
 * That wait cannot deadlock. Reviewers never take phases, so a node waiting for
 * one is always waiting on another node's *review* — a turn that is already
 * running and will end — never on a phase that might itself be blocked.
 *
 * The floor is the author's tier: work is not reviewed by someone the plan
 * judged less capable than whoever wrote it. Above that, cheapest first, for
 * the same reason substitution reaches for the cheapest qualified peer.
 */
export function assignReviewer(input: ReviewAssignInput): ReviewDecision {
  const qualified = reviewers(input.crew).filter((member) => member.tier >= input.authorTier)
  if (qualified.length === 0) return { kind: 'unstaffed' }

  const free = qualified.find((member) => !input.busy.has(member.id))
  if (free === undefined) return { kind: 'wait', requiredTier: input.authorTier }

  // Roles are disjoint and validated, so this can only fire on a hand-built
  // workflow. It is checked anyway: it is the one invariant this module exists
  // to guarantee, and an assertion is cheaper than the bug it prevents.
  if (free.id === input.author) {
    throw new Error(`crew member "${free.id}" would review its own phase`)
  }

  return {
    kind: 'assigned',
    member: free.id,
    tier: free.tier,
    model: free.model,
    harness: free.harness ?? null,
  }
}
