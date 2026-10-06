/**
 * Layout is the one part with a stability contract rather than a behaviour, so
 * it is tested as a pure function: the same input twice, and an input with one
 * unrelated node added.
 */

import { describe, expect, it } from 'vitest'
import { layoutDag } from '../src/layout'
import type { Dag } from '../src/types'
import { SAMPLE } from './helpers'

const positions = (dag: Dag): Record<string, { x: number; y: number }> =>
  Object.fromEntries([...layoutDag(dag)].map(([id, point]) => [id, { ...point }]))

describe('layoutDag', () => {
  it('is deterministic across runs', () => {
    expect(positions(SAMPLE)).toEqual(positions(SAMPLE))
  })

  it('does not depend on the identity of an equal input', () => {
    expect(positions(structuredClone(SAMPLE))).toEqual(positions(SAMPLE))
  })

  it('bands by wave', () => {
    const laid = layoutDag(SAMPLE)
    expect(laid.get('a')?.x).toBeLessThan(laid.get('b')?.x ?? 0)
    expect(laid.get('b')?.x).toEqual(laid.get('c')?.x)
    expect(laid.get('b')?.x).toBeLessThan(laid.get('d')?.x ?? 0)
    expect(laid.get('b')?.y).not.toEqual(laid.get('c')?.y)
  })

  it('leaves every existing node where it was when an unrelated node is added', () => {
    const before = positions(SAMPLE)
    const after = positions({
      ...SAMPLE,
      nodes: [...SAMPLE.nodes, { id: 'e', name: 'Docs', status: 'pending', wave: 1 }],
    })
    for (const [id, point] of Object.entries(before)) expect(after[id]).toEqual(point)
  })

  it('honours an explicit position and keeps it out of the auto-laid slots', () => {
    const pinned: Dag = {
      ...SAMPLE,
      nodes: SAMPLE.nodes.map((node) =>
        node.id === 'b' ? { ...node, position: { x: 999, y: -40 } } : node,
      ),
    }
    const laid = layoutDag(pinned)
    expect(laid.get('b')).toEqual({ x: 999, y: -40 })
    // `c` was the second slot of wave 1; with `b` pinned it takes the first.
    expect(laid.get('c')?.y).toEqual(0)
  })
})
