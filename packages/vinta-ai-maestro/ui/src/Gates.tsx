/**
 * The phase's gates: one headline row each, and the log of whichever one the
 * operator opens, in a dialog over the page.
 *
 * **The panel is a list of headlines, never a log.** It has been a wall of
 * logs (every gate's in its own 13rem box, each swallowing the wheel) and then
 * an accordion (one log at a time, inline). The accordion fixed the scrolling
 * but not the length: a failing suite's log is hundreds of lines, and opening
 * it pushed the session timeline below it off the bottom of a tall screen and
 * turned the right-hand column into the longest thing on the page. A dialog is
 * the one place a log can be as long as it is without moving anything else.
 *
 * **The dialog is a reading room, not a peek.** It is most of the window wide,
 * scrolls on its own, opens at the *end* of the log — where a test runner
 * prints its failures and its summary — and keeps following the tail while a
 * gate that is still running writes to it, unless the operator has scrolled up
 * to read. ← and → step through the gates without closing it, because the
 * question after "why did unit fail" is usually "and what did lint say".
 *
 * **Which gate is open lives with the caller**, because two things on the node
 * view open one: a row here, and §9.1's question card, whose context names the
 * gate it is asking about.
 */
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  ScrollTextIcon,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from 'vinta-design-system/lib/utils'
import { Button } from 'vinta-design-system/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from 'vinta-design-system/ui/dialog'
import { Kbd } from 'vinta-design-system/ui/kbd'
import type { NodeDetail } from '../../src/daemon/schemas.ts'
import { Chip } from './Chip.tsx'
import { EmptyNote, Panel } from './Panel.tsx'
import type { Tone } from './status.ts'
import { duration, elapsed, useNow } from './time.ts'

type Gate = NodeDetail['gates'][number]

export function Gates({
  gates,
  failing,
  open,
  onOpen,
}: {
  readonly gates: NodeDetail['gates']
  /** The gate §9.1's question points at, if any. Its row is marked. */
  readonly failing: string | null
  /** The gate whose log is open, or null for none. */
  readonly open: string | null
  readonly onOpen: (gateId: string | null) => void
}) {
  return (
    <Panel
      title="Gates"
      data-gates
      description={gates.length === 0 ? undefined : <GateSummary gates={gates} />}
    >
      {gates.length === 0 ? (
        <EmptyNote>No gate has run yet.</EmptyNote>
      ) : (
        <ul className="gates -mx-2 -my-1 flex flex-col">
          {gates.map((gate) => (
            <li key={gate.gateId} data-gate={gate.gateId}>
              <button
                type="button"
                data-action="open-gate-log"
                aria-haspopup="dialog"
                aria-label={`Open the ${gate.gateId} gate log`}
                onClick={() => onOpen(gate.gateId)}
                className={cn(
                  'group flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  gate.gateId === failing && 'bg-tone-attention-soft/50 hover:bg-tone-attention-soft',
                )}
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="truncate font-mono text-[13px] font-medium">{gate.gateId}</span>
                  <Chip tone={gateTone(gate.status)}>{GATE_LABELS[gate.status]}</Chip>
                  {gate.gateId === failing && <Chip tone="attention">asked about</Chip>}
                </span>
                <GateTiming gate={gate} />
                <ChevronRightIcon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
                />
              </button>
            </li>
          ))}
        </ul>
      )}
      <GateLogDialog gates={gates} open={open} onOpen={onOpen} />
    </Panel>
  )
}

/** "1 failed · 2 passed": the worst news first, and only the counts that exist. */
function GateSummary({ gates }: { readonly gates: NodeDetail['gates'] }) {
  const parts = SUMMARY_ORDER.flatMap((status) => {
    const count = gates.filter((gate) => gate.status === status).length
    return count === 0 ? [] : [`${count} ${GATE_LABELS[status]}`]
  })
  return <span data-gate-summary>{parts.join(' · ')}</span>
}

const SUMMARY_ORDER: readonly Gate['status'][] = ['failed', 'timed_out', 'running', 'passed']

/**
 * The open gate's log.
 *
 * The gate is looked up by id on every render rather than held, so a running
 * gate's log grows in place as the node view refreshes underneath. The last
 * one shown is remembered for the closing animation — without it the dialog
 * would empty itself in the 200ms it spends fading out.
 */
