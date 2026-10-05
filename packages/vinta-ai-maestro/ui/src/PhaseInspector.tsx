/**
 * One phase, as the agents that run it will see it (§19).
 *
 * The question a reviewer is actually answering is "will this phase come out
 * right", and the answer is in four places the plan's prose does not show
 * together: the brief the implementer gets, the prompts it is wrapped in, the
 * gates it has to pass, and who does the work. This puts them on one panel,
 * every piece of it commentable, so a remark lands on the exact thing it is
 * about — "the reviewer prompt does not mention the flag" — instead of on the
 * phase in general.
 */
import {
  ArrowDownRightIcon,
  ArrowUpLeftIcon,
  CheckIcon,
  CopyIcon,
  FileTextIcon,
  MessageSquarePlusIcon,
} from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { Button } from 'vinta-design-system/ui/button'
import type { PlanViewResponse } from '../../src/daemon/schemas.ts'
import type { Anchor, PlanReview, PromptRole } from '../../src/review/document.ts'
import { choresFor } from '../../src/chores.ts'
import { isJudgeGate, type Gate, type Node, type Workflow } from '../../src/types.ts'
import { Chip } from './Chip.tsx'
import { Prose } from './Markdown.tsx'
import { EmptyNote, ErrorNote, Panel } from './Panel.tsx'
import { Quotable } from './Quotable.tsx'
import { Segmented } from './Segmented.tsx'
import { commentsAt, gatesOf, ROLE_LABELS, type PhaseCounts } from './plan-model.ts'

type InspectorTab = 'brief' | PromptRole | 'gates' | 'chores'

export interface PhaseInspectorProps {
  readonly workflow: Workflow
  readonly view: PlanViewResponse
  readonly review: PlanReview | null
  readonly node: Node
  readonly counts: PhaseCounts | undefined
  /** Which tab to open on — a comment's "show me" can ask for a prompt. */
  readonly focus: InspectorTab | null
  readonly onComment: (anchor: Anchor, quote?: string) => void
  readonly onSelect: (nodeId: string) => void
  readonly onShowInPlan: (nodeId: string) => void
}

