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
 */
import { useEffect, useState } from 'react'
import type { NodeDetail, RunSnapshot } from '../../src/daemon/schemas.ts'
import { Chip } from './Chip.tsx'
import type { Client, NodeOperation, OperationBody } from './client.ts'
import type { NodeStatus } from './projection.ts'
import { nodeLabel, nodeTone } from './status.ts'
import { TerminalView } from './Terminal.tsx'
import { Transcript } from './Transcript.tsx'
import { useNow } from './time.ts'
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
        <p className="empty">{error ?? 'Loading node…'}</p>
      </section>
    )
  }

  // The stream is authoritative where it has spoken; the detail is the rest.
  const status = projection.statuses.get(nodeId) ?? detail.node.status
  const failingGate = detail.question?.context?.gateLogRef ?? null

  return (
    <section className="node">
      <header className="run-head">
        <div>
          <h2>{detail.node.name}</h2>
          <p className="muted">
            {detail.node.nodeId} · wave {detail.node.wave} · {detail.node.harness} ·{' '}
            {detail.node.lane ?? 'no lane'}
          </p>
        </div>
        <div className="run-meta">
          <Chip tone={nodeTone(status)}>{nodeLabel(status)}</Chip>
          <span className={connected ? 'live' : 'live off'}>
            {connected ? 'Live' : 'Reconnecting…'}
          </span>
          {/* A fragment, so the token stays where the daemon put it (§10). */}
          <a href={`#/runs/${encodeURIComponent(runId)}`}>Back to run</a>
        </div>
      </header>

      {error !== null && <p className="error">{error}</p>}
      {notice !== null && (
        <p className="muted" data-notice>
          {notice}
        </p>
      )}

      {detail.question !== null && (
        <Pending
          question={detail.question}
          busy={busy}
          onAnswer={(answer) => void operate('answer', { answer }, 'Answered. The node resumes.')}
        />
      )}

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

      <div className="panels">
        <Diff diff={detail.diff} />
        <Gates gates={detail.gates} failing={failingGate} />
      </div>

      <Transcript entries={detail.transcript.entries} />
    </section>
  )
}

/**
 * §9.1's question, inline with its context. The context is references — a
 * branch, a gate id, a transcript position — because that is what the daemon
 * serves and what the rest of this page already renders.
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
    <section className="panel question" data-question>
      <h3>
        <Chip tone="attention">awaiting you</Chip> {question.question}
      </h3>

      {context !== undefined && (
        <ul className="question-context">
          {context.diffRef !== undefined && (
            <li data-context="diff">Diff: {context.diffRef}</li>
          )}
          {context.gateLogRef !== undefined && (
            <li data-context="gate">Gate log: {context.gateLogRef}</li>
          )}
          {context.transcriptCursor !== undefined && (
            <li data-context="cursor">Paused at transcript entry {context.transcriptCursor}</li>
          )}
        </ul>
      )}

      {question.kind === 'confirm' && (
        <p className="controls">
          <button
            type="button"
            data-op="answer"
            data-answer="true"
            disabled={busy}
            onClick={() => onAnswer(true)}
          >
            Yes
          </button>
          <button
            type="button"
            data-op="answer"
            data-answer="false"
            disabled={busy}
            onClick={() => onAnswer(false)}
          >
            No
          </button>
        </p>
      )}

      {question.kind === 'choice' && (
        <p className="controls">
          {(question.choices ?? []).map((choice) => (
            <button
              key={choice}
              type="button"
              data-op="answer"
              data-answer={choice}
              disabled={busy}
              onClick={() => onAnswer(choice)}
            >
              {choice}
            </button>
          ))}
          {(question.choices ?? []).length === 0 && (
            <span className="empty">This question offers no choices.</span>
          )}
        </p>
      )}

      {question.kind === 'text' && (
        <>
          <textarea
            aria-label="Answer"
            data-field="answer"
            rows={2}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <p className="controls">
            <button
              type="button"
              data-op="answer"
              disabled={busy || text.trim() === ''}
              onClick={() => onAnswer(text)}
            >
              Answer
            </button>
          </p>
        </>
      )}
    </section>
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
    <section className="panel steering">
      <h3>Steering</h3>
      <textarea
        aria-label="Message to the agent"
        data-field="steering"
        rows={3}
        value={text}
        onChange={(event) => setText(event.target.value)}
        disabled={settled}
      />
      <p className="muted" data-delivery>
        {delivery(harness, status, declared.inject)}
      </p>
      {!declared.interrupt && !settled && (
        <p className="muted" data-redirect-note>
          {harness} cannot interrupt a running turn, so a redirect also lands at the next resume.
        </p>
      )}
      <p className="controls">
        <button
          type="button"
          data-op="context"
          disabled={busy || settled || empty}
          onClick={() => send('context', { text }, 'Context accepted.')}
        >
          Add context
        </button>
        <button
          type="button"
          data-op="redirect"
          disabled={busy || settled || empty}
          onClick={() => send('redirect', { instruction: text }, 'Redirect accepted.')}
        >
          Redirect
        </button>
        <button
          type="button"
          data-op="pause"
          disabled={busy || status !== 'running'}
          onClick={() => onOperate('pause', {}, 'Pause requested after the current turn.')}
        >
          Pause
        </button>
        <button
          type="button"
          data-op="abort"
          disabled={busy || settled}
          onClick={() => onOperate('abort', {}, 'Abort requested.')}
        >
          Abort node
        </button>
      </p>
      {declared.pty ? (
        <>
          <p className="controls">
            <button type="button" data-op="takeover" disabled={settled} onClick={onTakeOver}>
              {takingOver ? 'Detach' : 'Take over'}
            </button>
          </p>
          <p className="muted" data-takeover>
            Take over interrupts the headless session, opens {harness} in a terminal on the same
            session, and resumes it headless when you detach.
          </p>
        </>
      ) : (
        <p className="muted" data-takeover>
          Take over: {harness} has no interactive takeover.
          {capabilities === null
            ? ' Capabilities for this harness are unknown and assumed absent.'
            : ''}
        </p>
      )}
    </section>
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
    <section className="panel" data-diff>
      <h3>Diff</h3>
      <dl className="ref">
        <dt>branch</dt>
        <dd data-diff-branch>{diff.branch ?? '—'}</dd>
        <dt>base</dt>
        <dd data-diff-base>{diff.baseBranch ?? '—'}</dd>
        <dt>lane</dt>
        <dd data-diff-lane>{diff.lane ?? '—'}</dd>
      </dl>
      <p className="muted">
        {complete
          ? `git diff ${diff.baseBranch}...${diff.branch}`
          : 'This node has no branch yet.'}
      </p>
    </section>
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
    <section className="panel" data-gates>
      <h3>Gate logs</h3>
      {gates.length === 0 ? (
        <p className="empty">No gate has run yet.</p>
      ) : (
        <ul className="gates">
          {gates.map((gate) => (
            <li key={gate.gateId} data-gate={gate.gateId}>
              <p className="entry-head">
                <span>{gate.gateId}</span>
                {gate.gateId === failing && <Chip tone="error">failing</Chip>}
              </p>
              <pre data-gate-log={gate.gateId}>{gate.log}</pre>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** Errors from `client.ts` name an endpoint and a status; nothing else is relayed. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'the daemon could not be reached'
}
