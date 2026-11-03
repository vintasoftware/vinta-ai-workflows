/**
 * The gestures and feedback added on top of the click-and-pick editing model:
 * drag-to-connect, the hint about which targets a dependency may land on,
 * hover and tooltip, the opened-node event, and the refusal event. Each is
 * driven the way a browser would drive it; none reaches into the element.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { VintaDagElement } from '../src/element'
import type { DagChangeDetail, DagNodeActivateDetail, DagRefuseDetail } from '../src/events'
import { DAG_CHANGE_EVENT, DAG_NODE_ACTIVATE_EVENT, DAG_REFUSE_EVENT } from '../src/events'
import { control, mount, press, SAMPLE, shadow } from './helpers'

beforeEach(() => {
  document.body.replaceChildren()
})

function detailsOf<T>(element: VintaDagElement, type: string): T[] {
  const seen: T[] = []
  element.addEventListener(type, (event) => {
    if (event instanceof CustomEvent) seen.push(event.detail as T)
  })
  return seen
}

/** jsdom has no hit testing; the test says what is under the pointer. */
function underPointer(element: VintaDagElement, target: Element | null): void {
  const root = shadow(element) as ShadowRoot & { elementFromPoint?: () => Element | null }
  root.elementFromPoint = () => target
}

function drag(
  element: VintaDagElement,
  handle: HTMLElement,
  to: { readonly x: number; readonly y: number },
  dropOn: Element | null,
): void {
  handle.dispatchEvent(
    new MouseEvent('pointerdown', { bubbles: true, composed: true, clientX: 0, clientY: 0 }),
  )
  window.dispatchEvent(new MouseEvent('pointermove', { clientX: to.x, clientY: to.y }))
  underPointer(element, dropOn)
  window.dispatchEvent(new MouseEvent('pointerup', { clientX: to.x, clientY: to.y }))
}

describe('drawing a dependency by dragging', () => {
  it('closes the edge on the card the handle is dropped on', () => {
    const element = mount(SAMPLE, { mode: 'edit' })
    const seen = detailsOf<DagChangeDetail>(element, DAG_CHANGE_EVENT)
    drag(
      element,
      control(element, 'connect', 'b'),
      { x: 120, y: 40 },
      control(element, 'select-node', 'c'),
    )
    expect(seen.map((detail) => detail.change.kind)).toEqual(['edge-add'])
    expect(element.value.edges.some((edge) => edge.from === 'b' && edge.to === 'c')).toBe(true)
    // Nothing is left half-drawn, and the preview went with it.
    expect(shadow(element).querySelector('.hint')).toBeNull()
    expect(shadow(element).querySelector('.edges .preview')).toBeNull()
  })

  it('shows a preview and the legal targets while the pointer is down', () => {
    const element = mount(SAMPLE, { mode: 'edit' })
    control(element, 'connect', 'b').dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, composed: true, clientX: 0, clientY: 0 }),
    )
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 50, clientY: 50 }))
    expect(shadow(element).querySelector('.hint')?.textContent).toContain('API')
    expect(shadow(element).querySelector('.edges .preview')).not.toBeNull()
    expect(control(element, 'select-node', 'b').dataset.target).toBe('source')
    expect(control(element, 'select-node', 'c').dataset.target).toBe('ok')
    // `a` is upstream of `b`: an edge back to it would be a cycle, and `d` is
    // already a dependant.
    expect(control(element, 'select-node', 'a').dataset.target).toBe('refused')
    expect(control(element, 'select-node', 'd').dataset.target).toBe('refused')
    underPointer(element, null)
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 50, clientY: 50 }))
  })

  it('cancels when dropped on nothing, and swallows the click that follows', () => {
    const element = mount(SAMPLE, { mode: 'edit' })
    control(element, 'select-node', 'a').click()
    drag(element, control(element, 'connect', 'b'), { x: 300, y: 300 }, null)
    expect(shadow(element).querySelector('.hint')).toBeNull()
    expect(element.value.edges).toHaveLength(SAMPLE.edges.length)
    // The browser fires a click on the common ancestor after a drag; that must
    // not read as a click on the empty canvas and clear the selection.
    shadow(element)
      .querySelector('.viewport')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(element.selection).toEqual({ kind: 'node', id: 'a' })
  })

  it('leaves a press that never travelled to the click handler', () => {
    const element = mount(SAMPLE, { mode: 'edit' })
    const handle = control(element, 'connect', 'b')
    handle.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, composed: true, clientX: 0, clientY: 0 }),
    )
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 1, clientY: 1 }))
    expect(shadow(element).querySelector('.hint')).toBeNull()
    handle.click()
    expect(shadow(element).querySelector('.hint')).not.toBeNull()
  })
})

