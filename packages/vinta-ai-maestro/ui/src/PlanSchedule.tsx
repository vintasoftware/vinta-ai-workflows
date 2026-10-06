/**
 * §13.1's projection, drawn for a plan that has not run (§19).
 *
 * A timeline rather than a table, because the thing a reviewer reads off it is
 * shape: which phases run side by side, where the graph narrows to one lane,
 * which chain sets the wall clock. The durations are the simulator's defaults,
 * and the page says so — this answers "what runs with what", never "how long".
 */
import { useEffect, useState } from 'react'
import { cn } from 'vinta-design-system/lib/utils'
import type { PlanScheduleResponse } from '../../src/daemon/schemas.ts'
import type { Workflow } from '../../src/types.ts'
import { EmptyNote, ErrorNote, Hint, Panel } from './Panel.tsx'
import type { PlansClient } from './plans-client.ts'
import { duration } from './time.ts'

export function PlanSchedule({
  plans,
  planId,
  workflow,
  stamp,
  onSelectPhase,
}: {
  readonly plans: PlansClient
  readonly planId: string
  readonly workflow: Workflow
  /** Re-projected when the plan changes under the page. */
  readonly stamp: string
  readonly onSelectPhase: (nodeId: string) => void
}) {
  const [report, setReport] = useState<PlanScheduleResponse | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let stopped = false
    setFailed(false)
    plans
      .schedule(planId)
      .then((next) => {
        if (!stopped) setReport(next)
      })
      .catch(() => {
        if (!stopped) setFailed(true)
      })
    return () => {
      stopped = true
    }
  }, [plans, planId, stamp])

  if (failed) {
    return (
      <Panel title="Projected schedule">
        <ErrorNote>
          The plan could not be projected. Fix the issues listed above, then come back.
        </ErrorNote>
      </Panel>
    )
  }
  if (report === null) {
    return (
      <Panel title="Projected schedule">
        <EmptyNote>Projecting…</EmptyNote>
      </Panel>
    )
  }

  const total = Math.max(report.projectedMs, 1)
  const critical = new Set(report.criticalPath)
  const name = (id: string): string => workflow.nodes.find((node) => node.id === id)?.name ?? id
  const peak = peakParallel(report)

  return (
    <Panel
      title="Projected schedule"
      description={
        <>
          {report.nodes.length} phases · {peak} at most at once · critical path{' '}
          {report.criticalPath.join(' → ') || '—'} · {duration(report.projectedMs)} on default
          estimates
        </>
      }
      data-plan-schedule
    >
      {report.status === 'stopped' && (
        <ErrorNote>The projection stopped before every phase ran — the graph cannot complete as written.</ErrorNote>
      )}
      <ol className="flex flex-col gap-1.5">
        {report.nodes.map((node) => {
          const start = node.startedAtMs ?? 0
          const end = node.finishedAtMs ?? start
          const queued = Math.min(node.queueMs, start)
          return (
            <li key={node.id} className="grid grid-cols-[minmax(0,14rem)_minmax(0,1fr)] items-center gap-3">
              <button
                type="button"
                className="truncate text-left text-[13px] hover:underline"
                data-action="select-phase"
                data-id={node.id}
                onClick={() => onSelectPhase(node.id)}
                title={name(node.id)}
              >
                <span className="font-mono text-xs text-muted-foreground">{node.id}</span> {name(node.id)}
              </button>
              <div className="relative h-6 rounded-md bg-muted/50" data-bar={node.id}>
                {queued > 0 && (
                  <span
                    className="absolute inset-y-1 rounded-sm bg-tone-wait-soft"
                    style={{ left: pct(start - queued, total), width: pct(queued, total) }}
                    title={`queued ${duration(queued)}`}
                  />
                )}
                <span
                  className={cn(
                    'absolute inset-y-0.5 flex items-center overflow-hidden rounded-sm px-1.5 font-mono text-[11px] text-white',
                    critical.has(node.id) ? 'bg-tone-attention' : 'bg-tone-active',
                  )}
                  style={{ left: pct(start, total), width: pct(Math.max(end - start, total / 200), total) }}
                  data-critical={critical.has(node.id) ? '' : undefined}
                  title={`${duration(start)} → ${duration(end)}`}
                >
                  w{node.wave}
                </span>
              </div>
            </li>
          )
        })}
      </ol>
      <Hint className="text-xs">
        Simulated with the scheduler a run uses, over default estimates — about 20 minutes per agent
        turn and 5 per gate, clean path only. Violet bars are the critical path; amber is time spent
        queued for a pool.
      </Hint>
    </Panel>
  )
}

function pct(ms: number, total: number): string {
  return `${Math.max(0, Math.min(100, (ms / total) * 100))}%`
}

/** The most phases running at one instant. */
function peakParallel(report: PlanScheduleResponse): number {
  const marks: { at: number; delta: number }[] = []
  for (const node of report.nodes) {
    if (node.startedAtMs === null || node.finishedAtMs === null) continue
    marks.push({ at: node.startedAtMs, delta: 1 }, { at: node.finishedAtMs, delta: -1 })
  }
  marks.sort((a, b) => a.at - b.at || a.delta - b.delta)
  let current = 0
  let peak = 0
  for (const mark of marks) {
    current += mark.delta
    peak = Math.max(peak, current)
  }
  return peak
}
