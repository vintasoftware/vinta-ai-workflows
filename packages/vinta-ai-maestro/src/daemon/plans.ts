/**
 * The review page's half of the wire (§19): plans that have not run.
 *
 * Every other read in this daemon is a projection of the journal. These are
 * not — a plan under review has no run, so they read the committed files in
 * `ai-plans/` the way the editor's routes do, and write only the review file
 * beside them. The token check in `api.ts` covers them like everything else.
 *
 * Three rules, all enforced here:
 *
 * - **Ids are the workflow schema's.** Kebab-case, so a request can never name
 *   a path; that is the whole traversal defence for the files this module
 *   opens by id. The references *inside* a workflow are a second way to name a
 *   path, and `review/references.ts` holds those inside the repository.
 * - **Nothing a person wrote reaches a log or an error body.** Comments are
 *   prose about a repository. A refusal answers with a code.
 * - **The browser never authors as the agent.** Every write here is a person's
 *   (`kind: 'human'`); the agent writes through `vinta-ai-maestro review reply`.
 *   A page that could post as the agent would let a person put words in its
 *   mouth that the agent then reads back as its own.
 */
import type { Context, Hono } from 'hono'
import { join } from 'node:path'
import { z } from 'zod'
import {
  addComment,
  addReply,
  approve,
  buildPlanView,
  createReviewStore,
  deleteDraft,
  inspectWorkflow,
  planStamp,
  postMessage,
  readContained,
  repoRelative,
  ReviewRefusal,
  setCommentStatus,
  unsentThreads,
  WORKFLOW_FILE_SUFFIX,
  type PlanReview,
  type ReviewStore,
} from '../review/index.ts'
import { simulate } from '../simulate/index.ts'
import {
  ChatRequestSchema,
  CommentRequestSchema,
  CommentStatusRequestSchema,
  formatPath,
  NoArgsRequestSchema,
  ReplyRequestSchema,
  toIssues,
  type Issue,
  type PlanListResponse,
  type PlanReviewResponse,
  type PlanScheduleResponse,
  type PlanViewResponse,
} from './schemas.ts'
import { isWorkflowId, type WorkflowStore } from './workflows.ts'

export interface PlanRoutesOptions {
  /** The checkout: where references resolve and `.vinta-ai-workflows.yaml` lives. */
  readonly repoDir: string
  /** `<repo>/.vinta-ai-maestro` — where presence and the lock live. */
  readonly stateRoot: string
  /** The editor's store: the same `ai-plans/` listing, so the two never disagree. */
  readonly workflows: WorkflowStore
}

const HUMAN = { kind: 'human' } as const

