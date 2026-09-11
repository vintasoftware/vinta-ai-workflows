/**
 * The element's contract with its host: it renders what it is given, it never
 * writes to it, and everything it changes leaves as a new value on an event.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { VintaDagElement } from '../src/element'
import type { DagChangeDetail, DagSelectionChangeDetail } from '../src/events'
import { DAG_CHANGE_EVENT, DAG_SELECTION_CHANGE_EVENT } from '../src/events'
import { BAND_GAP, layoutDag, NODE_WIDTH } from '../src/layout'
import { sceneSize } from '../src/scene'
import type { Dag } from '../src/types'
import { control, deepFreeze, mount, nodeCards, press, SAMPLE, setField, shadow } from './helpers'

/** An edge that skips a wave — the one whose label used to land on a card. */
const SKIPPING: Dag = {
  ...SAMPLE,
  edges: [
    ...SAMPLE.edges,
    { id: 'a-d', from: 'a', to: 'd', artifact: 'the BookmarkFolder model and its migration' },
  ],
}

beforeEach(() => {
  document.body.replaceChildren()
})

function changes(element: VintaDagElement): DagChangeDetail[] {
  const seen: DagChangeDetail[] = []
  element.addEventListener(DAG_CHANGE_EVENT, (event) => {
    if (event instanceof CustomEvent) seen.push(event.detail)
  })
  return seen
}

describe('rendering', () => {
  it('renders a bare Dag with nothing else injected', () => {
    const element = mount(SAMPLE)
    const root = shadow(element)
    expect(nodeCards(element)).toHaveLength(SAMPLE.nodes.length)
    expect(root.querySelectorAll('.edge-label')).toHaveLength(SAMPLE.edges.length)
    expect(root.querySelectorAll('.edges path')).toHaveLength(SAMPLE.edges.length)
    expect([...root.querySelectorAll('.band-label')].map((band) => band.textContent)).toEqual([
      'Wave 0',
      'Wave 1',
      'Wave 2',
    ])
    expect(root.querySelector('.viewport')?.getAttribute('aria-label')).toBe('Plan graph')
    expect(control(element, 'select-edge', 'a-b').getAttribute('aria-label')).toBe(
      'API depends on Schema for schema.json',
    )
  })

  it('renders an empty Dag', () => {
    const element = mount({ nodes: [], edges: [] })
    expect(nodeCards(element)).toHaveLength(0)
  })

  it('colours each node by status and labels it', () => {
    const element = mount(SAMPLE)
    const card = control(element, 'select-node', 'b')
    expect(card.style.getPropertyValue('--vdag-node-color')).toBe('var(--vdag-status-running)')
    expect(card.getAttribute('aria-label')).toBe('API, Running')
  })

  it('takes its mode from the attribute and reflects the property back', () => {
    const element = mount(SAMPLE)
    element.setAttribute('mode', 'edit')
    expect(element.mode).toBe('edit')
    expect(shadow(element).querySelector('.toolbar')).not.toBeNull()
    element.mode = 'read'
    expect(element.getAttribute('mode')).toBe('read')
    expect(shadow(element).querySelector('.toolbar')).toBeNull()
  })

  it('offers no edit affordances in read mode', () => {
    const element = mount(SAMPLE, { mode: 'read' })
    control(element, 'select-node', 'a').click()
    expect(shadow(element).querySelector('.toolbar')).toBeNull()
    expect(shadow(element).querySelector('.inspector')).toBeNull()
    expect(shadow(element).querySelector('.connect')).toBeNull()
  })
})

describe('edge labels', () => {
  // jsdom has no layout engine, so nothing here can prove two boxes do not
  // overlap. What it can prove is the placement rule that makes overlap
  // impossible: every label is inside the empty gap between two waves, which is
  // the one strip of canvas no card is ever drawn in.
  it('places every label in the empty gap beside its source', () => {
    const element = mount(SKIPPING)
    const positions = layoutDag(SKIPPING)
    for (const edge of SKIPPING.edges) {
      const left = Number.parseFloat(control(element, 'select-edge', edge.id).style.left)
      const gapStart = (positions.get(edge.from)?.x ?? 0) + NODE_WIDTH
      expect(left).toBeGreaterThanOrEqual(gapStart)
      expect(left).toBeLessThanOrEqual(gapStart + BAND_GAP)
    }
  })

  it('keeps the whole artifact reachable on a label the gap is too narrow for', () => {
    const element = mount(SKIPPING)
    const label = control(element, 'select-edge', 'a-d')
    // The CSS truncates; the name itself is still on the element, and still in
    // the sentence a screen reader is given.
    expect(label.textContent).toBe('the BookmarkFolder model and its migration')
    expect(label.title).toBe('the BookmarkFolder model and its migration')
    expect(label.getAttribute('aria-label')).toContain('the BookmarkFolder model and its migration')
  })
})

