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
import { join } from 'node:path'
import { computeWaves } from '../graph.ts'
import type { ConflictFixer, ConflictRequest } from './fixer.ts'
import { git, GitCommandError, gitLines, gitOk } from './git.ts'
import { composeIntegrationPrBody, type PrText } from './pr-body.ts'
import { openPullRequest, type PrResult } from './pr.ts'

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
 * what the fixer tried, and since `prepareBase` began reusing a prepared base,
 * a resolution finished by hand there survives into the retry.
 */
export class UnresolvedConflictError extends Error {
  readonly nodes: readonly string[]
  readonly paths: readonly string[]
  readonly rounds: number

  constructor(nodes: readonly string[], paths: readonly string[], rounds: number) {
    super(
      `unresolved conflict: ${nodes.join(', ')} both changed ${paths.join(', ')}, ` +
        `and it still conflicts after ${rounds} fix rounds. Finish the merge by ` +
        `hand in the integration worktree — the retry will keep it — or serialize ` +
        `the phases with a dependency edge.`,
    )
    this.name = 'UnresolvedConflictError'
    this.nodes = nodes
    this.paths = paths
    this.rounds = rounds
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
 * Nothing here is resolved automatically. A merge left in place is either a
 * conflict `UnresolvedConflictError` handed to a person, or a person's own
 * work in progress; both are theirs to conclude.
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
  readonly verify?: (cwd: string) => Promise<boolean>
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
  readonly #maxFixRounds: number

  constructor(options: IntegratorOptions) {
    this.#options = options
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
   */
  adopt(plan: IntegrationPlan): void {
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
    // line, and the only useful answer names the merge.
    await this.#assertIdle(cwd)

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
    // built on the old one would hand the phase work that is no longer there.
    if (await this.#basePrepared(cwd, base.branch, base.nodes)) {
      await git(cwd, ['checkout', base.branch])
      return base.branch
    }

    await git(cwd, ['checkout', '-B', base.branch, this.nodeBranch(first as string)])

    const merged = [first as string]
    for (const dep of rest) {
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
   * Whether `branch` already integrates every dependency's *current* tip.
   *
   * A missing branch answers false, as does one built before a dependency
   * moved. Both are read-only questions — nothing here creates or resets a ref,
   * so a base judged stale costs only the rebuild it was going to do anyway.
   */
  async #basePrepared(
    cwd: string,
    branch: string,
    nodes: readonly string[],
  ): Promise<boolean> {
    if (!(await gitOk(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]))) {
      return false
    }
    for (const node of nodes) {
      if (!(await gitOk(cwd, ['merge-base', '--is-ancestor', this.nodeBranch(node), branch]))) {
        return false
      }
    }
    return true
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
    await this.#assertIdle(cwd)
    await git(cwd, ['checkout', '-B', branch, this.waveBranch(wave - 1)])
    // Wave 1 starts at the plan branch's tip, so it already has every commit
    // made there. A later wave starts at the wave before it, which was cut
    // before anything committed to the plan branch since — a config change
    // pushed mid-run — so that is merged first, or the plan PR would ship
    // without the change the run has been running under.
    if (wave > 1 && this.#options.runBase !== undefined) await this.#catchUp(cwd, branch)

    const merged: string[] = []
    const conflicts: ConflictRecord[] = []
    for (const nodeId of members ?? this.nodesAt(wave)) {
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
    return { wave, branch, merged, conflicts }
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
  ): Promise<ConflictRecord | null> {
    const cwd = this.#options.integrationPath
    const incoming = this.nodeBranch(nodeId)
    // --no-ff always: a fast-forward erases that this was a separate phase,
    // and a squash erases the phase's unit commits.
    if (await gitOk(cwd, ['merge', '--no-ff', '--no-edit', incoming])) return null

    const paths = await this.#conflictedPaths()
    const nodes = await this.#owners(paths, alreadyMerged, nodeId)
    // A resolution of exactly this merge that a refused commit left behind
    // (`preserveResolution`): the fixer's work, already past `verify`, waiting
    // for a commit the hook would allow. Taken over the conflicted merge
    // rather than redone — one fixer round is minutes and real money. The
    // kept commit descends from HEAD, so merging it cannot conflict; should
    // it fail anyway, the original conflicted merge is put back for the fixer.
    const kept = await this.#keptResolution(cwd, nodeId, incoming)
    if (kept !== null) {
      await this.#abandonMerge(cwd)
      if (await gitOk(cwd, ['merge', '--no-ff', '--no-edit', kept])) {
        return { nodes, paths, rounds: 0 }
      }
      await this.#abandonMerge(cwd)
      await gitOk(cwd, ['merge', '--no-ff', '--no-edit', incoming])
    }
    const request = {
      cwd,
      into,
      incoming,
      nodeId,
      nodes,
      paths,
      promptRefs: nodes.map((id) => this.#node(id).prompt_ref),
    } satisfies Omit<ConflictRequest, 'round'>

    for (let round = 1; round <= this.#maxFixRounds; round += 1) {
      try {
        await this.#options.fixer.fix({ ...request, round })
      } catch (error) {
        // A fixer that could not run — refused for capacity, a harness that
        // died — has resolved nothing, and the merge it was handed must not
        // outlive it: the next thing to touch this worktree is another
        // phase's base, and a merge left here fails that phase's setup instead
        // of this one's spawn. Abandoned, so the retry starts the merge
        // afresh. Only an unresolved conflict (below) is left standing on
        // purpose.
        await this.#abandonMerge(cwd)
        throw error
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
      await git(cwd, ['add', '--all'])
      // Before anything is committed, whichever shape the resolution arrived
      // in: a fixer must not be able to dodge the gate by committing its own
      // work, which is the one thing committing early would otherwise buy it.
      if (this.#options.verify && !(await this.#options.verify(cwd))) continue

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
    throw new UnresolvedConflictError(nodes, paths, this.#maxFixRounds)
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
  ): Promise<void> {
    let extra: readonly string[] = []
    for (let attempt = 1; ; attempt += 1) {
      try {
        await git(cwd, ['commit', ...extra, ...args])
        return
      } catch (error) {
        if (!(error instanceof GitCommandError)) throw error
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
   */
  async #keptResolution(cwd: string, nodeId: string, incoming: string): Promise<string | null> {
    const ref = `${RESOLUTION_REFS}/${nodeId}`
    const [line] = await gitLines(cwd, ['rev-list', '--parents', '-n', '1', ref]).catch(() => [])
    if (line === undefined) return null
    const [, ...parents] = line.split(' ')
    const head = (await git(cwd, ['rev-parse', 'HEAD'])).trim()
    const tip = (await git(cwd, ['rev-parse', incoming])).trim()
    return parents.length === 2 && parents[0] === head && parents[1] === tip ? ref : null
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
   * Refuses to work in a worktree that is mid-merge, mid-rebase or
   * mid-cherry-pick, naming what it found (`IntegrationWorktreeBusyError`).
   *
   * Read-only. Asked before every checkout this class makes in the integration
   * worktree, because git's own refusal for that state is one line that names
   * neither the operation nor the branches.
   */
  async #assertIdle(cwd: string): Promise<void> {
    const gitDir = (await git(cwd, ['rev-parse', '--absolute-git-dir'])).trim()
    const operation = await this.#operationInProgress(cwd, gitDir)
    if (operation === null) return
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
    throw new IntegrationWorktreeBusyError(operation, incoming, into === '' ? null : into)
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
    incoming: string,
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
    owners.push(incoming)
    return owners
  }

  #node(id: string): IntegrationNode {
    const node = this.#nodes.get(id)
    if (node === undefined) throw new Error(`unknown node "${id}"`)
    return node
  }
}