export function registerPlanRoutes(app: Hono, options: PlanRoutesOptions): void {
  const { repoDir, workflows } = options
  const plansDir = workflows.dir

  function storeFor(id: string): ReviewStore {
    return createReviewStore({ plansDir, stateRoot: options.stateRoot, workflowId: id })
  }

  /** The id from the path, if it names a workflow on disk. */
  function known(c: Context): string | null {
    const id = c.req.param('id') ?? ''
    return isWorkflowId(id) && workflows.list().includes(id) ? id : null
  }

  app.get('/api/plans', async (c) => {
    const plans: PlanListResponse['plans'] = []
    for (const id of workflows.list()) {
      const inspected = await inspectWorkflow(repoDir, join(plansDir, `${id}${WORKFLOW_FILE_SUFFIX}`), id)
      const workflow = inspected.ok ? inspected.workflow : null
      const planRef = workflow?.plan_ref ?? null
      const markdown = planRef === null ? null : readContained(repoDir, planRef)
      const read = storeFor(id).read()
      const review = read.ok ? read.review : null
      plans.push({
        id,
        title: markdown === null ? null : (/^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? null),
        planRef,
        phases: workflow?.nodes.length ?? null,
        valid: inspected.ok && inspected.issues.length === 0,
        status: review?.status ?? 'open',
        openComments: review?.comments.filter((comment) => comment.status === 'open').length ?? 0,
        unsentComments: review === null ? 0 : unsentThreads(review).length,
      })
    }
    return c.json({ plans } satisfies PlanListResponse)
  })

  app.get('/api/plans/:id', async (c) => {
    const id = known(c)
    if (id === null) return fail(c, 404, 'unknown_plan')
    const stamp = planStamp(repoDir, plansDir, id) ?? ''
    const built = await buildPlanView(repoDir, plansDir, id)
    if (!built.ok) {
      return built.reason === 'missing'
        ? fail(c, 404, 'unknown_plan')
        : fail(c, 409, 'invalid_workflow', [
            { path: '', code: 'invalid_json', message: 'Workflow file is not valid JSON' },
          ])
    }
    const { view } = built
    const phases: PlanViewResponse['phases'] = {}
    for (const [nodeId, materials] of Object.entries(view.phases)) {
      phases[nodeId] = {
        brief: materials.brief,
        prompts: {
          implementer: materials.prompts.implementer ?? null,
          reviewer: materials.prompts.reviewer ?? null,
          fixer: materials.prompts.fixer ?? null,
        },
        chores: { ...materials.chores },
        error: materials.error,
      }
    }
    return c.json({
      id,
      stamp,
      workflow: view.workflow,
      valid: view.valid,
      issues: view.issues.map((issue) => ({
        path: formatPath(issue.path),
        source: issue.source,
        message: issue.message,
      })),
      waves: { ...view.waves },
      plan: view.plan,
      phases,
    } satisfies PlanViewResponse)
  })

  app.get('/api/plans/:id/review', (c) => {
    const id = known(c)
    if (id === null) return fail(c, 404, 'unknown_plan')
    const store = storeFor(id)
    const read = store.read()
    if (!read.ok) return fail(c, 409, 'invalid_review')
    return c.json(reviewResponse(id, store, read.review))
  })

  /**
   * §13.1's projection over the plan as written. Lazy — the page asks only
   * when the schedule is opened — because it drives the real scheduler over a
   * throwaway journal, which is cheap but not free.
   */
  app.get('/api/plans/:id/schedule', async (c) => {
    const id = known(c)
    if (id === null) return fail(c, 404, 'unknown_plan')
    const inspected = await inspectWorkflow(repoDir, join(plansDir, `${id}${WORKFLOW_FILE_SUFFIX}`), id)
    if (!inspected.ok || inspected.workflow === null) return fail(c, 409, 'invalid_workflow')
    // Reference issues do not stop a projection — it never reads a brief —
    // but a graph the validator refused might not even schedule.
    if (inspected.issues.some((issue) => issue.source !== 'reference')) {
      return fail(c, 409, 'invalid_workflow')
    }
    let report
    try {
      report = await simulate({ workflow: inspected.workflow })
    } catch {
      return fail(c, 409, 'projection_stalled')
    }
    return c.json({
      status: report.status,
      projectedMs: report.projectedMs,
      nodes: report.nodes.map((node) => ({
        id: node.id,
        wave: node.wave,
        startedAtMs: node.startedAtMs,
        finishedAtMs: node.finishedAtMs,
        busyMs: node.busyMs,
        queueMs: node.queueMs,
      })),
      criticalPath: report.criticalPath.map((step) => step.nodeId),
    } satisfies PlanScheduleResponse)
  })

  app.post('/api/plans/:id/comments', async (c) => {
    const id = known(c)
    if (id === null) return fail(c, 404, 'unknown_plan')
    const body = await readJson(c, CommentRequestSchema)
    if ('issues' in body) return fail(c, 400, 'invalid_request', body.issues)
    const { anchor, body: text, quote } = body.value
    return change(c, id, (review, now) =>
      addComment(review, { anchor, body: text, author: HUMAN, ...(quote === undefined ? {} : { quote }) }, now),
    )
  })

  app.post('/api/plans/:id/comments/:commentId/replies', async (c) => {
    const id = known(c)
    if (id === null) return fail(c, 404, 'unknown_plan')
    const body = await readJson(c, ReplyRequestSchema)
    if ('issues' in body) return fail(c, 400, 'invalid_request', body.issues)
    const commentId = c.req.param('commentId') ?? ''
    return change(c, id, (review, now) =>
      addReply(review, commentId, { body: body.value.body, author: HUMAN }, now),
    )
  })

  app.put('/api/plans/:id/comments/:commentId/status', async (c) => {
    const id = known(c)
    if (id === null) return fail(c, 404, 'unknown_plan')
    const body = await readJson(c, CommentStatusRequestSchema)
    if ('issues' in body) return fail(c, 400, 'invalid_request', body.issues)
    const commentId = c.req.param('commentId') ?? ''
    return change(c, id, (review, now) => setCommentStatus(review, commentId, body.value.status, now))
  })

  app.delete('/api/plans/:id/comments/:commentId', (c) => {
    const id = known(c)
    if (id === null) return fail(c, 404, 'unknown_plan')
    const commentId = c.req.param('commentId') ?? ''
    return change(c, id, (review) => deleteDraft(review, commentId))
  })

  app.post('/api/plans/:id/messages', async (c) => {
    const id = known(c)
    if (id === null) return fail(c, 404, 'unknown_plan')
    const body = await readJson(c, ChatRequestSchema)
    if ('issues' in body) return fail(c, 400, 'invalid_request', body.issues)
    return change(c, id, (review, now) =>
      postMessage(review, { body: body.value.body, author: HUMAN, send: body.value.send }, now),
    )
  })

  app.post('/api/plans/:id/approve', async (c) => {
    const id = known(c)
    if (id === null) return fail(c, 404, 'unknown_plan')
    const body = await readJson(c, NoArgsRequestSchema)
    if ('issues' in body) return fail(c, 400, 'invalid_request', body.issues)
    return change(c, id, (review, now) => approve(review, HUMAN, now))
  })

  /** One locked read-modify-write, answered with the review as it now is. */
  function change(
    c: Context,
    id: string,
    mutate: (review: PlanReview, now: string) => PlanReview,
  ): Response {
    const store = storeFor(id)
    let written: PlanReview
    try {
      written = store.update((review) => mutate(review, new Date().toISOString()))
    } catch (error) {
      if (!(error instanceof ReviewRefusal)) throw error
      const status = error.code === 'unknown_comment' ? 404 : 409
      return fail(c, status, error.code)
    }
    return c.json(reviewResponse(id, store, written))
  }

  function reviewResponse(id: string, store: ReviewStore, review: PlanReview): PlanReviewResponse {
    return {
      id,
      stamp: planStamp(repoDir, plansDir, id) ?? '',
      path: repoRelative(repoDir, store.path),
      review,
      presence: store.presence(),
    }
  }
}

function fail(c: Context, status: 400 | 404 | 409, error: string, issues?: Issue[]): Response {
  return c.json({ error, issues: issues ?? null }, status)
}

async function readJson<T>(
  c: Context,
  schema: z.ZodType<T>,
): Promise<{ value: T } | { issues: Issue[] }> {
  const text = await c.req.text()
  let raw: unknown = {}
  if (text.trim() !== '') {
    try {
      raw = JSON.parse(text)
    } catch {
      return { issues: [{ path: '', code: 'invalid_json', message: 'Body is not valid JSON' }] }
    }
  }
  const parsed = schema.safeParse(raw)
  return parsed.success ? { value: parsed.data } : { issues: toIssues(parsed.error) }
}
