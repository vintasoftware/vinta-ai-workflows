/**
 * A plan's review: the comments a person leaves on it and the conversation
 * they have about it with the agent that wrote it (§19).
 *
 * **It is a document, not run state.** A review happens before any run exists,
 * it is about the committed plan, and it is worth keeping beside it — the next
 * person to read the plan should be able to see what was questioned and what
 * changed because of it. So it lives at `ai-plans/<id>.review.json`, next to
 * the plan and its workflow, and is committed like them. That is also why it
 * has a JSON Schema at the repo root: the agent that answers it reads it with
 * no daemon in between.
 *
 * Every function below is pure. A mutation takes a document and returns a new
 * one; the store (`store.ts`) owns the lock and the file. That split is what
 * lets the daemon and the CLI — two processes — edit the same file: each one
 * reads, applies one of these, and writes under the same lock.
 *
 * The protocol, in one paragraph. A person comments on the plan, the graph, a
 * phase, a prompt or a gate. Comments are saved at once and stay *unsent*
 * until the person sends them, the way a code review is drafted and then
 * submitted; sending is a conversation message that carries the ids. A chat
 * message is sent as it is written. The agent picks up what is undelivered
 * with `vinta-ai-maestro review wait`, which marks it delivered, edits the
 * plan, and answers with `review reply` — in the conversation, or on a thread.
 * Approving the plan is one more message, and the one that ends the loop.
 */
import { z } from 'zod'

export const PLAN_REVIEW_SCHEMA_URL =
  'https://github.com/vintasoftware/vinta-ai-workflows/schemas/plan-review.v1.schema.json'

/** `plan-feature`'s sibling of `<id>.workflow.json`. */
export const REVIEW_SUFFIX = '.review.json'

/**
 * Generous for prose and small for a file people commit. A comment longer than
 * this is a document, and the plan is where documents go.
 */
export const MAX_BODY = 8_000

/** A quoted excerpt of what the comment is about. Enough for a paragraph. */
export const MAX_QUOTE = 2_000

const IsoSchema = z.string().min(1)
const TextSchema = z.string().trim().min(1).max(MAX_BODY)

export const AUTHOR_KINDS = ['human', 'agent'] as const
export type AuthorKind = (typeof AUTHOR_KINDS)[number]

export const AuthorSchema = z.strictObject({
  kind: z.enum(AUTHOR_KINDS),
  /** `git config user.name` for a person, the harness for an agent. Optional. */
  name: z.string().min(1).max(200).optional(),
})

/**
 * The roles whose cold prompt a phase is composed with. A phase's review is a
 * chore (§16), so its prompt is one of the phase's chore prompts, not a role.
 */
export const PROMPT_ROLES = ['implementer', 'fixer'] as const
export type PromptRole = (typeof PROMPT_ROLES)[number]

/**
 * What a comment is about. Closed, because each kind is something the review
 * page can scroll to and the agent can find: a heading of the plan, a node of
 * the workflow, a composed prompt, a gate.
 */
export const AnchorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('plan') }),
  z.strictObject({
    kind: z.literal('section'),
    /** The heading's slug — the same one a `prompt_ref` anchor uses. */
    section: z.string().min(1).max(200),
    heading: z.string().min(1).max(300).optional(),
  }),
  z.strictObject({ kind: z.literal('phase'), node: z.string().min(1).max(200) }),
  z.strictObject({
    kind: z.literal('prompt'),
    node: z.string().min(1).max(200),
    role: z.enum(PROMPT_ROLES),
  }),
  z.strictObject({
    kind: z.literal('gate'),
    gate: z.string().min(1).max(200),
    node: z.string().min(1).max(200).optional(),
  }),
])

export const ReplySchema = z.strictObject({
  id: z.string().min(1),
  author: AuthorSchema,
  body: TextSchema,
  created_at: IsoSchema,
  /** When a person's reply reached the agent. Absent for an agent's own reply. */
  sent_at: IsoSchema.optional(),
})

export const COMMENT_STATUSES = ['open', 'resolved'] as const
export type CommentStatus = (typeof COMMENT_STATUSES)[number]

export const CommentSchema = z.strictObject({
  id: z.string().min(1),
  anchor: AnchorSchema,
  /** The text the person selected, when they selected some. */
  quote: z.string().min(1).max(MAX_QUOTE).optional(),
  author: AuthorSchema,
  body: TextSchema,
  created_at: IsoSchema,
  status: z.enum(COMMENT_STATUSES),
  resolved_at: IsoSchema.optional(),
  /** When the comment was sent to the agent. Absent while it is a draft. */
  sent_at: IsoSchema.optional(),
  replies: z.array(ReplySchema),
})

