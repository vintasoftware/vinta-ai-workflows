/**
 * The interview page (§20): an agent's interview as a form, one decision per
 * screen.
 *
 * Chat is a poor surface for deciding. Options arrive as one-line labels, the
 * context that made them meaningful scrolled away three messages ago, and a
 * diagram is impossible. Here each decision has the whole screen — what the
 * agent already knows, an explainer with its diagrams, the options as cards
 * with their consequences, the agent's recommended default marked — and the
 * chat that remains is for *questions* to the agent, answered in the next
 * round.
 *
 * Three columns on a wide window, stacked on a phone: the rail (every group
 * and decision, with done / waived / open state, to go back and change an
 * earlier answer before submitting), the decision, and the question panel.
 * The bar under them moves between decisions and submits the round.
 *
 * The page holds no authoritative state. A round is the agent's file, the
 * answers are the server's, and the draft in between is kept in the browser
 * so a reload or a closed tab loses nothing before submission. The server's
 * state is polled, and followed live where the browser has `EventSource`, so
 * the page switches to the next round the moment the agent writes it.
 */
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleIcon,
  InfoIcon,
  MinusIcon,
  XIcon,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AppBrand,
  AppMain,
  AppShell,
  AppTopbar,
  AppTopbarActions,
  HStack,
  PageHeaderMeta,
  VStack,
} from 'vinta-design-system/layout'
import { cn } from 'vinta-design-system/lib/utils'
import { Alert, AlertDescription, AlertTitle } from 'vinta-design-system/ui/alert'
import { Badge, type ToneVariant } from 'vinta-design-system/ui/badge'
import { Button } from 'vinta-design-system/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from 'vinta-design-system/ui/card'
import { Checkbox } from 'vinta-design-system/ui/checkbox'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from 'vinta-design-system/ui/empty'
import { Input } from 'vinta-design-system/ui/input'
import { Label } from 'vinta-design-system/ui/label'
import { NativeSelect, NativeSelectOption } from 'vinta-design-system/ui/native-select'
import { Progress } from 'vinta-design-system/ui/progress'
import { Skeleton } from 'vinta-design-system/ui/skeleton'
import { Textarea } from 'vinta-design-system/ui/textarea'
import type {
  Decision,
  Explainer,
  InterviewAnswers,
  InterviewRound,
  Option,
  Reply,
} from '../../src/interview/document.ts'
import type { InterviewState, RoundSummary } from '../../src/interview/wire.ts'
import { BrandMark } from './Brand.tsx'
import { InterviewRefused, type InterviewClient } from './interview-client.ts'
import {
  answerOf,
  draftKey,
  EMPTY_DRAFT,
  firstOpen,
  flatten,
  fromAnswers,
  isDone,
  missing,
  offersOther,
  pick,
  questionId,
  toAnswers,
  typeOther,
  waive,
  type Draft,
  type DraftAnswer,
  type Placed,
} from './interview-model.ts'
import { Prose } from './Markdown.tsx'
import { EmptyNote, ErrorNote, Hint } from './Panel.tsx'
import { ThemeProvider, ThemeToggle } from './theme.tsx'

/** How often the server's state is re-read. A directory listing, on loopback. */
const DEFAULT_POLL_MS = 3_000

/** Refusal codes the page can explain. Anything else is reported by its code. */
const REFUSALS: Readonly<Record<string, string>> = {
  already_submitted: 'This round was already submitted. The page will show the submitted answers.',
  unknown_round: 'The server no longer has this round.',
  invalid_round: 'The round file is no longer valid; ask the agent to fix it.',
  invalid_answers: 'The server refused the answers. Reload the page and try again.',
  round_mismatch: 'The server refused the answers. Reload the page and try again.',
  unknown_decision: 'The round changed under this page. Reload it and answer again.',
  unauthorized: 'The page has lost its access. Open the URL the agent printed again.',
}

const TAG_TONE: Readonly<Record<'neutral' | 'warn' | 'ok', ToneVariant>> = {
  neutral: 'idle',
  warn: 'wait',
  ok: 'ok',
}

