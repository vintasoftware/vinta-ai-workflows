/**
 * The package's public surface.
 *
 * Types and pure helpers only — importing this does not register the custom
 * element. Hosts that want `<vinta-dag>` import `./register` for the side effect
 * or call `defineDagEditor()` themselves, so a host that only needs the data
 * contract (the daemon's own code, say) never pulls in the DOM.
 */

export { DAG_EDITOR_TAG, defineDagEditor } from './define'
export { VintaDagElement } from './element'
export {
  DAG_CHANGE_EVENT,
  DAG_SELECTION_CHANGE_EVENT,
  type DagChange,
  type DagChangeDetail,
  type DagSelectionChangeDetail,
} from './events'
export { layoutDag, NODE_HEIGHT, NODE_WIDTH } from './layout'
export {
  addEdge,
  addNode,
  type NodePatch,
  removeEdge,
  removeNode,
  updateEdge,
  updateNode,
} from './model'
export {
  type DagStringOverrides,
  type DagStrings,
  DEFAULT_STRINGS,
  mergeStrings,
} from './strings'
export {
  DAG_NODE_STATUSES,
  type Dag,
  type DagEdge,
  type DagMode,
  type DagNode,
  type DagNodeStatus,
  type DagPoint,
  type DagSelection,
  type DagViewport,
} from './types'
