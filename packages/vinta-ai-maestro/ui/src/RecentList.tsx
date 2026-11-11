/**
 * A list the run grows without limit, shown as its newest few.
 *
 * Three panels on these screens are append-only records — the decisions the
 * run made unattended, the steps the integration worktree took, a phase's own
 * integration timeline — and each used to render every row it had. On a long
 * run that is a column hundreds of rows tall, which stretched the grid row it
 * sat in and the panels beside it with it, and buried the only rows that
 * matter mid-run: the latest ones.
 *
 * So the panel shows the newest `RECENT` rows, newest first, and offers the
 * whole record in a dialog, paged. Paging is done here, in the browser, over
 * the full list the endpoint already serves: these records are hundreds of
 * rows at most, the daemon reads them in one fold, and a page cursor on the
 * wire would buy a second request per page for nothing.
 *
 * Callers pass rows already ordered newest first and a renderer per row; the
 * dialog reuses the renderer, so a row reads the same in both places.
 */
import { ChevronLeftIcon, ChevronRightIcon, ListIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Button } from 'vinta-design-system/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from 'vinta-design-system/ui/dialog'
import { cn } from 'vinta-design-system/lib/utils'
import { EmptyNote } from './Panel.tsx'

/** Rows the panel shows before the dialog takes over. */
export const RECENT = 5

/** Rows per page in the dialog. */
export const PAGE = 25

export function RecentList<T>({
  rows,
  render,
  keyOf,
  title,
  description,
  empty,
  listClassName,
  recent = RECENT,
  ...attributes
}: {
  /** Newest first — or whatever order matters most first, for a list that is not a record. */
  readonly rows: readonly T[]
  /** How many rows the panel shows before the dialog takes over. */
  readonly recent?: number
  readonly render: (row: T, index: number) => ReactNode
  readonly keyOf: (row: T, index: number) => string
  /** The dialog's title. */
  readonly title: ReactNode
  readonly description?: ReactNode
  readonly empty: ReactNode
  readonly listClassName?: string
  /** `data-*` hooks for the list and the dialog, as a caller's tests address them. */
  readonly [attribute: `data-${string}`]: string | boolean | undefined
}) {
  const [open, setOpen] = useState(false)
  const shown = rows.slice(0, recent)
  const more = rows.length - shown.length

  if (rows.length === 0) return <EmptyNote>{empty}</EmptyNote>

  return (
    <>
      <ul className={cn('divide-y', listClassName)} {...attributes}>
        {shown.map((row, index) => (
          <li key={keyOf(row, index)} className="py-2 first:pt-0 last:pb-0">
            {render(row, index)}
          </li>
        ))}
      </ul>
      {more > 0 && (
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="w-fit"
          data-action="show-all"
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          <ListIcon aria-hidden="true" />
          All {rows.length}
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        {open && (
          <DialogContent
            data-all-dialog=""
            className="flex h-[min(46rem,calc(100vh-4rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
          >
            <DialogHeader className="gap-1.5 border-b px-5 py-4 pr-12 text-left">
              <DialogTitle className="text-base">{title}</DialogTitle>
              {description !== undefined && <DialogDescription>{description}</DialogDescription>}
            </DialogHeader>
            <Paged rows={rows} render={render} keyOf={keyOf} listClassName={listClassName} />
          </DialogContent>
        )}
      </Dialog>
    </>
  )
}

function Paged<T>({
  rows,
  render,
  keyOf,
  listClassName,
}: {
  readonly rows: readonly T[]
  readonly render: (row: T, index: number) => ReactNode
  readonly keyOf: (row: T, index: number) => string
  readonly listClassName?: string | undefined
}) {
  const [page, setPage] = useState(0)
  const pages = Math.max(1, Math.ceil(rows.length / PAGE))
  const current = Math.min(page, pages - 1)
  const from = current * PAGE
  const shown = rows.slice(from, from + PAGE)

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <ul className={cn('divide-y', listClassName)} data-page={current + 1}>
          {shown.map((row, index) => (
            <li key={keyOf(row, from + index)} className="py-2 first:pt-0 last:pb-0">
              {render(row, from + index)}
            </li>
          ))}
        </ul>
      </div>
      {pages > 1 && (
        <div className="flex items-center justify-between gap-2 border-t px-5 py-3 text-xs text-muted-foreground">
          <span data-page-range>
            {from + 1}–{from + shown.length} of {rows.length}
          </span>
          <span className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              data-action="page-previous"
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
            >
              <ChevronLeftIcon aria-hidden="true" />
              Newer
            </Button>
            <span className="tabular-nums">
              {current + 1} / {pages}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              data-action="page-next"
              disabled={current >= pages - 1}
              onClick={() => setPage(current + 1)}
            >
              Older
              <ChevronRightIcon aria-hidden="true" />
            </Button>
          </span>
        </div>
      )}
    </>
  )
}
