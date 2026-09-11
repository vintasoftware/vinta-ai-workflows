/**
 * What an amendment *is*: the difference between a run's frozen snapshot and
 * the workflow proposed against it, classified per node, closed under
 * dependency.
 *
 * Pure. Nothing here reads a node's status, touches git or writes an event —
 * this answers "what moved and who does it reach", and `amend.ts` answers
 * "may it move, and what does moving it cost".
 *
 * Three decisions worth stating, because each one changes which nodes end up
 * in the affected set:
 *
 * - **Nodes are compared by their *effective* definition, not their literal
 *   one.** `defaults.harness`, `defaults.model`, `defaults.pipeline` and the
 *   workflow-level `gates` table are all resolved per node first, so changing
 *   a default or a gate's `cmd` surfaces as a change on exactly the nodes it
 *   reaches, rather than as an unclassifiable workflow-level edit that either
 *   affects everything or nothing.
 * - **`depends_on` is compared as an ordered list.** §8 merges an `integ-<id>`
 *   base in `depends_on` declaration order precisely so the result is
 *   derivable from the node alone; reordering it therefore rebuilds a
 *   different base and is its own kind rather than a no-op.
 * - **The closure is taken over the union of both graphs.** An edge that was
 *   removed only exists in the snapshot and an edge that was added only exists
 *   in the proposal; walking either graph alone would miss half the nodes a
 *   rebase has to reach.
 *
 * Every value produced here is an id or a member of a closed union. Node
 * names, `prompt_ref`s and gate commands are read to *detect* a change and
 * never carried out of this file.
 */
import { computeWaves, transitiveDependents, type GraphNode } from '../graph.ts'
import type { AmendmentChange, AmendmentKind } from '../journal/events.ts'
import type { Node, Workflow } from '../types.ts'

/** Kinds that move a node's *base*: what its branch is cut from. */
const TOPOLOGY_KINDS: ReadonlySet<AmendmentKind> = new Set<AmendmentKind>([
  'node_added',
  'node_removed',
  'dependency_added',
  'dependency_removed',
  'dependency_reordered',
  'base_branch_changed',
])

export interface WorkflowDiff {
  /** One entry per node per way it moved, in the proposal's node order. */
  readonly changes: readonly AmendmentChange[]
  /** The changed nodes plus their transitive dependents, topologically ordered. */
  readonly affected: readonly string[]
  /** Ids present in the snapshot and not in the proposal. */
  readonly removed: readonly string[]
  /** Ids present in the proposal and not in the snapshot. */
  readonly added: readonly string[]
  /** Affected nodes whose *base* moved — the ones a rebase has to reach. */
  readonly rebaseable: readonly string[]
  /** Changed nodes whose branch *content* would have to be rebuilt by an agent. */
  readonly contentChanged: readonly string[]
}

/** A node's definition with every workflow-level default already resolved. */
interface Effective {
  readonly deps: string
  readonly gates: string
  readonly harness: string
  readonly model: string
  readonly pipeline: string
  readonly body: string
}

export function diffWorkflows(before: Workflow, after: Workflow): WorkflowDiff {
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]))
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]))

  const changes: AmendmentChange[] = []
  const removed = before.nodes.filter((node) => !afterNodes.has(node.id)).map((node) => node.id)
  const added = after.nodes.filter((node) => !beforeNodes.has(node.id)).map((node) => node.id)

  for (const id of removed) changes.push({ node: id, kind: 'node_removed' })
  for (const id of added) changes.push({ node: id, kind: 'node_added' })

  for (const node of after.nodes) {
    const old = beforeNodes.get(node.id)
    if (old === undefined) continue
    for (const kind of kindsFor(effective(before, old), effective(after, node))) {
      changes.push({ node: node.id, kind })
    }
  }

  // `base_branch` is not a node's field, but it *is* every dependency-free
  // node's base. Attributing it to those nodes is what lets the closure below
  // carry it to everything downstream, exactly like any other base change.
  if (before.base_branch !== after.base_branch) {
    for (const node of after.nodes) {
      if (node.depends_on.length === 0) changes.push({ node: node.id, kind: 'base_branch_changed' })
    }
    for (const node of before.nodes) {
      if (node.depends_on.length === 0 && !afterNodes.has(node.id)) {
        changes.push({ node: node.id, kind: 'base_branch_changed' })
      }
    }
  }

  const union = unionGraph(before, after)
  const order = topoOrder(after)

  const affected = close(union, changes.map((change) => change.node))
  const rebaseable = close(
    union,
    changes.filter((change) => TOPOLOGY_KINDS.has(change.kind)).map((change) => change.node),
  )
  const contentChanged = [
    ...new Set(
      changes.filter((change) => !TOPOLOGY_KINDS.has(change.kind)).map((change) => change.node),
    ),
  ]

  return {
    changes,
    affected: sortBy(affected, order),
    removed,
    added,
    rebaseable: sortBy(rebaseable, order),
    contentChanged: sortBy(contentChanged, order),
  }
}

