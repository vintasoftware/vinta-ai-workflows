/**
 * Public data contract for the plan-DAG canvas.
 *
 * These types are the boundary two other things are built against —
 * `vinta-flow`'s run view renders this shape, and the workflow editor edits it —
 * and the shape is decided by the workflow schema rather than by the canvas.
 *
 * Conventions mirror `vinta-state-machine-editor`, deliberately: data is deeply
 * readonly and never mutated in place, every entity carries a host-owned `data`
 * blob the component preserves but never reads, and the host injects everything
 * — the component fetches nothing and authenticates nothing.
 *
 * Declared here rather than in `index.ts` so the element can import them without
 * importing the module that re-exports the element. `index.ts` re-exports every
 * name below, so the published contract is unchanged.
 */

/** Where a node is in its lifecycle. Drives color only; the host owns meaning. */
export type DagNodeStatus =
  | 'pending'
  | 'ready'
  | 'waiting_on_capacity'
  | 'running'
  | 'awaiting_human'
  | 'done'
  | 'failed'
  | 'blocked'

/** Iteration order is the render order of the status picker, so it is fixed. */
export const DAG_NODE_STATUSES: readonly DagNodeStatus[] = [
  'pending',
  'ready',
  'waiting_on_capacity',
  'running',
  'awaiting_human',
  'done',
  'failed',
  'blocked',
]

export interface DagNode {
  readonly id: string
  readonly name: string
  readonly status: DagNodeStatus
  /** Longest-path depth. Used for banding; the canvas does not compute it. */
  readonly wave: number
  readonly position?: { readonly x: number; readonly y: number }
  readonly data?: Readonly<Record<string, unknown>>
}

export interface DagEdge {
  readonly id: string
  readonly from: string
  readonly to: string
  /** What the downstream node needs from the upstream one. Rendered as the edge label. */
  readonly artifact: string
  readonly data?: Readonly<Record<string, unknown>>
}

export interface Dag {
  readonly nodes: readonly DagNode[]
  readonly edges: readonly DagEdge[]
  readonly data?: Readonly<Record<string, unknown>>
}

/**
 * `read` is the live run view — selection and inspection only. `edit` is the
 * workflow editor. Same component, so the two views cannot drift into two
 * different pictures of one graph.
 */
export type DagMode = 'read' | 'edit'

export type DagSelection =
  | { readonly kind: 'node'; readonly id: string }
  | { readonly kind: 'edge'; readonly id: string }

export interface DagViewport {
  readonly x: number
  readonly y: number
  readonly scale: number
}

export interface DagPoint {
  readonly x: number
  readonly y: number
}
