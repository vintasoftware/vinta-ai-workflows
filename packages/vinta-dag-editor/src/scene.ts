/**
 * Builds the shadow DOM for one view of the graph.
 *
 * Pure: it reads a snapshot and returns a fragment, wiring no listeners. The
 * element delegates from the shadow root instead, reading `data-action` off the
 * clicked control, which is what lets this file stay a function of its input and
 * lets the element re-render by replacing the fragment wholesale.
 *
 * Nodes are HTML buttons rather than SVG shapes so keyboard focus, `aria-label`
 * and hit-target sizing are the platform's job and not ours; only the edges,
 * which are curves and are never focused, are SVG.
 */

import { BAND_GAP, NODE_HEIGHT, NODE_WIDTH } from './layout'
import type { DagStrings } from './strings'
import type { Dag, DagMode, DagNode, DagPoint, DagSelection } from './types'
import { DAG_NODE_STATUSES } from './types'

const SVG_NS = 'http://www.w3.org/2000/svg'
/** Leaves the top of the scene free for the wave labels. */
const BAND_LABEL_HEIGHT = 24
const PADDING = 24

export interface SceneView {
  readonly doc: Document
  readonly dag: Dag
  readonly positions: ReadonlyMap<string, DagPoint>
  readonly strings: DagStrings
  readonly mode: DagMode
  readonly selection: DagSelection | null
  /** Node the user is drawing a dependency from, if any. */
  readonly pending: string | null
}

export function buildCanvas(view: SceneView): DocumentFragment {
  const fragment = view.doc.createDocumentFragment()
  if (view.mode === 'edit') fragment.append(buildToolbar(view))

  const viewport = create(view.doc, 'section', 'viewport')
  viewport.setAttribute('part', 'viewport')
  viewport.setAttribute('aria-label', view.strings.canvas)
  viewport.append(buildScene(view), buildViewControls(view))
  fragment.append(viewport)

  const inspector = view.mode === 'edit' ? buildInspector(view) : null
  if (inspector) fragment.append(inspector)
  return fragment
}

function buildToolbar(view: SceneView): HTMLElement {
  const toolbar = create(view.doc, 'div', 'toolbar')
  toolbar.setAttribute('part', 'toolbar')
  toolbar.append(button(view.doc, 'add-node', view.strings.addNode))
  const source = view.pending
  if (source !== null) {
    const hint = create(view.doc, 'p', 'hint')
    hint.setAttribute('role', 'status')
    hint.textContent = view.strings.connectHint({ name: nameOf(view.dag, source) })
    toolbar.append(hint)
  }
  return toolbar
}

/**
 * The zoom and fit controls, in **both** modes and inside the viewport.
 *
 * They used to be three buttons in the edit toolbar, which meant the run view
 * — the one that shows a graph too wide for its frame — offered no visible way
 * to reach the waves past the right edge. Panning and the wheel still work;
 * this is the affordance that says so.
 */
function buildViewControls(view: SceneView): HTMLElement {
  const controls = create(view.doc, 'div', 'view-controls')
  controls.setAttribute('part', 'view-controls')
  controls.append(
    button(view.doc, 'zoom-out', view.strings.zoomOut),
    button(view.doc, 'zoom-in', view.strings.zoomIn),
    button(view.doc, 'fit', view.strings.fitView),
  )
  return controls
}

/**
 * How much room the laid-out graph needs. Read from the layout rather than
 * from the DOM, so the element can frame the graph without measuring it —
 * which is also why it is a function and not two lines inside `buildScene`.
 */
export function sceneSize(
  dag: Dag,
  positions: ReadonlyMap<string, DagPoint>,
): { readonly width: number; readonly height: number } {
  const placed = dag.nodes.map((node) => shift(positions.get(node.id)))
  return {
    width: Math.max(...placed.map((at) => at.x + NODE_WIDTH), 0) + PADDING,
    height: Math.max(...placed.map((at) => at.y + NODE_HEIGHT), 0) + PADDING,
  }
}

function buildScene(view: SceneView): HTMLElement {
  const scene = create(view.doc, 'div', 'scene')
  const placed = view.dag.nodes.map((node) => ({
    node,
    at: shift(view.positions.get(node.id)),
  }))
  const { width, height } = sceneSize(view.dag, view.positions)
  scene.style.width = `${width}px`
  scene.style.height = `${height}px`

  scene.append(...bands(view, placed, height))
  scene.append(edgeLayer(view, placed, width, height))
  for (const { node, at } of placed) scene.append(...nodeControls(view, node, at))
  scene.append(...edgeLabels(view, placed))
  return scene
}

