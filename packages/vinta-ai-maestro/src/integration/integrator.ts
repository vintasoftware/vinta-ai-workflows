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
 * **A conflict that survives `max_fix_rounds` is a plan defect.** Two nodes in
 * the same wave own the same code, which is a fact about the plan, not about
 * the code. Resolving it by taking a side would silently delete half of what
 * the plan asked for, so this stops and names both nodes and the contested
 * paths instead.
 *
 * Every field in every error and result here is an identifier — a node id, a
 * branch name, a path. Diffs, hunks and file contents stay in the worktree.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { computeWaves } from '../graph.ts'
import type { ConflictFixer, ConflictRequest } from './fixer.ts'
import { git, gitLines, gitOk } from './git.ts'
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
 * Two same-wave nodes own the same code. Not a merge to work around — a plan
 * to fix, by adding the dependency edge that serializes them.
 */
export class PlanDefectError extends Error {
  readonly nodes: readonly string[]
  readonly paths: readonly string[]
  readonly rounds: number

  constructor(nodes: readonly string[], paths: readonly string[], rounds: number) {
    super(
      `plan defect: nodes ${nodes.join(', ')} both own ${paths.join(', ')} — ` +
        `still conflicting after ${rounds} fix rounds. Serialize them by adding a ` +
        `dependency edge, or resolve by hand.`,
    )
    this.name = 'PlanDefectError'
    this.nodes = nodes
    this.paths = paths
    this.rounds = rounds
  }
}

export interface IntegratorOptions {
  readonly plan: IntegrationPlan
  /** The dedicated integration worktree: every merge and every fix happens here. */
  readonly integrationPath: string
  readonly fixer: ConflictFixer
  /** Rounds a conflict gets before it is a plan defect. */
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
  /** Overridden in tests so `gh` is never invoked against a real remote. */
  readonly ghPath?: string
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
  readonly #nodes: Map<string, IntegrationNode>
  readonly #waves: Map<string, number>
  readonly #maxFixRounds: number

  constructor(options: IntegratorOptions) {
    this.#options = options
    this.#nodes = new Map(options.plan.nodes.map((node) => [node.id, node]))
    this.#waves = computeWaves(options.plan.nodes)
    this.#maxFixRounds = options.maxFixRounds ?? 2
  }

  // -------------------------------------------------------------------------
  // Names
  // -------------------------------------------------------------------------

  nodeBranch(id: string): string {
    return `plan/${this.#options.plan.id}/phase-${id}`
  }

  integBranch(id: string): string {
    return `plan/${this.#options.plan.id}/integ-${id}`
  }

  /** `wave-0` is `base_branch` itself: the spine starts at what the run branched from. */
  waveBranch(wave: number): string {
    return wave === 0 ? this.#options.plan.base_branch : `plan/${this.#options.plan.id}/wave-${wave}`
  }

  // -------------------------------------------------------------------------
  // Bases
  // -------------------------------------------------------------------------

  /** The topology rule, as a pure function of the graph. Builds nothing. */
  base(nodeId: string): BaseRef {
    const deps = this.#node(nodeId).depends_on.map((dep) => dep.node)
    const [first] = deps
    if (first === undefined) return { kind: 'base_branch', branch: this.#options.plan.base_branch }
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
      const conflict = await this.#merge(base.branch, dep, merged)
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
    return this.#options.plan.nodes
      .filter((node) => this.#waves.get(node.id) === wave)
      .map((node) => node.id)
  }

  /**
   * Builds `wave-<N>` by merging every wave-N node branch into `wave-<N-1>`,
   * `--no-ff`, in plan order.
   */
  async mergeWave(wave: number): Promise<WaveResult> {
    const cwd = this.#options.integrationPath
    const branch = this.waveBranch(wave)
    await git(cwd, ['checkout', '-B', branch, this.waveBranch(wave - 1)])

    const merged: string[] = []
    const conflicts: ConflictRecord[] = []
    for (const nodeId of this.nodesAt(wave)) {
      const conflict = await this.#merge(branch, nodeId, merged)
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

  // -------------------------------------------------------------------------
  // Pull requests
  // -------------------------------------------------------------------------

  /**
   * One PR per node, based on that node's own computed base — never
   * `base_branch` for a node that has dependencies, which would put every
   * upstream phase in the diff and make the review useless.
   *
   * Never throws: opening a PR is reporting, not the work. A missing `gh` is
   * a degraded result the caller shows the operator.
   */
  async openPr(nodeId: string, options: { readonly draft?: boolean } = {}): Promise<PrResult> {
    const node = this.#node(nodeId)
    return await openPullRequest({
      cwd: this.#options.integrationPath,
      nodeId,
      base: this.base(nodeId).branch,
      head: this.nodeBranch(nodeId),
      title: node.name,
      body: node.prompt_ref,
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
   * when a fixer resolved it, and throws `PlanDefectError` when no fixer round
   * did.
   */
  async #merge(
    into: string,
    nodeId: string,
    alreadyMerged: readonly string[],
  ): Promise<ConflictRecord | null> {
    const cwd = this.#options.integrationPath
    const incoming = this.nodeBranch(nodeId)
    // --no-ff always: a fast-forward erases that this was a separate phase,
    // and a squash erases the phase's unit commits.
    if (await gitOk(cwd, ['merge', '--no-ff', '--no-edit', incoming])) return null

    const paths = await this.#conflictedPaths()
    const nodes = await this.#owners(paths, alreadyMerged, nodeId)
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
      await this.#options.fixer.fix({ ...request, round })
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
        await git(cwd, ['commit', '--no-edit'])
      } else if (await this.#staged(cwd)) {
        // A fixer that committed and then refined — round 2 after a `verify`
        // refusal, typically. There is no prepared message to take, so this
        // one is written here: branch names and a round number, which are
        // identifiers (§11).
        await git(cwd, ['commit', '-m', `Resolve ${incoming} conflict (round ${round})`])
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
    throw new PlanDefectError(nodes, paths, this.#maxFixRounds)
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
        `${this.#options.plan.base_branch}...${this.nodeBranch(candidate)}`,
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
