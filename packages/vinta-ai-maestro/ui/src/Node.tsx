/**
 * The node view (§10): the transcript, the gate logs, what the phase changed,
 * the steering box, the pending question, and the five operations of §9.
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
 * PTY takeover — §9's fifth verb — is now a button where `capabilities.pty` is
 * true and a stated limitation where it is false. That is the same rule as the
 * other four and the same rule `Runs.tsx` set: an action the harness cannot
 * perform does not belong on a control. The capability is read off the wire,
 * never assumed, so a harness that declares nothing gets the sentence rather
 * than the button.
 *
 * The page is two columns above a large window: what the operator *does* on
 * the left — the question, then the transcript with the steering box under
 * it the way a chat puts its composer under the conversation, then the
 * terminal — and what they *check* on the right — the changes, the gates,
 * the sessions. The right-hand column stays short on purpose: each of its
 * panels shows a bounded headline, and the long reads behind them — a gate's
 * log, the whole session history — open in dialogs rather than inline. On a narrow window the columns stack in that order.
 */
import { ChevronLeftIcon, ScrollTextIcon, TerminalIcon } from 'lucide-react'
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
import type { NodeDetail, RunSnapshot } from '../../src/daemon/schemas.ts'
import { Changes } from './Changes.tsx'
import { Chip } from './Chip.tsx'
import type { Client, NodeOperation, OperationBody } from './client.ts'
import { Gates } from './Gates.tsx'
import { Live } from './Live.tsx'
import { EmptyNote, ErrorNote, Hint, Panel } from './Panel.tsx'
import type { NodeStatus } from './projection.ts'
import { Sessions } from './Sessions.tsx'
import { nodeLabel, nodeTone } from './status.ts'
import { TerminalView } from './Terminal.tsx'
import { useNow } from './time.ts'
import { Transcript } from './Transcript.tsx'
import { useRun } from './useRun.ts'

/** Covers transcript growth, which journals no event to ride in on. */
const REFRESH_MS = 2000

type Capabilities = NonNullable<RunSnapshot['harnesses'][number]['capabilities']>
type Question = NonNullable<NodeDetail['question']>

/**
 * What an undeclared harness is assumed to be able to do: nothing it has not
 * claimed, except resume, which every adapter must support to be scheduled at
 * all. The cost of this assumption is a note saying "queued" about a message
 * that was in fact delivered live; the cost of the opposite is telling the
 * operator their steering landed in a turn that never received it.
 *
 * It is also what a snapshot that has not arrived yet reads as, which is the
 * conservative way round.
 */
const ASSUMED: Capabilities = {
  inject: false,
  interrupt: false,
  resume: true,
  pty: false,
  permissionControl: false,
  autoCompact: false,
}

/** §7's block for this node's harness, off the wire. Null when undeclared. */
function capabilitiesOf(snapshot: RunSnapshot | null, harness: string): Capabilities | null {
  return snapshot?.harnesses.find((state) => state.id === harness)?.capabilities ?? null
}
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
          </PageHeaderActions>
        </PageHeader>
      </div>

      {error !== null && <ErrorNote>{error}</ErrorNote>}
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
        />
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-4">
          <Transcript entries={detail.transcript.entries} />
          <Steering
            harness={detail.node.harness}
            capabilities={capabilitiesOf(snapshot, detail.node.harness)}
            status={status}
            busy={busy}
            takingOver={takingOver}
            onTakeOver={() => setTakingOver((open) => !open)}
            onOperate={(operation, body, done) => void operate(operation, body, done)}
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
 */
