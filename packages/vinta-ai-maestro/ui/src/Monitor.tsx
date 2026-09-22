/**
 * Asking the run's monitor a question (`monitor/monitor.ts`).
 *
 * A conversation rather than a report, because the useful questions are not
 * knowable in advance: "why is p1 blocked" and "does phase 3 still make sense
 * given what p0 found" are not fields on a dashboard.
 *
 * It is on the *run* view rather than the phase panel on purpose. The monitor
 * reads the whole run, and its best answers are the ones a single phase cannot
 * give — which phase is holding the others up, whether two failures share a
 * cause. A per-phase chat would invite questions it answers worse.
 *
 * **The conversation is the journal's, not the tab's.** An earlier version kept
 * it in component state, which meant a reload lost every question and every
 * answer — a worse record than the run it was describing. It is written to the
 * transcript store under a reserved node id, so it survives the tab, the
 * daemon, and the run itself.
 *
 * **And the turn is the daemon's, not the tab's.** That is the other half, and
 * it is newer. Asking used to be one long HTTP request with the whole answer in
 * its response, so the turn lived exactly as long as the connection: switching
 * view, reloading, or letting a laptop sleep killed the monitor mid-thought and
 * left a question with no answer and no record that one had been attempted. The
 * daemon owns the turn now. This posts a question, gets `202`, and reads the
 * conversation back — which is also what a *second* tab, or the same tab
 * tomorrow, would see.
 *
 * So there are two clocks here. A slow one that keeps a finished conversation
 * fresh, and a fast one that runs only while an answer is arriving. The monitor
 * journals as it thinks, so the fast one is what turns "Thinking…" from a word
 * into the thing it is actually doing.
 */
import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { Button } from 'vinta-design-system/ui/button'
import type { Client } from './client.ts'
import { CLOSED, Entries, FoldControls, type Folded } from './Entries.tsx'
import { useFollowing } from './follow.ts'
import { EmptyNote, ErrorNote, Panel } from './Panel.tsx'
import { fold } from './transcript.ts'

/**
 * How often the conversation is re-read while an answer is arriving.
 *
 * Fast, because this is the only thing on the page that moves and the operator
 * is watching it. It costs one tail of a small file per second, against a
 * daemon on the same machine, and only while a turn is running.
 */
const WHILE_THINKING_MS = 1_000

export function MonitorPanel({ client, runId }: { readonly client: Client; readonly runId: string }) {
  const [entries, setEntries] = useState<readonly unknown[]>([])
  const [pending, setPending] = useState(false)
  const [text, setText] = useState('')
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState<Folded>(CLOSED)
  const { listRef, onScroll, following, jump, stick } = useFollowing()

  const reload = useCallback(async () => {
    try {
      const conversation = await client.conversation(runId)
      setEntries(conversation.entries)
      setPending(conversation.pending)
    } catch {
      // A history that will not load is not worth an alarm: the box still
      // works, and the next answer brings the whole thing back with it.
    }
  }, [client, runId])

  useEffect(() => {
    void reload()
  }, [reload])

  // Only while something is coming. A finished conversation is re-read when the
  // view mounts and when a question is asked, and polling it every second for
  // the rest of the session would be a request per second for a file that
  // nothing is writing to.
  useEffect(() => {
    if (!pending) return
    const tick = setInterval(() => void reload(), WHILE_THINKING_MS)
    return () => clearInterval(tick)
  }, [pending, reload])

  // The answer arrives at the bottom, so that is where the box opens and stays.
  //
  // It used to stick **only while a turn was running**, on the theory that this
  // list is short and the operator is watching the answer they just asked for.
  // Neither half held. The conversation is the journal's, so it is every
  // question ever asked about this run — a hundred entries is ordinary — and
  // the interventions a run makes about itself land in it with nobody having
  // asked anything. So opening the panel put the operator at the oldest entry
  // of a long history, and the newest, which is the only one that could still
  // be relevant, was as far below the fold as the run was old.
  //
  // Now it follows the way a phase's transcript does, conditionally and with an
  // escape (`follow.ts`), because the other half of the old reasoning was also
  // wrong: there is plenty above worth reading, and yanking somebody out of it
  // is worse than the problem.
  useLayoutEffect(() => {
    stick()
  }, [entries.length, stick])

  async function ask(): Promise<void> {
    const question = text.trim()
    if (question === '' || pending) return
    setText('')
    setFailed(false)
    // Set before the round trip so the polling starts immediately, and the
    // journal has the question before the model is asked, so a reload during
    // the turn shows a question being answered rather than nothing at all.
    setPending(true)
    try {
      await client.ask(runId, question)
    } catch {
      setFailed(true)
      setPending(false)
    }
    await reload()
  }

  const rows = fold(entries, 0)

  return (
    <Panel
      title="Monitor"
      className="monitor"
      data-monitor
      expandable
      action={
        entries.length > 0 ? (
          <>
            <FoldControls
              open={open}
              onToggle={(shape) => setOpen((current) => ({ ...current, [shape]: !current[shape] }))}
            />
            <span className="muted text-xs text-muted-foreground" data-conversation-size>
              {entries.length} in this conversation
            </span>
          </>
        ) : undefined
      }
    >
      {entries.length === 0 && !pending ? (
        <EmptyNote>
          Ask about this run — what is blocked, why a phase failed, what it would take to move on.
        </EmptyNote>
      ) : (
        <>
          {/* The escape from the following rule, and the only way back into it
              short of scrolling to the very bottom by hand. It appears only
              once the reader has left the newest row, so it is never a control
              that does nothing. */}
          {!following && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="w-fit self-end"
              data-action="jump-latest"
              onClick={jump}
            >
              Jump to latest
            </Button>
          )}
          <Entries
            rows={rows}
            open={open}
            listRef={listRef}
            onScroll={onScroll}
            className="exchanges max-h-[var(--panel-scroll,320px)] overflow-y-auto"
            data-exchanges
          />
        </>
      )}

      {/* Said once, under the conversation, and only while nothing of the
          answer has arrived yet. Once the monitor starts thinking out loud the
          rows say it better than a word does — which is the whole reason the
          daemon journals a turn as it runs rather than at the end of it. */}
      {pending && (
        <p className="text-sm text-muted-foreground" data-thinking>
          Thinking…
        </p>
      )}

      {failed && <ErrorNote>The monitor could not be reached.</ErrorNote>}

      <form
        className="flex items-start gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void ask()
        }}
      >
        <textarea
          className="min-h-16 flex-1 resize-y rounded-md border bg-background px-2.5 py-2 text-sm"
          data-field="question"
          aria-label="Ask the monitor about this run"
          placeholder="Why did p1 fail?"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, because this is a question box and not a document.
            // Shift+Enter is the escape hatch for a question worth two lines.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void ask()
            }
          }}
        />
        <Button type="submit" size="sm" data-action="ask" disabled={pending || text.trim() === ''}>
          {pending ? 'Asking…' : 'Ask'}
        </Button>
      </form>
    </Panel>
  )
}
