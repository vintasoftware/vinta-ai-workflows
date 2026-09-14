import { Maximize2Icon, Minimize2Icon } from 'lucide-react'
import { useState, type ComponentProps, type ReactNode } from 'react'
import { cn } from 'vinta-design-system/lib/utils'
import { Button } from 'vinta-design-system/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from 'vinta-design-system/ui/card'

/**
 * A panel is the design system's card at this app's density: a title, an
 * optional one-line description under it, an optional control at the far end
 * of the header, and the content. Every view is a column of these, so the
 * spacing is decided once here and not per panel.
 *
 * `data-*` and `className` pass through to the card element, because that is
 * where the tests and the stylesheet's few remaining hooks (`steering`,
 * `transcript`, `sessions`) look for them.
 *
 * **`expandable` gives a panel room on demand.** Several of these hold content
 * that is only nominally summarisable — an agent's output, a gate's log, a
 * conversation — and a third of a grid row is where you read the first two
 * lines of it and then give up. Expanding takes the full width of the page
 * container and roughly a screen of height, and collapsing puts it back; it is
 * a reading position, not a route, so it is deliberately not in the URL.
 *
 * The height travels as a CSS variable rather than a prop, because the element
 * that has to grow is a scroller three components down — the transcript's list,
 * the gate log's `pre`. Each declares `max-h-[var(--panel-scroll,<default>)]`
 * and inherits whatever the panel around it is currently worth, which keeps the
 * panel from needing to know what is inside it.
 */
export function Panel({
  title,
  description,
  action,
  className,
  contentClassName,
  expandable = false,
  children,
  ...props
}: Omit<ComponentProps<typeof Card>, 'title'> & {
  readonly title: ReactNode
  readonly description?: ReactNode
  readonly action?: ReactNode
  readonly contentClassName?: string
  /** Offer a control that gives this panel the full container and a screen of height. */
  readonly expandable?: boolean
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <Card
      className={cn('gap-3 py-4', expanded && 'col-span-full', className)}
      // Read by whatever scroller is inside; see the note above.
      style={expanded ? { ['--panel-scroll' as string]: '70vh' } : undefined}
      data-expanded={expanded ? '' : undefined}
      {...props}
    >
      <CardHeader className="px-4">
        <CardTitle className="text-sm">{title}</CardTitle>
        {description !== undefined && (
          <CardDescription className="text-[13px]">{description}</CardDescription>
        )}
        {(action !== undefined || expandable) && (
          <CardAction className="flex items-center gap-1">
            {action}
            {expandable && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                data-action="expand"
                aria-pressed={expanded}
                aria-label={expanded ? 'Collapse this panel' : 'Expand this panel'}
                title={expanded ? 'Collapse' : 'Expand'}
                onClick={() => setExpanded((current) => !current)}
              >
                {expanded ? (
                  <Minimize2Icon aria-hidden="true" className="size-3.5" />
                ) : (
                  <Maximize2Icon aria-hidden="true" className="size-3.5" />
                )}
              </Button>
            )}
          </CardAction>
        )}
      </CardHeader>
      <CardContent className={cn('flex flex-col gap-3 px-4', contentClassName)}>
        {children}
      </CardContent>
    </Card>
  )
}

/** "Nothing here yet", in the muted colour. `empty` is the tests' hook. */
export function EmptyNote({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('empty text-sm text-muted-foreground', className)} {...props} />
}

/** A failure the operator has to read. `error` is the tests' hook. */
export function ErrorNote({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p
      role="alert"
      className={cn('error text-sm font-medium text-tone-error-foreground', className)}
      {...props}
    />
  )
}

/** A sentence of guidance under a control. */
export function Hint({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-[13px] text-muted-foreground', className)} {...props} />
}
