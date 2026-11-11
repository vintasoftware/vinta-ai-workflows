/**
 * The run's post-mortem (§13.6), read as a report.
 *
 * The artifact exists for `plan-feature`: it is what the next plan in this
 * repository is built against. This draws the same file for the person, so
 * the diagnosis is on screen at the end of the run and not only in a JSON
 * file an agent reads later. Nothing is recomputed — every figure here is the
 * artifact's — and every empty finding is drawn as the sentence the artifact
 * means by it, which is sometimes "none" and sometimes "not recorded"
 * (`gaps`). The two are different claims and the page keeps them apart.
 *
 * The run's own numbers (elapsed, phases, waves) lead; then the findings a
 * planner acts on, worst first: what failed and why, what fought at merge,
 * what the run decided alone, what it changed about itself, what each gate
 * cost, what set the clock, and what sat idle.
 */
import type { ReactNode } from 'react'
import { Badge } from 'vinta-design-system/ui/badge'
import type { PostMortem } from '../../src/postmortem/postmortem.ts'
import { Chip } from './Chip.tsx'
import { EmptyNote, Hint, Panel } from './Panel.tsx'
import { duration, elapsed } from './time.ts'

export function ReportView({
  report,
  runId,
  status,
}: {
  /** `undefined` while being read, `null` when the run wrote none. */
  readonly report: PostMortem | null | undefined
  readonly runId: string
  readonly status: string
}) {
  if (report === undefined) {
    return (
      <Panel title="Report" data-report="reading">
        <EmptyNote>Reading the run’s post-mortem…</EmptyNote>
      </Panel>
    )
  }
  if (report === null) {
    return (
      <Panel title="Report" data-report="none">
        <EmptyNote>
          {status === 'done' || status === 'failed'
            ? 'This run wrote no post-mortem — it ended before the report could be written, or on a version that did not write one. The timings below are still complete.'
            : `A post-mortem is written when a run finishes; this one is ${status}. Resume it to get one — the timings below cover what it did so far.`}
        </EmptyNote>
      </Panel>
    )
  }

  const { findings, gaps } = report
  const phase = (id: string): ReactNode => (
    <a className="font-mono text-xs font-medium" href={`#/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(id)}`}>
      {id}
    </a>
  )
  const gapFor = (kind: PostMortem['gaps'][number]['kind']) => gaps.find((gap) => gap.kind === kind)
  const failures = findings.failure_causes ?? []
  const crossPhase = findings.cross_phase_failures ?? []
  const unattended = findings.unattended_decisions
  const substitutions = findings.crew_substitutions ?? []
  const operations = findings.operations

  return (
    <div className="flex flex-col gap-4" data-report="ready">
      <Panel
        title="Report"
        description="What this run learned about its plan — the same findings the next plan in this repository is built from."
        data-report-summary
      >
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px]">
          <Chip tone={report.run.status === 'done' ? 'ok' : 'error'}>{report.run.status}</Chip>
          <span>
            <strong>{elapsed(0, report.run.elapsed_ms)}</strong> elapsed
          </span>
          <span>
            {report.run.node_count} {report.run.node_count === 1 ? 'phase' : 'phases'} in {report.run.wave_count}{' '}
            {report.run.wave_count === 1 ? 'wave' : 'waves'}
          </span>
          {findings.critical_path !== null && (
            <span data-critical-share>
              critical path {Math.round(findings.critical_path.share_of_elapsed * 100)}% of the clock
            </span>
          )}
          {findings.idle_capacity !== null && (
            <span data-idle-share>
              lanes idle {Math.round(findings.idle_capacity.idle_share * 100)}% · peak {findings.idle_capacity.peak_concurrency} of{' '}
              {findings.idle_capacity.lane_capacity} in use
            </span>
          )}
        </div>
        <Diagnosis report={report} />
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Finding title="Failures" data-finding="failures" bounded>
          {failures.length === 0 && crossPhase.length === 0 ? (
            <EmptyNote>No attempt failed.</EmptyNote>
          ) : (
            <ul className="flex flex-col gap-2 text-[13px]">
              {failures.map((cause) => (
                <li key={cause.reason} className="flex flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="muted">
                      {cause.attempts} {cause.attempts === 1 ? 'attempt' : 'attempts'}
                    </Badge>
                    {cause.setup && <Chip tone="wait">setup</Chip>}
                    <span className="flex flex-wrap gap-1.5">{cause.nodes.map((id) => <span key={id}>{phase(id)}</span>)}</span>
                  </span>
                  <span className="text-muted-foreground">{cause.reason}</span>
                </li>
              ))}
              {crossPhase.map((failure) => (
                <li key={`${failure.wave}-${failure.gate}-${failure.at_ms}`} className="flex flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <Chip tone="error">wave {failure.wave} red</Chip>
                    <span>
                      gate <span className="font-mono text-xs">{failure.gate}</span> passed on every branch and failed on the merged wave
                    </span>
                  </span>
                  <span className="flex flex-wrap gap-1.5 text-muted-foreground">
                    {failure.members.map((id) => <span key={id}>{phase(id)}</span>)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Finding>

        <Finding title="Merge conflicts" data-finding="conflicts" bounded>
          {findings.wave_conflicts.length === 0 ? (
            <EmptyNote>
              {gapFor('integration_record_unavailable') === undefined
                ? 'No two phases fought over the same code.'
                : 'Not recorded: the integration record was unavailable to this run.'}
            </EmptyNote>
          ) : (
            <ul className="flex flex-col gap-2 text-[13px]">
              {findings.wave_conflicts.map((conflict, index) => (
                <li key={index} className="flex flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="muted">
                      wave {conflict.wave}
                      {conflict.where === 'base' ? ' base' : ''}
                    </Badge>
                    <span className="flex flex-wrap gap-1.5">{conflict.nodes.map((id) => <span key={id}>{phase(id)}</span>)}</span>
                    <span className="text-muted-foreground">
                      {conflict.fix_rounds} fix {conflict.fix_rounds === 1 ? 'round' : 'rounds'}
                    </span>
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">{conflict.paths.join(', ')}</span>
                  {(conflict.reverted_deletions?.length ?? 0) > 0 && (
                    <span className="text-xs text-tone-wait-foreground">
                      kept lines a phase deleted in {conflict.reverted_deletions?.map((entry) => entry.path).join(', ')}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Finding>

        <Finding title="Dependencies the plan missed" data-finding="dependencies" bounded>
          {findings.missing_dependencies.length === 0 ? (
            <EmptyNote>None discovered. (Unused dependencies are not observable yet, and are not claimed.)</EmptyNote>
          ) : (
            <ul className="flex flex-col gap-1.5 text-[13px]">
              {findings.missing_dependencies.map((edge) => (
                <li key={`${edge.node}-${edge.depends_on}`}>
                  {phase(edge.node)} failed, then passed after {phase(edge.depends_on)} landed
                  {edge.gate !== undefined && (
                    <span className="text-muted-foreground">
                      {' '}
                      — gate <span className="font-mono text-xs">{edge.gate}</span> went red for{' '}
                      {duration(edge.passed_at_ms - edge.failed_at_ms)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Finding>

        <Finding title="Phases out of line with their wave" data-finding="divergences" bounded>
          {findings.duration_divergences.length === 0 ? (
            <EmptyNote>Every phase ran within range of its wave.</EmptyNote>
          ) : (
            <ul className="flex flex-col gap-1.5 text-[13px]">
              {findings.duration_divergences.map((item) => (
                <li key={item.node} className="flex flex-wrap items-center gap-2">
                  {phase(item.node)}
                  <span>
                    {duration(item.span_ms)} against a wave {item.wave} median of {duration(item.wave_baseline_ms)}
                  </span>
                  <Chip tone={item.direction === 'longer' ? 'wait' : 'idle'}>
                    {item.ratio}× {item.direction}
                  </Chip>
                </li>
              ))}
            </ul>
          )}
        </Finding>

        <Finding title="Decided without you" data-finding="unattended" bounded>
          {unattended === undefined ? (
            <EmptyNote>Not recorded by this version.</EmptyNote>
          ) : unattended.answers.length === 0 && unattended.coordinator_actions.length === 0 ? (
            <EmptyNote>Nothing was decided without a person.</EmptyNote>
          ) : (
            <ul className="flex flex-col gap-1.5 text-[13px]">
              {unattended.answers.map((answer, index) => (
                <li key={`a-${index}`} className="flex flex-wrap items-center gap-2">
                  {phase(answer.node)}
                  <Badge variant="outline" className="muted">
                    {answer.by}
                  </Badge>
                  <span>{answer.category.replaceAll('_', ' ')}</span>
                  <span className="font-mono text-xs text-muted-foreground">→ {String(answer.answer)}</span>
                  {answer.waited_ms !== undefined && (
                    <span className="text-xs text-muted-foreground">after {duration(answer.waited_ms)}</span>
                  )}
                </li>
              ))}
              {unattended.coordinator_actions.map((action, index) => (
                <li key={`c-${index}`} className="flex flex-wrap items-center gap-2">
                  {action.node !== undefined && phase(action.node)}
                  <Badge variant="outline" className="muted">
                    coordinator
                  </Badge>
                  <span>{action.action.replaceAll('_', ' ')}</span>
                  {action.target !== undefined && <span className="font-mono text-xs text-muted-foreground">{action.target}</span>}
                </li>
              ))}
            </ul>
          )}
        </Finding>

        <Finding title="What the run changed about itself" data-finding="interventions" bounded>
          {findings.interventions.length === 0 ? (
            <EmptyNote>The run made no amendment of its own.</EmptyNote>
          ) : (
            <ul className="flex flex-col gap-1.5 text-[13px]">
              {findings.interventions.map((item) => (
                <li key={item.amendment} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">{item.target}</span>
                  <Chip tone={item.effect === 'cheaper' ? 'ok' : item.effect === 'dearer' ? 'error' : 'idle'}>{item.effect}</Chip>
                  {item.before_ms !== undefined && item.after_ms !== undefined && (
                    <span className="text-muted-foreground">
                      {duration(item.before_ms)} → {duration(item.after_ms)} per run
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Finding>

        <Finding title="Gate costs" data-finding="gates" bounded>
          {findings.gate_costs.length === 0 ? (
            <EmptyNote>
              {gapFor('gate_durations_unrecorded') === undefined ? 'No gate ran.' : 'Gate durations were not recorded by this run.'}
            </EmptyNote>
          ) : (
            <ul className="flex flex-col gap-1.5 text-[13px]">
              {[...findings.gate_costs]
                .sort((a, b) => b.ran_ms - a.ran_ms)
                .map((gate) => (
                  <li key={gate.gate} className="flex flex-wrap items-center gap-2" data-gate-cost={gate.gate}>
                    <span className="font-mono text-xs font-medium">{gate.gate}</span>
                    <span className="font-mono text-xs tabular-nums">{duration(gate.ran_ms)}</span>
                    <span className="text-muted-foreground">
                      over {gate.runs} {gate.runs === 1 ? 'run' : 'runs'}
                      {gate.cached_runs > 0 && `, ${gate.cached_runs} cached (saved ${duration(gate.cache_saved_ms)})`}
                      {gate.failed_runs > 0 && ` · ${gate.failed_runs} red`}
                      {gate.timed_out_runs > 0 && ` · ${gate.timed_out_runs} timed out`}
                      {` · slowest ${duration(gate.slowest_ms)}`}
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </Finding>

        <Finding title="Staffing" data-finding="staffing" bounded>
          {substitutions.length === 0 && (operations === undefined || operations.node_operations.length === 0) ? (
            <EmptyNote>Every phase ran as staffed, and nobody steered it by hand.</EmptyNote>
          ) : (
            <ul className="flex flex-col gap-1.5 text-[13px]">
              {substitutions.map((item, index) => (
                <li key={`s-${index}`} className="flex flex-wrap items-center gap-2">
                  {phase(item.node)}
                  <span>
                    ran by <strong>{item.member}</strong> (tier {item.tier}) instead of {item.planned}
                  </span>
                  <Badge variant="outline" className="muted">
                    {item.reason.replaceAll('_', ' ')}
                  </Badge>
                  {item.above_plan && <Chip tone="wait">above plan</Chip>}
                  {item.node_cost_usd !== undefined && (
                    <span className="font-mono text-xs text-muted-foreground">${item.node_cost_usd.toFixed(2)}</span>
                  )}
                </li>
              ))}
              {(operations?.node_operations ?? []).map((item, index) => (
                <li key={`o-${index}`} className="flex flex-wrap items-center gap-2">
                  {phase(item.node)}
                  <span>
                    {item.op.replaceAll('_', ' ')} ×{item.count}
                  </span>
                  <Badge variant="outline" className="muted">
                    {item.by}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Finding>
      </div>

      {gaps.length > 0 && (
        <Hint data-report-gaps className="flex flex-wrap items-center gap-1.5">
          <span>Not recorded, so not claimed:</span>
          {gaps.map((gap) => (
            // The reason is a paragraph each; it is on hover, so the line stays a line.
            <Badge key={gap.kind} variant="outline" className="muted cursor-help" title={gap.needs}>
              {gap.kind.replaceAll('_', ' ')}
            </Badge>
          ))}
        </Hint>
      )}
    </div>
  )
}

function Finding({
  title,
  children,
  bounded = false,
  ...attributes
}: {
  readonly title: string
  readonly children: ReactNode
  readonly bounded?: boolean
  readonly [attribute: `data-${string}`]: string
}) {
  return (
    <Panel title={title} bounded={bounded} fill {...attributes}>
      {children}
    </Panel>
  )
}

/**
 * Three sentences a reader acts on, picked from the findings in the order
 * they matter: what to split, what to declare, what to shrink. Nothing here
 * is a figure the artifact does not carry.
 */
function Diagnosis({ report }: { readonly report: PostMortem }) {
  const { findings } = report
  const lines: string[] = []
  const dominant = [...findings.gate_costs].sort((a, b) => b.ran_ms - a.ran_ms)[0]
  if (findings.critical_path !== null && findings.critical_path.share_of_elapsed >= 0.8) {
    const chain = findings.critical_path.nodes.map((node) => node.node).join(' → ')
    lines.push(`One chain set the clock: ${chain}. Only a shallower graph or a cheaper phase on it makes the next run faster.`)
  }
  if (findings.idle_capacity !== null && findings.idle_capacity.idle_share >= 0.5) {
    lines.push(
      `Lanes sat idle ${Math.round(findings.idle_capacity.idle_share * 100)}% of the time and the graph was never wider than ${findings.idle_capacity.peak_concurrency}: the plan asked for ${findings.idle_capacity.lane_capacity} lanes it could not use.`,
    )
  }
  if (findings.wave_conflicts.length > 0) {
    const worst = [...findings.wave_conflicts].sort((a, b) => b.fix_rounds - a.fix_rounds)[0]
    if (worst !== undefined) {
      lines.push(
        `${worst.nodes.join(' and ')} fought over ${worst.paths.length} ${worst.paths.length === 1 ? 'path' : 'paths'} at wave ${worst.wave}: split them, or sequence them.`,
      )
    }
  }
  if (findings.missing_dependencies.length > 0) {
    lines.push(
      `${findings.missing_dependencies.length} ${findings.missing_dependencies.length === 1 ? 'dependency' : 'dependencies'} turned up undeclared at gate time; confirm and declare ${findings.missing_dependencies.length === 1 ? 'it' : 'them'} in the plan.`,
    )
  }
  if (dominant !== undefined && dominant.ran_ms >= report.run.elapsed_ms * 0.25) {
    lines.push(
      `Gate ${dominant.gate} alone ran for ${duration(dominant.ran_ms)} across ${dominant.runs} runs — a quarter or more of the run; its pool and its scope decide the wall clock.`,
    )
  }
  const asked = findings.unattended_decisions?.answers.length ?? 0
  if (asked > 0) {
    lines.push(`${asked} ${asked === 1 ? 'question was' : 'questions were'} answered with nobody watching; the ones that were design choices belonged in the plan.`)
  }
  if (lines.length === 0) return <Hint className="text-[13px]">Nothing stood out: the run went the way its plan said it would.</Hint>
  return (
    <ul className="flex flex-col gap-1 text-[13px]" data-diagnosis>
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  )
}
