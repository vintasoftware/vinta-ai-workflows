/**
 * Who fixes a merge conflict.
 *
 * The conflict fixer used to be staffed from `defaults`, which meant the
 * hardest merge in a run went to the least contextualised agent available: two
 * Tier 4 phases collide over a file neither half of the default-tier model has
 * ever read, and it resolves them by guessing which side looks more finished.
 * A roster exists precisely to say that work of that difficulty is not handed
 * to that model, and integration was the one place the roster was ignored.
 *
 * So the fixer is the **highest-tier crew member who implemented one of the
 * conflicting nodes**. `Integrator.#owners()` already answers "who worked on
 * the code in conflict" — the incoming node plus every already-merged node
 * that touched a contested path — and `node_crew` already records who took
 * each of those. This is the join, and nothing more.
 *
 * **Capability, not session.** The member is carried as a tier, a model and a
 * harness; their session is deliberately left where it is. A phase's session
 * ran in that phase's lane, and §15.2 makes `lane_changed` the *first* ledger
 * rule for a reason: the one thing a resumed session is reliably wrong about is
 * the contents of files that moved while it was away. The fixer runs in the
 * integration worktree — a different tree, holding a half-merged version of
 * exactly the files under dispute — so resuming there would hand the agent
 * confident, false memories of the very files it is merging. A fresh session on
 * a capable model reads the tree; a resumed one recalls a tree that no longer
 * exists.
 *
 * A fold over journal rows plus the roster, pure over both, in the same shape
 * as `usage/crew.ts`: identifiers, an integer tier and a model name. Nothing
 * here reads a prompt, a transcript or a vendor's words (§11).
 */
import type { HarnessAdapter } from '../harness/adapter.ts'
import type { StoredEvent } from '../journal/events.ts'
import type { TranscriptEntry } from '../journal/transcript.ts'
import type { CrewMember } from '../types.ts'
import { createAgentConflictFixer, type ConflictFixer, type ConflictRequest } from './fixer.ts'

/** The member a conflict is handed to, resolved from the roster. */
export interface FixerStaffing {
  readonly member: string
  readonly tier: number
  readonly model: string
  /** `null` means the member did not override `defaults.harness`. */
  readonly harness: string | null
  /** Which of the conflicting nodes this member implemented. Never empty. */
  readonly implemented: readonly string[]
}

/** The journal slice this needs. Structural, so a fake is one method. */
export interface CrewSource {
  crewAssignments(runId: string): readonly StoredEvent[]
}

/**
 * The highest-tier member who implemented one of `nodes`, or null when none of
 * them can be resolved to a roster member.
 *
 * Null is the ordinary answer for every workflow written before rosters
 * existed, and it is also the answer when a run's rows and its roster disagree
 * — a member journalled under an id the roster no longer carries. Both fall the
 * caller back to `defaults`, because a fixer on the wrong model still resolves
 * conflicts and a fixer that never spawns resolves none.
 *
 * Reviewer rows are skipped. A reviewer read the phase; the implementer wrote
 * the code that is in conflict, and it is the writing that this is selecting
 * for.
 */
