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
import { dirname } from 'node:path'
import { z } from 'zod'
import { amendRun, type AmendRunner } from '../amend/amend.ts'
import type { Journal, NodeRow, RunRow } from '../journal/journal.ts'
import { type Monitor, runDigest } from '../monitor/monitor.ts'
import type { Workflow } from '../types.ts'
import { collectRunCrew } from '../usage/crew.ts'
import { collectRunReuse } from '../usage/reuse.ts'
import { collectRunUsage } from '../usage/usage.ts'
import { parseWorkflow } from '../validate.ts'
import { presentedToken, tokenMatches } from './auth.ts'
import type { DaemonRun } from './control.ts'
import { harnessCapabilities } from './harnesses.ts'
import { createStaticHandler, DEFAULT_UI_DIR } from './static.ts'
import {
  AddContextRequestSchema,
  AnswerRequestSchema,
  HumanQuestionSchema,
  MonitorAskSchema,
  NoArgsRequestSchema,
  RedirectRequestSchema,
  toIssues,
  toWireIssues,
  type AmendResponse,
  type EventPage,
  type MonitorAnswer,
  type Issue,
  type NodeDetail,
  type RunSnapshot,
  type RunSummary,
  type RunUsageResponse,
  type SessionTurn,
  type WorkflowListResponse,
  type WorkflowResponse,
} from './schemas.ts'
import { createWorkflowStore, isWorkflowId, plansDirFor } from './workflows.ts'

/** The last 64 KiB of a gate log. Enough for a failure tail, bounded by design. */
const GATE_LOG_TAIL_BYTES = 64 * 1024

const TranscriptQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  stream: z.enum(['transcript', 'raw']).default('transcript'),
})

/** §13.2's page. Same exclusive `since` as the journal and the socket. */
const EventPageQuerySchema = z.object({
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
})

export interface ApiOptions {
  readonly journal: Journal
  readonly token: string
  /** Live view of the registry — a run registered after start is reachable. */
  readonly runs: ReadonlyMap<string, DaemonRun>
  /** Where the built UI lives. Defaults to this package's `dist/ui`. */
  readonly uiDir?: string
  /**
   * The editable workflow documents (§10's Editor row). Defaults to the
   * project's `ai-plans/` — the directory `plan-feature` writes into and the
   * one `run` is pointed at, so the editor opens the reviewed source rather
   * than a second copy under the gitignored store. Supplying one is for tests
   * and for a project that keeps its plans elsewhere.
   */
  readonly workflowsDir?: string
  /**
   * The run's spokesperson, built on demand (`monitor/monitor.ts`).
   *
   * A factory rather than an instance, and not part of `DaemonRun`, because a
   * monitor is useful for a run that finished days ago — "why did this fail" is
   * asked after the fact more often than during — and a finished run has no
   * registry entry to hang one on. Absent for a host that wired no harness, in
   * which case the endpoint says so instead of pretending.
   */
  readonly monitorFor?: (runId: string) => Monitor | null
}

