import type * as React from 'react'
import { cn } from '../lib/utils.ts'

/**
 * Labelled facts: a `<dl>` laid out as a two-column grid, the terms in the
 * muted colour and the details beside them. For the reference-style panels
 * — a diff's branch, base and lane; a run's reuse, cache, tokens and cost —
 * where the reader scans the labels and reads one value.
 */
function DescriptionList({ className, ...props }: React.ComponentProps<'dl'>) {
  return (
    <dl
      data-slot="description-list"
      className={cn(
        'm-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm',
        className,
      )}
      {...props}
    />
  )
}

function DescriptionTerm({ className, ...props }: React.ComponentProps<'dt'>) {
  return (
    <dt
      data-slot="description-term"
      className={cn('text-muted-foreground', className)}
      {...props}
    />
  )
}

function DescriptionDetails({ className, ...props }: React.ComponentProps<'dd'>) {
  return (
    <dd
      data-slot="description-details"
      className={cn('m-0 min-w-0 break-words text-foreground', className)}
      {...props}
    />
  )
}

export { DescriptionDetails, DescriptionList, DescriptionTerm }
