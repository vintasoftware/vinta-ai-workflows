/**
 * Steering a node (§9): the composer under the transcript, the node controls
 * in the page header, and the guide that says what each one does.
 *
 * **Two kinds of control, two places.** Add context and Redirect carry a
 * message to the agent, so they live where a chat puts its input: under the
 * conversation, inside the transcript's own panel. Pause, Take over, Abort and
 * Retry change the node's lifecycle and carry no message, so they sit in the
 * header beside the status they change — the same place the run view puts the
 * run's own Pause and Stop. The steering box used to hold all six side by side
 * under a separate card, which made the message verbs look like peers of
 * Abort and left the operator guessing which ones the text box fed.
 *
 * **One send button, and the mode says what it does.** The two message verbs
 * differ in one thing — whether the agent's current turn is stopped first —
 * so they are a toggle over a single Send, and the sentence under the box is
 * rewritten for the mode, the node's status and the harness's capabilities
 * before anything is pressed. That sentence is the truth the scheduler will
 * act on, which is why it is computed here and not written once as help text.
 *
 * **Controls that cannot apply are not drawn.** Retry exists only for a
 * failed node, Take over only where the harness declares a PTY, and a settled
 * node offers nothing but Retry. Pause is the one exception: it is shown
 * disabled on a live node that is between turns, because it will be
 * available again in a moment and a button that comes and goes is worse.
 *
 * **The guide is a sheet, not a wall of hints.** Every control has a one-line
 * tooltip; the full account — when it is available, what happens in practice,
 * how to undo it, and what this harness supports — opens on demand beside the
 * page so it never pushes the transcript down.
 */
import {
  CheckIcon,
  CircleHelpIcon,
  CornerUpRightIcon,
  MessageSquarePlusIcon,
  OctagonXIcon,
  PauseIcon,
  RotateCcwIcon,
  SendIcon,
  TerminalIcon,
  XIcon,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { cn } from 'vinta-design-system/lib/utils'
import { Button } from 'vinta-design-system/ui/button'
import { Kbd } from 'vinta-design-system/ui/kbd'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from 'vinta-design-system/ui/sheet'
import { Textarea } from 'vinta-design-system/ui/textarea'
import type { RunSnapshot } from '../../src/daemon/schemas.ts'
import { Chip } from './Chip.tsx'
import type { NodeOperation, OperationBody } from './client.ts'
import type { NodeStatus } from './projection.ts'

export type Capabilities = NonNullable<RunSnapshot['harnesses'][number]['capabilities']>

export type Operate = <K extends NodeOperation>(
  operation: K,
  body: OperationBody<K>,
  done: string,
) => void

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
export function capabilitiesOf(snapshot: RunSnapshot | null, harness: string): Capabilities | null {
  return snapshot?.harnesses.find((state) => state.id === harness)?.capabilities ?? null
}

/** A node that has finished, one way or the other. Steering it is ignored. */
export function isSettled(status: NodeStatus): boolean {
  return status === 'done' || status === 'failed'
}

/** The modifier for send, as the operator's keyboard labels it. */
const MOD_KEY =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'

const DESTRUCTIVE =
  'text-tone-error-foreground hover:bg-tone-error-soft hover:text-tone-error-foreground'

// ---------------------------------------------------------------------------
// The composer
// ---------------------------------------------------------------------------

type Mode = 'context' | 'redirect'

/**
 * The chat input at the foot of the transcript. `steering` and `data-delivery`
 * are the tests' hooks, kept from the box this replaces.
 */
export function Composer({
  harness,
  capabilities,
  status,
  busy,
  onOperate,
  onHelp,
}: {
  readonly harness: string
  /** The adapter's own declaration, or null for a harness that made none. */
  readonly capabilities: Capabilities | null
  readonly status: NodeStatus
  readonly busy: boolean
  readonly onOperate: Operate
  readonly onHelp: () => void
}) {
  const [text, setText] = useState('')
  const [mode, setMode] = useState<Mode>('context')
  const declared = capabilities ?? ASSUMED
  const settled = isSettled(status)
  const canSend = !busy && !settled && text.trim() !== ''

  const send = (): void => {
    if (!canSend) return
    if (mode === 'context') onOperate('context', { text }, 'Context sent.')
    else onOperate('redirect', { instruction: text }, 'Redirect sent.')
    setText('')
  }

  return (
    <div className="steering flex flex-col gap-2 border-t pt-3" data-composer>
      <Textarea
        aria-label="Message to the agent"
        data-field="steering"
        placeholder={settled ? 'This node has finished.' : 'Message the agent…'}
        rows={2}
        className="min-h-16 resize-y"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            send()
          }
        }}
        disabled={settled}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <div
            role="radiogroup"
            aria-label="How to send it"
            className="inline-flex rounded-md border p-0.5"
          >
            <ModeOption
              mode="context"
              current={mode}
              disabled={settled}
              onSelect={setMode}
              title="Give the agent more information. Its current turn keeps going."
            >
              <MessageSquarePlusIcon />
              Add context
            </ModeOption>
            <ModeOption
              mode="redirect"
              current={mode}
              disabled={settled}
              onSelect={setMode}
              title="Change course: stop the current turn and start the next one with this instruction."
            >
              <CornerUpRightIcon />
              Redirect
            </ModeOption>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="What is the difference?"
            title="What is the difference?"
            data-action="steering-guide-inline"
            onClick={onHelp}
          >
            <CircleHelpIcon />
          </Button>
        </div>
        <div className="flex items-center gap-2">
          {!settled && (
            <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:inline-flex">
              <Kbd>{MOD_KEY}</Kbd>
              <Kbd>↵</Kbd>
            </span>
          )}
          <Button
            type="button"
            size="sm"
            data-op={mode}
            disabled={!canSend}
            onClick={send}
          >
            {mode === 'context' ? <SendIcon /> : <CornerUpRightIcon />}
            {mode === 'context' ? 'Send' : 'Redirect'}
          </Button>
        </div>
      </div>
      <p className="text-[13px] text-muted-foreground" data-delivery>
        {delivery(mode, harness, status, declared)}
      </p>
    </div>
  )
}

