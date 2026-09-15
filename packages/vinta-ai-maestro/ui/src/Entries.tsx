/**
 * The rows themselves, shared by the two views that hold a conversation.
 *
 * `Transcript.tsx` owns a phase's: a window over a tail, a following rule, a
 * panel that opens full page. `Monitor.tsx` owns the run's, which needs none of
 * that and needs all of *this* — the same folding, the same author bands, the
 * same idea of what a row is worth. The daemon has always said these are the
 * same shape ("Entries are the same shape as a phase's, which is what lets the
 * UI render both with one component") and until this module existed that was
 * only true of the parsing: the monitor panel drew its own rows, so an agent's
 * thinking arrived there as a wall of undifferentiated prose.
 *
 * What is here is everything below the scroller. What is not is any opinion
 * about scrolling, windowing or panels, which is exactly the split that let the
 * monitor reuse it.
 */
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react'
import { Fragment, useEffect, useState } from 'react'
import { cn } from 'vinta-design-system/lib/utils'
import { Button } from 'vinta-design-system/ui/button'
import { ToneDot } from './Chip.tsx'
import { bodyOf, hasMore, headlineOf, type Row } from './transcript.ts'

/** The author's colour: the operator stands out, machinery recedes. */
const AUTHOR: Readonly<Record<string, string>> = {
  operator: 'text-tone-attention-foreground',
  tool: 'text-muted-foreground',
  system: 'text-muted-foreground',
}

/** Which kinds are open. Prose is not in here because prose never folds. */
export type Folded = Record<'thinking' | 'tool', boolean>

export const CLOSED: Folded = { thinking: false, tool: false }

/**
 * The list, and the per-row memory of what the reader opened by hand.
 *
 * Those overrides are cleared whenever `open` moves, which is what makes the
 * header controls honest: that button means "show me all of this now", and
 * honouring a row somebody closed three minutes ago underneath it would make
 * the button lie about what it did.
 */
export function Entries({
  rows,
  open,
  className,
  listRef,
  onScroll,
  ...props
}: {
  readonly rows: readonly Row[]
  readonly open: Folded
  readonly className?: string
  readonly listRef?: (element: HTMLOListElement | null) => void
  readonly onScroll?: (event: React.UIEvent<HTMLOListElement>) => void
} & Omit<React.ComponentProps<'ol'>, 'onScroll' | 'className' | 'ref'>) {
  const [overrides, setOverrides] = useState<Readonly<Record<number, boolean>>>({})
  useEffect(() => setOverrides({}), [open])

  return (
    <ol ref={listRef} className={cn('entries divide-y', className)} onScroll={onScroll} {...props}>
      {rows.map((row, index) => {
        const shape = row.shape
        // The band, not a per-row badge. A phase is an implementer, a reviewer
        // and three fix rounds in one file, and what a reader needs is the
        // *boundary* — where one agent stopped and the next started — which a
        // label repeated on ninety consecutive rows states ninety times and
        // shows once.
        const turn = row.role !== null && row.role !== rows[index - 1]?.role
        return (
          <Fragment key={row.at}>
            {turn && <Author role={row.role as string} first={index === 0} />}
            {shape === 'prose' ? (
              <Entry row={row} open />
            ) : (
              <Entry
                row={row}
                open={overrides[row.at] ?? open[shape]}
                onToggle={() =>
                  setOverrides((current) => ({
                    ...current,
                    [row.at]: !(current[row.at] ?? open[shape]),
                  }))
                }
              />
            )}
          </Fragment>
        )
      })}
    </ol>
  )
}

/** The two header controls, for a view that has a header to put them in. */
export function FoldControls({
  open,
  onToggle,
}: {
  readonly open: Folded
  readonly onToggle: (shape: 'thinking' | 'tool') => void
}) {
  return (
    <>
      <Fold shape="thinking" label="Thinking" noun="thinking block" on={open.thinking} onToggle={onToggle} />
      <Fold shape="tool" label="Tools" noun="tool call" on={open.tool} onToggle={onToggle} />
    </>
  )
}

/** A header control that opens or closes every row of one kind. */
function Fold({
  shape,
  label,
  noun,
  on,
  onToggle,
}: {
  readonly shape: 'thinking' | 'tool'
  /** What the button says. */
  readonly label: string
  /** What it acts on, singular, for the sentence a screen reader gets. */
  readonly noun: string
  readonly on: boolean
  readonly onToggle: (shape: 'thinking' | 'tool') => void
}) {
  const sentence = `${on ? 'Collapse' : 'Expand'} every ${noun}`
  return (
    <Button
      type="button"
      variant={on ? 'secondary' : 'ghost'}
      size="xs"
      data-action={`fold-${shape}`}
      aria-pressed={on}
      aria-label={sentence}
      title={sentence}
      onClick={() => onToggle(shape)}
    >
      {label}
    </Button>
  )
}

/**
 * One row.
 *
 * Prose is never folded — an agent's answer and an operator's steering are the
 * things the transcript exists to show, and a chevron in front of them would be
 * a control whose only use is to hide the point. Everything else folds, and a
 * row with nothing behind its headline offers no control either: a chevron that
 * reveals what is already on screen teaches the operator not to trust chevrons.
 */
