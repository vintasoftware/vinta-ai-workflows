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
 *   that survives a busy roster.
 * - **A free member should not idle while work they could do is queued.** So a
 *   substitution is allowed, and it reaches for the *cheapest* qualified member
 *   rather than the best available one — covering for a peer should not
 *   silently promote a phase to the top tier.
 *
 * When neither holds — every qualified member busy — the answer is to wait,
 * even though a lane is free. That is the one place this module can cost
 * throughput, and it is deliberate: a lane is a worktree, not a licence to run
 * a Tier 4 phase on a Tier 1 model.
 *
 * Nothing here reads a prompt, a transcript or a vendor's words. Its inputs are
 * identifiers, integers and a busy set (§11).
 */
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
  /** Members currently holding a node. */
  readonly busy: ReadonlySet<string>
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

export function assignCrew(input: CrewAssignInput): CrewDecision {
  const members = roster(input.crew)
  if (members.length === 0) return { kind: 'unstaffed' }

  // A node with no `crew` line in a staffed workflow is a document defect that
  // `validate.ts` refuses before a run starts. Reaching it here means the
  // scheduler was handed a workflow that never went through the parser, so
  // treat it as unstaffed rather than inventing a member for it.
  const named = input.assigned === undefined ? undefined : input.crew[input.assigned]
  if (named === undefined) return { kind: 'unstaffed' }

  const take = (member: RosterMember, substitute: boolean): CrewDecision => ({
    kind: 'assigned',
    member: member.id,
    tier: member.tier,
    model: member.model,
    harness: member.harness ?? null,
    substitute,
    insteadOf: substitute ? (input.assigned as string) : null,
  })

  if (!input.busy.has(input.assigned as string)) {
    const self = members.find((member) => member.id === input.assigned)
    if (self !== undefined) return take(self, false)
  }

  // Cheapest free member at or above the floor. `members` is already sorted, so
  // the first match is the cheapest one.
  const cover = members.find((member) => member.tier >= named.tier && !input.busy.has(member.id))
  if (cover !== undefined) return take(cover, true)

  return { kind: 'wait', requiredTier: named.tier }
}

/**
 * The model a review of `authorTier` work runs on.
 *
 * A team has seniors read juniors' work, and that is the half of "staff the
 * plan" that a per-node model could never express: today every role on a node
 * runs on the node's one model, so a Tier 1 phase is reviewed by a Tier 1
 * agent — the cheapest model on the plan checking the cheapest model's work.
 *
 * The reviewer **borrows a tier, not a person**. It does not claim the member
 * and does not wait for them: a senior who is mid-phase can still have their
 * model read a junior's diff, and making review consume a roster slot would
 * deadlock a plan whose only senior is busy on the phase being reviewed.
 *
 * Null means nobody on this roster is above the author — a single-tier team, or
 * a Tier 4 phase — and the caller keeps today's behaviour of reviewing at the
 * node's own model.
 */
export function reviewerModel(
  crew: Readonly<Record<string, CrewMember>>,
  authorTier: number,
): { readonly member: string; readonly model: string; readonly tier: number } | null {
  const senior = roster(crew).find((member) => member.tier > authorTier)
  return senior === undefined ? null : { member: senior.id, model: senior.model, tier: senior.tier }
}
