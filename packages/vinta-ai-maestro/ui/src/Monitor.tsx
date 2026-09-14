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
 * Every exchange is kept for the life of the view and none of it is persisted:
 * this is a conversation about the journal, not part of it. Reloading starts a
 * fresh one, which is also true of the session behind it.
 */
import { useState } from 'react'
import { Button } from 'vinta-design-system/ui/button'
import type { Client } from './client.ts'
import { EmptyNote, Panel } from './Panel.tsx'

interface Exchange {
  readonly asked: string
  /** Null while the model is still thinking. */
  readonly answer: string | null
  readonly model: string | null
  readonly failed: boolean
}

export function MonitorPanel({ client, runId }: { readonly client: Client; readonly runId: string }) {
  const [exchanges, setExchanges] = useState<readonly Exchange[]>([])
  const [text, setText] = useState('')
  const [asking, setAsking] = useState(false)

  async function ask(): Promise<void> {
    const question = text.trim()
    if (question === '' || asking) return
    setText('')
    setAsking(true)
    // Shown immediately: a model takes seconds to answer, and a question that
    // vanishes from the box without appearing anywhere reads as a lost click.
    setExchanges((current) => [...current, { asked: question, answer: null, model: null, failed: false }])

    try {
      const { answer, model } = await client.ask(runId, question)
      setExchanges((current) => replaceLast(current, { answer, model, failed: false }))
    } catch {
      // The daemon's status is not shown: a 503 here means the harness would
      // not start, which is not something the operator can act on from this box.
      setExchanges((current) =>
        replaceLast(current, { answer: null, model: null, failed: true }),
      )
    } finally {
      setAsking(false)
    }
  }

  return (
    <Panel title="Monitor" className="monitor" data-monitor>
      {exchanges.length === 0 ? (
        <EmptyNote>
          Ask about this run — what is blocked, why a phase failed, what it would take to move on.
        </EmptyNote>
      ) : (
        <ol className="exchanges flex flex-col gap-3" data-exchanges>
          {exchanges.map((exchange, index) => (
            <li key={index} className="flex flex-col gap-1" data-exchange={index}>
              <p className="text-[13px] font-semibold text-tone-attention-foreground" data-asked>
                {exchange.asked}
              </p>
              {exchange.answer !== null && (
                <p className="whitespace-pre-wrap text-sm" data-answer>
                  {exchange.answer}
                </p>
              )}
              {exchange.answer === null && !exchange.failed && (
                <p className="text-sm text-muted-foreground" data-thinking>
                  Thinking…
                </p>
              )}
              {exchange.failed && (
                <p className="text-sm text-tone-error-foreground" data-failed>
                  The monitor could not be reached.
                </p>
              )}
              {exchange.model !== null && (
                <p className="text-xs text-muted-foreground" data-model>
                  {exchange.model}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}

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
        <Button type="submit" size="sm" data-action="ask" disabled={asking || text.trim() === ''}>
          {asking ? 'Asking…' : 'Ask'}
        </Button>
      </form>
    </Panel>
  )
}

/** The pending exchange is always the last one; only its answer changes. */
function replaceLast(
  exchanges: readonly Exchange[],
  patch: Omit<Exchange, 'asked'>,
): readonly Exchange[] {
  const last = exchanges.at(-1)
  if (last === undefined) return exchanges
  return [...exchanges.slice(0, -1), { ...last, ...patch }]
}
