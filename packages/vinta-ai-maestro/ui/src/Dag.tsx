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
  DAG_SELECTION_CHANGE_EVENT,
  defineDagEditor,
  type Dag,
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
}

export function DagView({ dag, selected, onSelect }: DagViewProps): React.ReactElement {
  const host = useRef<VintaDagElement | null>(null)

  useLayoutEffect(() => {
    const element = host.current
    if (element === null) return
    element.mode = 'read'
    const listener = (event: Event): void => {
      const { selection } = (event as CustomEvent<DagSelectionChangeDetail>).detail
      onSelect(selection?.kind === 'node' ? selection.id : null)
    }
    element.addEventListener(DAG_SELECTION_CHANGE_EVENT, listener)
    return () => element.removeEventListener(DAG_SELECTION_CHANGE_EVENT, listener)
  }, [onSelect])

  useLayoutEffect(() => {
    if (host.current !== null) host.current.value = dag
  }, [dag])

  useLayoutEffect(() => {
    if (host.current === null) return
    host.current.selection = selected === null ? null : { kind: 'node', id: selected }
  }, [selected])

  return <vinta-dag ref={host} className="dag" />
}
