/**
 * `<vinta-dag>` (§3), mounted from React in read mode.
 *
 * A custom element is not a React component and the three places that differ
 * are all here:
 *
 * - **Defined at module scope.** An element created before its class is
 *   registered upgrades later — but a property assigned in the meantime
 *   becomes an own property that shadows the class's accessor forever. Define
 *   first, and React can never create one too early.
 * - **Properties, not attributes.** `value` is an object graph. React would
 *   stringify it into an attribute; the element wants the object, so it is
 *   assigned to the ref in an effect.
 * - **Listeners added imperatively.** `vinta-dag-selection-change` is a
 *   `CustomEvent`, which JSX has no `onFoo` for.
 *
 * The three effects are layout effects: they are the imperative half of the
 * same commit React just made, and running them after paint would show the
 * roster and the graph disagreeing for a frame on every status change.
 *
 * Selection is pushed back in as a property, and the element's setter does not
 * re-emit, so there is no loop between it and the host's state.
 */
import type * as React from 'react'
import { useLayoutEffect, useRef } from 'react'
import {
  DAG_NODE_ACTIVATE_EVENT,
  DAG_SELECTION_CHANGE_EVENT,
  defineDagEditor,
  type Dag,
  type DagNodeActivateDetail,
  type DagStringOverrides,
  type DagSelectionChangeDetail,
  type VintaDagElement,
} from 'vinta-dag-editor/src/index.ts'

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'vinta-dag': React.DetailedHTMLProps<
        React.HTMLAttributes<VintaDagElement>,
        VintaDagElement
      >
    }
  }
}

defineDagEditor()

export interface DagViewProps {
  readonly dag: Dag
  readonly selected: string | null
  readonly onSelect: (nodeId: string | null) => void
  /** A node opened — double-clicked, or Enter on the selected one. */
  readonly onOpen?: (nodeId: string) => void
  /**
   * The canvas's labels. The review page (§19) borrows run statuses for their
   * colour and renames them, so a plan that has not run never reads "Failed".
   */
  readonly strings?: DagStringOverrides
}

export function DagView({
  dag,
  selected,
  onSelect,
  onOpen,
  strings,
}: DagViewProps): React.ReactElement {
  const host = useRef<VintaDagElement | null>(null)

  useLayoutEffect(() => {
    const element = host.current
    if (element === null) return
    element.mode = 'read'
    const selection = (event: Event): void => {
      const detail = (event as CustomEvent<DagSelectionChangeDetail>).detail
      onSelect(detail.selection?.kind === 'node' ? detail.selection.id : null)
    }
    const open = (event: Event): void => {
      onOpen?.((event as CustomEvent<DagNodeActivateDetail>).detail.nodeId)
    }
    element.addEventListener(DAG_SELECTION_CHANGE_EVENT, selection)
    element.addEventListener(DAG_NODE_ACTIVATE_EVENT, open)
    return () => {
      element.removeEventListener(DAG_SELECTION_CHANGE_EVENT, selection)
      element.removeEventListener(DAG_NODE_ACTIVATE_EVENT, open)
    }
  }, [onSelect, onOpen])

  useLayoutEffect(() => {
    if (host.current !== null && strings !== undefined) host.current.strings = strings
  }, [strings])

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

/**
 * The host's selection is a node id, and an edge the operator picked on the
 * canvas is reported up as "no node". Pushing that `null` straight back would
 * clear the edge the moment it was picked — so a `null` only clears a *node*,
 * and an edge selection is the canvas's own to keep.
 */
export function pushSelection(element: VintaDagElement, selected: string | null): void {
  if (selected !== null) {
    element.selection = { kind: 'node', id: selected }
    return
  }
  if (element.selection?.kind === 'node') element.selection = null
}
