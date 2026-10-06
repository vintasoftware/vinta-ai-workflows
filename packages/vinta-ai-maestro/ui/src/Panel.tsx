import { Maximize2Icon, Minimize2Icon } from 'lucide-react'
import { useEffect, useState, type ComponentProps, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
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
 * **`expandable` gives a panel the whole page on demand.** Several of these
 * hold content that is only nominally summarisable — an agent's output, a
 * gate's log, a conversation — and a third of a grid row is where you read the
 * first two lines of it and then give up. Expanding puts the panel over
 * everything else at the size of the window; the same button, wearing the
 * opposite icon, puts it back. It is a reading position, not a route, so it is
 * deliberately not in the URL.
 *
 * It used to expand by taking `col-span-full`, which was two different wrong
 * things at once. On the run view it went from a third of a row to a whole one
 * — more room, still a strip. On the node view it did *nothing at all*: the
 * panels there sit inside a flex column, not a grid, so the only thing the
 * button changed was the scroller's height. A control that silently does
 * nothing on one of the two screens that offer it is worse than no control.
 *
 * **Expanded, it renders through a portal.** The node view nests its panels
 * inside scrolling containers, and an overlay is clipped by any of them. Going
 * out to `document.body` is what makes "full page" mean the page rather than
 * whichever box the panel happens to live in. The cost is that expanded
 * content leaves the React tree's DOM position — tests that scope queries to a
 * render container have to look at `document.body` instead.
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

  // Escape closes it, and the page behind it does not scroll while it is up.
  // Both are what "full page" has to mean to be usable: there is no other way
  // out of an overlay that covers its own trigger, and a wheel event that
  // scrolls the document underneath makes the overlay feel like a mistake.
  useEffect(() => {
    if (!expanded) return
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setExpanded(false)
    }
    const { body } = document
    const restore = body.style.overflow
    body.style.overflow = 'hidden'
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('keydown', close)
      body.style.overflow = restore
    }
  }, [expanded])

  // The overlay spans the window, but a line of text as wide as a large
  // monitor is unreadable; expanded, header and content share a centred column.
  const column = expanded && 'mx-auto w-full max-w-6xl'

  const card = (
    <Card
      className={cn(
        'gap-3 py-4',
        expanded && 'fixed inset-0 z-50 m-0 overflow-y-auto rounded-none border-0 shadow-none',
        className,
      )}
      // Read by whatever scroller is inside; see the note above. The header and
      // this card's own padding are what the subtraction leaves room for.
      style={expanded ? { ['--panel-scroll' as string]: 'calc(100vh - 9rem)' } : undefined}
      data-expanded={expanded ? '' : undefined}
      {...props}
    >
      <CardHeader className={cn('px-4', column)}>
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
                aria-label={expanded ? 'Close the full-page view' : 'Open this panel full page'}
                title={expanded ? 'Back to the page' : 'Full page'}
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
      <CardContent className={cn('flex flex-col gap-3 px-4', column, contentClassName)}>
        {children}
      </CardContent>
    </Card>
  )

  return expanded ? createPortal(card, document.body) : card
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
