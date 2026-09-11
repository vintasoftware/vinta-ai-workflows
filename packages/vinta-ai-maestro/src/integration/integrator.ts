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
  /** Overridden in tests so `gh` is never invoked against a real remote. */
  readonly ghPath?: string
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
    await git(cwd, ['checkout', '-B', base.branch, this.nodeBranch(first as string)])

    const merged = [first as string]
    for (const dep of rest) {
      await this.#merge(base.branch, dep, merged)
      merged.push(dep)
    }
    return base.branch
  }

  /**
   * Cuts the node's phase branch at its computed base, in the lane that will
   * run it. `checkout -B` creates the branch at the base without checking the
   * base out, so a base that is checked out in another worktree is fine.
   */
  async startNode(nodeId: string, lanePath: string): Promise<string> {
    const base = await this.prepareBase(nodeId)
    const branch = this.nodeBranch(nodeId)
    await git(lanePath, ['checkout', '-B', branch, base])
    return branch
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
      if (conflict) conflicts.push(conflict)
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

      // Staging someone else's resolution. The orchestrator authored none of it.
      await git(cwd, ['add', '--all'])
      if (this.#options.verify && !(await this.#options.verify(cwd))) continue

      await git(cwd, ['commit', '--no-edit'])
      return { nodes, paths, rounds: round }
    }

    // The conflicted merge is left in place deliberately: it is the only copy
    // of what the fixer tried, and it is what a human continuing by hand needs.
    throw new PlanDefectError(nodes, paths, this.#maxFixRounds)
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