function ModeOption({
  mode,
  current,
  disabled,
  title,
  onSelect,
  children,
}: {
  readonly mode: Mode
  readonly current: Mode
  readonly disabled: boolean
  readonly title: string
  readonly onSelect: (mode: Mode) => void
  readonly children: ReactNode
}) {
  const selected = mode === current
  return (
    <Button
      type="button"
      role="radio"
      aria-checked={selected}
      variant={selected ? 'secondary' : 'ghost'}
      size="xs"
      data-mode={mode}
      disabled={disabled}
      title={title}
      className={cn('h-6', !selected && 'text-muted-foreground')}
      onClick={() => onSelect(mode)}
    >
      {children}
    </Button>
  )
}

/**
 * What pressing Send will do, as the scheduler will do it. A message is
 * injected only into a turn that is live, on an adapter that can be written
 * to; a redirect stops a turn only on an adapter that can be interrupted.
 * Everything else waits for the agent's next turn on this node.
 */
export function delivery(
  mode: Mode,
  harness: string,
  status: NodeStatus,
  declared: Capabilities,
): string {
  if (isSettled(status)) return 'This node has finished. Messages can no longer reach it.'
  const running = status === 'running'
  if (mode === 'context') {
    if (!running) {
      return 'No agent turn is running, so this is queued and given to the agent at the start of its next turn on this node.'
    }
    return declared.inject
      ? `Goes straight into the running ${harness} session. The agent reads it without stopping.`
      : `${harness} cannot take messages mid-turn, so this is queued and given to the agent at the start of its next turn on this node.`
  }
  if (!running) {
    return "No agent turn is running, so nothing is stopped. The agent's next turn on this node starts with this instruction."
  }
  return declared.interrupt
    ? `Stops the current ${harness} turn now. The agent's next turn starts with this instruction.`
    : `${harness} cannot be stopped mid-turn, so the current turn finishes first. The next one starts with this instruction.`
}

// ---------------------------------------------------------------------------
// The node controls
// ---------------------------------------------------------------------------

/**
 * Pause, Take over, Abort and Retry, for the page header. Abort asks twice,
 * inline, for the reason the run view's Stop does: it kills a live turn and
 * blocks every dependent, and it sits one button away from Pause.
 */
