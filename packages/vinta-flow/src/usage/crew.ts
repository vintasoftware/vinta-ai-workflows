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
 * member id, an integer tier and two booleans (§11).
 */
import type { StoredEvent } from '../journal/events.ts'

export interface MemberWork {
  readonly member: string
  readonly tier: number
  /** Node attempts this member took. */
  readonly nodes: number
  /** Of those, the ones the plan had assigned to somebody else. */
  readonly coveredFor: number
}

export interface RunCrew {
  readonly runId: string
  /** One entry per member who took at least one node, cheapest tier first. */
  readonly members: readonly MemberWork[]
  /** Node attempts that went to the member the plan named. */
  readonly asPlanned: number
  /**
   * Node attempts that went to somebody else because the named member was busy.
   *
   * Never a failure on its own — substitution is what keeps a wave from
   * serialising behind one agent. It is the number to read against the plan's
   * cost estimate, because every one of these ran at a tier at or above the one
   * the plan budgeted for.
   */
  readonly substituted: number
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
}

export function collectRunCrew(
  source: CrewSource,
  runId: string,
  declared: readonly string[] = [],
): RunCrew {
  const byMember = new Map<string, { tier: number; nodes: number; coveredFor: number }>()
  let asPlanned = 0
  let substituted = 0

  for (const event of source.crewAssignments(runId)) {
    const claim = read(event)
    // An unreadable row is skipped rather than guessed at. Counting it as
    // planned would hide a substitution, which is the direction that reads as
    // "the plan's estimate held" when it did not.
    if (claim === null) continue

    const entry = byMember.get(claim.member) ?? { tier: claim.tier, nodes: 0, coveredFor: 0 }
    entry.nodes += 1
    if (claim.substitute) {
      entry.coveredFor += 1
      substituted += 1
    } else {
      asPlanned += 1
    }
    byMember.set(claim.member, entry)
  }

  const members = [...byMember.entries()]
    .map(([member, entry]) => ({
      member,
      tier: entry.tier,
      nodes: entry.nodes,
      coveredFor: entry.coveredFor,
    }))
    .sort((a, b) => a.tier - b.tier || a.member.localeCompare(b.member))

  return {
    runId,
    members,
    asPlanned,
    substituted,
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
  return { member, tier, substitute: payload['substitute'] === true }
}