function GateLogDialog({
  gates,
  open,
  onOpen,
}: {
  readonly gates: NodeDetail['gates']
  readonly open: string | null
  readonly onOpen: (gateId: string | null) => void
}) {
  const index = open === null ? -1 : gates.findIndex((gate) => gate.gateId === open)
  const current = index === -1 ? null : gates[index]!
  const shown = useRef<Gate | null>(null)
  if (current !== null) shown.current = current
  const gate = current ?? shown.current

  const previous = index > 0 ? gates[index - 1]! : null
  const next = index !== -1 && index < gates.length - 1 ? gates[index + 1]! : null

  return (
    <Dialog open={current !== null} onOpenChange={(isOpen) => !isOpen && onOpen(null)}>
      {gate !== null && (
        <DialogContent
          data-gate-dialog={gate.gateId}
          className="flex h-[min(46rem,calc(100vh-4rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' && previous !== null) onOpen(previous.gateId)
            else if (event.key === 'ArrowRight' && next !== null) onOpen(next.gateId)
            else return
            event.preventDefault()
          }}
        >
          <DialogHeader className="gap-1.5 border-b px-5 py-4 pr-12 text-left">
            <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
              <ScrollTextIcon aria-hidden="true" className="size-4 text-muted-foreground" />
              <span className="font-mono">{gate.gateId}</span>
              <Chip tone={gateTone(gate.status)}>{GATE_LABELS[gate.status]}</Chip>
            </DialogTitle>
            <DialogDescription className="flex flex-wrap items-baseline gap-x-1.5">
              <GateFacts gate={gate} />
            </DialogDescription>
          </DialogHeader>

          {/* Keyed by gate, so stepping to another one starts at its end. */}
          <LogBody key={gate.gateId} gate={gate} />

          <DialogFooter className="flex-row items-center justify-between border-t px-5 py-3 sm:justify-between">
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Previous gate"
                title="Previous gate (←)"
                disabled={previous === null}
                onClick={() => previous !== null && onOpen(previous.gateId)}
              >
                <ChevronLeftIcon aria-hidden="true" />
              </Button>
              <span className="min-w-12 text-center font-mono text-xs tabular-nums text-muted-foreground">
                {index === -1 ? '' : `${index + 1} / ${gates.length}`}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Next gate"
                title="Next gate (→)"
                disabled={next === null}
                onClick={() => next !== null && onOpen(next.gateId)}
              >
                <ChevronRightIcon aria-hidden="true" />
              </Button>
              {gates.length > 1 && (
                <span className="ml-2 hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
                  <Kbd>←</Kbd>
                  <Kbd>→</Kbd>
                  to switch gates
                </span>
              )}
            </div>
            <CopyLog log={gate.log} />
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  )
}

/**
 * The scrolling log, with a line-number gutter drawn by CSS counters — so the
 * numbers are visible but not in the text a reader selects and copies.
 *
 * Opens at the bottom, and stays there while the log grows unless the reader
 * has scrolled away: the same contract `follow.ts` gives the transcript, at
 * the size a single `pre` needs.
 */
function LogBody({ gate }: { readonly gate: Gate }) {
  const scroller = useRef<HTMLDivElement | null>(null)
  const stuck = useRef(true)
  const lines = gate.log === '' ? [] : gate.log.replace(/\n$/, '').split('\n')

  useLayoutEffect(() => {
    const element = scroller.current
    if (element !== null && stuck.current) element.scrollTop = element.scrollHeight
  }, [gate.log])

  return (
    <div
      ref={scroller}
      className="min-h-0 flex-1 overflow-auto bg-muted/50"
      onScroll={(event) => {
        const element = event.currentTarget
        stuck.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40
      }}
    >
      {lines.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
          <ScrollTextIcon aria-hidden="true" className="size-6 text-muted-foreground/60" />
          <EmptyNote>
            {gate.status === 'running'
              ? 'This gate has written nothing yet. Its output appears here as it runs.'
              : 'This gate has written nothing yet.'}
          </EmptyNote>
        </div>
      ) : (
        <pre
          className="gate-log m-0 py-3 pr-4 font-mono text-xs leading-5"
          data-gate-log={gate.gateId}
        >
          {lines.map((line, number) => (
            // Lines are positions in an append-only log; the index is their identity.
            <span key={number} className="gate-line">
              {line}
              {'\n'}
            </span>
          ))}
        </pre>
      )}
    </div>
  )
}