function Pending({
  question,
  busy,
  onOpenGate,
  onAnswer,
}: {
  readonly question: Question
  readonly busy: boolean
  /** Opens a gate's log; null when the gate it names has no log to open yet. */
  readonly onOpenGate: ((gateId: string) => void) | null
  readonly onAnswer: (answer: Answer) => void
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

        {question.kind === 'text' && (
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
                onClick={() => onAnswer(text)}
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

/**
 * The steering box and the four operations that take one (§9). What the note
 * says is decided by the harness's capabilities *and* the node's status,
 * because both decide it in the scheduler: a message is injected only into a
 * turn that is live, on an adapter that can be written to. Everything else is
 * queued for the next resume — which is fine, and is what the box says.
 */
function Steering({
  harness,
  capabilities,
  status,
  busy,
  takingOver,
  onTakeOver,
  onOperate,
}: {
  readonly harness: string
  /** The adapter's own declaration, or null for a harness that made none. */
  readonly capabilities: Capabilities | null
  readonly status: NodeStatus
  readonly busy: boolean
  readonly takingOver: boolean
  readonly onTakeOver: () => void
  readonly onOperate: <K extends NodeOperation>(
    operation: K,
    body: OperationBody<K>,
    done: string,
  ) => void
}) {
  const [text, setText] = useState('')
  const declared = capabilities ?? ASSUMED
  const settled = status === 'done' || status === 'failed'
  const empty = text.trim() === ''
  const send = <K extends NodeOperation>(operation: K, body: OperationBody<K>, done: string) => {
    onOperate(operation, body, done)
    setText('')
  }

  return (
    <Panel
      expandable
      title="Steering"
      className="steering"
      description={<span data-delivery>{delivery(harness, status, declared.inject)}</span>}
    >
      <Textarea
        aria-label="Message to the agent"
        data-field="steering"
        placeholder="Message to the agent…"
        rows={3}
        value={text}
        onChange={(event) => setText(event.target.value)}
        disabled={settled}
      />
      {!declared.interrupt && !settled && (
        <Hint className="muted" data-redirect-note>
          {harness} cannot interrupt a running turn, so a redirect also lands at the next resume.
        </Hint>
      )}
      <div className="controls flex flex-wrap items-center justify-between gap-2">
        <HStack gap={2} wrap>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-op="context"
            disabled={busy || settled || empty}
            onClick={() => send('context', { text }, 'Context accepted.')}
          >
            Add context
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-op="redirect"
            disabled={busy || settled || empty}
            onClick={() => send('redirect', { instruction: text }, 'Redirect accepted.')}
          >
            Redirect
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-op="pause"
            disabled={busy || status !== 'running'}
            onClick={() => onOperate('pause', {}, 'Pause requested after the current turn.')}
          >
            Pause
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-tone-error-foreground hover:bg-tone-error-soft hover:text-tone-error-foreground"
            data-op="abort"
            disabled={busy || settled}
            onClick={() => onOperate('abort', {}, 'Abort requested.')}
          >
            Abort node
          </Button>
          {/* Only for a phase that has stopped, because that is the only state
              it means anything in — and the only one where the operator is
              otherwise left with "re-run the whole plan". */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-op="retry"
            disabled={busy || status !== 'failed'}
            onClick={() => onOperate('retry', {}, 'Retrying this phase, and unblocking what it held up.')}
          >
            Retry phase
          </Button>
        </HStack>
        {declared.pty && (
          <Button
            type="button"
            variant={takingOver ? 'secondary' : 'outline'}
            size="sm"
            data-op="takeover"
            disabled={settled}
            onClick={onTakeOver}
          >
            <TerminalIcon />
            {takingOver ? 'Detach' : 'Take over'}
          </Button>
        )}
      </div>
      {declared.pty ? (
        <Hint className="muted" data-takeover>
          Take over interrupts the headless session, opens {harness} in a terminal on the same
          session, and resumes it headless when you detach.
        </Hint>
      ) : (
        <Hint className="muted" data-takeover>
          Take over: {harness} has no interactive takeover.
          {capabilities === null
            ? ' Capabilities for this harness are unknown and assumed absent.'
            : ''}
        </Hint>
      )}
    </Panel>
  )
}

function delivery(harness: string, status: NodeStatus, inject: boolean): string {
  if (status === 'done' || status === 'failed') {
    return 'This node has settled. Steering it now would be ignored.'
  }
  if (status !== 'running') {
    return 'This node is not in a turn: your message is queued and delivered on the next resume.'
  }
  return inject
    ? `Delivered straight into the running ${harness} session.`
    : `${harness} cannot join a running turn: your message is queued and delivered on the next resume.`
}

/** Errors from `client.ts` name an endpoint and a status; nothing else is relayed. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'the daemon could not be reached'
}
