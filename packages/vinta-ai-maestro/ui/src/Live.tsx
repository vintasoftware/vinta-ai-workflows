import { cn } from 'vinta-design-system/lib/utils'
import { BadgeDot } from 'vinta-design-system/ui/badge'

/**
 * Whether the run's socket is up. Green with a halo while it is; the waiting
 * tone while it reconnects — a dropped socket is the stream being re-read, not
 * a run in trouble, and it must not look like one.
 */
export function Live({ connected }: { readonly connected: boolean }) {
  return (
    <span
      className={cn(
        'live inline-flex items-center gap-1.5 text-[13px] font-medium',
        connected ? 'text-tone-ok-foreground' : 'off text-tone-wait-foreground',
      )}
      data-connected={connected}
    >
      <BadgeDot
        className={cn(
          connected
            ? 'bg-tone-ok shadow-[0_0_0_3px_var(--tone-ok-soft)]'
            : 'bg-tone-wait shadow-[0_0_0_3px_var(--tone-wait-soft)]',
        )}
      />
      {connected ? 'Live' : 'Reconnecting…'}
    </span>
  )
}
