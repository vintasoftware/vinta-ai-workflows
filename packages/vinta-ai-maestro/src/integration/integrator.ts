/**
 * Integration: dependency-derived branch bases, wave merges, and the conflict
 * loop around both (§8, `parallel-lanes.md#LANE_TOPOLOGY`).
 *
 * **Branch topology follows dependencies, not plan order.** A node with no
 * dependencies cuts from `base_branch`; one with exactly one cuts from that
 * node's branch; one with several cuts from an `integ-<id>` branch that merges
 * them. Phase numbering is a reading aid for humans and says nothing about
 * what a phase is built on — basing a phase on "the previous one" is how a
 * phase inherits work it never declared a dependency on, and how a PR diff
 * grows to include every upstream phase.
 *
 * **Lane merges are always `--no-ff`, never squash.** The atomic unit commits
 * inside a phase are the point of the `modular-commits` strategy; squashing
 * them at integration deletes exactly the history the strategy exists to
 * produce, and a fast-forward hides that a phase was ever a separate line of
 * work.
 *
 * **The orchestrator never edits code.** A conflicted merge is handed to a
 * conflict-fixer agent running in the dedicated integration worktree — never a
 * lane, which may still be working — and the result re-enters the gate. What
 * this file does to the working tree is `merge`, `add` and `commit`: staging
 * someone else's resolution, never authoring one.
 *
 * **A conflict that survives `max_fix_rounds` stops and asks for a person.**
 * Not because the plan is broken — two sibling phases editing one file is
 * expected, which is why there is a fixer at all — but because resolving it by
 * taking a side would silently delete half of what the plan asked for. So this
 * names both nodes and the contested paths and leaves the conflicted merge
 * standing, which is what somebody finishing it by hand needs.
 *
 * Every field in every error and result here is an identifier — a node id, a
 * branch name, a path. Diffs, hunks and file contents stay in the worktree.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { computeWaves } from '../graph.ts'
import type { IntegrationStepPayload } from '../journal/events.ts'
import type { RedGate } from '../prompts/index.ts'
import { codegenMessage, commitOutputs, restageHookEdits } from '../codegen/codegen.ts'
import type { IntegrationCodegen } from '../codegen/integration.ts'
import {
  type ConflictFixer,
  ConflictFixerInterrupted,
  ConflictFixerTimeout,
  type ConflictRequest,
  type FixVerdict,
} from './fixer.ts'
import type { FreshReason } from './fresh.ts'
import { git, GitCommandError, gitLines, gitOk } from './git.ts'
import { composeIntegrationPrBody, type PrText } from './pr-body.ts'
import { openPullRequest, type PrResult } from './pr.ts'
import { type RevertedDeletion, revertedDeletions } from './reverted.ts'

/** What integration reads from a node. `Node` satisfies it structurally. */
export interface IntegrationNode {
  readonly id: string
  readonly name: string
  readonly prompt_ref: string
  readonly depends_on: readonly { readonly node: string }[]
}

/** What integration reads from a workflow. `Workflow` satisfies it structurally. */
export interface IntegrationPlan {
  /** Used in branch names. */
  readonly id: string
  readonly base_branch: string
  readonly nodes: readonly IntegrationNode[]
}

/** How a node's base was derived. The `kind` is the topology rule that applied. */
export type BaseRef =
  | { readonly kind: 'base_branch'; readonly branch: string }
  | { readonly kind: 'dependency'; readonly branch: string; readonly node: string }
  | { readonly kind: 'integration'; readonly branch: string; readonly nodes: readonly string[] }

/** A conflict that was resolved, for the wave record. Identifiers only. */
export interface ConflictRecord {
  readonly nodes: readonly string[]
  readonly paths: readonly string[]
  readonly rounds: number
  /**
   * Lines one side deleted that the resolution kept (`reverted.ts`): a fixer
   * that kept "both sides", or the union driver on an `append_only` file.
   * Flagged, never refused — see SPEC §8. Absent when there were none.
   */
  readonly revertedDeletions?: readonly RevertedDeletion[]
}

export interface WaveResult {
  readonly wave: number
  readonly branch: string
  /** Node branches merged, in plan order. */
  readonly merged: readonly string[]
  readonly conflicts: readonly ConflictRecord[]
}

/**
 * A conflict the fixer could not settle in its rounds. It needs a person.
 *
 * **It used to be called `PlanDefectError`**, and the name was a judgement the
 * orchestrator is not entitled to make. Two same-wave phases touching one file
 * is not a broken plan: the plan's file-overlap analysis is a guess made before
 * a line was written, sibling phases legitimately edit a shared module, and the
 * conflict fixer exists precisely because that is expected. Most of these are
 * resolved and never reach here at all.
 *
 * What reaching here means is narrower and worth saying exactly: *this*
 * conflict outlasted its fix rounds. Sometimes the plan really should have
 * serialized the two phases, and the message still offers that — but it offers
 * it as one option next to finishing the merge by hand, which is the more
 * common answer and the one the worktree is left ready for.
 *
 * The merge is deliberately left in place, conflicted: it is the only copy of
 * what the fixer tried, and since `prepareBase` and `mergeWave` keep a branch
 * they can build on (`#reusable`), a resolution finished by hand there —
 * committed — survives into the retry.
 * One still in progress when the retry comes is not left to wedge it: it is
 * this run's own merge, so the retry keeps it under `ABANDONED_REFS` and
 * starts the merge again (`Integrator.reclaim`).
 */
/** Paths that read as a generator's output: `*.gen.*`, `generated/`, an OpenAPI schema. */
const LOOKS_GENERATED = /(\.gen\.|(^|\/)generated\/|(^|\/)(openapi|schema)\.(ya?ml|json)$|\.generated\.)/

export class UnresolvedConflictError extends Error {
  readonly nodes: readonly string[]
  readonly paths: readonly string[]
  readonly rounds: number

  constructor(nodes: readonly string[], paths: readonly string[], rounds: number, message?: string) {
    super(
      message ??
      `unresolved conflict: ${nodes.join(', ')} both changed ${paths.join(', ')}, ` +
        `and it still conflicts after ${rounds} fix rounds. Finish the merge by ` +
        `hand in the integration worktree and conclude it with \`git commit\` — ` +
        `the next attempt keeps that branch and merges only the phases it still ` +
        `lacks — or serialize the phases with a dependency edge. A merge still ` +
        `unfinished when the phase is retried is kept under ${ABANDONED_REFS}/ ` +
        `and started again.`,
    )
    this.name = 'UnresolvedConflictError'
    this.nodes = nodes
    this.paths = paths
    this.rounds = rounds
  }
}

/**
 * The merge's last fix round ended on a red gate, not on a conflict: the
 * merged tree does not pass the phases' gates. Two sibling phases that each
 * added a migration on the same parent are the common case — each fine alone,
 * broken together, and invisible to git.
 *
 * A subclass, so everything that handles an unresolved conflict — the failure
 * reason, the post-mortem's split signal, the merge left in place for a person
 * — handles this the same way. What differs is what it says: the gate and its
 * log, which is where the cause is. "still conflicts after 2 fix rounds" over
 * an empty path list sent an operator looking for a conflict that was a test.
 */
export class IntegrationVerifyError extends UnresolvedConflictError {
  constructor(
    nodes: readonly string[],
    paths: readonly string[],
    rounds: number,
    readonly gate: RedGate,
    into: string,
    incoming: string,
  ) {
    super(
      nodes,
      paths,
      rounds,
      `merge of ${incoming} into ${into} fails gate ${gate.gateId ?? '(unnamed)'}` +
        `${typeof gate.exitCode === 'number' ? ` (exit ${gate.exitCode})` : ''} after ${rounds} fix rounds` +
        `${gate.logPath === undefined ? '' : `; its output is at ${gate.logPath}`}. ` +
        `${nodes.join(' and ')} each pass alone and break together. Fix the merged code ` +
        `in the integration worktree and conclude the merge with \`git commit\` — the ` +
        `next attempt keeps that branch — or serialize the phases with a dependency edge.`,
    )
    this.name = 'IntegrationVerifyError'
  }
}

/**
 * The integration worktree was found in the middle of a merge, a rebase or a
 * cherry-pick that nothing in this run is conducting.
 *
 * It is shared state, and that is what makes this worth its own error: a
 * `checkout` refused in a lane fails one phase, while one refused here fails
 * every phase whose base is built here, with the same one-line reason each
 * time. The observed run failed four phases between four and twenty-three
 * times each on `git checkout exited 1` before a person opened `.git/` and
 * found `MERGE_HEAD`. So the worktree is inspected *before* any checkout, and
 * the answer names the operation and both branches — which is what somebody
 * finishing or aborting it by hand needs, and all they need.
 *
 * Only what this run did not start gets here. A merge of one of the plan's
 * own branches into one of its own integration branches is the integrator's,
 * whoever interrupted it, and `Integrator.reclaim` takes it down and lets it be
 * redone. A rebase, a cherry-pick, or a merge of anything else is somebody's
 * own work in progress, and theirs to conclude.
 */
export class IntegrationWorktreeBusyError extends Error {
  constructor(
    readonly operation: 'merge' | 'rebase' | 'cherry-pick',
    /** What is being merged, rebased or picked — a branch name where git can say, else a short sha. */
    readonly incoming: string | null,
    /** The branch checked out, or null when HEAD is detached. */
    readonly into: string | null,
  ) {
    const what = incoming === null ? `a ${operation}` : `a ${operation} of ${incoming}`
    super(
      `integration worktree is mid-${operation}: ${what}${into === null ? '' : ` into ${into}`} ` +
        `was started and never concluded. Finish it (git ${operation} --continue) or ` +
        `undo it (git ${operation} --abort) in the integration worktree, then retry.`,
    )
    this.name = 'IntegrationWorktreeBusyError'
  }
}

