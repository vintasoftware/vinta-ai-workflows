import { describe, expect, it } from 'vitest'
import { computeHeights } from '../src/graph.ts'

const node = (id: string, ...deps: string[]) => ({
  id,
  depends_on: deps.map((dep) => ({ node: dep })),
})

describe('computeHeights', () => {
  it('counts the longest chain still in front of each node', () => {
    // a → b → d, a → c, and a lone e
    const heights = computeHeights([
      node('a'),
      node('b', 'a'),
      node('c', 'a'),
      node('d', 'b'),
      node('e'),
    ])
    expect(Object.fromEntries(heights)).toEqual({ a: 3, b: 2, c: 1, d: 1, e: 1 })
  })

  it('throws on a cycle rather than recursing forever', () => {
    expect(() => computeHeights([node('a', 'b'), node('b', 'a')])).toThrow(/cyclic/)
  })
})
