/**
 * The node view (§10): the transcript, the gate logs, the diff ref, the
 * steering box, the pending question, and the five operations of §9.
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
 * the left — the question, the steering box, the terminal, the transcript it
 * steers — and what they *check* on the right — the diff, the gates, the
 * sessions. On a narrow window the columns stack in that order.
 */
import { ChevronLeftIcon, TerminalIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
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
import { Chip } from './Chip.tsx'
import type { Client, NodeOperation, OperationBody } from './client.ts'
import { Live } from './Live.tsx'
import { EmptyNote, ErrorNote, Hint, Panel } from './Panel.tsx'
import type { NodeStatus } from './projection.ts'
import { nodeLabel, nodeTone, type Tone } from './status.ts'
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
          onAnswer={(answer) => void operate('answer', { answer }, 'Answered. The node resumes.')}
        />
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-4">
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
          <Transcript entries={detail.transcript.entries} />
        </div>
        <div className="panels flex flex-col gap-4">
          <Diff diff={detail.diff} />
          <Gates gates={detail.gates} failing={failingGate} />
          <Sessions sessions={detail.sessions} />
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
  onAnswer,
}: {
  readonly question: Question
  readonly busy: boolean
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
                Gate log <span className="font-mono">{context.gateLogRef}</span>
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

/**
 * The diff, as a *reference*. The API serves branch, base and lane rather than
 * a rendering, because running git in a lane is the git unit's job (§10) — so
 * this panel names what to diff and where, and does not pretend to show it.
 */
function Diff({ diff }: { readonly diff: NodeDetail['diff'] }) {
  const complete = diff.branch !== null && diff.baseBranch !== null
  return (
    <Panel title="Diff" data-diff>
      <DescriptionList>
        <DescriptionTerm>branch</DescriptionTerm>
        <DescriptionDetails className="font-mono text-xs" data-diff-branch>
          {diff.branch ?? '—'}
        </DescriptionDetails>
        <DescriptionTerm>base</DescriptionTerm>
        <DescriptionDetails className="font-mono text-xs" data-diff-base>
          {diff.baseBranch ?? '—'}
        </DescriptionDetails>
        <DescriptionTerm>lane</DescriptionTerm>
        <DescriptionDetails className="font-mono text-xs" data-diff-lane>
          {diff.lane ?? '—'}
        </DescriptionDetails>
      </DescriptionList>
      {complete ? (
        // Wraps rather than overflowing: two long branch names are routinely
        // wider than this panel, and a command that runs off the edge of its
        // box is one nobody can copy without selecting blind.
        <pre className="m-0 whitespace-pre-wrap break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">
          git diff {diff.baseBranch}...{diff.branch}
        </pre>
      ) : (
        <Hint className="muted">This node has no branch yet.</Hint>
      )}
    </Panel>
  )
}

/**
 * Gate logs, tail-truncated by the daemon.
 *
 * A gate's *verdict* is not on the wire — `NodeDetailSchema` carries an id and
 * a log and no exit code — so the one gate this view can name as failing is
 * the one §9.1's question points at with `context.gateLogRef`. That is also
 * the case that matters: a node parked on a human gate because a gate failed.
 */
function Gates({
  gates,
  failing,
}: {
  readonly gates: NodeDetail['gates']
  readonly failing: string | null
}) {
  return (
    <Panel title="Gate logs" data-gates expandable>
      {gates.length === 0 ? (
        <EmptyNote>No gate has run yet.</EmptyNote>
      ) : (
        <ul className="gates flex flex-col gap-3">
          {gates.map((gate) => (
            <li key={gate.gateId} data-gate={gate.gateId} className="flex flex-col gap-1.5">
              <p className="entry-head flex items-center gap-2">
                <span className="font-mono text-[13px] font-medium">{gate.gateId}</span>
                {gate.gateId === failing && <Chip tone="error">failing</Chip>}
              </p>
              <pre
                className="gate-log m-0 max-h-[var(--panel-scroll,13rem)] overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs"
                data-gate-log={gate.gateId}
              >
                {gate.log}
              </pre>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

/**
 * §15's session reuse, as the operator sees it: one row per agent turn, saying
 * which slot it ran on and whether it continued that slot's session.
 *
 * The panel exists because reuse fails *quietly*. A run whose sessions stopped
 * being reused looks exactly like one that never reused — same statuses, same
 * transcripts, same result, just more tokens and a slower fix loop. The reason
 * token is the whole point of the row: without it "fresh" is an observation
 * nobody can act on.
 *
 * **Fresh is not a failure, and the colours say so.** Most cold turns are
 * correct — the first turn on a slot has nothing to continue, and the last fix
 * round is deliberately handed to an agent that has not seen the work (§15.5).
 * Only `stale_session` gets the waiting tone, because it is the one that cost
 * something nobody asked for: a spawn spent being told the session was gone.
 */
function Sessions({ sessions }: { readonly sessions: NodeDetail['sessions'] }) {
  const reused = sessions.filter((turn) => turn.disposition === 'reused').length

  return (
    <Panel
      title="Agent sessions"
      data-sessions
      description={
        sessions.length === 0 ? undefined : (
          <span data-session-summary>
            {reused} of {sessions.length} {sessions.length === 1 ? 'turn' : 'turns'} continued a
            session.
          </span>
        )
      }
    >
      {sessions.length === 0 ? (
        <EmptyNote>No agent turn has run yet.</EmptyNote>
      ) : (
        <ul className="sessions divide-y">
          {sessions.map((turn, index) => (
            // The index is the key because a slot legitimately repeats: `main`
            // is every implementer and fixer turn on this node, and the rows
            // are an append-only sequence that nothing reorders or removes.
            <li
              key={index}
              data-session-slot={turn.slot}
              className="flex flex-col gap-0.5 py-2 first:pt-0 last:pb-0"
            >
              <p className="entry-head flex items-center gap-2">
                <Chip tone={sessionTone(turn)}>{turn.disposition}</Chip>
                <span className="entry-author text-[13px] font-semibold">{turn.slot}</span>
                {turn.sessionId !== undefined && (
                  <span
                    className="muted font-mono text-xs text-muted-foreground"
                    title={turn.sessionId}
                  >
                    {shortId(turn.sessionId)}
                  </span>
                )}
              </p>
              {turn.reason !== undefined && (
                <p className="muted entry-body text-xs text-muted-foreground">
                  {sessionReason(turn.reason)}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

/** Reused is good news, cold is usually correct, and one case cost a spawn. */
function sessionTone(turn: NodeDetail['sessions'][number]): Tone {
  if (turn.disposition === 'reused') return 'ok'
  return turn.reason === 'stale_session' ? 'wait' : 'idle'
}

/**
 * The daemon's closed reason vocabulary, in words.
 *
 * An unrecognised token falls through to itself rather than to "unknown": a
 * browser served by a newer daemon should show the operator the thing it was
 * told, which is ugly and true, instead of hiding it behind wording this build
 * happens to know.
 */
function sessionReason(reason: string): string {
  switch (reason) {
    case 'no_prior_session':
      return 'First turn on this slot — there was nothing to continue.'
    case 'harness_changed':
      return 'The slot’s session belongs to a different harness.'
    case 'lane_changed':
      return 'The node is in a different lane than the session ran in.'
    case 'no_resume_capability':
      return 'This harness cannot continue a session.'
    case 'turn_ceiling':
      return 'The slot reached its turn limit, so the context starts over.'
    case 'final_fix_round':
      return 'Last fix round — deliberately an agent that has not seen the work.'
    case 'stale_session':
      return 'The harness had forgotten the session. The turn was retried cold.'
    case 'no_slot':
      return 'This step asked for a fresh session.'
    default:
      return reason
  }
}

/**
 * Enough of an id to tell two sessions apart; the full one is on hover.
 *
 * The **tail**, not the head. A session id is a vendor prefix followed by the
 * unique part — `claude-code-01J8ZQ4M7X2K` — so truncating from the left shows
 * the twelve characters every session on this harness shares and hides the only
 * ones that differ. An id is on this row to be compared, not read.
 */
function shortId(sessionId: string): string {
  return sessionId.length <= 14 ? sessionId : `…${sessionId.slice(-12)}`
}

/** Errors from `client.ts` name an endpoint and a status; nothing else is relayed. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'the daemon could not be reached'
}
