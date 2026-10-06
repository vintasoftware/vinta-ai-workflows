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
import { addEdge } from './model'
import type { DagStrings } from './strings'
import type { Dag, DagEdge, DagMode, DagNode, DagPoint, DagSelection } from './types'
import { DAG_NODE_STATUSES } from './types'

const SVG_NS = 'http://www.w3.org/2000/svg'
/** Leaves the top of each band free for its wave label. */
const BAND_LABEL_HEIGHT = 24
/** Air around the whole graph, so the first band is not flush with the frame. */
const PADDING = 24
/** How far short of the target card an edge stops, so the arrowhead meets the border. */
const ARROW_INSET = 2
const CONNECT_SIZE = 24
/** Two labels in one gap closer than this are pushed apart, in order of height. */
const LABEL_SPACING = 20

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

/** lucide-style strokes, 24-unit box. Inline because nothing outside the shadow root is ours. */
const ICONS = {
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  fit: 'M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  trash: 'M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
} as const

export function buildCanvas(view: SceneView): DocumentFragment {
  const fragment = view.doc.createDocumentFragment()
  if (view.mode === 'edit') fragment.append(buildToolbar(view))

  const viewport = create(view.doc, 'section', 'viewport')
  viewport.setAttribute('part', 'viewport')
  viewport.setAttribute('aria-label', view.strings.canvas)
  viewport.append(buildScene(view))
  if (view.dag.nodes.length === 0) {
    viewport.append(text(view.doc, 'p', 'empty', view.strings.empty))
  }
  if (view.mode === 'edit' && view.pending !== null) {
    const hint = create(view.doc, 'p', 'hint')
    hint.setAttribute('role', 'status')
    hint.textContent = view.strings.connectHint({ name: nameOf(view.dag, view.pending) })
    viewport.append(hint)
  }
  viewport.append(buildViewControls(view))
  fragment.append(viewport)

  const footer = view.mode === 'edit' ? buildInspector(view) : buildDetails(view)
  if (footer) fragment.append(footer)
  return fragment
}

