/**
 * The HTTP surface: commands and snapshots (§10's transport split).
 *
 * Everything here is a projection. The journal is the source of truth for
 * every read — node rows, leases, transcripts, gate logs — and the five
 * operations of §9 are forwarded to the run's `RunControl`. This module holds
 * no state of its own beyond a cache of the frozen workflow snapshot, which
 * cannot change for the life of a run by construction (§5.3).
 *
 * The rules that shaped the endpoint list:
 *
 * - **Refs, not renderings.** A node's detail carries the *reference* a diff
 *   needs — branch, base, lane — not a diff. Running git in a lane belongs to
 *   the git unit; an API that shelled out here would be a second place that
 *   knows how phase branches are named.
 * - **Tails, not pages.** Transcripts and gate logs are append-only files that
 *   reach megabytes. `Journal` reads them backwards from the end, and so does
 *   this: the last `limit` entries, and the last 64 KiB of a gate log.
 * - **Nothing is logged.** Transcript content is served — that is the product —
 *   but no request body, no response body and no thrown message reaches a log
 *   line or an error body. A failed operation answers with a code.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { amendRun, type AmendRunner } from '../amend/amend.ts'
import type { Journal, NodeRow, RunRow } from '../journal/journal.ts'
import type { Workflow } from '../types.ts'
import { parseWorkflow } from '../validate.ts'
import { presentedToken, tokenMatches } from './auth.ts'
import type { DaemonRun } from './control.ts'
import { harnessCapabilities } from './harnesses.ts'
import { createStaticHandler, DEFAULT_UI_DIR } from './static.ts'
import {
  AddContextRequestSchema,
  AnswerRequestSchema,
  HumanQuestionSchema,
  NoArgsRequestSchema,
  RedirectRequestSchema,
  toIssues,
  toWireIssues,
  type AmendResponse,
  type Issue,
  type NodeDetail,
  type RunSnapshot,
  type RunSummary,
  type WorkflowListResponse,
  type WorkflowResponse,
} from './schemas.ts'
import { createWorkflowStore, isWorkflowId, WORKFLOWS_DIRNAME } from './workflows.ts'

/** The last 64 KiB of a gate log. Enough for a failure tail, bounded by design. */
const GATE_LOG_TAIL_BYTES = 64 * 1024

const TranscriptQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  stream: z.enum(['transcript', 'raw']).default('transcript'),
})

export interface ApiOptions {
  readonly journal: Journal
  readonly token: string
  /** Live view of the registry — a run registered after start is reachable. */
  readonly runs: ReadonlyMap<string, DaemonRun>
  /** Where the built UI lives. Defaults to this package's `dist/ui`. */
  readonly uiDir?: string
  /**
   * The editable workflow documents (§10's Editor row). Defaults to
   * `<store>/workflows`; supplying one is for tests and for a project that
   * keeps its plans elsewhere.
   */
  readonly workflowsDir?: string
}

