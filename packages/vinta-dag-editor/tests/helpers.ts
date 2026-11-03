/**
 * Shared fixtures and DOM driving for the suite.
 *
 * `mount` is the only way the tests reach the element, so every test drives it
 * the way a host does — set properties, dispatch real events, read the shadow
 * tree — rather than calling internals that a browser could never call.
 */

import { defineDagEditor } from '../src/define'
import type { VintaDagElement } from '../src/element'
import type { DagStringOverrides } from '../src/strings'
import type { Dag, DagMode } from '../src/types'

defineDagEditor()

export const SAMPLE: Dag = {
  nodes: [
    { id: 'a', name: 'Schema', status: 'done', wave: 0, data: { owner: { team: 'core' } } },
    { id: 'b', name: 'API', status: 'running', wave: 1, data: { owner: { team: 'api' } } },
    { id: 'c', name: 'Client', status: 'pending', wave: 1 },
    { id: 'd', name: 'E2E', status: 'blocked', wave: 2 },
  ],
  edges: [
    { id: 'a-b', from: 'a', to: 'b', artifact: 'schema.json', data: { note: 'generated' } },
    { id: 'a-c', from: 'a', to: 'c', artifact: 'types.ts' },
    { id: 'b-d', from: 'b', to: 'd', artifact: 'openapi.yaml' },
    { id: 'c-d', from: 'c', to: 'd', artifact: 'bundle.js' },
  ],
  data: { runId: 'run-1' },
}

export function mount(
  value: Dag,
  options: { readonly mode?: DagMode; readonly strings?: DagStringOverrides } = {},
): VintaDagElement {
  const element = document.createElement('vinta-dag')
  if (!isDagElement(element)) throw new Error('vinta-dag was not registered')
  document.body.append(element)
  if (options.mode) element.mode = options.mode
  if (options.strings) element.strings = options.strings
  element.value = value
  return element
}

function isDagElement(element: HTMLElement): element is VintaDagElement {
  return 'value' in element && 'mode' in element
}

export function shadow(element: VintaDagElement): ShadowRoot {
  const root = element.shadowRoot
  if (!root) throw new Error('no shadow root')
  return root
}

export function control(element: VintaDagElement, action: string, id?: string): HTMLElement {
  const found = [...shadow(element).querySelectorAll('[data-action]')].find(
    (candidate) =>
      candidate instanceof HTMLElement &&
      candidate.dataset.action === action &&
      (id === undefined || candidate.dataset.id === id),
  )
  if (!(found instanceof HTMLElement)) throw new Error(`no control ${action}/${id ?? ''}`)
  return found
}

export function nodeCards(element: VintaDagElement): readonly HTMLElement[] {
  return [...shadow(element).querySelectorAll('.node')].filter(
    (card): card is HTMLElement => card instanceof HTMLElement,
  )
}

export function press(target: HTMLElement, key: string): void {
  target.focus()
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

export function setField(target: HTMLElement, value: string): void {
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) {
    throw new Error('not a form control')
  }
  target.value = value
  target.dispatchEvent(new Event('change', { bubbles: true }))
}

export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value
  for (const entry of Object.values(value)) deepFreeze(entry)
  return Object.freeze(value)
}
