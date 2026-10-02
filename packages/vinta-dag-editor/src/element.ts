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
 *
 * Two things deliberately do *not* re-render: hovering a node (its edges are
 * pulled forward by toggling a class on them) and the tooltip (one element,
 * moved). Both happen on every pointer movement, and a rebuild per movement
 * would make the canvas feel like it was fighting the mouse.
 */

import type {
  DagChange,
  DagChangeDetail,
  DagNodeActivateDetail,
  DagRefuseDetail,
  DagSelectionChangeDetail,
} from './events'
import {
  DAG_CHANGE_EVENT,
  DAG_NODE_ACTIVATE_EVENT,
  DAG_REFUSE_EVENT,
  DAG_SELECTION_CHANGE_EVENT,
} from './events'
import { layoutDag } from './layout'
import type { NodePatch } from './model'
import {
  addEdge,
  addNode,
  edgeRefusal,
  removeEdge,
  removeNode,
  updateEdge,
  updateNode,
} from './model'
import { buildCanvas, handlePoint, placedAt, previewPath, sceneSize } from './scene'
import type { DagStringOverrides, DagStrings } from './strings'
import { DEFAULT_STRINGS, mergeStrings } from './strings'
import { STYLES } from './styles'
import type { Dag, DagMode, DagNodeStatus, DagPoint, DagSelection, DagViewport } from './types'
import { DAG_NODE_STATUSES } from './types'

const EMPTY_DAG: Dag = { nodes: [], edges: [] }
const ZOOM_STEP = 1.2
const ZOOM_RANGE = { min: 0.2, max: 3 }
/** Pointer travel below this is a click on the handle, not the start of a drag. */
const DRAG_THRESHOLD = 4
const SVG_NS = 'http://www.w3.org/2000/svg'

export class VintaDagElement extends HTMLElement {
  static readonly observedAttributes: readonly string[] = ['mode']

