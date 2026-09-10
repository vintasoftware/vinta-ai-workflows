import type { ReactNode } from 'react'
import type { Tone } from './status.ts'

/**
 * A status pill. `data-tone` is the meaning; the class is only the colour —
 * which is why §6.1's distinction between waiting and failing survives a
 * restyle.
 */
export function Chip({ tone, children }: { readonly tone: Tone; readonly children: ReactNode }) {
  return (
    <span className={`chip tone-${tone}`} data-tone={tone}>
      {children}
    </span>
  )
}

/**
 * The same tone with no word in it, for a row whose own text already says what
 * happened. The transcript's rows read "Tool result · failed" and "Operator
 * (you)"; a pill beside them saying `tool_result` or `user_message` added the
 * event type out of the journal and nothing a reader wanted — an internal
 * identifier is not a label. The colour is worth keeping, so it stays and the
 * word goes, and the dot is `aria-hidden` because everything it encodes is
 * already in the sentence next to it.
 */
export function ToneDot({ tone }: { readonly tone: Tone }) {
  return <span className={`chip dot tone-${tone}`} data-tone={tone} aria-hidden="true" />
}
