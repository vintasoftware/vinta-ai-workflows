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
 * **Following** lives in `follow.ts`, shared with the monitor panel — the box
 * opens at the newest row, stays there while new ones arrive, and lets go the
 * moment the operator scrolls up to read. What stays here is the one part of it
 * that is about the *window* rather than about the scroller:
 *
 * - **Growing the window preserves the anchor.** Rows are prepended, so holding
 *   `scrollTop` still moves the reader by exactly the height of what arrived.
 *   The distance from the viewport to the *bottom* of the content is what stays
 *   fixed, which is the one measurement prepending does not change.
 *
 * **Density.** Rows are not all worth the same room (`transcript.ts`). Prose
 * reads at full size. Thinking is smaller and quieter, and consecutive thinking
 * is one row rather than a dozen. Tool calls collapse to the argument that says
 * what they did. Each row opens on its own, and the header opens or closes a
 * whole kind at once.
 */
import { useLayoutEffect, useRef, useState } from 'react'
import { Button } from 'vinta-design-system/ui/button'
import { CLOSED, Entries, FoldControls, type Folded } from './Entries.tsx'
import { useFollowing } from './follow.ts'
import { EmptyNote, Panel } from './Panel.tsx'
import { fold } from './transcript.ts'

/** Rows per window step. Big enough to fill a screen, small enough to be cheap. */
export const TRANSCRIPT_WINDOW = 60

/** Grow the window when the operator scrolls within this much of the top. */
const SCROLL_MARGIN = 40

export function Transcript({ entries }: { readonly entries: readonly unknown[] }) {
  // The box's height is the panel's to decide (`Panel.tsx`): expanded it is a
  // screen, collapsed it is 480px, and the following below works either way.
  const [visible, setVisible] = useState(TRANSCRIPT_WINDOW)
  const [open, setOpen] = useState<Folded>(CLOSED)
  const { listRef, onScroll, following, jump, stick, list } = useFollowing()
  // The distance from the viewport to the bottom of the content, captured
  // before a window grows and restored after it has. Null except across that.
  const anchor = useRef<number | null>(null)

  const hidden = Math.max(0, entries.length - visible)
  const rows = fold(entries.slice(hidden), hidden)

  const grow = (): void => {
    const element = list.current
    if (element !== null) anchor.current = element.scrollHeight - element.scrollTop
    setVisible((current) => current + TRANSCRIPT_WINDOW)
  }

  const toggleKind = (shape: 'thinking' | 'tool'): void =>
    setOpen((current) => ({ ...current, [shape]: !current[shape] }))

  // Before paint, so a row is never briefly visible at the wrong offset. The
  // two branches are exclusive: a reader who is following wants the bottom, and
  // only a reader who is not can have asked for an earlier window.
  useLayoutEffect(() => {
    if (stick()) return
    const element = list.current
    if (element === null || anchor.current === null) return
    element.scrollTop = element.scrollHeight - anchor.current
    anchor.current = null
  }, [entries.length, visible, stick, list])

  return (
    <Panel
      title="Transcript"
      expandable
      className="transcript"
      action={
        entries.length > 0 ? (
          <>
            <FoldControls open={open} onToggle={toggleKind} />
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
          {(hidden > 0 || !following) && (
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
              {!following && (
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
          <Entries
            rows={rows}
            open={open}
            listRef={listRef}
            className="max-h-[var(--panel-scroll,480px)] overflow-y-auto"
            onScroll={(event) => {
              onScroll(event)
              if (hidden > 0 && event.currentTarget.scrollTop <= SCROLL_MARGIN) grow()
            }}
          />
        </>
      )}
    </Panel>
  )
}