function buildToolbar(view: SceneView): HTMLElement {
  const toolbar = create(view.doc, 'div', 'toolbar')
  toolbar.setAttribute('part', 'toolbar')
  const add = button(view.doc, 'add-node', '')
  add.className = 'tool'
  add.append(icon(view.doc, 'plus'), view.doc.createTextNode(view.strings.addNode))
  toolbar.append(add)
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
    iconButton(view.doc, 'zoom-out', 'minus', view.strings.zoomOut),
    iconButton(view.doc, 'zoom-in', 'plus', view.strings.zoomIn),
    iconButton(view.doc, 'fit', 'fit', view.strings.fitView),
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

/** Where a node's connect handle sits — the element needs it to start a drag preview. */
export function handlePoint(at: DagPoint): DagPoint {
  return { x: at.x + NODE_WIDTH, y: at.y + NODE_HEIGHT / 2 }
}

/** A node's top-left corner in scene coordinates, for a host-free caller. */
export function placedAt(positions: ReadonlyMap<string, DagPoint>, nodeId: string): DagPoint {
  return shift(positions.get(nodeId))
}

/** The curve the preview edge draws from a handle to the pointer. */
export function previewPath(start: DagPoint, end: DagPoint): string {
  return curve(start, end)
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
  if (view.selection !== null) scene.dataset.focus = ''

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
      band.style.left = `${extent.left - 10}px`
      band.style.top = `${PADDING / 2}px`
      band.style.width = `${extent.right - extent.left + 20}px`
      band.style.height = `${height - PADDING}px`
      const label = create(view.doc, 'div', 'band-label')
      label.style.left = `${extent.left}px`
      label.style.top = `${PADDING / 2 + 6}px`
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
  svg.append(markers(view.doc))
  for (const edge of view.dag.edges) {
    const ends = endpoints(placed, edge.from, edge.to)
    if (!ends) continue
    const path = view.doc.createElementNS(SVG_NS, 'path')
    path.setAttribute('class', 'edge')
    path.setAttribute('d', curve(ends.start, ends.end))
    path.dataset.from = edge.from
    path.dataset.to = edge.to
    path.dataset.edge = edge.id
    if (isLinked(view.selection, edge)) path.dataset.linked = ''
    svg.append(path)
  }
  return svg
}

/** Two arrowheads: the line colour, and the accent for an edge in hand. */
function markers(doc: Document): Element {
  const defs = doc.createElementNS(SVG_NS, 'defs')
  for (const [id, className] of [
    ['vdag-arrow', 'arrow'],
    ['vdag-arrow-hot', 'arrow-hot'],
  ] as const) {
    const marker = doc.createElementNS(SVG_NS, 'marker')
    marker.setAttribute('id', id)
    marker.setAttribute('viewBox', '0 0 10 10')
    marker.setAttribute('refX', '9')
    marker.setAttribute('refY', '5')
    marker.setAttribute('markerWidth', '7')
    marker.setAttribute('markerHeight', '7')
    marker.setAttribute('orient', 'auto')
    const tip = doc.createElementNS(SVG_NS, 'polygon')
    tip.setAttribute('class', className)
    tip.setAttribute('points', '0,0 10,5 0,10')
    marker.append(tip)
    defs.append(marker)
  }
  return defs
}

function edgeLabels(view: SceneView, placed: readonly Placed[]): readonly HTMLElement[] {
  const spots = new Map<string, DagPoint>()
  for (const edge of view.dag.edges) {
    const ends = endpoints(placed, edge.from, edge.to)
    if (ends) spots.set(edge.id, labelPoint(ends.start, ends.end))
  }
  spreadLabels(spots)
  return view.dag.edges.flatMap((edge) => {
    const at = spots.get(edge.id)
    if (!at) return []
    const label = button(view.doc, 'select-edge', edge.artifact, edge.id)
    label.className = 'edge-label'
    label.setAttribute('part', 'edge')
    label.setAttribute('aria-label', edgeSentence(view, edge))
    label.setAttribute('aria-pressed', String(isSelected(view.selection, 'edge', edge.id)))
    label.dataset.from = edge.from
    label.dataset.to = edge.to
    // The label is clipped to the width of the gap it sits in (see STYLES).
    // The whole artifact is readable three other ways: it expands when the
    // edge or either node is picked, the element shows it in a tooltip on
    // hover or focus, and the details strip prints it when it is selected.
    label.dataset.tooltip = edge.artifact
    if (isLinked(view.selection, edge)) label.dataset.linked = ''
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
  card.dataset.status = node.status
  const statusLabel = view.strings.status[node.status]
  card.setAttribute('aria-label', view.strings.node({ name: node.name, status: statusLabel }))
  card.setAttribute('aria-pressed', String(isSelected(view.selection, 'node', node.id)))
  // Two lines of the name are drawn; the rest is in the tooltip the element
  // shows on hover or focus, and in the details strip once selected.
  card.dataset.tooltip = node.name
  if (view.selection?.kind === 'node' && view.selection.id !== node.id) {
    const selected = view.selection.id
    const linked = view.dag.edges.some(
      (edge) =>
        (edge.from === selected && edge.to === node.id) ||
        (edge.to === selected && edge.from === node.id),
    )
    if (linked) card.dataset.linked = ''
  }
  if (view.pending !== null) {
    card.dataset.target =
      view.pending === node.id
        ? 'source'
        : addEdge(view.dag, view.pending, node.id, '') === null
          ? 'refused'
          : 'ok'
  }
  card.append(
    text(view.doc, 'span', 'node-name', node.name),
    text(view.doc, 'span', 'node-status', statusLabel),
  )
  if (view.mode !== 'edit') return [card]

  const connect = button(view.doc, 'connect', '', node.id)
  connect.className = 'connect'
  connect.setAttribute('aria-label', view.strings.connect)
  connect.setAttribute('aria-pressed', String(view.pending === node.id))
  connect.dataset.tooltip = view.strings.connect
  connect.append(icon(view.doc, 'arrow'))
  const handle = handlePoint(at)
  connect.style.left = `${handle.x - CONNECT_SIZE / 2}px`
  connect.style.top = `${handle.y - CONNECT_SIZE / 2}px`
  return [card, connect]
}

/**
 * Read mode's footer: what is selected, in full. A name is clamped to two
 * lines on its card and an artifact to the gap its label sits in, so this is
 * where the whole of either is printed once something is picked.
 */
function buildDetails(view: SceneView): HTMLElement | null {
  const selection = view.selection
  if (!selection) return null
  const details = create(view.doc, 'div', 'details')
  details.setAttribute('part', 'details')
  if (selection.kind === 'edge') {
    const edge = view.dag.edges.find((candidate) => candidate.id === selection.id)
    if (!edge) return null
    details.append(text(view.doc, 'span', 'inspector-title', edgeSentence(view, edge)))
    return details
  }
  const node = view.dag.nodes.find((candidate) => candidate.id === selection.id)
  if (!node) return null
  details.append(
    text(view.doc, 'span', 'inspector-title', node.name),
    text(view.doc, 'span', 'field', view.strings.status[node.status]),
  )
  return details
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
      text(view.doc, 'span', 'inspector-title', edgeSentence(view, edge)),
      field(
        view.doc,
        'artifact',
        view.strings.artifactField,
        input(view.doc, 'edge-artifact', edge.artifact),
      ),
      deleteButton(view.doc, 'delete-edge', view.strings.deleteEdge, edge.id),
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
    text(view.doc, 'span', 'inspector-title', node.name),
    field(view.doc, 'name', view.strings.nameField, input(view.doc, 'node-name', node.name)),
    field(view.doc, 'status', view.strings.statusField, status),
    field(view.doc, 'wave', view.strings.waveField, wave),
    deleteButton(view.doc, 'delete-node', view.strings.deleteNode, node.id),
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
    start: handlePoint(source.at),
    end: { x: target.at.x - ARROW_INSET, y: target.at.y + NODE_HEIGHT / 2 },
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

/**
 * Two edges leaving one node into the same gap — one to the next wave, one
 * skipping it — cross that gap at nearly the same height, and their labels
 * landed on top of each other. Labels in a gap are walked top to bottom and
 * each is pushed below the one before it when they would touch. The order is
 * by the labels' own heights, so the one that moves is always the lower one,
 * and an edge with the gap to itself does not move at all.
 */
function spreadLabels(spots: Map<string, DagPoint>): void {
  const columns = new Map<number, string[]>()
  for (const [id, at] of spots) {
    const column = columns.get(at.x)
    if (column) column.push(id)
    else columns.set(at.x, [id])
  }
  for (const column of columns.values()) {
    column.sort((a, b) => (spots.get(a)?.y ?? 0) - (spots.get(b)?.y ?? 0))
    let floor = Number.NEGATIVE_INFINITY
    for (const id of column) {
      const at = spots.get(id)
      if (!at) continue
      const y = Math.max(at.y, floor)
      spots.set(id, { x: at.x, y })
      floor = y + LABEL_SPACING
    }
  }
}

/** The height of the same cubic `curve` draws, at `t`. Its control points share
 *  the endpoints' `y`, so only two terms of the polynomial survive. */
function curveY(start: DagPoint, end: DagPoint, t: number): number {
  const rest = 1 - t
  return (rest ** 3 + 3 * rest ** 2 * t) * start.y + (3 * rest * t ** 2 + t ** 3) * end.y
}

function shift(point: DagPoint | undefined): DagPoint {
  return { x: (point?.x ?? 0) + PADDING, y: (point?.y ?? 0) + PADDING + BAND_LABEL_HEIGHT }
}

function nameOf(dag: Dag, nodeId: string): string {
  return dag.nodes.find((node) => node.id === nodeId)?.name ?? nodeId
}

function edgeSentence(view: SceneView, edge: DagEdge): string {
  return view.strings.edge({
    from: nameOf(view.dag, edge.from),
    to: nameOf(view.dag, edge.to),
    artifact: edge.artifact,
  })
}

function isSelected(selection: DagSelection | null, kind: 'node' | 'edge', id: string): boolean {
  return selection?.kind === kind && selection.id === id
}

/** An edge is linked to the selection when it is the selection, or touches it. */
function isLinked(selection: DagSelection | null, edge: DagEdge): boolean {
  if (!selection) return false
  if (selection.kind === 'edge') return selection.id === edge.id
  return edge.from === selection.id || edge.to === selection.id
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

function icon(doc: Document, name: keyof typeof ICONS): SVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'icon')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  const path = doc.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', ICONS[name])
  svg.append(path)
  return svg
}

function button(doc: Document, action: string, label: string, id?: string): HTMLButtonElement {
  const element = create(doc, 'button')
  element.type = 'button'
  element.dataset.action = action
  if (id !== undefined) element.dataset.id = id
  if (label) element.textContent = label
  return element
}

/** A control that is only an icon: the label goes to assistive tech and the tooltip. */
function iconButton(
  doc: Document,
  action: string,
  glyph: keyof typeof ICONS,
  label: string,
): HTMLButtonElement {
  const element = button(doc, action, '')
  element.setAttribute('aria-label', label)
  element.dataset.tooltip = label
  element.append(icon(doc, glyph))
  return element
}

function deleteButton(doc: Document, action: string, label: string, id: string): HTMLButtonElement {
  const element = button(doc, action, '', id)
  element.className = 'delete'
  element.setAttribute('part', 'delete')
  element.append(icon(doc, 'trash'), doc.createTextNode(label))
  return element
}

function input(doc: Document, action: string, value: string): HTMLInputElement {
  const element = create(doc, 'input')
  element.dataset.action = action
  element.value = value
  return element
}

function field(doc: Document, name: string, label: string, control: HTMLElement): HTMLLabelElement {
  const wrapper = create(doc, 'label', 'field')
  wrapper.setAttribute('part', `field field-${name}`)
  wrapper.append(text(doc, 'span', 'field-label', label), control)
  return wrapper
}
