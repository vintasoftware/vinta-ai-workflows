/**
 * `vinta-ai-maestro review` — the agent's half of a plan review (§19).
 *
 * A person reviews a plan on the review page: reads it, walks its graph, reads
 * the prompts each phase will send, comments, and chats. The agent that wrote
 * the plan is on the other end of that chat, and these are the three things it
 * does there:
 *
 *   review open <workflow.json>    serve the page and print its URL
 *   review wait <workflow.json>    block until the person says something
 *   review reply <workflow.json>   answer, in the chat or on a comment thread
 *
 * `wait` and `reply` never talk to a daemon. They read and write the review
 * file (`ai-plans/<id>.review.json`) under the same lock the page's daemon
 * uses, so they work whichever process is serving the page — or none, for an
 * agent answering comments somebody committed yesterday. That is also what
 * makes this harness-agnostic: any agent that can run a shell command can sit
 * in this loop, and none needs a tool of its own for it.
 *
 * `wait` exits after `--timeout` seconds with `{"kind":"timeout"}` rather than
 * blocking for ever, because the agents running it have a ceiling on how long
 * one command may take. The loop around it is the agent's: wait, act, reply,
 * wait again — until the person approves the plan.
 */
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  addReply,
  createReviewStore,
  markDelivered,
  repoRelative,
  postMessage,
  ReviewRefusal,
  setCommentStatus,
  undelivered,
  WORKFLOW_FILE_SUFFIX,
  type Anchor,
  type Comment,
  type Message,
  type PlanReview,
  type ReviewStore,
} from '../review/index.ts'
import { FAILED, OK, USAGE, type Io } from './io.ts'
import { serveCommand, type ServeDeps } from './serve.ts'

export const REVIEW_USAGE = `usage: vinta-ai-maestro review open  <workflow.json> [--repo <dir>] [--host <host>] [--port <n>]
       vinta-ai-maestro review wait  <workflow.json> [--repo <dir>] [--timeout <seconds>]
       vinta-ai-maestro review reply <workflow.json> --message <text|-> [--comment <id> [--resolve]]
                                     [--as <name>] [--repo <dir>]

  The agent's side of a plan review. A person reads the plan on the review
  page — its graph, each phase's prompts and gates — comments on it and chats
  with the agent that wrote it. The agent answers through these commands.

  open   Serve the browser UI, as \`ui\` does, and print the URL of this plan's
         review page. Runs until interrupted; start it in the background.
  wait   Block until the person sends something, then print it as one JSON
         object on stdout and mark it delivered:
           {"kind": "messages" | "approved" | "timeout", "workflow_id",
            "review_path", "status", "messages": [{"id", "body",
            "comments": [{"id", "where", "anchor", "quote", "body", "replies"}]}]}
         "approved" means the person approved the plan: stop waiting.
         "timeout" means nothing arrived: run wait again.
         --timeout defaults to 110 seconds, under a two-minute command limit.
  reply  Answer. Without --comment the text goes to the chat; with it, onto
         that comment's thread, and --resolve also marks the thread resolved.
         --message - reads the text from stdin. --as names the agent
         (claude-code, codex, …) in the conversation.

  --repo <dir>   The project. Defaults to the current directory. The review
                 itself is the file beside the workflow: <id>.review.json.`

const DEFAULT_TIMEOUT_S = 110
const POLL_MS = 500
const HEARTBEAT_MS = 3_000

export interface ReviewDeps {
  /** Passed through to `serve` by `review open`. */
  readonly serve?: ServeDeps
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
  readonly stdin?: () => Promise<string>
}

export async function reviewCommand(
  argv: readonly string[],
  io: Io,
  deps: ReviewDeps = {},
): Promise<number> {
  const [sub, ...rest] = argv
  switch (sub) {
    case 'open':
      return await openCommand(rest, io, deps)
    case 'wait':
      return await waitCommand(rest, io, deps)
    case 'reply':
      return await replyCommand(rest, io, deps)
    default:
      io.err(REVIEW_USAGE)
      return USAGE
  }
}

