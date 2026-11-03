/**
 * A row of tabs that switch a view in place.
 *
 * Buttons with `role="tab"` rather than the design system's Radix tabs: the
 * review page keeps the active tab in its own state (a comment's "show me"
 * link has to switch it), and a controlled list of buttons is the whole of
 * what that needs. It wears the design system's tab-list styling, so it looks
 * like the tabs it is standing in for.
 */
import type { ReactNode } from 'react'
import { cn } from 'vinta-design-system/lib/utils'
import { tabsListVariants } from 'vinta-design-system/ui/tabs'

export interface SegmentedOption<T extends string> {
  readonly value: T
  readonly label: ReactNode
  /** A count shown after the label — comments, issues. Hidden when zero. */
  readonly count?: number
  readonly tone?: 'attention' | 'error'
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
  size = 'default',
}: {
  readonly options: readonly SegmentedOption<T>[]
  readonly value: T
  readonly onChange: (value: T) => void
  /** The list's accessible name. */
  readonly label: string
  readonly className?: string
  readonly size?: 'default' | 'sm'
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(tabsListVariants(), 'max-w-full overflow-x-auto', size === 'sm' && 'h-8', className)}
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            data-tab={option.value}
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex h-full items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 font-medium transition-colors',
              size === 'sm' ? 'text-xs' : 'text-sm',
              active
                ? 'bg-background text-foreground shadow-xs dark:bg-input/70'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
            {option.count !== undefined && option.count > 0 && (
              <span
                className={cn(
                  'rounded-full px-1.5 font-mono text-[11px] leading-4',
                  option.tone === 'error'
                    ? 'bg-tone-error-soft text-tone-error-foreground'
                    : option.tone === 'attention'
                      ? 'bg-tone-attention-soft text-tone-attention-foreground'
                      : 'bg-muted-foreground/15 text-muted-foreground',
                )}
                data-count
              >
                {option.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
