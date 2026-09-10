/**
 * The edit operations, as pure functions over a `Dag`.
 *
 * The element never touches its input: every operation here builds new arrays
 * and new objects for what changed and reuses the rest by reference, so an
 * unchanged node is still the host's exact object — including the `data` blob,
 * which survives because we spread the node rather than rebuild it field by
 * field. Keeping them out of the element also makes them testable without a DOM
 * and reusable by a host that wants to apply the same edit itself.
 */

import type { Dag, DagNode } from './types'

export type NodePatch = Partial<Pick<DagNode, 'name' | 'status' | 'wave'>>

export function addNode(dag: Dag, name: string): { readonly dag: Dag; readonly nodeId: string } {
  const nodeId = freshId('node', new Set(dag.nodes.map((node) => node.id)))
  const node: DagNode = { id: nodeId, name, status: 'pending', wave: 0 }
  return { dag: { ...dag, nodes: [...dag.nodes, node] }, nodeId }
}

export function removeNode(dag: Dag, nodeId: string): Dag {
  return {
    ...dag,
    nodes: dag.nodes.filter((node) => node.id !== nodeId),
    edges: dag.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
  }
}

export function updateNode(dag: Dag, nodeId: string, patch: NodePatch): Dag {
  return {
    ...dag,
    nodes: dag.nodes.map((node) => (node.id === nodeId ? { ...node, ...patch } : node)),
  }
}

/**
 * Returns `null` when the edge would not leave a DAG behind — a self-loop, a
 * duplicate, or a cycle. Refusing here is cheaper than asking every host to
 * re-validate what the canvas just handed it.
 */
export function addEdge(dag: Dag, from: string, to: string, artifact: string): Dag | null {
  if (from === to) return null
  if (dag.edges.some((edge) => edge.from === from && edge.to === to)) return null
  if (reaches(dag, to, from)) return null
  const id = freshId(`${from}-${to}`, new Set(dag.edges.map((edge) => edge.id)))
  return { ...dag, edges: [...dag.edges, { id, from, to, artifact }] }
}

export function removeEdge(dag: Dag, edgeId: string): Dag {
  return { ...dag, edges: dag.edges.filter((edge) => edge.id !== edgeId) }
}

export function updateEdge(dag: Dag, edgeId: string, artifact: string): Dag {
  return {
    ...dag,
    edges: dag.edges.map((edge) => (edge.id === edgeId ? { ...edge, artifact } : edge)),
  }
}

function reaches(dag: Dag, from: string, to: string): boolean {
  const seen = new Set<string>()
  const queue = [from]
  while (queue.length > 0) {
    const current = queue.pop()
    if (current === undefined || seen.has(current)) continue
    if (current === to) return true
    seen.add(current)
    for (const edge of dag.edges) if (edge.from === current) queue.push(edge.to)
  }
  return false
}

function freshId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  let suffix = 2
  while (taken.has(`${base}-${suffix}`)) suffix += 1
  return `${base}-${suffix}`
}
