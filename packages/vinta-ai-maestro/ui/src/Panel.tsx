import type { ComponentProps, ReactNode } from 'react'
import { cn } from 'vinta-design-system/lib/utils'
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
 */
export function Panel({
  title,
  description,
  action,
  className,
  contentClassName,
  children,
  ...props
}: Omit<ComponentProps<typeof Card>, 'title'> & {
  readonly title: ReactNode
  readonly description?: ReactNode
  readonly action?: ReactNode
  readonly contentClassName?: string
}) {
  return (
    <Card className={cn('gap-3 py-4', className)} {...props}>
      <CardHeader className="px-4">
        <CardTitle className="text-sm">{title}</CardTitle>
        {description !== undefined && (
          <CardDescription className="text-[13px]">{description}</CardDescription>
        )}
        {action !== undefined && <CardAction>{action}</CardAction>}
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
