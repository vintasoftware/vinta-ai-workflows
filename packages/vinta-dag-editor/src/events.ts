/**
 * The events the canvas emits. Nothing else leaves the component.
 *
 * A change event carries the whole new `Dag`, not a patch: the host owns
 * persistence and undo, and handing it a complete value means it never has to
 * replay our edits to know what the graph is now. `change` says *what* happened
 * so the host can label an undo step without diffing.
 */

import type { Dag, DagSelection } from './types'

export const DAG_CHANGE_EVENT = 'vinta-dag-change'
export const DAG_SELECTION_CHANGE_EVENT = 'vinta-dag-selection-change'

export type DagChange =
  | { readonly kind: 'node-add'; readonly nodeId: string }
  | { readonly kind: 'node-remove'; readonly nodeId: string }
  | { readonly kind: 'node-update'; readonly nodeId: string }
  | { readonly kind: 'edge-add'; readonly edgeId: string }
  | { readonly kind: 'edge-remove'; readonly edgeId: string }
  | { readonly kind: 'edge-update'; readonly edgeId: string }

export interface DagChangeDetail {
  readonly value: Dag
  readonly change: DagChange
}

export interface DagSelectionChangeDetail {
  readonly selection: DagSelection | null
}
