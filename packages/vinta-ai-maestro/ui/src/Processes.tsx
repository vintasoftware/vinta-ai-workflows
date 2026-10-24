/**
 * What the phase is running right now, as processes: its agent's commands,
 * foreground and background, and its gates (`src/processes/list.ts`).
 *
 * **It exists so a waiting phase is not read as a stuck one.** A quiet
 * transcript and no gate running looked exactly like a hang, when the agent
 * was waiting on a suite it started in the background half an hour earlier.
 * Each row says what runs, whether the phase is waiting on it, and for how
 * long — and offers to stop it, which ends it and everything under it.
 *
 * **Two rows, then a dialog.** A phase can have many processes, and the
 * column this sits in is meant to stay short (`Node.tsx`). The two shown are
 * the likeliest to matter — the daemon sorts what the phase waits on first,
 * then the oldest — and the rest are one click away.
 *
 * **Stopping asks twice.** The first click arms the row, the second stops it;
 * an armed row disarms itself after a few seconds, so a stray click on a
 * list that refreshes underneath cannot kill the wrong command later.
 */
import { CircleStopIcon, CpuIcon, ListIcon } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Button } from 'vinta-design-system/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from 'vinta-design-system/ui/dialog'
import type { NodeDetail } from '../../src/daemon/schemas.ts'
import { Chip } from './Chip.tsx'
import { EmptyNote } from './Panel.tsx'
import { elapsed, useNow } from './time.ts'

type Process = NonNullable<NodeDetail['processes']>[number]

/** How many rows the panel shows before the rest go behind "Show all". */
export const SHOWN_PROCESSES = 2

/** How long an armed Stop waits for its confirming click. */
const ARMED_MS = 5_000

export function ProcessSection({
  processes,
  onStop,
}: {
  /** Null when there is no list to give: the run is not live, or the table cannot be read. */
  readonly processes: NodeDetail['processes']
  readonly onStop: (pid: number) => Promise<void>
}) {
  const [all, setAll] = useState(false)
  const list = processes ?? []

  return (
    <section data-processes className="flex flex-col gap-1">
      <SectionHeading
        label="Running now"
        detail={list.length === 0 ? null : `${list.length} process${list.length === 1 ? '' : 'es'}`}
      />
      {processes === null ? (
        <EmptyNote>No process list: the run is not live here.</EmptyNote>
      ) : list.length === 0 ? (
        <EmptyNote>Nothing is running.</EmptyNote>
      ) : (
        <>
          <ProcessList processes={list.slice(0, SHOWN_PROCESSES)} onStop={onStop} />
          {list.length > SHOWN_PROCESSES && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              data-action="show-all-processes"
              aria-haspopup="dialog"
              className="self-start text-muted-foreground"
              onClick={() => setAll(true)}
            >
              <ListIcon aria-hidden="true" />
              Show all {list.length} processes
            </Button>
          )}
        </>
      )}
      <Dialog open={all && list.length > 0} onOpenChange={setAll}>
        <DialogContent data-processes-dialog className="flex max-h-[min(40rem,calc(100vh-4rem))] flex-col gap-3 sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <CpuIcon aria-hidden="true" className="size-4 text-muted-foreground" />
              Running now
            </DialogTitle>
            <DialogDescription>
              What this phase is waiting on comes first. Stopping a process ends it and everything it started.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2">
            <ProcessList processes={list} onStop={onStop} />
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}

/** A small heading inside the panel, for its two sections. */
export function SectionHeading({ label, detail }: { readonly label: string; readonly detail: ReactNode }) {
  return (
    <h3 className="flex items-baseline gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
      {label}
      {detail !== null && detail !== undefined && <span className="font-normal normal-case tracking-normal">{detail}</span>}
    </h3>
  )
}

/** Its own component, so the second-by-second clock ticks only in a row that shows one. */
function Elapsed({ since }: { readonly since: number }) {
  return <>{elapsed(since, useNow(1000))}</>
}

function ProcessList({
  processes,
  onStop,
}: {
  readonly processes: readonly Process[]
  readonly onStop: (pid: number) => Promise<void>
}) {
  return (
    <ul className="-mx-2 flex flex-col">
      {processes.map((process) => (
        <ProcessRow key={process.pid} process={process} onStop={onStop} />
      ))}
    </ul>
  )
}

function ProcessRow({
  process,
  onStop,
}: {
  readonly process: Process
  readonly onStop: (pid: number) => Promise<void>
}) {
  const [armed, setArmed] = useState(false)
  const [stopping, setStopping] = useState(false)

  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), ARMED_MS)
    return () => clearTimeout(timer)
  }, [armed])

  const label = process.kind === 'gate' ? `the ${process.gateId ?? 'gate'} gate` : `“${process.command}”`

  return (
    <li
      data-process={process.pid}
      data-process-mode={process.mode}
      className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <Chip tone={process.mode === 'foreground' ? 'active' : 'wait'}>
            {process.mode === 'foreground' ? 'waiting on it' : 'background'}
          </Chip>
          {process.kind === 'gate' && <Chip tone="idle">gate {process.gateId}</Chip>}
        </span>
        <code className="truncate font-mono text-[13px]" title={process.command}>
          {process.command}
        </code>
      </span>
      <span className="flex shrink-0 items-baseline gap-1.5 font-mono text-xs tabular-nums text-muted-foreground">
        <Elapsed since={process.startedAt} />
        {process.descendants > 0 && <span title="Processes running under it">+{process.descendants}</span>}
      </span>
      {armed ? (
        <span className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="destructive"
            size="xs"
            data-action="confirm-stop-process"
            disabled={stopping}
            onClick={() => {
              setStopping(true)
              void onStop(process.pid).finally(() => {
                setStopping(false)
                setArmed(false)
              })
            }}
          >
            {stopping ? 'Stopping…' : 'Stop it'}
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={() => setArmed(false)} disabled={stopping}>
            Cancel
          </Button>
        </span>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-action="stop-process"
          aria-label={`Stop ${label}`}
          title="Stop this process and everything it started"
          onClick={() => setArmed(true)}
        >
          <CircleStopIcon aria-hidden="true" />
        </Button>
      )}
    </li>
  )
}