const WAIVE_LABEL = 'Not applicable to this feature — skip this decision'

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export function InterviewApp({
  client,
  pollMs = DEFAULT_POLL_MS,
}: {
  readonly client: InterviewClient
  readonly pollMs?: number
}) {
  const interview = useInterview(client, pollMs)
  const { state, target, loaded } = interview
  const round = loaded?.round ?? null
  const title = round?.interview.title ?? 'Interview'
  const rounds = state?.rounds ?? []

  useEffect(() => {
    document.title = round === null ? 'Interview · Vinta AI Maestro' : `${title} · round ${round.round}`
  }, [round, title])

  return (
    <ThemeProvider>
      <AppShell className="app" data-interview>
        <AppTopbar className="app-head">
          <AppBrand>
            <BrandMark />
            <span className="hidden sm:inline">AI Maestro</span>
          </AppBrand>
          <div className="min-w-0 flex-1 truncate text-sm" data-interview-title>
            <span className="font-medium text-foreground">{title}</span>
            {round !== null && (
              <span className="text-muted-foreground">
                {' · '}Round {round.round} · {round.kind === 'readback' ? 'Read-back' : 'Decisions'}
                {round.interview.skill === undefined ? '' : ` · ${round.interview.skill}`}
              </span>
            )}
          </div>
          <AppTopbarActions className="shrink-0 flex-nowrap">
            {rounds.length > 1 && target !== null && (
              <NativeSelect
                size="sm"
                aria-label="Round"
                data-round-select
                value={String(target)}
                onChange={(event) => interview.open(Number(event.target.value))}
              >
                {rounds.map((summary) => (
                  <NativeSelectOption key={summary.round} value={String(summary.round)}>
                    Round {summary.round}
                    {summary.answered ? ' · submitted' : summary.error !== null ? ' · invalid' : ''}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
            <ThemeToggle />
          </AppTopbarActions>
        </AppTopbar>
        <AppMain className="max-w-none gap-0 px-0 py-0">
          <Body client={client} interview={interview} />
        </AppMain>
      </AppShell>
    </ThemeProvider>
  )
}

function Body({ client, interview }: { readonly client: InterviewClient; readonly interview: Interview }) {
  const { state, unreachable, target, loaded } = interview
  if (state === null) {
    return unreachable ? (
      <Centered>
        <EmptyTitle>Cannot reach the interview server</EmptyTitle>
        <EmptyDescription>
          It may have been stopped. Ask the agent to run <code className="font-mono">interview start</code>{' '}
          again, then reload this page.
        </EmptyDescription>
      </Centered>
    ) : (
      <div className="flex flex-col gap-3 p-8" data-loading>
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }
  if (target === null) {
    return (
      <Centered>
        <EmptyTitle>Waiting for the first round</EmptyTitle>
        <EmptyDescription>The agent is preparing the interview. This page updates on its own.</EmptyDescription>
      </Centered>
    )
  }
  if (loaded === null || loaded.roundNo !== target) {
    return (
      <div className="flex flex-col gap-3 p-8" data-loading>
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }
  if (loaded.round === null) {
    return (
      <Centered>
        <EmptyTitle>Round {loaded.roundNo} cannot be shown</EmptyTitle>
        <EmptyDescription>
          <ErrorNote>
            {loaded.error === 'invalid_json'
              ? 'The round file is not valid JSON.'
              : loaded.error === 'invalid_round'
                ? 'The round file does not match the interview-round schema.'
                : 'The round could not be read from the server.'}
          </ErrorNote>
          Ask the agent to fix it; this page refreshes on its own.
        </EmptyDescription>
      </Centered>
    )
  }
  return (
    <RoundForm
      key={`${loaded.round.interview.slug}:${loaded.roundNo}`}
      client={client}
      round={loaded.round}
      submitted={loaded.submitted}
      state={state}
      onSubmitted={interview.refresh}
      onOpen={interview.open}
    />
  )
}

function Centered({ children }: { readonly children: ReactNode }) {
  return (
    <Empty className="min-h-[60vh]" data-empty>
      <EmptyHeader>{children}</EmptyHeader>
    </Empty>
  )
}

// ---------------------------------------------------------------------------
// The server's state, followed
// ---------------------------------------------------------------------------

interface Loaded {
  readonly roundNo: number
  readonly round: InterviewRound | null
  readonly error: RoundSummary['error'] | 'unreachable' | null
  /** The answers, when the round was submitted; the form is then read-only. */
  readonly submitted: InterviewAnswers | null
}

interface Interview {
  readonly state: InterviewState | null
  readonly unreachable: boolean
  /** The round on screen: the one the person picked, else the open one, else the latest. */
  readonly target: number | null
  readonly loaded: Loaded | null
  readonly open: (round: number) => void
  readonly refresh: () => Promise<void>
}

function useInterview(client: InterviewClient, pollMs: number): Interview {
  const [state, setState] = useState<InterviewState | null>(null)
  const [unreachable, setUnreachable] = useState(false)
  // The round the person went back to, and which round was open when they
  // did: a *new* round opening afterwards is what they are waiting for.
  const [pinned, setPinned] = useState<{ readonly round: number; readonly since: number | null } | null>(null)
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  const refresh = useCallback(async () => {
    try {
      setState(await client.state())
      setUnreachable(false)
    } catch {
      setUnreachable(true)
    }
  }, [client])

  useEffect(() => {
    let stopped = false
    const tick = async (): Promise<void> => {
      try {
        const next = await client.state()
        if (stopped) return
        setState(next)
        setUnreachable(false)
      } catch {
        if (!stopped) setUnreachable(true)
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), pollMs)
    const unsubscribe = client.events?.((next) => {
      if (stopped) return
      setState(next)
      setUnreachable(false)
    })
    return () => {
      stopped = true
      clearInterval(timer)
      unsubscribe?.()
    }
  }, [client, pollMs])

  // A round the person went back to stays on screen until the agent opens a
  // new one — then the new one is what they are waiting for.
  const current = state?.current ?? null
  useEffect(() => {
    if (pinned === null || current === null || current === pinned.since || current === pinned.round) return
    setPinned(null)
  }, [current, pinned])

  const open = useCallback((round: number) => setPinned({ round, since: current }), [current])
  const target = pinned?.round ?? current ?? state?.latest ?? null
  const summary = state?.rounds.find((round) => round.round === target)
  // The round is re-read when it changes hands — answered, or fixed by the
  // agent — not on every poll.
  const stamp = target === null ? '' : `${target}:${summary?.answered ?? false}:${summary?.error ?? ''}`

  useEffect(() => {
    if (target === null) {
      setLoaded(null)
      return
    }
    let stopped = false
    void (async () => {
      let round: InterviewRound | null = null
      let error: Loaded['error'] = null
      let submitted: InterviewAnswers | null = null
      try {
        round = await client.round(target)
      } catch (failure) {
        error =
          failure instanceof InterviewRefused && (failure.code === 'invalid_json' || failure.code === 'invalid_round')
            ? failure.code
            : 'unreachable'
      }
      if (round !== null && summary?.answered === true) {
        try {
          submitted = await client.answers(target)
        } catch {
          submitted = null
        }
      }
      if (!stopped) setLoaded({ roundNo: target, round, error, submitted })
    })()
    return () => {
      stopped = true
    }
    // `stamp` is the dependency on purpose: it names everything that should reload the round.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, stamp])

  return { state, unreachable, target, loaded, open, refresh }
}

// ---------------------------------------------------------------------------
// One round
// ---------------------------------------------------------------------------

function loadDraft(key: string): Draft {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return EMPTY_DRAFT
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'answers' in parsed &&
      'questions' in parsed &&
      'general_note' in parsed
    ) {
      return parsed as Draft
    }
  } catch {
    // A browser that refuses storage, or a draft from another version.
  }
  return EMPTY_DRAFT
}

function saveDraft(key: string, draft: Draft): void {
  try {
    localStorage.setItem(key, JSON.stringify(draft))
  } catch {
    // Storage refused; the draft lives in memory for this tab.
  }
}

function clearDraft(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // Nothing to clear.
  }
}

function RoundForm({
  client,
  round,
  submitted,
  state,
  onSubmitted,
  onOpen,
}: {
  readonly client: InterviewClient
  readonly round: InterviewRound
  readonly submitted: InterviewAnswers | null
  readonly state: InterviewState
  readonly onSubmitted: () => Promise<void>
  readonly onOpen: (round: number) => void
}) {
  const placed = useMemo(() => flatten(round), [round])
  const readOnly = submitted !== null
  const key = draftKey(round.interview.slug, round.round)
  const [draft, setDraft] = useState<Draft>(() => (submitted === null ? loadDraft(key) : fromAnswers(submitted)))
  const [index, setIndex] = useState(() => (readOnly ? 0 : firstOpen(placed, draft)))
  const [showMissing, setShowMissing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const paneRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!readOnly) saveDraft(key, draft)
  }, [draft, key, readOnly])

  // Each decision starts at its top. Properties rather than `scrollTo`, which
  // jsdom does not implement.
  useEffect(() => {
    if (paneRef.current !== null) paneRef.current.scrollTop = 0
    document.documentElement.scrollTop = 0
  }, [index])

  const current = placed[index] ?? placed[0]
  const open = missing(placed, draft)
  const done = placed.filter(({ decision }) => isDone(decision, answerOf(draft, decision))).length
  const last = index >= placed.length - 1

  const go = useCallback(
    (to: number) => setIndex(Math.max(0, Math.min(placed.length - 1, to))),
    [placed.length],
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!event.altKey) return
      if (event.key === 'ArrowRight') go(index + 1)
      if (event.key === 'ArrowLeft') go(index - 1)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [go, index])

  const update = (decision: Decision, change: (answer: DraftAnswer) => DraftAnswer): void => {
    if (readOnly) return
    setDraft((before) => ({
      ...before,
      answers: { ...before.answers, [decision.id]: change(answerOf(before, decision)) },
    }))
  }

  const ask = (decisionId: string | null, body: string): void => {
    const text = body.trim()
    if (text === '' || readOnly) return
    setDraft((before) => ({
      ...before,
      questions: [...before.questions, { id: questionId(), decision_id: decisionId, body: text }],
    }))
  }

  const unask = (id: string): void => {
    if (readOnly) return
    setDraft((before) => ({ ...before, questions: before.questions.filter((q) => q.id !== id) }))
  }

  async function submit(): Promise<void> {
    if (open.length > 0) {
      setShowMissing(true)
      setIndex(open[0]?.index ?? 0)
      setFailure('Answer or skip the highlighted decisions first.')
      return
    }
    setBusy(true)
    setFailure(null)
    try {
      await client.submit(round.round, toAnswers(round, placed, draft))
      clearDraft(key)
      await onSubmitted()
    } catch (error) {
      setFailure(
        error instanceof InterviewRefused
          ? (REFUSALS[error.code] ?? `The server refused the submission (${error.code}).`)
          : 'The submission did not reach the server. Check that it is still running and try again.',
      )
    } finally {
      setBusy(false)
    }
  }

  if (current === undefined) {
    return (
      <Centered>
        <EmptyTitle>Nothing to decide in this round</EmptyTitle>
        <EmptyDescription>The agent wrote a round with no decisions. Ask it to add some.</EmptyDescription>
      </Centered>
    )
  }

  const decisionIds = new Set(placed.map(({ decision }) => decision.id))
  const replies = round.replies ?? []
  const generalReplies = replies.filter((reply) => reply.decision_id === undefined || !decisionIds.has(reply.decision_id))

  return (
    <div
      className="flex min-h-[calc(100vh-3rem)] flex-col"
      data-round={round.round}
      data-readonly={readOnly ? '' : undefined}
    >
      <div className="grid flex-1 lg:grid-cols-[260px_minmax(0,1fr)_340px]">
        <Rail
          placed={placed}
          draft={draft}
          index={index}
          done={done}
          missing={showMissing ? open : []}
          onGo={go}
        />
        <section ref={paneRef} className="min-w-0 px-5 py-6 lg:px-10" data-decision={current.decision.id}>
          <VStack gap={5} className="mx-auto max-w-3xl">
            {readOnly && (
              <Alert data-submitted>
                <InfoIcon />
                <AlertTitle>
                  This round was submitted
                  {submitted?.submitted_at === undefined ? '' : ` on ${new Date(submitted.submitted_at).toLocaleString()}`}
                </AlertTitle>
                <AlertDescription>
                  Answers are read-only here; the agent reads them from the answers file.
                </AlertDescription>
              </Alert>
            )}
            {index === 0 && round.intro !== undefined && (
              <Section title="From the agent" data-intro>
                <Prose text={round.intro} />
              </Section>
            )}
            {index === 0 && round.kind === 'readback' && round.summary !== undefined && (
              <Section title="Read-back of what was decided" data-summary>
                <Prose text={round.summary} className="plan-prose" />
              </Section>
            )}
            <DecisionView
              client={client}
              placed={current}
              total={placed.length}
              answer={answerOf(draft, current.decision)}
              replies={replies.filter((reply) => reply.decision_id === current.decision.id)}
              readOnly={readOnly}
              onChange={(change) => update(current.decision, change)}
            />
          </VStack>
        </section>
        <SidePanel
          placed={current}
          draft={draft}
          generalReplies={generalReplies}
          readOnly={readOnly}
          onAsk={ask}
          onUnask={unask}
          onGeneralNote={(general_note) => {
            if (!readOnly) setDraft((before) => ({ ...before, general_note }))
          }}
        />
      </div>
      <footer className="sticky bottom-0 z-30 border-t bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <HStack gap={2} wrap className="px-5 py-3">
          <Button type="button" variant="outline" size="sm" disabled={index === 0} onClick={() => go(index - 1)} data-action="prev">
            <ChevronLeftIcon /> Back
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={last} onClick={() => go(index + 1)} data-action="next">
            Next decision <ChevronRightIcon />
          </Button>
          <div className="min-w-0 flex-1 text-sm text-muted-foreground" data-status>
            {failure !== null ? (
              <ErrorNote>{failure}</ErrorNote>
            ) : readOnly ? (
              state.current !== null && state.current !== round.round ? (
                `Round ${state.current} is open.`
              ) : (
                'Waiting for the agent to prepare the next round…'
              )
            ) : busy ? (
              'Submitting…'
            ) : open.length > 0 ? (
              `${open.length} decision${open.length === 1 ? '' : 's'} still open`
            ) : (
              'All decisions answered. Submit when ready.'
            )}
          </div>
          {readOnly ? (
            state.current !== null &&
            state.current !== round.round && (
              <Button type="button" size="sm" onClick={() => onOpen(state.current as number)} data-action="open-current">
                Open round {state.current}
              </Button>
            )
          ) : (
            <Button type="button" size="sm" disabled={busy} onClick={() => void submit()} data-action="submit">
              Submit round {round.round}
            </Button>
          )}
        </HStack>
      </footer>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The rail
// ---------------------------------------------------------------------------

type RailState = 'done' | 'waived' | 'open' | 'missing'

function Rail({
  placed,
  draft,
  index,
  done,
  missing: missed,
  onGo,
}: {
  readonly placed: readonly Placed[]
  readonly draft: Draft
  readonly index: number
  readonly done: number
  readonly missing: readonly Placed[]
  readonly onGo: (index: number) => void
}) {
  const missingIds = new Set(missed.map(({ decision }) => decision.id))
  const groups = new Map<string, Placed[]>()
  for (const item of placed) {
    const list = groups.get(item.group.id) ?? []
    list.push(item)
    groups.set(item.group.id, list)
  }
  return (
    <nav
      aria-label="Decisions"
      className="border-b bg-card/40 px-3 py-4 lg:sticky lg:top-12 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto lg:border-r lg:border-b-0"
      data-rail
    >
      <VStack gap={1} className="px-2 pb-3">
        <HStack justify="between" className="text-xs text-muted-foreground">
          <span>Progress</span>
          <span className="font-mono" data-progress>
            {done} / {placed.length}
          </span>
        </HStack>
        <Progress value={placed.length === 0 ? 0 : Math.round((done / placed.length) * 100)} className="h-1.5" />
      </VStack>
      <VStack gap={4}>
        {[...groups.values()].map((items) => {
          const group = items[0]?.group
          if (group === undefined) return null
          return (
            <VStack key={group.id} gap={1} data-group={group.id}>
              <div className="px-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{group.title}</div>
              {items.map((item) => {
                const answer = answerOf(draft, item.decision)
                const state: RailState = missingIds.has(item.decision.id)
                  ? 'missing'
                  : answer.status === 'waived'
                    ? 'waived'
                    : isDone(item.decision, answer)
                      ? 'done'
                      : 'open'
                const active = item.index === index
                return (
                  <button
                    key={item.decision.id}
                    type="button"
                    data-decision-link={item.decision.id}
                    data-state={state}
                    aria-current={active ? 'step' : undefined}
                    onClick={() => onGo(item.index)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                      active
                        ? 'bg-accent font-medium text-accent-foreground'
                        : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                      state === 'missing' && 'text-tone-error-foreground',
                    )}
                  >
                    <RailMark state={state} />
                    <span className="truncate">{item.decision.short ?? item.decision.title}</span>
                  </button>
                )
              })}
            </VStack>
          )
        })}
      </VStack>
    </nav>
  )
}

function RailMark({ state }: { readonly state: RailState }) {
  const className = 'size-3.5 shrink-0'
  switch (state) {
    case 'done':
      return <CheckIcon aria-label="answered" className={cn(className, 'text-tone-ok')} />
    case 'waived':
      return <MinusIcon aria-label="not applicable" className={cn(className, 'text-muted-foreground')} />
    case 'missing':
      return <AlertCircleIcon aria-label="still open" className={cn(className, 'text-tone-error')} />
    case 'open':
      return <CircleIcon aria-label="open" className={cn(className, 'opacity-40')} />
  }
}

// ---------------------------------------------------------------------------
// One decision
// ---------------------------------------------------------------------------

function Section({
  title,
  children,
  className,
  ...props
}: {
  readonly title: ReactNode
  readonly children: ReactNode
  readonly className?: string
  readonly [attribute: `data-${string}`]: string | undefined
}) {
  return (
    <Card className={cn('gap-3 py-4', className)} {...props}>
      <CardHeader className="px-5">
        <CardTitle className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-5">{children}</CardContent>
    </Card>
  )
}

function DecisionView({
  client,
  placed,
  total,
  answer,
  replies,
  readOnly,
  onChange,
}: {
  readonly client: InterviewClient
  readonly placed: Placed
  readonly total: number
  readonly answer: DraftAnswer
  readonly replies: readonly Reply[]
  readonly readOnly: boolean
  readonly onChange: (change: (answer: DraftAnswer) => DraftAnswer) => void
}) {
  const { decision, group } = placed
  const waived = answer.status === 'waived'
  const disabled = readOnly || waived
  const options = decision.input.options ?? []

  return (
    <>
      <VStack gap={2}>
        <PageHeaderMeta>
          <span>{group.title}</span>
          <span>
            Decision {placed.inGroup + 1} of {group.decisions.length}
          </span>
          <span>
            {placed.index + 1} of {total}
          </span>
        </PageHeaderMeta>
        <h1 className="text-2xl font-semibold tracking-tight">{decision.title}</h1>
        {decision.why !== undefined && <Hint data-why>Why this matters: {decision.why}</Hint>}
      </VStack>

      {decision.context !== undefined && (
        <Section title="What we know so far" className="border-l-2 border-l-primary" data-context>
          <Prose text={decision.context} />
        </Section>
      )}

      {decision.explainer !== undefined && (
        <Section title={explainerTitle(decision.explainer) ?? 'Explainer'} data-explainer>
          <ExplainerView explainer={decision.explainer} client={client} />
        </Section>
      )}

      {replies.length > 0 && (
        <Section title="Agent replies to your questions" data-replies>
          <VStack gap={3}>
            {replies.map((reply, at) => (
              <ReplyView key={at} reply={reply} />
            ))}
          </VStack>
        </Section>
      )}

      {decision.input.type === 'text' ? (
        <VStack gap={2}>
          <Label htmlFor={`text-${decision.id}`}>{decision.input.label ?? 'Your answer'}</Label>
          <Textarea
            id={`text-${decision.id}`}
            data-field="text"
            rows={5}
            disabled={disabled}
            placeholder={decision.input.placeholder}
            value={answer.text}
            onChange={(event) => onChange((before) => ({ ...before, status: 'answered', text: event.target.value }))}
          />
        </VStack>
      ) : (
        <div
          role={decision.input.type === 'multi' ? 'group' : 'radiogroup'}
          aria-label={decision.title}
          className={cn('grid gap-3 sm:grid-cols-2', waived && 'opacity-50')}
          data-options
        >
          {options.map((option) => (
            <OptionCard
              key={option.value}
              option={option}
              multi={decision.input.type === 'multi'}
              selected={answer.values.includes(option.value)}
              disabled={disabled}
              client={client}
              onPick={() => onChange((before) => pick(decision, before, option.value))}
            />
          ))}
          {offersOther(decision) && (
            <OtherCard
              label={decision.input.other_label ?? 'Something else'}
              placeholder={decision.input.other_placeholder ?? 'Describe it'}
              multi={decision.input.type === 'multi'}
              value={answer.other}
              selected={answer.other.trim() !== ''}
              disabled={disabled}
              onChange={(other) => onChange((before) => typeOther(decision, before, other))}
            />
          )}
        </div>
      )}

      {decision.waivable && (
        <HStack gap={2}>
          <Checkbox
            id={`waive-${decision.id}`}
            data-field="waive"
            checked={waived}
            disabled={readOnly}
            onCheckedChange={(checked) => onChange((before) => waive(decision, before, checked === true))}
          />
          <Label htmlFor={`waive-${decision.id}`} className="font-normal">
            {decision.waive_label ?? WAIVE_LABEL}
          </Label>
        </HStack>
      )}

      <VStack gap={2}>
        <Label htmlFor={`note-${decision.id}`} className="text-muted-foreground">
          Note for the agent about this decision (optional)
        </Label>
        <Textarea
          id={`note-${decision.id}`}
          data-field="note"
          rows={2}
          disabled={readOnly}
          placeholder="Nuance the options don't capture, a condition, a caveat…"
          value={answer.note}
          onChange={(event) => onChange((before) => ({ ...before, note: event.target.value }))}
        />
      </VStack>
    </>
  )
}

function ReplyView({ reply }: { readonly reply: Reply }) {
  return (
    <VStack gap={2} data-reply>
      <blockquote className="border-l-2 border-l-tone-attention pl-3 text-sm">
        <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          You asked{reply.decision_id === undefined ? '' : ` about ${reply.decision_id}`}
        </div>
        {reply.question}
      </blockquote>
      <div>
        <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Agent</div>
        <Prose text={reply.answer} />
      </div>
    </VStack>
  )
}

function OptionCard({
  option,
  multi,
  selected,
  disabled,
  client,
  onPick,
}: {
  readonly option: Option
  readonly multi: boolean
  readonly selected: boolean
  readonly disabled: boolean
  readonly client: InterviewClient
  readonly onPick: () => void
}) {
  const [details, setDetails] = useState(false)
  return (
    <div className="flex flex-col gap-2" data-option={option.value} data-selected={selected ? '' : undefined}>
      <button
        type="button"
        role={multi ? 'checkbox' : 'radio'}
        aria-checked={selected}
        disabled={disabled}
        onClick={onPick}
        className={cn(
          'flex h-full flex-col gap-2 rounded-xl border bg-card p-4 text-left shadow-xs transition-[color,box-shadow,border-color] outline-none',
          'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default',
          selected ? 'border-primary ring-[3px] ring-ring/30' : 'hover:border-ring/60',
          option.recommended === true && !selected && 'border-primary/40',
        )}
      >
        <HStack gap={2} align="start">
          <span
            aria-hidden="true"
            className={cn(
              'mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border',
              multi && 'rounded-[4px]',
              selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
            )}
          >
            {selected && <CheckIcon className="size-3" />}
          </span>
          <span className="font-medium leading-snug">{option.label}</span>
          {option.recommended === true && (
            <Badge variant="active" className="ml-auto" data-recommended>
              Recommended
            </Badge>
          )}
        </HStack>
        {option.description !== undefined && <p className="text-sm text-muted-foreground">{option.description}</p>}
        {option.consequences !== undefined && (
          <p className="text-sm" data-consequences>
            <span className="font-medium">If you pick this: </span>
            {option.consequences}
          </p>
        )}
        {option.tags !== undefined && option.tags.length > 0 && (
          <HStack gap={1} wrap>
            {option.tags.map((tag, at) => {
              const label = typeof tag === 'string' ? tag : tag.label
              const tone = typeof tag === 'string' ? 'neutral' : (tag.tone ?? 'neutral')
              return (
                <Badge key={at} variant={TAG_TONE[tone]}>
                  {label}
                </Badge>
              )
            })}
          </HStack>
        )}
      </button>
      {option.explainer !== undefined && (
        <>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="self-start"
            aria-expanded={details}
            onClick={() => setDetails((before) => !before)}
            data-action="details"
          >
            {details ? 'Hide details' : 'Show details'}
          </Button>
          {details && (
            <div className="rounded-lg border bg-card p-3" data-option-explainer>
              <ExplainerView explainer={option.explainer} client={client} />
            </div>
          )}
        </>
      )}
    </div>
  )
}

function OtherCard({
  label,
  placeholder,
  multi,
  value,
  selected,
  disabled,
  onChange,
}: {
  readonly label: string
  readonly placeholder: string
  readonly multi: boolean
  readonly value: string
  readonly selected: boolean
  readonly disabled: boolean
  readonly onChange: (other: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-xl border bg-card p-4 shadow-xs transition-[border-color,box-shadow]',
        selected ? 'border-primary ring-[3px] ring-ring/30' : 'hover:border-ring/60',
      )}
      data-option="__other"
      data-selected={selected ? '' : undefined}
    >
      <button
        type="button"
        role={multi ? 'checkbox' : 'radio'}
        aria-checked={selected}
        disabled={disabled}
        className="flex items-center gap-2 text-left outline-none"
        onClick={() => inputRef.current?.focus()}
      >
        <span
          aria-hidden="true"
          className={cn(
            'grid size-4 shrink-0 place-items-center rounded-full border',
            multi && 'rounded-[4px]',
            selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
          )}
        >
          {selected && <CheckIcon className="size-3" />}
        </span>
        <span className="font-medium leading-snug">{label}</span>
      </button>
      <Input
        ref={inputRef}
        data-field="other"
        disabled={disabled}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Explainers
// ---------------------------------------------------------------------------

function explainerTitle(explainer: Explainer): string | undefined {
  return typeof explainer === 'string' ? undefined : explainer.title
}

/** Markdown documents already fetched, by path. A round re-renders often; a document does not change. */
const documents = new Map<string, Promise<string>>()

function ExplainerView({ explainer, client }: { readonly explainer: Explainer; readonly client: InterviewClient }) {
  if (typeof explainer === 'string') return <Prose text={explainer} className="plan-prose" />
  if ('markdown' in explainer) return <Prose text={explainer.markdown} className="plan-prose" />
  if (/\.html?$/i.test(explainer.path)) {
    return (
      <iframe
        title={explainer.title ?? 'Explainer'}
        // No same-origin: the document cannot read this page or its token.
        sandbox="allow-scripts allow-popups"
        src={client.docUrl(explainer.path)}
        className="min-h-[480px] w-full rounded-lg border bg-white"
        data-doc={explainer.path}
      />
    )
  }
  return <DocumentProse path={explainer.path} client={client} />
}

function DocumentProse({ path, client }: { readonly path: string; readonly client: InterviewClient }) {
  const [text, setText] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    let stopped = false
    setText(null)
    setFailed(null)
    let pending = documents.get(path)
    if (pending === undefined) {
      pending = client.doc(path)
      documents.set(path, pending)
    }
    pending
      .then((loaded) => {
        if (!stopped) setText(loaded)
      })
      .catch((error: unknown) => {
        documents.delete(path)
        if (!stopped) setFailed(error instanceof InterviewRefused ? error.code : 'unreachable')
      })
    return () => {
      stopped = true
    }
  }, [client, path])

  if (failed !== null) {
    return (
      <ErrorNote data-doc={path}>
        {failed === 'unknown_doc'
          ? 'The document this decision refers to is missing. Ask the agent to write it.'
          : failed === 'forbidden'
            ? 'The document this decision refers to is outside the interview; the server refused it.'
            : 'The document could not be loaded.'}
      </ErrorNote>
    )
  }
  if (text === null) return <Skeleton className="h-24 w-full" data-doc={path} />
  return <Prose text={text} className="plan-prose" data-doc={path} />
}

// ---------------------------------------------------------------------------
// The question panel
// ---------------------------------------------------------------------------

function SidePanel({
  placed,
  draft,
  generalReplies,
  readOnly,
  onAsk,
  onUnask,
  onGeneralNote,
}: {
  readonly placed: Placed
  readonly draft: Draft
  readonly generalReplies: readonly Reply[]
  readonly readOnly: boolean
  readonly onAsk: (decisionId: string | null, body: string) => void
  readonly onUnask: (id: string) => void
  readonly onGeneralNote: (note: string) => void
}) {
  const { decision } = placed
  const mine = draft.questions.filter((question) => question.decision_id === decision.id)
  const general = draft.questions.filter((question) => question.decision_id === null || question.decision_id === undefined)

  return (
    <aside
      className="border-t px-5 py-6 lg:sticky lg:top-12 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto lg:border-t-0 lg:border-l"
      aria-label="Questions for the agent"
      data-side
    >
      <VStack gap={6}>
        <VStack gap={1}>
          <h2 className="text-sm font-semibold">Questions for the agent</h2>
          <Hint>
            Decisions go in the form. Use this to ask what you need to decide well; the agent answers in the
            next round.
          </Hint>
        </VStack>

        <QuestionList
          heading={`About “${decision.short ?? decision.title}”`}
          questions={mine}
          placeholder="Ask about this decision…"
          readOnly={readOnly}
          field="question"
          onAsk={(body) => onAsk(decision.id, body)}
          onUnask={onUnask}
        />

        <VStack gap={3}>
          {generalReplies.map((reply, at) => (
            <ReplyView key={at} reply={reply} />
          ))}
          <QuestionList
            heading="General"
            questions={general}
            placeholder="Anything else the agent should know or answer…"
            readOnly={readOnly}
            field="general-question"
            onAsk={(body) => onAsk(null, body)}
            onUnask={onUnask}
          />
        </VStack>

        <VStack gap={2}>
          <Label htmlFor="general-note" className="text-muted-foreground">
            Note for the whole round (optional)
          </Label>
          <Textarea
            id="general-note"
            data-field="general-note"
            rows={3}
            disabled={readOnly}
            placeholder="Context the agent should carry into the artefact"
            value={draft.general_note}
            onChange={(event) => onGeneralNote(event.target.value)}
          />
        </VStack>
      </VStack>
    </aside>
  )
}

function QuestionList({
  heading,
  questions,
  placeholder,
  readOnly,
  field,
  onAsk,
  onUnask,
}: {
  readonly heading: string
  readonly questions: readonly Draft['questions'][number][]
  readonly placeholder: string
  readonly readOnly: boolean
  readonly field: string
  readonly onAsk: (body: string) => void
  readonly onUnask: (id: string) => void
}) {
  const [text, setText] = useState('')
  const add = (): void => {
    if (text.trim() === '') return
    onAsk(text)
    setText('')
  }
  return (
    <VStack gap={2} data-questions={field}>
      <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{heading}</div>
      {questions.length === 0 && readOnly && <EmptyNote>No questions.</EmptyNote>}
      {questions.map((question) => (
        <HStack key={question.id} gap={2} align="start" className="rounded-md border bg-card px-3 py-2 text-sm" data-question={question.id}>
          <span className="min-w-0 flex-1 whitespace-pre-wrap">{question.body}</span>
          {!readOnly && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Remove this question"
              onClick={() => onUnask(question.id)}
              data-action="unask"
            >
              <XIcon />
            </Button>
          )}
        </HStack>
      ))}
      {!readOnly && (
        <>
          <Textarea
            data-field={field}
            rows={2}
            placeholder={placeholder}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                add()
              }
            }}
          />
          <Button type="button" variant="outline" size="sm" className="self-start" onClick={add} data-action={`ask-${field}`}>
            Add question
          </Button>
        </>
      )}
    </VStack>
  )
}