export const MESSAGE_KINDS = ['message', 'approval'] as const
export type MessageKind = (typeof MESSAGE_KINDS)[number]

export const MessageSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(MESSAGE_KINDS),
  author: AuthorSchema,
  /** Empty only for an approval or a send that carried no note. */
  body: z.string().max(MAX_BODY),
  created_at: IsoSchema,
  /** The threads this message sent to the agent, by id. */
  comment_ids: z.array(z.string().min(1)).optional(),
  /** When `review wait` handed it to an agent. Absent on the agent's own. */
  delivered_at: IsoSchema.optional(),
})

export const REVIEW_STATUSES = ['open', 'approved'] as const
export type ReviewStatus = (typeof REVIEW_STATUSES)[number]

export const PlanReviewSchema = z
  .strictObject({
    $schema: z.string().optional(),
    schema_version: z.literal(1),
    /** The workflow this review is about, and the stem of its filename. */
    workflow_id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    status: z.enum(REVIEW_STATUSES),
    approved_at: IsoSchema.optional(),
    comments: z.array(CommentSchema),
    conversation: z.array(MessageSchema),
  })
  .describe(
    'A plan review: comments on a plan-feature plan and the conversation about it between the ' +
      'person reviewing it and the agent that wrote it.',
  )

export type Author = z.infer<typeof AuthorSchema>
export type Anchor = z.infer<typeof AnchorSchema>
export type Reply = z.infer<typeof ReplySchema>
export type Comment = z.infer<typeof CommentSchema>
export type Message = z.infer<typeof MessageSchema>
export type PlanReview = z.infer<typeof PlanReviewSchema>

export function emptyReview(workflowId: string): PlanReview {
  return {
    $schema: PLAN_REVIEW_SCHEMA_URL,
    schema_version: 1,
    workflow_id: workflowId,
    status: 'open',
    comments: [],
    conversation: [],
  }
}

/** A mutation that cannot apply says why, by code, never with the text it was given. */
export class ReviewRefusal extends Error {
  readonly code: string
  constructor(code: string) {
    super(`review change refused: ${code}`)
    this.name = 'ReviewRefusal'
    this.code = code
  }
}

export interface NewComment {
  readonly anchor: Anchor
  readonly body: string
  readonly quote?: string
  readonly author: Author
}

export function addComment(review: PlanReview, input: NewComment, now: string): PlanReview {
  const comment: Comment = {
    id: nextId('c', review.comments.map((comment) => comment.id)),
    anchor: input.anchor,
    ...(input.quote === undefined || input.quote.trim() === '' ? {} : { quote: input.quote }),
    author: input.author,
    body: input.body.trim(),
    created_at: now,
    status: 'open',
    // An agent's comment is already where it needs to be: there is nobody on
    // the other side of `wait` to send it to.
    ...(input.author.kind === 'agent' ? { sent_at: now } : {}),
    replies: [],
  }
  return { ...review, comments: [...review.comments, comment] }
}

export function addReply(
  review: PlanReview,
  commentId: string,
  input: { readonly body: string; readonly author: Author },
  now: string,
): PlanReview {
  const comment = findComment(review, commentId)
  const reply: Reply = {
    id: nextId(`${comment.id}r`, comment.replies.map((reply) => reply.id)),
    author: input.author,
    body: input.body.trim(),
    created_at: now,
  }
  return replaceComment(review, { ...comment, replies: [...comment.replies, reply] })
}

export function setCommentStatus(
  review: PlanReview,
  commentId: string,
  status: CommentStatus,
  now: string,
): PlanReview {
  const comment = findComment(review, commentId)
  const { resolved_at: _resolvedAt, ...rest } = comment
  return replaceComment(review, status === 'resolved' ? { ...rest, status, resolved_at: now } : { ...rest, status })
}

/**
 * Removes a draft. Only a person's unsent comment with no replies can go: once
 * the agent has read a comment, deleting it would leave the agent's answer
 * replying to nothing, and a resolved thread already says "this is done".
 */
export function deleteDraft(review: PlanReview, commentId: string): PlanReview {
  const comment = findComment(review, commentId)
  if (comment.sent_at !== undefined || comment.replies.length > 0) {
    throw new ReviewRefusal('comment_already_sent')
  }
  return { ...review, comments: review.comments.filter((candidate) => candidate.id !== commentId) }
}

