/**
 * Plans, and the page a person reviews one on (§19).
 *
 * The page answers the three questions approving a plan comes down to, each on
 * its own tab, with the conversation about them always beside it:
 *
 * - **Is the shape right?** The graph — waves, dependencies and what each edge
 *   carries — coloured by review state, with the selected phase's brief,
 *   prompts, gates and staffing under it.
 * - **Does the plan say what it means?** The markdown, whole, every section
 *   commentable and every selection quotable.
 * - **Will it be held to the right bar?** Every gate every phase runs, with the
 *   commands a run would execute; and a projected schedule of what runs with
 *   what.
 *
 * The review is live in both directions. The page polls the review file and a
 * stamp of the plan's files every two seconds: the agent's replies appear in
 * the chat, and when it edits the plan the page re-reads it and says so.
 */
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  FilePenLineIcon,
  MessagesSquareIcon,
  RefreshCwIcon,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderHeading,
  PageHeaderMeta,
  PageHeaderTitle,
} from 'vinta-design-system/layout'
import { Button } from 'vinta-design-system/ui/button'
import { Card } from 'vinta-design-system/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from 'vinta-design-system/ui/table'
import { cn } from 'vinta-design-system/lib/utils'
import type {
  PlanReviewResponse,
  PlanSummary,
  PlanViewResponse,
} from '../../src/daemon/schemas.ts'
import type { Anchor, PromptRole } from '../../src/review/document.ts'
import type { Workflow } from '../../src/types.ts'
import { Chip, TONE_DOT } from './Chip.tsx'
import { DagView } from './Dag.tsx'
import { EmptyNote, ErrorNote, Hint, Panel } from './Panel.tsx'
import { PhaseInspector } from './PhaseInspector.tsx'
import { PlanDocument } from './PlanDocument.tsx'
import { PlanGates } from './PlanGates.tsx'
import { PlanSchedule } from './PlanSchedule.tsx'
import { ReviewChat } from './ReviewChat.tsx'
import { ReviewComments, type DraftTarget } from './ReviewComments.tsx'
import { Segmented } from './Segmented.tsx'
import {
  isUnsent,
  issueNode,
  phaseCounts,
  phaseState,
  REVIEW_DAG_STRINGS,
  sectionsByNode,
  splitPlan,
  toReviewDag,
  type PhaseCounts,
  type PhaseReviewState,
} from './plan-model.ts'
import { PlanRefused, type PlansClient } from './plans-client.ts'
import type { Tone } from './status.ts'
import { ago } from './time.ts'

/** How often the review and the plan's stamp are re-read. A file read, on loopback. */
const POLL_MS = 2_000

type MainTab = 'graph' | 'plan' | 'gates' | 'schedule' | 'issues'
type SideTab = 'comments' | 'chat'
type InspectorTab = 'brief' | PromptRole | 'gates' | 'chores'

const STATE_TONE: Readonly<Record<PhaseReviewState, Tone>> = {
  clean: 'idle',
  commented: 'attention',
  resolved: 'ok',
  issues: 'error',
}

const STATE_LABEL: Readonly<Record<PhaseReviewState, string>> = {
  clean: 'No comments',
  commented: 'Open comments',
  resolved: 'Comments resolved',
  issues: 'Has issues',
}

/** Refusal codes the page can explain. Anything else is reported generically. */
const REFUSALS: Readonly<Record<string, string>> = {
  comment_already_sent: 'That comment was already sent to the agent, so it stays — resolve it instead.',
  review_busy: 'The review file is busy. Try again in a moment.',
  invalid_review: 'The review file is not valid JSON any more. Fix or remove it, then reload.',
  already_approved: 'This plan is already approved.',
  empty_message: 'There is nothing to send.',
  unknown_comment: 'That comment no longer exists.',
}

// ---------------------------------------------------------------------------
// The plan list
// ---------------------------------------------------------------------------