describe('framing', () => {
  const measured = HTMLElement.prototype.getBoundingClientRect

  /** jsdom measures everything as zero; the viewport needs a size to fit into. */
  function measure(width: number, height: number): void {
    HTMLElement.prototype.getBoundingClientRect = function rect(this: HTMLElement): DOMRect {
      const size = this.classList.contains('viewport') ? { width, height } : { width: 0, height: 0 }
      return {
        ...size,
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: size.width,
        bottom: size.height,
        toJSON: () => ({}),
      } as DOMRect
    }
  }

  afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = measured
  })

  it('frames the whole graph on the first render of a non-empty one', () => {
    measure(400, 200)
    const element = mount(SAMPLE)
    // Wide enough that the width is what binds: three waves in 400px.
    const fitted = 400 / sceneSize(SAMPLE, layoutDag(SAMPLE)).width
    expect(element.viewport.scale).toBeCloseTo(fitted, 5)
    expect(shadow(element).querySelector('.scene')).toHaveProperty(
      'style.transform',
      expect.stringContaining(`scale(${fitted})`),
    )
  })

  it('never magnifies a graph that already fits', () => {
    measure(4000, 2000)
    expect(mount(SAMPLE).viewport.scale).toBe(1)
  })

  it('frames it once, and then leaves the viewport to whoever is reading it', () => {
    measure(400, 200)
    const element = mount(SAMPLE)
    element.viewport = { x: 5, y: 6, scale: 2 }
    // A status tick is a new value, and it must not yank the canvas back.
    element.value = {
      ...SAMPLE,
      nodes: SAMPLE.nodes.map((node) => (node.id === 'b' ? { ...node, status: 'done' } : node)),
    }
    expect(element.viewport).toEqual({ x: 5, y: 6, scale: 2 })
    // The way back is a control, in read mode as much as in edit mode.
    control(element, 'fit').click()
    expect(element.viewport.scale).toBeCloseTo(400 / sceneSize(SAMPLE, layoutDag(SAMPLE)).width, 5)
  })

  it('does not frame an empty graph, and fits when it can finally be measured', () => {
    const element = mount({ nodes: [], edges: [] })
    expect(element.viewport).toEqual({ x: 0, y: 0, scale: 1 })
    // Unmeasurable (jsdom's zeros) is not fitted either — it is asked again.
    element.value = SAMPLE
    expect(element.viewport).toEqual({ x: 0, y: 0, scale: 1 })
    measure(400, 200)
    element.value = { ...SAMPLE }
    expect(element.viewport.scale).toBeCloseTo(400 / sceneSize(SAMPLE, layoutDag(SAMPLE)).width, 5)
  })
})

describe('selection', () => {
  it('selects a node and announces it', () => {
    const element = mount(SAMPLE)
    const seen: (DagSelectionChangeDetail | null)[] = []
    element.addEventListener(DAG_SELECTION_CHANGE_EVENT, (event) => {
      if (event instanceof CustomEvent) seen.push(event.detail)
    })
    control(element, 'select-node', 'c').click()
    expect(element.selection).toEqual({ kind: 'node', id: 'c' })
    expect(seen).toEqual([{ selection: { kind: 'node', id: 'c' } }])
    expect(control(element, 'select-node', 'c').getAttribute('aria-pressed')).toBe('true')
  })

  it('clears the selection on a canvas click', () => {
    const element = mount(SAMPLE)
    control(element, 'select-node', 'c').click()
    shadow(element)
      .querySelector('.viewport')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(element.selection).toBeNull()
  })
})

