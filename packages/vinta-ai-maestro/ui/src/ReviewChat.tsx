/**
 * The conversation with the agent that wrote the plan (§19).
 *
 * The agent is not hosted here. It is whatever session ran `plan-feature`, and
 * it is on the other end of `vinta-ai-maestro review wait` — so this panel's
 * first job is to say whether anybody *is* on the other end. "Listening" means
 * a message is read at once; "working" means it picked up the last one and is
 * revising the plan; "away" means a message will wait, and the panel says
 * exactly what to run to bring an agent back to it.
 *
 * The conversation is the review file's, not the tab's: a reload, a second
 * tab, or the same page tomorrow shows the same history.
 */
import { CheckCheckIcon, CopyIcon, MessageSquareTextIcon, SendIcon, SparklesIcon } from 'lucide-react'
import { useLayoutEffect, useState } from 'react'
import { Button } from 'vinta-design-system/ui/button'
import { cn } from 'vinta-design-system/lib/utils'
import type { PresenceResponse } from '../../src/daemon/schemas.ts'
import type { Anchor, Message, PlanReview } from '../../src/review/document.ts'
import { Chip } from './Chip.tsx'
import { useFollowing } from './follow.ts'
import { Prose } from './Markdown.tsx'
import { EmptyNote, ErrorNote } from './Panel.tsx'
import { ago } from './time.ts'