export function createApi(options: ApiOptions): Hono {
  const { journal, runs } = options
  const workflows = new Map<string, Workflow>()
  // `Journal.root` is `<project>/.vinta-ai-maestro`, so its parent is the checkout.
  // Derived rather than passed because every caller already agrees on the
  // journal, and a second `repoPath` parameter would be a second chance to
  // disagree about which project is being served.
  const store = createWorkflowStore(options.workflowsDir ?? plansDirFor(dirname(journal.root)))
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
    const found = resolveRead(c)
    if ('response' in found) return found.response
    return c.json(snapshot(found.run, found.row, workflow(found.row.id)))
  })

  /**
   * §13.2's replay read: a bounded page of this run's log.
   *
   * Three decisions worth stating.
   *
   * - **The journal alone answers it.** Unlike the snapshot beside it, this
   *   route resolves the run out of `journal.run` rather than the in-memory
   *   registry, because nothing here is live state. A finished run from before
   *   the last daemon restart is exactly the run a reviewer wants to scrub,
   *   and requiring it to still be registered would refuse the main case.
   * - **Bounded here, not in the query.** `Journal.events` has no `LIMIT`; a
   *   bounded read belongs to the journal's owner, and this layer must not
   *   reach past its public API to add one. So the rows are read and the
   *   *response* is sliced: the browser never receives more than `limit`
   *   events, which is the property replay depends on.
   * - **`remaining` instead of a total.** The client needs to know how much
   *   log lies beyond the page, not how long the run was; one subtraction here
   *   saves it a second round trip to find the end.
   */
  app.get('/api/runs/:runId/events', (c) => {
    const runId = c.req.param('runId') ?? ''
    if (journal.run(runId) === undefined) return fail(c, 404, 'unknown_run')

    const query = EventPageQuerySchema.safeParse(c.req.query())
    if (!query.success) return fail(c, 400, 'invalid_request', toIssues(query.error))

    const { since, limit } = query.data
    const after = journal.events(runId, since)
    const page = after.slice(0, limit)
    return c.json({
      runId,
      cursor: page.at(-1)?.id ?? since,
      remaining: after.length - page.length,
      events: page.map((event) => ({
        id: event.id,
        ts: event.ts,
        runId: event.runId,
        nodeId: 'nodeId' in event ? event.nodeId : null,
        type: event.type,
        payload: event.payload,
      })),
    } satisfies EventPage)
  })

  /**
   * §15.6's rollup: what this run's agents cost, and how often reuse engaged.
   *
   * Resolved out of the journal rather than out of `runs`, exactly like the
   * events route above — a finished run's numbers are the ones most worth
   * reading, and requiring a live control port would make them unreachable the
   * moment the run they describe ends.
   *
   * Not part of the snapshot, deliberately. `collectRunUsage` reads every
   * node's transcript in full, and the snapshot is re-read whenever an event
   * lands; folding this into it would put a whole-run file scan behind every
   * agent message.
   */
  app.get('/api/runs/:runId/usage', (c) => {
    const runId = c.req.param('runId') ?? ''
    if (journal.run(runId) === undefined) return fail(c, 404, 'unknown_run')

    const usage = collectRunUsage(journal, runId)
    const reuse = collectRunReuse(journal, runId)
    // The roster the run was started against, so a member who has not worked
    // yet is reported as idle rather than simply absent.
    const declared = Object.keys(workflow(runId).crew)
    const crew = collectRunCrew(journal, runId, declared)
    return c.json({
      runId,
      // Copied rather than passed through: the fold's arrays are `readonly`,
      // and the wire type is the mutable shape `c.json` serializes.
      reuse: { ...reuse.totals, fresh: [...reuse.totals.fresh] },
      crew: {
        members: crew.members.map((member) => ({ ...member })),
        asPlanned: crew.asPlanned,
        substituted: crew.substituted,
        idle: [...crew.idle],
      },
      inputTokens: usage.totals.inputTokens,
      outputTokens: usage.totals.outputTokens,
      sessions: usage.totals.sessions,
      cost: usage.totals.cost,
      cache: usage.totals.cache,
    } satisfies RunUsageResponse)
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
      sessions: sessionTurns(journal, runId, node.node_id),
      question: question(runId, found.run, node),
    }
    return c.json(detail)
  })

  /**
   * Ask the monitor about this run.
   *
   * Deliberately not one of §9's operations: those reach the scheduler and
   * change what a run is doing, and this one changes nothing. It works on a
   * finished run for the same reason it reads the journal — the questions worth
   * asking about a failed run are asked after it has failed.
   *
   * The answer is agent output and goes in a response body, which §11 allows
   * for exactly this case: the operator asked for it, and it is the product.
   * What must not appear is the *refusal* prose if the harness declines —
   * that is a code.
   */
  app.post('/api/runs/:runId/monitor', async (c) => {
    const found = resolveRead(c)
    if ('response' in found) return found.response

    const body = await readBody(c, MonitorAskSchema)
    if ('issues' in body) return fail(c, 400, 'invalid_request', body.issues)

    const monitor = options.monitorFor?.(found.row.id) ?? null
    if (monitor === null) return fail(c, 501, 'monitor_unavailable')

    const digest = runDigest(journal, found.row.id, workflow(found.row.id))
    if (digest === null) return fail(c, 404, 'unknown_run')

    try {
      const answer = await monitor.ask(digest, body.value.text)
      return c.json({ answer, model: monitor.model } satisfies MonitorAnswer)
    } catch {
      // A harness that would not start, a session that would not resume. The
      // kind is on the error and the prose is the vendor's; neither belongs in
      // a browser, so the operator gets a code and the run is untouched.
      return fail(c, 503, 'monitor_unavailable')
    }
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
  // The documents are `ai-plans/<id>.workflow.json`: source, committed, and
  // the same files `vinta-ai-maestro run` takes a path to. A `PUT` therefore rewrites
  // a *reviewed* file in place — atomically, and only after `parseWorkflow`
  // accepts it — and the review of that rewrite is the project's own diff, the
  // same as for the plan beside it. There is no second copy under
  // `.vinta-ai-maestro/` for the editor to drift away from.
  //
  // These are the only *writing* endpoints in this API, and the four rules
  // below are what keeps that from being a hole:
  //
  // - **The same validator the executor uses.** A save runs `parseWorkflow`,
  //   so the editor cannot persist a document the daemon would later refuse to
  //   run. Client-side validation is a courtesy; this is the boundary.
  // - **An id is a filename, and the schema's id rule is the sanitiser.** No
  //   path from a request ever reaches `join` un-checked.
  // - **The filename and the document's `id` must agree, in both directions.**
  //   `plan-feature` names the file after the id and every branch a run cuts is
  //   named from the id, so a file that disagrees with itself is a defect, not
  //   a preference. `PUT` refuses one; `GET` refuses to serve one, because
  //   loading a document the editor could never save back is the worse failure.
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
    if (parsed.workflow.id !== id) {
      return fail(c, 409, 'invalid_workflow', [
        { path: 'id', code: 'id_mismatch', message: 'Workflow id does not match its filename' },
      ])
    }
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
  function question(runId: string, run: DaemonRun | null, node: NodeRow): NodeDetail['question'] {
    if (node.status !== 'awaiting_human') return null
    // The journal is authoritative and survives the daemon; the live control
    // port is the escape hatch for a host that parked a node without
    // journalling the pause, and a finished run simply has none.
    const raw =
      journal.pendingQuestion(runId, node.node_id)?.question ??
      run?.control.question?.(node.node_id)
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

  /**
   * A run to *read*. The journal is the whole answer.
   *
   * `runs` is an in-memory registry filled as a run starts, so it holds only
   * what is live — and this used to require an entry in it *and* a journal row,
   * which meant every finished run answered 404. The list endpoint reads the
   * journal, so a daemon started with nothing running would show the operator
   * their history and then refuse to open any of it.
   *
   * The store outlives the daemon by design (§5.3). A finished run is exactly
   * as readable as a live one; what it no longer has is a scheduler to talk to,
   * which is `resolveLive`'s problem and not a reader's.
   */
  function resolveRead(c: Context): { run: DaemonRun | null; row: RunRow } | { response: Response } {
    const runId = c.req.param('runId') ?? ''
    const row = journal.run(runId)
    if (row === undefined) return { response: fail(c, 404, 'unknown_run') }
    return { run: runs.get(runId) ?? null, row }
  }

  function resolveNode(
    c: Context,
  ): { run: DaemonRun | null; runId: string; node: NodeRow } | { response: Response } {
    const found = resolveRead(c)
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
    // Reading a finished node is fine; steering one is not — there is no
    // scheduler left to receive the instruction. It refuses with 409 rather
    // than 404 because the run *does* exist: answering "unknown" would send the
    // operator hunting for a typo instead of reading the status in front of
    // them.
    if (found.run === null) return fail(c, 409, 'run_not_live')

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

  /**
   * A run as the UI draws it. `run` is null for a finished one.
   *
   * Everything structural — nodes, edges, statuses, leases — comes from the
   * journal either way. What the live handle adds is the in-flight counters,
   * and for a finished run those are not unknown, they are *zero*: nothing is
   * held, nothing is queued, nothing is waiting on a backoff. The capacities
   * beside them come from the frozen workflow, which is what they were
   * configured to be for the whole of that run.
   */
  function snapshot(run: DaemonRun | null, row: RunRow, wf: Workflow): RunSnapshot {
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
        capacity: run === null ? resource.capacity : run.pools.capacity(id),
        held: run === null ? 0 : run.pools.held(id),
        holders: leases.filter((lease) => lease.resource === id).map((lease) => lease.holder_node),
      })),
      gateQueue: {
        waiting: run === null ? 0 : run.pools.waiting,
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
        // A finished run has no admission control to ask. Its ceiling was the
        // lane capacity the plan declared — the number `run` is given at boot —
        // and nothing is in flight under it any more.
        ceiling: run === null ? (wf.resources['lane']?.capacity ?? 0) : run.admission.ceiling(id),
        inFlight: run === null ? 0 : run.admission.inFlight(id),
        wakeAt: run === null ? null : (run.admission.wakeAt(id) ?? null),
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

/**
 * §15's session decisions for one node, oldest first.
 *
 * The journal stores each row as the scheduler wrote it, and this narrows that
 * to the wire shape: a slot, a disposition, and the identifier or the reason
 * token that goes with it. A row whose payload does not parse is dropped rather
 * than served half-read — the panel is a diagnostic, and a diagnostic that
 * invents a value is worse than one with a gap.
 */
function sessionTurns(journal: Journal, runId: string, nodeId: string): SessionTurn[] {
  const turns: SessionTurn[] = []
  for (const event of journal.sessionHistory(runId, nodeId)) {
    const payload = SessionPayloadSchema.safeParse(event.payload)
    if (!payload.success) continue
    const { slot, disposition, session_id, reason } = payload.data
    turns.push({
      slot,
      disposition,
      at: event.ts,
      ...(session_id === undefined ? {} : { sessionId: session_id }),
      ...(reason === undefined ? {} : { reason }),
    })
  }
  return turns
}

/** The journal payload, read back off disk — hence parsed rather than cast. */
const SessionPayloadSchema = z.object({
  slot: z.string(),
  disposition: z.enum(['reused', 'fresh']),
  session_id: z.string().optional(),
  reason: z.string().optional(),
})

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

/**
 * `501` and `503` are here for one endpoint: a host that wired no harness has
 * no monitor to offer, and a harness that will not start is a failure of
 * something behind this API rather than of the request. Both are distinct from
 * "your request was wrong", which is what the other four say.
 */
function fail(
  c: Context,
  status: 400 | 401 | 404 | 409 | 501 | 503,
  error: string,
  issues?: Issue[],
): Response {
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