interface Placed {
  readonly node: DagNode
  readonly at: DagPoint
}

function bands(view: SceneView, placed: readonly Placed[], height: number): readonly HTMLElement[] {
  const extents = new Map<number, { left: number; right: number }>()
  for (const { node, at } of placed) {
    const extent = extents.get(node.wave)
    if (extent) {
      extent.left = Math.min(extent.left, at.x)
      extent.right = Math.max(extent.right, at.x + NODE_WIDTH)
    } else extents.set(node.wave, { left: at.x, right: at.x + NODE_WIDTH })
  }
  return [...extents.entries()]
    .sort((a, b) => a[0] - b[0])
    .flatMap(([wave, extent]) => {
      const band = create(view.doc, 'div', 'band')
      band.style.left = `${extent.left - 8}px`
      band.style.width = `${extent.right - extent.left + 16}px`
      band.style.height = `${height}px`
      const label = create(view.doc, 'div', 'band-label')
      label.style.left = `${extent.left}px`
      label.textContent = view.strings.wave({ wave })
      return [band, label]
    })
}

function edgeLayer(
  view: SceneView,
  placed: readonly Placed[],
  width: number,
  height: number,
): Element {
  const svg = view.doc.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'edges')
  svg.setAttribute('width', `${width}`)
  svg.setAttribute('height', `${height}`)
  svg.setAttribute('aria-hidden', 'true')
  for (const edge of view.dag.edges) {
    const ends = endpoints(placed, edge.from, edge.to)
    if (!ends) continue
    const path = view.doc.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', curve(ends.start, ends.end))
    svg.append(path)
  }
  return svg
}

function edgeLabels(view: SceneView, placed: readonly Placed[]): readonly HTMLElement[] {
  return view.dag.edges.flatMap((edge) => {
    const ends = endpoints(placed, edge.from, edge.to)
    if (!ends) return []
    const label = button(view.doc, 'select-edge', edge.artifact, edge.id)
    label.className = 'edge-label'
    label.setAttribute('part', 'edge')
    label.setAttribute(
      'aria-label',
      view.strings.edge({
        from: nameOf(view.dag, edge.from),
        to: nameOf(view.dag, edge.to),
        artifact: edge.artifact,
      }),
    )
    label.setAttribute('aria-pressed', String(isSelected(view.selection, 'edge', edge.id)))
    // The label is clipped to the width of the gap it sits in (see STYLES), so
    // the whole artifact has to be readable some other way than by looking.
    label.title = edge.artifact
    const at = labelPoint(ends.start, ends.end)
    label.style.left = `${at.x}px`
    label.style.top = `${at.y}px`
    return [label]
  })
}

function nodeControls(view: SceneView, node: DagNode, at: DagPoint): readonly HTMLElement[] {
  const card = button(view.doc, 'select-node', '', node.id)
  card.className = 'node'
  card.setAttribute('part', 'node')
  card.style.setProperty('--vdag-node-color', `var(--vdag-status-${node.status})`)
  card.style.left = `${at.x}px`
  card.style.top = `${at.y}px`
  card.style.width = `${NODE_WIDTH}px`
  card.style.minHeight = `${NODE_HEIGHT}px`
  const statusLabel = view.strings.status[node.status]
  card.setAttribute('aria-label', view.strings.node({ name: node.name, status: statusLabel }))
  card.setAttribute('aria-pressed', String(isSelected(view.selection, 'node', node.id)))
  card.append(
    text(view.doc, 'span', 'node-name', node.name),
    text(view.doc, 'span', 'node-status', statusLabel),
  )
  if (view.mode !== 'edit') return [card]

  const connect = button(view.doc, 'connect', '', node.id)
  connect.className = 'connect'
  connect.setAttribute('aria-label', view.strings.connect)
  connect.setAttribute('aria-pressed', String(view.pending === node.id))
  connect.style.left = `${at.x + NODE_WIDTH - 16}px`
  connect.style.top = `${at.y + NODE_HEIGHT / 2 - 16}px`
  return [card, connect]
}

