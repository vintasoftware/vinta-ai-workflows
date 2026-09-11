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
 */
import { useState } from 'react'
import { cn } from 'vinta-design-system/lib/utils'
import { Button } from 'vinta-design-system/ui/button'
import { ToneDot } from './Chip.tsx'
import { EmptyNote, Panel } from './Panel.tsx'
import { present } from './transcript.ts'

/** Rows per window step. Big enough to fill a screen, small enough to be cheap. */
export const TRANSCRIPT_WINDOW = 60

/** Grow the window when the operator scrolls within this much of the top. */
const SCROLL_MARGIN = 40

/** The author's colour: the operator stands out, machinery recedes. */
const AUTHOR: Readonly<Record<string, string>> = {
  operator: 'text-tone-attention-foreground',
  tool: 'text-muted-foreground',
  system: 'text-muted-foreground',
}

export function Transcript({ entries }: { readonly entries: readonly unknown[] }) {
  const [visible, setVisible] = useState(TRANSCRIPT_WINDOW)

  const hidden = Math.max(0, entries.length - visible)
  const shown = entries.slice(hidden)
  const grow = (): void => setVisible((current) => current + TRANSCRIPT_WINDOW)

  return (
    <Panel
      title="Transcript"
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
            className="entries max-h-[480px] divide-y overflow-y-auto"
            onScroll={(event) => {
              if (hidden > 0 && event.currentTarget.scrollTop <= SCROLL_MARGIN) grow()
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