function Entry({
  row,
  open,
  onToggle,
}: {
  readonly row: Row
  readonly open: boolean
  readonly onToggle?: () => void
}) {
  const view = row.views[0]
  if (view === undefined) return null
  const quiet = row.shape === 'thinking'
  // A chevron that reveals what is already on screen teaches the operator not
  // to trust chevrons, so a row with nothing behind its headline offers none.
  const toggle = onToggle !== undefined && hasMore(row) ? onToggle : undefined

  const attribution = (
    <>
      <span
        className={cn('entry-author', quiet ? 'font-medium' : 'font-semibold', AUTHOR[view.author])}
        data-author={view.author}
      >
        {view.label}
      </span>
      {/* The kind is `view.label`'s job and the status is the dot's; the event
          type stays in `data-kind`, where a test or a stylesheet can reach it
          and a reader is not asked to. */}
      {view.tone !== null && <ToneDot tone={view.tone} />}
    </>
  )

  // Prose is never folded. An agent's answer and an operator's steering are the
  // things the transcript exists to show, and a chevron in front of them would
  // be a control whose only use is to hide the point — so these rows keep the
  // head-over-body shape they have always had.
  if (row.shape === 'prose') {
    return (
      <li data-entry={row.at} data-kind={view.kind} data-shape="prose" data-open="" className={ROW}>
        {/* An agent's answer under a band that already reads REVIEWER needs no
            head at all; `transcript.ts` decides that and empties the label. */}
        {(view.label !== '' || view.tone !== null) && (
          <p className="entry-head flex items-center gap-2 text-[13px]">{attribution}</p>
        )}
        {/* `bodyOf`, not `view.body`. Prose groups now — a streamed answer is
            several `assistant_text` events and one statement — so a row can
            hold more than the view its head was built from. */}
        <p className="entry-body text-sm">{bodyOf(row)}</p>
      </li>
    )
  }

  const headline = (
    <span className="entry-headline min-w-0 flex-1 truncate text-muted-foreground" data-headline>
      {headlineOf(row)}
    </span>
  )
  const head = cn(
    'entry-head flex min-w-0 items-center gap-2',
    quiet ? 'text-[11px]' : 'text-[13px]',
  )

  return (
    <li
      data-entry={row.at}
      data-kind={view.kind}
      data-shape={row.shape}
      data-open={open ? '' : undefined}
      className={cn(quiet ? 'py-1.5' : 'py-2', 'flex flex-col gap-0.5 first:pt-0 last:pb-0')}
    >
      {toggle === undefined ? (
        <p className={head}>
          {attribution}
          {headline}
        </p>
      ) : (
        <button
          type="button"
          data-action="toggle-entry"
          aria-expanded={open}
          onClick={toggle}
          className={cn(head, 'cursor-pointer border-0 bg-transparent p-0 text-left')}
        >
          {open ? (
            <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRightIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
          )}
          {attribution}
          {!open && headline}
        </button>
      )}
      {open && toggle !== undefined && (
        <p
          className={cn(
            'entry-body pl-5',
            quiet ? 'text-xs text-muted-foreground' : 'font-mono text-xs',
          )}
        >
          {bodyOf(row)}
        </p>
      )}
    </li>
  )
}

/** Shared by every row so the dividers land on an even rhythm. */
const ROW = 'flex flex-col gap-0.5 py-2.5 first:pt-0 last:pb-0'

/**
 * Where one agent stops and the next starts.
 *
 * A phase's transcript is an implementer, a reviewer, and a fix round or three,
 * appended to one file in order — and until the daemon started recording who
 * wrote each line there was no way to tell, mid-scroll, which of them you were
 * reading. This is that boundary, and only the boundary: a badge on every row
 * would say the same thing ninety times running.
 *
 * `role` is whatever the daemon wrote (`journal/transcript.ts` explains why it
 * is a string and not a union), so a role this build has never heard of shows
 * as itself rather than as nothing.
 */
function Author({ role, first }: { readonly role: string; readonly first: boolean }) {
  return (
    <li
      data-turn={role}
      className={cn(
        'flex items-center gap-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground',
        first ? 'pt-0' : 'pt-3',
      )}
    >
      <span className="h-px flex-none basis-3 bg-border" aria-hidden="true" />
      {ROLE_NAMES[role] ?? role}
      <span className="h-px min-w-0 flex-1 bg-border" aria-hidden="true" />
    </li>
  )
}

/** The roles the shipped pipeline and the daemon produce, in words. */
const ROLE_NAMES: Readonly<Record<string, string>> = {
  // §7's rule, in the band: the operator's steering is never filed under the
  // agent that received it, even though the adapter echoes it back on that
  // agent's own event stream.
  operator: 'You',
  implementer: 'Implementer',
  reviewer: 'Reviewer',
  fixer: 'Fixer',
  'conflict-fixer': 'Conflict fixer',
  gate: 'Gate',
  monitor: 'Monitor',
}
