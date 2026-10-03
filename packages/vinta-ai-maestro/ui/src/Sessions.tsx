/**
 * §15's session reuse, as the operator sees it: one point on a timeline per
 * agent turn, saying which slot it ran on and whether it continued that slot's
 * session.
 *
 * The panel exists because reuse fails *quietly*. A run whose sessions stopped
 * being reused looks exactly like one that never reused — same statuses, same
 * transcripts, same result, just more tokens and a slower fix loop. The reason
 * is the whole point of the row: without it "fresh" is an observation nobody
 * can act on.
 *
 * **Newest first, and only the last few.** It used to be every turn, oldest
 * first, which on a phase with a long fix loop made it the tallest thing on
 * the page and put the one turn that matters — the one happening now — at the
 * bottom of it. The card shows the latest `SESSIONS_SHOWN`; the whole history
 * is one button away, in a dialog that scrolls on its own.
 *
 * **The live turn says so.** While the node is in an agent turn, the newest
 * point pulses and counts up from when the turn began. "In an agent turn" is
 * the node running *and* no gate running: gates run between turns, and a pulse
 * on the last turn while the suite runs would claim an agent is working when
 * it is waiting.
 *
 * **Fresh is not a failure, and the colours say so.** Most cold turns are
 * correct — the first turn on a slot has nothing to continue, and the last fix
 * round is deliberately handed to an agent that has not seen the work (§15.5).
 * Only `stale_session` gets the waiting tone, because it is the one that cost
 * something nobody asked for: a spawn spent being told the session was gone.
 */
import { HistoryIcon } from 'lucide-react'
import { useState } from 'react'
import { cn } from 'vinta-design-system/lib/utils'
import { Button } from 'vinta-design-system/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from 'vinta-design-system/ui/dialog'
import type { NodeDetail } from '../../src/daemon/schemas.ts'
import { Chip, TONE_DOT } from './Chip.tsx'
import { EmptyNote, Panel } from './Panel.tsx'
import type { Tone } from './status.ts'
import { ago, elapsed, useNow } from './time.ts'

type Turn = NodeDetail['sessions'][number]

/** How many turns the card shows before the rest move into the dialog. */
export const SESSIONS_SHOWN = 5

export function Sessions({
  sessions,
  live,
}: {
  /** Oldest first, as the daemon serves them. */
  readonly sessions: NodeDetail['sessions']
  /** The node is inside an agent turn right now, so the newest turn is running. */
  readonly live: boolean
}) {
  const [all, setAll] = useState(false)
  const reused = sessions.filter((turn) => turn.disposition === 'reused').length
  const summary = (
    <span data-session-summary>
      {reused} of {sessions.length} {sessions.length === 1 ? 'turn' : 'turns'} continued a session.
    </span>
  )
  const hidden = sessions.length - SESSIONS_SHOWN

  return (
    <Panel
      title="Agent sessions"
      data-sessions
      description={sessions.length === 0 ? undefined : summary}
    >
      {sessions.length === 0 ? (
        <EmptyNote>No agent turn has run yet.</EmptyNote>
      ) : (
        <>
          <Timeline sessions={sessions} live={live} limit={SESSIONS_SHOWN} className="sessions" />
          {hidden > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full justify-center text-muted-foreground hover:text-foreground"
              data-action="all-sessions"
              aria-haspopup="dialog"
              onClick={() => setAll(true)}
            >
              <HistoryIcon aria-hidden="true" />
              Show the full timeline
              <span className="text-xs font-normal tabular-nums text-muted-foreground">
                {hidden} earlier {hidden === 1 ? 'turn' : 'turns'}
              </span>
            </Button>
          )}
          <Dialog open={all} onOpenChange={setAll}>
            <DialogContent
              data-sessions-dialog
              className="flex max-h-[min(46rem,calc(100vh-4rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl"
            >
              <DialogHeader className="gap-1.5 border-b px-5 py-4 pr-12 text-left">
                <DialogTitle className="flex items-center gap-2 text-base">
                  <HistoryIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                  Agent sessions
                </DialogTitle>
                <DialogDescription>
                  Newest first. {reused} of {sessions.length} turns continued a session.
                </DialogDescription>
              </DialogHeader>
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                <Timeline sessions={sessions} live={live} className="sessions-all" />
              </div>
            </DialogContent>
          </Dialog>
        </>
      )}
    </Panel>
  )
}

/**
 * The turns, newest at the top, on a rail. A `limit` that cuts the list short
 * leaves the rail trailing off in dashes, so the last visible point does not
 * read as the first turn there was.
 */
