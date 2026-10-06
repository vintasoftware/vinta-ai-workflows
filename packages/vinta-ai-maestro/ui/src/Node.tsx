/**
 * The node view (§10): the transcript, the gate logs, what the phase changed,
 * the message composer, the pending question, and the five operations of §9.
 *
 * What makes this screen different from the run view is that it is the only
 * one that *writes*. Three rules follow from that.
 *
 * - **Capabilities are declared, so the screen tells the truth about them.**
 *   §7's whole reason for a capability block is that the UI greys out what a
 *   harness cannot do instead of failing when the operator tries. A message
 *   typed at a harness that cannot inject is not lost — the scheduler queues
 *   it — but saying "sent" would be a lie, so the box says what will actually
 *   happen before it is pressed. They come off the run snapshot, read from
 *   the adapters themselves — this view used to consult a hand-copy of the
 *   three adapters' blocks, which could drift from them silently and make
 *   every sentence below a confident falsehood. A harness the daemon does not
 *   ship declares nothing, and this view assumes nothing.
 * - **Nothing is optimistic.** An operation posts, and then the detail is
 *   re-read. The daemon's journal is what decides whether a message reached a
 *   session, and this view renders that answer rather than predicting it.
 * - **Reads are refreshed from two clocks.** Every frame on the run's stream
 *   means something moved, and a slow tick covers transcript growth, which
 *   journals no event of its own.
 *
 * PTY takeover — §9's fifth verb — is a button where `capabilities.pty` is
 * true and a stated limitation in the steering guide where it is false. An
 * action the harness cannot perform does not belong on a control, the same
 * rule `Runs.tsx` set. The capability is read off the wire, never assumed.
 *
 * The page is two columns above a large window: what the operator *does* on
 * the left — the question, then the transcript with the message composer
 * inside its panel the way a chat seats its input under the conversation,
 * then the terminal — and what they *check* on the right — the changes, the
 * gates, the sessions. On a narrow window the columns stack in that order.
 * The node's lifecycle controls sit in the header beside its status; see
 * `Steering.tsx` for why messages and controls were split.
 *
 * The right-hand column stays short on purpose: each of its panels shows a
 * bounded headline, and the long reads behind them — a gate's log, the whole
 * session history — open in dialogs rather than inline.
 */
import { ChevronLeftIcon, ScrollTextIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  HStack,
  PageHeader,
  PageHeaderActions,
  PageHeaderHeading,
  PageHeaderMeta,
  PageHeaderTitle,
} from 'vinta-design-system/layout'
import { Button } from 'vinta-design-system/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from 'vinta-design-system/ui/card'
import { Textarea } from 'vinta-design-system/ui/textarea'
import type { NodeDetail } from '../../src/daemon/schemas.ts'
import type { AgentAnswer } from '../../src/questions/shape.ts'
import { AgentQuestions } from './AgentQuestions.tsx'
import { Changes } from './Changes.tsx'
import { Chip } from './Chip.tsx'
import type { Client, NodeOperation, OperationBody } from './client.ts'
import { Gates } from './Gates.tsx'
import { Live } from './Live.tsx'
import { EmptyNote, ErrorNote, Hint } from './Panel.tsx'
import { Sessions } from './Sessions.tsx'
import { nodeLabel, nodeTone } from './status.ts'
import { capabilitiesOf, Composer, NodeControls, SteeringGuide } from './Steering.tsx'
import { TerminalView } from './Terminal.tsx'
import { useNow } from './time.ts'
import { Transcript } from './Transcript.tsx'
import { useRun } from './useRun.ts'

/** Covers transcript growth, which journals no event to ride in on. */
const REFRESH_MS = 2000

type Question = NonNullable<NodeDetail['question']>

type Answer = OperationBody<'answer'>['answer']

