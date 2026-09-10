/**
 * The `<vinta-dag>` custom element: state, input handling, and the events.
 *
 * It owns nothing durable. The host injects the `Dag`, every edit produces a new
 * one through `model.ts` and leaves on a `CustomEvent`, and the host decides
 * whether it sticks — so the run view can render a projection of the journal and
 * the editor can persist, from the same component in two modes.
 *
 * Rendering rebuilds the shadow tree from scratch on every change rather than
 * diffing. A plan DAG is tens of nodes, the input is immutable so there is
 * nothing to reconcile, and the only cost is focus, which `#render` restores by
 * the control's action/id pair.
 */

import type { DagChange, DagChangeDetail, DagSelectionChangeDetail } from './events'
import { DAG_CHANGE_EVENT, DAG_SELECTION_CHANGE_EVENT } from './events'
import { layoutDag } from './layout'
import type { NodePatch } from './model'
import { addEdge, addNode, removeEdge, removeNode, updateEdge, updateNode } from './model'
import { buildCanvas } from './scene'
import type { DagStringOverrides, DagStrings } from './strings'
import { DEFAULT_STRINGS, mergeStrings } from './strings'
import { STYLES } from './styles'
import type { Dag, DagMode, DagNodeStatus, DagSelection, DagViewport } from './types'
import { DAG_NODE_STATUSES } from './types'

const EMPTY_DAG: Dag = { nodes: [], edges: [] }
const ZOOM_STEP = 1.2
const ZOOM_RANGE = { min: 0.2, max: 3 }

export class VintaDagElement extends HTMLElement {
  static readonly observedAttributes: readonly string[] = ['mode']

  readonly #root: ShadowRoot
  #value: Dag = EMPTY_DAG
  #strings: DagStrings = DEFAULT_STRINGS
  #mode: DagMode = 'read'
  #selection: DagSelection | null = null
  #viewport: DagViewport = { x: 0, y: 0, scale: 1 }
  #pending: string | null = null
  #pan: { readonly x: number; readonly y: number; readonly origin: DagViewport } | null = null