export function PlansList({ plans }: { readonly plans: PlansClient }) {
  const [list, setList] = useState<readonly PlanSummary[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let stopped = false
    plans
      .list()
      .then((next) => {
        if (!stopped) setList(next)
      })
      .catch(() => {
        if (!stopped) setFailed(true)
      })
    return () => {
      stopped = true
    }
  }, [plans])

  return (
    <div className="flex flex-col gap-5" data-plans>
      <PageHeader>
        <PageHeaderHeading>
          <PageHeaderTitle>Plans</PageHeaderTitle>
          <PageHeaderMeta>
            <span>ai-plans/*.workflow.json — review a plan before it runs</span>
          </PageHeaderMeta>
        </PageHeaderHeading>
      </PageHeader>
      {failed && <ErrorNote>The plans could not be listed.</ErrorNote>}
      {list !== null && list.length === 0 && (
        <EmptyNote>
          No plans in <code className="font-mono">ai-plans/</code> yet. Run{' '}
          <code className="font-mono">plan-feature</code> in this project; the workflow it writes
          shows up here.
        </EmptyNote>
      )}
      {list !== null && list.length > 0 && (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Plan</TableHead>
                <TableHead className="w-24">Phases</TableHead>
                <TableHead className="w-32">Checks</TableHead>
                <TableHead className="w-32">Review</TableHead>
                <TableHead className="w-40">Comments</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((plan) => (
                <TableRow key={plan.id} data-plan-row={plan.id}>
                  <TableCell>
                    <a href={`#/plans/${encodeURIComponent(plan.id)}`} className="flex flex-col hover:underline">
                      <span className="font-medium">{plan.title ?? plan.id}</span>
                      <span className="font-mono text-xs text-muted-foreground">{plan.id}</span>
                    </a>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{plan.phases ?? '—'}</TableCell>
                  <TableCell>
                    <Chip tone={plan.valid ? 'ok' : 'error'}>{plan.valid ? 'valid' : 'issues'}</Chip>
                  </TableCell>
                  <TableCell>
                    <Chip tone={plan.status === 'approved' ? 'ok' : 'idle'}>
                      {plan.status === 'approved' ? 'approved' : 'in review'}
                    </Chip>
                  </TableCell>
                  <TableCell className="text-[13px]">
                    {plan.openComments} open
                    {plan.unsentComments > 0 && (
                      <span className="text-muted-foreground"> · {plan.unsentComments} unsent</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// One plan
// ---------------------------------------------------------------------------

/**
 * The view and the review, kept fresh. The review is polled; the view is
 * re-read only when the stamp of the files under it moves, and `changedAt`
 * says when that last happened so the page can tell the reviewer.
 */
function usePlanData(plans: PlansClient, planId: string) {
  const [view, setView] = useState<PlanViewResponse | null>(null)
  const [state, setState] = useState<PlanReviewResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [changedAt, setChangedAt] = useState<number | null>(null)
  const stamp = useRef<string | null>(null)

  const loadView = useCallback(
    async (changed: boolean) => {
      try {
        const next = await plans.view(planId)
        stamp.current = next.stamp
        setView(next)
        setLoadError(null)
        if (changed) setChangedAt(Date.now())
      } catch (error) {
        setLoadError(
          error instanceof PlanRefused && error.code === 'unknown_plan'
            ? `There is no ai-plans/${planId}.workflow.json in this project.`
            : 'The plan could not be loaded.',
        )
      }
    },
    [plans, planId],
  )

  useEffect(() => {
    void loadView(false)
  }, [loadView])

  useEffect(() => {
    let stopped = false
    const tick = async (): Promise<void> => {
      try {
        const next = await plans.review(planId)
        if (stopped) return
        setState(next)
        if (stamp.current !== null && next.stamp !== stamp.current) {
          stamp.current = next.stamp
          void loadView(true)
        }
      } catch {
        // The next tick asks again; a review that never loads is reported by
        // the view's own failure, which says why.
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), POLL_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [plans, planId, loadView])

  return { view, state, setState, loadError, changedAt }
}

export function PlanReviewView({
  plans,
  planId,
}: {
  readonly plans: PlansClient
  readonly planId: string
}) {
  const { view, state, setState, loadError, changedAt } = usePlanData(plans, planId)
  const [tab, setTab] = useState<MainTab>('graph')
  const [side, setSide] = useState<SideTab>('comments')
  const [selected, setSelected] = useState<string | null>(null)
  const [inspectorFocus, setInspectorFocus] = useState<InspectorTab | null>(null)
  const [sectionFocus, setSectionFocus] = useState<string | null>(null)
  const [gateFocus, setGateFocus] = useState<string | null>(null)
  const [target, setTarget] = useState<DraftTarget>({ anchor: { kind: 'plan' } })
  const [focusToken, setFocusToken] = useState(0)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [seenChat, setSeenChat] = useState(0)

  const workflow = view?.workflow ?? null
  const review = state?.review ?? null
  const issues = view?.issues ?? []
  const split = useMemo(() => splitPlan(view?.plan?.markdown ?? ''), [view?.plan?.markdown])
  const sectionToNode = useMemo(() => sectionsByNode(workflow, split.sections), [workflow, split])
  const counts = useMemo(
    () => phaseCounts(workflow, review, issues, sectionToNode),
    [workflow, review, issues, sectionToNode],
  )
  const dag = useMemo(() => (workflow === null ? null : toReviewDag(workflow, counts)), [workflow, counts])

  // Open on the first phase, and keep the selection valid when the agent
  // renumbers the plan underneath it.
  useEffect(() => {
    if (workflow === null) return
    if (selected === null || !workflow.nodes.some((node) => node.id === selected)) {
      setSelected(workflow.nodes[0]?.id ?? null)
    }
  }, [workflow, selected])

  const conversation = review?.conversation ?? []
  const agentMessages = conversation.filter((message) => message.author.kind === 'agent').length
  useEffect(() => {
    if (side === 'chat') setSeenChat(agentMessages)
  }, [side, agentMessages])

  const compose = useCallback((anchor: Anchor, quote?: string) => {
    setTarget(quote === undefined ? { anchor } : { anchor, quote })
    setSide('comments')
    setFocusToken((token) => token + 1)
  }, [])

  const selectPhase = useCallback((nodeId: string) => {
    setTab('graph')
    setSelected(nodeId)
  }, [])

  const reveal = useCallback(
    (anchor: Anchor) => {
      switch (anchor.kind) {
        case 'plan':
          setTab('plan')
          return
        case 'section':
          setTab('plan')
          setSectionFocus(anchor.section)
          return
        case 'phase':
          selectPhase(anchor.node)
          setInspectorFocus('brief')
          return
        case 'prompt':
          selectPhase(anchor.node)
          setInspectorFocus(anchor.role)
          return
        case 'gate':
          if (anchor.node !== undefined) {
            selectPhase(anchor.node)
            setInspectorFocus('gates')
          } else {
            setTab('gates')
            setGateFocus(anchor.gate)
          }
      }
    },
    [selectPhase],
  )

  const showInPlan = useCallback(
    (nodeId: string) => {
      const node = workflow?.nodes.find((candidate) => candidate.id === nodeId)
      const section = [...sectionToNode].find(([, id]) => id === nodeId)?.[0] ?? null
      if (node === undefined) return
      setTab('plan')
      setSectionFocus(section)
    },
    [workflow, sectionToNode],
  )

  async function mutate(action: () => Promise<PlanReviewResponse>): Promise<boolean> {
    try {
      setState(await action())
      setActionError(null)
      return true
    } catch (error) {
      setActionError(
        error instanceof PlanRefused
          ? (REFUSALS[error.code] ?? `The change was refused (${error.code}).`)
          : 'The daemon could not be reached.',
      )
      return false
    }
  }

  if (view === null) {
    return loadError === null ? (
      <EmptyNote>Loading the plan…</EmptyNote>
    ) : (
      <div className="flex flex-col gap-3">
        <ErrorNote>{loadError}</ErrorNote>
        <a href="#/plans" className="text-sm text-primary hover:underline">
          ← All plans
        </a>
      </div>
    )
  }

  const comments = review?.comments ?? []
  const open = comments.filter((comment) => comment.status === 'open').length
  const unsent = comments.filter(isUnsent).length
  const waves = Object.values(view.waves)
  const waveCount = waves.length === 0 ? 0 : Math.max(...waves)
  const approved = review?.status === 'approved'
  const node = workflow?.nodes.find((candidate) => candidate.id === selected) ?? null
  const workflowPath = (state?.path ?? `ai-plans/${planId}.review.json`).replace(
    /\.review\.json$/,
    '.workflow.json',
  )
  const unreadChat = Math.max(0, agentMessages - seenChat)

  return (
    <div className="flex flex-col gap-5" data-plan-review={planId}>
      <a href="#/plans" className="-mb-3 w-fit text-[13px] text-muted-foreground hover:text-foreground">
        ← Plans
      </a>
      <PageHeader>
        <PageHeaderHeading>
          <PageHeaderTitle>{view.plan?.title ?? planId}</PageHeaderTitle>
          <PageHeaderMeta>
            <span>{planId}</span>
            {view.plan !== null && <span>{view.plan.ref}</span>}
            {workflow !== null && <span>base {workflow.base_branch}</span>}
            {workflow !== null && (
              <span>
                {workflow.nodes.length} phases · {waveCount} {waveCount === 1 ? 'wave' : 'waves'}
              </span>
            )}
          </PageHeaderMeta>
        </PageHeaderHeading>
        <PageHeaderActions>
          <button
            type="button"
            onClick={() => setTab(view.valid ? 'graph' : 'issues')}
            data-action="checks"
            className="cursor-pointer"
          >
            <Chip tone={view.valid ? 'ok' : 'error'}>
              {view.valid ? 'valid' : `${issues.length} issue${issues.length === 1 ? '' : 's'}`}
            </Chip>
          </button>
          <Chip tone={approved ? 'ok' : open > 0 ? 'attention' : 'idle'}>
            {approved ? 'approved' : open > 0 ? `${open} open` : 'in review'}
          </Chip>
          <Button asChild variant="outline" size="sm">
            <a href={`#/editor/${encodeURIComponent(planId)}`}>
              <FilePenLineIcon />
              Editor
            </a>
          </Button>
          {approved ? (
            <span className="flex items-center gap-1.5 text-[13px] text-tone-ok-foreground" data-approved>
              <CheckCircle2Icon className="size-4" aria-hidden="true" />
              Approved{review?.approved_at !== undefined ? ` ${ago(Date.parse(review.approved_at), Date.now())}` : ''}
            </span>
          ) : confirming ? (
            <span className="flex items-center gap-1.5 text-[13px]" data-confirm-approve>
              {open > 0 || unsent > 0
                ? `${open} open${unsent > 0 ? `, ${unsent} unsent` : ''} — approve anyway?`
                : 'Approve this plan?'}
              <Button
                type="button"
                size="sm"
                data-action="approve-confirm"
                onClick={() => {
                  setConfirming(false)
                  void mutate(() => plans.approve(planId))
                }}
              >
                Approve
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </span>
          ) : (
            <Button type="button" size="sm" data-action="approve" onClick={() => setConfirming(true)}>
              <CheckCircle2Icon />
              Approve plan
            </Button>
          )}
        </PageHeaderActions>
      </PageHeader>

      {changedAt !== null && Date.now() - changedAt < 60_000 && (
        <p
          className="-mt-2 flex items-center gap-2 rounded-lg border border-tone-active/30 bg-tone-active-soft/40 px-3 py-2 text-[13px]"
          data-plan-changed
          role="status"
        >
          <RefreshCwIcon className="size-3.5" aria-hidden="true" />
          The plan changed on disk and this page now shows the new version.
        </p>
      )}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Segmented<MainTab>
            label="Plan views"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'graph', label: 'Graph' },
              { value: 'plan', label: 'Plan' },
              { value: 'gates', label: 'Gates' },
              { value: 'schedule', label: 'Schedule' },
              ...(issues.length > 0
                ? [{ value: 'issues' as const, label: 'Issues', count: issues.length, tone: 'error' as const }]
                : []),
            ]}
          />

          {tab === 'graph' &&
            (workflow === null || dag === null ? (
              <ErrorNote>The workflow does not have a workflow's shape yet — see Issues.</ErrorNote>
            ) : (
              <>
                <Legend counts={counts} />
                <DagView
                  dag={dag}
                  selected={selected}
                  onSelect={(id) => {
                    if (id !== null) setSelected(id)
                  }}
                  onOpen={(id) => compose({ kind: 'phase', node: id })}
                  strings={REVIEW_DAG_STRINGS}
                />
                <Hint className="-mt-3 text-xs">
                  Click a phase to inspect it; double-click to comment on it. Colours are review
                  state, not run state.
                </Hint>
                {node !== null && (
                  <PhaseInspector
                    key={node.id}
                    workflow={workflow}
                    view={view}
                    review={review}
                    node={node}
                    counts={counts.get(node.id)}
                    focus={inspectorFocus}
                    onComment={compose}
                    onSelect={setSelected}
                    onShowInPlan={showInPlan}
                  />
                )}
                <PhaseTable
                  workflow={workflow}
                  waves={view.waves}
                  counts={counts}
                  selected={selected}
                  onSelect={setSelected}
                />
              </>
            ))}

          {tab === 'plan' &&
            (view.plan === null ? (
              <ErrorNote>
                The plan's markdown could not be read — its <code className="font-mono">plan_ref</code>{' '}
                names no file in this repository.
              </ErrorNote>
            ) : (
              <PlanDocument
                planRef={view.plan.ref}
                split={split}
                review={review}
                sectionToNode={sectionToNode}
                focus={sectionFocus}
                onComment={compose}
                onShowPhase={selectPhase}
              />
            ))}

          {tab === 'gates' && workflow !== null && (
            <PlanGates
              workflow={workflow}
              waves={view.waves}
              review={review}
              focus={gateFocus}
              onComment={compose}
              onSelectPhase={selectPhase}
            />
          )}

          {tab === 'schedule' && workflow !== null && (
            <PlanSchedule
              plans={plans}
              planId={planId}
              workflow={workflow}
              stamp={view.stamp}
              onSelectPhase={selectPhase}
            />
          )}

          {tab === 'issues' && <IssueList view={view} workflow={workflow} onSelectPhase={selectPhase} />}
        </div>

        <Card className="gap-3 px-3 py-3 lg:sticky lg:top-16 lg:max-h-[calc(100vh-5rem)]" data-review-sidebar>
          <Segmented<SideTab>
            label="Review"
            value={side}
            onChange={setSide}
            className="w-full"
            options={[
              { value: 'comments', label: 'Comments', count: open, tone: 'attention' },
              {
                value: 'chat',
                label: (
                  <span className="flex items-center gap-1.5">
                    <MessagesSquareIcon className="size-3.5" aria-hidden="true" />
                    Agent
                  </span>
                ),
                count: unreadChat,
                tone: 'attention',
              },
            ]}
          />
          {side === 'comments' ? (
            <ReviewComments
              review={review}
              workflow={workflow}
              target={target}
              focusToken={focusToken}
              onClearTarget={() => setTarget({ anchor: { kind: 'plan' } })}
              onSave={async (draft, body) => {
                const ok = await mutate(() =>
                  plans.comment(planId, {
                    anchor: draft.anchor,
                    body,
                    ...(draft.quote === undefined ? {} : { quote: draft.quote }),
                  }),
                )
                // A quote belongs to one comment; the next one starts clean.
                if (ok && draft.quote !== undefined) setTarget({ anchor: draft.anchor })
                return ok
              }}
              onReply={(id, body) => mutate(() => plans.reply(planId, id, body))}
              onStatus={(id, status) => mutate(() => plans.setStatus(planId, id, status))}
              onDiscard={(id) => mutate(() => plans.discard(planId, id))}
              onSend={async (note) => {
                const ok = await mutate(() => plans.message(planId, note, 'unsent'))
                if (ok) setSide('chat')
                return ok
              }}
              onReveal={reveal}
              error={actionError}
            />
          ) : (
            <ReviewChat
              review={review}
              presence={state?.presence ?? null}
              workflowPath={workflowPath}
              onSend={(body) => mutate(() => plans.message(planId, body, 'none'))}
              onReveal={reveal}
              error={actionError}
            />
          )}
        </Card>
      </div>
    </div>
  )
}