export function NodeControls({
  capabilities,
  status,
  busy,
  takingOver,
  onTakeOver,
  onOperate,
  onHelp,
}: {
  readonly capabilities: Capabilities | null
  readonly status: NodeStatus
  readonly busy: boolean
  readonly takingOver: boolean
  readonly onTakeOver: () => void
  readonly onOperate: Operate
  readonly onHelp: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const declared = capabilities ?? ASSUMED
  const settled = isSettled(status)

  const help = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-action="steering-guide"
      title="What each control does to this node"
      onClick={onHelp}
    >
      <CircleHelpIcon />
      How steering works
    </Button>
  )

  if (confirming && !settled) {
    return (
      <span className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirm abort">
        <span className="text-[13px]">Abort this node? It fails and its dependents are blocked.</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={DESTRUCTIVE}
          data-op="abort-confirm"
          disabled={busy}
          onClick={() => {
            setConfirming(false)
            onOperate('abort', {}, 'Abort requested. The node fails and its dependents are blocked.')
          }}
        >
          Abort node
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-op="abort-cancel"
          onClick={() => setConfirming(false)}
        >
          Keep it
        </Button>
      </span>
    )
  }

  return (
    <span className="flex flex-wrap items-center gap-2" data-node-controls>
      {!settled && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-op="pause"
          disabled={busy || (status !== 'running' && status !== 'awaiting_human')}
          title={
            status === 'running'
              ? 'Let the current turn finish, then wait for you to resume it.'
              : status === 'awaiting_human'
                ? 'Keep it parked: no unattended timer answers its question until you do.'
                : 'Only a node in an agent turn, or parked on a question, can be paused.'
          }
          onClick={() =>
            onOperate(
              'pause',
              {},
              status === 'awaiting_human'
                ? 'Paused. No timer will answer this question; your answer releases it.'
                : 'Pause requested. The node stops after its current turn.',
            )
          }
        >
          <PauseIcon />
          Pause
        </Button>
      )}
      {!settled && declared.pty && (
        <Button
          type="button"
          variant={takingOver ? 'secondary' : 'outline'}
          size="sm"
          data-op="takeover"
          aria-pressed={takingOver}
          title={
            takingOver
              ? 'Hand the session back to run headless.'
              : 'Stop the headless agent and drive its session yourself in a terminal.'
          }
          onClick={onTakeOver}
        >
          <TerminalIcon />
          {takingOver ? 'Detach' : 'Take over'}
        </Button>
      )}
      {!settled && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={DESTRUCTIVE}
          data-op="abort"
          disabled={busy}
          title="Kill the agent now and fail this node. Its dependents are blocked."
          onClick={() => setConfirming(true)}
        >
          <OctagonXIcon />
          Abort
        </Button>
      )}
      {status === 'failed' && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-op="retry"
          disabled={busy}
          title="Run this phase again with a fresh agent session, and unblock what it held up."
          onClick={() =>
            onOperate('retry', {}, 'Retrying this phase, and unblocking what it held up.')
          }
        >
          <RotateCcwIcon />
          Retry phase
        </Button>
      )}
      {help}
    </span>
  )
}

// ---------------------------------------------------------------------------
// The guide
// ---------------------------------------------------------------------------

/**
 * What each control does to *this* node, in practice. The capability rows and
 * every harness-dependent sentence are read off the wire, so the guide cannot
 * promise a live message to a harness that will queue it.
 */