/** What the operator may answer when a resolution's commit is refused. */
export const COMMIT_DECISIONS = ['commit', 'no-verify', 'abort'] as const
export type CommitDecision = (typeof COMMIT_DECISIONS)[number]

/** A merge commit git would not make — a hook refused it, typically. Identifiers and git's own words. */
export interface CommitFailure {
  /** The incoming phase — the one whose branch was being merged, as a conflict record names it. */
  readonly nodeId: string
  /**
   * The phase this merge is being made *for*: the one whose base is being
   * built, or whose turn built the wave. It is the node that is running, and
   * so the one a question about this commit is parked on — the incoming
   * phase may be long done.
   */
  readonly forNode: string
  /** The branch being merged into. */
  readonly branch: string
  /** The branch whose merge was being committed. */
  readonly incoming: string
  readonly error: GitCommandError
  /** How many times the commit has been refused in this merge, 1-based. */
  readonly attempt: number
  /**
   * Whether the merge conflicted and a fixer resolved it. False for a merge
   * git made cleanly whose commit was refused anyway — the hook checked the
   * merged code itself, and no resolution or gate stands between the two.
   */
  readonly conflicted: boolean
}

/**
 * A wave was asked to build on a wave branch that does not exist. Names the
 * missing wave, which is the fact an operator needs; git's own refusal ("not
 * a commit", exit 128) reads like a corrupted ref.
 */
export class WaveNotBuiltError extends Error {
  constructor(
    readonly wave: number,
    readonly branch: string,
  ) {
    super(`wave ${wave} was never built: ${branch} does not exist`)
    this.name = 'WaveNotBuiltError'
  }
}

/**
 * The commit that would have concluded a resolved merge was refused and the
 * merge was abandoned — by the operator's choice, or because nobody was there
 * to choose.
 *
 * **The worktree is clean when this is thrown.** That is the invariant this
 * class exists to state. The first version of the commit step let a refused
 * `git commit` propagate as-is, which left `MERGE_HEAD` in a worktree every
 * other phase's base is built in: from then on each of them failed in its own
 * setup, before any agent ran, on an error that named none of this. A failed
 * commit in a shared worktree is a failure for *everyone* until the worktree
 * is clean again, so cleaning it is not optional and not the retry's job.
 *
 * The resolution itself is not lost. It is written as a commit under
 * `preservedRef` (see `Integrator.preserveResolution`) before the merge is
 * abandoned — a merge commit made with `commit-tree`, which runs no hook — so
 * that a person can `git merge <ref>` it once the hook is fixed, and a retry
 * of the phase reuses it rather than spending another fixer round.
 */
export class IntegrationCommitError extends Error {
  constructor(
    /** The incoming phase, as `CommitFailure.nodeId`. */
    readonly nodeId: string,
    readonly branch: string,
    readonly incoming: string,
    override readonly cause: GitCommandError,
    readonly preservedRef: string | null,
    readonly decision: CommitDecision | 'unanswered',
  ) {
    super(
      `${cause.message}. The merge of ${incoming} into ${branch} was abandoned` +
        (decision === 'abort' ? " at the operator's word" : '') +
        (preservedRef === null
          ? '; the resolution could not be kept.'
          : `; the resolution is kept at ${preservedRef} and the retry will reuse it.`),
    )
    this.name = 'IntegrationCommitError'
  }
}

/** Where a refused resolution is kept. One ref per incoming phase; the newest wins. */
export const RESOLUTION_REFS = 'refs/vinta-ai-maestro/resolutions'

/**
 * Where an unfinished merge of this run's is kept when it is taken down to be
 * redone (`Integrator.reclaim`). One ref per branch merged into; the newest
 * wins. Never reused automatically, unlike `RESOLUTION_REFS`: what it holds
 * passed no gate and may still carry conflict markers.
 */
export const ABANDONED_REFS = 'refs/vinta-ai-maestro/abandoned'

/** An unfinished merge this run started, taken down so it can be redone. Identifiers only. */
export interface ReclaimedMerge {
  /** The branch the merge was being made on. */
  readonly into: string
  /** What was being merged: a branch or ref name. */
  readonly incoming: string
  /** Where what the merge had in its tree is kept, or null when it could not be. */
  readonly kept: string | null
}

export interface IntegratorOptions {
  readonly plan: IntegrationPlan
  /** The dedicated integration worktree: every merge and every fix happens here. */
  readonly integrationPath: string
  readonly fixer: ConflictFixer
  /** Rounds the fixer gets before the conflict is handed to a person. */
  readonly maxFixRounds?: number
  /**
   * The outer gate, re-run in the integration worktree after every fix. Red
   * sends the conflict back to the fixer — a resolution that does not build is
   * not a resolution.
   */
  readonly verify?: (cwd: string, force?: FreshReason) => Promise<true | false | RedGate>
  /**
   * `workflow.post_merge` on the files a clean merge combined: what it
   * changed is staged for a commit on top of the merge, and `ok` is false
   * when it exited non-zero. Absent, nothing runs.
   */
  readonly postMerge?: (
    cwd: string,
    files: readonly string[],
    forNode: string,
  ) => Promise<{ readonly ok: boolean; readonly changed: readonly string[] }>
  /**
   * Every conflict a fixer settled, as it is settled.
   *
   * A conflict is a normal outcome, not an exception: the planner's file
   * overlap analysis is a guess, two sibling phases legitimately touch one
   * file, and the fixer exists because of it. But nothing recorded that it had
   * happened. `mergeWave` returns its conflicts to whoever called it and
   * `prepareBase` discarded its own, so an operator watching a phase sit in
   * `running` for two minutes — while an agent resolved a merge in a worktree
   * they cannot see — had nothing at all to read.
   *
   * Identifiers only, as `ConflictRecord` already is: node ids, paths, a round
   * count and a branch name (§11).
   */
  readonly onConflict?: (conflict: ReportedConflict) => void
  /**
   * Each step taken in the worktree — a merge, a fix round, a `verify` — as it
   * starts and as it finishes, with the node whose turn it is
   * (`integration_step`). A merge runs no agent of its own, so without this a
   * phase in `integrate` read as frozen for as long as its merge took.
   */
  readonly onStep?: (forNode: string, step: IntegrationStepPayload) => void
  /**
   * Asked what to do when git refuses to commit a resolved merge — a
   * pre-commit hook that fails in the integration worktree, almost always.
   *
   * Three answers. `commit` tries the same commit again, hooks and all, for an
   * operator who has just fixed whatever the hook wanted. `no-verify` commits
   * past the hooks, once, for this merge: the resolution has already passed
   * `verify`, which runs the phases' own gates, so the hook is the only check
   * being skipped and the operator is the one skipping it. `abort` gives up
   * the merge — the resolution is preserved first — and fails the phase with
   * the reason.
   *
   * Absent, the answer is `abort`: an integrator with nobody to ask must still
   * leave the worktree usable for every other phase. The caller that *can* ask
   * routes this to the operator (the scheduler's node question), and under an
   * unattended run answers `abort` for them once the retry window passes.
   */
  readonly onCommitFailure?: (failure: CommitFailure) => Promise<CommitDecision>
  /** Every unfinished merge of this run's that `reclaim` took down, as it is taken down. */
  readonly onReclaimed?: (merge: ReclaimedMerge) => void
  /** Overridden in tests so `gh` is never invoked against a real remote. */
  readonly ghPath?: string
  /**
   * The run's plan branch (`src/run/plan-branch.ts`): what dependency-free
   * nodes branch from and what the wave spine starts at. Absent means
   * `base_branch` plays both parts, as it did before runs had a plan branch.
   *
   * Never a pull-request base. Every PR still targets `base_branch`; the plan
   * branch only adds the commits made on it during the run, and those reach
   * `base_branch` inside the plan's own PRs.
   */
  readonly runBase?: string
  /**
   * Codegen steps and append-only files (`src/codegen/integration.ts`). A
   * conflict confined to a step's outputs is settled by running the step; every
   * merge result is regenerated before it is committed; and every merge takes
   * the union driver for the plan's `append_only` files. Absent, none of it.
   */
  readonly codegen?: IntegrationCodegen
}

/** A settled conflict, plus which merge it came out of. */
export interface ReportedConflict extends ConflictRecord {
  /**
   * `base` is a multi-dependency node's `integ-<id>`, built before the phase
   * runs; `wave` is the spine merge after one finishes. Worth distinguishing:
   * a base conflict blocks a phase that has not started, and a wave conflict
   * lands after its work is already done.
   */
  readonly where: 'base' | 'wave'
  readonly branch: string
}

const CONFLICT_MARKER = /^(<{7}|>{7}) /m

export class Integrator {
  readonly #options: IntegratorOptions
  /**
   * The plan as it stands *now*. §9's amend can replace it mid-run; see
   * `adopt`.
   */
  #plan: IntegrationPlan
  #nodes: Map<string, IntegrationNode>
  #waves: Map<string, number>
  /** The fixer as the crew stands *now*; replaced by `adopt` alongside the plan. */
  #fixer: ConflictFixer
  readonly #maxFixRounds: number

  constructor(options: IntegratorOptions) {
    this.#options = options
    this.#fixer = options.fixer
    this.#plan = options.plan
    this.#nodes = new Map(options.plan.nodes.map((node) => [node.id, node]))
    this.#waves = computeWaves(options.plan.nodes)
    this.#maxFixRounds = options.maxFixRounds ?? 2
  }

