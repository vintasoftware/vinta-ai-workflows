/**
 * `<state-machine-editor>` (§10), mounted from React for the phase pipelines.
 *
 * The mounting rules are the DAG canvas's — define at module scope, assign
 * object graphs as properties, listen for `CustomEvent`s imperatively — plus
 * two the state machine editor adds:
 *
 * - **The catalog is injected, not fetched.** §5.2 puts the side-effect
 *   catalog on the host, and `sideEffectProvider` is where it lands.
 *   `EFFECT_DEFINITIONS` is derived from `EFFECT_CATALOG`, so the palette is
 *   the daemon's verbs and cannot list one the executor has never heard of.
 * - **Echoing a change back must not clear undo.** Assigning a *different*
 *   machine resets the component's history, and every round trip through the
 *   workflow schema produces new objects. The pipeline this component last
 *   emitted is remembered by reference and not written back, so a host that
 *   stores what it was handed leaves the history alone.
 *
 * Transient changes — a card mid-drag — are dropped. They are announced so a
 * host can animate; validating a whole workflow per mousemove is not that.
 */
import type * as React from 'react'
import { useLayoutEffect, useRef } from 'react'
import {
  defineStateMachineEditor,
  STATE_MACHINE_CHANGE_EVENT,
  type StateMachineChangeDetail,
  type StateMachineEditorElement,
} from 'vinta-state-machine-editor'
import type { Pipeline } from '../../src/types.ts'
import { EFFECT_DEFINITIONS, fromMachine, toMachine } from './editor-model.ts'

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'state-machine-editor': React.DetailedHTMLProps<
        React.HTMLAttributes<StateMachineEditorElement>,
        StateMachineEditorElement
      >
    }
  }
}

defineStateMachineEditor()

export interface EditorPipelineProps {
  readonly pipeline: Pipeline
  readonly onChange: (pipeline: Pipeline) => void
}

export function EditorPipeline({ pipeline, onChange }: EditorPipelineProps): React.ReactElement {
  const host = useRef<StateMachineEditorElement | null>(null)
  const emitted = useRef<Pipeline | null>(null)

  useLayoutEffect(() => {
    const element = host.current
    if (element === null) return
    element.sideEffectProvider = () => EFFECT_DEFINITIONS
  }, [])

  useLayoutEffect(() => {
    const element = host.current
    if (element === null) return
    const changed = (event: Event): void => {
      const detail = (event as CustomEvent<StateMachineChangeDetail>).detail
      if (detail.transient) return
      const next = fromMachine(detail.value)
      emitted.current = next
      onChange(next)
    }
    element.addEventListener(STATE_MACHINE_CHANGE_EVENT, changed)
    return () => element.removeEventListener(STATE_MACHINE_CHANGE_EVENT, changed)
  }, [onChange])

  useLayoutEffect(() => {
    if (host.current === null || pipeline === emitted.current) return
    host.current.value = toMachine(pipeline)
  }, [pipeline])

  return <state-machine-editor ref={host} className="pipeline" />
}
