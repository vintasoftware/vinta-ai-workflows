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
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { Button } from 'vinta-design-system/ui/button'
import { CLOSED, Entries, FoldControls, type Folded } from './Entries.tsx'
import { EmptyNote, Panel } from './Panel.tsx'
import { fold } from './transcript.ts'

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

export function Transcript({ entries }: { readonly entries: readonly unknown[] }) {
  // The box's height is the panel's to decide (`Panel.tsx`): expanded it is a
  // screen, collapsed it is 480px, and the following below works either way.
  const [visible, setVisible] = useState(TRANSCRIPT_WINDOW)
  const [open, setOpen] = useState<Folded>(CLOSED)
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

  const toggleKind = (shape: 'thinking' | 'tool'): void =>
    setOpen((current) => ({ ...current, [shape]: !current[shape] }))

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
          <Entries
            rows={rows}
            open={open}
            listRef={attach}
            className="max-h-[var(--panel-scroll,480px)] overflow-y-auto"
            onScroll={(event) => {
              const box = event.currentTarget
              resting.current = box.scrollTop
              follow(box.scrollHeight - box.scrollTop - box.clientHeight <= STICK_MARGIN)
              if (hidden > 0 && box.scrollTop <= SCROLL_MARGIN) grow()
            }}
          />
        </>
      )}
    </Panel>
  )
}