  readonly #root: ShadowRoot
  #value: Dag = EMPTY_DAG
  #strings: DagStrings = DEFAULT_STRINGS
  #mode: DagMode = 'read'
  #selection: DagSelection | null = null
  #viewport: DagViewport = { x: 0, y: 0, scale: 1 }
  #pending: string | null = null
  #fitted = false
  #resize: ResizeObserver | null = null
  #pan: { readonly x: number; readonly y: number; readonly origin: DagViewport } | null = null
  /** A dependency being dragged off a handle; `moved` separates it from a click. */
  #drag: {
    readonly source: string
    readonly x: number
    readonly y: number
    moved: boolean
  } | null = null
  /** The click the browser synthesises after a drag release is not a click on anything. */
  #swallowClick = false

  constructor() {
    super()
    this.#root = this.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = STYLES
    this.#root.append(style)
    this.#root.addEventListener('click', (event) => this.#onClick(event))
    this.#root.addEventListener('dblclick', (event) => this.#onDoubleClick(event))
    this.#root.addEventListener('change', (event) => this.#onChange(event))
    this.#root.addEventListener('keydown', (event) => {
      if (event instanceof KeyboardEvent) this.#onKeyDown(event)
    })
    this.#root.addEventListener('pointerover', (event) => this.#onPointerOver(event))
    this.#root.addEventListener('pointerout', (event) => this.#onPointerOut(event))
    this.#root.addEventListener('focusin', (event) => this.#showTooltip(event.target))
    this.#root.addEventListener('focusout', () => this.#hideTooltip())
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
    this.#watchSize()
  }

  disconnectedCallback(): void {
    this.#resize?.disconnect()
    this.#resize = null
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
    this.#zoomAt(factor, this.#viewportCentre())
  }

  /**
   * Frames the whole graph in the viewport, shrinking it if it does not fit.
   *
   * A plan of any size is wider than the panel it is drawn in, and what a
   * first-time viewer used to get was the first two waves and a clean vertical
   * cut where the rest should be — the canvas panned and zoomed, but nothing on
   * screen said so. So the first render of a non-empty graph frames it (below),
   * and this stays public and on a button for every render after that.
   */
  fitToContent(): void {
    this.#fitTo(layoutDag(this.#value))
  }

  /**
   * The first measurement can be a zero — the panel is still being laid out,
   * or is hidden — and a graph that never changes again has no second render
   * coming to try in. So the first frame is retried whenever the box changes
   * size, and the observer is dropped the moment it lands.
   */
  #watchSize(): void {
    if (this.#resize !== null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (!this.#fitted) this.#fitTo(layoutDag(this.#value))
      if (!this.#fitted) return
      observer.disconnect()
      this.#resize = null
    })
    observer.observe(this)
    this.#resize = observer
  }

  #render(): void {
    if (!this.isConnected) return
    const focused = actionOf(this.#root.activeElement)
    const positions = layoutDag(this.#value)
    for (const child of [...this.#root.children]) if (child.tagName !== 'STYLE') child.remove()
    this.#root.append(
      buildCanvas({
        doc: this.ownerDocument,
        dag: this.#value,
        positions,
        strings: this.#strings,
        mode: this.#mode,
        selection: this.#selection,
        pending: this.#pending,
      }),
    )
    this.#applyViewport()
    // Once only, and never again: after the first frame the viewport is the
    // viewer's, and a graph that re-framed itself on every status tick would
    // yank the canvas out from under whoever was reading it.
    if (!this.#fitted) this.#fitTo(positions)
    if (focused) this.#focus(focused.action, focused.id)
  }

  /**
   * The measurement is of the viewport only — the content's size comes from
   * the layout, not from the DOM — so an element that has not been laid out
   * yet, or is hidden, simply does not fit and is asked again on the next
   * render rather than being framed around a zero.
   */
  #fitTo(positions: ReadonlyMap<string, DagPoint>): void {
    if (this.#value.nodes.length === 0) return
    const viewport = this.#viewportElement()
    if (!viewport) return
    const box = viewport.getBoundingClientRect()
    const content = sceneSize(this.#value, positions)
    if (box.width <= 0 || box.height <= 0) return
    // Never magnifies: a graph smaller than its frame is shown at its own size
    // rather than blown up to fill one.
    const scale = clamp(
      Math.min(box.width / content.width, box.height / content.height),
      ZOOM_RANGE.min,
      1,
    )
    this.#viewport = {
      scale,
      x: (box.width - content.width * scale) / 2,
      y: (box.height - content.height * scale) / 2,
    }
    this.#fitted = true
    this.#applyViewport()
  }

  #applyViewport(): void {
    const scene = this.#root.querySelector('.scene')
    if (!(scene instanceof HTMLElement)) return
    const { x, y, scale } = this.#viewport
    scene.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
  }

  #viewportElement(): HTMLElement | null {
    const viewport = this.#root.querySelector('.viewport')
    return viewport instanceof HTMLElement ? viewport : null
  }

  #viewportCentre(): DagPoint {
    const box = this.#viewportElement()?.getBoundingClientRect()
    return { x: (box?.width ?? 0) / 2, y: (box?.height ?? 0) / 2 }
  }

  /** Scales about a point in viewport pixels, so that point stays where it is. */
  #zoomAt(factor: number, at: DagPoint): void {
    const scale = clamp(this.#viewport.scale * factor, ZOOM_RANGE.min, ZOOM_RANGE.max)
    const ratio = scale / this.#viewport.scale
    this.#viewport = {
      scale,
      x: at.x - (at.x - this.#viewport.x) * ratio,
      y: at.y - (at.y - this.#viewport.y) * ratio,
    }
    this.#applyViewport()
  }

  #onClick(event: Event): void {
    if (this.#swallowClick) {
      this.#swallowClick = false
      return
    }
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
    } else if (action === 'fit') {
      this.fitToContent()
    } else if (action === 'add-node') {
      const added = addNode(this.#value, this.#strings.newNodeName)
      this.#selection = { kind: 'node', id: added.nodeId }
      this.#commit(added.dag, { kind: 'node-add', nodeId: added.nodeId })
      // The new card, not the button that made it: the next thing to do is name it.
      this.#focus('select-node', added.nodeId)
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

  #onDoubleClick(event: Event): void {
    const control = actionOf(event.target)
    if (control?.action === 'select-node' && control.id !== undefined) this.#activate(control.id)
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
      this.#hideTooltip()
      this.#select(null, true)
      // #select is a no-op when nothing was selected, but a cancelled edge
      // still has to leave the screen.
      this.#render()
      return
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault()
      this.zoomBy(ZOOM_STEP)
      return
    }
    if (event.key === '-') {
      event.preventDefault()
      this.zoomBy(1 / ZOOM_STEP)
      return
    }
    if (event.key === '0') {
      event.preventDefault()
      this.fitToContent()
      return
    }
    if (!control?.id) return
    const { action, id } = control
    if (action === 'select-node' && event.key.startsWith('Arrow')) {
      event.preventDefault()
      this.#moveFocus(id, event.key)
      return
    }
    // Enter on the node that is already selected opens it; the platform's
    // click that follows re-selects it, which is a no-op. Not while a
    // dependency is being drawn: then Enter is how the keyboard closes it.
    if (
      event.key === 'Enter' &&
      action === 'select-node' &&
      this.#pending === null &&
      this.#selection?.kind === 'node' &&
      this.#selection.id === id
    ) {
      this.#activate(id)
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

  /**
   * Listened for on the host, where the target is retargeted to the host
   * itself; `composedPath()[0]` is the element actually under the pointer.
   */
  #onPointerDown(event: PointerEvent | MouseEvent): void {
    this.#swallowClick = false
    this.#hideTooltip()
    const target = event.composedPath()[0] ?? null
    const control = actionOf(target)
    if (control?.action === 'connect' && control.id !== undefined && this.#mode === 'edit') {
      this.#beginDrag(control.id, event)
      return
    }
    if (control) return
    if (event.button !== 0) return
    if (!(target instanceof Element) || !target.closest('.viewport')) return
    const viewport = this.#viewportElement()
    viewport?.classList.add('panning')
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
      viewport?.classList.remove('panning')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  /**
   * A dependency drawn by dragging: off a node's handle, onto another node.
   *
   * The click-and-pick gesture stays — a press that never travels is left to
   * the click handler, which toggles the source as before — so the two coexist
   * and the keyboard path is unchanged. Once the pointer has travelled, the
   * source is marked pending (so every card says whether it would accept the
   * drop), a dashed preview follows the pointer, and release on a card closes
   * the edge or reports why it cannot. Release anywhere else cancels.
   */
  #beginDrag(source: string, event: PointerEvent | MouseEvent): void {
    const drag = { source, x: event.clientX, y: event.clientY, moved: false }
    this.#drag = drag
    const move = (moved: PointerEvent | MouseEvent): void => {
      if (this.#drag !== drag) return
      if (!drag.moved) {
        if (Math.hypot(moved.clientX - drag.x, moved.clientY - drag.y) < DRAG_THRESHOLD) return
        drag.moved = true
        this.#pending = source
        this.#render()
      }
      this.#drawPreview(source, moved)
    }
    const stop = (up: PointerEvent | MouseEvent): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      if (this.#drag !== drag) return
      this.#drag = null
      this.#clearPreview()
      if (!drag.moved) return
      this.#swallowClick = true
      const target = this.#nodeAt(up.clientX, up.clientY)
      if (target !== null) this.#activateNode(target)
      else {
        this.#pending = null
        this.#render()
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  #drawPreview(source: string, at: { readonly clientX: number; readonly clientY: number }): void {
    const svg = this.#root.querySelector('.edges')
    const viewport = this.#viewportElement()
    if (!(svg instanceof SVGElement) || !viewport) return
    let path = svg.querySelector('.preview')
    if (!(path instanceof SVGElement)) {
      path = this.ownerDocument.createElementNS(SVG_NS, 'path')
      path.setAttribute('class', 'edge preview')
      svg.append(path)
    }
    const box = viewport.getBoundingClientRect()
    const { x, y, scale } = this.#viewport
    const end = { x: (at.clientX - box.left - x) / scale, y: (at.clientY - box.top - y) / scale }
    const start = handlePoint(placedAt(layoutDag(this.#value), source))
    path.setAttribute('d', previewPath(start, end))
  }

  #clearPreview(): void {
    this.#root.querySelector('.edges .preview')?.remove()
  }

  /** The node card under a point on screen, if the platform can tell us. */
  #nodeAt(clientX: number, clientY: number): string | null {
    const root = this.#root as ShadowRoot & {
      elementFromPoint?: (x: number, y: number) => Element | null
    }
    if (typeof root.elementFromPoint !== 'function') return null
    const control = actionOf(root.elementFromPoint(clientX, clientY))
    return control?.action === 'select-node' && control.id !== undefined ? control.id : null
  }

  #onPointerOver(event: Event): void {
    const control = actionOf(event.target)
    this.#showTooltip(event.target)
    if (control?.action === 'select-node' && control.id !== undefined) this.#highlight(control.id)
  }

  #onPointerOut(event: Event): void {
    const control = actionOf(event.target)
    if (!control) return
    // Leaving one child of the control for another is not leaving the control.
    const next = event instanceof MouseEvent ? event.relatedTarget : null
    if (next instanceof Node && event.target instanceof Node && event.target.contains(next)) return
    this.#hideTooltip()
    if (control.action === 'select-node') this.#highlight(null)
  }

  /** Pulls a node's edges forward without a re-render. `null` lets go. */
  #highlight(nodeId: string | null): void {
    for (const edge of this.#root.querySelectorAll('.edge, .edge-label')) {
      if (!(edge instanceof HTMLElement || edge instanceof SVGElement)) continue
      const hot = nodeId !== null && (edge.dataset.from === nodeId || edge.dataset.to === nodeId)
      edge.classList.toggle('hot', hot)
    }
  }

  /**
   * The full text of whatever is under the pointer or has focus — a name the
   * card clamps, an artifact the gap truncates, an icon button's label. One
   * element, moved; shown for a card or a label only when its text does not
   * already fit, so a short name is not repeated under itself.
   */
  #showTooltip(target: EventTarget | null): void {
    const source = target instanceof Element ? target.closest('[data-tooltip]') : null
    const viewport = this.#viewportElement()
    if (!(source instanceof HTMLElement) || !viewport?.contains(source)) {
      this.#hideTooltip()
      return
    }
    const clipped = source.querySelector('.node-name, .edge-label') ?? source
    if (
      (source.classList.contains('node') || source.classList.contains('edge-label')) &&
      clipped.scrollWidth <= clipped.clientWidth &&
      clipped.scrollHeight <= clipped.clientHeight
    ) {
      this.#hideTooltip()
      return
    }
    const existing = viewport.querySelector('.tooltip')
    let tooltip: HTMLElement
    if (existing instanceof HTMLElement) tooltip = existing
    else {
      tooltip = this.ownerDocument.createElement('div')
      tooltip.className = 'tooltip'
      tooltip.setAttribute('role', 'tooltip')
      viewport.append(tooltip)
    }
    tooltip.textContent = source.dataset.tooltip ?? ''
    const box = viewport.getBoundingClientRect()
    const at = source.getBoundingClientRect()
    tooltip.style.left = `${clamp(at.left - box.left + at.width / 2, 12, Math.max(12, box.width - 12))}px`
    tooltip.style.top = `${at.bottom - box.top + 6}px`
    tooltip.hidden = false
  }

  #hideTooltip(): void {
    const tooltip = this.#root.querySelector('.tooltip')
    if (tooltip instanceof HTMLElement) tooltip.hidden = true
  }

  /**
   * Zoom is on the wheel only with ⌘ or Ctrl held — which is also how a
   * trackpad pinch arrives. A bare wheel is left to the page: this canvas sits
   * in a page that scrolls, and a strip of it that swallowed every wheel event
   * was a wall the operator had to steer the pointer around.
   */
  #onWheel(event: WheelEvent): void {
    if (!(event.ctrlKey || event.metaKey)) return
    event.preventDefault()
    const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
    // Keep the point under the cursor still, so zooming reads as magnifying
    // what the user is looking at rather than as the graph sliding away.
    const box = this.#viewportElement()?.getBoundingClientRect() ?? this.getBoundingClientRect()
    this.#zoomAt(factor, { x: event.clientX - box.left, y: event.clientY - box.top })
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
      const reason = edgeRefusal(this.#value, source, id)
      if (reason !== null) {
        const detail: DagRefuseDetail = { from: source, to: id, reason }
        this.dispatchEvent(
          new CustomEvent(DAG_REFUSE_EVENT, { detail, bubbles: true, composed: true }),
        )
      }
      return
    }
    const added = next.edges[next.edges.length - 1]
    if (!added) return
    this.#selection = { kind: 'edge', id: added.id }
    this.#commit(next, { kind: 'edge-add', edgeId: added.id })
  }

  /** A node opened, as opposed to selected. What that means is the host's. */
  #activate(nodeId: string): void {
    const detail: DagNodeActivateDetail = { nodeId }
    this.dispatchEvent(
      new CustomEvent(DAG_NODE_ACTIVATE_EVENT, { detail, bubbles: true, composed: true }),
    )
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