function buildInspector(view: SceneView): HTMLElement | null {
  const selection = view.selection
  if (!selection) return null
  const inspector = create(view.doc, 'div', 'inspector')
  inspector.setAttribute('part', 'inspector')

  if (selection.kind === 'edge') {
    const edge = view.dag.edges.find((candidate) => candidate.id === selection.id)
    if (!edge) return null
    inspector.append(
      field(view.doc, view.strings.artifactField, input(view.doc, 'edge-artifact', edge.artifact)),
      button(view.doc, 'delete-edge', view.strings.deleteEdge, edge.id),
    )
    return inspector
  }

  const node = view.dag.nodes.find((candidate) => candidate.id === selection.id)
  if (!node) return null
  const status = create(view.doc, 'select')
  status.dataset.action = 'node-status'
  for (const value of DAG_NODE_STATUSES) {
    const option = create(view.doc, 'option')
    option.value = value
    option.textContent = view.strings.status[value]
    option.selected = value === node.status
    status.append(option)
  }
  const wave = input(view.doc, 'node-wave', String(node.wave))
  wave.type = 'number'
  inspector.append(
    field(view.doc, view.strings.nameField, input(view.doc, 'node-name', node.name)),
    field(view.doc, view.strings.statusField, status),
    field(view.doc, view.strings.waveField, wave),
    button(view.doc, 'delete-node', view.strings.deleteNode, node.id),
  )
  return inspector
}

function endpoints(
  placed: readonly Placed[],
  from: string,
  to: string,
): { readonly start: DagPoint; readonly end: DagPoint } | null {
  const source = placed.find((candidate) => candidate.node.id === from)
  const target = placed.find((candidate) => candidate.node.id === to)
  if (!source || !target) return null
  return {
    start: { x: source.at.x + NODE_WIDTH, y: source.at.y + NODE_HEIGHT / 2 },
    end: { x: target.at.x, y: target.at.y + NODE_HEIGHT / 2 },
  }
}

function curve(start: DagPoint, end: DagPoint): string {
  const bend = bendOf(start, end)
  return `M ${start.x} ${start.y} C ${start.x + bend} ${start.y} ${end.x - bend} ${end.y} ${end.x} ${end.y}`
}

function bendOf(start: DagPoint, end: DagPoint): number {
  return Math.max(40, (end.x - start.x) / 2)
}

/**
 * Where an edge's label sits: the middle of the empty band between the source
 * node and the next wave, at the height the curve passes through there.
 *
 * The midpoint of the whole edge was the obvious choice and the wrong one. A
 * label is as wide as its artifact name, and half of it landed on the node
 * card to the right; an edge that skips a wave put the label squarely on top
 * of a card in between. Both are gone if the label never leaves the one strip
 * of canvas that is guaranteed to be empty — the gap `layout.ts` leaves
 * between two bands — and the CSS caps the label at that strip's width.
 */
function labelPoint(start: DagPoint, end: DagPoint): DagPoint {
  const span = end.x - start.x
  // For a one-wave edge that is the curve's own midpoint; for a longer one it
  // is the part of the curve that crosses this gap.
  const t = span <= 0 ? 0.5 : Math.min(0.5, BAND_GAP / 2 / span)
  return { x: start.x + BAND_GAP / 2, y: curveY(start, end, t) }
}

/** The height of the same cubic `curve` draws, at `t`. Its control points share
 *  the endpoints' `y`, so only two terms of the polynomial survive. */
function curveY(start: DagPoint, end: DagPoint, t: number): number {
  const rest = 1 - t
  return (rest ** 3 + 3 * rest ** 2 * t) * start.y + (3 * rest * t ** 2 + t ** 3) * end.y
}

function shift(point: DagPoint | undefined): DagPoint {
  return { x: point?.x ?? 0, y: (point?.y ?? 0) + BAND_LABEL_HEIGHT }
}

function nameOf(dag: Dag, nodeId: string): string {
  return dag.nodes.find((node) => node.id === nodeId)?.name ?? nodeId
}

function isSelected(selection: DagSelection | null, kind: 'node' | 'edge', id: string): boolean {
  return selection?.kind === kind && selection.id === id
}

function create<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag)
  if (className) element.className = className
  return element
}

function text<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
  content: string,
): HTMLElementTagNameMap[K] {
  const element = create(doc, tag, className)
  element.textContent = content
  return element
}

function button(doc: Document, action: string, label: string, id?: string): HTMLButtonElement {
  const element = create(doc, 'button')
  element.type = 'button'
  element.dataset.action = action
  if (id !== undefined) element.dataset.id = id
  if (label) element.textContent = label
  return element
}

function input(doc: Document, action: string, value: string): HTMLInputElement {
  const element = create(doc, 'input')
  element.dataset.action = action
  element.value = value
  return element
}

function field(doc: Document, label: string, control: HTMLElement): HTMLLabelElement {
  const wrapper = create(doc, 'label')
  wrapper.append(text(doc, 'span', '', label), control)
  return wrapper
}
