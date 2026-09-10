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
