import type * as React from 'react'
import { cn } from '../lib/utils.ts'

/**
 * What the page is about, in one row: a title, the identifiers under it, and
 * the status and actions at the far end. Wraps on a narrow window so the
 * actions drop under the title rather than squeezing it.
 */
function PageHeader({ className, ...props }: React.ComponentProps<'header'>) {
  return (
    <header
      data-slot="page-header"
      className={cn('flex flex-wrap items-start justify-between gap-x-6 gap-y-3', className)}
      {...props}
    />
  )
}

function PageHeaderHeading({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="page-header-heading"
      className={cn('flex min-w-0 flex-col gap-1', className)}
      {...props}
    />
  )
}

function PageHeaderTitle({ className, ...props }: React.ComponentProps<'h1'>) {
  return (
    <h1
      data-slot="page-header-title"
      className={cn('truncate text-xl font-semibold tracking-tight', className)}
      {...props}
    />
  )
}

/**
 * The identifiers: run id, base branch, wave, harness. Rendered in the mono
 * face because they are things to copy and compare, and separated by the
 * container's gap rather than typed middle dots.
 */
function PageHeaderMeta({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="page-header-meta"
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}

function PageHeaderActions({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="page-header-actions"
      className={cn('flex flex-wrap items-center gap-2', className)}
      {...props}
    />
  )
}

export { PageHeader, PageHeaderActions, PageHeaderHeading, PageHeaderMeta, PageHeaderTitle }