export function ReviewChat({
  review,
  presence,
  workflowPath,
  onSend,
  onReveal,
  error,
}: {
  readonly review: PlanReview | null
  readonly presence: PresenceResponse | null
  /** Repo-relative path of the workflow, for the command that attaches an agent. */
  readonly workflowPath: string
  readonly onSend: (body: string) => Promise<boolean>
  readonly onReveal: (anchor: Anchor) => void
  readonly error: string | null
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const { listRef, onScroll, stick } = useFollowing()
  const conversation = review?.conversation ?? []
  const comments = new Map((review?.comments ?? []).map((comment) => [comment.id, comment]))

  useLayoutEffect(() => {
    stick()
  }, [conversation.length, stick])

  async function send(): Promise<void> {
    const body = text.trim()
    if (body === '' || busy) return
    setBusy(true)
    if (await onSend(body)) setText('')
    setBusy(false)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-review-chat>
      <PresenceNote presence={presence} workflowPath={workflowPath} />

      <ol
        ref={listRef}
        onScroll={onScroll}
        className="-mx-1 flex min-h-40 flex-1 flex-col gap-2.5 overflow-y-auto px-1"
        data-conversation
      >
        {conversation.length === 0 ? (
          <li>
            <EmptyNote className="py-6 text-center">
              Ask the agent why a phase is shaped the way it is, or tell it what to change. It edits
              the plan and the page updates.
            </EmptyNote>
          </li>
        ) : (
          conversation.map((message) => (
            <ChatRow
              key={message.id}
              message={message}
              sent={(message.comment_ids ?? []).map((id) => ({
                id,
                anchor: comments.get(id)?.anchor ?? null,
              }))}
              onReveal={onReveal}
            />
          ))
        )}
        {presence?.state === 'working' && (
          <li className="flex items-center gap-2 text-xs text-muted-foreground" data-working>
            <SparklesIcon aria-hidden="true" className="size-3.5 animate-pulse" />
            The agent is revising the plan…
          </li>
        )}
      </ol>

      {error !== null && <ErrorNote>{error}</ErrorNote>}

      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <textarea
          className="min-h-16 flex-1 resize-y rounded-md border bg-background px-2.5 py-2 text-sm"
          aria-label="Message the agent"
          placeholder="Split phase 2 — the endpoint and its tests are two concerns."
          data-field="message"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
        />
        <Button type="submit" size="sm" data-action="send-message" disabled={busy || text.trim() === ''}>
          <SendIcon />
          Send
        </Button>
      </form>
    </div>
  )
}

function ChatRow({
  message,
  sent,
  onReveal,
}: {
  readonly message: Message
  readonly sent: readonly { readonly id: string; readonly anchor: Anchor | null }[]
  readonly onReveal: (anchor: Anchor) => void
}) {
  const human = message.author.kind === 'human'
  const when = ago(Date.parse(message.created_at), Date.now())

  if (message.kind === 'approval') {
    return (
      <li className="flex items-center justify-center gap-2 py-1 text-xs" data-message={message.id} data-kind="approval">
        <Chip tone="ok">Plan approved</Chip>
        <span className="text-muted-foreground">{when}</span>
      </li>
    )
  }

  return (
    <li
      className={cn('flex flex-col gap-1', human ? 'items-end' : 'items-start')}
      data-message={message.id}
      data-author={message.author.kind}
    >
      <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {human ? 'You' : (message.author.name ?? 'Agent')} · {when}
        {human && message.delivered_at !== undefined && (
          <span className="flex items-center gap-0.5 text-tone-ok-foreground" title="Read by the agent" data-delivered>
            <CheckCheckIcon aria-hidden="true" className="size-3.5" />
            read
          </span>
        )}
      </span>
      {(message.body !== '' || sent.length === 0) && (
        <div
          className={cn(
            'max-w-[92%] rounded-lg px-3 py-2 text-sm',
            human
              ? 'border-l-2 border-tone-attention bg-tone-attention-soft/50'
              : 'border bg-card',
          )}
        >
          <Prose text={message.body} className="markdown-quiet" />
        </div>
      )}
      {sent.length > 0 && (
        <div className="flex max-w-[92%] flex-wrap items-center gap-1 text-xs" data-sent-comments>
          <MessageSquareTextIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">
            Sent {sent.length} comment{sent.length === 1 ? '' : 's'}
          </span>
          {sent.map((comment) => (
            <button
              key={comment.id}
              type="button"
              className="rounded bg-muted px-1.5 font-mono text-[11px] hover:bg-muted-foreground/20"
              disabled={comment.anchor === null}
              onClick={() => comment.anchor !== null && onReveal(comment.anchor)}
            >
              {comment.id}
            </button>
          ))}
        </div>
      )}
    </li>
  )
}

function PresenceNote({
  presence,
  workflowPath,
}: {
  readonly presence: PresenceResponse | null
  readonly workflowPath: string
}) {
  if (presence === null) return null
  if (presence.state === 'listening') {
    return (
      <p className="flex items-center gap-2 text-xs" data-presence="listening">
        <span className="relative flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-tone-ok opacity-60" />
          <span className="relative inline-flex size-2 rounded-full bg-tone-ok" />
        </span>
        The agent is listening — messages reach it at once.
      </p>
    )
  }
  if (presence.state === 'working') {
    return (
      <p className="flex items-center gap-2 text-xs" data-presence="working">
        <span className="inline-flex size-2 rounded-full bg-tone-active" />
        The agent picked up your last message and is working on it.
      </p>
    )
  }
  const command = `vinta-ai-maestro review wait ${workflowPath}`
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-dashed p-2.5 text-xs" data-presence="away">
      <span className="flex items-center gap-2">
        <span className="inline-flex size-2 rounded-full bg-tone-idle" />
        No agent is listening
        {presence.lastSeenAt !== null && (
          <span className="text-muted-foreground">· last seen {ago(Date.parse(presence.lastSeenAt), Date.now())}</span>
        )}
      </span>
      <span className="text-muted-foreground">
        Messages and comments are kept. Ask your agent to pick them up — in the session that wrote the
        plan, say “check the review”, or have any agent run:
      </span>
      <span className="flex items-center gap-1">
        <code className="flex-1 overflow-x-auto whitespace-nowrap rounded bg-muted px-2 py-1 font-mono text-[11px]">
          {command}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Copy the command"
          onClick={() => void navigator.clipboard?.writeText(command)}
        >
          <CopyIcon />
        </Button>
      </span>
    </div>
  )
}
