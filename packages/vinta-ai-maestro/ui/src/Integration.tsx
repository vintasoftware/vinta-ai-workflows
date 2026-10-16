/**
 * What a phase is doing in the integration worktree, and who has the worktree.
 *
 * `integrate` runs no agent of its own — a merge, a suite on the merged tree,
 * a push — so a phase in it showed `running` over a silent transcript, and
 * one queued behind it looked the same. Two views of one record
 * (`integration_step`):
 *
 * - **The timeline** on the phase view: each step this attempt took, the one
 *   in progress with a live clock, and the log of every step that has one.
 *   A fix round's own words are in the transcript beside it.
 * - **The worktree panel** on the run view: the holder, the step it is on,
 *   and who waits. One worktree, one merge at a time — this is the place that
 *   answers "is it stuck, or busy?".
 *
 * `hold` brackets a node's whole time in the worktree, so the timeline leaves
 * it out: it would wrap every other row and add nothing to read.
 */
import { CheckIcon, CircleDashedIcon, LoaderCircleIcon, ScrollTextIcon, XIcon } from 'lucide-react'
import { useState, type ReactElement } from 'react'
import { Button } from 'vinta-design-system/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from 'vinta-design-system/ui/dialog'
import type { NodeDetail, RunSnapshot } from '../../src/daemon/schemas.ts'
import { Chip } from './Chip.tsx'
import { LogBody, RunningFor } from './Gates.tsx'
import { describeStep } from './integration.ts'
import { EmptyNote, Panel } from './Panel.tsx'
import { duration } from './time.ts'

type Entry = NodeDetail['integration'][number]

export function IntegrationTimeline({ steps }: { readonly steps: NodeDetail['integration'] }): ReactElement | null {
  const [open, setOpen] = useState<number | null>(null)
  const shown = steps.filter((step) => step.step !== 'hold')
  if (shown.length === 0) return null
  const current = open === null ? null : (shown[open] ?? null)

  return (
    <Panel
      title="Integration"
      data-integration
      description="This attempt in the integration worktree. A fix round’s turn is in the transcript."
    >
      <ol className="flex flex-col divide-y text-[13px]">
        {shown.map((step, index) => (
          <li
            // Steps are positions in an append-only record; the index is their identity.
            key={index}
            className="flex items-center gap-2 py-1.5"
            data-integration-step={step.step}
            data-outcome={step.outcome ?? 'running'}
          >
            <StepMark step={step} />
            <span className="min-w-0 flex-1">{describeStep(step)}</span>
            {step.logTail !== null && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-action="open-step-log"
                aria-label={`Open the log of ${describeStep(step)}`}
                onClick={() => setOpen(index)}
              >
                <ScrollTextIcon aria-hidden="true" />
                log
              </Button>
            )}
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
              {step.finishedAt === null ? (
                <RunningFor since={step.startedAt} />
              ) : (
                duration(step.finishedAt - step.startedAt)
              )}
            </span>
          </li>
        ))}
      </ol>
      <Dialog open={current !== null} onOpenChange={(isOpen) => !isOpen && setOpen(null)}>
        {current !== null && (
          <DialogContent
            data-step-dialog={current.step}
            className="flex h-[min(46rem,calc(100vh-4rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
          >
            <DialogHeader className="gap-1.5 border-b px-5 py-4 pr-12 text-left">
              <DialogTitle className="flex items-center gap-2 text-base">
                <ScrollTextIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                {describeStep(current)}
              </DialogTitle>
              <DialogDescription>On the merged tree, in the integration worktree.</DialogDescription>
            </DialogHeader>
            <LogBody
              id={`${current.step}-${current.gate ?? ''}`}
              log={current.logTail ?? ''}
              running={current.finishedAt === null}
            />
          </DialogContent>
        )}
      </Dialog>
    </Panel>
  )
}

function StepMark({ step }: { readonly step: Entry }): ReactElement {
  const className = 'size-4 shrink-0'
  if (step.finishedAt === null) {
    return <LoaderCircleIcon aria-label="running" className={`${className} animate-spin text-tone-active`} />
  }
  if (step.outcome === 'failed') return <XIcon aria-label="failed" className={`${className} text-tone-error`} />
  if (step.outcome === 'interrupted') {
    return <CircleDashedIcon aria-label="interrupted" className={`${className} text-muted-foreground`} />
  }
  return <CheckIcon aria-label={step.outcome ?? 'ok'} className={`${className} text-tone-ok`} />
}

export function IntegrationWorktree({
  worktree,
}: {
  readonly worktree: RunSnapshot['integration']
}): ReactElement {
  return (
    <Panel
      title="Integration worktree"
      data-integration-worktree
      description="Every merge, wave suite and conflict fix runs here, one at a time."
    >
      {worktree.holder === null ? (
        <EmptyNote>Idle.</EmptyNote>
      ) : (
        <div className="flex flex-col gap-1.5 text-[13px]" data-holder={worktree.holder}>
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <Chip tone="active">{worktree.holder}</Chip>
              <span>{worktree.step === null ? 'between steps' : describeStep(worktree.step)}</span>
            </span>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {worktree.step !== null ? (
                <RunningFor since={worktree.step.startedAt} />
              ) : worktree.since !== null ? (
                <RunningFor since={worktree.since} />
              ) : null}
            </span>
          </div>
        </div>
      )}
      {worktree.queue.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground" data-queue>
          Waiting: {worktree.queue.join(', ')}
        </p>
      )}
    </Panel>
  )
}
