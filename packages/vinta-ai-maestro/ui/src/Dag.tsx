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
import { Maximize2Icon, Minimize2Icon } from 'lucide-react'
import type * as React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from 'vinta-design-system/ui/button'
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
  // Full screen: the canvas over the whole window, for a plan too wide to
  // read in a strip. A reading position like `Panel`'s expand, not a route.
  const [fullscreen, setFullscreen] = useState(false)

  // Escape leaves, the page behind does not scroll, and the graph is framed
  // again for the new box — the canvas frames itself only once, on first
  // render, and a box ten times the size deserves a second fit.
  useEffect(() => {
    if (!fullscreen) return
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setFullscreen(false)
    }
    const { body } = document
    const restore = body.style.overflow
    body.style.overflow = 'hidden'
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('keydown', close)
      body.style.overflow = restore
    }
  }, [fullscreen])

  useLayoutEffect(() => {
    const element = host.current
    if (element === null) return
    const frame = requestAnimationFrame(() => element.fitToContent())
    return () => cancelAnimationFrame(frame)
  }, [fullscreen])

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

  return (
    <div
      className={fullscreen ? 'fixed inset-0 z-50 flex flex-col bg-background p-3' : 'relative'}
      data-dag-fullscreen={fullscreen ? '' : undefined}
    >
      <vinta-dag ref={host} className="dag" data-fullscreen={fullscreen ? '' : undefined} />
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        className="absolute top-3 right-3 z-10 bg-background/80 backdrop-blur"
        data-action="dag-fullscreen"
        aria-pressed={fullscreen}
        aria-label={fullscreen ? 'Leave full screen' : 'Show the graph full screen'}
        title={fullscreen ? 'Leave full screen (Esc)' : 'Full screen'}
        onClick={() => setFullscreen((current) => !current)}
      >
        {fullscreen ? <Minimize2Icon aria-hidden="true" /> : <Maximize2Icon aria-hidden="true" />}
      </Button>
    </div>
  )
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
