/**
 * Wave-banded auto-layout with a crossing-reduction pass.
 *
 * Stability is the requirement that shapes this file, because the run view
 * re-lays out on every status tick and a graph that reshuffles is unreadable.
 * Two properties give it:
 *
 *   - The layout is a pure function of the input, with no randomness and no
 *     dependence on object identity or hash order. Same `Dag` in, same map out.
 *   - A node with nothing to sort it by keeps the slot it already has, so a
 *     node arriving elsewhere in the graph cannot displace it. Ordering starts
 *     from the input array order and only ever moves a node toward its
 *     neighbours, which means an unrelated addition moves nothing.
 *
 * The barycentre heuristic is the standard Sugiyama crossing-reduction pass. It
 * is not optimal — minimising crossings is NP-hard — and it does not need to be.
 */

import type { Dag, DagPoint } from './types'

export const NODE_WIDTH = 200
export const NODE_HEIGHT = 76
/**
 * The empty strip between two waves. It is wide enough to hold an edge's label
 * (`scene.ts` puts it there, `styles.ts` caps it at this width) rather than
 * only to separate two cards — the graph is framed to fit on first render, so
 * the cost of a roomier gap is a little scale, not a clipped view.
 */
export const BAND_GAP = 160
export const ROW_GAP = 36

/** Enough sweeps to settle a plan-sized graph; more buys nothing measurable. */
const PASSES = 4

export function layoutDag(dag: Dag): ReadonlyMap<string, DagPoint> {
  const positions = new Map<string, DagPoint>()
  const bands = new Map<number, string[]>()

  for (const node of dag.nodes) {
    if (node.position) {
      positions.set(node.id, node.position)
      continue
    }
    const band = bands.get(node.wave)
    if (band) band.push(node.id)
    else bands.set(node.wave, [node.id])
  }

  const ordered = [...bands.entries()].sort((a, b) => a[0] - b[0])
  const slots = new Map<string, number>()
  for (const [, band] of ordered) recordSlots(band, slots)

  const upstream = neighbours(dag, 'to', 'from')
  const downstream = neighbours(dag, 'from', 'to')
  for (let pass = 0; pass < PASSES; pass += 1) {
    // Alternating direction lets an ordering decided in one band propagate both
    // ways; sweeping only downward would leave the first band arbitrary.
    const anchors = pass % 2 === 0 ? upstream : downstream
    const sweep = pass % 2 === 0 ? ordered : [...ordered].reverse()
    for (const [, band] of sweep) {
      sortByBarycentre(band, slots, anchors)
      recordSlots(band, slots)
    }
  }

  for (const [wave, band] of ordered) {
    band.forEach((id, slot) => {
      positions.set(id, { x: wave * (NODE_WIDTH + BAND_GAP), y: slot * (NODE_HEIGHT + ROW_GAP) })
    })
  }
  return positions
}

function recordSlots(band: readonly string[], slots: Map<string, number>): void {
  band.forEach((id, index) => {
    slots.set(id, index)
  })
}

function neighbours(
  dag: Dag,
  self: 'from' | 'to',
  other: 'from' | 'to',
): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, string[]>()
  for (const edge of dag.edges) {
    const list = map.get(edge[self])
    if (list) list.push(edge[other])
    else map.set(edge[self], [edge[other]])
  }
  return map
}

function sortByBarycentre(
  band: string[],
  slots: ReadonlyMap<string, number>,
  anchors: ReadonlyMap<string, readonly string[]>,
): void {
  const keys = new Map<string, number>()
  band.forEach((id, index) => {
    const near = (anchors.get(id) ?? [])
      .map((neighbour) => slots.get(neighbour))
      .filter((slot): slot is number => slot !== undefined)
    keys.set(id, near.length > 0 ? median(near) : index)
  })
  // Sort is stable, so nodes that tie keep the order they arrived in.
  band.sort((a, b) => (keys.get(a) ?? 0) - (keys.get(b) ?? 0))
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[sorted.length >> 1] ?? 0
}