export function PhaseInspector({
  workflow,
  view,
  review,
  node,
  counts,
  focus,
  onComment,
  onSelect,
  onShowInPlan,
}: PhaseInspectorProps) {
  const [tab, setTab] = useState<InspectorTab>(focus ?? 'brief')
  useEffect(() => {
    if (focus !== null) setTab(focus)
  }, [focus])

  const materials = view.phases[node.id]
  const wave = view.waves[node.id]
  const dependents = workflow.nodes.filter((candidate) =>
    candidate.depends_on.some((dep) => dep.node === node.id),
  )
  const gates = gatesOf(workflow, node)
  const chores = choresFor(workflow, node)
  const count = (anchor: Anchor): number =>
    commentsAt(review, anchor).filter((comment) => comment.status === 'open').length

  const promptAnchor = (role: PromptRole): Anchor => ({ kind: 'prompt', node: node.id, role })

  return (
    <Panel
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">{node.id}</span>
          <span>{node.name}</span>
        </span>
      }
      description={<Staffing workflow={workflow} node={node} wave={wave ?? null} />}
      action={
        <>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-action="show-in-plan"
            onClick={() => onShowInPlan(node.id)}
          >
            <FileTextIcon aria-hidden="true" />
            In plan
          </Button>
          <Button
            type="button"
            variant="outline"
            size="xs"
            data-action="comment-phase"
            onClick={() => onComment({ kind: 'phase', node: node.id })}
          >
            <MessageSquarePlusIcon aria-hidden="true" />
            Comment
            {(counts?.open ?? 0) > 0 && (
              <span className="font-mono text-[11px] text-tone-attention-foreground">{counts?.open}</span>
            )}
          </Button>
        </>
      }
      expandable
      className="phase-inspector"
      data-phase={node.id}
    >
      <Pipeline workflow={workflow} node={node} gates={gates.length} chores={chores.length} />

      <div className="grid gap-3 text-[13px] sm:grid-cols-2">
        <Relations
          title="Depends on"
          icon={<ArrowUpLeftIcon aria-hidden="true" className="size-3.5" />}
          empty="Nothing — starts from the base branch."
          items={node.depends_on.map((dep) => ({
            id: dep.node,
            name: workflow.nodes.find((candidate) => candidate.id === dep.node)?.name ?? dep.node,
            note: dep.artifact,
          }))}
          onSelect={onSelect}
        />
        <Relations
          title="Unblocks"
          icon={<ArrowDownRightIcon aria-hidden="true" className="size-3.5" />}
          empty="Nothing waits for this phase."
          items={dependents.map((dependent) => ({
            id: dependent.id,
            name: dependent.name,
            note: dependent.depends_on.find((dep) => dep.node === node.id)?.artifact ?? '',
          }))}
          onSelect={onSelect}
        />
      </div>
      {node.touches.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-[13px]" data-touches>
          <span className="text-muted-foreground">Touches</span>
          {node.touches.map((path) => (
            <code key={path} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              {path}
            </code>
          ))}
        </div>
      )}

      <Segmented<InspectorTab>
        label="Phase detail"
        size="sm"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'brief', label: 'Brief' },
          ...(['implementer', 'reviewer', 'fixer'] as const).map((role) => ({
            value: role,
            label: ROLE_LABELS[role].replace(' prompt', ''),
            count: count(promptAnchor(role)),
            tone: 'attention' as const,
          })),
          {
            value: 'gates',
            label: 'Gates',
            count: gates.reduce((sum, gate) => sum + count({ kind: 'gate', gate: gate.id, node: node.id }), 0),
            tone: 'attention' as const,
          },
          { value: 'chores', label: `Chores${chores.length > 0 ? ` · ${chores.length}` : ''}` },
        ]}
      />

      {materials?.error !== null && materials?.error !== undefined && tab !== 'brief' && tab !== 'gates' && (
        <ErrorNote>The prompts could not be composed: {materials.error}</ErrorNote>
      )}

      {tab === 'brief' &&
        (materials?.brief === null || materials?.brief === undefined ? (
          <ErrorNote>
            <code className="font-mono">{node.prompt_ref}</code> resolves to nothing in the plan.
          </ErrorNote>
        ) : (
          <Quotable
            className="max-h-[var(--panel-scroll,520px)] overflow-y-auto rounded-lg border bg-background px-4 py-3"
            onQuote={(quote) => onComment({ kind: 'phase', node: node.id }, quote)}
          >
            <Prose text={materials.brief} className="plan-prose" />
          </Quotable>
        ))}

      {(tab === 'implementer' || tab === 'reviewer' || tab === 'fixer') && (
        <PromptBody
          key={tab}
          text={materials?.prompts[tab] ?? null}
          onComment={(quote) => onComment(promptAnchor(tab), quote)}
          role={tab}
        />
      )}

      {tab === 'gates' && (
        <GateList
          workflow={workflow}
          node={node}
          onComment={(gate) => onComment({ kind: 'gate', gate, node: node.id })}
          counts={(gate) => count({ kind: 'gate', gate, node: node.id })}
        />
      )}

      {tab === 'chores' &&
        (chores.length === 0 ? (
          <EmptyNote>This phase runs no chores.</EmptyNote>
        ) : (
          <ul className="flex flex-col gap-3" data-chores>
            {chores.map(({ id, chore }) => (
              <li key={id} className="flex flex-col gap-1.5 rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span className="font-mono font-medium">{id}</span>
                  <Chip tone="idle">{chore.when === 'after_pr' ? 'after the PR' : 'before the gates'}</Chip>
                  {chore.skill !== undefined && (
                    <span className="text-muted-foreground">
                      skill <code className="font-mono">{chore.skill}</code>
                    </span>
                  )}
                </div>
                {chore.description !== undefined && (
                  <p className="text-[13px] text-muted-foreground">{chore.description}</p>
                )}
                {materials?.chores[id] !== undefined && (
                  <PromptText text={materials.chores[id] as string} compact />
                )}
              </li>
            ))}
          </ul>
        ))}
    </Panel>
  )
}