export function NodeView({
  client,
  runId,
  nodeId,
}: {
  readonly client: Client
  readonly runId: string
  readonly nodeId: string
}) {
  const { projection, snapshot, connected, pty } = useRun(client, runId)
  const tick = useNow(REFRESH_MS)
  const [detail, setDetail] = useState<NodeDetail | null>(null)
  const [reloads, setReloads] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [takingOver, setTakingOver] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  // Which gate's log is open. Here and not in the panel, because the question
  // card opens the gate it is asking about too.
  const [gateLog, setGateLog] = useState<string | null>(null)
  const cursor = projection.cursor

  useEffect(() => {
    let stopped = false
    client.node(runId, nodeId).then(
      (next) => {
        if (stopped) return
        setDetail(next)
        setError(null)
      },
      (cause: unknown) => {
        if (!stopped) setError(messageOf(cause))
      },
    )
    return () => {
      stopped = true
    }
  }, [client, runId, nodeId, cursor, tick, reloads])

  async function operate<K extends NodeOperation>(
    operation: K,
    body: OperationBody<K>,
    done: string,
  ): Promise<void> {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await client.operate(runId, nodeId, operation, body)
      setNotice(done)
      setReloads((count) => count + 1)
    } catch (cause: unknown) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  if (detail === null) {
    return (
      <section className="node">
        <EmptyNote>{error ?? 'Loading node…'}</EmptyNote>
      </section>
    )
  }

  // The stream is authoritative where it has spoken; the detail is the rest.
  const status = projection.statuses.get(nodeId) ?? detail.node.status
  const failingGate = detail.question?.context?.gateLogRef ?? null
  const runHref = `#/runs/${encodeURIComponent(runId)}`
  const harness = detail.node.harness
  const capabilities = capabilitiesOf(snapshot, harness)
  const openGuide = (): void => setGuideOpen(true)
  const onOperate = <K extends NodeOperation>(
    operation: K,
    body: OperationBody<K>,
    done: string,
  ): void => void operate(operation, body, done)

  return (
    <section className="node flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        {/* A fragment, so the token stays where the daemon put it (§10). */}
        <a
          href={runHref}
          className="inline-flex w-fit items-center gap-1 text-[13px] text-muted-foreground no-underline hover:text-foreground hover:no-underline"
        >
          <ChevronLeftIcon className="size-3.5" aria-hidden="true" />
          Back to run
        </a>
        <PageHeader className="run-head">
          <PageHeaderHeading>
            <PageHeaderTitle>{detail.node.name}</PageHeaderTitle>
            <PageHeaderMeta>
              <span>{detail.node.nodeId}</span>
              <span>wave {detail.node.wave}</span>
              <span>{detail.node.harness}</span>
              <span>{detail.node.lane ?? 'no lane'}</span>
            </PageHeaderMeta>
          </PageHeaderHeading>
          <PageHeaderActions className="run-meta">
            <Chip tone={nodeTone(status)}>{nodeLabel(status)}</Chip>
            <Live connected={connected} />
            <NodeControls
              capabilities={capabilities}
              status={status}
              busy={busy}
              takingOver={takingOver}
              onTakeOver={() => setTakingOver((open) => !open)}
              onOperate={onOperate}
              onHelp={openGuide}
            />
          </PageHeaderActions>
        </PageHeader>
      </div>

      {error !== null && <ErrorNote>{error}</ErrorNote>}
      {projection.waits.has(nodeId) && status === 'running' && (
        <Hint className="muted" data-waiting="integration_worktree">
          Waiting for the integration worktree
          {projection.waits.get(nodeId) === null ? '' : ` — held by ${projection.waits.get(nodeId)}`}.
          Nothing is running for this phase until it is free.
        </Hint>
      )}
      {notice !== null && (
        <Hint className="muted" data-notice>
          {notice}
        </Hint>
      )}

      {detail.question !== null && (
        <Pending
          question={detail.question}
          busy={busy}
          onOpenGate={detail.gates.some((gate) => gate.gateId === failingGate) ? setGateLog : null}
          onAnswer={(answer) => void operate('answer', { answer }, 'Answered. The node resumes.')}
          onAnswers={(answers) => void operate('answer', { answers }, 'Answered. The agent resumes.')}
        />
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-4">
          <Transcript
            entries={detail.transcript.entries}
            composer={
              <Composer
                harness={harness}
                capabilities={capabilities}
                status={status}
                busy={busy}
                onOperate={onOperate}
                onHelp={openGuide}
              />
            }
          />
          {takingOver && <TerminalView nodeId={nodeId} link={pty} />}
        </div>
        <div className="panels flex flex-col gap-4">
          <Changes client={client} runId={runId} nodeId={nodeId} ref={detail.diff} cursor={cursor} pullRequest={detail.pullRequest} />
          <Gates gates={detail.gates} failing={failingGate} open={gateLog} onOpen={setGateLog} />
          <Sessions
            sessions={detail.sessions}
            live={status === 'running' && !detail.gates.some((gate) => gate.status === 'running')}
          />
        </div>
      </div>

      <SteeringGuide
        open={guideOpen}
        onOpenChange={setGuideOpen}
        harness={harness}
        capabilities={capabilities}
        status={status}
      />
    </section>
  )
}

/**
 * §9.1's question, inline with its context. The context is references — a
 * branch, a gate id, a transcript position — because that is what the daemon
 * serves and what the rest of this page already renders.
 *
 * It is the one card on the page with a ring: it is the reason the operator
 * was called here, and it must read before anything else does.
 *
 * An agent's question (`kind: 'agent'`) renders as `AgentQuestions`: its
 * options as buttons and a free-text answer per question. When the daemon
 * could not find what the agent asked, the card still takes a typed answer,
 * which reaches the agent as free text.
 */
function Pending({
  question,
  busy,
  onOpenGate,
  onAnswer,
  onAnswers,
}: {
  readonly question: Question
  readonly busy: boolean
  /** Opens a gate's log; null when the gate it names has no log to open yet. */
  readonly onOpenGate: ((gateId: string) => void) | null
  readonly onAnswer: (answer: Answer) => void
  readonly onAnswers: (answers: AgentAnswer[]) => void
}) {
  const [text, setText] = useState('')
  const context = question.context

  return (
    <Card
      className="question gap-3 border-tone-attention py-4 ring-[3px] ring-tone-attention-soft"
      data-question
    >
      <CardHeader className="px-4">
        <CardTitle className="flex flex-wrap items-center gap-2.5 text-[15px] leading-snug">
          <Chip tone="attention">awaiting you</Chip>
          <span>{question.question}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-4">
        {context !== undefined && (
          <ul className="question-context flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {context.diffRef !== undefined && (
              <li data-context="diff">
                Diff <span className="font-mono">{context.diffRef}</span>
              </li>
            )}
            {context.gateLogRef !== undefined && (
              <li data-context="gate">
                {onOpenGate === null ? (
                  <>
                    Gate log <span className="font-mono">{context.gateLogRef}</span>
                  </>
                ) : (
                  <button
                    type="button"
                    data-action="open-gate-log"
                    className="inline-flex items-center gap-1 rounded-sm text-tone-attention-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    onClick={() => onOpenGate(context.gateLogRef!)}
                  >
                    <ScrollTextIcon aria-hidden="true" className="size-3.5" />
                    Read the <span className="font-mono">{context.gateLogRef}</span> gate log
                  </button>
                )}
              </li>
            )}
            {context.transcriptCursor !== undefined && (
              <li data-context="cursor">Paused at transcript entry {context.transcriptCursor}</li>
            )}
          </ul>
        )}

        {question.kind === 'confirm' && (
          <HStack gap={2} wrap className="controls">
            <Button
              type="button"
              size="sm"
              data-op="answer"
              data-answer="true"
              disabled={busy}
              onClick={() => onAnswer(true)}
            >
              Yes
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-op="answer"
              data-answer="false"
              disabled={busy}
              onClick={() => onAnswer(false)}
            >
              No
            </Button>
          </HStack>
        )}

        {question.kind === 'choice' && (
          <HStack gap={2} wrap className="controls">
            {(question.choices ?? []).map((choice) => (
              <Button
                key={choice}
                type="button"
                variant="outline"
                size="sm"
                data-op="answer"
                data-answer={choice}
                disabled={busy}
                onClick={() => onAnswer(choice)}
              >
                {choice}
              </Button>
            ))}
            {(question.choices ?? []).length === 0 && (
              <EmptyNote>This question offers no choices.</EmptyNote>
            )}
          </HStack>
        )}

        {question.kind === 'agent' && question.ask !== undefined && (
          <AgentQuestions ask={question.ask} busy={busy} onSubmit={onAnswers} />
        )}

        {(question.kind === 'text' || (question.kind === 'agent' && question.ask === undefined)) && (
          <>
            <Textarea
              aria-label="Answer"
              data-field="answer"
              rows={2}
              className="min-h-14"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            <HStack gap={2} wrap className="controls">
              <Button
                type="button"
                size="sm"
                data-op="answer"
                disabled={busy || text.trim() === ''}
                onClick={() =>
                  question.kind === 'agent' ? onAnswers([{ selected: [], text: text.trim() }]) : onAnswer(text)
                }
              >
                Answer
              </Button>
            </HStack>
          </>
        )}
      </CardContent>
    </Card>
  )
}

/** Errors from `client.ts` name an endpoint and a status; nothing else is relayed. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'the daemon could not be reached'
}
