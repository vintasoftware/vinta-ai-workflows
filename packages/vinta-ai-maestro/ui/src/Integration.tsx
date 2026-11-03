/**
 * What a phase is doing in the integration worktree, and who has the worktree.
 *
 * `integrate` runs no agent of its own — a merge, a suite on the merged tree,
 * a push — so a phase in it showed `running` over a silent transcript, and
 * one queued behind it looked the same. Two views of one record
 * (`integration_step`):
 *
 * - **The timeline** on the phase view: each step this attempt took, newest
 *   first, the one in progress with a live clock, and the log of every step
 *   that has one — tailed while the step still runs, since the daemon records
 *   the log's path when a gate starts and not only when it ends. A fix
 *   round's own words are in the transcript beside it.
 * - **The worktree panel** on the run view: the holder, the step it is on,
 *   who waits, and then the record of every step every node has taken there,
 *   newest first. One worktree, one merge at a time — this is the place that
 *   answers "is it stuck, or busy?", and then "what has it been doing".
 *
 * `hold` brackets a node's whole time in the worktree, so neither list shows
 * it: it would wrap every other row and add nothing to read.
 *
 * Both lists are `RecentList`s: the newest few in the panel, the rest in a
 * paged dialog, because a long run's record is a column the panel beside it
 * should not have to match in height.
 */
import { CheckIcon, CircleDashedIcon, LoaderCircleIcon, ScrollTextIcon, XIcon } from 'lucide-react'
import { useState, type ReactElement } from 'react'
import { Button } from 'vinta-design-system/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from 'vinta-design-system/ui/dialog'
import type { IntegrationHistoryResponse, NodeDetail, RunSnapshot } from '../../src/daemon/schemas.ts'
import { Chip } from './Chip.tsx'
import { LogBody, RunningFor } from './Gates.tsx'
import { describeStep } from './integration.ts'
import { EmptyNote, Panel } from './Panel.tsx'
import { RecentList } from './RecentList.tsx'
import { duration } from './time.ts'

type Entry = NodeDetail['integration'][number]
type HistoryRow = IntegrationHistoryResponse['steps'][number]

export function IntegrationTimeline({ steps }: { readonly steps: NodeDetail['integration'] }): ReactElement | null {
  const [open, setOpen] = useState<number | null>(null)
  // Newest first, with the index into the served (oldest-first) record kept
  // as each row's identity — steps are positions in an append-only record.
  const shown = steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.step !== 'hold')
    .reverse()
  if (shown.length === 0) return null
  const current = open === null ? null : (steps[open] ?? null)

  return (
    <Panel
      title="Integration"
      data-integration
      description="This attempt in the integration worktree, newest first. A fix round’s turn is in the transcript."
    >
      <RecentList
        rows={shown}
        keyOf={({ index }) => String(index)}
        title="Integration steps"
        description="Every step this attempt took in the integration worktree, newest first."
        empty="Nothing yet."
        listClassName="text-[13px]"
        data-integration-steps=""
        render={({ step, index }) => (
          <div
            className="flex items-center gap-2"
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
            <StepClock step={step} />
          </div>
        )}
      />
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
              <DialogDescription>
                {current.finishedAt === null
                  ? 'On the merged tree, in the integration worktree. Still running — the log grows as it writes.'
                  : 'On the merged tree, in the integration worktree.'}
              </DialogDescription>
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

function StepMark({ step }: { readonly step: Entry | HistoryRow }): ReactElement {
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

function StepClock({ step }: { readonly step: Entry | HistoryRow }): ReactElement {
  return (
    <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
      {step.finishedAt === null ? <RunningFor since={step.startedAt} /> : duration(step.finishedAt - step.startedAt)}
    </span>
  )
}

export function IntegrationWorktree({
  runId,
  worktree,
  history,
}: {
  readonly runId: string
  readonly worktree: RunSnapshot['integration']
  /** Every step of the run, newest first; null until read. */
  readonly history: IntegrationHistoryResponse['steps'] | null
}): ReactElement {
  return (
    <Panel
      title="Integration worktree"
      data-integration-worktree
      fill
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
        <p className="text-xs text-muted-foreground" data-queue>
          Waiting: {worktree.queue.join(', ')}
        </p>
      )}
      {history !== null && history.length > 0 && (
        <div className="flex flex-col gap-2 border-t pt-3">
          <span className="text-xs font-medium text-muted-foreground">Recent steps</span>
          <RecentList
            rows={history}
            keyOf={(row) => `${row.nodeId}:${row.step}:${row.startedAt}`}
            title="Integration worktree"
            description="Every step every phase took in the integration worktree, newest first."
            empty="Nothing yet."
            listClassName="text-[13px]"
            data-integration-history=""
            render={(row) => (
              <div className="flex items-center gap-2" data-history-step={row.step} data-history-node={row.nodeId}>
                <StepMark step={row} />
                <a
                  className="shrink-0 font-mono text-xs font-medium"
                  href={`#/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(row.nodeId)}`}
                >
                  {row.nodeId}
                </a>
                <span className="min-w-0 flex-1 truncate" title={describeStep(row)}>
                  {describeStep(row)}
                </span>
                <StepClock step={row} />
              </div>
            )}
          />
        </div>
      )}
    </Panel>
  )
}
