/**
 * The transcript, chat-rendered and windowed.
 *
 * A run's transcript reaches megabytes (§5.3) and the endpoint already tails
 * it, but a tail of 500 tool results is still 500 DOM subtrees on a page that
 * re-reads every couple of seconds. So the list keeps a window over the tail:
 * `visible` rows from the end, grown by the button or by scrolling to the top
 * of the box, and never by the arrival of new entries. Only what is inside the
 * window is mounted.
 *
 * The window is anchored at the *end* because that is where a live agent is
 * writing, and because the endpoint cannot page backwards past the tail it
 * served — "show earlier" can only ever reveal more of what is already here,
 * which is exactly what the button says.
 *
 * Keys are absolute indices from the start of the served tail, so appending to
 * a live transcript does not remount the rows already on screen.
 *
 * **Following.** The box opens at the newest row and stays there while new ones
 * arrive. A top-anchored scroller opens a live agent's transcript at the oldest
 * of sixty rows, so the thing the operator came to read — what it is doing now
 * — is below the fold, and every new entry pushes it further down. Sticking is
 * conditional, though: an operator who has scrolled up is reading, and yanking
 * them back to the bottom mid-sentence is worse than the problem it fixes.
 *
 * Two things about the following are load-bearing and were each a bug.
 *
 * - **It keys on `entries.length`, not on how many are shown.** The shown count
 *   is `min(entries.length, visible)`, which stops changing the moment the
 *   transcript is longer than one window — so an effect keyed on it followed
 *   perfectly up to entry sixty and then silently never again, including after
 *   the operator scrolled back to the bottom to ask for it.
 * - **Growing the window preserves the anchor.** Rows are prepended, so holding
 *   `scrollTop` still moves the reader by exactly the height of what arrived.
 *   The distance from the viewport to the *bottom* of the content is what stays
 *   fixed, which is the one measurement prepending does not change.
 *
 * And because an implicit rule needs an explicit escape: once following has
 * stopped there is a button that starts it again, rather than a 60px band at
 * the bottom of a scroller being the only way back into it.
 *
 * **Density.** Rows are not all worth the same room (`transcript.ts`). Prose
 * reads at full size. Thinking is smaller and quieter, and consecutive thinking
 * is one row rather than a dozen. Tool calls collapse to the argument that says
 * what they did. Each row opens on its own, and the header opens or closes a
 * whole kind at once.
 */
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react'
import { Fragment, useCallback, useLayoutEffect, useRef, useState } from 'react'
import { cn } from 'vinta-design-system/lib/utils'
import { Button } from 'vinta-design-system/ui/button'
import { ToneDot } from './Chip.tsx'
import { EmptyNote, Panel } from './Panel.tsx'
import { bodyOf, fold, hasMore, headlineOf, type Row } from './transcript.ts'

/** Rows per window step. Big enough to fill a screen, small enough to be cheap. */
export const TRANSCRIPT_WINDOW = 60

/** Grow the window when the operator scrolls within this much of the top. */
const SCROLL_MARGIN = 40

/**
 * Treat the view as "at the bottom" within this much of it.
 *
 * Wider than an exact test on purpose: a row arriving mid-scroll, or a
 * fractional device pixel, must not read as "the operator has scrolled away"
 * and silently stop the following.
 */
const STICK_MARGIN = 60

/** The author's colour: the operator stands out, machinery recedes. */
const AUTHOR: Readonly<Record<string, string>> = {
  operator: 'text-tone-attention-foreground',
  tool: 'text-muted-foreground',
  system: 'text-muted-foreground',
}

/** Which kinds start open. Prose is not in here because prose never folds. */
type Folded = Record<'thinking' | 'tool', boolean>

const CLOSED: Folded = { thinking: false, tool: false }

