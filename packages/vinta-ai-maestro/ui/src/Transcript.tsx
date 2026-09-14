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
 * The box opens at the *newest* row and stays there while new ones arrive. A
 * top-anchored scroller opens a live agent's transcript at the oldest of sixty
 * rows, so the thing the operator came to read — what it is doing now — is
 * below the fold, and every new entry pushes it further down. Sticking is
 * conditional, though: an operator who has scrolled up is reading, and yanking
 * them back to the bottom mid-sentence is worse than the problem it fixes.
 */
import { useLayoutEffect, useRef, useState } from 'react'
import { cn } from 'vinta-design-system/lib/utils'
import { Button } from 'vinta-design-system/ui/button'
import { ToneDot } from './Chip.tsx'
import { EmptyNote, Panel } from './Panel.tsx'
import { present } from './transcript.ts'

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

export function Transcript({ entries }: { readonly entries: readonly unknown[] }) {
  // The box's height is the panel's to decide (`Panel.tsx`): expanded it is a
  // screen, collapsed it is 480px, and the following below works either way.
  const [visible, setVisible] = useState(TRANSCRIPT_WINDOW)
  const list = useRef<HTMLOListElement>(null)
  // Starts true so the first paint lands on the newest row. A ref rather than
  // state: it is read during layout and changing it must never re-render.
  const following = useRef(true)

  const hidden = Math.max(0, entries.length - visible)
  const shown = entries.slice(hidden)
  const grow = (): void => setVisible((current) => current + TRANSCRIPT_WINDOW)

  // Before paint, so the newest row is never briefly visible at the wrong
  // offset. Growing the window prepends rows and also lands here, but only
  // ever with `following` false — the operator had to scroll to the top to
  // ask for them.
  useLayoutEffect(() => {
    const element = list.current
    if (element === null || !following.current) return
    element.scrollTop = element.scrollHeight
  }, [shown.length])

  return (
    <Panel
      title="Transcript"
      expandable
      className="transcript"
      action={
        entries.length > 0 ? (
          <span className="muted text-xs text-muted-foreground" data-transcript-window>
            Showing {shown.length} of {entries.length}
          </span>
        ) : undefined
      }
    >
      {entries.length === 0 ? (
        <EmptyNote>No transcript yet.</EmptyNote>
      ) : (
        <>
          {hidden > 0 && (
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
          )}
          <ol
            ref={list}
            className="entries max-h-[var(--panel-scroll,480px)] divide-y overflow-y-auto"
            onScroll={(event) => {
              const box = event.currentTarget
              following.current =
                box.scrollHeight - box.scrollTop - box.clientHeight <= STICK_MARGIN
              if (hidden > 0 && box.scrollTop <= SCROLL_MARGIN) grow()
            }}
          >
            {shown.map((raw, index) => {
              const view = present(raw)
              return (
                <li
                  key={hidden + index}
                  data-entry={hidden + index}
                  data-kind={view.kind}
                  className="flex flex-col gap-0.5 py-2.5 first:pt-0 last:pb-0"
                >
                  <p className="entry-head flex items-center gap-2 text-[13px]">
                    <span
                      className={cn('entry-author font-semibold', AUTHOR[view.author])}
                      data-author={view.author}
                    >
                      {view.label}
                    </span>
                    {/* The kind is `view.label`'s job and the status is the
                        dot's; the event type stays in `data-kind`, where a
                        test or a stylesheet can reach it and a reader is not
                        asked to. */}
                    {view.tone !== null && <ToneDot tone={view.tone} />}
                  </p>
                  <p className="entry-body text-sm">{view.body}</p>
                </li>
              )
            })}
          </ol>
        </>
      )}
    </Panel>
  )
}