  /**
   * Take an amended plan (§9), as the scheduler, the executor and the gate
   * broker do.
   *
   * **This one was left out of that fan-out on purpose, and the reasoning was
   * wrong.** The argument was that an integrator reads node topology rather
   * than the gate table, and that every amendment kind reaching topology is
   * refused while a node it blocks is in flight — so a stale plan here could
   * never be *read* while it was stale. That is true of the nodes an amendment
   * touches and false of the wave they sit in. Adding a phase is refused only
   * while something it blocks is running; nothing is blocked by a phase nobody
   * depends on, so it lands freely while its future wave-mates are mid-flight,
   * and this object went on believing that wave had one fewer member.
   *
   * What made it reachable was fixing the executor. `#lastOfWave` decides a
   * wave is complete by counting the executor's node set, and `mergeWave` used
   * to decide what to merge by reading this one; while *both* were stale they
   * agreed with each other, and the bug was invisible. Teaching the executor to
   * adopt without teaching this to adopt is what turned two consistent stale
   * readings into one fresh and one stale — a wave whose merge silently omits
   * the branch of a phase that ran.
   *
   * `mergeWave` no longer derives membership at all (see its note), so this is
   * about the rest: `base` and `prepareBase` for a node whose dependencies
   * moved, and `openPr` for a phase whose name or brief did. Branch *names* are
   * safe either way — they are built from the plan id, and an amendment that
   * changes the id is refused as `id_mismatch`.
   *
   * **`fixer` is the amended crew's**, and it has to come with the plan. The
   * fixer is staffed from `crew` and `defaults` (`integration/staffing.ts`),
   * and the one built at start kept spawning on the harness the run started
   * with: after an amendment moved every desk from Codex to Claude Code, one
   * observed phase failed seven times on "conflict fixer spawn refused: codex"
   * while every implementer was already on the new harness. A round already
   * running keeps the fixer it started with; the next round takes this one.
   */
  adopt(plan: IntegrationPlan, fixer?: ConflictFixer): void {
    if (fixer !== undefined) this.#fixer = fixer
    this.#plan = plan
    this.#nodes = new Map(plan.nodes.map((node) => [node.id, node]))
    this.#waves = computeWaves(plan.nodes)
  }

  // -------------------------------------------------------------------------
  // Names
  // -------------------------------------------------------------------------

  nodeBranch(id: string): string {
    return `plan/${this.#plan.id}/phase-${id}`
  }

  integBranch(id: string): string {
    return `plan/${this.#plan.id}/integ-${id}`
  }

  /** `wave-0` is the run's base itself: the spine starts at what the run branched from. */
  waveBranch(wave: number): string {
    return wave === 0 ? this.#runBase() : `plan/${this.#plan.id}/wave-${wave}`
  }