export function Transcript({ entries }: { readonly entries: readonly unknown[] }) {
  // The box's height is the panel's to decide (`Panel.tsx`): expanded it is a
  // screen, collapsed it is 480px, and the following below works either way.
  const [visible, setVisible] = useState(TRANSCRIPT_WINDOW)
  const [open, setOpen] = useState<Folded>(CLOSED)
  // Rows the operator opened or closed against the header's setting, by
  // absolute index. Cleared whenever a header toggle moves: that button means
  // "show me all of this now", and honouring stale per-row choices underneath
  // it would make the button lie about what it did.
  const [overrides, setOverrides] = useState<Readonly<Record<number, boolean>>>({})
  const list = useRef<HTMLOListElement | null>(null)
  // Truth for the layout effect, which reads it during a commit that the state
  // below may not have caused. The state is only so the button can render.
  const following = useRef(true)
  const [followingNow, setFollowingNow] = useState(true)
  // The distance from the viewport to the bottom of the content, captured
  // before a window grows and restored after it has. Null except across that.
  const anchor = useRef<number | null>(null)
  // Where a reader who is not following was last looking, so it survives the
  // list being rebuilt underneath them. See `attach`.
  const resting = useRef(0)
  const resize = useRef<ResizeObserver | null>(null)

  const hidden = Math.max(0, entries.length - visible)
  const rows = fold(entries.slice(hidden), hidden)

  const follow = (value: boolean): void => {
    following.current = value
    setFollowingNow(value)
  }

  const grow = (): void => {
    const element = list.current
    if (element !== null) anchor.current = element.scrollHeight - element.scrollTop
    setVisible((current) => current + TRANSCRIPT_WINDOW)
  }

  const jump = (): void => {
    follow(true)
    const element = list.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }

  const toggleKind = (shape: 'thinking' | 'tool'): void => {
    setOpen((current) => ({ ...current, [shape]: !current[shape] }))
    setOverrides({})
  }

  // Before paint, so a row is never briefly visible at the wrong offset.
  useLayoutEffect(() => {
    const element = list.current
    if (element === null) return
    if (following.current) {
      element.scrollTop = element.scrollHeight
      return
    }
    if (anchor.current !== null) {
      element.scrollTop = element.scrollHeight - anchor.current
      anchor.current = null
    }
  }, [entries.length, visible])

  /**
   * A callback ref, because this list does not merely change — it is *replaced*.
   *
   * Expanding the panel moves it through a portal (`Panel.tsx`), which unmounts
   * the whole subtree and builds it again in `document.body`. The new `ol` is a
   * new element scrolled to the top, and no render of this component
   * accompanies it, so neither the effect above nor an observer bound to the old
   * node has anything to say about it. The reader who expanded the panel to see
   * more of the transcript landed at the start of it.
   *
   * So the position is reapplied whenever an element arrives: the bottom if they
   * were following, and otherwise where they were. The observer is rebound at
   * the same moment, which is what catches the *other* thing a full-page panel
   * does — swapping `--panel-scroll` from 480px to most of the window, moving
   * the newest row off the screen with no render either. Resizing the window
   * does the same thing more slowly.
   *
   * `ResizeObserver` is guarded because jsdom has none. Nothing in the suite
   * asserts that path; what it protects is a real browser, where the only
   * alternative is polling a height.
   */
  const attach = useCallback((element: HTMLOListElement | null) => {
    resize.current?.disconnect()
    resize.current = null
    list.current = element
    if (element === null) return

    const stick = (): void => {
      if (following.current) element.scrollTop = element.scrollHeight
    }
    if (following.current) stick()
    else element.scrollTop = resting.current

    if (typeof ResizeObserver === 'undefined') return
    resize.current = new ResizeObserver(stick)
    resize.current.observe(element)
  }, [])

  return (
    <Panel
      title="Transcript"
      expandable
      className="transcript"
      action={
        entries.length > 0 ? (
          <>
            <Fold
              shape="thinking"
              label="Thinking"
              noun="thinking block"
              on={open.thinking}
              onToggle={toggleKind}
            />
            <Fold
              shape="tool"
              label="Tools"
              noun="tool call"
              on={open.tool}
              onToggle={toggleKind}
            />
            {/* Entries, not rows: grouping consecutive thinking is a rendering
                decision and must not make the window look smaller than it is. */}
            <span className="muted text-xs text-muted-foreground" data-transcript-window>
              Showing {entries.length - hidden} of {entries.length}
            </span>
          </>
        ) : undefined
      }
    >
      {entries.length === 0 ? (
        <EmptyNote>No transcript yet.</EmptyNote>
      ) : (
        <>
          {(hidden > 0 || !followingNow) && (
            <div className="flex items-center justify-between gap-2">
              {hidden > 0 ? (
                <Button
                  type="button"
                  variant="link"
                  size="xs"
                  className="link w-fit px-0"
                  data-action="show-earlier"
                  onClick={grow}
                >
                  Show {Math.min(TRANSCRIPT_WINDOW, hidden)} earlier
                </Button>
              ) : (
                <span />
              )}
              {!followingNow && (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="w-fit"
                  data-action="jump-latest"
                  onClick={jump}
                >
                  Jump to latest
                </Button>
              )}
            </div>
          )}
          <ol
            ref={attach}
            className="entries max-h-[var(--panel-scroll,480px)] divide-y overflow-y-auto"
            onScroll={(event) => {
              const box = event.currentTarget
              resting.current = box.scrollTop
              follow(box.scrollHeight - box.scrollTop - box.clientHeight <= STICK_MARGIN)
              if (hidden > 0 && box.scrollTop <= SCROLL_MARGIN) grow()
            }}
          >
            {rows.map((row, index) => {
              const shape = row.shape
              // The band, not a per-row badge. A phase is an implementer, a
              // reviewer and three fix rounds in one file, and what a reader
              // needs is the *boundary* — where one agent stopped and the next
              // started — which a label repeated on ninety consecutive rows
              // states ninety times and shows once.
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
        </>
      )}
    </Panel>
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
        <p className="entry-body text-sm">{view.body}</p>
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