function Legend({ counts }: { readonly counts: ReadonlyMap<string, PhaseCounts> }) {
  const tally = new Map<PhaseReviewState, number>()
  for (const entry of counts.values()) {
    const state = phaseState(entry)
    tally.set(state, (tally.get(state) ?? 0) + 1)
  }
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" data-legend>
      {(Object.keys(STATE_LABEL) as PhaseReviewState[]).map((state) => (
        <li key={state} className="flex items-center gap-1.5" data-legend-state={state}>
          <span className={cn('inline-block size-2 rounded-full', TONE_DOT[STATE_TONE[state]])} />
          {STATE_LABEL[state]}
          <span className="font-mono">{tally.get(state) ?? 0}</span>
        </li>
      ))}
    </ul>
  )
}

function PhaseTable({
  workflow,
  waves,
  counts,
  selected,
  onSelect,
}: {
  readonly workflow: Workflow
  readonly waves: Readonly<Record<string, number>>
  readonly counts: ReadonlyMap<string, PhaseCounts>
  readonly selected: string | null
  readonly onSelect: (nodeId: string) => void
}) {
  return (
    <Panel title="Phases" description="Every phase, in plan order.">
      <div className="overflow-x-auto">
        <Table data-phase-table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">Wave</TableHead>
              <TableHead>Phase</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead>Gates</TableHead>
              <TableHead className="w-28">Review</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {workflow.nodes.map((node) => {
              const entry = counts.get(node.id)
              const state = phaseState(entry)
              const member = node.crew === undefined ? undefined : workflow.crew[node.crew]
              return (
                <TableRow
                  key={node.id}
                  aria-current={node.id === selected}
                  className="cursor-pointer aria-[current=true]:bg-muted"
                  onClick={() => onSelect(node.id)}
                  data-phase-row={node.id}
                >
                  <TableCell className="font-mono text-xs">{waves[node.id] ?? '—'}</TableCell>
                  <TableCell>
                    <span className="font-mono text-xs text-muted-foreground">{node.id}</span> {node.name}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {node.crew ?? '—'}
                    {member !== undefined && (
                      <span className="text-muted-foreground"> · t{member.tier} · {member.model}</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{node.gates.join(', ') || '—'}</TableCell>
                  <TableCell>
                    <Chip tone={STATE_TONE[state]}>
                      {state === 'commented'
                        ? `${entry?.open ?? 0} open`
                        : state === 'issues'
                          ? `${entry?.issues ?? 0} issue${entry?.issues === 1 ? '' : 's'}`
                          : state === 'resolved'
                            ? 'resolved'
                            : '—'}
                    </Chip>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </Panel>
  )
}

const SOURCE_LABEL = {
  workflow: 'Workflow',
  config: '.vinta-ai-workflows.yaml',
  reference: 'Plan reference',
} as const

function IssueList({
  view,
  workflow,
  onSelectPhase,
}: {
  readonly view: PlanViewResponse
  readonly workflow: Workflow | null
  readonly onSelectPhase: (nodeId: string) => void
}) {
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <AlertTriangleIcon className="size-4 text-tone-error" aria-hidden="true" />
          {view.issues.length} issue{view.issues.length === 1 ? '' : 's'}
        </span>
      }
      description={
        <>
          What <code className="font-mono">vinta-ai-maestro validate</code> reports. A run would stop
          on each of these.
        </>
      }
    >
      <ul className="divide-y text-[13px]" data-issues>
        {view.issues.map((issue, index) => {
          const nodeId = issueNode(issue, workflow)
          return (
            <li key={`${issue.path}-${index}`} className="flex flex-col gap-0.5 py-2" data-issue={issue.path}>
              <span className="flex flex-wrap items-center gap-2">
                <code className="font-mono text-xs">{issue.path === '' ? '(document)' : issue.path}</code>
                <Chip tone="idle">{SOURCE_LABEL[issue.source]}</Chip>
                {nodeId !== null && (
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline"
                    onClick={() => onSelectPhase(nodeId)}
                  >
                    {nodeId}
                  </button>
                )}
              </span>
              <span>{issue.message}</span>
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}
