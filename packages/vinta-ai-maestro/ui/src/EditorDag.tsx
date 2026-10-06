/**
 * `<vinta-dag>` in **edit** mode — the same component the run view renders in
 * read mode (§10), which is what keeps the two from drifting into two
 * different pictures of one graph.
 *
 * The mounting rules are `Dag.tsx`'s and are not restated: define at module
 * scope, assign object graphs as properties, add `CustomEvent` listeners
 * imperatively, and do all three in layout effects. Two things are specific to
 * editing:
 *
 * - **The change event carries a whole new `Dag`.** It is handed straight up;
 *   this component keeps no copy of the graph and can therefore never hold a
 *   stale one.
 * - **A drawn dependency seeds an empty artifact.** The component's default
 *   seed is the word `artifact`, which would pass the schema's `min(1)` and
 *   bless an unexplained dependency. See `NEW_EDGE_ARTIFACT`.
 * - **A refused dependency is reported, not swallowed.** The canvas will not
 *   draw a self-loop, a duplicate or a cycle; it says which, and the editor
 *   turns that into a sentence where the gesture happened.
 */
import type * as React from 'react'
import { useLayoutEffect, useRef } from 'react'
import {
  DAG_CHANGE_EVENT,
  DAG_REFUSE_EVENT,
  DAG_SELECTION_CHANGE_EVENT,
  defineDagEditor,
  type Dag,
  type DagChangeDetail,
  type DagRefuseDetail,
  type DagSelectionChangeDetail,
  type EdgeRefusal,
  type VintaDagElement,
} from 'vinta-dag-editor/src/index.ts'
import { pushSelection } from './Dag.tsx'
import { NEW_EDGE_ARTIFACT } from './editor-model.ts'

defineDagEditor()

export interface EditorDagProps {
  readonly dag: Dag
  readonly selected: string | null
  readonly onChange: (dag: Dag) => void
  readonly onSelect: (nodeId: string | null) => void
  /** A dependency the canvas would not draw, and the rule it broke. */
  readonly onRefuse: (reason: EdgeRefusal) => void
}

export function EditorDag({
  dag,
  selected,
  onChange,
  onSelect,
  onRefuse,
}: EditorDagProps): React.ReactElement {
  const host = useRef<VintaDagElement | null>(null)

  useLayoutEffect(() => {
    const element = host.current
    if (element === null) return
    element.mode = 'edit'
    element.strings = { newEdgeArtifact: NEW_EDGE_ARTIFACT }
  }, [])

  useLayoutEffect(() => {
    const element = host.current
    if (element === null) return
    const changed = (event: Event): void => {
      onChange((event as CustomEvent<DagChangeDetail>).detail.value)
    }
    const selection = (event: Event): void => {
      const detail = (event as CustomEvent<DagSelectionChangeDetail>).detail
      onSelect(detail.selection?.kind === 'node' ? detail.selection.id : null)
    }
    const refused = (event: Event): void => {
      onRefuse((event as CustomEvent<DagRefuseDetail>).detail.reason)
    }
    element.addEventListener(DAG_CHANGE_EVENT, changed)
    element.addEventListener(DAG_SELECTION_CHANGE_EVENT, selection)
    element.addEventListener(DAG_REFUSE_EVENT, refused)
    return () => {
      element.removeEventListener(DAG_CHANGE_EVENT, changed)
      element.removeEventListener(DAG_SELECTION_CHANGE_EVENT, selection)
      element.removeEventListener(DAG_REFUSE_EVENT, refused)
    }
  }, [onChange, onSelect, onRefuse])

  useLayoutEffect(() => {
    if (host.current !== null) host.current.value = dag
  }, [dag])

  useLayoutEffect(() => {
    const element = host.current
    if (element === null) return
    pushSelection(element, selected)
  }, [selected])

  return <vinta-dag ref={host} className="dag" />
}