describe('editing', () => {
  it('emits a new Dag rather than the one it was given', () => {
    const element = mount(SAMPLE, { mode: 'edit' })
    const seen = changes(element)
    control(element, 'add-node').click()
    const first = seen[0]
    expect(first).toBeDefined()
    expect(first?.value).not.toBe(SAMPLE)
    expect(first?.value.nodes).not.toBe(SAMPLE.nodes)
    expect(first?.change).toEqual({ kind: 'node-add', nodeId: 'node' })
    expect(SAMPLE.nodes).toHaveLength(4)
  })

  it('draws a dependency edge between two nodes', () => {
    const element = mount(SAMPLE, { mode: 'edit' })
    const seen = changes(element)
    control(element, 'connect', 'b').click()
    expect(shadow(element).querySelector('.hint')?.textContent).toContain('API')
    control(element, 'select-node', 'c').click()
    expect(seen).toHaveLength(1)
    expect(element.value.edges.map((edge) => `${edge.from}>${edge.to}`)).toContain('b>c')
  })

  it('refuses an edge that would create a cycle', () => {
    const element = mount(SAMPLE, { mode: 'edit' })
    const seen = changes(element)
    control(element, 'connect', 'd').click()
    control(element, 'select-node', 'a').click()
    expect(seen).toHaveLength(0)
    expect(element.value.edges).toHaveLength(SAMPLE.edges.length)
  })

  it('deletes an edge, and a node with its edges', () => {
    const element = mount(SAMPLE, { mode: 'edit' })
    const seen = changes(element)
    control(element, 'select-edge', 'a-c').click()
    control(element, 'delete-edge', 'a-c').click()
    expect(element.value.edges.map((edge) => edge.id)).toEqual(['a-b', 'b-d', 'c-d'])
    control(element, 'select-node', 'b').click()
    control(element, 'delete-node', 'b').click()
    expect(element.value.nodes.map((node) => node.id)).toEqual(['a', 'c', 'd'])
    expect(element.value.edges.map((edge) => edge.id)).toEqual(['c-d'])
    expect(seen.map((detail) => detail.change.kind)).toEqual(['edge-remove', 'node-remove'])
  })

  it('edits a node through the inspector fields', () => {
    const element = mount(SAMPLE, { mode: 'edit' })
    const seen = changes(element)
    control(element, 'select-node', 'c').click()
    setField(control(element, 'node-name'), 'Web client')
    setField(control(element, 'node-status'), 'failed')
    setField(control(element, 'node-wave'), '3')
    const node = element.value.nodes.find((candidate) => candidate.id === 'c')
    expect(node).toMatchObject({ name: 'Web client', status: 'failed', wave: 3 })
    expect(seen).toHaveLength(3)
  })

  it('edits an edge artifact', () => {
    const element = mount(SAMPLE, { mode: 'edit' })
    control(element, 'select-edge', 'b-d').click()
    setField(control(element, 'edge-artifact'), 'contract.yaml')
    expect(element.value.edges.find((edge) => edge.id === 'b-d')?.artifact).toBe('contract.yaml')
  })

  it('preserves the host data blob verbatim through an unrelated edit', () => {
    const element = mount(SAMPLE, { mode: 'edit' })
    control(element, 'select-node', 'a').click()
    setField(control(element, 'node-name'), 'Renamed')
    const node = element.value.nodes.find((candidate) => candidate.id === 'a')
    const original = SAMPLE.nodes[0]
    expect(node?.data).toBe(original?.data)
    expect(node?.data).toEqual({ owner: { team: 'core' } })
    expect(element.value.edges[0]?.data).toEqual({ note: 'generated' })
    expect(element.value.data).toBe(SAMPLE.data)
  })
})

describe('immutability', () => {
  it('never writes to the Dag it is given', () => {
    const frozen = deepFreeze(structuredClone(SAMPLE))
    const snapshot = structuredClone(SAMPLE)
    const element = mount(frozen, { mode: 'edit' })
    // Every value the element hands back is frozen too, so a later edit that
    // mutated an intermediate result would throw just as loudly.
    element.addEventListener(DAG_CHANGE_EVENT, (event) => {
      if (event instanceof CustomEvent) deepFreeze(event.detail.value)
    })

    expect(() => {
      control(element, 'select-node', 'a').click()
      setField(control(element, 'node-name'), 'Schema v2')
      setField(control(element, 'node-status'), 'done')
      setField(control(element, 'node-wave'), '0')
      control(element, 'connect', 'b').click()
      control(element, 'select-node', 'c').click()
      control(element, 'select-edge', 'a-b').click()
      setField(control(element, 'edge-artifact'), 'schema.v2.json')
      control(element, 'delete-edge', 'a-b').click()
      control(element, 'add-node').click()
      press(control(element, 'select-node', 'd'), 'ArrowLeft')
      press(control(element, 'select-node', 'd'), 'ArrowUp')
      press(control(element, 'select-node', 'd'), 'Delete')
      press(control(element, 'select-node', 'a'), 'Escape')
      control(element, 'zoom-in').click()
      control(element, 'zoom-out').click()
      pan(element)
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }))
    }).not.toThrow()

    expect(frozen).toEqual(snapshot)
  })
})

describe('pan and zoom', () => {
  it('translates the scene on drag and scales it on wheel', () => {
    const element = mount(SAMPLE)
    pan(element)
    const scene = shadow(element).querySelector('.scene')
    expect(scene instanceof HTMLElement && scene.style.transform).toContain('translate(30px, 12px)')
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }))
    expect(element.viewport.scale).toBeGreaterThan(1)
    element.viewport = { x: 0, y: 0, scale: 1 }
    expect(scene instanceof HTMLElement && scene.style.transform).toContain('scale(1)')
  })
})

function pan(element: VintaDagElement): void {
  const viewport = shadow(element).querySelector('.viewport')
  viewport?.dispatchEvent(
    new MouseEvent('pointerdown', { bubbles: true, composed: true, clientX: 0, clientY: 0 }),
  )
  window.dispatchEvent(new MouseEvent('pointermove', { clientX: 30, clientY: 12 }))
  window.dispatchEvent(new MouseEvent('pointerup', {}))
}

describe('the value property', () => {
  it('drops a selection the new value no longer contains', () => {
    const element = mount(SAMPLE, { mode: 'edit' })
    control(element, 'select-node', 'd').click()
    const without: Dag = { ...SAMPLE, nodes: SAMPLE.nodes.filter((node) => node.id !== 'd') }
    element.value = without
    expect(element.selection).toBeNull()
    expect(shadow(element).querySelector('.inspector')).toBeNull()
  })
})
