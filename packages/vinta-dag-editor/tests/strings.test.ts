/**
 * The rule is that no user-visible text is written in the component. Proving it
 * by reading the source would be a lint; proving it here is stronger: render
 * with every string replaced by a unique marker, then account for every
 * character on screen as either a marker or a value out of the host's `Dag`.
 * Anything left over is text the component invented, and a host translating it
 * would be stuck with English.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { VintaDagElement } from '../src/element'
import type { DagStrings } from '../src/strings'
import { DEFAULT_STRINGS, mergeStrings } from '../src/strings'
import { control, mount, SAMPLE, shadow } from './helpers'

const MARKED: DagStrings = {
  canvas: '⟦canvas⟧',
  addNode: '⟦addNode⟧',
  deleteNode: '⟦deleteNode⟧',
  deleteEdge: '⟦deleteEdge⟧',
  connect: '⟦connect⟧',
  connectHint: ({ name }) => `⟦connectHint⟧${name}`,
  zoomIn: '⟦zoomIn⟧',
  zoomOut: '⟦zoomOut⟧',
  nameField: '⟦nameField⟧',
  statusField: '⟦statusField⟧',
  waveField: '⟦waveField⟧',
  artifactField: '⟦artifactField⟧',
  wave: ({ wave }) => `⟦wave⟧${wave}`,
  node: ({ name, status }) => `⟦node⟧${name}${status}`,
  edge: ({ from, to, artifact }) => `⟦edge⟧${from}${to}${artifact}`,
  newNodeName: '⟦newNodeName⟧',
  newEdgeArtifact: '⟦newEdgeArtifact⟧',
  status: {
    pending: '⟦pending⟧',
    ready: '⟦ready⟧',
    waiting_on_capacity: '⟦capacity⟧',
    running: '⟦running⟧',
    awaiting_human: '⟦human⟧',
    done: '⟦done⟧',
    failed: '⟦failed⟧',
    blocked: '⟦blocked⟧',
  },
}

/** Everything that may legitimately appear: our markers, and the host's data. */
const ALLOWED: readonly string[] = [
  ...Object.values(MARKED.status),
  ...Object.values(MARKED).filter((value): value is string => typeof value === 'string'),
  ...SAMPLE.nodes.flatMap((node) => [node.name, String(node.wave)]),
  ...SAMPLE.edges.map((edge) => edge.artifact),
  '⟦connectHint⟧',
  '⟦wave⟧',
  '⟦node⟧',
  '⟦edge⟧',
].sort((a, b) => b.length - a.length)

function visibleText(root: ShadowRoot): readonly string[] {
  const found: string[] = []
  for (const element of root.querySelectorAll(':not(style)')) {
    for (const child of element.childNodes) {
      if (child.nodeType === child.TEXT_NODE && child.textContent) found.push(child.textContent)
    }
    for (const attribute of ['aria-label', 'title', 'placeholder']) {
      const value = element.getAttribute(attribute)
      if (value) found.push(value)
    }
  }
  return found
}

function leftover(text: string): string {
  let rest = text
  for (const allowed of ALLOWED) rest = rest.split(allowed).join('')
  return rest.trim()
}

function everySurface(element: VintaDagElement): readonly string[] {
  const seen: string[] = []
  control(element, 'select-node', 'b').click()
  seen.push(...visibleText(shadow(element)))
  control(element, 'connect', 'b').click()
  seen.push(...visibleText(shadow(element)))
  control(element, 'select-edge', 'a-b').click()
  seen.push(...visibleText(shadow(element)))
  return seen
}

beforeEach(() => {
  document.body.replaceChildren()
})

describe('strings', () => {
  it('leaks no text of its own with every string overridden', () => {
    const element = mount(SAMPLE, { mode: 'edit', strings: MARKED })
    for (const text of everySurface(element)) expect(leftover(text)).toBe('')
  })

  it('renders defaults when the host overrides nothing', () => {
    const element = mount(SAMPLE, { mode: 'edit' })
    control(element, 'select-node', 'b').click()
    expect(control(element, 'add-node').textContent).toBe(DEFAULT_STRINGS.addNode)
    expect(control(element, 'select-node', 'b').getAttribute('aria-label')).toBe('API, Running')
  })

  it('takes a partial override and keeps the rest', () => {
    const merged = mergeStrings({ addNode: '＋', status: { done: 'Shipped' } })
    expect(merged.addNode).toBe('＋')
    expect(merged.status.done).toBe('Shipped')
    expect(merged.status.running).toBe(DEFAULT_STRINGS.status.running)
    expect(merged.deleteNode).toBe(DEFAULT_STRINGS.deleteNode)
    expect(mergeStrings(undefined)).toBe(DEFAULT_STRINGS)
  })

  it('seeds new entities from the strings, never from a literal', () => {
    const element = mount(SAMPLE, { mode: 'edit', strings: MARKED })
    control(element, 'add-node').click()
    expect(element.value.nodes.at(-1)?.name).toBe('⟦newNodeName⟧')
    control(element, 'connect', 'b').click()
    control(element, 'select-node', 'c').click()
    expect(element.value.edges.at(-1)?.artifact).toBe('⟦newEdgeArtifact⟧')
  })
})