/** Every thread holding a person's words the agent has not been sent yet. */
export function unsentThreads(review: PlanReview): Comment[] {
  return review.comments.filter(
    (comment) =>
      comment.author.kind === 'human' &&
      (comment.sent_at === undefined ||
        comment.replies.some((reply) => reply.author.kind === 'human' && reply.sent_at === undefined)),
  )
}

/**
 * A person's chat message, optionally sending threads with it.
 *
 * `send: 'unsent'` sends every thread with unsent words — the "Send to agent"
 * button. A message with no body and nothing to send is refused: it would wake
 * the agent to read nothing.
 */
export function postMessage(
  review: PlanReview,
  input: { readonly body: string; readonly author: Author; readonly send?: 'unsent' | 'none' },
  now: string,
): PlanReview {
  const body = input.body.trim()
  const threads = input.send === 'unsent' && input.author.kind === 'human' ? unsentThreads(review) : []
  if (body === '' && threads.length === 0) throw new ReviewRefusal('empty_message')

  const sent = new Set(threads.map((thread) => thread.id))
  const comments =
    sent.size === 0
      ? review.comments
      : review.comments.map((comment) =>
          sent.has(comment.id)
            ? {
                ...comment,
                sent_at: comment.sent_at ?? now,
                replies: comment.replies.map((reply) =>
                  reply.author.kind === 'human' && reply.sent_at === undefined
                    ? { ...reply, sent_at: now }
                    : reply,
                ),
              }
            : comment,
        )

  const message: Message = {
    id: nextId('m', review.conversation.map((message) => message.id)),
    kind: 'message',
    author: input.author,
    body,
    created_at: now,
    ...(threads.length === 0 ? {} : { comment_ids: threads.map((thread) => thread.id) }),
  }
  // A person who writes after approving is reopening the review, whether or
  // not they say so — an approved plan with an unanswered question about it is
  // not approved.
  const reopened = input.author.kind === 'human' && review.status === 'approved'
  const { approved_at: _approvedAt, ...base } = review
  return {
    ...(reopened ? base : review),
    status: reopened ? 'open' : review.status,
    comments,
    conversation: [...review.conversation, message],
  }
}

export function approve(review: PlanReview, author: Author, now: string): PlanReview {
  if (review.status === 'approved') throw new ReviewRefusal('already_approved')
  const message: Message = {
    id: nextId('m', review.conversation.map((message) => message.id)),
    kind: 'approval',
    author,
    body: '',
    created_at: now,
  }
  return {
    ...review,
    status: 'approved',
    approved_at: now,
    conversation: [...review.conversation, message],
  }
}

/** What `review wait` hands an agent: a person's messages it has not seen. */
export function undelivered(review: PlanReview): Message[] {
  return review.conversation.filter(
    (message) => message.author.kind === 'human' && message.delivered_at === undefined,
  )
}

export function markDelivered(review: PlanReview, ids: readonly string[], now: string): PlanReview {
  if (ids.length === 0) return review
  const marked = new Set(ids)
  return {
    ...review,
    conversation: review.conversation.map((message) =>
      marked.has(message.id) && message.delivered_at === undefined
        ? { ...message, delivered_at: now }
        : message,
    ),
  }
}

/**
 * Whether the agent owes an answer: a person's message it has picked up with
 * nothing from the agent after it. That is what tells "the agent is working on
 * it" apart from "nobody has picked this up".
 */
export function awaitingAgent(review: PlanReview): boolean {
  for (let i = review.conversation.length - 1; i >= 0; i -= 1) {
    const message = review.conversation[i] as Message
    if (message.author.kind === 'agent') return false
    if (message.delivered_at !== undefined) return true
  }
  return false
}

function findComment(review: PlanReview, id: string): Comment {
  const comment = review.comments.find((candidate) => candidate.id === id)
  if (comment === undefined) throw new ReviewRefusal('unknown_comment')
  return comment
}

function replaceComment(review: PlanReview, comment: Comment): PlanReview {
  return {
    ...review,
    comments: review.comments.map((candidate) => (candidate.id === comment.id ? comment : candidate)),
  }
}

/**
 * `c1`, `c2`, … — short, because the agent quotes them back and a person reads
 * them in a terminal. Next after the largest, never reused: an id the agent
 * already answered must not come to mean a different comment.
 */
function nextId(prefix: string, taken: readonly string[]): string {
  let max = 0
  for (const id of taken) {
    if (!id.startsWith(prefix)) continue
    const n = Number(id.slice(prefix.length))
    if (Number.isInteger(n) && n > max) max = n
  }
  return `${prefix}${max + 1}`
}
