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
 *   knows how phase branches are named. The changes endpoint keeps to that:
 *   it hands `integration/changes.ts` the branch, the base and the lane's
 *   path off the journal row, and serves what comes back.
 * - **Tails, not pages.** Transcripts and gate logs are append-only files that
 *   reach megabytes. `Journal` reads them backwards from the end, and so does
 *   this: the last `limit` entries, and the last 64 KiB of a gate log.
 * - **Nothing is logged.** Transcript content is served — that is the product —
 *   but no request body, no response body and no thrown message reaches a log
 *   line or an error body. A failed operation answers with a code.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { randomUUID } from 'node:crypto'
import { closeSync, createWriteStream, openSync, readSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { amendRun, type AmendRunner } from '../amend/amend.ts'
import { laneRootFor } from '../cli/paths.ts'
import { describeChanges } from '../integration/changes.ts'
import { prNumberOf } from '../integration/pr.ts'
import type { Journal, NodeRow, RunRow } from '../journal/journal.ts'
import {
  LEVELS,
  MAX_PAGE,
  activePath,
  errorFields,
  logDirFor,
  nullLogger,
  readAfter,
  readTail,
  type Logger,
} from '../log/index.ts'
import { MONITOR_ROLE } from '../journal/transcript.ts'
import { type AgentAsk, AgentAskSchema, encodeAnswers } from '../questions/agent-questions.ts'
import { MONITOR_NODE, type Monitor, runDigest } from '../monitor/monitor.ts'
import { CODEGEN_GATE_PREFIX, WorkflowSchema, type Workflow } from '../types.ts'
import { codegenPools } from '../codegen/codegen.ts'
import type { Actor } from '../journal/events.ts'
import { CoordinatorForbidden } from '../coordinator/actor.ts'
import { execHolder } from '../coordinator/exec.ts'
import { coordinatorRefusals } from '../coordinator/policy.ts'
import { describeUnattended, runAgentDetails, unattendedDecisions } from '../decisions/index.ts'
import { ReassignRefused, StepRefused } from '../scheduler/index.ts'
import { collectRunCrew } from '../usage/crew.ts'
import { collectRunReuse } from '../usage/reuse.ts'
import { collectRunUsage } from '../usage/usage.ts'
import { AgentGateRefusal } from '../resources/agent-gates.ts'
import { AgentLeaseRefusal, type AgentLeaseHeld } from '../resources/agent-leases.ts'
import { loadProjectConfig } from '../config/project-config.ts'
import { ownDocument } from '../config/own.ts'
import { resolveWorkflow } from '../config/resolve.ts'
import type { Upstream, UpstreamFor } from './proxy.ts'
import { presentedToken, tokenMatches } from './auth.ts'
import {
  UnknownHarness,
  UnsupportedOperation,
  type DaemonRun,
  type RunStartPort,
  type RunStartRefusal,
} from './control.ts'
import { harnessCapabilities } from './harnesses.ts'
import { createStaticHandler, DEFAULT_UI_DIR } from './static.ts'
import {
  AddContextRequestSchema,
  FixerReassignRequestSchema,
  MAX_REASON_CHARS,
  REASON_HEADER,
  ReassignRequestSchema,
  StepRequestSchema,
  SwitchHarnessRequestSchema,
  AgentGateRequestSchema,
  GateCacheInvalidateSchema,
  GuardRequestSchema,
  PermissionRequestSchema,
  AgentLeaseRequestSchema,
  AnswerRequestSchema,
  HumanQuestionSchema,
  MonitorAskSchema,
  NoArgsRequestSchema,
  ExecRequestSchema,
  PropagateRequestSchema,
  SyncBaseRequestSchema,
  OperationResponseSchema,
  RedirectRequestSchema,
  StartRunRequestSchema,
  toIssues,
  toWireIssues,
  AmendResponseSchema,
  ErrorResponseSchema,
  type AmendResponse,
  type AgentGateResultResponse,
  type AgentGateWaitingResponse,
  type AgentLeaseGrantResponse,
  type AgentLeaseWaitingResponse,
  type HaltResponse,
  type NodeActivity,
  type ResourceHolder,
  type EventPage,
  type LogPage,
  type MonitorAsked,
  type Issue,
  type NodeChanges,
  type NodeDetail,
  type RunSnapshot,
  type RunSummary,
  type RunUsageResponse,
  type UnattendedResponse,
  type SessionTurn,
  type StartRunResponse,
  type WorkflowListResponse,
  type WorkflowResponse,
} from './schemas.ts'
import { registerPlanRoutes } from './plans.ts'
import { createWorkflowStore, isWorkflowId, plansDirFor } from './workflows.ts'

/**
 * How long one lease request waits before answering "not yet".
 *
 * Short enough that no client timeout, proxy or keep-alive window has an
 * opinion about it, and long enough that a queue moving at a normal pace is
 * usually answered on the first hop.
 */
const LEASE_WAIT_MS = 15_000

/**
 * How long one gate request waits before answering "not yet".
 *
 * `LEASE_WAIT_MS`'s reasoning, and deliberately the same number: both are
 * bounded by the shortest opinion anything between client and daemon has
 * about an idle response, not by how long the work behind them takes.
 */
const GATE_WAIT_MS = 15_000

/** The last 64 KiB of a gate log. Enough for a failure tail, bounded by design. */
const GATE_LOG_TAIL_BYTES = 64 * 1024

const TranscriptQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  stream: z.enum(['transcript', 'raw']).default('transcript'),
})

/** Whether the changes endpoint reads the patch, which is the expensive half. */
const ChangesQuerySchema = z.object({
  patch: z.enum(['true', 'false']).default('false'),
})

/** §13.2's page. Same exclusive `since` as the journal and the socket. */
const EventPageQuerySchema = z.object({
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
})

/** How much of a monitor conversation is served. Long enough to be a history. */
const MONITOR_HISTORY = 200

/**
 * How far back the node view looks for the transcript entry an agent question
 * parked on. The entry is the last thing written before the park, so this only
 * has to outlast what a resumed session or an operator writes after it.
 */
const AGENT_ASK_WINDOW = 500

/**
 * `/api/logs`, in both its modes.
 *
 * `after` and `tail` are not mutually exclusive in the schema, and `after`
 * wins in the handler. That is not laziness: the view opens with a tail and
 * then follows, and a client that keeps its `tail` parameter across the switch
 * is doing the ordinary thing rather than something to be refused.
 */
const LogQuerySchema = z.object({
  /** A cursor from a previous page. Absent means "give me the tail". */
  after: z.string().optional(),
  tail: z.coerce.number().int().min(1).max(MAX_PAGE).default(200),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(MAX_PAGE),
  level: z.enum(LEVELS).optional(),
  run: z.string().optional(),
  node: z.string().optional(),
  /** Substring over the event name and the field values — identifiers, not prose. */
  q: z.string().max(200).optional(),
})

/**
 * Everything an agent's token may reach (§11). These are what `with`, `gate`
 * and the judge and guard hooks call, and nothing else a lane runs needs the
 * API for. The list is the whole of the agent's authority: an agent that could
 * reach the §9 operations, `/amend`, `/exec`, `/pause`, `/stop` or the editor
 * would be steering its own run as the operator.
 *
 * Matched against the path Hono routes on, so a path this admits is one only
 * the handlers named here can answer: `[^/]+` holds because the router keeps
 * an encoded `/` encoded.
 */
const AGENT_ROUTES: readonly { readonly method: string; readonly path: RegExp }[] = [
  { method: 'POST', path: /^\/api\/runs\/[^/]+\/leases$/ },
  { method: 'PUT', path: /^\/api\/runs\/[^/]+\/leases\/[^/]+$/ },
  { method: 'DELETE', path: /^\/api\/runs\/[^/]+\/leases\/[^/]+$/ },
  { method: 'POST', path: /^\/api\/runs\/[^/]+\/gates$/ },
  { method: 'POST', path: /^\/api\/runs\/[^/]+\/permission$/ },
  { method: 'POST', path: /^\/api\/runs\/[^/]+\/guard$/ },
]

/** One `exec` command that has not ended: what `exec list` shows and `exec cancel` ends. */
interface LiveExec {
  readonly id: string
  readonly runId: string
  readonly target: string
  readonly actor: Actor
  readonly reason?: string
  state: 'queued' | 'running'
  readonly startedAt: number
  readonly abort: AbortController
}

export function agentMayReach(method: string, path: string): boolean {
  return AGENT_ROUTES.some((route) => route.method === method && route.path.test(path))
}

export interface ApiOptions {
  readonly journal: Journal
  readonly token: string
  /**
   * The run coordinator's own token (`coordinator/`). A request carrying it is
   * the coordinator's: attributed to it in the journal, and held to what it
   * may do — no halting the run, no editor saves, amendments only within
   * `coordinator/policy.ts`, answers only to questions a timer could answer.
   * Absent for a host with no coordinator.
   */
  readonly coordinatorToken?: string
  /**
   * The token a run's lanes are handed (`VINTA_AI_MAESTRO_TOKEN`). It reaches
   * only `AGENT_ROUTES` — the agent's own leases and gates, and the two hooks
   * that ask on its behalf — and is answered `403 agent_forbidden` everywhere
   * else. Absent for a host that hands its lanes no token of their own.
   */
  readonly agentToken?: string
  /** Live view of the registry — a run registered after start is reachable. */
  readonly runs: ReadonlyMap<string, DaemonRun>
  /** Where the built UI lives. Defaults to this package's `dist/ui`. */
  readonly uiDir?: string
  /**
   * `false` for a run's own job, which serves agents and the control commands
   * and has no page to offer: `ui` is the process that serves the app. Every
   * path then goes through the token check, the app shell included.
   */
  readonly serveUi?: boolean
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
  /**
   * How long one lease request waits before answering "not yet" (`202`).
   * Defaults to `LEASE_WAIT_MS`; a test shortens it to reach the queued answer
   * without waiting fifteen real seconds for it.
   */
  readonly leaseWaitMs?: number
  /**
   * How long one gate request waits before answering "not yet" (`202`).
   * Defaults to `GATE_WAIT_MS`; a test shortens it to reach the queued answer
   * without waiting fifteen real seconds for it.
   */
  readonly gateWaitMs?: number
  /**
   * Starting a run on this daemon. Absent on a host that only serves history,
   * and then `POST /api/runs` says so rather than accepting a run nobody will
   * drive — see `RunStartPort`.
   */
  readonly runStarter?: RunStartPort | undefined
  /**
   * Where this module's own records go. Absent in tests, and then nothing is
   * written — see `nullLogger`.
   */
  readonly logger?: Logger
  /**
   * Where the log is read from. Defaults to the journal's own
   * `.vinta-ai-maestro/logs`, derived rather than passed for the same reason
   * `workflowsDir` is: every caller already agrees on the journal, and a second
   * parameter is a second chance to disagree about which project is open.
   */
  readonly logDir?: string
  /**
   * The job hosting a run this process does not, for `ui` (`proxy.ts`). The
   * server forwards `/api/runs/<id>/*` there by itself; this is for the one
   * route outside that prefix that has to reach a live run — the editor's save
   * (`PUT /api/workflows/:id`), which amends whichever run is executing the
   * workflow it writes.
   */
  readonly upstream?: UpstreamFor
}

