/**
 * Who actually worked, counted across a run.
 *
 * The plan's roster is a prediction: these members, this many phases each,
 * nobody idle. This is the outcome. They diverge in two directions and both are
 * worth seeing — a member who took fewer phases than the plan gave them was
 * covered for by somebody dearer, and a member who took more was the one doing
 * the covering. A run that came in over budget with every node green looks like
 * nothing at all in tokens alone.
 *
 * A fold over journal rows, pure over them, with the query supplied by the
 * caller — so this module needs no database and its tests need no disk. The
 * same shape as `reuse.ts` next door, for the same reason: a rollup that needed
 * a live run could not answer questions about the run that just ended.
 *
 * Nothing here reads a prompt, a transcript or a vendor's words: a row is a
 * member id, an integer tier, a boolean and a reason token from a closed set
 * (§11).
 */
import type { CrewRole, StoredEvent } from '../journal/events.ts'

export interface MemberWork {
  readonly member: string
  readonly tier: number
  /**
   * Node attempts this member **implemented**.
   *
   * Reviewer claims are not in here, and used to be. `node_crew` is written for
   * both seats — the reviewer's carries `role: 'reviewer'`, the implementer's
   * omits it — and this fold read neither, so every phase a member reviewed was
   * counted as a phase they took. On any run with reviewers that inflated the
   * number this whole module exists to put next to the plan's estimate, in the
   * direction that reads as "we used more of the roster than budgeted".
   */
  readonly nodes: number
  /** Of those, the ones the plan had assigned to somebody else. */
  readonly coveredFor: number
  /**
   * Node attempts this member **reviewed**.
   *
   * Counted apart rather than dropped. A review is real work by a real member
   * and costs real tokens, so discarding it would answer the inflation by
   * making the same rollup silent about half of what the crew did. It is not
   * added to `nodes` because the two are not comparable: the plan's roster
   * assigns implementers to phases, and `asPlanned` / `substituted` measure the
   * outcome against exactly that. A reviewer was never "the member the plan
   * named" for the node it reviewed, so folding the seats together would make
   * the divergence numbers meaningless in the same breath as the count.
   */
  readonly reviews: number
}

export interface RunCrew {
  readonly runId: string
  /**
   * One entry per member who took at least one claim of either seat, cheapest
   * tier first. A member who only ever reviewed appears here with `nodes: 0` —
   * which is also what keeps them out of `idle`, where "declared but never
   * reached" would be a plain lie about somebody who reviewed six phases.
   */
  readonly members: readonly MemberWork[]
  /** Implementer attempts that went to the member the plan named. */
  readonly asPlanned: number
  /**
   * Implementer attempts that went to somebody other than the member the plan
   * named. Reviewer claims are outside this count entirely — see `reviews`.
   *
   * Never a failure on its own — a substitution is either a wave declining to
   * serialise behind one busy agent, or a phase reusing a session that was
   * already open. It is the number to read against the plan's cost estimate,
   * because every one of these ran at a tier at or above the one the plan
   * budgeted for, and `warmReuse` says how many of them were bought
   * deliberately rather than forced.
   */
  readonly substituted: number
  /**
   * Of those, the ones taken to reuse a session that was already open.
   *
   * A subset of `substituted`, not a sibling of it — every warm promotion is
   * still a divergence from the plan's staffing. It is counted apart because
   * the two are answerable in opposite directions. A `peer_busy` substitution
   * is the roster absorbing its own load and costs what was budgeted; a warm
   * one is the scheduler choosing to pay a dearer model to avoid a cold start,
   * a trade that is only worth making while it actually saves one. Folded into
   * one number, a run that promoted every phase to the top tier looks exactly
   * like a busy wave.
   */
  readonly warmReuse: number
  /**
   * Members the roster declared who took nothing here. Empty on a completed
   * run of a validated workflow — `validate.ts` refuses a member assigned no
   * node — so a non-empty list means the run stopped before they were reached.
   */
  readonly idle: readonly string[]
}

/** The journal slice this needs. Structural, so a fake is one method. */
export interface CrewSource {
  crewAssignments(runId: string): readonly StoredEvent[]
}

interface Claim {
  readonly member: string
  readonly tier: number
  readonly substitute: boolean
  /** Why, when the row says. Absent on rows written before it did (§15.6). */
  readonly reason: string | null
  readonly role: CrewRole
}

export function collectRunCrew(
  source: CrewSource,
  runId: string,
  declared: readonly string[] = [],
): RunCrew {
  const byMember = new Map<
    string,
    { tier: number; nodes: number; coveredFor: number; reviews: number }
  >()
  let asPlanned = 0
  let substituted = 0
  let warmReuse = 0

  for (const event of source.crewAssignments(runId)) {
    const claim = read(event)
    // An unreadable row is skipped rather than guessed at. Counting it as
    // planned would hide a substitution, which is the direction that reads as
    // "the plan's estimate held" when it did not.
    if (claim === null) continue

    const entry = byMember.get(claim.member) ?? {
      tier: claim.tier,
      nodes: 0,
      coveredFor: 0,
      reviews: 0,
    }
    // The member is recorded either way — a reviewer-only member has worked and
    // must not fall through to `idle` — but only an implementer claim is a
    // phase *taken*, and only an implementer claim can diverge from the plan's
    // staffing. A reviewer is chosen by `assignReviewer`, not named by the
    // roster against a node, so there is nothing for it to have diverged from.
    if (claim.role === 'reviewer') {
      entry.reviews += 1
    } else {
      entry.nodes += 1
      if (claim.substitute) {
        entry.coveredFor += 1
        substituted += 1
        if (claim.reason === 'warm_session') warmReuse += 1
      } else {
        asPlanned += 1
      }
    }
    byMember.set(claim.member, entry)
  }

  const members = [...byMember.entries()]
    .map(([member, entry]) => ({
      member,
      tier: entry.tier,
      nodes: entry.nodes,
      coveredFor: entry.coveredFor,
      reviews: entry.reviews,
    }))
    .sort((a, b) => a.tier - b.tier || a.member.localeCompare(b.member))

  return {
    runId,
    members,
    asPlanned,
    substituted,
    warmReuse,
    idle: declared.filter((member) => !byMember.has(member)).sort(),
  }
}

/** One row, or null when it is not the shape this fold counts. */
function read(event: StoredEvent): Claim | null {
  const payload = event.payload as Record<string, unknown> | undefined
  if (payload === undefined) return null
  const member = payload['member']
  const tier = payload['tier']
  if (typeof member !== 'string' || member === '') return null
  if (typeof tier !== 'number' || !Number.isFinite(tier)) return null
  const reason = payload['reason']
  return {
    member,
    tier,
    substitute: payload['substitute'] === true,
    reason: typeof reason === 'string' ? reason : null,
    role: seat(payload['role']),
  }
}

/**
 * Which seat a row claims, defaulting the way the payload documents it.
 *
 * Absent means implementer, because reviewers became members after this event
 * did and rows written before that read as what they were. Anything that is not
 * a seat this fold knows also reads as implementer — which is deliberately the
 * *old* behaviour, kept so a row from a newer daemon still counts its member
 * rather than vanishing them into `idle`.
 *
 * `SEATS` is what stops that being a slow leak back into the bug above: a third
 * seat added to `CrewRole` fails this `satisfies`, so the choice of which count
 * it belongs in has to be made here rather than defaulted into `nodes` by a
 * daemon nobody has read.
 */
const SEATS = ['implementer', 'reviewer'] as const satisfies readonly CrewRole[]

function seat(raw: unknown): CrewRole {
  return SEATS.find((known) => known === raw) ?? 'implementer'
}
