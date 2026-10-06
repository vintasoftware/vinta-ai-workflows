/**
 * Comments on a plan, and the composer that writes them (§19).
 *
 * Drafted, then sent — the way a code review is. A comment is saved the moment
 * it is written, so nothing is lost to a closed tab, but the agent sees it only
 * when the reviewer presses "Send to agent". One send carries every comment
 * not yet sent, which is what lets a reviewer read the whole plan before the
 * agent starts rewriting the first section of it.
 *
 * The composer always says what the next comment is about. It follows the
 * reviewer: picking a phase, a prompt, a gate or a section of the plan points
 * it there, and "×" points it back at the plan as a whole.
 */
import {
  CheckIcon,
  CornerDownRightIcon,
  LocateFixedIcon,
  RotateCcwIcon,
  SendIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from 'vinta-design-system/ui/button'
import { cn } from 'vinta-design-system/lib/utils'
import type { Anchor, Comment, PlanReview } from '../../src/review/document.ts'
import type { Workflow } from '../../src/types.ts'
import { Chip } from './Chip.tsx'
import { Prose } from './Markdown.tsx'
import { EmptyNote, ErrorNote } from './Panel.tsx'
import { Segmented } from './Segmented.tsx'
import { anchorLabel, filterComments, isUnsent, type CommentFilter } from './plan-model.ts'
import { ago } from './time.ts'

export interface DraftTarget {
  readonly anchor: Anchor
  readonly quote?: string
}

export interface ReviewCommentsProps {
  readonly review: PlanReview | null
  readonly workflow: Workflow | null
  readonly target: DraftTarget
  /** Bumped each time something asks for the composer, so it takes focus. */
  readonly focusToken: number
  readonly onClearTarget: () => void
  readonly onSave: (target: DraftTarget, body: string) => Promise<boolean>
  readonly onReply: (commentId: string, body: string) => Promise<boolean>
  readonly onStatus: (commentId: string, status: 'open' | 'resolved') => Promise<boolean>
  readonly onDiscard: (commentId: string) => Promise<boolean>
  readonly onSend: (note: string) => Promise<boolean>
  readonly onReveal: (anchor: Anchor) => void
  readonly error: string | null
}

export function ReviewComments({
  review,
  workflow,
  target,
  focusToken,
  onClearTarget,
  onSave,
  onReply,
  onStatus,
  onDiscard,
  onSend,
  onReveal,
  error,
}: ReviewCommentsProps) {
  const [filter, setFilter] = useState<CommentFilter>('open')
  const [body, setBody] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (focusToken > 0) input.current?.focus()
  }, [focusToken])

  const comments = review?.comments ?? []
  const unsent = comments.filter(isUnsent)
  const shown = filterComments(comments, filter).slice().reverse()
  const openCount = comments.filter((comment) => comment.status === 'open').length

  async function save(): Promise<void> {
    if (body.trim() === '' || busy) return
    setBusy(true)
    if (await onSave(target, body)) setBody('')
    setBusy(false)
  }

  async function send(): Promise<void> {
    if (unsent.length === 0 || busy) return
    setBusy(true)
    if (await onSend(note)) setNote('')
    setBusy(false)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-review-comments>
      <form
        className="flex flex-col gap-2 rounded-lg border bg-background p-2.5"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
        data-composer
      >
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="text-muted-foreground">On</span>
            <span className="truncate font-medium" data-target={target.anchor.kind}>
              {anchorLabel(target.anchor, workflow)}
            </span>
          </span>
          {target.anchor.kind !== 'plan' && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Comment on the whole plan instead"
              data-action="clear-target"
              onClick={onClearTarget}
            >
              <XIcon />
            </Button>
          )}
        </div>
        {target.quote !== undefined && (
          <blockquote className="line-clamp-3 border-l-2 border-tone-attention pl-2 text-xs text-muted-foreground" data-quote>
            {target.quote}
          </blockquote>
        )}
        <textarea
          ref={input}
          className="min-h-16 resize-y rounded-md border bg-background px-2.5 py-2 text-sm"
          aria-label="New comment"
          placeholder="What should change, or what is unclear?"
          data-field="comment"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void save()
            }
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">⌘/Ctrl + Enter saves a draft</span>
          <Button type="submit" size="xs" data-action="save-comment" disabled={busy || body.trim() === ''}>
            Save draft
          </Button>
        </div>
      </form>

      {error !== null && <ErrorNote>{error}</ErrorNote>}

      <div className="flex items-center justify-between gap-2">
        <Segmented<CommentFilter>
          label="Show comments"
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'open', label: 'Open', count: openCount, tone: 'attention' },
            { value: 'resolved', label: 'Resolved' },
            { value: 'all', label: 'All' },
          ]}
        />
      </div>

      <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-1" data-threads>
        {shown.length === 0 ? (
          <EmptyNote className="py-4 text-center">
            {filter === 'open'
              ? 'No open comments. Select text in the plan or a prompt, or use a Comment button.'
              : 'Nothing here.'}
          </EmptyNote>
        ) : (
          shown.map((comment) => (
            <Thread
              key={comment.id}
              comment={comment}
              workflow={workflow}
              onReply={onReply}
              onStatus={onStatus}
              onDiscard={onDiscard}
              onReveal={onReveal}
            />
          ))
        )}
      </div>

      <div
        className={cn(
          'flex flex-col gap-2 rounded-lg border p-2.5',
          unsent.length > 0 ? 'border-tone-attention bg-tone-attention-soft/40' : 'bg-muted/40',
        )}
        data-send
      >
        <span className="text-xs">
          {unsent.length === 0
            ? 'Every comment has been sent to the agent.'
            : `${unsent.length} comment${unsent.length === 1 ? '' : 's'} not yet sent to the agent.`}
        </span>
        {unsent.length > 0 && (
          <input
            className="h-8 rounded-md border bg-background px-2.5 text-sm"
            aria-label="Note to send with the comments"
            placeholder="Optional note — e.g. “mostly scoping questions”"
            data-field="send-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        )}
        <Button
          type="button"
          size="sm"
          data-action="send-comments"
          disabled={busy || unsent.length === 0}
          onClick={() => void send()}
        >
          <SendIcon />
          Send {unsent.length > 0 ? unsent.length : ''} to agent
        </Button>
      </div>
    </div>
  )
}

