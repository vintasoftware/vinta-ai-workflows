/**
 * What every phase has to pass, at a glance (§19).
 *
 * A matrix rather than a list per phase, because the questions a reviewer asks
 * about gates are across phases: "does the migration phase run the full suite",
 * "why does p4 skip lint", "is anything holding the test pool". The commands
 * are the *resolved* ones — the project's `.vinta-ai-workflows.yaml` under the
 * plan's own — because that is what a run executes, and a gate the plan names
 * only by type is otherwise a word with no command behind it.
 */
import { CheckIcon, MessageSquarePlusIcon } from 'lucide-react'
import { Button } from 'vinta-design-system/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from 'vinta-design-system/ui/table'
import { cn } from 'vinta-design-system/lib/utils'
import type { Anchor, PlanReview } from '../../src/review/document.ts'
import type { Workflow } from '../../src/types.ts'
import { Chip } from './Chip.tsx'
import { EmptyNote, Panel } from './Panel.tsx'
import { GateDetail, GateKind } from './PhaseInspector.tsx'
import { commentsAt, gateColumns } from './plan-model.ts'

export function PlanGates({
  workflow,
  waves,
  review,
  focus,
  onComment,
  onSelectPhase,
}: {
  readonly workflow: Workflow
  readonly waves: Readonly<Record<string, number>>
  readonly review: PlanReview | null
  /** A gate to highlight — a comment's "show me". */
  readonly focus: string | null
  readonly onComment: (anchor: Anchor) => void
  readonly onSelectPhase: (nodeId: string) => void
}) {
  const columns = gateColumns(workflow)
  const open = (anchor: Anchor): number =>
    commentsAt(review, anchor).filter((comment) => comment.status === 'open').length
  const pools = Object.entries(workflow.resources)
  const chores = Object.entries(workflow.chores)

  return (
    <div className="flex flex-col gap-4" data-plan-gates>
      <Panel
        title="Gates by phase"
        description="Each phase must pass every gate ticked on its row before it merges."
      >
        {columns.length === 0 ? (
          <EmptyNote>This plan declares no gates — phases merge on review alone.</EmptyNote>
        ) : (
          <div className="overflow-x-auto">
            <Table data-gate-matrix>
              <TableHeader>
                <TableRow>
                  <TableHead>Phase</TableHead>
                  <TableHead className="w-12 text-center">Wave</TableHead>
                  {columns.map((id) => (
                    <TableHead
                      key={id}
                      className={cn('text-center font-mono', focus === id && 'bg-tone-attention-soft')}
                      data-gate-column={id}
                    >
                      {id}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {workflow.nodes.map((node) => (
                  <TableRow key={node.id}>
                    <TableCell>
                      <button
                        type="button"
                        className="text-left hover:underline"
                        data-action="select-phase"
                        data-id={node.id}
                        onClick={() => onSelectPhase(node.id)}
                      >
                        <span className="font-mono text-xs text-muted-foreground">{node.id}</span>{' '}
                        {node.name}
                      </button>
                    </TableCell>
                    <TableCell className="text-center font-mono text-xs">{waves[node.id] ?? '—'}</TableCell>
                    {columns.map((id) => (
                      <TableCell
                        key={id}
                        className={cn('text-center', focus === id && 'bg-tone-attention-soft/50')}
                        data-cell={`${node.id}:${id}`}
                      >
                        {node.gates.includes(id) ? (
                          <CheckIcon aria-label="runs" className="mx-auto size-4 text-tone-ok" />
                        ) : (
                          <span aria-label="skips" className="text-muted-foreground">·</span>
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        {columns.map((id) => {
          const gate = workflow.gates[id] ?? null
          const count = open({ kind: 'gate', gate: id })
          return (
            <Panel
              key={id}
              title={
                <span className="flex items-center gap-2">
                  <span className="font-mono">{id}</span>
                  <GateKind gate={gate} />
                </span>
              }
              description={gate?.description}
              className={cn(focus === id && 'ring-2 ring-ring/40')}
              data-gate-definition={id}
              action={
                <Button
                  type="button"
                  variant={count > 0 ? 'secondary' : 'ghost'}
                  size="xs"
                  data-action="comment-gate"
                  data-gate-id={id}
                  onClick={() => onComment({ kind: 'gate', gate: id })}
                >
                  <MessageSquarePlusIcon aria-hidden="true" />
                  {count > 0 ? count : 'Comment'}
                </Button>
              }
            >
              <GateDetail gate={gate} />
              <p className="text-xs text-muted-foreground">
                Run by{' '}
                {workflow.nodes.filter((node) => node.gates.includes(id)).length} of{' '}
                {workflow.nodes.length} phases.
              </p>
            </Panel>
          )
        })}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Resource pools" description="What lanes and gates queue on.">
          <ul className="divide-y text-[13px]" data-pools>
            {pools.map(([id, pool]) => (
              <li key={id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="flex flex-col">
                  <span className="font-mono">{id}</span>
                  {pool.description !== undefined && (
                    <span className="text-xs text-muted-foreground">{pool.description}</span>
                  )}
                </span>
                <span className="flex items-center gap-2">
                  <Chip tone="idle">{pool.kind}</Chip>
                  <span className="font-mono text-xs">× {pool.capacity}</span>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="Chores" description="Agent turns a phase runs beside its gates.">
          {chores.length === 0 ? (
            <EmptyNote>No chores declared.</EmptyNote>
          ) : (
            <ul className="divide-y text-[13px]" data-chore-list>
              {chores.map(([id, chore]) => (
                <li key={id} className="flex flex-col gap-0.5 py-2">
                  <span className="flex items-center gap-2">
                    <span className="font-mono">{id}</span>
                    <Chip tone="idle">{chore.when === 'after_pr' ? 'after PR' : 'before gates'}</Chip>
                    {workflow.defaults.chores.includes(id) && <Chip tone="ok">every phase</Chip>}
                  </span>
                  {chore.description !== undefined && (
                    <span className="text-xs text-muted-foreground">{chore.description}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  )
}