  constructor() {
    super()
    this.#root = this.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = STYLES
    this.#root.append(style)
    this.#root.addEventListener('click', (event) => this.#onClick(event))
    this.#root.addEventListener('change', (event) => this.#onChange(event))
    this.#root.addEventListener('keydown', (event) => {
      if (event instanceof KeyboardEvent) this.#onKeyDown(event)
    })
    this.addEventListener('pointerdown', (event) => this.#onPointerDown(event))
    this.addEventListener('wheel', (event) => this.#onWheel(event), { passive: false })
  }

  get value(): Dag {
    return this.#value
  }

  set value(next: Dag) {
    this.#adopt(next)
    this.#render()
  }

  get mode(): DagMode {
    return this.#mode
  }

  set mode(next: DagMode) {
    if (this.#mode === next) return
    this.#mode = next
    this.#pending = null
    this.setAttribute('mode', next)
    this.#render()
  }

  /** Reading back gives the full merged set, so a host can inspect defaults. */
  get strings(): DagStrings {
    return this.#strings
  }

  set strings(next: DagStringOverrides | undefined) {
    this.#strings = mergeStrings(next)
    this.#render()
  }

  get selection(): DagSelection | null {
    return this.#selection
  }

  set selection(next: DagSelection | null) {
    this.#select(next, false)
  }

  get viewport(): DagViewport {
    return this.#viewport
  }

  set viewport(next: DagViewport) {
    this.#viewport = next
    this.#applyViewport()
  }

  connectedCallback(): void {
    this.#render()
  }

  attributeChangedCallback(name: string, _old: string | null, next: string | null): void {
    if (name !== 'mode') return
    const mode: DagMode = next === 'edit' ? 'edit' : 'read'
    if (mode === this.#mode) return
    this.#mode = mode
    this.#pending = null
    this.#render()
  }

  zoomBy(factor: number): void {
    const scale = clamp(this.#viewport.scale * factor, ZOOM_RANGE.min, ZOOM_RANGE.max)
    this.#viewport = { ...this.#viewport, scale }
    this.#applyViewport()
  }

  #render(): void {
    if (!this.isConnected) return
    const focused = actionOf(this.#root.activeElement)
    for (const child of [...this.#root.children]) if (child.tagName !== 'STYLE') child.remove()
    this.#root.append(
      buildCanvas({
        doc: this.ownerDocument,
        dag: this.#value,
        positions: layoutDag(this.#value),
        strings: this.#strings,
        mode: this.#mode,
        selection: this.#selection,
        pending: this.#pending,
      }),
    )
    this.#applyViewport()
    if (focused) this.#focus(focused.action, focused.id)
  }

  #applyViewport(): void {
    const scene = this.#root.querySelector('.scene')
    if (!(scene instanceof HTMLElement)) return
    const { x, y, scale } = this.#viewport
    scene.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
  }

  #onClick(event: Event): void {
    const control = actionOf(event.target)
    if (!control) {
      // Only the canvas itself clears the selection; the inspector sits outside
      // it precisely so clicking a field label does not deselect what it edits.
      const target = event.target
      if (target instanceof Element && target.closest('.viewport')) this.#select(null, true)
      return
    }
    const { action, id } = control
    if (action === 'zoom-in') {
      this.zoomBy(ZOOM_STEP)
    } else if (action === 'zoom-out') {
      this.zoomBy(1 / ZOOM_STEP)
    } else if (action === 'add-node') {
      const added = addNode(this.#value, this.#strings.newNodeName)
      this.#selection = { kind: 'node', id: added.nodeId }
      this.#commit(added.dag, { kind: 'node-add', nodeId: added.nodeId })
    } else if (id !== undefined) {
      this.#onEntityClick(action, id)
    }
  }

  #onEntityClick(action: string, id: string): void {
    if (action === 'select-node') {
      this.#activateNode(id)
    } else if (action === 'select-edge') {
      this.#select({ kind: 'edge', id }, true)
    } else if (action === 'connect') {
      this.#pending = this.#pending === id ? null : id
      this.#render()
    } else if (action === 'delete-node') {
      this.#deleteNode(id)
    } else if (action === 'delete-edge') {
      this.#deleteEdge(id)
    }
  }

  #onChange(event: Event): void {
    const target = event.target
    const action = actionOf(target)?.action
    const selected = this.#selection
    if (!action || !selected) return
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return
    if (action === 'edge-artifact') {
      const edgeId = selected.id
      this.#commit(updateEdge(this.#value, edgeId, target.value), { kind: 'edge-update', edgeId })
      return
    }
    const patch = nodePatch(action, target.value)
    if (!patch) return
    const nodeId = selected.id
    this.#commit(updateNode(this.#value, nodeId, patch), { kind: 'node-update', nodeId })
  }

  #onKeyDown(event: KeyboardEvent): void {
    const target = event.target
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) return
    const control = actionOf(target)
    if (event.key === 'Escape') {
      this.#pending = null
      this.#select(null, true)
      // #select is a no-op when nothing was selected, but a cancelled edge
      // still has to leave the screen.
      this.#render()
      return
    }
    if (!control?.id) return
    const { action, id } = control
    if (action === 'select-node' && event.key.startsWith('Arrow')) {
      event.preventDefault()
      this.#moveFocus(id, event.key)
      return
    }
    if (this.#mode !== 'edit') return
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      if (action === 'select-node') this.#deleteNode(id)
      else if (action === 'select-edge') this.#deleteEdge(id)
      return
    }
    if (event.key === 'e' && action === 'select-node') {
      event.preventDefault()
      // Pressing it on a second node closes the edge; anywhere else it toggles
      // the source, so the same key both starts and cancels the gesture.
      if (this.#pending !== null && this.#pending !== id) this.#activateNode(id)
      else {
        this.#pending = this.#pending === id ? null : id
        this.#render()
      }
    }
  }

  #onPointerDown(event: PointerEvent | MouseEvent): void {
    if (actionOf(event.target)) return
    this.#pan = { x: event.clientX, y: event.clientY, origin: this.#viewport }
    const move = (moved: PointerEvent | MouseEvent): void => {
      const pan = this.#pan
      if (!pan) return
      this.#viewport = {
        ...pan.origin,
        x: pan.origin.x + (moved.clientX - pan.x),
        y: pan.origin.y + (moved.clientY - pan.y),
      }
      this.#applyViewport()
    }
    const stop = (): void => {
      this.#pan = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  #onWheel(event: WheelEvent): void {
    event.preventDefault()
    const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
    const scale = clamp(this.#viewport.scale * factor, ZOOM_RANGE.min, ZOOM_RANGE.max)
    // Keep the point under the cursor still, so zooming reads as magnifying
    // what the user is looking at rather than as the graph sliding away.
    const ratio = scale / this.#viewport.scale
    const box = this.getBoundingClientRect()
    const cursor = { x: event.clientX - box.left, y: event.clientY - box.top }
    this.#viewport = {
      scale,
      x: cursor.x - (cursor.x - this.#viewport.x) * ratio,
      y: cursor.y - (cursor.y - this.#viewport.y) * ratio,
    }
    this.#applyViewport()
  }

  /** Clicking or Entering a node either completes a pending edge or selects it. */
  #activateNode(id: string): void {
    const source = this.#pending
    if (source === null || this.#mode !== 'edit') {
      this.#select({ kind: 'node', id }, true)
      return
    }
    this.#pending = null
    const next = addEdge(this.#value, source, id, this.#strings.newEdgeArtifact)
    if (!next) {
      this.#render()
      return
    }
    const added = next.edges[next.edges.length - 1]
    if (!added) return
    this.#selection = { kind: 'edge', id: added.id }
    this.#commit(next, { kind: 'edge-add', edgeId: added.id })
  }

  #deleteNode(id: string): void {
    if (this.#mode !== 'edit') return
    this.#commit(removeNode(this.#value, id), { kind: 'node-remove', nodeId: id })
  }

  #deleteEdge(id: string): void {
    if (this.#mode !== 'edit') return
    this.#commit(removeEdge(this.#value, id), { kind: 'edge-remove', edgeId: id })
  }

  /**
   * A new value can have removed whatever was selected or half-connected —
   * deleting a node takes its edges with it — so both are re-checked in the one
   * place every new value passes through.
   */
  #adopt(next: Dag): void {
    this.#value = next
    if (this.#selection && !this.#exists(this.#selection)) this.#selection = null
    if (this.#pending !== null && !next.nodes.some((node) => node.id === this.#pending)) {
      this.#pending = null
    }
  }

  #commit(next: Dag, change: DagChange): void {
    this.#adopt(next)
    this.#render()
    const detail: DagChangeDetail = { value: next, change }
    this.dispatchEvent(new CustomEvent(DAG_CHANGE_EVENT, { detail, bubbles: true, composed: true }))
  }

  #select(next: DagSelection | null, notify: boolean): void {
    if (next?.kind === this.#selection?.kind && next?.id === this.#selection?.id) return
    this.#selection = next && this.#exists(next) ? next : null
    this.#render()
    if (!notify) return
    const detail: DagSelectionChangeDetail = { selection: this.#selection }
    this.dispatchEvent(
      new CustomEvent(DAG_SELECTION_CHANGE_EVENT, { detail, bubbles: true, composed: true }),
    )
  }

  #exists(selection: DagSelection): boolean {
    const pool = selection.kind === 'node' ? this.#value.nodes : this.#value.edges
    return pool.some((entry) => entry.id === selection.id)
  }

  /** Arrows walk the graph itself: across an edge, or along the current wave. */
  #moveFocus(id: string, key: string): void {
    if (key === 'ArrowRight' || key === 'ArrowLeft') {
      const forward = key === 'ArrowRight'
      const edge = this.#value.edges.find((candidate) =>
        forward ? candidate.from === id : candidate.to === id,
      )
      if (edge) this.#focus('select-node', forward ? edge.to : edge.from)
      return
    }
    const current = this.#value.nodes.find((node) => node.id === id)
    if (!current) return
    // Ordered by where they ended up, not by array order, so up and down match
    // what the user sees after crossing reduction moved things.
    const positions = layoutDag(this.#value)
    const band = this.#value.nodes
      .filter((node) => node.wave === current.wave)
      .sort((a, b) => (positions.get(a.id)?.y ?? 0) - (positions.get(b.id)?.y ?? 0))
    const index = band.findIndex((node) => node.id === id)
    const next = band[index + (key === 'ArrowDown' ? 1 : -1)]
    if (next) this.#focus('select-node', next.id)
  }

  #focus(action: string, id?: string): void {
    for (const candidate of this.#root.querySelectorAll('[data-action]')) {
      if (!(candidate instanceof HTMLElement)) continue
      if (candidate.dataset.action === action && candidate.dataset.id === id) {
        candidate.focus()
        return
      }
    }
  }
}

function actionOf(
  target: EventTarget | null,
): { readonly action: string; readonly id: string | undefined } | null {
  if (!(target instanceof Element)) return null
  const control = target.closest('[data-action]')
  if (!(control instanceof HTMLElement)) return null
  const action = control.dataset.action
  return action === undefined ? null : { action, id: control.dataset.id }
}

/** Null for a field we do not know, or a value that is not a legal one. */
function nodePatch(action: string, value: string): NodePatch | null {
  if (action === 'node-name') return { name: value }
  if (action === 'node-status') return isStatus(value) ? { status: value } : null
  if (action === 'node-wave') {
    const wave = Number.parseInt(value, 10)
    return Number.isNaN(wave) ? null : { wave }
  }
  return null
}

function isStatus(value: string): value is DagNodeStatus {
  return DAG_NODE_STATUSES.some((status) => status === value)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