interface Target {
  readonly repoDir: string
  readonly id: string
  readonly path: string
  readonly store: ReviewStore
}

/** The workflow named on the command line, and the review store beside it. */
function targetOf(path: string, repo: string | undefined, io: Io): Target | null {
  const file = resolve(path)
  const name = basename(file)
  if (!name.endsWith(WORKFLOW_FILE_SUFFIX)) {
    io.err(`vinta-ai-maestro: ${path} is not a <id>${WORKFLOW_FILE_SUFFIX} file`)
    return null
  }
  const id = name.slice(0, -WORKFLOW_FILE_SUFFIX.length)
  const repoDir = resolve(repo ?? process.cwd())
  const store = createReviewStore({
    plansDir: dirname(file),
    stateRoot: join(repoDir, '.vinta-ai-maestro'),
    workflowId: id,
  })
  return { repoDir, id, path, store }
}

async function openCommand(argv: readonly string[], io: Io, deps: ReviewDeps): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { repo: { type: 'string' }, host: { type: 'string' }, port: { type: 'string' } },
      allowPositionals: true,
    })
  } catch {
    io.err(REVIEW_USAGE)
    return USAGE
  }
  const path = parsed.positionals[0]
  if (path === undefined || parsed.positionals.length > 1) {
    io.err(REVIEW_USAGE)
    return USAGE
  }
  const target = targetOf(path, parsed.values.repo, io)
  if (target === null) return USAGE

  const forwarded = ['--repo', target.repoDir]
  if (parsed.values.host !== undefined) forwarded.push('--host', parsed.values.host)
  if (parsed.values.port !== undefined) forwarded.push('--port', parsed.values.port)
  return await serveCommand(forwarded, io, {
    ...deps.serve,
    fragment: `#/plans/${encodeURIComponent(target.id)}`,
  })
}

async function waitCommand(argv: readonly string[], io: Io, deps: ReviewDeps): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { repo: { type: 'string' }, timeout: { type: 'string' } },
      allowPositionals: true,
    })
  } catch {
    io.err(REVIEW_USAGE)
    return USAGE
  }
  const path = parsed.positionals[0]
  if (path === undefined || parsed.positionals.length > 1) {
    io.err(REVIEW_USAGE)
    return USAGE
  }
  const timeoutS = parsed.values.timeout === undefined ? DEFAULT_TIMEOUT_S : Number(parsed.values.timeout)
  if (!Number.isFinite(timeoutS) || timeoutS < 0 || timeoutS > 24 * 3600) {
    io.err('vinta-ai-maestro: --timeout must be a number of seconds')
    return USAGE
  }
  const target = targetOf(path, parsed.values.repo, io)
  if (target === null) return USAGE

  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  const { store } = target
  const since = new Date(now()).toISOString()
  const deadline = now() + timeoutS * 1000
  let lastBeat = Number.NEGATIVE_INFINITY

  try {
    for (;;) {
      if (now() - lastBeat >= HEARTBEAT_MS) {
        store.heartbeat(since, new Date(now()).toISOString())
        lastBeat = now()
      }
      const current = store.read()
      if (!current.ok) {
        io.err(`vinta-ai-maestro: ${store.path} is not a valid review — fix or remove it`)
        return FAILED
      }
      if (undelivered(current.review).length > 0) {
        // Re-read under the lock: the set handed over must be exactly the set
        // marked, even if the person sent another message in between.
        let picked: Message[] = []
        const written = store.update((review) => {
          picked = undelivered(review)
          return markDelivered(
            review,
            picked.map((message) => message.id),
            new Date(now()).toISOString(),
          )
        })
        io.out(JSON.stringify(handover(target, written, picked)))
        return OK
      }
      if (now() >= deadline) {
        io.out(
          JSON.stringify({
            kind: 'timeout',
            workflow_id: target.id,
            review_path: repoRelative(target.repoDir, store.path),
            status: current.review.status,
            messages: [],
          }),
        )
        return OK
      }
      await sleep(POLL_MS)
    }
  } catch (error) {
    if (error instanceof ReviewRefusal) {
      io.err(`vinta-ai-maestro: the review could not be updated (${error.code})`)
      return FAILED
    }
    throw error
  } finally {
    store.leave(new Date(now()).toISOString())
  }
}

