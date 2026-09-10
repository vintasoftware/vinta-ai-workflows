/**
 * The wire contract, in the package's schema language.
 *
 * Every request body and every response body has a schema here, and both
 * directions are checked:
 *
 * - **Requests**, because the UI is a client of this API, not a trusted peer.
 *   It is a browser page, reachable by anything that got hold of the token,
 *   and "the only client is ours" is a sentence that stops being true the
 *   first time someone scripts against it.
 * - **Responses**, because the schemas are the contract the UI codegens and
 *   asserts against. A projection that quietly grows a field or nulls one is
 *   exactly the drift the run view cannot detect on its own.
 *
 * Two shape conventions, both from `tsconfig`'s `exactOptionalPropertyTypes`
 * and both worth stating: response fields that may be absent are **nullable,
 * never optional** — a client that has to distinguish "missing key" from
 * "null" has been handed a puzzle instead of a contract. Request fields are
 * the opposite: strict objects with no unknown keys, so a typo is a 400 rather
 * than a silently ignored instruction.
 *
 * Error bodies carry a code, a path and zod's own message. They never carry
 * the offending value: a request body may hold steering text or a pasted
 * excerpt of the repository, and an error is the one place that must not
 * become a second copy of it.
 */
import { z } from 'zod'
import type { HarnessCapabilities } from '../harness/adapter.ts'
import type { NodeStatus, RunStatus } from '../journal/events.ts'
import { WorkflowSchema } from '../types.ts'

/** Compile-time exhaustiveness: a new status must be added to the enum below. */
type Covers<Union extends string, Listed extends string> = [Exclude<Union, Listed>] extends [never]
  ? true
  : never

const NODE_STATUSES = [
  'pending',
  'running',
  'waiting_on_capacity',
  'awaiting_human',
  'blocked',
  'done',
  'failed',
] as const satisfies readonly NodeStatus[]
const RUN_STATUSES = ['running', 'done', 'failed'] as const satisfies readonly RunStatus[]

export type _NodeStatusCovered = Covers<NodeStatus, (typeof NODE_STATUSES)[number]>
export type _RunStatusCovered = Covers<RunStatus, (typeof RUN_STATUSES)[number]>

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const IssueSchema = z.strictObject({
  /** Dotted path into the body. Empty string means the body itself. */
  path: z.string(),
  code: z.string(),
  message: z.string(),
})

export const ErrorResponseSchema = z.strictObject({
  /** A stable code, not prose: `unauthorized`, `invalid_request`, `unknown_run`… */
  error: z.string(),
  issues: z.array(IssueSchema).nullable(),
})

// ---------------------------------------------------------------------------
// Requests — the five operations of §9
// ---------------------------------------------------------------------------

export const AddContextRequestSchema = z.strictObject({ text: z.string().min(1) })
export const RedirectRequestSchema = z.strictObject({ instruction: z.string().min(1) })
/** Pause and abort take no arguments; the strict empty object rejects the typo. */
export const NoArgsRequestSchema = z.strictObject({})

/** §9.1 — the answer lands in the guard context as `human.answer`. */
export const AnswerRequestSchema = z.strictObject({
  answer: z.union([z.string(), z.number(), z.boolean(), z.null()]),
})

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const OkResponseSchema = z.strictObject({ ok: z.literal(true) })

export const RunSummarySchema = z.strictObject({
  runId: z.string(),
  workflowId: z.string(),
  status: z.enum(RUN_STATUSES),
  baseBranch: z.string(),
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
})

export const RunListResponseSchema = z.strictObject({ runs: z.array(RunSummarySchema) })

export const NodeSummarySchema = z.strictObject({
  nodeId: z.string(),
  /**
   * The display name from the frozen workflow (§5.3), not the row: node rows
   * are projected from events and the name is plan prose, not run state. Falls
   * back to the id for a node the snapshot no longer declares.
   */
  name: z.string(),
  status: z.enum(NODE_STATUSES),
  wave: z.number().int(),
  lane: z.string().nullable(),
  branch: z.string().nullable(),
  baseBranch: z.string().nullable(),
  harness: z.string(),
  sessionId: z.string().nullable(),
})

/** One capacity pool as of now (§10's pool meters). `holders` are node ids. */
export const ResourceStateSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(['worktree', 'semaphore']),
  capacity: z.number().int(),
  held: z.number().int(),
  holders: z.array(z.string()),
})

/**
 * §7's capability block, on the wire.
 *
 * It lives on the harness rather than on the node because that is whose
 * property it is. A node carries a harness *id*; repeating the block per node
 * would put thirty copies of one fact in a snapshot and make it possible for
 * two of them to disagree — the same drift this field exists to end, moved
 * inside a single response.
 *
 * The keys are held to the adapter interface at compile time below, and the
 * values are read off the adapters themselves in `harnesses.ts`, so there is
 * no second declaration of what a harness can do.
 */