/** Wave, who implements, who reviews — one line under the title. */
function Staffing({
  workflow,
  node,
  wave,
}: {
  readonly workflow: Workflow
  readonly node: Node
  readonly wave: number | null
}) {
  const member = node.crew === undefined ? undefined : workflow.crew[node.crew]
  const model = member?.model ?? node.model ?? workflow.defaults.model
  const harness = member?.harness ?? node.harness ?? workflow.defaults.harness ?? 'claude-code'
  const reviewer = expectedReviewer(workflow, member?.tier ?? null)
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs" data-staffing>
      {wave !== null && <span>wave {wave}</span>}
      <span>
        implements{' '}
        <span className="text-foreground">
          {node.crew !== undefined ? `${node.crew} · ` : ''}
          {member !== undefined ? `tier ${member.tier} · ` : ''}
          {model}
        </span>
      </span>
      <span>
        reviews <span className="text-foreground">{reviewer}</span>
      </span>
      <span>{harness}</span>
      <span>≤ {node.max_fix_rounds} fix rounds</span>
    </span>
  )
}

/**
 * Which reviewer a run would most likely give this phase: the cheapest one at
 * or above its tier, which is the scheduler's rule when nobody is warm. Said
 * as an expectation, because who is free at the time is a run's to know.
 */
function expectedReviewer(workflow: Workflow, tier: number | null): string {
  const eligible = Object.entries(workflow.crew)
    .filter(([, member]) => member.role === 'reviewer' && (tier === null || member.tier >= tier))
    .sort(([, a], [, b]) => a.tier - b.tier)
  const first = eligible[0]
  if (first !== undefined) return `${first[0]} · ${first[1].model}`
  return workflow.defaults.reviewer_model ?? workflow.defaults.model
}

/**
 * The phase's pipeline as a strip: what happens, in order, and what it is
 * gated on. Drawn for the built-in `standard-phase`; a plan with its own
 * pipeline gets its name and a pointer to the editor, which draws it whole.
 */
function Pipeline({
  workflow,
  node,
  gates,
  chores,
}: {
  readonly workflow: Workflow
  readonly node: Node
  readonly gates: number
  readonly chores: number
}) {
  const pipeline = node.pipeline ?? workflow.defaults.pipeline
  if (pipeline !== 'standard-phase') {
    return (
      <p className="text-[13px] text-muted-foreground" data-pipeline={pipeline}>
        Runs the <code className="font-mono">{pipeline}</code> pipeline — open it in the editor to see
        its states.
      </p>
    )
  }
  const steps: { id: string; label: string; detail: string }[] = [
    { id: 'implement', label: 'Implement', detail: 'one agent, its own lane' },
    { id: 'review', label: 'Review', detail: `fix loop ≤ ${node.max_fix_rounds}` },
    { id: 'polish', label: 'Polish', detail: chores === 0 ? 'no chores' : `${chores} chore${chores === 1 ? '' : 's'}` },
    { id: 'gate', label: 'Gates', detail: gates === 0 ? 'none' : node.gates.join(', ') },
    { id: 'integrate', label: 'Integrate', detail: 'merge · push · PR' },
  ]
  return (
    <ol className="flex flex-wrap items-stretch gap-1.5" data-pipeline="standard-phase" aria-label="Phase pipeline">
      {steps.map((step, index) => (
        <li key={step.id} className="flex items-center gap-1.5">
          <span
            className="flex flex-col rounded-md border bg-muted/50 px-2.5 py-1.5 leading-tight"
            data-step={step.id}
          >
            <span className="text-xs font-medium">{step.label}</span>
            <span className="max-w-44 truncate font-mono text-[11px] text-muted-foreground" title={step.detail}>
              {step.detail}
            </span>
          </span>
          {index < steps.length - 1 && <span aria-hidden="true" className="text-muted-foreground">→</span>}
        </li>
      ))}
    </ol>
  )
}