function Thread({
  comment,
  workflow,
  onReply,
  onStatus,
  onDiscard,
  onReveal,
}: {
  readonly comment: Comment
  readonly workflow: Workflow | null
  readonly onReply: (commentId: string, body: string) => Promise<boolean>
  readonly onStatus: (commentId: string, status: 'open' | 'resolved') => Promise<boolean>
  readonly onDiscard: (commentId: string) => Promise<boolean>
  readonly onReveal: (anchor: Anchor) => void
}) {
  const [replying, setReplying] = useState(false)
  const [text, setText] = useState('')
  const draft = comment.sent_at === undefined && comment.author.kind === 'human'
  const resolved = comment.status === 'resolved'

  return (
    <article
      className={cn(
        'flex flex-col gap-2 rounded-lg border bg-card p-2.5 text-sm',
        resolved && 'opacity-70',
        draft && 'border-dashed',
      )}
      data-comment={comment.id}
      data-status={comment.status}
    >
      <header className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="flex min-w-0 items-center gap-1 text-xs font-medium text-primary hover:underline"
          data-action="reveal"
          onClick={() => onReveal(comment.anchor)}
          title="Show where this comment is"
        >
          <LocateFixedIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">{anchorLabel(comment.anchor, workflow)}</span>
        </button>
        <span className="flex shrink-0 items-center gap-1">
          {draft && <Chip tone="wait">draft</Chip>}
          {resolved && <Chip tone="ok">resolved</Chip>}
          <span className="font-mono text-[11px] text-muted-foreground">{comment.id}</span>
        </span>
      </header>
      {comment.quote !== undefined && (
        <blockquote className="line-clamp-4 border-l-2 border-border pl-2 text-xs text-muted-foreground">
          {comment.quote}
        </blockquote>
      )}
      <Body author={comment.author.kind} text={comment.body} at={comment.created_at} />
      {comment.replies.map((reply) => (
        <div key={reply.id} className="flex gap-1.5 pl-1" data-reply={reply.id}>
          <CornerDownRightIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <Body author={reply.author.kind} text={reply.body} at={reply.created_at} />
        </div>
      ))}
      {replying ? (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            if (text.trim() === '') return
            void onReply(comment.id, text).then((ok) => {
              if (ok) {
                setText('')
                setReplying(false)
              }
            })
          }}
        >
          <textarea
            className="min-h-12 resize-y rounded-md border bg-background px-2 py-1.5 text-sm"
            aria-label={`Reply to ${comment.id}`}
            data-field="reply"
            value={text}
            autoFocus
            onChange={(event) => setText(event.target.value)}
          />
          <span className="flex justify-end gap-1">
            <Button type="button" variant="ghost" size="xs" onClick={() => setReplying(false)}>
              Cancel
            </Button>
            <Button type="submit" size="xs" data-action="send-reply" disabled={text.trim() === ''}>
              Reply
            </Button>
          </span>
        </form>
      ) : (
        <footer className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="xs" data-action="reply" onClick={() => setReplying(true)}>
            Reply
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-action={resolved ? 'reopen' : 'resolve'}
            onClick={() => void onStatus(comment.id, resolved ? 'open' : 'resolved')}
          >
            {resolved ? <RotateCcwIcon /> : <CheckIcon />}
            {resolved ? 'Reopen' : 'Resolve'}
          </Button>
          {draft && comment.replies.length === 0 && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="ml-auto text-muted-foreground"
              data-action="discard"
              aria-label={`Discard draft ${comment.id}`}
              onClick={() => void onDiscard(comment.id)}
            >
              <Trash2Icon />
            </Button>
          )}
        </footer>
      )}
    </article>
  )
}

function Body({
  author,
  text,
  at,
}: {
  readonly author: 'human' | 'agent'
  readonly text: string
  readonly at: string
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-author={author}>
      <span className="text-[11px] text-muted-foreground">
        {author === 'agent' ? 'Agent' : 'You'} · {ago(Date.parse(at), Date.now())}
      </span>
      <Prose text={text} className="markdown-quiet text-sm" />
    </div>
  )
}
