import type { ReactNode } from 'react'
import { Badge, BadgeDot } from 'vinta-design-system/ui/badge'
import type { Tone } from './status.ts'

/**
 * A status pill: the design system's badge in its tone variant.
 *
 * `data-tone` is the meaning and the variant is only the colour — which is why
 * §6.1's distinction between waiting and failing survives a restyle, and why
 * the tests read the attribute and never the class. The `chip` class stays as
 * the hook those tests (and nothing else) select by.
 *
 * `Tone` and the badge's tone variants are the same six words by construction:
 * the design system's contract was written from this app's vocabulary.
 */
export function Chip({ tone, children }: { readonly tone: Tone; readonly children: ReactNode }) {
  return (
    <Badge variant={tone} className="chip" data-tone={tone}>
      {children}
    </Badge>
  )
}

/** Solid-colour classes per tone, for a mark that is not a badge. */
const DOT: Readonly<Record<Tone, string>> = {
  idle: 'bg-tone-idle',
  active: 'bg-tone-active',
  wait: 'bg-tone-wait',
  attention: 'bg-tone-attention',
  ok: 'bg-tone-ok',
  error: 'bg-tone-error',
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
  return <BadgeDot className={`chip dot ${DOT[tone]}`} data-tone={tone} aria-hidden="true" />
}
