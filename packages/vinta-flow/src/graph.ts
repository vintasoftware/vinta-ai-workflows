/**
 * Pure graph operations over the plan DAG. No workflow parsing, no IO — the
 * scheduler and the validator both need these and neither should own them.
 */

export interface GraphNode {
  readonly id: string
  readonly depends_on: readonly { readonly node: string }[]
}

/**
 * Returns a cycle as the ids along it, with the entry point repeated at the
 * end (`['a','b','a']`), or null when the graph is acyclic.
 *
 * Reports the first cycle found rather than all of them: a workflow with a
 * cycle is not runnable, and one located example is what the author needs.
 */
export function findCycle(nodes: readonly GraphNode[]): string[] | null {
  const deps = new Map(nodes.map((n) => [n.id, n.depends_on.map((d) => d.node)]))
  const state = new Map<string, 'visiting' | 'done'>()
  const path: string[] = []

  const visit = (id: string): string[] | null => {
    const seen = state.get(id)
    if (seen === 'done') return null
    if (seen === 'visiting') return [...path.slice(path.indexOf(id)), id]

    state.set(id, 'visiting')
    path.push(id)
    for (const dep of deps.get(id) ?? []) {
      // Unknown ids are the validator's problem, not ours.
      if (!deps.has(dep)) continue
      const cycle = visit(dep)
      if (cycle) return cycle
    }
    path.pop()
    state.set(id, 'done')
    return null
  }

  for (const node of nodes) {
    const cycle = visit(node.id)
    if (cycle) return cycle
  }
  return null
}

/**
 * Every node that depends on `id`, directly or through a chain, in
 * breadth-first order. `id` itself is not included.
 *
 * This is failure containment (§6): a failed node blocks exactly this set, and
 * nothing outside it — every other branch of the graph keeps running, and the
 * nodes already in flight finish rather than being killed.
 *
 * Safe on a cyclic graph: each node is enqueued once, so a cycle upstream
 * cannot make this loop.
 */
export function transitiveDependents(nodes: readonly GraphNode[], id: string): string[] {
  const dependents = new Map<string, string[]>()
  for (const node of nodes) {
    for (const dep of node.depends_on) {
      const list = dependents.get(dep.node)
      if (list === undefined) dependents.set(dep.node, [node.id])
      else list.push(node.id)
    }
  }

  const blocked: string[] = []
  const seen = new Set<string>([id])
  const queue = [id]
  while (queue.length > 0) {
    for (const dependent of dependents.get(queue.shift() as string) ?? []) {
      if (seen.has(dependent)) continue
      seen.add(dependent)
      blocked.push(dependent)
      queue.push(dependent)
    }
  }
  return blocked
}

/**
 * Longest-path depth per node: 1 for a node with no dependencies, otherwise
 * one more than its deepest dependency.
 *
 * Waves are the durable spine — the resume anchor, the merge target, the
 * reporting unit. They are NOT the start gate: a node starts when its own
 * dependencies are green, not when its wave fills or drains.
 *
 * Throws on a cyclic graph; call `findCycle` first.
 */
export function computeWaves(nodes: readonly GraphNode[]): Map<string, number> {
  if (findCycle(nodes)) throw new Error('computeWaves called on a cyclic graph')

  const deps = new Map(nodes.map((n) => [n.id, n.depends_on.map((d) => d.node)]))
  const waves = new Map<string, number>()

  const waveOf = (id: string): number => {
    const cached = waves.get(id)
    if (cached !== undefined) return cached

    const known = (deps.get(id) ?? []).filter((d) => deps.has(d))
    const wave = known.length === 0 ? 1 : 1 + Math.max(...known.map(waveOf))
    waves.set(id, wave)
    return wave
  }

  for (const node of nodes) waveOf(node.id)
  return waves
}