  /** The plan branch when the run has one, and `base_branch` when it does not. */
  #runBase(): string {
    return this.#options.runBase ?? this.#plan.base_branch
  }

  // -------------------------------------------------------------------------
  // Bases
  // -------------------------------------------------------------------------

  /** The topology rule, as a pure function of the graph. Builds nothing. */
  base(nodeId: string): BaseRef {
    const deps = this.#node(nodeId).depends_on.map((dep) => dep.node)
    const [first] = deps
    if (first === undefined) return { kind: 'base_branch', branch: this.#runBase() }
    if (deps.length === 1) {
      return { kind: 'dependency', branch: this.nodeBranch(first), node: first }
    }
    return { kind: 'integration', branch: this.integBranch(nodeId), nodes: deps }
  }

  /**
   * The base as a ref that exists: builds the `integ-<id>` branch when the node
   * has several dependencies, in the integration worktree, before the node is
   * dispatched.
   */
  async prepareBase(nodeId: string): Promise<string> {
    const base = this.base(nodeId)
    if (base.kind !== 'integration') return base.branch

    const [first, ...rest] = base.nodes as string[]
    const cwd = this.#options.integrationPath

    // Before any checkout — including the one the prepared-base path below
    // makes. A worktree mid-merge refuses every checkout with the same terse
    // line: an unfinished merge of this run's is redone, and any other is
    // refused by name.
    await this.reclaim()

    // **A base that is already correct is kept, conflicts and all.**
    //
    // This used to reset and re-merge unconditionally, which is right exactly
    // once. A phase that fails after its base was built — and failing *after*
    // is the common shape, since the base is built before the agent runs —
    // comes back through here on every retry, and rebuilding threw away a
    // resolution that had already been made. Where the merge was clean that is
    // wasted seconds; where it conflicted it is a fresh fixer agent redoing
    // identical work, minutes and real money per attempt. One observed run
    // paid for it three times over.
    //
    // Worse than the cost: a conflict this fixer could not settle is meant to
    // be finishable by hand, in this worktree, and the reset silently discarded
    // whatever the human had done before the next attempt looked at it.
    //
    // "Correct" is deliberately about *reachability of the current tips* rather
    // than about the branch merely existing. A dependency that was retried and
    // re-implemented has a new tip this base has never seen, and reusing a base
    // built on the old one would hand the phase work that is no longer there:
    // `#reusable` rebuilds then, and merges on top what a kept base lacks.
    const missing = await this.#reusable(cwd, base.branch, this.nodeBranch(first as string), rest)
    await git(
      cwd,
      missing === null
        ? ['checkout', '-B', base.branch, this.nodeBranch(first as string)]
        : ['checkout', base.branch],
    )

    const merged = [first as string, ...rest.filter((dep) => missing !== null && !missing.includes(dep))]
    for (const dep of missing ?? rest) {
      const conflict = await this.#merge(base.branch, dep, merged, nodeId)
      // Reported wherever the host wants it. Without this a conflict resolved
      // while *preparing a base* was recorded nowhere at all — `mergeWave`'s
      // conflicts reach the post-mortem through its return value, and this
      // loop discarded its own. The multi-dependency merge is the one most
      // likely to conflict, since it is the only place two sibling phases meet.
      if (conflict) this.#options.onConflict?.({ ...conflict, where: 'base', branch: base.branch })
      merged.push(dep)
    }
    return base.branch
  }

  /**
   * Cuts the node's phase branch at its computed base, in the lane that will
   * run it. `checkout -B` creates the branch at the base without checking the
   * base out, so a base that is checked out in another worktree is fine.
   *
   * **`resume` is what stops a retry from erasing the attempt before it.** A
   * failed phase is re-entered at the pipeline's initial state, which runs
   * `git_branch` again — and `-B` moves an existing branch unconditionally. So
   * a phase that committed real work in attempt 1 had it reset to base at the
   * start of attempt 2, the files vanished from the worktree, and the next
   * reviewer correctly reported "phase not implemented at all". The fix budget
   * then burned on re-implementing from nothing, failed again, and the cycle
   * repeated. Observed as two implementer commits and three `branch: Reset to
   * <base>` entries in one phase branch's reflog.
   *
   * "Cold" was always meant to describe the agent's *session*, not its branch.
   * The default policy calls the failures it targets environmental, and an
   * environmental failure is exactly the case where the previous attempt's code
   * is the thing worth keeping.
   *
   * It is a parameter rather than something inferred here because the question
   * is "has this node been branched in *this run*", and only the caller holds
   * the journal that answers it. A phase branch surviving from an unrelated
   * earlier run of the same plan must still be cut fresh — its name carries the
   * plan id and not the run id, so the ref alone cannot tell the two apart.
   */
  async startNode(nodeId: string, lanePath: string, resume = false): Promise<string> {
    const base = await this.prepareBase(nodeId)
    const branch = this.nodeBranch(nodeId)
    await this.#releaseBranch(lanePath, branch)

    if (resume && (await this.#carriesWork(lanePath, branch, base))) {
      // Deliberately not rebased or fast-forwarded onto a base that has moved.
      // Either could conflict, and a conflict here would fail the retry during
      // its *setup*, before the agent that might resolve it has run. An
      // out-of-date base is what an ordinary feature branch has, and the wave
      // merge is what reconciles it.
      await git(lanePath, ['checkout', branch])
      return branch
    }

    await git(lanePath, ['checkout', '-B', branch, base])
    return branch
  }

  /**
   * Lets go of the phase branch wherever another worktree has it checked out,
   * so this lane can take it.
   *
   * A phase moves lanes: the crew assignment changes between attempts, or a
   * staffed phase's member sits at a different desk than last time. Git
   * refuses to check a branch out in two worktrees at once — `fatal: 'plan/…/
   * phase-p13' is already used by worktree at '…/crew-1'`, exit 128 — and
   * nothing moved the old lane off it, so the phase failed in its setup on
   * every attempt. Thirty-nine in a row, in the observed run.
   *
   * The holder is detached at the commit it is on, which releases the name
   * and changes nothing in its working tree: a lane left mid-phase keeps its
   * files, and the next phase handed that lane resets it anyway. Only this
   * run's worktrees are touched; a developer's own checkout holding the branch
   * is left alone and the checkout below fails with git's reason, as before.
   */
  async #releaseBranch(lanePath: string, branch: string): Promise<void> {
    const lines = await gitLines(lanePath, ['worktree', 'list', '--porcelain']).catch(() => [])
    const here = await git(lanePath, ['rev-parse', '--show-toplevel']).then((out) => out.trim(), () => lanePath)
    const poolRoot = dirname(here)
    let worktree: string | null = null
    for (const line of lines) {
      if (line.startsWith('worktree ')) worktree = line.slice('worktree '.length)
      if (line !== `branch refs/heads/${branch}` || worktree === null || worktree === here) continue
      // Another worktree of this run's pool: a sibling under the same root.
      if (dirname(worktree) !== poolRoot) continue
      await gitOk(worktree, ['checkout', '--detach'])
    }
  }

  /**
   * Whether this branch holds commits the base does not — the only reason to
   * keep it rather than cut it again.
   *
   * A branch that is an ancestor of its base contributed nothing (or has
   * already been merged into it), so moving it up costs nothing and leaves the
   * retry on a fresher base. A missing branch answers the same way: there is
   * nothing to lose by creating it.
   */
  async #carriesWork(lanePath: string, branch: string, base: string): Promise<boolean> {
    if (!(await gitOk(lanePath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]))) {
      return false
    }
    return !(await gitOk(lanePath, ['merge-base', '--is-ancestor', branch, base]))
  }

  // -------------------------------------------------------------------------
  // Waves
  // -------------------------------------------------------------------------

  /** The nodes at a wave, in plan order — which is what breaks merge-order ties. */
  nodesAt(wave: number): string[] {
    return this.#plan.nodes
      .filter((node) => this.#waves.get(node.id) === wave)
      .map((node) => node.id)
  }

  /**
   * Builds `wave-<N>` by merging every wave-N node branch into `wave-<N-1>`,
   * `--no-ff`, in plan order.
   *
   * **`members` is the membership as the caller counted it, and passing it is
   * how a queued merge survives an amendment.** A wave merge is decided the
   * moment its last phase arrives and *executed* later, behind the integration
   * worktree's queue; §9's amend can land in between. Deriving the membership
   * here would derive it from whatever plan had arrived by execution time,
   * which is not the plan the caller used to decide the wave was complete — so
   * a phase added to this wave in that window would be merged though it had
   * never run, and one removed would be counted as arrived and then not
   * merged.
   *
   * The caller is the only one that can get this right: it holds the count that
   * decides completeness, and the two answers have to come from one reading.
   * Omitting it falls back to this object's own plan, which is correct for
   * `createRebaser` and for any caller with no such window.
   *
   * `forNode` is the phase whose turn is building this wave — what a question
   * about a refused merge commit is parked on (`CommitFailure.forNode`).
   * Absent, the incoming phase stands in.
   */
  async mergeWave(wave: number, members?: readonly string[], forNode?: string): Promise<WaveResult> {
    const cwd = this.#options.integrationPath
    const branch = this.waveBranch(wave)
    await this.reclaim()
    const under = this.waveBranch(wave - 1)
    // Named, rather than left to `checkout`'s exit 128: "is not a commit" sent
    // one operator looking for a corrupted ref, when the wave had simply never
    // been built. The executor builds missing waves first; this is the
    // backstop for any other caller.
    if (wave > 1 && !(await gitOk(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${under}`]))) {
      throw new WaveNotBuiltError(wave - 1, under)
    }
    const order = members ?? this.nodesAt(wave)
    const catchUp = wave > 1 && this.#options.runBase !== undefined
    // A wave this attempt can build on — one a person finished by hand after
    // the fixer gave up, typically — is kept, and only what it lacks is merged
    // (`#reusable`). Rebuilding from `under` threw that resolution away and
    // brought the same conflict back on every attempt.
    const missing = await this.#reusable(cwd, branch, under, order, catchUp ? [this.#runBase()] : [])
    await git(cwd, missing === null ? ['checkout', '-B', branch, under] : ['checkout', branch])
    // Wave 1 starts at the plan branch's tip, so it already has every commit
    // made there. A later wave starts at the wave before it, which was cut
    // before anything committed to the plan branch since — a config change
    // pushed mid-run — so that is merged first, or the plan PR would ship
    // without the change the run has been running under.
    if (catchUp) await this.#catchUp(cwd, branch)

    const merged = order.filter((id) => missing !== null && !missing.includes(id))
    const conflicts: ConflictRecord[] = []
    for (const nodeId of missing ?? order) {
      const conflict = await this.#merge(branch, nodeId, merged, forNode ?? nodeId)
      if (conflict) {
        conflicts.push(conflict)
        // Reported as it happens as well as returned at the end: the return
        // value reaches the post-mortem once the wave is over, and an operator
        // watching the run needs to know now.
        this.#options.onConflict?.({ ...conflict, where: 'wave', branch })
      }
      merged.push(nodeId)
    }
    return { wave, branch, merged: order.filter((id) => merged.includes(id)), conflicts }
  }

  /**
   * What `branch` still lacks, when it can be built on as it stands; null when
   * it has to be cut again from `under`.
   *
   * It can when it exists, still contains `under`, and every merge made on it
   * since brought in work that is still current: each merge's incoming side is
   * in some member's tip (or in one of `extra`, the plan branch a wave catches
   * up with). That is what tells a resolution finished by hand — its incoming
   * side *is* the member's tip — from a member that was redone after it was
   * merged, whose old commits are in the branch and no longer in the member.
   * The second answers null, and the rebuild is what drops the old work.
   *
   * The members it already contains need nothing; the rest are merged on top,
   * in order. A member it contains at an older tip that the current one
   * descends from is "missing" and merged again, which brings in only what is
   * new.
   */
  async #reusable(
    cwd: string,
    branch: string,
    under: string,
    members: readonly string[],
    extra: readonly string[] = [],
  ): Promise<string[] | null> {
    if (!(await gitOk(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]))) return null
    if (!(await gitOk(cwd, ['merge-base', '--is-ancestor', under, branch]))) return null
    const tips = [...members.map((id) => this.nodeBranch(id)), ...extra]
    for (const line of await gitLines(cwd, ['rev-list', '--merges', '--parents', `${under}..${branch}`])) {
      const [, , ...incoming] = line.split(' ')
      for (const commit of incoming) {
        let current = false
        for (const tip of tips) {
          if (await gitOk(cwd, ['merge-base', '--is-ancestor', commit, tip])) {
            current = true
            break
          }
        }
        if (!current) return null
      }
    }
    const missing: string[] = []
    for (const id of members) {
      if (!(await gitOk(cwd, ['merge-base', '--is-ancestor', this.nodeBranch(id), branch]))) missing.push(id)
    }
    return missing
  }

  /** Merges the plan branch into `branch` when it has commits `branch` lacks. */
  async #catchUp(cwd: string, branch: string): Promise<void> {
    const runBase = this.#runBase()
    if (await gitOk(cwd, ['merge-base', '--is-ancestor', runBase, 'HEAD'])) return
    try {
      await git(cwd, ['merge', '--no-ff', '-m', `Merge ${runBase} into ${branch}`, runBase])
    } catch {
      // A plan-branch commit is configuration, and configuration that
      // conflicts with a phase's work is a decision about which one is right.
      // The fixer is for phases colliding with each other, not for that.
      await gitOk(cwd, ['merge', '--abort'])
      throw new Error(
        `merging ${runBase} into ${branch} conflicted — resolve it on ${runBase} and resume the run`,
      )
    }
  }

  /**
   * Merges `incoming` — a branch that is no phase's: the plan branch after
   * `base_branch` was brought into it, or the wave below (`sync-base`) — into
   * the existing branch `into`, in the integration worktree, with the fixer
   * and `verify` on a conflict exactly as a phase's merge has. `members` are
   * the phases `into` carries, oldest first: the candidates for who owns a
   * contested path, and the last of them is whose turn the merge is filed
   * under. Throws as a wave merge does when no round resolves it — but
   * leaves no merge standing: `reclaim` does not know a wave merging the wave
   * below as this run's, and the run's own next merge would refuse the
   * worktree. What the merge had is kept under `ABANDONED_REFS` first.
   */
  async mergeBranch(into: string, incoming: string, members: readonly string[]): Promise<ConflictRecord | null> {
    const cwd = this.#options.integrationPath
    const forNode = members[members.length - 1]
    if (forNode === undefined) throw new Error(`no phase is merged into ${into} to file its merge under`)
    await this.reclaim()
    await git(cwd, ['checkout', into])
    try {
      const conflict = await this.#merge(into, forNode, members, forNode, incoming)
      if (conflict !== null) this.#options.onConflict?.({ ...conflict, where: 'wave', branch: into })
      return conflict
    } catch (error) {
      if (await this.#merging(cwd)) {
        await this.#keepAbandoned(cwd, into, incoming)
        await this.#abandonMerge(cwd)
      }
      throw error
    }
  }

  // -------------------------------------------------------------------------
  // Pull requests
  //
  // Three kinds, and a plan needs all three to reach `base_branch` through its
  // PRs: one per phase (the review unit), one per `integ-<id>` branch (so a
  // phase stacked on one has a path down), and one for the plan (the final
  // wave branch, the only branch carrying every conflict resolution).
  // -------------------------------------------------------------------------

  /**
   * One PR per node, based on that node's own computed base — never
   * `base_branch` for a node that has dependencies, which would put every
   * upstream phase in the diff and make the review useless.
   *
   * Never throws: opening a PR is reporting, not the work. A missing `gh` is
   * a degraded result the caller shows the operator.
   */
  async openPr(
    nodeId: string,
    options: { readonly draft?: boolean; readonly text?: PrText } = {},
  ): Promise<PrResult> {
    const node = this.#node(nodeId)
    const base = this.base(nodeId)
    // Composed by the caller, which is where the journal is: what a phase cost
    // — gates, attempts, conflicts — is the run's record and not the graph's,
    // and this class deliberately holds only the graph. Absent, the PR falls
    // back to what this file can say by itself.
    return await openPullRequest({
      cwd: this.#options.integrationPath,
      nodeId,
      // A dependency-free phase targets `base_branch`, not the plan branch it
      // was cut from: the plan branch is the run's, and a PR into it would be
      // merged somewhere nobody reviews from.
      base: base.kind === 'base_branch' ? this.#plan.base_branch : base.branch,
      head: this.nodeBranch(nodeId),
      title: options.text?.title ?? node.name,
      body: options.text?.body ?? node.prompt_ref,
      draft: options.draft ?? false,
      ...(this.#options.ghPath === undefined ? {} : { ghPath: this.#options.ghPath }),
    })
  }

  /**
   * The PR that takes a multi-dependency node's `integ-<id>` branch to
   * `base_branch`, or null for a node whose base is not one.
   *
   * The phase PR targets `integ-<id>`, so without this one the stack above it
   * has no path to `base_branch` — see `composeIntegrationPrBody`. Opened by
   * the same node, at the same time, so it exists whenever the PR that needs it
   * does. Never throws, for the reason `openPr` does not.
   */
  async openIntegrationPr(
    nodeId: string,
    options: { readonly draft?: boolean; readonly text?: PrText } = {},
  ): Promise<PrResult | null> {
    const base = this.base(nodeId)
    if (base.kind !== 'integration') return null
    const text =
      options.text ??
      composeIntegrationPrBody({
        nodeId,
        name: this.#node(nodeId).name,
        branch: base.branch,
        baseBranch: this.#plan.base_branch,
        dependsOn: base.nodes,
      })
    return await openPullRequest({
      cwd: this.#options.integrationPath,
      nodeId,
      label: `the integration branch of node ${nodeId}`,
      base: this.#plan.base_branch,
      head: base.branch,
      title: text.title,
      body: text.body,
      draft: options.draft ?? false,
      ...(this.#options.ghPath === undefined ? {} : { ghPath: this.#options.ghPath }),
    })
  }

  /**
   * The PR that lands the whole plan: `wave-<wave>` into `base_branch`.
   *
   * `wave` is the caller's, for `mergeWave`'s reason — the caller decided this
   * was the final wave from its own reading of the plan, and this must open the
   * branch that reading built. Wave 0 *is* `base_branch`, and a PR from a branch
   * into itself is not one, so that answers null.
   */
  async openPlanPr(
    wave: number,
    options: { readonly draft?: boolean; readonly text: PrText },
  ): Promise<PrResult | null> {
    if (wave < 1) return null
    return await openPullRequest({
      cwd: this.#options.integrationPath,
      label: `plan ${this.#plan.id}`,
      base: this.#plan.base_branch,
      head: this.waveBranch(wave),
      title: options.text.title,
      body: options.text.body,
      draft: options.draft ?? false,
      ...(this.#options.ghPath === undefined ? {} : { ghPath: this.#options.ghPath }),
    })
  }

  // -------------------------------------------------------------------------
  // The merge, and the conflict loop around it
  // -------------------------------------------------------------------------

  /**
   * Merges one node branch into the branch checked out in the integration
   * worktree. Returns null when it merged cleanly, the record of the conflict
   * when a fixer resolved it, and throws `UnresolvedConflictError` when no fixer round
   * did.
   */
  async #merge(
    into: string,
    nodeId: string,
    alreadyMerged: readonly string[],
    forNode: string,
    branch?: string,
  ): Promise<ConflictRecord | null> {
    const step = { step: 'merge', branch: into, incoming: branch ?? nodeId } as const
    this.#options.onStep?.(forNode, { ...step, state: 'started' })
    try {
      const cwd = this.#options.integrationPath
      const sides = await Promise.all([
        git(cwd, ['rev-parse', 'HEAD']),
        git(cwd, ['rev-parse', '--verify', `${branch ?? this.nodeBranch(nodeId)}^{commit}`]),
      ]).then(
        (shas) => shas.map((sha) => sha.trim()) as [string, string],
        () => null,
      )
      let record = await this.#mergeOne(into, nodeId, alreadyMerged, forNode, branch)
      const reverted = sides === null ? [] : await this.#revertedDeletions(sides, into, nodeId, alreadyMerged, branch)
      if (reverted.length > 0) {
        // A union merge git made by itself is still a resolution, and the
        // record is where the reverted deletion is reported from.
        const paths = [...new Set(reverted.map((entry) => entry.path))]
        record = {
          ...(record ?? {
            nodes:
              branch === undefined
                ? await this.#owners(paths, alreadyMerged, nodeId)
                : await this.#owners(paths, alreadyMerged, null).then((owners) => (owners.length > 0 ? owners : [nodeId])),
            paths,
            rounds: 0,
          }),
          revertedDeletions: reverted,
        }
      }
      this.#options.onStep?.(forNode, { ...step, state: 'finished', outcome: record === null ? 'ok' : 'resolved' })
      return record
    } catch (error) {
      this.#options.onStep?.(forNode, { ...step, state: 'finished', outcome: 'failed' })
      throw error
    }
  }

  async #mergeOne(
    into: string,
    nodeId: string,
    alreadyMerged: readonly string[],
    forNode: string,
    branch?: string,
  ): Promise<ConflictRecord | null> {
    const cwd = this.#options.integrationPath
    // A branch that is not a phase's (`mergeBranch`) brings no node of its
    // own: the phases already merged that touched a contested path are the
    // conflict's, and `nodeId` stands in when none did.
    const incoming = branch ?? this.nodeBranch(nodeId)
    // --no-ff always: a fast-forward erases that this was a separate phase,
    // and a squash erases the phase's unit commits.
    const mergeArgs = (await this.#options.codegen?.mergeArgs(cwd)) ?? []
    let refused: GitCommandError
    try {
      await git(cwd, [...mergeArgs, 'merge', '--no-ff', '--no-edit', incoming])
      await this.#normalizeMerged(cwd, incoming, forNode)
      await this.#regenerateMerged(cwd, incoming, forNode)
      return null
    } catch (error) {
      if (!(error instanceof GitCommandError)) throw error
      refused = error
    }

    let unmerged = await this.#conflictedPaths()
    // **A merge that stopped with nothing unmerged is not a conflict to hand
    // a fixer.** Git merged the trees and stopped short of the commit:
    // `rerere.autoupdate` replayed a recorded resolution and staged it, or a
    // `pre-merge-commit` / `commit-msg` hook refused the merged code. Handed to
    // the fixer, either became a "conflict" with no files — nineteen rounds in
    // one observed phase, each told to resolve nothing. Without `MERGE_HEAD`
    // git refused before merging anything (an untracked file in the way), and
    // its own words are the error.
    if (unmerged.length === 0 && !(await this.#merging(cwd))) throw refused
    // What git had to resolve, for the record and for the marker check: the
    // unmerged paths, or — when it resolved them itself — what conflicts
    // between the two sides.
    const paths = unmerged.length > 0 ? unmerged : await this.#conflictingPaths(cwd)
    const nodes =
      branch === undefined
        ? await this.#owners(paths, alreadyMerged, nodeId)
        : await this.#owners(paths, alreadyMerged, null).then((owners) => (owners.length > 0 ? owners : [nodeId]))

    // A conflict in a generated file is not one to resolve: either side is
    // taken and the step that writes it runs. What is left — a source file —
    // is the fixer's. A merge whose only conflicts were outputs needs no fixer.
    const codegen = this.#options.codegen
    if (codegen !== undefined && unmerged.length > 0) {
      if ((await codegen.settle(cwd, unmerged)).length > 0) unmerged = await this.#conflictedPaths()
    }

    let red: RedGate | null = null
    if (unmerged.length === 0 && !(await this.#unresolved(paths))) {
      // Already resolved, so 0 rounds: the gates decide, as they would after a
      // fixer. Only a red one reaches the fixer — two migrations on one parent
      // merge cleanly and break together. Regenerated first: the gates judge
      // the tree that is committed, and a failing step is a red gate.
      red = (await codegen?.refresh(cwd, forNode)) ?? (await this.#verify(cwd, forNode))
      if (red === null) {
        await this.#commitResolution(cwd, nodeId, forNode, into, incoming, ['--no-edit'], paths.length > 0)
        return paths.length === 0 ? null : { nodes, paths, rounds: 0 }
      }
    }
    // A resolution of exactly this merge that a refused commit left behind
    // (`preserveResolution`): the fixer's work, already past `verify`, waiting
    // for a commit the hook would allow. Taken over the conflicted merge
    // rather than redone — one fixer round is minutes and real money. The
    // kept commit descends from HEAD, so merging it cannot conflict; should
    // it fail anyway, the original conflicted merge is put back for the fixer.
    const kept = await this.#keptResolution(cwd, nodeId, incoming, paths)
    if (kept !== null) {
      await this.#abandonMerge(cwd)
      if (await gitOk(cwd, ['merge', '--no-ff', '--no-edit', kept])) {
        return { nodes, paths, rounds: 0 }
      }
      // Refused again: dropped, so the next attempt does not replay it. A
      // kept resolution that cannot be committed is a loop, not a shortcut.
      await gitOk(cwd, ['update-ref', '-d', kept])
      await this.#abandonMerge(cwd)
      await gitOk(cwd, [...mergeArgs, 'merge', '--no-ff', '--no-edit', incoming])
      if (codegen !== undefined) await codegen.settle(cwd, await this.#conflictedPaths())
    }
    // An earlier round of this same merge that was stopped part-way — a time
    // limit, a teardown — kept what it had (`#keepAbandoned`). Named to the
    // fixer so the retry continues it: one observed retry restarted a 13-file
    // resolution from scratch after its predecessor ran out of time.
    const previous = await this.#previousAttempt(cwd, into, incoming)
    const request = {
      cwd,
      into,
      incoming,
      nodeId,
      nodes,
      paths,
      promptRefs: nodes.map((id) => this.#node(id).prompt_ref),
      ...(previous === null ? {} : { previousAttempt: previous }),
      ...(codegen === undefined || codegen.generated().length === 0 ? {} : { generated: codegen.generated() }),
    } satisfies Omit<ConflictRequest, 'round'>

    // A fixer reporting the environment stale changed no code, so its round is
    // given back once: the budget is for resolving the merge, and the round
    // spent establishing that the database was wrong did not try to.
    let budget = this.#maxFixRounds
    let staleReported = false
    for (let round = 1; round <= budget; round += 1) {
      this.#options.onStep?.(forNode, { step: 'fix_round', state: 'started', round, incoming: nodeId })
      let verdict: FixVerdict | void
      try {
        verdict = await this.#fixer.fix({ ...request, round, forNode, ...(red === null ? {} : { redGate: red }) })
        this.#options.onStep?.(forNode, { step: 'fix_round', state: 'finished', round })
      } catch (error) {
        this.#options.onStep?.(forNode, { step: 'fix_round', state: 'finished', round, outcome: 'failed' })
        // A fixer that could not run — refused for capacity, a harness that
        // died — has resolved nothing, and the merge it was handed must not
        // outlive it: the next thing to touch this worktree is another
        // phase's base, and a merge left here fails that phase's setup instead
        // of this one's spawn. Abandoned, so the retry starts the merge
        // afresh. Only an unresolved conflict (below) is left standing on
        // purpose.
        //
        // A round that was *stopped* — its time limit, a teardown — did
        // resolve things, possibly most of them, and is kept first under
        // `ABANDONED_REFS` exactly as `reclaim` keeps a merge a kill caught,
        // so the retry's fixer is pointed at it rather than starting over.
        if (
          (error instanceof ConflictFixerTimeout || error instanceof ConflictFixerInterrupted) &&
          (await this.#merging(cwd))
        ) {
          await this.#keepAbandoned(cwd, into, incoming)
        }
        await this.#abandonMerge(cwd)
        throw error
      }
      red = null
      // Outputs the round left conflicted are the integrator's, as at the merge.
      if (codegen !== undefined) await codegen.resettle(cwd, paths)
      const stale = verdict === 'environment_stale' && !staleReported
      if (stale) {
        staleReported = true
        budget += 1
      }
      if (await this.#unresolved(paths)) continue

      // **A fixer that committed its own resolution is the ordinary case, not a
      // deviation.** An agent told to resolve a conflict reaches for the
      // sequence a person would — `git merge --abort`, merge again, resolve,
      // `git commit` — and the last step is the one that broke this.
      //
      // The code below used to commit unconditionally, which is right only
      // while a merge is still in progress. Against an agent that had already
      // committed, `git add --all` is a no-op that exits 0 and `git commit
      // --no-edit` exits 1 with "nothing to commit" — and `git` throws on a
      // non-zero exit, so the *successful* resolution was reported as a failed
      // phase. It surfaced as a node that failed before its branch was cut,
      // with a resolved merge commit sitting in the integration worktree and
      // nothing in the journal saying why: every wave after a parallel one,
      // deterministically, because a multi-dependency node is the only thing
      // that merges here and two sibling phases touching one file is the
      // common case rather than the rare one.
      //
      // So the commit is now conditional on there being something to commit,
      // and "the fixer already did it" is accepted on the same evidence a
      // human would use: the incoming branch is an ancestor of HEAD.
      // Staging someone else's resolution. The orchestrator authored none of it.
      await this.#stageResolution(cwd, paths)
      // Before anything is committed, whichever shape the resolution arrived
      // in: a fixer must not be able to dodge the gate by committing its own
      // work, which is the one thing committing early would otherwise buy it.
      // A red gate goes to the next round, named, so the fixer reads why. The
      // generated files are regenerated from the resolved sources first.
      red =
        (await codegen?.refresh(cwd, forNode)) ??
        (await this.#verify(cwd, forNode, stale ? 'fixer_reported' : undefined))
      if (red !== null) continue

      if (await this.#merging(cwd)) {
        // The merge is still git's to conclude, so `--no-edit` takes the
        // message it already prepared. This is the path that always worked.
        await this.#commitResolution(cwd, nodeId, forNode, into, incoming, ['--no-edit'])
      } else if (await this.#staged(cwd)) {
        // A fixer that committed and then refined — round 2 after a `verify`
        // refusal, typically. There is no prepared message to take, so this
        // one is written here: branch names and a round number, which are
        // identifiers (§11).
        await this.#commitResolution(cwd, nodeId, forNode, into, incoming, [
          '-m',
          `Resolve ${incoming} conflict (round ${round})`,
        ])
      } else if (!(await this.#contains(cwd, incoming))) {
        // Nothing in progress, nothing to commit, and the incoming phase is
        // not in this history: the fixer cleared the conflict by throwing the
        // merge away. Another round rather than a success — recording the
        // phase as integrated when its commits are nowhere here would surface
        // much later, as a phase built on work that is not there.
        continue
      }
      return { nodes, paths, rounds: round }
    }

    // The conflicted merge is left in place deliberately: it is the only copy
    // of what the fixer tried, and it is what a human continuing by hand needs.
    // A last round that ended on a red gate says so: "still conflicts" over an
    // empty path list sent one operator looking for a conflict that was a
    // failing test.
    if (red !== null) throw new IntegrationVerifyError(nodes, paths, this.#maxFixRounds, red, into, incoming)
    throw new UnresolvedConflictError(nodes, paths, this.#maxFixRounds, await this.#unresolvedMessage(nodes, paths))
  }

  /**
   * What the merge just concluded kept of lines one side had deleted. The
   * incoming side is the phase being merged (or, for `mergeBranch`, the branch
   * itself); the side merged into is whichever phase already here last
   * touched the path. Codegen outputs are not read: the steps regenerate them,
   * and a stale line there is the step's to drop. A check that fails reports
   * nothing — it must never fail a merge that is already made.
   */
  async #revertedDeletions(
    [ours, theirs]: readonly [string, string],
    into: string,
    nodeId: string,
    alreadyMerged: readonly string[],
    branch: string | undefined,
  ): Promise<RevertedDeletion[]> {
    const cwd = this.#options.integrationPath
    try {
      return await revertedDeletions({
        cwd,
        ours,
        theirs,
        result: (await git(cwd, ['rev-parse', 'HEAD'])).trim(),
        exclude: this.#options.codegen?.generated() ?? [],
        attribute: async (side, path) => {
          if (side === 'theirs') return branch ?? nodeId
          return (await this.#owners([path], alreadyMerged, null)).at(-1) ?? into
        },
      })
    } catch {
      return []
    }
  }

  /**
   * A merge git committed by itself still has generated files to bring up to
   * date: each side regenerated from its own sources, and the merged sources
   * are neither. The steps run on the merge commit, and what they change is
   * one more commit on top. A step that fails here, or a commit refused, is
   * put back rather than thrown: nothing conflicted, so there is no fixer to
   * hand it to, and the merged tree's gates (§8) are what judge it.
   */
  /**
   * `post_merge` on what a clean merge combined: the files both sides changed
   * since they parted, still present. Git merged them line by line, which is
   * how one observed run got two `routes: list[RouteDict] = [` openers, a
   * duplicated import and imports out of order, each one a fix round and a
   * gate cycle. What the command changes is one more commit on top; a command
   * that fails is put back and left to the merged tree's gates, since no
   * conflict means no fixer to hand it to.
   */
  async #normalizeMerged(cwd: string, incoming: string, forNode: string): Promise<void> {
    const postMerge = this.#options.postMerge
    if (postMerge === undefined) return
    const both = await this.#bothSidesChanged(cwd)
    if (both.length === 0) return
    const result = await postMerge(cwd, both, forNode).catch(() => ({ ok: false, changed: [] as string[] }))
    if (result.ok && result.changed.length > 0) {
      await git(cwd, ['add', '--', ...result.changed])
      const committed = await commitOutputs(cwd, result.changed, `chore(post-merge): normalize files merged from ${incoming}`)
        .then(() => true)
        .catch(() => false)
      if (committed) return
    }
    if (!result.ok || result.changed.length > 0) await gitOk(cwd, ['reset', '-q', '--hard', 'HEAD'])
  }

  /** The files both parents of the merge just made changed since their merge base, that still exist. */
  async #bothSidesChanged(cwd: string): Promise<string[]> {
    try {
      const base = (await git(cwd, ['merge-base', 'HEAD^1', 'HEAD^2'])).trim()
      const ours = new Set(await gitLines(cwd, ['diff', '--name-only', '--diff-filter=d', base, 'HEAD^1']))
      const theirs = await gitLines(cwd, ['diff', '--name-only', '--diff-filter=d', base, 'HEAD^2'])
      return theirs.filter((path) => ours.has(path) && existsSync(join(cwd, path)))
    } catch {
      return []
    }
  }

  async #regenerateMerged(cwd: string, incoming: string, forNode: string): Promise<void> {
    const codegen = this.#options.codegen
    if (codegen === undefined) return
    const red = await codegen.refresh(cwd, forNode).catch(() => ({}))
    const staged = (await git(cwd, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter((path) => path.length > 0)
    if (red === null && staged.length > 0) {
      const committed = await commitOutputs(cwd, staged, codegenMessage([], `after merging ${incoming}`))
        .then(() => true)
        .catch(() => false)
      if (committed) return
    }
    if (staged.length > 0 || red !== null) await gitOk(cwd, ['reset', '-q', '--hard', 'HEAD'])
  }

  /** The outer gate on the merged tree: null when green or not configured, else what went red. */
  async #verify(cwd: string, forNode: string, force?: FreshReason): Promise<RedGate | null> {
    if (this.#options.verify === undefined) return null
    this.#options.onStep?.(forNode, { step: 'verify', state: 'started' })
    const verdict = await this.#options.verify(cwd, force).catch((error: unknown) => {
      this.#options.onStep?.(forNode, { step: 'verify', state: 'finished', outcome: 'failed' })
      throw error
    })
    const red = verdict === true ? null : verdict === false ? {} : verdict
    this.#options.onStep?.(forNode, {
      step: 'verify',
      state: 'finished',
      outcome: red === null ? 'ok' : 'failed',
      ...(red?.gateId === undefined ? {} : { gate: red.gateId }),
      ...(red?.logPath === undefined ? {} : { log: red.logPath }),
    })
    return red
  }

  /**
   * The paths both sides of the merge in progress changed since they parted —
   * what a conflict git resolved itself (`rerere`) was over, since the index
   * no longer says: it is staged as if there never was one. Empty when git
   * cannot say, which only costs the record its paths.
   */
  async #conflictingPaths(cwd: string): Promise<string[]> {
    try {
      const base = (await git(cwd, ['merge-base', 'HEAD', 'MERGE_HEAD'])).trim()
      const ours = new Set(await gitLines(cwd, ['diff', '--name-only', base, 'HEAD']))
      return (await gitLines(cwd, ['diff', '--name-only', base, 'MERGE_HEAD'])).filter((path) => ours.has(path))
    } catch {
      return []
    }
  }

  /**
   * `git commit <args>` for a resolution, and what happens when git says no.
   *
   * A hook is the usual reason: the integration worktree runs the repository's
   * hooks exactly as a lane does (`project.hooks`), and a `pre-commit` chain
   * that imports a gitignored settings module the worktree never received
   * fails every commit here while passing in the operator's own checkout. One
   * such refusal used to leave `MERGE_HEAD` behind and fail every later phase
   * in its setup; see `IntegrationCommitError`.
   *
   * So the loop is: ask (`onCommitFailure`) and do as told, and whatever ends
   * it — `abort`, no one to ask, or the asking itself failing, which is what a
   * halt looks like from here — the merge is abandoned with the resolution
   * preserved first, and the worktree is left clean.
   */
  async #commitResolution(
    cwd: string,
    nodeId: string,
    forNode: string,
    into: string,
    incoming: string,
    args: readonly string[],
    conflicted = true,
  ): Promise<void> {
    let extra: readonly string[] = []
    let restaged = false
    for (let attempt = 1; ; attempt += 1) {
      try {
        await git(cwd, ['commit', ...extra, ...args])
        return
      } catch (error) {
        if (!(error instanceof GitCommandError)) throw error
        // A hook that rewrote what it was handed — a formatter, a schema
        // generator — and failed the commit for it. The rewrite is the fix:
        // staged, and the commit tried once more before anyone is asked. Seven
        // merge commits in one run were refused this way over a reorder.
        if (!restaged && (await restageHookEdits(cwd).catch(() => false))) {
          restaged = true
          attempt -= 1
          continue
        }
        const refused = error
        let decision: CommitDecision
        try {
          decision =
            this.#options.onCommitFailure === undefined
              ? 'abort'
              : await this.#options.onCommitFailure({
                  nodeId,
                  forNode,
                  branch: into,
                  incoming,
                  error: refused,
                  attempt,
                  conflicted,
                })
        } catch (asking) {
          // The question could not be asked or was withdrawn — a halt, an
          // abort. The worktree still has to be clean for whoever comes next.
          await this.preserveResolution(cwd, nodeId, incoming)
          await this.#abandonMerge(cwd)
          throw asking
        }
        if (decision === 'commit') {
          extra = []
          continue
        }
        if (decision === 'no-verify') {
          extra = ['--no-verify']
          continue
        }
        const preserved = await this.preserveResolution(cwd, nodeId, incoming)
        await this.#abandonMerge(cwd)
        throw new IntegrationCommitError(nodeId, into, incoming, refused, preserved, decision)
      }
    }
  }

  /**
   * Keeps whatever is staged as a commit under `RESOLUTION_REFS`, with the
   * same parents the merge commit would have had, and returns the ref — or
   * null when nothing could be kept.
   *
   * `write-tree` + `commit-tree` + `update-ref`: plumbing, which runs no hook,
   * which is the point — the hook is what refused the commit. The ref is
   * outside `refs/heads`, so no branch listing shows it and no lane can cut
   * from it by accident; `git merge <ref>` in the integration worktree, or the
   * next `prepareBase`, is how it is used.
   */
  async preserveResolution(cwd: string, nodeId: string, incoming: string): Promise<string | null> {
    try {
      const tree = (await git(cwd, ['write-tree'])).trim()
      const parents = (await this.#merging(cwd)) ? ['-p', 'HEAD', '-p', 'MERGE_HEAD'] : ['-p', 'HEAD']
      const commit = (
        await git(cwd, [
          'commit-tree',
          tree,
          ...parents,
          '-m',
          `Resolve ${incoming} conflict (kept by vinta-ai-maestro: the commit was refused)`,
        ])
      ).trim()
      const ref = `${RESOLUTION_REFS}/${nodeId}`
      await git(cwd, ['update-ref', ref, commit])
      return ref
    } catch {
      return null
    }
  }

  /**
   * A resolution kept by `preserveResolution` for this phase, when it is still
   * the resolution of *this* merge — its parents are the branch's current tip
   * and the incoming branch's. Anything else is stale and ignored.
   *
   * Asked while the conflicted merge is in progress, so "the branch's tip" is
   * `HEAD`: a merge in progress has not moved it.
   *
   * **One that carries files from outside the merge is dropped, not reused.**
   * Before staging was narrowed (`#stageResolution`) a gate's leftover in the
   * integration worktree — a 3.2 MB `.testmondata-wal` — was staged into the
   * resolution, a large-file hook refused the commit, and the kept resolution
   * replayed the same file into every retry: a phase that looped on its own
   * debris. "Outside" is a path the kept commit changes against `HEAD` that
   * the incoming side never changed and that was not in conflict.
   */
  async #keptResolution(
    cwd: string,
    nodeId: string,
    incoming: string,
    paths: readonly string[],
  ): Promise<string | null> {
    const ref = `${RESOLUTION_REFS}/${nodeId}`
    const [line] = await gitLines(cwd, ['rev-list', '--parents', '-n', '1', ref]).catch(() => [])
    if (line === undefined) return null
    const [, ...parents] = line.split(' ')
    const head = (await git(cwd, ['rev-parse', 'HEAD'])).trim()
    const tip = (await git(cwd, ['rev-parse', incoming])).trim()
    if (parents.length !== 2 || parents[0] !== head || parents[1] !== tip) return null
    try {
      const base = (await git(cwd, ['merge-base', head, tip])).trim()
      const merged = new Set([...paths, ...(await gitLines(cwd, ['diff', '--name-only', base, tip]))])
      const changed = await gitLines(cwd, ['diff', '--name-only', head, ref])
      if (changed.some((path) => !merged.has(path))) {
        await gitOk(cwd, ['update-ref', '-d', ref])
        return null
      }
    } catch {
      return null
    }
    return ref
  }

  /**
   * What an earlier, stopped round of this same merge left under
   * `ABANDONED_REFS`, when it is still about this merge — its parents are the
   * branch's tip and the incoming tip. Null otherwise.
   */
  async #previousAttempt(cwd: string, into: string, incoming: string): Promise<string | null> {
    const ref = `${ABANDONED_REFS}/${into.slice(`plan/${this.#plan.id}/`.length)}`
    const [line] = await gitLines(cwd, ['rev-list', '--parents', '-n', '1', ref]).catch(() => [])
    if (line === undefined) return null
    const [, ...parents] = line.split(' ')
    const head = (await git(cwd, ['rev-parse', 'HEAD']).catch(() => '')).trim()
    const tip = (await git(cwd, ['rev-parse', incoming]).catch(() => '')).trim()
    return parents.length === 2 && parents[0] === head && parents[1] === tip ? ref : null
  }

  /**
   * Stages a fixer's resolution: every tracked path (`add -u`, which also
   * settles unmerged entries and records deletions) plus the merge's own
   * paths — and nothing untracked.
   *
   * It used to be `add --all`, which took whatever else was lying in the
   * worktree: a gate run there leaves caches and databases behind, and one
   * such file (a 3.2 MB `.testmondata-wal`) was staged into a merge, refused
   * by a large-file hook, and replayed on every retry. A file the fixer means
   * to add — a merge migration — it stages itself; the prompt says so.
   */
  async #stageResolution(cwd: string, paths: readonly string[]): Promise<void> {
    await git(cwd, ['add', '-u'])
    for (const path of paths) await gitOk(cwd, ['add', '-A', '--', path])
  }

  /**
   * Leaves no merge in progress: `merge --abort` while one is, and otherwise a
   * reset of the index and tree to HEAD, which is what a refused `commit -m`
   * of a staged refinement needs. Best effort — the worktree may already be
   * clean.
   */
  async #abandonMerge(cwd: string): Promise<void> {
    if (await this.#merging(cwd)) {
      await gitOk(cwd, ['merge', '--abort'])
      return
    }
    await gitOk(cwd, ['reset', '--hard', 'HEAD'])
  }

  /**
   * Leaves the integration worktree with no operation in progress, or says
   * why it cannot: takes down an unfinished merge this run started, and
   * refuses — by name, `IntegrationWorktreeBusyError` — anything else.
   *
   * Asked before every checkout this class makes in the integration worktree,
   * and by the host on a resume and on the way out of a forced stop. A merge
   * that a pause, a stop or a kill caught half-way is the integrator's own
   * work and nobody else will conclude it: refusing it, as this used to,
   * failed every later attempt in its setup with the same line until a person
   * ran `git merge --abort` by hand — one observed phase backed off its
   * unattended retries and parked on a human over a merge that had staged
   * without a conflict. So it is redone instead, which is also what puts the
   * merge's result in front of the gates again.
   *
   * "Started by this run" is read from git, not remembered: the branch
   * checked out is one of the plan's `integ-` or `wave-` branches, and what is
   * being merged is one of the plan's phase branches (at its tip, or behind it
   * when a retry has moved it on since), a resolution this integrator kept, or
   * the plan branch catching a wave up. Anything else is somebody's own.
   *
   * Nothing is lost: whatever the merge had in its tree, a fixer's unfinished
   * attempt included, is kept as a commit under `ABANDONED_REFS` first.
   */
  async reclaim(): Promise<ReclaimedMerge | null> {
    const cwd = this.#options.integrationPath
    const gitDir = (await git(cwd, ['rev-parse', '--absolute-git-dir'])).trim()
    const operation = await this.#operationInProgress(cwd, gitDir)
    if (operation === null) return null
    const own = operation === 'merge' ? await this.#ownMerge(cwd) : null
    if (own === null) throw await this.#busy(cwd, operation)

    const kept = await this.#keepAbandoned(cwd, own.into, own.incoming)
    await gitOk(cwd, ['merge', '--abort'])
    // `--abort` refuses a few index states a killed merge can leave; a hard
    // reset to the branch's own tip clears `MERGE_HEAD` from any of them.
    if (await this.#merging(cwd)) await gitOk(cwd, ['reset', '--hard', 'HEAD'])
    if (await this.#merging(cwd)) throw await this.#busy(cwd, operation)
    const merge: ReclaimedMerge = { into: own.into, incoming: own.incoming, kept }
    this.#options.onReclaimed?.(merge)
    return merge
  }

  /**
   * The merge in progress, when this run started it: `into` the plan branch
   * checked out, `incoming` the name of what it is merging. Null otherwise.
   */
  async #ownMerge(cwd: string): Promise<{ readonly into: string; readonly incoming: string } | null> {
    const prefix = `plan/${this.#plan.id}/`
    const into = (await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim()
    if (!into.startsWith(`${prefix}integ-`) && !into.startsWith(`${prefix}wave-`)) return null
    const head = (await git(cwd, ['rev-parse', 'MERGE_HEAD']).catch(() => '')).trim()
    if (head === '') return null

    const resolutions = await gitLines(cwd, ['for-each-ref', '--format=%(objectname) %(refname)', RESOLUTION_REFS])
    for (const line of resolutions) {
      const [sha, ref] = line.split(' ')
      if (sha === head && ref !== undefined) return { into, incoming: ref }
    }

    const runBase = this.#runBase()
    const baseTip = (await git(cwd, ['rev-parse', '--verify', '--quiet', runBase]).catch(() => '')).trim()
    if (into.startsWith(`${prefix}wave-`) && head === baseTip) return { into, incoming: runBase }
    // What every phase branch contains is the base, and a merge of the base
    // is not a phase's.
    if (await gitOk(cwd, ['merge-base', '--is-ancestor', head, runBase])) return null

    const phases = (
      await gitLines(cwd, ['for-each-ref', '--contains', head, '--format=%(refname:short)', `refs/heads/${prefix}`])
    ).filter((branch) => branch.startsWith(`${prefix}phase-`))
    if (phases.length === 0) return null
    for (const branch of phases) {
      if ((await git(cwd, ['rev-parse', branch])).trim() === head) return { into, incoming: branch }
    }
    return { into, incoming: phases[0] as string }
  }

  /**
   * Keeps what an unfinished merge has in its tree as a commit under
   * `ABANDONED_REFS`, with the merge's own parents, and returns the ref — or
   * null when nothing could be kept. Plumbing, so no hook runs. Tracked paths
   * are staged first: a killed fixer round leaves unmerged paths, which
   * `write-tree` refuses, and the merge is about to be undone anyway. Never
   * untracked ones, for `#stageResolution`'s reason — this ref is handed to
   * the next fixer as a starting point.
   */
  async #keepAbandoned(cwd: string, into: string, incoming: string): Promise<string | null> {
    try {
      await git(cwd, ['add', '-u'])
      const tree = (await git(cwd, ['write-tree'])).trim()
      const commit = (
        await git(cwd, [
          'commit-tree',
          tree,
          '-p',
          'HEAD',
          '-p',
          'MERGE_HEAD',
          '-m',
          `Unfinished merge of ${incoming} into ${into} (kept by vinta-ai-maestro: it was redone)`,
        ])
      ).trim()
      const ref = `${ABANDONED_REFS}/${into.slice(`plan/${this.#plan.id}/`.length)}`
      await git(cwd, ['update-ref', ref, commit])
      return ref
    } catch {
      return null
    }
  }

  /** The refusal for an operation this run did not start, naming it and both branches. */
  async #busy(
    cwd: string,
    operation: 'merge' | 'rebase' | 'cherry-pick',
  ): Promise<IntegrationWorktreeBusyError> {
    const into = (await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim()
    const headRef =
      operation === 'merge' ? 'MERGE_HEAD' : operation === 'rebase' ? 'REBASE_HEAD' : 'CHERRY_PICK_HEAD'
    const named = (
      await git(cwd, ['name-rev', '--name-only', '--refs=refs/heads/*', '--no-undefined', headRef]).catch(
        () => '',
      )
    ).trim()
    const sha = (await git(cwd, ['rev-parse', '--short', headRef]).catch(() => '')).trim()
    const incoming = named !== '' ? named.replace(/[~^].*$/, '') : sha !== '' ? sha : null
    return new IntegrationWorktreeBusyError(operation, incoming, into === '' ? null : into)
  }

  async #operationInProgress(
    cwd: string,
    gitDir: string,
  ): Promise<'merge' | 'rebase' | 'cherry-pick' | null> {
    if (await gitOk(cwd, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])) return 'merge'
    if (
      (await gitOk(cwd, ['rev-parse', '--verify', '--quiet', 'REBASE_HEAD'])) ||
      existsSync(join(gitDir, 'rebase-merge')) ||
      existsSync(join(gitDir, 'rebase-apply'))
    ) {
      return 'rebase'
    }
    if (await gitOk(cwd, ['rev-parse', '--verify', '--quiet', 'CHERRY_PICK_HEAD'])) return 'cherry-pick'
    return null
  }

  /**
   * Whether a merge is still in progress — `MERGE_HEAD` exists.
   *
   * This is git's own record that a merge was started and not concluded, and
   * it is what distinguishes "the fixer resolved the files and left the commit
   * to us" from "the fixer committed". Asking the working tree instead would
   * not separate them: both leave it clean.
   */
  async #merging(cwd: string): Promise<boolean> {
    return await gitOk(cwd, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])
  }

  /** Whether the index holds anything the last commit does not. */
  async #staged(cwd: string): Promise<boolean> {
    return !(await gitOk(cwd, ['diff', '--cached', '--quiet']))
  }

  /**
   * Whether the incoming branch is already in this branch's history.
   *
   * The test for a fixer that committed the merge itself, and it is deliberately
   * about *reachability* rather than about the shape of the last commit: a
   * resolution squashed onto one commit, or committed as a merge, or rebased,
   * all satisfy the only thing the wave spine needs — that this phase's work is
   * in the branch the next phase will build on.
   */
  async #contains(cwd: string, branch: string): Promise<boolean> {
    return await gitOk(cwd, ['merge-base', '--is-ancestor', branch, 'HEAD'])
  }

  async #conflictedPaths(): Promise<string[]> {
    return await gitLines(this.#options.integrationPath, [
      'diff',
      '--name-only',
      '--diff-filter=U',
    ])
  }

  /**
   * True while any conflicted path still carries markers.
   *
   * Asking git is not enough: `git add` marks a path resolved whether or not
   * the markers are gone, so a fixer that did nothing would produce a merge
   * commit full of `<<<<<<<`. The file is read and tested, never logged.
   */
  /**
   * The unresolved-conflict message, with a hint when what is left looks
   * generated and no codegen step owns it: a fixer told not to hand-edit
   * generated files leaves those conflicts in place round after round, and
   * nothing regenerates a file the workflow does not say is generated.
   */
  async #unresolvedMessage(nodes: readonly string[], paths: readonly string[]): Promise<string | undefined> {
    const left: string[] = []
    for (const path of paths) {
      try {
        if (CONFLICT_MARKER.test(await readFile(join(this.#options.integrationPath, path), 'utf8'))) left.push(path)
      } catch {
        // Deleted: resolved.
      }
    }
    const generated = new Set(this.#options.codegen?.generated() ?? [])
    const looksGenerated = left.filter((path) => LOOKS_GENERATED.test(path) && !generated.has(path))
    if (looksGenerated.length === 0) return undefined
    return (
      `unresolved conflict: ${nodes.join(', ')} both changed ${paths.join(', ')}, ` +
      `and it still conflicts after ${this.#maxFixRounds} fix rounds. ${looksGenerated.join(', ')} ` +
      'look generated and no `codegen` step writes them, so nothing regenerated them: declare the ' +
      'generator under `codegen` (or `maestro.codegen`) with them as its `outputs`, and a merge takes ' +
      'either side and regenerates them instead of asking the fixer.'
    )
  }

  async #unresolved(paths: readonly string[]): Promise<boolean> {
    for (const path of paths) {
      try {
        if (CONFLICT_MARKER.test(await readFile(join(this.#options.integrationPath, path), 'utf8'))) {
          return true
        }
      } catch {
        // Deleting the file is a legitimate resolution.
      }
    }
    return false
  }

  /**
   * Which nodes own the contested paths: the incoming one, plus every node
   * already merged into this branch that changed one of them. This is what
   * makes the defect report name a *pair* rather than only the node whose
   * merge happened to be second.
   */
  async #owners(
    paths: readonly string[],
    candidates: readonly string[],
    incoming: string | null,
  ): Promise<string[]> {
    const contested = new Set(paths)
    const owners: string[] = []
    for (const candidate of candidates) {
      const touched = await gitLines(this.#options.integrationPath, [
        'diff',
        '--name-only',
        `${this.#plan.base_branch}...${this.nodeBranch(candidate)}`,
      ])
      if (touched.some((path) => contested.has(path))) owners.push(candidate)
    }
    if (incoming !== null) owners.push(incoming)
    return owners
  }

  #node(id: string): IntegrationNode {
    const node = this.#nodes.get(id)
    if (node === undefined) throw new Error(`unknown node "${id}"`)
    return node
  }
}