export function highestTierImplementer(
  rows: readonly StoredEvent[],
  nodes: readonly string[],
  crew: Readonly<Record<string, CrewMember>>,
): FixerStaffing | null {
  const wanted = new Set(nodes)

  // Last row wins. A retried node is claimed again, and the branch that is
  // being merged is the one the *last* attempt left behind — so the member who
  // actually produced the conflicting code is the one who ran most recently,
  // not the one who ran first. This is also what makes a substitution resolve
  // to whoever covered rather than to whoever the plan named: `node_crew.member`
  // is always the member that ran, and `instead_of` is the one that did not.
  const byNode = new Map<string, string>()
  for (const row of rows) {
    if (row.type !== 'node_crew') continue
    if (!wanted.has(row.nodeId)) continue
    const payload = row.payload as Record<string, unknown> | undefined
    if (payload === undefined) continue
    // Absent `role` means implementer — rows written before reviewers were
    // members read as what they were.
    if (payload['role'] !== undefined && payload['role'] !== 'implementer') continue
    const member = payload['member']
    if (typeof member !== 'string' || member === '') continue
    byNode.set(row.nodeId, member)
  }

  const implemented = new Map<string, string[]>()
  for (const node of nodes) {
    const member = byNode.get(node)
    if (member === undefined || crew[member] === undefined) continue
    const owned = implemented.get(member)
    if (owned === undefined) implemented.set(member, [node])
    else owned.push(node)
  }

  // Tier descending, then member id ascending. Two conflicting phases staffed
  // at the same tier is the common case rather than an edge one, and the tie
  // has no better answer available here — whichever member is picked, the other
  // side's brief is in the prompt and the other side's code is in the tree. So
  // it breaks the way `roster()` breaks its own ties, on id, for the reason
  // given there: a choice that came out differently on each run would make two
  // runs of one plan cost differently for no reason anyone could see.
  const tierOf = (member: string): number => (crew[member] as CrewMember).tier
  const best = [...implemented.keys()].sort((a, b) => tierOf(b) - tierOf(a) || a.localeCompare(b))[0]
  if (best === undefined) return null

  const resolved = crew[best] as CrewMember
  return {
    member: best,
    tier: resolved.tier,
    model: resolved.model,
    harness: resolved.harness ?? null,
    implemented: implemented.get(best) as string[],
  }
}

export interface CrewConflictFixerOptions {
  /** Every adapter the run built, by harness id. */
  readonly adapters: Readonly<Record<string, HarnessAdapter>>
  /** Where an unstaffed workflow — and every unresolvable conflict — lands. */
  readonly defaults: { readonly harness: string; readonly model: string }
  readonly crew: Readonly<Record<string, CrewMember>>
  /**
   * The integration worktree's environment, passed straight through to the
   * spawned task. Selection has no opinion on it — it is a fact about the tree
   * the fixer stands in, not about who is standing there — and it is carried
   * here only because this is the one seam between the composition root that
   * owns the lane pool and the agent that gets spawned.
   */
  readonly env?: Readonly<Record<string, string>>
  /**
   * The run's `node_crew` rows, read at conflict time rather than captured.
   * The fixer is built before the first node dispatches, when no node has been
   * claimed and the answer would be "nobody" for every conflict in the run.
   */
  readonly crewAssignments: () => readonly StoredEvent[]
  /**
   * Where a fix round's turn is written down. Passed straight through: who is
   * staffed changes nothing about where their turn is recorded.
   */
  readonly record?: (nodeId: string, entry: TranscriptEntry) => void
}

/**
 * The fixer a composed run uses: `defaults` as the floor, the highest-tier
 * implementing member on top of it whenever the roster can name one.
 *
 * With no adapter at all the fixer is a no-op and the merge exhausts its rounds
 * and stops as the plan defect it is — the orchestrator resolves nothing itself,
 * and a run whose adapters were injected need not carry the default harness.
 */
export function createCrewConflictFixer(options: CrewConflictFixerOptions): ConflictFixer {
  const fallback = options.adapters[options.defaults.harness] ?? Object.values(options.adapters)[0]
  if (fallback === undefined) return { fix: async () => {} }

  return createAgentConflictFixer({
    adapter: fallback,
    ...(options.record === undefined ? {} : { record: options.record }),
    model: options.defaults.model,
    ...(options.env === undefined ? {} : { env: options.env }),
    staff: (request: ConflictRequest) => {
      const top = highestTierImplementer(options.crewAssignments(), request.nodes, options.crew)
      if (top === null) return null
      // A member's `harness` override only holds if the run actually built that
      // adapter. It falls back rather than refusing: the member's *model* is
      // the half of the decision that matters, and a run that was handed one
      // injected adapter should still get that member's model through it.
      const adapter = top.harness === null ? fallback : (options.adapters[top.harness] ?? fallback)
      return { adapter, model: top.model, implemented: top.implemented }
    },
  })
}
