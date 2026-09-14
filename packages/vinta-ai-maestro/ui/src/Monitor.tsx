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
 * daemon, and the run itself; this view reads it back on mount and after each
 * answer, and holds only the question currently in flight.
 */
import { useCallback, useEffect, useState } from 'react'
import { Button } from 'vinta-design-system/ui/button'
import type { Client } from './client.ts'
import { EmptyNote, ErrorNote, Panel } from './Panel.tsx'
import { present } from './transcript.ts'

export function MonitorPanel({ client, runId }: { readonly client: Client; readonly runId: string }) {
  const [entries, setEntries] = useState<readonly unknown[]>([])
  const [pending, setPending] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [failed, setFailed] = useState(false)

  const reload = useCallback(async () => {
    try {
      setEntries(await client.conversation(runId))
    } catch {
      // A history that will not load is not worth an alarm: the box still
      // works, and the next answer brings the whole thing back with it.
    }
  }, [client, runId])

  useEffect(() => {
    void reload()
  }, [reload])

  async function ask(): Promise<void> {
    const question = text.trim()
    if (question === '' || pending !== null) return
    setText('')
    setFailed(false)
    // Held locally only while it is in flight. The daemon writes it to the
    // journal before the model is asked, so the reload below is what makes it
    // permanent — and what makes a question whose answer never came still
    // visible as a question that was asked.
    setPending(question)
    try {
      await client.ask(runId, question)
    } catch {
      setFailed(true)
    } finally {
      setPending(null)
      await reload()
    }
  }

  return (
    <Panel
      title="Monitor"
      className="monitor"
      data-monitor
      expandable
      action={
        entries.length > 0 ? (
          <span className="muted text-xs text-muted-foreground" data-conversation-size>
            {entries.length} in this conversation
          </span>
        ) : undefined
      }
    >
      {entries.length === 0 && pending === null ? (
        <EmptyNote>
          Ask about this run — what is blocked, why a phase failed, what it would take to move on.
        </EmptyNote>
      ) : (
        <ol
          className="exchanges flex max-h-[var(--panel-scroll,320px)] flex-col gap-3 overflow-y-auto"
          data-exchanges
        >
          {entries.map((entry, index) => {
            const view = present(entry)
            return (
              <li key={index} className="flex flex-col gap-0.5" data-exchange={index}>
                <p
                  className={
                    view.author === 'operator'
                      ? 'text-[13px] font-semibold text-tone-attention-foreground'
                      : 'text-[13px] font-semibold'
                  }
                  data-author={view.author}
                >
                  {view.label}
                </p>
                <p className="whitespace-pre-wrap text-sm" data-body>
                  {view.body}
                </p>
              </li>
            )
          })}
          {pending !== null && (
            <li className="flex flex-col gap-0.5" data-pending>
              <p className="text-[13px] font-semibold text-tone-attention-foreground">You</p>
              <p className="whitespace-pre-wrap text-sm">{pending}</p>
              <p className="text-sm text-muted-foreground" data-thinking>
                Thinking…
              </p>
            </li>
          )}
        </ol>
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
        <Button
          type="submit"
          size="sm"
          data-action="ask"
          disabled={pending !== null || text.trim() === ''}
        >
          {pending !== null ? 'Asking…' : 'Ask'}
        </Button>
      </form>
    </Panel>
  )
}
