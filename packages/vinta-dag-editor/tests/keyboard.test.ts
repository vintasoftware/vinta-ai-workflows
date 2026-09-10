/**
 * Everything the canvas can do has to be reachable without a mouse, so this
 * file drives it entirely from focus and key events.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { DAG_CHANGE_EVENT } from '../src/events'
import { control, mount, nodeCards, press, SAMPLE, shadow } from './helpers'

beforeEach(() => {
  document.body.replaceChildren()
})

describe('keyboard navigation', () => {
  it('reaches and selects every node', () => {
    const element = mount(SAMPLE)
    // Buttons in document order: the tab sequence, with no tabindex of ours.
    expect(nodeCards(element).map((card) => card.dataset.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(nodeCards(element).every((card) => card.tagName === 'BUTTON')).toBe(true)
    expect(nodeCards(element).some((card) => card.hasAttribute('tabindex'))).toBe(false)

    for (const { id } of SAMPLE.nodes) {
      const card = control(element, 'select-node', id)
      card.focus()
      expect(shadow(element).activeElement).toBe(card)
      // Enter and Space activate a focused button; the platform does that part.
      card.click()
      expect(element.selection).toEqual({ kind: 'node', id })
    }
  })

  it('traverses edges with the arrow keys', () => {
    const element = mount(SAMPLE)
    press(control(element, 'select-node', 'a'), 'ArrowRight')
    expect(shadow(element).activeElement).toBe(control(element, 'select-node', 'b'))
    press(control(element, 'select-node', 'b'), 'ArrowDown')
    expect(shadow(element).activeElement).toBe(control(element, 'select-node', 'c'))
    press(control(element, 'select-node', 'd'), 'ArrowLeft')
    expect(shadow(element).activeElement).toBe(control(element, 'select-node', 'b'))
  })

  it('draws and deletes with the keyboard alone', () => {
    const element = mount(SAMPLE, { mode: 'edit' })
    const kinds: string[] = []
    element.addEventListener(DAG_CHANGE_EVENT, (event) => {
      if (event instanceof CustomEvent) kinds.push(event.detail.change.kind)
    })

    press(control(element, 'select-node', 'b'), 'e')
    press(control(element, 'select-node', 'c'), 'e')
    expect(element.value.edges.some((edge) => edge.from === 'b' && edge.to === 'c')).toBe(true)

    press(control(element, 'select-node', 'd'), 'Delete')
    expect(element.value.nodes.map((node) => node.id)).toEqual(['a', 'b', 'c'])
    expect(kinds).toEqual(['edge-add', 'node-remove'])
  })

  it('cancels a half-drawn edge with Escape', () => {
    const element = mount(SAMPLE, { mode: 'edit' })
    press(control(element, 'select-node', 'b'), 'e')
    expect(shadow(element).querySelector('.hint')).not.toBeNull()
    press(control(element, 'select-node', 'b'), 'Escape')
    expect(shadow(element).querySelector('.hint')).toBeNull()
    control(element, 'select-node', 'c').click()
    expect(element.value.edges).toHaveLength(SAMPLE.edges.length)
  })

  it('ignores shortcuts typed into a field, and refuses edits in read mode', () => {
    const editing = mount(SAMPLE, { mode: 'edit' })
    control(editing, 'select-node', 'c').click()
    press(control(editing, 'node-name'), 'Delete')
    expect(editing.value.nodes).toHaveLength(SAMPLE.nodes.length)

    const reading = mount(SAMPLE, { mode: 'read' })
    press(control(reading, 'select-node', 'c'), 'Delete')
    press(control(reading, 'select-node', 'c'), 'e')
    expect(reading.value).toBe(SAMPLE)
  })

  it('keeps focus on the control that made the edit', () => {
    const element = mount(SAMPLE, { mode: 'edit' })
    control(element, 'select-node', 'c').click()
    const field = control(element, 'node-name')
    field.focus()
    if (field instanceof HTMLInputElement) {
      field.value = 'Renamed'
      field.dispatchEvent(new Event('change', { bubbles: true }))
    }
    expect(shadow(element).activeElement).toBe(control(element, 'node-name'))
  })
})