/**
 * Topological order for a workflow: dependency depth first, declaration order
 * within a depth. `computeWaves` gives every node a depth strictly greater
 * than each of its dependencies', so this really is topological — and it is
 * the same tie-break the scheduler and the wave merge already use, so a rebase
 * queue reads in the order the plan does.
 */
export function topoOrder(workflow: Workflow): string[] {
  const waves = computeWaves(workflow.nodes)
  return workflow.nodes
    .map((node, index) => ({ id: node.id, wave: waves.get(node.id) ?? 1, index }))
    .sort((a, b) => a.wave - b.wave || a.index - b.index)
    .map((entry) => entry.id)
}

/** The changed nodes plus everything downstream of them, in the union graph. */
function close(graph: readonly GraphNode[], seeds: readonly string[]): string[] {
  const reached = new Set<string>()
  for (const seed of seeds) {
    reached.add(seed)
    for (const dependent of transitiveDependents(graph, seed)) reached.add(dependent)
  }
  return [...reached]
}

/**
 * Both graphs at once: every id either declares, and every edge either
 * declares. A removed edge lives only in the snapshot and an added one only in
 * the proposal, so the closure has to see both to reach every node a rebase
 * touches.
 */
function unionGraph(before: Workflow, after: Workflow): GraphNode[] {
  const edges = new Map<string, Set<string>>()
  for (const workflow of [before, after]) {
    for (const node of workflow.nodes) {
      const set = edges.get(node.id) ?? new Set<string>()
      for (const dependency of node.depends_on) set.add(dependency.node)
      edges.set(node.id, set)
    }
  }
  return [...edges].map(([id, deps]) => ({
    id,
    depends_on: [...deps].map((node) => ({ node })),
  }))
}

/** `order` first, then anything it does not mention — removed nodes, mostly. */
function sortBy(ids: readonly string[], order: readonly string[]): string[] {
  const rank = new Map(order.map((id, index) => [id, index]))
  return [...ids].sort(
    (a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER),
  )
}

function effective(workflow: Workflow, node: Node): Effective {
  return {
    deps: JSON.stringify(node.depends_on.map((dependency) => dependency.node)),
    // The gate *definitions*, not their ids: a gate whose `cmd`, `requires` or
    // `timeout_s` changed is a different gate to every node that declares it.
    gates: JSON.stringify(node.gates.map((id) => [id, workflow.gates[id] ?? null])),
    harness: node.harness ?? workflow.defaults.harness,
    model: node.model ?? workflow.defaults.model,
    pipeline: node.pipeline ?? workflow.defaults.pipeline,
    body: JSON.stringify([node.name, node.prompt_ref, node.touches, node.max_fix_rounds]),
  }
}

function kindsFor(old: Effective, next: Effective): AmendmentKind[] {
  const kinds: AmendmentKind[] = []
  if (old.deps !== next.deps) {
    const before = JSON.parse(old.deps) as string[]
    const after = JSON.parse(next.deps) as string[]
    const gained = after.filter((id) => !before.includes(id))
    const lost = before.filter((id) => !after.includes(id))
    if (gained.length > 0) kinds.push('dependency_added')
    if (lost.length > 0) kinds.push('dependency_removed')
    if (gained.length === 0 && lost.length === 0) kinds.push('dependency_reordered')
  }
  if (old.gates !== next.gates) kinds.push('gates_changed')
  if (old.harness !== next.harness) kinds.push('harness_changed')
  if (old.model !== next.model) kinds.push('model_changed')
  if (old.pipeline !== next.pipeline) kinds.push('pipeline_changed')
  if (old.body !== next.body) kinds.push('body_changed')
  return kinds
}