export const HarnessCapabilitiesSchema = z.strictObject({
  /** Deliver a message into a running turn. */
  inject: z.boolean(),
  interrupt: z.boolean(),
  /** Continue a prior session by id. */
  resume: z.boolean(),
  /** Interactive takeover. */
  pty: z.boolean(),
  /** Non-interactive tool permission policy. */
  permissionControl: z.boolean(),
})

type WireCapability = keyof z.infer<typeof HarnessCapabilitiesSchema>

/** Compile-time, both ways: a capability added or dropped by §7 breaks here. */
export type _CapabilitiesCovered = Covers<keyof HarnessCapabilities, WireCapability> &
  Covers<WireCapability, keyof HarnessCapabilities>

/** §6.1's per-harness state: the discovered ceiling and any wait window. */
export const HarnessStateSchema = z.strictObject({
  id: z.string(),
  ceiling: z.number().int(),
  inFlight: z.number().int(),
  /** Epoch ms, or null when the harness is not parked. */
  wakeAt: z.number().int().nullable(),
  /**
   * What this harness can do, or null when the daemon has no adapter under
   * that id — a test double, an out-of-tree adapter. Null is not "nothing":
   * it is "not declared", and the UI degrades to assuming nothing rather than
   * claiming a capability nobody stated.
   */
  capabilities: HarnessCapabilitiesSchema.nullable(),
})

/**
 * The gate queue. `waiting` is every holder enqueued in the pools, and
 * `holders` is who currently occupies a gate pool. Positions are not served:
 * `ResourcePools` publishes an aggregate count and no per-waiter identity, so
 * a position would have to be invented here.
 */
export const GateQueueSchema = z.strictObject({
  waiting: z.number().int(),
  holders: z.array(
    z.strictObject({ resource: z.string(), nodeId: z.string(), acquiredAt: z.number().int() }),
  ),
})

/**
 * One dependency, as §10's graph draws it: an arrow from the upstream node to
 * the one that needs it, labelled with what it needs. `artifact` is required
 * in the workflow schema for exactly this reason — an unlabelled edge says
 * only that an order exists, not why.
 */
export const RunEdgeSchema = z.strictObject({
  /** The upstream node id — the dependency. */
  from: z.string(),
  /** The node that declared the dependency. */
  to: z.string(),
  artifact: z.string(),
})

export const RunSnapshotSchema = z.strictObject({
  run: RunSummarySchema,
  /**
   * The id of the newest event this snapshot reflects, or 0 for a run with
   * none. A client with no stored position streams from here: it is already
   * current as of this id, so `?since=<cursor>` costs no replay and can skip
   * nothing — the cursor is read before the projections beside it, so it can
   * only lag them, never lead them.
   */
  cursor: z.number().int(),
  nodes: z.array(NodeSummarySchema),
  /** The frozen workflow's dependencies, in declaration order (§10). */
  edges: z.array(RunEdgeSchema),
  resources: z.array(ResourceStateSchema),
  gateQueue: GateQueueSchema,
  harnesses: z.array(HarnessStateSchema),
})

/** §9.1's question, rendered inline in the node view with its context. */
export const HumanQuestionSchema = z.strictObject({
  question: z.string(),
  kind: z.enum(['confirm', 'choice', 'text']),
  choices: z.array(z.string()).optional(),
  context: z
    .strictObject({
      diffRef: z.string().optional(),
      gateLogRef: z.string().optional(),
      transcriptCursor: z.number().int().optional(),
    })
    .optional(),
})

/**
 * What a `git diff` needs, not the diff itself. Computing it means running git
 * in the lane, which is the git unit's job; the node view asks for it by ref.
 */
export const DiffRefSchema = z.strictObject({
  branch: z.string().nullable(),
  baseBranch: z.string().nullable(),
  lane: z.string().nullable(),
})

export const NodeDetailSchema = z.strictObject({
  runId: z.string(),
  node: NodeSummarySchema,
  diff: DiffRefSchema,
  transcript: z.strictObject({
    stream: z.enum(['transcript', 'raw']),
    /** The last `limit` entries. Transcripts are tailed, never paged backwards. */
    entries: z.array(z.unknown()),
  }),
  /** One entry per declared gate that has produced a log, tail-truncated. */
  gates: z.array(z.strictObject({ gateId: z.string(), log: z.string() })),
  question: HumanQuestionSchema.nullable(),
})

// ---------------------------------------------------------------------------
// Workflows — §10's Editor row
// ---------------------------------------------------------------------------