export function createApi(options: ApiOptions): Hono {
  const { journal, runs } = options
  const workflows = new Map<string, Workflow>()
  const store = createWorkflowStore(options.workflowsDir ?? join(journal.root, WORKFLOWS_DIRNAME))
  const ui = createStaticHandler(options.uiDir ?? DEFAULT_UI_DIR)
  const app = new Hono()

  /**
   * The app shell, before the token check and only ever before it (§10).
   *
   * The reasoning for serving these bytes unauthenticated is in `static.ts`.
   * What matters here is the boundary: this middleware declines every path
   * under `/api` and the WebSocket path, so the one route that does not
   * require a token cannot become a way to reach a route that does. Everything
   * it can answer with comes out of the UI directory.
   */
  app.use('*', async (c, next) => {
    const path = new URL(c.req.url).pathname
    if (path === '/api' || path.startsWith('/api/') || path === '/ws') return await next()
    const method = c.req.method
    if (method !== 'GET' && method !== 'HEAD') return await next()
    return ui(path, method)
  })

  /** §11: every request, without exception, including the ones that 404. */
  app.use('*', async (c, next) => {
    const presented = presentedToken(c.req.header('authorization'), new URL(c.req.url))
    if (!tokenMatches(options.token, presented)) return fail(c, 401, 'unauthorized')
    await next()
  })

  app.notFound((c) => fail(c, 404, 'not_found'))

  /**
   * Every run on disk, not every run this process started (§5.3). The journal
   * outlives the daemon; a list drawn from the in-memory registry would report
   * a restarted machine as one with no history.
   */
  app.get('/api/runs', (c) => {
    return c.json({ runs: journal.runs().map(runSummary) satisfies RunSummary[] })
  })

  app.get('/api/runs/:runId', (c) => {
    const found = resolveRun(c)
    if ('response' in found) return found.response
    return c.json(snapshot(found.run, found.row, workflow(found.run.runId)))
  })

  app.get('/api/runs/:runId/nodes/:nodeId', (c) => {
    const found = resolveNode(c)
    if ('response' in found) return found.response

    const query = TranscriptQuerySchema.safeParse(c.req.query())
    if (!query.success) return fail(c, 400, 'invalid_request', toIssues(query.error))

    const { runId, node } = found
    const { limit, stream } = query.data
    const declared = workflow(runId).nodes.find((candidate) => candidate.id === node.node_id)
    const gates: { gateId: string; log: string }[] = []
    for (const gateId of declared?.gates ?? []) {
      const log = tailFile(journal.gateLogPath(runId, node.node_id, gateId), GATE_LOG_TAIL_BYTES)
      if (log !== null) gates.push({ gateId, log })
    }

    const detail: NodeDetail = {
      runId,
      node: nodeSummary(node, declared?.name ?? node.node_id),
      diff: { branch: node.branch, baseBranch: node.base_branch, lane: node.lane },
      transcript: {
        stream,
        entries: journal.tailTranscript(runId, node.node_id, limit, stream),
      },
      gates,
      question: question(runId, found.run, node),
    }
    return c.json(detail)
  })

  // The five operations of §9. Each one validates its body, forwards to the
  // run's control port, and answers with a code — never with what went wrong
  // inside, which is the one place agent output could leak into a response.
  app.post('/api/runs/:runId/nodes/:nodeId/context', (c) =>
    operate(c, AddContextRequestSchema, (run, nodeId, body) =>
      run.control.addContext(nodeId, body.text),
    ),
  )

  app.post('/api/runs/:runId/nodes/:nodeId/redirect', (c) =>
    operate(c, RedirectRequestSchema, (run, nodeId, body) =>
      run.control.redirect(nodeId, body.instruction),
    ),
  )

  app.post('/api/runs/:runId/nodes/:nodeId/pause', (c) =>
    operate(c, NoArgsRequestSchema, (run, nodeId) => run.control.pause(nodeId)),
  )

  app.post('/api/runs/:runId/nodes/:nodeId/abort', (c) =>
    operate(c, NoArgsRequestSchema, (run, nodeId) => run.control.abortNode(nodeId)),
  )

  /** §9.1 — the answer enters the guard context as `human.answer`. */
  app.post('/api/runs/:runId/nodes/:nodeId/answer', (c) =>
    operate(c, AnswerRequestSchema, (run, nodeId, body) =>
      run.control.answer(nodeId, { human: { answer: body.answer } }),
    ),
  )

  // -------------------------------------------------------------------------
  // Workflows — the documents §10's Editor row edits.
  //
  // These are the only *writing* endpoints in this API, and the three rules
  // below are what keeps that from being a hole:
  //
  // - **The same validator the executor uses.** A save runs `parseWorkflow`,
  //   so the editor cannot persist a document the daemon would later refuse to
  //   run. Client-side validation is a courtesy; this is the boundary.
  // - **An id is a filename, and the schema's id rule is the sanitiser.** No
  //   path from a request ever reaches `join` un-checked.
  // - **A save that reaches a live run is an amendment, not an edit.** §9's
  //   amend path owns that: it refuses while any affected node is in flight,
  //   rebases the `done` nodes whose base moved, and journals what it did. The
  //   refusal comes back located, like every other refusal here.
  // -------------------------------------------------------------------------

  app.get('/api/workflows', (c) => {
    return c.json({
      workflows: store.list().map((id) => ({ id })),
    } satisfies WorkflowListResponse)
  })

  app.get('/api/workflows/:id', (c) => {
    const id = c.req.param('id') ?? ''
    if (!isWorkflowId(id)) return fail(c, 404, 'unknown_workflow')

    const read = store.read(id)
    if (!read.ok) {
      return read.reason === 'missing'
        ? fail(c, 404, 'unknown_workflow')
        : fail(c, 409, 'invalid_workflow', [
            { path: '', code: 'invalid_json', message: 'Workflow file is not valid JSON' },
          ])
    }

    const parsed = parseWorkflow(read.value)
    if (!parsed.ok) return fail(c, 409, 'invalid_workflow', toWireIssues(parsed.issues))
    return c.json({ id, workflow: parsed.workflow } satisfies WorkflowResponse)
  })

  app.put('/api/workflows/:id', async (c) => {
    const id = c.req.param('id') ?? ''
    if (!isWorkflowId(id)) return fail(c, 400, 'invalid_workflow_id')

    const text = await c.req.text()
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return fail(c, 400, 'invalid_workflow', [
        { path: '', code: 'invalid_json', message: 'Body is not valid JSON' },
      ])
    }

    const parsed = parseWorkflow(raw)
    if (!parsed.ok) return fail(c, 400, 'invalid_workflow', toWireIssues(parsed.issues))
    if (parsed.workflow.id !== id) {
      return fail(c, 400, 'invalid_workflow', [
        { path: 'id', code: 'id_mismatch', message: 'Workflow id does not match the path' },
      ])
    }
    // §9's amend. A run in flight has its own frozen snapshot and its own
    // rules about which nodes may still change, so a save that reaches one is
    // routed through `src/amend/` rather than refused: it classifies what
    // moved, refuses while any affected node is in flight, rebases the `done`
    // nodes whose base moved, and journals what it did. The source document is
    // written only after the run took the change — a saved document the run
    // refused would be a plan the editor shows and the daemon is not running.
    const live = journal.runs().find((row) => row.workflow_id === id && row.status === 'running')
    if (live !== undefined) {
      const runner = amendRunner(runs.get(live.id))
      const result = await amendRun({
        journal,
        runId: live.id,
        proposed: parsed.workflow,
        ...(runner === undefined ? {} : { runner }),
      })
      if (!result.ok) {
        return fail(c, 409, result.code, toWireIssues(result.issues, result.code))
      }
      // The run's definition moved, so the cached snapshot has to.
      workflows.set(live.id, result.workflow)
      try {
        store.write(id, result.workflow)
      } catch {
        return fail(c, 409, 'write_failed')
      }
      return c.json({
        ok: true,
        amendment: result.amendment,
        runId: live.id,
        changes: result.changes.map((change) => ({ node: change.node, kind: change.kind })),
        affected: [...result.affected],
        applied: [...result.applied],
        rebased: [...result.rebased],
      } satisfies AmendResponse)
    }

    try {
      store.write(id, parsed.workflow)
    } catch {
      // A code, never the path or the bytes (§11).
      return fail(c, 409, 'write_failed')
    }
    return c.json({ ok: true })
  })

  return app

  // -------------------------------------------------------------------------

  /**
   * §9.1's question. The journal is asked first and the host second: the
   * pending question is projected from the `human_question` event, which is
   * what makes it outlive a daemon restart and a UI reload alike. Validated on
   * the way out either way — a shape the UI cannot rely on is worse than none.
   */
  function question(runId: string, run: DaemonRun, node: NodeRow): NodeDetail['question'] {
    if (node.status !== 'awaiting_human') return null
    const raw =
      journal.pendingQuestion(runId, node.node_id)?.question ??
      run.control.question?.(node.node_id)
    if (raw === undefined) return null
    const parsed = HumanQuestionSchema.safeParse(raw)
    return parsed.success ? parsed.data : null
  }

  /**
   * §9's amend, as the run can drive it.
   *
   * `RunControl.statuses` is the live view every registered run already
   * publishes, so the gate reads it whether or not the host wired an
   * integration worktree — a host that cannot rebase can still refuse
   * correctly, which is the half that matters for safety. Anything the host
   * *did* supply wins over it.
   */
  function amendRunner(run: DaemonRun | undefined): AmendRunner | undefined {
    if (run === undefined) return undefined
    return { statuses: () => run.control.statuses, ...run.amend }
  }

  function workflow(runId: string): Workflow {
    const cached = workflows.get(runId)
    if (cached !== undefined) return cached
    // Frozen at run start (§5.3), so caching it cannot go stale.
    const read = journal.readWorkflow(runId)
    workflows.set(runId, read)
    return read
  }

  function resolveRun(c: Context): { run: DaemonRun; row: RunRow } | { response: Response } {
    const runId = c.req.param('runId') ?? ''
    const run = runs.get(runId)
    const row = journal.run(runId)
    if (run === undefined || row === undefined) return { response: fail(c, 404, 'unknown_run') }
    return { run, row }
  }

  function resolveNode(
    c: Context,
  ): { run: DaemonRun; runId: string; node: NodeRow } | { response: Response } {
    const found = resolveRun(c)
    if ('response' in found) return found
    const nodeId = c.req.param('nodeId') ?? ''
    const node = journal.nodes(found.row.id).find((row) => row.node_id === nodeId)
    if (node === undefined) return { response: fail(c, 404, 'unknown_node') }
    return { run: found.run, runId: found.row.id, node }
  }

  async function operate<T>(
    c: Context,
    schema: z.ZodType<T>,
    apply: (run: DaemonRun, nodeId: string, body: T) => unknown,
  ): Promise<Response> {
    const found = resolveNode(c)
    if ('response' in found) return found.response

    const body = await readBody(c, schema)
    if ('issues' in body) return fail(c, 400, 'invalid_request', body.issues)

    try {
      await apply(found.run, found.node.node_id, body.value)
    } catch {
      // Codes only. The thrown message belongs to a harness or a scheduler and
      // is not this layer's to relay into a browser.
      return fail(c, 409, 'operation_failed')
    }
    return c.json({ ok: true })
  }

  function snapshot(run: DaemonRun, row: RunRow, wf: Workflow): RunSnapshot {
    // Read before the projections below, so the cursor can only lag what this
    // snapshot shows. A client resuming from it may replay an event it already
    // sees the effect of — the fold is idempotent — but can never miss one.
    const cursor = journal.lastEventId(row.id)
    const nodes = journal.nodes(row.id)
    const names = new Map(wf.nodes.map((node) => [node.id, node.name]))
    const mine = new Set(nodes.map((node) => node.node_id))
    const leases = journal.leases().filter((lease) => mine.has(lease.holder_node))

    const gatePools = new Set<string>()
    for (const gate of Object.values(wf.gates)) {
      for (const resource of gate.requires) gatePools.add(resource)
    }

    return {
      run: runSummary(row),
      cursor,
      nodes: nodes.map((node) => nodeSummary(node, names.get(node.node_id) ?? node.node_id)),
      // The graph's edges come from the frozen workflow, which is the only
      // place they exist: a dependency is plan structure, not run state, so no
      // event carries one and no node row could.
      edges: wf.nodes.flatMap((node) =>
        node.depends_on.map((dependency) => ({
          from: dependency.node,
          to: node.id,
          artifact: dependency.artifact,
        })),
      ),
      resources: Object.entries(wf.resources).map(([id, resource]) => ({
        id,
        kind: resource.kind,
        capacity: run.pools.capacity(id),
        held: run.pools.held(id),
        holders: leases.filter((lease) => lease.resource === id).map((lease) => lease.holder_node),
      })),
      gateQueue: {
        waiting: run.pools.waiting,
        holders: leases
          .filter((lease) => gatePools.has(lease.resource))
          .map((lease) => ({
            resource: lease.resource,
            nodeId: lease.holder_node,
            acquiredAt: lease.acquired_at,
          })),
      },
      harnesses: [...new Set(nodes.map((node) => node.harness))].sort().map((id) => ({
        id,
        ceiling: run.admission.ceiling(id),
        inFlight: run.admission.inFlight(id),
        wakeAt: run.admission.wakeAt(id) ?? null,
        // Read off the adapter, never restated — see `harnesses.ts`.
        capabilities: harnessCapabilities(id),
      })),
    }
  }
}

function runSummary(row: RunRow): RunSummary {
  return {
    runId: row.id,
    workflowId: row.workflow_id,
    status: row.status,
    baseBranch: row.base_branch,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  }
}

function nodeSummary(row: NodeRow, name: string): RunSnapshot['nodes'][number] {
  return {
    nodeId: row.node_id,
    name,
    status: row.status,
    wave: row.wave,
    lane: row.lane,
    branch: row.branch,
    baseBranch: row.base_branch,
    harness: row.harness,
    sessionId: row.session_id,
  }
}

/** An absent body reads as `{}` so a no-argument POST needs no payload. */
async function readBody<T>(
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

function fail(c: Context, status: 400 | 401 | 404 | 409, error: string, issues?: Issue[]): Response {
  return c.json({ error, issues: issues ?? null }, status)
}

/** The last `bytes` of a file, dropping the partial first line. Null if absent. */
function tailFile(path: string, bytes: number): string | null {
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return null
  }
  const start = Math.max(0, size - bytes)
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(size - start)
    if (buffer.length > 0) readSync(fd, buffer, 0, buffer.length, start)
    const text = buffer.toString('utf8')
    return start === 0 ? text : text.slice(text.indexOf('\n') + 1)
  } finally {
    closeSync(fd)
  }
}
