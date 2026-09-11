import type * as React from 'react'
import { cn } from '../lib/utils.ts'

/**
 * The page: a sticky top bar and one bounded content column.
 *
 * Deliberately not a sidebar shell. A run monitor is read top to bottom —
 * graph, then the panels under it — and a graph wants the whole width it can
 * get; a rail on the left would take it from exactly the surface that needs
 * it. Navigation on these pages is two links, and two links fit in a bar.
 */
function AppShell({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="app-shell"
      className={cn('flex min-h-screen flex-col bg-background text-foreground', className)}
      {...props}
    />
  )
}

/**
 * One row: brand at the start, primary navigation beside it, whatever the app
 * needs at the far end (`AppTopbarActions`). The bar is the app's chrome and
 * says where you are; it is not a place for content.
 */
function AppTopbar({ className, children, ...props }: React.ComponentProps<'header'>) {
  return (
    <header
      data-slot="app-topbar"
      className={cn(
        'sticky top-0 z-40 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70',
        className,
      )}
      {...props}
    >
      <div className="mx-auto flex h-12 w-full max-w-(--app-width,1280px) items-center gap-4 px-5">
        {children}
      </div>
    </header>
  )
}

/** The wordmark. A link home when `href` is given. */
function AppBrand({
  className,
  href,
  children,
  ...props
}: React.ComponentProps<'a'> & { readonly href?: string }) {
  const classes = cn(
    'inline-flex items-center gap-2 text-sm font-semibold tracking-tight text-foreground no-underline hover:no-underline',
    className,
  )
  if (href === undefined) {
    return (
      <span data-slot="app-brand" className={classes}>
        {children}
      </span>
    )
  }
  return (
    <a data-slot="app-brand" href={href} className={classes} {...props}>
      {children}
    </a>
  )
}

/** The primary links, spaced as a group. */
function AppNav({ className, ...props }: React.ComponentProps<'nav'>) {
  return (
    <nav
      data-slot="app-nav"
      aria-label="Primary"
      className={cn('flex items-center gap-1', className)}
      {...props}
    />
  )
}

/**
 * One link in the bar. `current` marks the section the page is in, in the
 * text weight and with `aria-current`, so a reader hears it too.
 */
function AppNavLink({
  className,
  current = false,
  ...props
}: React.ComponentProps<'a'> & { readonly current?: boolean }) {
  return (
    <a
      data-slot="app-nav-link"
      aria-current={current ? 'page' : undefined}
      className={cn(
        'rounded-md px-2.5 py-1.5 text-sm text-muted-foreground no-underline transition-colors hover:bg-accent hover:text-accent-foreground hover:no-underline',
        current && 'font-medium text-foreground',
        className,
      )}
      {...props}
    />
  )
}

/** Pushed to the far end of the bar. */
function AppTopbarActions({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="app-topbar-actions"
      className={cn('ml-auto flex flex-wrap items-center gap-2', className)}
      {...props}
    />
  )
}

/** The content column under the bar. */
function AppMain({ className, ...props }: React.ComponentProps<'main'>) {
  return (
    <main
      data-slot="app-main"
      className={cn(
        'mx-auto flex w-full max-w-(--app-width,1280px) flex-1 flex-col gap-5 px-5 py-6',
        className,
      )}
      {...props}
    />
  )
}

export { AppBrand, AppMain, AppNav, AppNavLink, AppShell, AppTopbar, AppTopbarActions }