/**
 * The documents a run can be started from, by id. Deliberately thin: the list
 * exists so the editor can offer something to open, and anything richer would
 * mean parsing every file on disk to answer a menu.
 */
export const WorkflowListResponseSchema = z.strictObject({
  workflows: z.array(z.strictObject({ id: z.string() })),
})

/**
 * One workflow, validated on the way out with the same schema the executor
 * parses it with. A document the daemon cannot vouch for is refused rather
 * than served: the editor's whole claim is that it cannot bless a workflow the
 * executor would reject, and that claim has to hold in both directions.
 */
export const WorkflowResponseSchema = z.strictObject({
  id: z.string(),
  workflow: WorkflowSchema,
})

/**
 * A save. The body is the workflow itself rather than a wrapper — there is no
 * second field to carry, and `parseWorkflow` is the validation either way.
 */
export const SaveWorkflowRequestSchema = WorkflowSchema

/**
 * What a save did to a run that was still in flight (§9's amend path).
 *
 * A save against a workflow with no live run answers `{ok: true}` as before;
 * one that amended a run answers with this instead, because "the document was
 * written" and "three branches were rebased under a running plan" are not the
 * same event and an editor that could not tell them apart would say nothing
 * about the second.
 *
 * Every field is a node id or a classification from the journal's own
 * vocabulary. There is no field a phase body could reach.
 */
export const AmendResponseSchema = z.strictObject({
  ok: z.literal(true),
  /** 1 for the run's first amendment. Matches the journalled ordinal. */
  amendment: z.number().int(),
  runId: z.string(),
  changes: z.array(z.strictObject({ node: z.string(), kind: z.string() })),
  /** Changed nodes plus their transitive dependents, topologically ordered. */
  affected: z.array(z.string()),
  /** Not-yet-started nodes that took the change immediately. */
  applied: z.array(z.string()),
  /** Already-`done` nodes rebased, in the order they were rebased. */
  rebased: z.array(z.string()),
})

// ---------------------------------------------------------------------------
// The WebSocket envelope
// ---------------------------------------------------------------------------

/**
 * Every frame is discriminated by `channel`. Only `events` exists today; PTY
 * bytes are step 17 and arrive as a second member of this union, which is why
 * the discriminator is here before there is anything to discriminate.
 */
export const EventFrameSchema = z.strictObject({
  channel: z.literal('events'),
  runId: z.string(),
  /** The id of the last event in this frame — the client's next `since`. */
  cursor: z.number().int(),
  events: z.array(
    z.strictObject({
      id: z.number().int(),
      ts: z.number().int(),
      runId: z.string(),
      nodeId: z.string().nullable(),
      type: z.string(),
      payload: z.unknown(),
    }),
  ),
})

export const FrameSchema = z.discriminatedUnion('channel', [EventFrameSchema])

export type AmendResponse = z.infer<typeof AmendResponseSchema>
export type HumanQuestion = z.infer<typeof HumanQuestionSchema>
export type RunSummary = z.infer<typeof RunSummarySchema>
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>
export type NodeDetail = z.infer<typeof NodeDetailSchema>
export type EventFrame = z.infer<typeof EventFrameSchema>
export type Frame = z.infer<typeof FrameSchema>
export type Issue = z.infer<typeof IssueSchema>
export type WorkflowResponse = z.infer<typeof WorkflowResponseSchema>
export type WorkflowListResponse = z.infer<typeof WorkflowListResponseSchema>

/**
 * `validate.ts`'s issues on the wire. Its path is an array of segments; the
 * wire's is the dotted-and-bracketed rendering, so the browser shows the same
 * location string the CLI prints and neither has to re-derive the other's.
 */
export function toWireIssues(
  issues: readonly { readonly path: readonly (string | number)[]; readonly message: string }[],
  code = 'invalid_workflow',
): Issue[] {
  return issues.map((issue) => ({ path: formatPath(issue.path), code, message: issue.message }))
}

/** `nodes[2].depends_on[0].artifact`. The empty path is the document itself. */
export function formatPath(path: readonly (string | number)[]): string {
  return path.reduce<string>(
    (acc, segment) =>
      typeof segment === 'number' ? `${acc}[${segment}]` : acc === '' ? segment : `${acc}.${segment}`,
    '',
  )
}

/**
 * zod issues, flattened and stripped. `unrecognized_keys` is the one code
 * whose message quotes input — the key name — so it is replaced; every other
 * zod v4 message describes the expectation and never the received value.
 */
export function toIssues(error: z.ZodError): Issue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    code: issue.code,
    message: issue.code === 'unrecognized_keys' ? 'Unrecognized key' : issue.message,
  }))
}