export function createApi(options: ApiOptions): Hono {
  const { journal, runs } = options
  /** Each run's snapshot, with the mtime it was read at. See `workflow`. */
  const workflows = new Map<string, { readonly mtimeMs: number; readonly workflow: Workflow }>()
  const repoDir = dirname(journal.root)
  // `Journal.root` is `<project>/.vinta-ai-maestro`, so its parent is the checkout.
  // Derived rather than passed because every caller already agrees on the
  // journal, and a second `repoPath` parameter would be a second chance to
  // disagree about which project is being served.
  const store = createWorkflowStore(options.workflowsDir ?? plansDirFor(dirname(journal.root)))
  const ui = createStaticHandler(options.uiDir ?? DEFAULT_UI_DIR)
  const log = options.logger ?? nullLogger()
  const logDir = options.logDir ?? logDirFor(journal.root)
  /** `exec` commands that have not ended, by id, across runs (`GET`/`DELETE …/exec`). */
  const liveExecs = new Map<string, LiveExec>()
  /** Requests the coordinator's token authenticated. Everyone else is the operator. */
  const actors = new WeakMap<Request, Actor>()
  const actorOf = (c: Context): Actor => actors.get(c.req.raw) ?? 'operator'
  /** `X-Maestro-Reason`, decoded and bounded; undefined when absent, blank or malformed. */
  const reasonOf = (c: Context): string | undefined => {
    const raw = c.req.header(REASON_HEADER)
    if (raw === undefined) return undefined
    let text: string
    try {
      text = decodeURIComponent(raw).trim()
    } catch {
      return undefined
    }
    if (text === '') return undefined
    return text.length <= MAX_REASON_CHARS ? text : text.slice(0, MAX_REASON_CHARS)
  }
  /** How far the coordinator reaches on this run (`run --coordinator-authority`). */
  const authorityOf = (run: DaemonRun | undefined | null): 'standard' | 'full' =>
    run?.coordinatorAuthority ?? 'standard'
  /**
   * Monitor turns in flight, by run. The one piece of state this module keeps.
   *
   * It exists because a monitor turn is no longer bounded by the request that
   * started it — see the `POST` below. Deliberately not durable: a daemon that
   * restarts mid-turn has no turn to report, and a conversation holding a
   * question with no answer is then exactly what happened.
   */
  const asking = new Map<string, Promise<unknown>>()
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
    if (options.serveUi === false) return await next()
    const path = new URL(c.req.url).pathname
    if (path === '/api' || path.startsWith('/api/') || path === '/ws') return await next()
    const method = c.req.method
    if (method !== 'GET' && method !== 'HEAD') return await next()
    return ui(path, method)
  })

  /**
   * What the API did, per request.
   *
   * Above the token check so a `401` is on the record: an operator whose UI
   * shows nothing has two very different problems — a daemon that never
   * received the request, and one that received it and refused the token — and
   * without this row they look identical from the browser.
   *
   * **The path, never the query string.** The token rides in the query on the
   * WebSocket upgrade and can be put there on any request, so `c.req.url` is a
   * string that sometimes contains the secret. `pathname` carries the run and
   * node ids, which are identifiers and the part worth having.
   *
   * A thrown handler is logged and rethrown. Hono would turn it into a 500 and
   * the bridge in `server.ts` would turn that into a body with no detail —
   * correct, and completely opaque, which is the shape of failure this unit
   * exists to remove.
   */
  app.use('*', async (c, next) => {
    // `error` rather than `debug`: this is the cheapest test for "is there a
    // logger at all", and it is the right one. Guarding on `debug` skipped the
    // whole middleware at `--log-level error` — including the 500s, which is
    // the one level an operator picks *because* they only want those.
    if (!log.enabled('error')) return await next()
    const started = Date.now()
    const path = new URL(c.req.url).pathname
    const method = c.req.method
    try {
      await next()
    } catch (error) {
      log.error('api.threw', { method, path, ...errorFields(error) })
      throw error
    }
    const status = c.res.status
    const fields = { method, path, status, ms: Date.now() - started }
    // A refusal is the interesting one and is kept at the default level; an
    // ordinary 200 is `debug`, because a UI polling four endpoints a second
    // would otherwise be the entire file.
    if (status >= 500) log.error('api.request', fields)
    else if (status >= 400) log.warn('api.request', fields)
    else log.debug('api.request', fields)
  })

  /**
   * §11: every request, without exception, including the ones that 404.
   *
   * The agent's token is held to its routes here, before anything is routed,
   * rather than left to each handler to remember. Its routes read no actor, so
   * it is not given one.
   */
  app.use('*', async (c, next) => {
    const presented = presentedToken(c.req.header('authorization'), new URL(c.req.url))
    if (options.coordinatorToken !== undefined && tokenMatches(options.coordinatorToken, presented)) {
      actors.set(c.req.raw, 'coordinator')
    } else if (options.agentToken !== undefined && tokenMatches(options.agentToken, presented)) {
      if (!agentMayReach(c.req.method, c.req.path)) return fail(c, 403, 'agent_forbidden')
    } else if (!tokenMatches(options.token, presented)) {
      return fail(c, 401, 'unauthorized')
    }
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

  /**
   * Start a run, or pick an interrupted one back up — the endpoint that makes a
   * run outlive the thing that asked for it.
   *
   * Before this existed, `vinta-ai-maestro run` was the only way to start a run
   * and it hosted the daemon itself, so the run's lifetime was the terminal's:
   * closing the window killed the scheduler and every agent under it, and left
   * the journal claiming `running` with nothing able to pick it up. Submitting
   * to a daemon that was already listening breaks that coupling completely —
   * the request returns as soon as the run is registered, and the run then
   * belongs to the daemon.
   *
   * **It answers on registration, not on completion.** A run takes hours; a
   * request held open for one would be a request no proxy, browser or laptop
   * lid survives. What comes back is the id, and everything else in this API is
   * addressed by it.
   */
  app.post('/api/runs', async (c) => {
    const starter = options.runStarter
    // `501`, in the sense the neighbouring monitor endpoint uses it: the
    // request is fine and this host does not implement it.
    if (starter === undefined) return fail(c, 501, 'runs_unsupported')

    const body = await readBody(c, StartRunRequestSchema)
    if ('issues' in body) return fail(c, 400, 'invalid_request', body.issues)

    // Refused here rather than in the port, because the registry is the
    // daemon's and only the daemon can see it: a resume of a run this process
    // is already driving would put a second scheduler on one journal, and the
    // two would fight over every node.
    if (body.value.resume !== undefined && runs.has(body.value.resume)) {
      return fail(c, 409, 'run_active')
    }

    const request =
      body.value.resume === undefined
        ? ({ kind: 'workflow', workflowId: body.value.workflow as string } as const)
        : ({ kind: 'resume', runId: body.value.resume } as const)

    const outcome = await starter.start(request)
    if (!outcome.ok) {
      // The refusal an operator most needs on the record. A start that never
      // happened leaves no run, so it leaves no journal row, no transcript and
      // no post-mortem — the whole apparatus for explaining a run is keyed by
      // an id this request did not produce. Without this line, "I clicked run
      // and nothing happened" is unanswerable.
      log.warn('runs.refused', {
        code: outcome.code,
        kind: request.kind,
        ...(request.kind === 'workflow'
          ? { workflow: request.workflowId }
          : { run: request.runId }),
      })
      return fail(c, STATUS_FOR[outcome.code], outcome.code)
    }
    log.info('runs.started', { run: outcome.runId, kind: request.kind })
    return c.json({ runId: outcome.runId } satisfies StartRunResponse, 201)
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
        warmReuse: crew.warmReuse,
        promoted: crew.promoted,
        idle: [...crew.idle],
      },
      inputTokens: usage.totals.inputTokens,
      outputTokens: usage.totals.outputTokens,
      sessions: usage.totals.sessions,
      cost: usage.totals.cost,
      cache: usage.totals.cache,
    } satisfies RunUsageResponse)
  })

  /**
   * The decisions the run made with nobody watching, for the run view. Its own
   * read for the reason `usage` is: it folds the run's whole log and reads
   * every asking phase's `decisions.jsonl`, which the snapshot must not do on
   * every event.
   */
  app.get('/api/runs/:runId/unattended', (c) => {
    const runId = c.req.param('runId') ?? ''
    if (journal.run(runId) === undefined) return fail(c, 404, 'unknown_run')
    const details = runAgentDetails(journal, runId)
    return c.json({
      runId,
      decisions: unattendedDecisions(journal.events(runId)).map((entry) => ({
        at: entry.at,
        node: entry.node,
        by: entry.type === 'answer' ? entry.by : entry.type === 'action' ? 'coordinator' : 'unattended',
        category: entry.type === 'answer' ? entry.category : entry.type,
        summary: describeUnattended(entry, { details }),
      })),
    } satisfies UnattendedResponse)
  })

  /**
   * A lease an agent can take during its own inner loop.
   *
   * The POST deliberately waits for `ResourcePools.acquire`: HTTP is the queue,
   * so the CLI cannot mistake "accepted" for "granted" and start its command
   * early. Only semaphore resources are legal here. A node already holds its
   * lane for the whole turn; allowing it to ask for `lane` again would create a
   * self-deadlock, not extra isolation.
   */
  app.post('/api/runs/:runId/leases', async (c) => {
    const found = resolveLeaseRun(c)
    if ('response' in found) return found.response

    const body = await readBody(c, AgentLeaseRequestSchema)
    if ('issues' in body) return fail(c, 400, 'invalid_request', body.issues)
    const holder = refuseHolder(c, found.row.id, body.value.holderNode)
    if (holder !== null) return holder

    const wf = workflow(found.row.id)
    if (
      body.value.resources.some((id) => {
        const resource = wf.resources[id]
        return resource === undefined || resource.kind !== 'semaphore'
      })
    ) {
      return fail(c, 400, 'invalid_resource')
    }

    // Waited for in short hops rather than one held request. A test suite
    // behind a capacity-1 semaphore waits as long as it waits — routinely
    // longer than the five minutes Node's own fetch gives a response before it
    // times out, and every intermediary has an opinion too. A client that timed
    // out got an error that read like "the lease mechanism is broken", and
    // agents did the reasonable thing with that: ran the command without a
    // lease. So the wait is the *client's* loop, and this answers "not yet".
    //
    // What that answer must not do is throw the wait away. It used to abort the
    // acquire at the hop boundary, which left the pool queue; the next POST
    // re-entered at the tail, behind every waiter that had arrived in between.
    // Fifteen seconds of hop against gate runs that hold a semaphore for
    // minutes meant an agent could be overtaken on every single hop, forever,
    // while an in-process waiter on the same pool was not. `waitToken` is the
    // queue position, handed out here and given back on the next ask.
    try {
      const outcome = await found.run.agentLeases.hop(
        body.value.resources,
        body.value.holderNode,
        {
          ...(body.value.waitToken === undefined ? {} : { waitToken: body.value.waitToken }),
          ...(body.value.turn === undefined ? {} : { turn: body.value.turn }),
          ...(body.value.pid === undefined ? {} : { pid: body.value.pid }),
          withinMs: options.leaseWaitMs ?? LEASE_WAIT_MS,
        },
      )
      // Still queued behind someone, which is the ordinary case and not an
      // error: 202 is "come back", and the client does. It says who, because
      // "held by another lane" was wrong in exactly the case that mattered:
      // a lease the asking phase held itself, which no amount of waiting ends.
      if ('waiting' in outcome) {
        const waiting: AgentLeaseWaitingResponse = {
          ...outcome,
          holders: holdersOf(found.row.id, found.run, body.value.resources),
        }
        return c.json(waiting, 202)
      }
      return c.json(outcome satisfies AgentLeaseGrantResponse, 201)
    } catch (error) {
      // `turn_ended`, `run_pausing`, `run_stopping`: answers the client turns
      // into what the agent should do next. Anything else is opaque.
      return fail(c, 409, error instanceof AgentLeaseRefusal ? error.code : 'lease_unavailable')
    }
  })

  /** Renewal is the liveness proof that keeps a long command's lease valid. */
  app.put('/api/runs/:runId/leases/:leaseId', (c) => {
    const found = resolveLeaseRun(c)
    if ('response' in found) return found.response
    const grant = found.run.agentLeases.renew(c.req.param('leaseId') ?? '')
    return grant === null
      ? fail(c, 409, 'lease_expired')
      : c.json(grant satisfies AgentLeaseGrantResponse)
  })

  /** Idempotent because expiry and the command's `finally` routinely race. */
  app.delete('/api/runs/:runId/leases/:leaseId', (c) => {
    const found = resolveLeaseRun(c)
    if ('response' in found) return found.response
    found.run.agentLeases.release(c.req.param('leaseId') ?? '')
    return c.json({ ok: true })
  })

  /**
   * One declared gate, run by the daemon on an agent's behalf.
   *
   * This is the same work the `gate` node does, moved to where the agents
   * already were. They were running the gate commands by hand four times a
   * phase — the implementer's outer gate, the reviewer's first layer, the
   * fixer, the reviewer again — and every one of those was a bare shell line:
   * outside `GateCache`, so the fifth run by the `gate` node paid full price
   * for a tree nothing had changed, and outside the pool unless the agent
   * remembered to wrap it.
   *
   * Through here all three are structural. The broker keys on the same
   * `(gate id, lane tree hash)` as the `gate` node, so the run that node
   * eventually makes can be a hit on what an agent already proved; it takes
   * the gate's pools itself, so the lease is not something an agent can omit;
   * and it is given a gate *id*, so the command is the workflow's rather than
   * whatever the agent recalled of it.
   *
   * It waits in hops the way `POST /leases` does, and for the same reason it
   * once did not. A gate acquires its pools and then runs a test suite, which
   * is routinely slower than the five minutes Node's own `fetch` gives a
   * response — so one held request answered "could not reach the daemon" about
   * a gate that was running fine, and agents met that with polling loops of
   * their own invention. `202` is "come back", and the client does.
   *
   * Unlike a lease there is no token to carry: the gate is found again by
   * `(holderNode, gateId)`. That is what makes the *killed* client — the
   * ordinary one, since harnesses cap a command's life — attach to its own run
   * instead of starting a second suite beside it.
   */
  app.post('/api/runs/:runId/gates', async (c) => {
    const found = resolveGateRun(c)
    if ('response' in found) return found.response

    const body = await readBody(c, AgentGateRequestSchema)
    if ('issues' in body) return fail(c, 400, 'invalid_request', body.issues)
    const holder = refuseHolder(c, found.row.id, body.value.holderNode)
    if (holder !== null) return holder
    const declared = workflow(found.row.id)
    // `codegen:` / `codegen:<step>` is `vinta-ai-maestro codegen`: the plan's
    // codegen steps through the same flight, with their pools as its `requires`.
    const codegen = body.value.gate.startsWith(CODEGEN_GATE_PREFIX)
      ? { requires: codegenPools(declared, body.value.gate.slice(CODEGEN_GATE_PREFIX.length)) }
      : undefined
    const gate = codegen ?? declared.gates[body.value.gate]
    if (gate === undefined) return fail(c, 400, 'unknown_gate')

    try {
      const outcome = await found.run.agentGates.hop(body.value.gate, body.value.holderNode, {
        withinMs: options.gateWaitMs ?? GATE_WAIT_MS,
        ...(body.value.noCache === true ? { noCache: true } : {}),
        ...(body.value.full === true ? { full: true } : {}),
        ...(body.value.turn === undefined ? {} : { turn: body.value.turn }),
      })
      // Still queued or running, which is the ordinary case and not an error.
      // A queued gate says who holds its pools, as a queued lease does.
      if ('waiting' in outcome) {
        const waiting: AgentGateWaitingResponse =
          outcome.state === 'queued' && !('judge' in gate)
            ? { ...outcome, holders: holdersOf(found.row.id, found.run, gate.requires) }
            : outcome
        return c.json(waiting, 202)
      }
      return c.json(outcome satisfies AgentGateResultResponse)
    } catch (error) {
      // Codes only, and the code is the broker's own where it had one. A gate
      // that failed is a `200` with a non-zero `exitCode`; reaching here means
      // the gate could not be *started* — no lane, a `requires` that would
      // have deadlocked against what the node is holding, or a session or run
      // that is ending.
      if (!(error instanceof AgentGateRefusal)) return fail(c, 409, 'gate_unavailable')
      if (error.held.length === 0) return fail(c, 409, error.code)
      const lanes = laneIndex(found.row.id)
      const holders = error.held.flatMap((held) =>
        held.resources
          .filter((resource) => ('judge' in gate ? [] : gate.requires).includes(resource))
          .map((resource) => withHolder(held, resource, lanes)),
      )
      return c.json({ error: error.code, issues: null, holders }, 409)
    }
  })

  /**
   * Forgets one gate's cached results (§13.4) — for one lane tree, or for every
   * tree when the body names none. The next run of that gate, by the gate node
   * or an agent, runs it.
   *
   * For a verdict the key cannot see is wrong: a red one whose cause was an
   * ignored file, the lane's database, something installed. The operator's and
   * the coordinator's, and not the agent's (`AGENT_ROUTES`): an agent has
   * `gate <id> --no-cache`, which replaces the entry for its own lane's tree
   * and nothing wider. Open to the coordinator because forgetting a verdict
   * can only cause a gate to run again; it cannot make one pass.
   */
  app.post('/api/runs/:runId/gates/:gateId/invalidate', async (c) => {
    const runId = c.req.param('runId')
    const gateId = c.req.param('gateId')
    if (journal.run(runId) === undefined) return fail(c, 404, 'unknown_run')
    const run = runs.get(runId)
    if (run === undefined) return fail(c, 409, 'run_not_live')
    if (run.gateCache === undefined) return fail(c, 501, 'gate_cache_unavailable')
    if (workflow(runId).gates[gateId] === undefined) return fail(c, 400, 'unknown_gate')
    const body = await readBody(c, GateCacheInvalidateSchema)
    if ('issues' in body) return fail(c, 400, 'invalid_request', body.issues)

    const { tree } = body.value
    const actor = actorOf(c)
    const reason = reasonOf(c)
    if (actor === 'coordinator' && reason === undefined) return fail(c, 400, 'reason_required')
    const removed = run.gateCache.invalidate(gateId, tree)
    journal.append({
      runId,
      type: 'gate_cache_invalidated',
      payload: {
        gate: gateId,
        ...(tree === undefined ? {} : { tree }),
        removed,
        ...(actor === 'coordinator' ? { by: actor } : {}),
        ...(reason === undefined ? {} : { reason }),
      },
    })
    log.info('runs.gate_cache_invalidated', { run: runId, gate: gateId, actor, removed })
    return c.json({ gate: gateId, removed })
  })

  /**
   * §17.6 — a `judged` session's hook asking whether one tool call may run.
   *
   * Every refusal here is a denial on the hook's side, by construction: it
   * reads anything but a `200` with a boolean as "no". So the codes only have
   * to say *why* for the transcript, never to be safe.
   */
  app.post('/api/runs/:runId/permission', async (c) => {
    const runId = c.req.param('runId')
    if (journal.run(runId) === undefined) return fail(c, 404, 'unknown_run')
    const run = runs.get(runId)
    if (run === undefined) return fail(c, 409, 'run_not_live')
    if (run.permissionJudge === undefined) return fail(c, 501, 'judge_unavailable')

    const body = await readBody(c, PermissionRequestSchema)
    if ('issues' in body) return fail(c, 400, 'invalid_request', body.issues)
    if (!journal.nodes(runId).some((node) => node.node_id === body.value.holderNode)) {
      return fail(c, 400, 'invalid_holder')
    }
    const decided = await run.permissionJudge.judge({
      holderNode: body.value.holderNode,
      tool: body.value.tool,
      input: body.value.input,
      cwd: body.value.cwd,
    })
    return c.json({ allow: decided.allow, reason: decided.reason })
  })

  /**
   * The gate guard: may this Bash line run, or is it a gate or a pooled
   * command that should go through the daemon? Anything but a `200` with
   * `allow: false` is read by the hook as "go ahead" — it fails open — so the
   * refusals here only have to say why.
   */
  /**
   * §9's amend, addressed to the run rather than to its workflow file.
   *
   * The editor's save is a `/api/workflows/` route, which `ui` answers itself
   * — and `ui` does not host the run. Amending from there touched the frozen
   * snapshot and nothing else: no live statuses, no integration worktree to
   * rebase in, no `adopt`, so the scheduler, the executor and the gate broker
   * in the job carried on with the old definition until a resume. This route
   * lives under the prefix `ui` forwards to the job, so the editor's save
   * reaches the process that can actually apply it. Only the host answers it:
   * an amendment that cannot be adopted is not one.
   */
  app.post('/api/runs/:runId/amend', async (c) => {
    const runId = c.req.param('runId')
    if (journal.run(runId) === undefined) return fail(c, 404, 'unknown_run')
    const run = runs.get(runId)
    if (run === undefined) return fail(c, 409, 'run_not_live')
    let proposed: unknown
    try {
      proposed = JSON.parse(await c.req.text())
    } catch {
      return fail(c, 400, 'invalid_workflow', [
        { path: '', code: 'invalid_json', message: 'Body is not valid JSON' },
      ])
    }
    const actor = actorOf(c)
    const reason = reasonOf(c)
    if (actor === 'coordinator' && reason === undefined) return fail(c, 400, 'reason_required')
    const outcome = await amendHere(runId, proposed, run, actor, reason)
    return outcome.ok ? c.json(outcome.body) : fail(c, 409, outcome.code, outcome.issues)
  })

  /**
   * One shell command run by hand in a live run's lane or its integration
   * worktree, with that worktree's environment (`coordinator/exec.ts`). The
   * answer streams, one JSON object per line: `{"accepted": "<id>"}` at once,
   * `{"queued": "<holder>"}` while it waits for the integration worktree (and
   * `{"waiting": …}` every fifteen seconds after), `{"running": true}` when it
   * starts, `{"output": "…"}` as it prints, and `{"exit": <code>}` last.
   *
   * Nothing used to be sent until the command ran, so a command queued behind
   * the integration worktree for minutes looked to the client like a daemon
   * that was not there: it printed "not live" and gave up, the server never
   * noticed, and the command ran later with nobody attached — twice in one
   * observed run, once for 835 seconds, holding the worktree while a phase
   * sat queued behind it. The first frame is what keeps the client attached;
   * a client that goes away cancels the command, queued or running.
   *
   * `detach: true` answers `{"id": …}` at once and runs the command with
   * nobody attached, its output in a log; `GET …/exec` lists the commands of
   * the run that have not ended and `DELETE …/exec/<id>` cancels one.
   *
   * The command and what it prints are repository content and stay out of the
   * daemon's log; the journal records the target, who ran it, why, and its
   * exit code.
   */
  app.post('/api/runs/:runId/exec', async (c) => {
    const runId = c.req.param('runId')
    if (journal.run(runId) === undefined) return fail(c, 404, 'unknown_run')
    const run = runs.get(runId)
    if (run === undefined) return fail(c, 409, 'run_not_live')
    if (run.exec === undefined) return fail(c, 501, 'exec_unsupported')
    const body = await readBody(c, ExecRequestSchema)
    if ('issues' in body) return fail(c, 400, 'invalid_request', body.issues)
    const { command } = body.value
    // A lane's short name or its phase's id resolves too, and a refusal lists
    // what the run has: only the full lane name used to work, silently.
    const target = run.exec.resolve(body.value.target)
    if (target === null) {
      return fail(c, 404, 'unknown_target', [
        { path: 'target', code: 'unknown_target', message: `known targets: ${run.exec.targets().join(', ')}` },
      ])
    }

    const actor = actorOf(c)
    const reason = reasonOf(c)
    const port = run.exec
    const id = randomUUID().slice(0, 8)
    const abort = new AbortController()
    const entry: LiveExec = { id, runId, target, actor, state: 'queued', startedAt: Date.now(), abort, ...(reason === undefined ? {} : { reason }) }
    liveExecs.set(id, entry)

    const execute = async (onOutput: (chunk: string) => void, onRunning: () => void): Promise<number> => {
      const started = Date.now()
      let code = 127
      try {
        code =
          (await port.run(
            {
              target,
              command,
              actor,
              onRunning: () => {
                entry.state = 'running'
                onRunning()
              },
            },
            onOutput,
            abort.signal,
          )) ?? 127
      } finally {
        liveExecs.delete(id)
        journal.append({
          runId,
          type: 'workspace_exec',
          payload: {
            target,
            exit_code: code,
            duration_ms: Date.now() - started,
            id,
            ...(actor === 'coordinator' ? { by: actor } : {}),
            ...(reason === undefined ? {} : { reason }),
            ...(abort.signal.aborted ? { cancelled: true } : {}),
          },
        })
        log.info('runs.exec', { run: runId, target, actor, exit_code: code, cancelled: abort.signal.aborted })
      }
      return code
    }

    if (body.value.detach === true) {
      const logPath = journal.gateLogPath(runId, '_exec', id)
      const out = createWriteStream(logPath)
      void execute(
        (chunk) => out.write(chunk),
        () => {},
      )
        .catch(() => 127)
        .finally(() => out.end())
      return c.json({ id, target, log: logPath }, 202)
    }

    c.req.raw.signal.addEventListener('abort', () => abort.abort(), { once: true })
    const encoder = new TextEncoder()
    let heartbeat: ReturnType<typeof setInterval> | undefined
    const stream_ = async (controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
        const send = (frame: Readonly<Record<string, unknown>>): void => {
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`))
          } catch {
            // The client went away: the command goes with it.
            abort.abort()
          }
        }
        send({ accepted: id })
        if (target === 'integration') {
          const holder = port.integrationHolder()
          if (holder !== null) {
            send({ queued: holder })
            heartbeat = setInterval(() => {
              if (entry.state === 'queued') send({ waiting: port.integrationHolder() ?? holder })
            }, 15_000)
            heartbeat.unref?.()
          }
        }
        const code = await execute(
          (output) => send({ output }),
          () => send({ running: true }),
        )
        if (heartbeat !== undefined) clearInterval(heartbeat)
        send({ exit: code })
        try {
          controller.close()
        } catch {
          // Already cancelled.
        }
    }
    const stream = new ReadableStream<Uint8Array>({
      // Not awaited: a stream whose `start` is still pending delivers none of
      // what it enqueued, so awaiting the command here held every frame —
      // the `accepted` one included — until the command had run.
      start(controller) {
        void stream_(controller)
      },
      cancel() {
        if (heartbeat !== undefined) clearInterval(heartbeat)
        abort.abort()
      },
    })
    return new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } })
  })

  /** The run's `exec` commands that have not ended: queued or running, attached or detached. */
  app.get('/api/runs/:runId/exec', (c) => {
    const runId = c.req.param('runId')
    if (journal.run(runId) === undefined) return fail(c, 404, 'unknown_run')
    const execs = [...liveExecs.values()]
      .filter((entry) => entry.runId === runId)
      .map(({ id, target, actor, state, startedAt, reason }) => ({
        id,
        target,
        by: actor,
        state,
        startedAt,
        ...(reason === undefined ? {} : { reason }),
      }))
    return c.json({ execs })
  })

  /** Cancels one: a queued command never starts, a running one's process tree is ended. */
  app.delete('/api/runs/:runId/exec/:id', (c) => {
    const runId = c.req.param('runId')
    const entry = liveExecs.get(c.req.param('id'))
    if (entry === undefined || entry.runId !== runId) return fail(c, 404, 'unknown_exec')
    const was = entry.state
    entry.abort.abort()
    return c.json({ id: entry.id, cancelled: true, was })
  })

  /**
   * `propagate` and `sync-base` on a live run (`landing/live.ts`): the merges
   * are made here, holding the integration worktree's queue, and the answer
   * is the result as the commands print it. Journalled as `branches_moved`
   * unless it was a dry run. Branch names and paths only (§11).
   */
  const moved = (
    runId: string,
    op: 'propagate' | 'sync_base',
    node: string | null,
    result: { readonly kind: string },
    actor: Actor,
  ): void => {
    if (result.kind === 'planned') return
    const outcome = result as
      | { kind: 'done'; steps: readonly { branch: string }[] }
      | { kind: 'conflict'; done: readonly { branch: string }[]; at: { branch: string }; paths: readonly string[] }
      | { kind: 'held'; branch: string }
    journal.append({
      runId,
      type: 'branches_moved',
      payload: {
        op,
        ...(node === null ? {} : { node }),
        moved: (outcome.kind === 'done' ? outcome.steps : outcome.kind === 'conflict' ? outcome.done : []).map(
          (step) => step.branch,
        ),
        outcome: outcome.kind,
        ...(outcome.kind === 'conflict' ? { at: outcome.at.branch, paths: outcome.paths } : {}),
        ...(outcome.kind === 'held' ? { at: outcome.branch } : {}),
        ...(actor === 'coordinator' ? { by: actor } : {}),
      },
    })
  }

  app.post('/api/runs/:runId/branches/propagate', async (c) => {
    const runId = c.req.param('runId')
    if (journal.run(runId) === undefined) return fail(c, 404, 'unknown_run')
    const run = runs.get(runId)
    if (run === undefined) return fail(c, 409, 'run_not_live')
    if (run.branches === undefined) return fail(c, 501, 'branches_unsupported')
    const body = await readBody(c, PropagateRequestSchema)
    if ('issues' in body) return fail(c, 400, 'invalid_request', body.issues)
    const { phase, dryRun, push } = body.value
    const result = await run.branches.propagate({ nodeId: phase, dryRun: dryRun === true, push: push !== false })
    if (result === null) {
      return fail(c, 404, 'unknown_phase', [
        { path: 'phase', code: 'unknown_phase', message: `run ${runId} has no phase "${phase}" with a recorded base` },
      ])
    }
    moved(runId, 'propagate', phase, result, actorOf(c))
    return c.json(result)
  })

  app.post('/api/runs/:runId/branches/sync-base', async (c) => {
    const runId = c.req.param('runId')
    if (journal.run(runId) === undefined) return fail(c, 404, 'unknown_run')
    const run = runs.get(runId)
    if (run === undefined) return fail(c, 409, 'run_not_live')
    if (run.branches === undefined) return fail(c, 501, 'branches_unsupported')
    const body = await readBody(c, SyncBaseRequestSchema)
    if ('issues' in body) return fail(c, 400, 'invalid_request', body.issues)
    const { dryRun, push } = body.value
    const result = await run.branches.syncBase({ dryRun: dryRun === true, push: push !== false })
    moved(runId, 'sync_base', null, result, actorOf(c))
    return c.json(result)
  })

  app.post('/api/runs/:runId/guard', async (c) => {
    const runId = c.req.param('runId')
    if (journal.run(runId) === undefined) return fail(c, 404, 'unknown_run')
    const run = runs.get(runId)
    if (run === undefined) return fail(c, 409, 'run_not_live')
    if (run.gateGuard === undefined) return c.json({ allow: true })

    const body = await readBody(c, GuardRequestSchema)
    if ('issues' in body) return fail(c, 400, 'invalid_request', body.issues)
    if (!journal.nodes(runId).some((node) => node.node_id === body.value.holderNode)) {
      return fail(c, 400, 'invalid_holder')
    }
    const decided = run.gateGuard.check(body.value)
    return c.json(decided.allow ? { allow: true } : { allow: false, reason: decided.reason ?? '' })
  })

  app.get('/api/runs/:runId/nodes/:nodeId', (c) => {
    const found = resolveNode(c)
    if ('response' in found) return found.response

    const query = TranscriptQuerySchema.safeParse(c.req.query())
    if (!query.success) return fail(c, 400, 'invalid_request', toIssues(query.error))

    const { runId, node } = found
    const { limit, stream } = query.data
    const declared = workflow(runId).nodes.find((candidate) => candidate.id === node.node_id)
    const history = latestGateRuns(journal.gateHistory(runId, node.node_id))
    const gates: NodeDetail['gates'] = []
    for (const gateId of declared?.gates ?? []) {
      const state = history.get(gateId)
      const log = tailFile(journal.gateLogPath(runId, node.node_id, gateId), GATE_LOG_TAIL_BYTES)
      // A gate with neither a log nor a journal row has not run — the panel
      // is a record of what happened, not of what was declared. Either one
      // alone is enough: a gate that has just started has an empty log file
      // and no verdict, and a journal restored beside a purged log directory
      // has the verdict and no file.
      if (log === null && state === undefined) continue
      gates.push({
        gateId,
        log: log ?? '',
        status: state?.status ?? 'running',
        startedAt: state?.startedAt ?? null,
        finishedAt: state?.finishedAt ?? null,
        durationMs: state?.durationMs ?? null,
        cached: state?.cached ?? false,
        runs: state?.runs ?? 0,
      })
    }

    const detail: NodeDetail = {
      runId,
      node: nodeSummary(node, declared?.name ?? node.node_id, journal.nodeSteps(runId).get(node.node_id) ?? null),
      integration: journal.integrationTimeline(runId, node.node_id).map((row) => ({
        ...row,
        // Read only inside the run's own directory, whatever the event says.
        logTail:
          row.log !== null && journal.ownsRunFile(runId, row.log) ? tailFile(row.log, GATE_LOG_TAIL_BYTES) : null,
      })),
      diff: { branch: node.branch, baseBranch: node.base_branch, lane: node.lane },
      pullRequest: pullRequest(journal, runId, node.node_id),
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
   * What the node changed: files, counts and — on request — the patch (§10).
   *
   * Everything git needs is on the journal row. The lane's *path* is derived
   * the way the pool derives it, from the same root `purge` and `doctor` use,
   * so this route knows no more about lane layout than they do. A node with no
   * branch yet, or one whose branch git no longer has, is an empty description
   * with `source: none` — a 200, because "nothing to show" is an answer.
   */
  app.get('/api/runs/:runId/nodes/:nodeId/changes', async (c) => {
    const found = resolveNode(c)
    if ('response' in found) return found.response
    const query = ChangesQuerySchema.safeParse(c.req.query())
    if (!query.success) return fail(c, 400, 'invalid_request', toIssues(query.error))

    const { runId, node } = found
    const ref = { branch: node.branch, baseBranch: node.base_branch, lane: node.lane }
    const empty: NodeChanges = {
      runId,
      nodeId: node.node_id,
      ...ref,
      source: 'none',
      files: [],
      totals: { files: 0, additions: 0, deletions: 0 },
      patch: null,
      truncated: false,
    }
    if (node.branch === null || node.base_branch === null) return c.json(empty)

    const repo = dirname(journal.root)
    const changes = await describeChanges({
      repo,
      branch: node.branch,
      baseBranch: node.base_branch,
      lanePath: node.lane === null ? null : join(laneRootFor(repo), node.lane),
      patch: query.data.patch === 'true',
    })
    const body: NodeChanges = {
      runId,
      nodeId: node.node_id,
      ...ref,
      ...changes,
      files: [...changes.files],
    }
    return c.json(body)
  })

  /**
   * The conversation so far, oldest first.
   *
   * Kept in the transcript store under a reserved node id, so it outlives the
   * tab and the daemon alike — and so the operator who asked a question
   * yesterday can read the answer today. Entries are the same shape as a
   * phase's, which is what lets the UI render both with one component.
   *
   * `pending` is what makes it readable *while* a turn runs: the monitor
   * journals as it goes now, so a client that knows an answer is still coming
   * can poll this and watch it arrive. Without the flag it could not tell a
   * monitor that is thinking from one that has finished saying nothing.
   */
  app.get('/api/runs/:runId/monitor', (c) => {
    const found = resolveRead(c)
    if ('response' in found) return found.response
    return c.json({
      entries: journal.tailTranscript(found.row.id, MONITOR_NODE, MONITOR_HISTORY),
      pending: asking.has(found.row.id),
    })
  })

  /**
   * Ask the monitor about this run.
   *
   * Deliberately not one of §9's operations: those reach the scheduler and
   * change what a run is doing, and this one changes nothing. It works on a
   * finished run for the same reason it reads the journal — the questions worth
   * asking about a failed run are asked after it has failed.
   *
   * **The turn outlives the request, and that is the whole change here.** This
   * used to drive the model inside the handler and answer with the finished
   * prose, which made the turn's lifetime the browser's connection: switching
   * view, reloading, or letting a laptop sleep killed a monitor mid-thought,
   * and the operator came back to a question with no answer and no record that
   * one had been attempted. A question is cheap to ask and expensive to answer,
   * so the answering belongs to the daemon.
   *
   * `202` with nothing in it, therefore. The answer is not in this response
   * because it does not exist yet; it arrives in the journal, entry by entry as
   * the monitor produces it (`monitor/monitor.ts`), and `GET` above serves it
   * with `pending` until the turn ends. That also puts the answer where it was
   * always supposed to live rather than in one client's memory.
   *
   * One turn per run at a time. Not a lock for correctness — a second
   * conversation would be merely confusing, not unsafe — but because two
   * monitors interleaving their thinking into one transcript is a record
   * nobody can read, and because the operator pressing Ask twice means "I am
   * still waiting", not "answer it twice".
   */
  app.post('/api/runs/:runId/monitor', async (c) => {
    const found = resolveRead(c)
    if ('response' in found) return found.response

    const body = await readBody(c, MonitorAskSchema)
    if ('issues' in body) return fail(c, 400, 'invalid_request', body.issues)

    const monitor = options.monitorFor?.(found.row.id) ?? null
    if (monitor === null) return fail(c, 501, 'monitor_unavailable')

    const runId = found.row.id
    if (asking.has(runId)) return fail(c, 409, 'monitor_busy')

    const digest = runDigest(journal, runId, workflow(runId))
    if (digest === null) return fail(c, 404, 'unknown_run')

    const turn = monitor
      .ask(digest, body.value.text)
      .catch(() => {
        // A harness that would not start, a session that would not resume.
        //
        // It goes in the *conversation*, which is new and is the point: with
        // the answer no longer riding on this response, a failure that only
        // rejected a promise nobody is awaiting would leave the operator's
        // question sitting there forever with no answer and no explanation. The
        // kind is on the error and the prose is the vendor's — neither belongs
        // in a browser (§11) — so the record gets a sentence of this daemon's
        // own, which is not repository content and never was.
        journal.appendTranscript(runId, MONITOR_NODE, {
          type: 'error',
          message: 'The monitor could not be reached, so this question was not answered.',
          by: { role: MONITOR_ROLE },
        })
      })
      .finally(() => {
        asking.delete(runId)
      })
    asking.set(runId, turn)

    return c.json({ asked: true, model: monitor.model } satisfies MonitorAsked, 202)
  })

  // The five operations of §9. Each one validates its body, forwards to the
  // run's control port, and answers with a code — never with what went wrong
  // inside, which is the one place agent output could leak into a response.
  app.post('/api/runs/:runId/nodes/:nodeId/context', (c) =>
    operate(c, AddContextRequestSchema, (run, nodeId, body, actor, reason) =>
      run.control.addContext(nodeId, body.text, actor, reason),
    ),
  )

  app.post('/api/runs/:runId/nodes/:nodeId/redirect', (c) =>
    operate(c, RedirectRequestSchema, (run, nodeId, body, actor, reason) =>
      run.control.redirect(nodeId, body.instruction, actor, reason),
    ),
  )

  app.post('/api/runs/:runId/nodes/:nodeId/pause', (c) =>
    operate(c, NoArgsRequestSchema, (run, nodeId, _body, actor, reason) => run.control.pause(nodeId, actor, reason)),
  )

  /** §9 — undo `pause` (`Scheduler.resume`). */
  app.post('/api/runs/:runId/nodes/:nodeId/resume', (c) =>
    operate(c, NoArgsRequestSchema, (run, nodeId, _body, actor, reason) => {
      if (run.control.resume === undefined) throw new UnsupportedOperation('resume')
      return run.control.resume(nodeId, actor, reason)
    }),
  )

  app.post('/api/runs/:runId/nodes/:nodeId/abort', (c) =>
    operate(c, NoArgsRequestSchema, (run, nodeId, _body, actor, reason) =>
      run.control.abortNode(nodeId, actor, reason),
    ),
  )

  /**
   * Stop the phase's turn now without failing it: it is held, keeping its
   * lane, branch, commits and uncommitted work, until `resume`, `reassign` or
   * `step` releases it. `held` for a phase already parked on a question.
   */
  app.post('/api/runs/:runId/nodes/:nodeId/interrupt', (c) =>
    operate(c, NoArgsRequestSchema, (run, nodeId, _body, actor, reason) => {
      if (run.control.interrupt === undefined) throw new UnsupportedOperation('interrupt')
      return run.control.interrupt(nodeId, actor, reason)
    }),
  )

  /**
   * Hand the phase to a crew member, or a harness and model, and let it carry
   * on at the same step: `sent` (the turn was cut), `queued` (`after_turn`),
   * `delivered` (it was parked, and took it at once). 409 `reassign_refused`
   * names what the run cannot do — an unknown or busy member, a harness it has
   * no adapter for.
   */
  app.post('/api/runs/:runId/nodes/:nodeId/reassign', (c) =>
    operate(c, ReassignRequestSchema, (run, nodeId, body, actor, reason) => {
      if (run.control.reassign === undefined) throw new UnsupportedOperation('reassign')
      const { when, crew, harness, model } = body
      const target = {
        ...(crew === undefined ? {} : { crew }),
        ...(harness === undefined ? {} : { harness }),
        ...(model === undefined ? {} : { model }),
      }
      return run.control.reassign(nodeId, target, {
        actor,
        ...(when === undefined ? {} : { when }),
        ...(reason === undefined ? {} : { reason }),
      })
    }),
  )

  /**
   * Move the phase's pipeline to a state by hand, for work finished in the
   * lane by somebody else. Never a final state: the gates still decide. The
   * coordinator needs `--coordinator-authority full`.
   */
  app.post('/api/runs/:runId/nodes/:nodeId/step', (c) =>
    operate(c, StepRequestSchema, (run, nodeId, body, actor, reason) => {
      if (run.control.step === undefined) throw new UnsupportedOperation('step')
      return run.control.step(nodeId, body.to, actor, reason)
    }),
  )

  /**
   * Move the whole run off a harness: phases in flight on it are reassigned,
   * phases yet to start take the switch when they do. What an account out of
   * credits needs, without a pause and a resume.
   */
  app.post('/api/runs/:runId/switch-harness', async (c) => {
    const runId = c.req.param('runId')
    if (journal.run(runId) === undefined) return fail(c, 404, 'unknown_run')
    const run = runs.get(runId)
    if (run === undefined) return fail(c, 409, 'run_not_live')
    const actor = actorOf(c)
    const reason = reasonOf(c)
    if (actor === 'coordinator' && reason === undefined) return fail(c, 400, 'reason_required')
    const body = await readBody(c, SwitchHarnessRequestSchema)
    if ('issues' in body) return fail(c, 400, 'invalid_request', body.issues)
    if (run.control.switchHarness === undefined) return fail(c, 501, 'switch_unsupported')
    const { from, to, model, when } = body.value
    try {
      const moved = await run.control.switchHarness(from, to, model, {
        actor,
        ...(when === undefined ? {} : { when }),
        ...(reason === undefined ? {} : { reason }),
      })
      log.info('runs.harness_switched', { run: runId, from, to, actor, moved: moved.length })
      return c.json({ ok: true as const, moved: [...moved] })
    } catch (error) {
      const refused = refusalOf(error)
      if (refused !== null) return fail(c, 409, refused.code, [{ path: '', code: refused.code, message: refused.message }])
      return fail(c, 409, 'operation_failed')
    }
  })

  /**
   * The conflict fixer's round, by hand. `interrupt` ends the running round as
   * a round spent — what it left in the integration worktree stays, and the
   * integrator reads it as any finished round. `reassign` names who fixes the
   * rounds after it, ending the running one unless `now` is false.
   */
  const fixerRoute = (verb: 'interrupt' | 'reassign') => async (c: Context) => {
    const runId = c.req.param('runId') as string
    if (journal.run(runId) === undefined) return fail(c, 404, 'unknown_run')
    const run = runs.get(runId)
    if (run === undefined) return fail(c, 409, 'run_not_live')
    if (run.fixer === undefined) return fail(c, 501, 'fixer_unavailable')
    const actor = actorOf(c)
    const reason = reasonOf(c)
    if (actor === 'coordinator' && reason === undefined) return fail(c, 400, 'reason_required')
    const was = run.fixer.running()
    let ended: boolean
    let to: { harness: string; model: string } | undefined
    if (verb === 'interrupt') {
      const body = await readBody(c, NoArgsRequestSchema)
      if ('issues' in body) return fail(c, 400, 'invalid_request', body.issues)
      ended = await run.fixer.interrupt()
    } else {
      const body = await readBody(c, FixerReassignRequestSchema)
      if ('issues' in body) return fail(c, 400, 'invalid_request', body.issues)
      to = { harness: body.value.harness, model: body.value.model }
      try {
        ended = await run.fixer.reassign(to.harness, to.model, body.value.now ?? true)
      } catch (error) {
        const refused = refusalOf(error)
        if (refused !== null) return fail(c, 409, refused.code, [{ path: '', code: refused.code, message: refused.message }])
        return fail(c, 409, 'operation_failed')
      }
    }
    journal.append({
      runId,
      type: 'fixer_operation',
      payload: {
        op: verb,
        ended,
        ...(was === null ? {} : { from: was }),
        ...(to === undefined ? {} : { to }),
        ...(actor === 'coordinator' ? { by: actor } : {}),
        ...(reason === undefined ? {} : { reason }),
      },
    })
    log.info('runs.fixer_operation', { run: runId, op: verb, actor, ended })
    return c.json({ ok: true as const, ended })
  }
  app.post('/api/runs/:runId/fixer/interrupt', fixerRoute('interrupt'))
  app.post('/api/runs/:runId/fixer/reassign', fixerRoute('reassign'))

  /** §9.1 — the answer enters the guard context as `human.answer`. */
  /**
   * Run a failed phase again.
   *
   * Separate from §9's five because it reaches a node that has *stopped*, and
   * because it can fail for a reason none of those can: a run that has finished
   * has no scheduler left to dispatch into, and is re-run rather than retried.
   * That comes back as 409, like every other "not now".
   */
  app.post('/api/runs/:runId/nodes/:nodeId/retry', (c) =>
    operate(c, NoArgsRequestSchema, (run, nodeId, _body, actor, reason) => {
      if (run.control.retry === undefined) throw new UnsupportedOperation('retry')
      // `retry` journals no operation of its own; the reason goes with the status it moves.
      if (actor === 'coordinator' || reason !== undefined) {
        journal.append({
          runId: run.runId,
          nodeId,
          type: 'node_operation',
          payload: {
            op: 'retry',
            delivery: 'sent',
            ...(actor === 'coordinator' ? { by: actor } : {}),
            ...(reason === undefined ? {} : { reason }),
          },
        })
      }
      return run.control.retry(nodeId)
    }),
  )

  /**
   * Drop a phase's agent session, so its next turn starts cold (§15). For a
   * session gone wrong that the attempt should outlive — `abort` throws both
   * away. Answers `queued`, or `ignored` for a settled phase.
   */
  app.post('/api/runs/:runId/nodes/:nodeId/fresh', (c) =>
    operate(c, NoArgsRequestSchema, (run, nodeId, _body, actor, reason) => {
      if (run.control.freshSession === undefined) throw new UnsupportedOperation('fresh')
      return run.control.freshSession(nodeId, actor, reason)
    }),
  )

  app.post('/api/runs/:runId/nodes/:nodeId/answer', (c) =>
    operate(c, AnswerRequestSchema, (run, nodeId, body, actor, reason) =>
      run.control.answer(
        nodeId,
        {
          human: {
            // An agent's answers travel as one encoded string, so the journal
            // and the guard context carry them the way they carry any answer.
            answer: body.answers === undefined ? (body.answer ?? null) : encodeAnswers(body.answers),
          },
        },
        actor,
        reason,
      ),
    ),
  )

  /**
   * Ending a run before its DAG does: `pause` drains it to a resumable stop,
   * `stop` kills its live turns and cancels it for good.
   *
   * `202`, not `200`: the request is taken, and the run ends when its running
   * phases reach a boundary — immediately for a stop, after their current step
   * for a pause. The host process exits once it has; that is the signal a
   * caller waits on, and `run_ended` is the record.
   *
   * A run the journal says is `running` but nobody is hosting is a run whose
   * process died. There is nothing to drain, so `pause` refuses — it is
   * already exactly as resumable as a pause would make it — and `stop` writes
   * the cancellation itself, which is the one thing left to do for it. When a
   * job for the run is alive somewhere, `ui` forwards these requests to it and
   * never reaches this branch.
   */
  const halt = (mode: 'paused' | 'cancelled') => async (c: Context) => {
    // The coordinator lives inside the run it would be ending. A pause is
    // resumable and costs nothing that is not run again, so it may; a stop is
    // final and is the operator's unless they gave it full authority. Either
    // way it says why.
    const actor = actorOf(c)
    const reason = reasonOf(c)
    if (actor === 'coordinator' && reason === undefined) return fail(c, 400, 'reason_required')
    const body = await readBody(c, NoArgsRequestSchema)
    if ('issues' in body) return fail(c, 400, 'invalid_request', body.issues)
    const found = resolveRead(c)
    if ('response' in found) return found.response
    const { run, row } = found
    if (actor === 'coordinator' && (run === null || (mode === 'cancelled' && authorityOf(run) !== 'full'))) {
      return fail(c, 403, 'coordinator_forbidden')
    }
    if (run !== null) {
      if (run.halt === undefined) return fail(c, 501, 'halt_unsupported')
      if (row.status !== 'running') return fail(c, 409, 'run_not_running')
      journal.append({
        runId: row.id,
        type: 'run_halt_requested',
        payload: {
          mode,
          ...(actor === 'coordinator' ? { by: actor } : {}),
          ...(reason === undefined ? {} : { reason }),
        },
      })
      const waitingOn = (await run.halt(mode)) ?? undefined
      log.info('runs.halt_requested', {
        run: row.id,
        mode,
        ...(waitingOn === undefined ? {} : { waiting_on: waitingOn.map(activityField).join(',') }),
      })
      const answer: HaltResponse = {
        ok: true,
        ...(waitingOn === undefined ? {} : { waitingOn: [...waitingOn] }),
      }
      return c.json(answer, 202)
    }
    if (mode === 'paused') return fail(c, 409, 'run_not_live')
    if (row.status === 'done' || row.status === 'cancelled') {
      return fail(c, 409, 'run_not_running')
    }
    journal.append({ runId: row.id, type: 'run_ended', payload: { status: 'cancelled' } })
    log.info('runs.cancelled_unhosted', { run: row.id, was: row.status })
    return c.json({ ok: true } as const, 200)
  }
  app.post('/api/runs/:runId/pause', halt('paused'))
  app.post('/api/runs/:runId/stop', halt('cancelled'))

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

  // -------------------------------------------------------------------------
  // The daemon's own log
  // -------------------------------------------------------------------------
  //
  // The one read here that is not a projection of the journal, because it is
  // not about a run. It is about *this process*: what it bound, what it
  // refused, what it dispatched, and — the case this whole unit exists for —
  // what killed it.
  //
  // Deliberately not per-run, and deliberately not on the run's WebSocket. A
  // run-scoped log cannot hold the records worth having: a daemon that failed
  // to bind, a preflight that refused, a start request rejected before a run
  // id existed, a crash with three runs in flight. Those are the moments with
  // no run to hang a record on, and they are the moments somebody is looking.
  //
  // Two modes on one route, matching the events route above: `tail` for the
  // last N records — the "show me what just happened" read — and `after` for
  // a follow. Both are bounded by the reader, which never opens more than a
  // few MiB however long the daemon has been up.
  app.get('/api/logs', (c) => {
    const query = LogQuerySchema.safeParse(c.req.query())
    if (!query.success) return fail(c, 400, 'invalid_request', toIssues(query.error))

    const { after, tail, limit, level, run, node, q } = query.data
    const filter = {
      ...(level === undefined ? {} : { level }),
      ...(run === undefined ? {} : { runId: run }),
      ...(node === undefined ? {} : { nodeId: node }),
      ...(q === undefined ? {} : { search: q }),
    }
    const page =
      after === undefined ? readTail(logDir, tail, filter) : readAfter(logDir, after, limit, filter)

    return c.json({
      records: page.records.map((record) => ({
        ts: record.ts,
        seq: record.seq,
        pid: record.pid,
        level: record.level,
        event: record.event,
        runId: record.runId ?? null,
        nodeId: record.nodeId ?? null,
        fields: record.fields,
      })),
      cursor: page.cursor,
      reset: page.reset,
      more: page.more,
      path: activePath(logDir),
    } satisfies LogPage)
  })

  app.get('/api/workflows', (c) => {
    return c.json({
      workflows: store.list().map((id) => ({ id })),
    } satisfies WorkflowListResponse)
  })

  app.get('/api/workflows/:id', async (c) => {
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

    // The *resolved* workflow — the project's gate commands, pools and defaults
    // under the plan's own — because that is what a run would execute. A save
    // writes back only what changed (`ownDocument`).
    const config = await loadProjectConfig(repoDir)
    if (!config.ok) return fail(c, 409, 'invalid_config', toWireIssues(config.issues))
    const parsed = resolveWorkflow(read.value, config.config)
    if (!parsed.ok) return fail(c, 409, 'invalid_workflow', toWireIssues(parsed.issues))
    if (parsed.workflow.id !== id) {
      return fail(c, 409, 'invalid_workflow', [
        { path: 'id', code: 'id_mismatch', message: 'Workflow id does not match its filename' },
      ])
    }
    return c.json({ id, workflow: parsed.workflow } satisfies WorkflowResponse)
  })

  app.put('/api/workflows/:id', async (c) => {
    // The plan documents are the operator's; the coordinator amends a live
    // run through `/amend`, where its policy is checked.
    if (actorOf(c) === 'coordinator') return fail(c, 403, 'coordinator_forbidden')
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

    const config = await loadProjectConfig(repoDir)
    if (!config.ok) return fail(c, 409, 'invalid_config', toWireIssues(config.issues))
    const parsed = resolveWorkflow(raw, config.config)
    if (!parsed.ok) return fail(c, 400, 'invalid_workflow', toWireIssues(parsed.issues))
    if (parsed.workflow.id !== id) {
      return fail(c, 400, 'invalid_workflow', [
        { path: 'id', code: 'id_mismatch', message: 'Workflow id does not match the path' },
      ])
    }
    // What goes to disk: the stored file with only the edited values changed.
    // The posted document is the resolved one the editor displayed, and
    // writing it whole would freeze the project's values into the plan.
    const stored = store.read(id)
    const own = ownDocument(parsed.workflow, stored.ok ? stored.value : undefined, config.config)
    // §9's amend. A run in flight has its own frozen snapshot and its own
    // rules about which nodes may still change, so a save that reaches one is
    // routed through `src/amend/` rather than refused: it classifies what
    // moved, refuses while any affected node is in flight, rebases the `done`
    // nodes whose base moved, and journals what it did. The source document is
    // written only after the run took the change — a saved document the run
    // refused would be a plan the editor shows and the daemon is not running.
    const live = journal.runs().find((row) => row.workflow_id === id && row.status === 'running')
    if (live !== undefined) {
      // The run is amended where it runs. A run hosted by another process — a
      // job, seen from `ui` — is asked over its own API. One hosted here, or
      // one the journal says is running with no job left to ask (a crash the
      // next resume picks up), is amended here.
      const remote = runs.has(live.id) ? null : (options.upstream?.(live.id) ?? null)
      if (remote !== null) {
        const forwarded = await amendThere(remote, live.id, parsed.workflow)
        if (forwarded.kind === 'unreachable') {
          // Nothing is written: a saved document the run never took would be
          // a plan the editor shows and the job is not running.
          return c.json({ error: 'run_host_unreachable', issues: null }, 502)
        }
        if (forwarded.kind === 'refused') return c.json(forwarded.body, forwarded.status)
        try {
          store.write(id, own)
        } catch {
          return fail(c, 409, 'write_failed')
        }
        return c.json(forwarded.body)
      }

      const outcome = await amendHere(live.id, parsed.workflow, runs.get(live.id))
      if (!outcome.ok) return fail(c, 409, outcome.code, outcome.issues)
      try {
        store.write(id, own)
      } catch {
        return fail(c, 409, 'write_failed')
      }
      return c.json(outcome.body)
    }

    try {
      store.write(id, own)
    } catch {
      // A code, never the path or the bytes (§11).
      return fail(c, 409, 'write_failed')
    }
    return c.json({ ok: true })
  })

  // §19: plans under review, read from the same `ai-plans/` the editor opens.
  registerPlanRoutes(app, { repoDir, stateRoot: journal.root, workflows: store })

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
    const pending = journal.pendingQuestion(runId, node.node_id)
    const raw = pending?.question ?? run?.control.question?.(node.node_id)
    if (raw === undefined) return null
    const parsed = HumanQuestionSchema.safeParse(raw)
    if (!parsed.success) return null
    if (parsed.data.kind !== 'agent' || pending === undefined) return parsed.data
    const ask = agentAsk(runId, node.node_id, pending.effectId)
    return ask === null ? parsed.data : { ...parsed.data, ask }
  }

  /**
   * What the agent asked, read back from the `agent_question` transcript
   * entry the scheduler wrote just before it parked (`src/questions`). The
   * newest entry with the pause's effect id wins; one that no longer parses,
   * or fell out of the window, leaves the card to its free-text fallback.
   */
  function agentAsk(runId: string, nodeId: string, effectId: string): AgentAsk | null {
    const entries = journal.tailTranscript(runId, nodeId, AGENT_ASK_WINDOW)
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]
      if (typeof entry !== 'object' || entry === null) continue
      const { type, effectId: id, by: _by, ...rest } = entry as Record<string, unknown>
      if (type !== 'agent_question' || id !== effectId) continue
      const ask = AgentAskSchema.safeParse(rest)
      return ask.success ? ask.data : null
    }
    return null
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

  /**
   * A run's snapshot, re-read when the file moved.
   *
   * It used to be cached for good on the grounds that a snapshot is frozen,
   * and it is not: every amendment replaces it, and only the editor's own save
   * remembered to refresh the cache. A monitor retune or a config reload in
   * the run's process left this serving the definition from before it. An
   * mtime check costs a `stat` and is right for every author at once.
   */
  /** One amendment, applied in this process with whatever runner the run registered. */
  async function amendHere(
    runId: string,
    proposed: unknown,
    run: DaemonRun | undefined,
    actor: Actor = 'operator',
    reason?: string,
  ): Promise<
    | { readonly ok: true; readonly body: AmendResponse }
    | { readonly ok: false; readonly code: string; readonly issues: Issue[] }
  > {
    if (actor === 'coordinator') {
      // Checked against the run as it stands, before anything moves. A
      // proposal that is not a workflow at all falls through to `amendRun`,
      // which refuses it with located issues.
      const parsed = WorkflowSchema.safeParse(proposed)
      if (parsed.success) {
        const refusals = coordinatorRefusals(journal.readWorkflow(runId), parsed.data, {
          authority: authorityOf(run),
        })
        if (refusals.length > 0) {
          return {
            ok: false,
            code: 'coordinator_forbidden',
            issues: refusals.map((issue) => ({ path: issue.path.join('.'), code: 'coordinator_forbidden', message: issue.message })),
          }
        }
      }
    }
    const runner = amendRunner(run)
    const result = await amendRun({
      journal,
      runId,
      proposed,
      ...(runner === undefined ? {} : { runner }),
      ...(actor === 'coordinator' ? { author: 'coordinator' as const } : {}),
      ...(reason === undefined ? {} : { reason }),
    })
    if (!result.ok) return { ok: false, code: result.code, issues: toWireIssues(result.issues, result.code) }
    return {
      ok: true,
      body: {
        ok: true,
        amendment: result.amendment,
        runId,
        changes: result.changes.map((change) => ({ node: change.node, kind: change.kind })),
        affected: [...result.affected],
        applied: [...result.applied],
        rebased: [...result.rebased],
        waiting: result.waiting.map((entry) => ({ ...entry })),
      },
    }
  }

  /**
   * One amendment, asked of the job hosting the run. The job's own refusal is
   * passed back as it came — its codes and located issues are the ones the
   * editor already knows — and anything that is neither an amendment nor an
   * error body counts as the job being unreachable.
   */
  async function amendThere(
    remote: Upstream,
    runId: string,
    proposed: unknown,
  ): Promise<
    | { readonly kind: 'applied'; readonly body: AmendResponse }
    | { readonly kind: 'refused'; readonly status: 400 | 404 | 409; readonly body: unknown }
    | { readonly kind: 'unreachable' }
  > {
    let response: Response
    try {
      response = await fetch(new URL(`/api/runs/${encodeURIComponent(runId)}/amend`, remote.url), {
        method: 'POST',
        headers: { authorization: `Bearer ${remote.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(proposed),
      })
    } catch (error) {
      log.warn('editor.amend_unreachable', { run: runId, ...errorFields(error) })
      return { kind: 'unreachable' }
    }
    const body: unknown = await response.json().catch(() => null)
    if (response.ok) {
      const parsed = AmendResponseSchema.safeParse(body)
      return parsed.success ? { kind: 'applied', body: parsed.data } : { kind: 'unreachable' }
    }
    const status = response.status
    if ((status === 400 || status === 404 || status === 409) && ErrorResponseSchema.safeParse(body).success) {
      return { kind: 'refused', status, body }
    }
    log.warn('editor.amend_failed', { run: runId, status })
    return { kind: 'unreachable' }
  }

  function workflow(runId: string): Workflow {
    const path = join(journal.root, 'runs', runId, 'workflow.json')
    let mtimeMs = -1
    try {
      mtimeMs = statSync(path).mtimeMs
    } catch {
      // Unreadable is `readWorkflow`'s to report.
    }
    const cached = workflows.get(runId)
    if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.workflow
    const read = journal.readWorkflow(runId)
    workflows.set(runId, { mtimeMs, workflow: read })
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

  function resolveLeaseRun(
    c: Context,
  ):
    | { run: DaemonRun & { agentLeases: NonNullable<DaemonRun['agentLeases']> }; row: RunRow }
    | { response: Response } {
    const runId = c.req.param('runId') ?? ''
    const row = journal.run(runId)
    if (row === undefined) return { response: fail(c, 404, 'unknown_run') }
    const run = runs.get(runId)
    if (run === undefined) return { response: fail(c, 409, 'run_not_live') }
    if (run.agentLeases === undefined) return { response: fail(c, 501, 'leases_unavailable') }
    return { run: run as DaemonRun & { agentLeases: NonNullable<DaemonRun['agentLeases']> }, row }
  }

  /**
   * The answer for a holder the daemon will not serve, or null to go on.
   *
   * A node that is not `running` has no live session, so whatever is asking
   * on its behalf is a leftover — a command its last session backgrounded and
   * left behind — and queueing it would hold capacity for nobody.
   */
  function refuseHolder(c: Context, runId: string, holderNode: string): Response | null {
    // A command an operator runs with `exec` on a lane no phase is in holds as
    // itself, and only while it runs (`execHolder`).
    if (holderNode.startsWith(execHolder(''))) {
      return runs.get(runId)?.exec?.holds(holderNode) === true ? null : fail(c, 409, 'holder_not_running')
    }
    const row = journal.nodes(runId).find((node) => node.node_id === holderNode)
    if (row === undefined) return fail(c, 400, 'invalid_holder')
    if (row.status !== 'running') return fail(c, 409, 'holder_not_running')
    return null
  }

  function laneIndex(runId: string): ReadonlyMap<string, string | null> {
    return new Map(journal.nodes(runId).map((row) => [row.node_id, row.lane]))
  }

  /**
   * Everyone holding any of `resources` right now: agents' leases, gates
   * agents asked for, and phases' own gate steps (the scheduler's journal
   * rows). Ids, lanes and a pid — never a command (§11).
   */
  function holdersOf(runId: string, run: DaemonRun, resources: readonly string[]): ResourceHolder[] {
    const wanted = new Set(resources)
    const lanes = laneIndex(runId)
    const holders: ResourceHolder[] = []
    const agentLeases = run.agentLeases?.held() ?? []
    for (const held of agentLeases) {
      for (const resource of held.resources) {
        if (wanted.has(resource)) holders.push(withHolder(held, resource, lanes))
      }
    }
    for (const flight of run.agentGates?.running?.() ?? []) {
      for (const resource of flight.requires) {
        if (!wanted.has(resource)) continue
        holders.push({
          resource,
          node: flight.holderNode,
          lane: lanes.get(flight.holderNode) ?? null,
          via: 'gate',
          gate: flight.gateId,
        })
      }
    }
    const leaseIds = new Set(agentLeases.map((held) => held.leaseId))
    for (const row of journal.leases()) {
      if (!wanted.has(row.resource) || !lanes.has(row.holder_node) || leaseIds.has(row.lease_id)) continue
      holders.push({
        resource: row.resource,
        node: row.holder_node,
        lane: lanes.get(row.holder_node) ?? null,
        via: 'gate_step',
      })
    }
    return holders
  }

  /** `resolveLeaseRun`'s twin. Same three refusals, about the other port. */
  function resolveGateRun(
    c: Context,
  ):
    | { run: DaemonRun & { agentGates: NonNullable<DaemonRun['agentGates']> }; row: RunRow }
    | { response: Response } {
    const runId = c.req.param('runId') ?? ''
    const row = journal.run(runId)
    if (row === undefined) return { response: fail(c, 404, 'unknown_run') }
    const run = runs.get(runId)
    if (run === undefined) return { response: fail(c, 409, 'run_not_live') }
    if (run.agentGates === undefined) return { response: fail(c, 501, 'gates_unavailable') }
    return { run: run as DaemonRun & { agentGates: NonNullable<DaemonRun['agentGates']> }, row }
  }

  async function operate<T>(
    c: Context,
    schema: z.ZodType<T>,
    apply: (run: DaemonRun, nodeId: string, body: T, actor: Actor, reason: string | undefined) => unknown,
  ): Promise<Response> {
    const found = resolveNode(c)
    if ('response' in found) return found.response
    // Reading a finished node is fine; steering one is not — there is no
    // scheduler left to receive the instruction. It refuses with 409 rather
    // than 404 because the run *does* exist: answering "unknown" would send the
    // operator hunting for a typo instead of reading the status in front of
    // them.
    if (found.run === null) return fail(c, 409, 'run_not_live')
    const actor = actorOf(c)
    const reason = reasonOf(c)
    if (actor === 'coordinator' && reason === undefined) return fail(c, 400, 'reason_required')

    const body = await readBody(c, schema)
    if ('issues' in body) return fail(c, 400, 'invalid_request', body.issues)

    let result: unknown
    try {
      result = await apply(found.run, found.node.node_id, body.value, actor, reason)
    } catch (error) {
      // A refusal of the coordinator is its own code: it is not a failure of
      // the operation, and the coordinator reads it to know to stop asking.
      if (error instanceof CoordinatorForbidden) return fail(c, 403, 'coordinator_forbidden')
      // A reassignment or a step the run cannot make says which and why —
      // ids only, composed by the scheduler for exactly this.
      const refused = refusalOf(error)
      if (refused !== null) return fail(c, 409, refused.code, [{ path: '', code: refused.code, message: refused.message }])
      // Codes only. The thrown message belongs to a harness or a scheduler and
      // is not this layer's to relay into a browser.
      return fail(c, 409, 'operation_failed')
    }
    // The delivery the scheduler journalled, so a pause that did nothing says
    // `ignored` rather than an `ok` an operator reads as done.
    const delivery = OperationResponseSchema.shape.delivery.safeParse(result)
    return c.json({ ok: true, ...(delivery.success && delivery.data !== undefined ? { delivery: delivery.data } : {}) })
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
    const steps = journal.nodeSteps(row.id)
    const mine = new Set(nodes.map((node) => node.node_id))
    const leases = journal.leases().filter((lease) => mine.has(lease.holder_node))

    const gatePools = new Set<string>()
    for (const gate of Object.values(wf.gates)) {
      for (const resource of gate.requires) gatePools.add(resource)
    }

    return {
      run: runSummary(row),
      cursor,
      nodes: nodes.map((node) =>
        nodeSummary(node, names.get(node.node_id) ?? node.node_id, steps.get(node.node_id) ?? null),
      ),
      integration: (({ queue, ...rest }) => ({ ...rest, queue: [...queue] }))(journal.integrationWorktree(row.id)),
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
      // A live run only reports harnesses it loaded an adapter for. A node row
      // can still name one it did not — a phase amended away from it before
      // this daemon came up — and admission throws on a harness it was never
      // configured with, which turned the whole snapshot into a 500.
      harnesses: [...new Set(nodes.map((node) => node.harness))]
        .filter((id) => run === null || (run.admission.has?.(id) ?? true))
        .sort()
        .map((id) => ({
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

function nodeSummary(row: NodeRow, name: string, step: string | null): RunSnapshot['nodes'][number] {
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
    step,
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

function pullRequest(journal: Journal, runId: string, nodeId: string): NodeDetail['pullRequest'] {
  const event = journal.latestPr(runId, nodeId)
  if (event === undefined) return null
  const payload = PrPayloadSchema.safeParse(event.payload)
  if (!payload.success) return null
  const { opened, url, reason } = payload.data
  // Only a forge URL reaches the browser as a link: the payload is read off
  // disk, and an `href` is the one field here a browser would act on.
  const safeUrl = url !== undefined && /^https:\/\//.test(url) ? url : null
  return {
    opened,
    url: safeUrl,
    number: safeUrl === null ? null : (prNumberOf(safeUrl) ?? null),
    reason: reason ?? null,
  }
}

/** The `node_pr` journal payload, read back off disk. */
const PrPayloadSchema = z.object({
  opened: z.boolean(),
  url: z.string().optional(),
  reason: z.enum(['unavailable', 'failed']).optional(),
})

/** The journal payload, read back off disk — hence parsed rather than cast. */
const SessionPayloadSchema = z.object({
  slot: z.string(),
  disposition: z.enum(['reused', 'fresh']),
  session_id: z.string().optional(),
  reason: z.string().optional(),
})

/** What one gate's rows fold down to, for the node view's panel. */
interface GateRun {
  status: 'running' | 'passed' | 'failed' | 'timed_out'
  startedAt: number | null
  finishedAt: number | null
  durationMs: number | null
  cached: boolean
  runs: number
}

/**
 * The latest attempt per gate, folded from the node's `gate_started` /
 * `gate_result` rows in commit order.
 *
 * Latest rather than all of them, because a gate re-runs on every fix round
 * and a panel listing four verdicts for `unit` answers "how is this phase
 * doing" with a history nobody asked for. `runs` keeps the count, which is
 * the part of the history that is worth a line.
 *
 * A `gate_started` resets the entry rather than merging into it: the previous
 * verdict belongs to the previous attempt, and carrying its duration into a
 * row now labelled running would put a finished number next to a live clock.
 *
 * Payloads are parsed, not cast. They were written by an older build as often
 * as by this one, and `duration_ms` and `cached` are exactly the fields a
 * journal from before they existed does not carry — so both degrade to "not
 * recorded" instead of to `undefined` reaching the wire schema.
 */
function latestGateRuns(
  events: readonly { type: string; ts: number; payload: unknown }[],
): Map<string, GateRun> {
  const runs = new Map<string, GateRun>()
  for (const event of events) {
    if (event.type === 'gate_result') {
      const payload = GateResultPayloadSchema.safeParse(event.payload)
      if (!payload.success) continue
      const previous = runs.get(payload.data.gate)
      runs.set(payload.data.gate, {
        status: payload.data.status,
        startedAt: previous?.startedAt ?? null,
        finishedAt: event.ts,
        durationMs: payload.data.duration_ms ?? null,
        cached: payload.data.cached ?? false,
        runs: (previous?.runs ?? 0) + 1,
      })
      continue
    }
    const payload = GatePayloadSchema.safeParse(event.payload)
    if (!payload.success) continue
    const previous = runs.get(payload.data.gate)
    runs.set(payload.data.gate, {
      status: 'running',
      startedAt: event.ts,
      finishedAt: null,
      durationMs: null,
      cached: false,
      runs: previous?.runs ?? 0,
    })
  }
  return runs
}

/**
 * Both gate payloads, read back off disk. Which one a row is comes from its
 * `type`, not from which schema happens to accept it — `gate_started`'s
 * payload is a subset of `gate_result`'s, so shape alone cannot tell them
 * apart and a fold that tried would read every verdict as a second start.
 */
const GatePayloadSchema = z.object({ gate: z.string() })

const GateResultPayloadSchema = z.object({
  gate: z.string(),
  status: z.enum(['passed', 'failed', 'timed_out']),
  duration_ms: z.number().int().optional(),
  cached: z.boolean().optional(),
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
 * A start refusal's HTTP status.
 *
 * Split the way the rest of this API splits them: `404` is a thing that is not
 * there, `409` is a thing that is there and is in the wrong state for what was
 * asked. A `409` is worth distinguishing from a `400` here because none of them
 * are the caller's fault — the plan is invalid, the machine is short of disk,
 * the run already finished — and a UI that showed "bad request" for any of them
 * would send the operator looking in the wrong place.
 */
const STATUS_FOR: Readonly<Record<RunStartRefusal, 404 | 409>> = {
  unknown_workflow: 404,
  unknown_run: 404,
  invalid_workflow: 409,
  run_finished: 409,
  run_active: 409,
  environment: 409,
  provision: 409,
}

/**
 * `501` and `503` are here for one endpoint: a host that wired no harness has
 * no monitor to offer, and a harness that will not start is a failure of
 * something behind this API rather than of the request. Both are distinct from
 * "your request was wrong", which is what the other four say.
 */
/**
 * A refusal the scheduler composed for the caller — a reassignment or a step
 * the run cannot make, a harness with no adapter — as a code and its message.
 * Those messages are ids by construction; nothing else thrown is repeated.
 */
function refusalOf(error: unknown): { readonly code: string; readonly message: string } | null {
  if (error instanceof ReassignRefused || error instanceof UnknownHarness) {
    return { code: 'reassign_refused', message: error.message }
  }
  if (error instanceof StepRefused) return { code: 'step_refused', message: error.message }
  return null
}

function fail(
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 501 | 503,
  error: string,
  issues?: Issue[],
): Response {
  return c.json({ error, issues: issues ?? null }, status)
}

/** An agent's `with` lease, as a waiter is told about it. */
function withHolder(
  held: AgentLeaseHeld,
  resource: string,
  lanes: ReadonlyMap<string, string | null>,
): ResourceHolder {
  return {
    resource,
    node: held.holderNode,
    lane: lanes.get(held.holderNode) ?? null,
    via: 'with',
    ...(held.pid === undefined ? {} : { pid: held.pid }),
  }
}

/** One node a halt waits on, as one token of a log field: `node:doing`. */
function activityField(activity: NodeActivity): string {
  return `${activity.node}:${activity.doing}`
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