export function SteeringGuide({
  open,
  onOpenChange,
  harness,
  capabilities,
  status,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly harness: string
  readonly capabilities: Capabilities | null
  readonly status: NodeStatus
}) {
  const declared = capabilities ?? ASSUMED
  const settled = isSettled(status)
  const unknown = capabilities === null
  const live = status === 'running'

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-md" data-steering-guide>
        <SheetHeader className="border-b">
          <SheetTitle>How steering works</SheetTitle>
          <SheetDescription>
            What each control does to this node, on {harness}. They act on this node only. To
            pause or stop the whole run, use the controls on the run page.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-6 p-4 text-sm">
          <section className="flex flex-col gap-2" data-guide="capabilities">
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              What {harness} supports
            </h3>
            <ul className="flex flex-col gap-1.5">
              <Capability ok={declared.inject}>Taking messages during a running turn</Capability>
              <Capability ok={declared.interrupt}>Being stopped mid-turn</Capability>
              <Capability ok={declared.pty}>Interactive terminal takeover</Capability>
            </ul>
            {unknown && (
              <p className="text-[13px] text-muted-foreground">
                This harness declared no capabilities, so each one is assumed absent.
              </p>
            )}
          </section>

          <section className="flex flex-col gap-3">
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Messages, from the box under the transcript
            </h3>
            <Entry
              id="context"
              name="Add context"
              available={!settled}
              when="Any time before the node finishes."
              what={
                declared.inject
                  ? `Gives the agent more information without stopping it. While a turn is running, the text goes straight into the ${harness} session and the agent reads it mid-turn. Otherwise it is queued and given to the agent at the start of its next turn on this node.`
                  : `Gives the agent more information without stopping it. ${harness} cannot take messages mid-turn, so the text is always queued and given to the agent at the start of its next turn on this node, such as the next fix round.`
              }
              use="Hints, constraints, a file to look at, an answer to something the agent is unsure about."
            />
            <Entry
              id="redirect"
              name="Redirect"
              available={!settled}
              when="Any time before the node finishes."
              what={
                declared.interrupt
                  ? `Changes course. The current ${harness} turn is stopped at once, and the agent's next turn on this node starts with your instruction. What the agent already wrote stays in the lane.`
                  : `Changes course. ${harness} cannot be stopped mid-turn, so the current turn runs to its end. The agent's next turn on this node starts with your instruction.`
              }
              use="The agent is heading the wrong way and more context will not fix it."
            />
          </section>

          <section className="flex flex-col gap-3">
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Node controls, in the page header
            </h3>
            <Entry
              id="pause"
              name="Pause"
              available={live}
              when="While an agent turn is running."
              what="Nothing is killed. The current turn finishes, then the node stops and asks “The operator paused this node. Resume it?” at the top of this page. It keeps its lane and releases its gate slots while it waits."
              undo="Answer the question to resume the node."
            />
            <Entry
              id="takeover"
              name="Take over"
              available={declared.pty && !settled}
              when="Before the node finishes, on a harness with terminal takeover."
              what={
                declared.pty ? (
                  <span data-takeover>
                    Take over interrupts the headless session and opens {harness} in a terminal
                    under the transcript, on the same session, so you can type to it directly.
                    Detach hands it back: the session resumes headless from where you left it.
                  </span>
                ) : (
                  <span data-takeover>
                    Not offered here: {harness} has no interactive takeover.
                    {unknown ? ' Capabilities for this harness are unknown and assumed absent.' : ''}
                  </span>
                )
              }
              undo={declared.pty ? 'Detach.' : undefined}
            />
            <Entry
              id="abort"
              name="Abort"
              available={!settled}
              when="Any time before the node finishes. Asks you to confirm."
              what="Kills the agent session at once and marks this node failed. Every phase that depends on it is blocked. Other phases in the run keep going."
              undo="Retry phase, while the run is still in progress."
            />
            <Entry
              id="retry"
              name="Retry phase"
              available={status === 'failed'}
              when="Only once the node has failed, while the run is still in progress."
              what="Runs this phase again from the start with a fresh agent session that has no memory of the failed attempt, and a full fix-round budget. The phases its failure blocked are unblocked. A run that has already ended cannot be retried; start it again instead."
            />
          </section>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function Capability({ ok, children }: { readonly ok: boolean; readonly children: ReactNode }) {
  return (
    <li className="flex items-center gap-2" data-capability={ok ? 'yes' : 'no'}>
      {ok ? (
        <CheckIcon aria-label="Supported" className="size-4 text-tone-ok-foreground" />
      ) : (
        <XIcon aria-label="Not supported" className="size-4 text-muted-foreground" />
      )}
      <span className={ok ? undefined : 'text-muted-foreground'}>{children}</span>
    </li>
  )
}

function Entry({
  id,
  name,
  available,
  when,
  what,
  use,
  undo,
}: {
  readonly id: string
  readonly name: string
  readonly available: boolean
  readonly when: string
  readonly what: ReactNode
  readonly use?: string
  readonly undo?: string | undefined
}) {
  return (
    <div className="flex flex-col gap-1 rounded-md border p-3" data-guide={id}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{name}</span>
        <Chip tone={available ? 'ok' : 'idle'}>{available ? 'available now' : 'not now'}</Chip>
      </div>
      <p className="text-[13px] leading-relaxed">{what}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <dt className="font-medium">When</dt>
        <dd>{when}</dd>
        {use !== undefined && (
          <>
            <dt className="font-medium">Use it for</dt>
            <dd>{use}</dd>
          </>
        )}
        {undo !== undefined && (
          <>
            <dt className="font-medium">Undo</dt>
            <dd>{undo}</dd>
          </>
        )}
      </dl>
    </div>
  )
}