/** What the agent is handed: each message, with the threads it sent spelled out. */
function handover(target: Target, review: PlanReview, picked: readonly Message[]) {
  const byId = new Map(review.comments.map((comment) => [comment.id, comment]))
  const last = picked[picked.length - 1]
  return {
    kind: review.status === 'approved' && last?.kind === 'approval' ? 'approved' : 'messages',
    workflow_id: target.id,
    review_path: repoRelative(target.repoDir, target.store.path),
    status: review.status,
    messages: picked.map((message) => ({
      id: message.id,
      kind: message.kind,
      body: message.body,
      created_at: message.created_at,
      comments: (message.comment_ids ?? [])
        .map((id) => byId.get(id))
        .filter((comment): comment is Comment => comment !== undefined)
        .map((comment) => ({
          id: comment.id,
          where: describeAnchor(comment.anchor),
          anchor: comment.anchor,
          ...(comment.quote === undefined ? {} : { quote: comment.quote }),
          body: comment.body,
          status: comment.status,
          replies: comment.replies.map((reply) => ({
            author: reply.author.kind,
            body: reply.body,
          })),
        })),
    })),
  }
}

/** A comment's anchor in words, so the agent knows where to look without a lookup table. */
export function describeAnchor(anchor: Anchor): string {
  switch (anchor.kind) {
    case 'plan':
      return 'the plan as a whole'
    case 'section':
      return `plan section "${anchor.heading ?? anchor.section}" (#${anchor.section})`
    case 'phase':
      return `phase ${anchor.node}`
    case 'prompt':
      return `the ${anchor.role} prompt of phase ${anchor.node}`
    case 'gate':
      return anchor.node === undefined
        ? `gate ${anchor.gate}`
        : `gate ${anchor.gate} on phase ${anchor.node}`
  }
}

async function replyCommand(argv: readonly string[], io: Io, deps: ReviewDeps): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        repo: { type: 'string' },
        message: { type: 'string', short: 'm' },
        comment: { type: 'string' },
        resolve: { type: 'boolean' },
        as: { type: 'string' },
      },
      allowPositionals: true,
    })
  } catch {
    io.err(REVIEW_USAGE)
    return USAGE
  }
  const path = parsed.positionals[0]
  const raw = parsed.values.message
  if (path === undefined || parsed.positionals.length > 1 || raw === undefined) {
    io.err(REVIEW_USAGE)
    return USAGE
  }
  if (parsed.values.resolve === true && parsed.values.comment === undefined) {
    io.err('vinta-ai-maestro: --resolve needs --comment <id>')
    return USAGE
  }
  const target = targetOf(path, parsed.values.repo, io)
  if (target === null) return USAGE

  const body = raw === '-' ? await (deps.stdin ?? readStdin)() : raw
  if (body.trim() === '') {
    io.err('vinta-ai-maestro: --message is empty')
    return USAGE
  }
  const author = {
    kind: 'agent' as const,
    ...(parsed.values.as === undefined ? {} : { name: parsed.values.as }),
  }
  const now = new Date((deps.now ?? Date.now)()).toISOString()
  const commentId = parsed.values.comment

  try {
    target.store.update((review) => {
      if (commentId === undefined) return postMessage(review, { body, author }, now)
      const replied = addReply(review, commentId, { body, author }, now)
      return parsed.values.resolve === true ? setCommentStatus(replied, commentId, 'resolved', now) : replied
    })
  } catch (error) {
    if (error instanceof ReviewRefusal) {
      io.err(`vinta-ai-maestro: the reply was not recorded (${error.code})`)
      return FAILED
    }
    throw error
  }
  io.out(commentId === undefined ? 'replied in the conversation' : `replied on ${commentId}`)
  return OK
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer))
  return Buffer.concat(chunks).toString('utf8')
}