describe('refusals', () => {
  it('says why a dependency was not drawn', () => {
    const element = mount(SAMPLE, { mode: 'edit' })
    const refused = detailsOf<DagRefuseDetail>(element, DAG_REFUSE_EVENT)
    control(element, 'connect', 'd').click()
    control(element, 'select-node', 'a').click()
    control(element, 'connect', 'a').click()
    control(element, 'select-node', 'b').click()
    expect(refused).toEqual([
      { from: 'd', to: 'a', reason: 'cycle' },
      { from: 'a', to: 'b', reason: 'duplicate' },
    ])
  })
})

describe('opening a node', () => {
  it('is a double-click, or Enter on the node already selected', () => {
    const element = mount(SAMPLE)
    const opened = detailsOf<DagNodeActivateDetail>(element, DAG_NODE_ACTIVATE_EVENT)
    control(element, 'select-node', 'b').dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true }),
    )
    expect(opened).toEqual([{ nodeId: 'b' }])
    // Enter on a node that is not selected only selects it.
    press(control(element, 'select-node', 'c'), 'Enter')
    expect(opened).toHaveLength(1)
    control(element, 'select-node', 'c').click()
    press(control(element, 'select-node', 'c'), 'Enter')
    expect(opened).toEqual([{ nodeId: 'b' }, { nodeId: 'c' }])
  })
})

describe('focus and feedback', () => {
  it('marks the edges of the selected node and lets the rest recede', () => {
    const element = mount(SAMPLE)
    control(element, 'select-node', 'b').click()
    const root = shadow(element)
    expect(root.querySelector('.scene')?.hasAttribute('data-focus')).toBe(true)
    const linked = [...root.querySelectorAll('.edge[data-linked]')].map((path) =>
      path.getAttribute('data-edge'),
    )
    expect(linked.sort()).toEqual(['a-b', 'b-d'])
    expect(control(element, 'select-edge', 'a-b').hasAttribute('data-linked')).toBe(true)
    expect(control(element, 'select-node', 'a').hasAttribute('data-linked')).toBe(true)
    expect(control(element, 'select-node', 'c').hasAttribute('data-linked')).toBe(false)
  })

  it('pulls a hovered node’s edges forward without re-rendering', () => {
    const element = mount(SAMPLE)
    const root = shadow(element)
    const card = control(element, 'select-node', 'a')
    const scene = root.querySelector('.scene')
    card.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
    expect([...root.querySelectorAll('.edge.hot')].map((p) => p.getAttribute('data-edge'))).toEqual(
      ['a-b', 'a-c'],
    )
    expect(root.querySelector('.scene')).toBe(scene)
    card.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: root.host }))
    expect(root.querySelectorAll('.edge.hot')).toHaveLength(0)
  })

  it('shows the full label of a control under the pointer or in focus', () => {
    const element = mount(SAMPLE)
    const root = shadow(element)
    const fit = control(element, 'fit')
    fit.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
    const tooltip = root.querySelector('.tooltip')
    expect(tooltip).toBeInstanceOf(HTMLElement)
    expect(tooltip?.textContent).toBe(element.strings.fitView)
    expect((tooltip as HTMLElement).hidden).toBe(false)
    fit.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: root.host }))
    expect((tooltip as HTMLElement).hidden).toBe(true)
    control(element, 'zoom-in').focus()
    expect((root.querySelector('.tooltip') as HTMLElement).hidden).toBe(false)
    expect(root.querySelector('.tooltip')?.textContent).toBe(element.strings.zoomIn)
  })

  it('says so over an empty canvas', () => {
    const element = mount({ nodes: [], edges: [] })
    expect(shadow(element).querySelector('.empty')?.textContent).toBe(element.strings.empty)
    element.value = SAMPLE
    expect(shadow(element).querySelector('.empty')).toBeNull()
  })

  it('zooms from the keyboard and names the panning state', () => {
    const element = mount(SAMPLE)
    press(control(element, 'select-node', 'a'), '+')
    expect(element.viewport.scale).toBeGreaterThan(1)
    press(control(element, 'select-node', 'a'), '-')
    expect(element.viewport.scale).toBeCloseTo(1, 5)
    const viewport = shadow(element).querySelector('.viewport')
    viewport?.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, composed: true, clientX: 0, clientY: 0 }),
    )
    expect(viewport?.classList.contains('panning')).toBe(true)
    window.dispatchEvent(new MouseEvent('pointerup', {}))
    expect(viewport?.classList.contains('panning')).toBe(false)
  })

  it('does not pan from a press on the chrome around the canvas', () => {
    const element = mount(SAMPLE, { mode: 'edit' })
    shadow(element)
      .querySelector('.toolbar')
      ?.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, composed: true, clientX: 0, clientY: 0 }),
      )
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 30, clientY: 12 }))
    window.dispatchEvent(new MouseEvent('pointerup', {}))
    expect(element.viewport).toEqual({ x: 0, y: 0, scale: 1 })
  })

  it('focuses a node it has just added, so the next keystroke names it', () => {
    const element = mount(SAMPLE, { mode: 'edit' })
    control(element, 'add-node').click()
    expect(shadow(element).activeElement).toBe(control(element, 'select-node', 'node'))
  })
})