/** The header's facts: what it cost, whether the cache served it, how often it ran. */
function GateFacts({ gate }: { readonly gate: Gate }) {
  const facts: ReactNode[] = []
  if (gate.status === 'running') {
    facts.push(
      gate.startedAt === null ? 'Running' : <RunningFor key="for" since={gate.startedAt} prefix="Running for " />,
    )
  } else if (gate.durationMs !== null) {
    facts.push(gate.cached ? `Took ${duration(gate.durationMs)} when it last ran` : `Took ${duration(gate.durationMs)}`)
  }
  if (gate.cached) facts.push('served from the cache')
  if (gate.runs > 1) facts.push(`${gate.runs} runs on this phase`)
  if (facts.length === 0) facts.push('No timing on record')
  return (
    <>
      {facts.map((fact, index) => (
        // A fixed, short list built above; position is its identity.
        <span key={index} className="tabular-nums">
          {index > 0 && <span aria-hidden="true" className="mr-1.5">·</span>}
          {fact}
        </span>
      ))}
    </>
  )
}

function CopyLog({ log }: { readonly log: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])

  // Not every context has a clipboard (plain http off localhost); a button
  // that cannot work is not offered.
  if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return null

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-action="copy-gate-log"
      disabled={log === ''}
      onClick={() => {
        navigator.clipboard.writeText(log).then(
          () => setCopied(true),
          () => undefined,
        )
      }}
    >
      {copied ? <CheckIcon aria-hidden="true" className="text-tone-ok" /> : <CopyIcon aria-hidden="true" />}
      {copied ? 'Copied' : 'Copy log'}
    </Button>
  )
}

const GATE_LABELS: Readonly<Record<Gate['status'], string>> = {
  running: 'running',
  passed: 'passed',
  failed: 'failed',
  timed_out: 'timed out',
}

/**
 * A timed-out gate is `error` and not `wait` on purpose. §6.1's patience is
 * about capacity the system will get back on its own; a gate the runner had
 * to kill is a result, and a human decides what happens next.
 */
function gateTone(status: Gate['status']): Tone {
  if (status === 'running') return 'active'
  return status === 'passed' ? 'ok' : 'error'
}

/**
 * How long the gate has been going, or how long it took.
 *
 * The live case ticks off `useNow` against the daemon's `startedAt`, so a tab
 * left open on a slow suite keeps counting and a tab opened halfway through
 * shows the true figure rather than starting from zero. The finished case is
 * the runner's own measurement, which is why a cached verdict can report a
 * duration at all — it is what the gate cost when it last ran, and the row
 * says `cached` beside it so the number is not read as time this run spent.
 */
function GateTiming({ gate }: { readonly gate: Gate }) {
  if (gate.status === 'running') {
    // A component of its own, so the second-by-second clock exists only where
    // something is actually moving. Inlining the hook here would give every
    // settled row its own interval for a number that will never change again.
    return (
      <GateTime>{gate.startedAt === null ? 'running' : <RunningFor since={gate.startedAt} />}</GateTime>
    )
  }
  return (
    <GateTime>
      {gate.durationMs !== null && <span>{duration(gate.durationMs)}</span>}
      {gate.cached && <span>cached</span>}
      {gate.runs > 1 && <span>×{gate.runs}</span>}
    </GateTime>
  )
}

function RunningFor({ since, prefix = '' }: { readonly since: number; readonly prefix?: string }) {
  return (
    <>
      {prefix}
      {elapsed(since, useNow(1000))}
    </>
  )
}

/** The right-hand end of a gate's row. Tabular figures, so it does not jitter. */
function GateTime({ children }: { readonly children: ReactNode }) {
  return (
    <span className="gate-time flex shrink-0 items-baseline gap-1.5 font-mono text-xs tabular-nums text-muted-foreground">
      {children}
    </span>
  )
}