function Timeline({
  sessions,
  live,
  limit = sessions.length,
  className,
}: {
  readonly sessions: NodeDetail['sessions']
  readonly live: boolean
  readonly limit?: number
  readonly className: string
}) {
  // One clock for every row's "ago", slow enough to cost nothing.
  const now = useNow(15_000)
  const newest = sessions.length - 1
  const shown = sessions
    .map((turn, index) => ({ turn, number: index + 1 }))
    .reverse()
    .slice(0, limit)
  const truncated = shown.length < sessions.length

  return (
    <ol className={cn('flex flex-col', className)}>
      {shown.map(({ turn, number }, position) => (
        // The turn number is the key: a slot legitimately repeats (`main` is
        // every implementer and fixer turn), but a position in an append-only
        // sequence does not.
        <TurnPoint
          key={number}
          turn={turn}
          number={number}
          now={now}
          running={live && number - 1 === newest}
          rail={position < shown.length - 1 ? 'solid' : truncated ? 'trailing' : 'none'}
        />
      ))}
    </ol>
  )
}

function TurnPoint({
  turn,
  number,
  now,
  running,
  rail,
}: {
  readonly turn: Turn
  readonly number: number
  readonly now: number
  readonly running: boolean
  /** What runs below this point: the line to the next one, a fade-out, or nothing. */
  readonly rail: 'solid' | 'trailing' | 'none'
}) {
  const tone = sessionTone(turn)

  return (
    <li
      data-session-slot={turn.slot}
      data-session-turn={number}
      data-running={running ? '' : undefined}
      className="relative flex gap-3 pb-4 last:pb-0"
    >
      <span aria-hidden="true" className="relative flex w-2.5 shrink-0 justify-center pt-[5px]">
        {/* The rail runs from under this dot to the top of the next one. This
            span stretches to the row's content box, so the bottom offset is
            the row's padding plus the next dot's 5px inset. */}
        {rail !== 'none' && (
          <span
            className={cn(
              'absolute top-[15px] left-1/2 w-0 -translate-x-1/2 border-l border-muted-foreground/30',
              rail === 'solid'
                ? '-bottom-[21px]'
                : '-bottom-5 border-dashed [mask-image:linear-gradient(to_bottom,black,transparent)]',
            )}
          />
        )}
        <span className="relative flex size-2.5">
          {running && (
            <span className="absolute inset-0 rounded-full bg-tone-active opacity-60 motion-safe:animate-ping" />
          )}
          <span
            className={cn(
              'relative size-2.5 rounded-full ring-4 ring-card',
              running ? TONE_DOT.active : TONE_DOT[tone],
            )}
          />
        </span>
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="entry-head flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="entry-author text-[13px] font-semibold">{turn.slot}</span>
          <Chip tone={tone}>{turn.disposition}</Chip>
          {turn.sessionId !== undefined && (
            <span className="muted font-mono text-xs text-muted-foreground" title={turn.sessionId}>
              {shortId(turn.sessionId)}
            </span>
          )}
          <span
            className="ml-auto flex items-baseline gap-1.5 text-xs tabular-nums text-muted-foreground"
            title={`Turn ${number}, ${new Date(turn.at).toLocaleString()}`}
          >
            {running ? (
              <span className="font-medium text-tone-active-foreground" data-session-live>
                running · <LiveFor since={turn.at} />
              </span>
            ) : (
              ago(turn.at, now)
            )}
          </span>
        </p>
        {turn.reason !== undefined && (
          <p className="muted entry-body text-xs text-muted-foreground">{sessionReason(turn.reason)}</p>
        )}
      </div>
    </li>
  )
}

/** Its own component, so only the running row carries a one-second clock. */
function LiveFor({ since }: { readonly since: number }) {
  return <>{elapsed(since, useNow(1000))}</>
}

/** Reused is good news, cold is usually correct, and one case cost a spawn. */
function sessionTone(turn: Turn): Tone {
  if (turn.disposition === 'reused') return 'ok'
  return turn.reason === 'stale_session' ? 'wait' : 'idle'
}

/**
 * The daemon's closed reason vocabulary, in words.
 *
 * An unrecognised token falls through to itself rather than to "unknown": a
 * browser served by a newer daemon should show the operator the thing it was
 * told, which is ugly and true, instead of hiding it behind wording this build
 * happens to know.
 */
function sessionReason(reason: string): string {
  switch (reason) {
    case 'no_prior_session':
      return 'First turn on this slot — there was nothing to continue.'
    case 'harness_changed':
      return 'The slot’s session belongs to a different harness.'
    case 'lane_changed':
      return 'The node is in a different lane than the session ran in.'
    case 'no_resume_capability':
      return 'This harness cannot continue a session.'
    case 'turn_ceiling':
      return 'The slot reached its turn limit, so the context starts over.'
    case 'final_fix_round':
      return 'Last fix round — deliberately an agent that has not seen the work.'
    case 'stale_session':
      return 'The harness had forgotten the session. The turn was retried cold.'
    case 'no_slot':
      return 'This step asked for a fresh session.'
    default:
      return reason
  }
}

/**
 * Enough of an id to tell two sessions apart; the full one is on hover.
 *
 * The **tail**, not the head. A session id is a vendor prefix followed by the
 * unique part — `claude-code-01J8ZQ4M7X2K` — so truncating from the left shows
 * the twelve characters every session on this harness shares and hides the only
 * ones that differ. An id is on this row to be compared, not read.
 */
function shortId(sessionId: string): string {
  return sessionId.length <= 14 ? sessionId : `…${sessionId.slice(-12)}`
}