function Relations({
  title,
  icon,
  empty,
  items,
  onSelect,
}: {
  readonly title: string
  readonly icon: ReactNode
  readonly empty: string
  readonly items: readonly { readonly id: string; readonly name: string; readonly note: string }[]
  readonly onSelect: (nodeId: string) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
        {icon}
        {title}
      </span>
      {items.length === 0 ? (
        <span className="text-muted-foreground">{empty}</span>
      ) : (
        <ul className="flex flex-col gap-1">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="text-left hover:underline"
                data-action="select-phase"
                data-id={item.id}
                onClick={() => onSelect(item.id)}
              >
                <span className="font-mono text-xs text-muted-foreground">{item.id}</span> {item.name}
              </button>
              {item.note !== '' && <span className="block text-xs text-muted-foreground">{item.note}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function PromptBody({
  text,
  role,
  onComment,
}: {
  readonly text: string | null
  readonly role: PromptRole
  readonly onComment: (quote?: string) => void
}) {
  if (text === null) return <EmptyNote>No {role} prompt for this phase.</EmptyNote>
  return (
    <div className="flex flex-col gap-2" data-prompt={role}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          Exactly what the {role} is sent on a cold start. A run swaps in its lane's path and the
          phase branch, and adds its dependencies' reports.
          <span className="ml-2 font-mono">
            {text.length.toLocaleString()} chars · ~{Math.ceil(text.length / 4).toLocaleString()} tokens
          </span>
        </span>
        <span className="flex items-center gap-1">
          <CopyButton text={text} />
          <Button
            type="button"
            variant="outline"
            size="xs"
            data-action="comment-prompt"
            onClick={() => onComment()}
          >
            <MessageSquarePlusIcon aria-hidden="true" />
            Comment
          </Button>
        </span>
      </div>
      <Quotable onQuote={(quote) => onComment(quote)}>
        <PromptText text={text} />
      </Quotable>
    </div>
  )
}

function PromptText({ text, compact = false }: { readonly text: string; readonly compact?: boolean }) {
  return (
    <pre
      className={
        compact
          ? 'max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted/60 p-2.5 font-mono text-xs leading-relaxed'
          : 'max-h-[var(--panel-scroll,520px)] overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed'
      }
      data-prompt-text
    >
      {text}
    </pre>
  )
}

function CopyButton({ text }: { readonly text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      data-action="copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  )
}

function GateList({
  workflow,
  node,
  onComment,
  counts,
}: {
  readonly workflow: Workflow
  readonly node: Node
  readonly onComment: (gate: string) => void
  readonly counts: (gate: string) => number
}) {
  const gates = gatesOf(workflow, node)
  if (gates.length === 0) {
    return <EmptyNote>No gates. This phase merges on its review alone.</EmptyNote>
  }
  return (
    <ul className="flex flex-col gap-2" data-gates>
      {gates.map(({ id, gate }) => (
        <li key={id} className="rounded-lg border p-3" data-gate={id}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <span className="font-mono text-[13px] font-medium">{id}</span>
              <GateKind gate={gate} />
            </span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              data-action="comment-gate"
              data-gate-id={id}
              onClick={() => onComment(id)}
            >
              <MessageSquarePlusIcon aria-hidden="true" />
              Comment
              {counts(id) > 0 && (
                <span className="font-mono text-[11px] text-tone-attention-foreground">{counts(id)}</span>
              )}
            </Button>
          </div>
          <GateDetail gate={gate} />
        </li>
      ))}
    </ul>
  )
}

export function GateKind({ gate }: { readonly gate: Gate | null }) {
  if (gate === null) return <Chip tone="error">undeclared</Chip>
  if (isJudgeGate(gate)) return <Chip tone="attention">judge</Chip>
  return <Chip tone="idle">{gate.type ?? 'command'}</Chip>
}

export function GateDetail({ gate }: { readonly gate: Gate | null }) {
  if (gate === null) {
    return <p className="mt-1 text-[13px] text-tone-error-foreground">No gate with this id is declared.</p>
  }
  if (isJudgeGate(gate)) {
    const question = gate.judge.question ?? gate.judge.question_ref ?? ''
    return (
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
        <dt className="text-muted-foreground">Asks</dt>
        <dd>{question}</dd>
        {gate.requires.length > 0 && (
          <>
            <dt className="text-muted-foreground">Holds</dt>
            <dd className="font-mono text-xs">{gate.requires.join(', ')}</dd>
          </>
        )}
      </dl>
    )
  }
  return (
    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
      <dt className="text-muted-foreground">Runs</dt>
      <dd>
        <code className="break-all font-mono text-xs">{gate.cmd}</code>
      </dd>
      {gate.scoped_cmd !== undefined && (
        <>
          <dt className="text-muted-foreground">Scoped</dt>
          <dd>
            <code className="break-all font-mono text-xs">{gate.scoped_cmd}</code>
          </dd>
        </>
      )}
      <dt className="text-muted-foreground">Timeout</dt>
      <dd className="font-mono text-xs">{gate.timeout_s}s</dd>
      {gate.requires.length > 0 && (
        <>
          <dt className="text-muted-foreground">Holds</dt>
          <dd className="font-mono text-xs">{gate.requires.join(', ')}</dd>
        </>
      )}
    </dl>
  )
}

