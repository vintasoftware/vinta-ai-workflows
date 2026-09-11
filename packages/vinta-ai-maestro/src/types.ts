/**
 * Source of truth for the workflow document.
 *
 * `schemas/workflow.v1.schema.json` at the repo root is GENERATED from this
 * file (`pnpm --filter vinta-ai-maestro schema:gen`) and drift-checked in CI. Edit
 * here, never there.
 *
 * Shape-level rules live in these schemas. Cross-reference rules — a
 * `depends_on` naming a node that exists, a graph without cycles — cannot be
 * expressed in JSON Schema and live in `validate.ts`.
 */
import { z } from 'zod'

export const HARNESS_IDS = ['claude-code', 'codex', 'opencode'] as const

/** Side effects a pipeline transition may invoke. The host owns this catalog. */
export const EFFECT_IDS = [
  'spawn_agent',
  'run_gate',
  'git_branch',
  'git_merge',
  'git_push',
  'open_pr',
  'write_tracking',
  'await_human',
  'notify',
] as const

export const AGENT_ROLES = ['implementer', 'reviewer', 'fixer', 'conflict-fixer'] as const

const Id = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase kebab-case')
  .min(1)

const Passthrough = z
  .record(z.string(), z.unknown())
  .describe('Host-owned passthrough. Preserved verbatim and never interpreted.')

// ---------------------------------------------------------------------------
// Pipeline state machines — close to vinta-state-machine-editor's own shape,
// but NOT identical: effects are one flat array here and ordered
// {before, after} hooks there, `trigger` is a string here and an object there,
// four of its fields are required and optional here, and its `from` is
// nullable. `ui/src/editor-model.ts` owns that mapping. SPEC §5.2 originally
// claimed there was no translation layer; there is one, and pretending
// otherwise made it somebody's surprise instead of a designed seam.
// ---------------------------------------------------------------------------

export const SideEffectSchema = z.strictObject({
  id: Id.describe('Unique within its containing state or transition.'),
  definitionId: z.enum(EFFECT_IDS).describe('Which catalog verb this effect invokes.'),
  name: z.string().optional().describe('Display label. Falls back to definitionId.'),
  params: z.record(z.string(), z.unknown()).default({}).describe('Arguments for the verb.'),
  enabled: z.boolean().default(true),
  description: z.string().optional(),
  data: Passthrough.optional(),
})

export const StateNodeSchema = z.strictObject({
  id: Id,
  name: z.string().min(1),
  position: z.strictObject({ x: z.number(), y: z.number() }).describe('Canvas position.'),
  onEnter: z.array(SideEffectSchema).default([]).describe('Effects run on entering the state.'),
  onLeave: z.array(SideEffectSchema).default([]).describe('Effects run on leaving the state.'),
  color: z.string().optional(),
  description: z.string().optional(),
  data: Passthrough.optional(),
})

export const TransitionSchema = z.strictObject({
  id: Id,
  name: z.string().optional(),
  from: Id.describe('Source state id.'),
  to: Id.describe('Target state id.'),
  trigger: z.string().optional().describe('Event name that fires this transition.'),
  guard: z
    .string()
    .optional()
    .describe(
      'Opaque boolean expression over the documented guard context ' +
        '(review.verdict, gate.exit_code, human.answer, fix_rounds, node.*, run.*). ' +
        'Evaluated by a restricted evaluator with no host access.',
    ),
  effects: z.array(SideEffectSchema).default([]),
  data: Passthrough.optional(),
})

export const PipelineSchema = z
  .strictObject({
    states: z.array(StateNodeSchema).min(1),
    transitions: z.array(TransitionSchema).default([]),
    initialStateIds: z.array(Id).min(1),
    finalStateIds: z.array(Id).default([]),
    data: Passthrough.optional(),
  })
  .describe('A per-phase pipeline, authored in vinta-state-machine-editor.')

// ---------------------------------------------------------------------------
// The plan graph
// ---------------------------------------------------------------------------

export const ResourceSchema = z.strictObject({
  capacity: z
    .number()
    .int()
    .min(1)
    .describe('Maximum concurrent holders. A starting hint for `lane` — see admission control.'),
  kind: z
    .enum(['worktree', 'semaphore'])
    .describe('`worktree` pools are provisioned lanes; `semaphore` pools are pure counters.'),
  description: z.string().optional(),
})

export const GateSchema = z.strictObject({
  cmd: z.string().min(1).describe('Shell command run in the node’s lane. Not an agent.'),
  requires: z
    .array(Id)
    .default([])
    .describe('Resource pool ids acquired before the gate runs, in canonical order.'),
  timeout_s: z.number().int().min(1).default(1800),
  description: z.string().optional(),
})

export const DependencySchema = z.strictObject({
  node: Id.describe('The upstream node id.'),
  artifact: z
    .string()
    .min(1)
    .describe(
      'What this node needs from the upstream one — a model, a symbol, a migration, ' +
        'an endpoint. Required: it is what the implementer prompt uses to explain what ' +
        'the phase builds on, and a bare id with no reason is usually a plan smell.',
    ),
})

// ---------------------------------------------------------------------------
// The crew — who is on this plan, in what role, and at what tier
//
// The alternative this replaces is a per-node `model`, picked phase by phase
// with nothing anywhere adding it up. That reads fine one node at a time and
// hides the two questions a plan is actually being asked: how many agents does
// this feature need at once, and is any of them too junior for what it was
// handed. A roster answers both before the run starts.
//
// **A member is an agent, not a model.** Each one owns a worktree for the whole
// run and keeps its session across the phases it takes, so what it learned
// about the repository in phase 1 is still in its context in phase 4 — which is
// most of what an agent spends its first turn of a phase rediscovering. The
// worktree is reset between phases and the session is told exactly which files
// that changed; see `sessions.ts`. What made this impossible before was not the
// reset but the *anonymity* of lanes: a member that lands in a different
// directory each phase has a context describing paths it is no longer standing
// in, which is what §15.2's `lane_changed` refuses.
// ---------------------------------------------------------------------------

/**
 * What a member is on the team for. Disjoint on purpose: an agent that both
 * writes and reviews can be handed its own diff, and "the reviewer is never the
 * implementer" then depends on arithmetic going right every time rather than on
 * there being no way to express the mistake.
 */
export const CREW_ROLES = ['implementer', 'reviewer'] as const

export const CrewMemberSchema = z.strictObject({
  role: z
    .enum(CREW_ROLES)
    .default('implementer')
    .describe(
      'Implementers take phases; reviewers read them. No member does both, which is ' +
        'what makes self-review unrepresentable rather than merely unlikely.',
    ),
  tier: z
    .number()
    .int()
    .min(1)
    .max(4)
    .describe(
      'Difficulty tier this member is staffed at, per the plan skill’s rubric. It is a ' +
        'floor on what they may be handed, and the ordering the scheduler substitutes along.',
    ),
  model: z.string().min(1).describe('The model this tier resolves to for this run.'),
  harness: z.enum(HARNESS_IDS).optional().describe('Overrides defaults.harness for this member.'),
  description: z.string().optional().describe('Why the plan staffed this tier.'),
})

export const NodeSchema = z.strictObject({
  id: Id,
  name: z.string().min(1),
  depends_on: z
    .array(DependencySchema)
    .default([])
    .describe('Empty means the node branches from base_branch and may start immediately.'),
  prompt_ref: z.string().min(1).describe('Where the phase brief lives, e.g. `plan.md#phase-1`.'),
  touches: z
    .array(z.string())
    .default([])
    .describe('Touch List. Same-wave overlap is warned about, never refused.'),
  pipeline: Id.optional().describe('Overrides defaults.pipeline.'),
  gates: z.array(Id).default([]),
  harness: z.enum(HARNESS_IDS).optional().describe('Overrides defaults.harness.'),
  model: z
    .string()
    .optional()
    .describe('Overrides defaults.model. Mutually exclusive with `crew`, which carries a model.'),
  crew: Id.optional().describe(
    'The implementer this phase is assigned to. Their tier is the floor for it: a busier ' +
      'roster may hand the phase to a free implementer at that tier or above, never below. ' +
      'Its reviewer is not named here — it is the cheapest reviewer on the roster who is ' +
      'qualified for this phase, and it is never this member.',
  ),
  max_fix_rounds: z.number().int().min(0).default(2),
})

// ---------------------------------------------------------------------------
// The project — what a lane has to become a working checkout of it (§8)
//
// Deliberately not the whole of `prepare-worktree`'s summary. That file records
// what a worktree *is*; this block records only what the daemon must know
// *before* one exists, which is the set of databases to fork and the command
// that migrates the template they are forked from. Everything else the skill
// decides and records — dependency and env strategy, compose networks and
// volume forks, sandbox tier, redis indices, S3 prefixes, seed commands — is
// the skill's, is discovered per worktree, and is read back off the summary.
//
// A database declared here is always *forked*: `share` and `stub` are the
// absence of a declaration, not a value, because a lane that shares the main
// checkout's database is a lane with no database of its own to describe.
// ---------------------------------------------------------------------------

const SqliteDatabaseSchema = z.strictObject({
  engine: z.literal('sqlite'),
  path: z
    .string()
    .min(1)
    .describe('Repo-relative path of the database file, e.g. `db.sqlite3`. Copied per lane.'),
  connection_url_var: z
    .string()
    .min(1)
    .describe('Env var the project reads its connection string from, set per lane.'),
})

const PostgresDatabaseSchema = z.strictObject({
  engine: z.literal('postgres'),
  delivery: z
    .enum(['external', 'compose'])
    .describe(
      '`external` forks a database on an already-running server — the cheap mode, and the ' +
        'one to prefer for pooling. `compose` boots the lane its own server on its own forked ' +
        'volume, which has no template to clone from and therefore no reset: such a lane is ' +
        'single-use and is re-provisioned rather than reset.',
    ),
  name: z.string().min(1).describe('The main checkout’s database name. Lane names derive from it.'),
  server_url: z
    .string()
    .min(1)
    .describe('The server, without the database path segment, e.g. `postgres://localhost:5432`.'),
  connection_url_var: z.string().min(1),
})

export const DatabaseSchema = z
  .discriminatedUnion('engine', [SqliteDatabaseSchema, PostgresDatabaseSchema])
  .describe('One forked database a lane gets its own copy of.')

export const ProjectSchema = z
  .strictObject({
    migrate_cmd: z
      .string()
      .min(1)
      .describe(
        'The project’s own migrate command. Run once per template database — never per lane, ' +
          'which is what makes the Nth lane cost a copy rather than a provision.',
      ),
    databases: z
      .strictObject({
        dev: DatabaseSchema.optional(),
        test: DatabaseSchema.optional(),
      })
      .default({})
      .describe('Roles a lane forks. An undeclared role means the lane has no database of its own.'),
  })
  .describe(
    'What a lane needs to be a working checkout of this project. Optional: with no project ' +
      'block a lane is a worktree and nothing else.',
  )

export const DefaultsSchema = z.strictObject({
  harness: z.enum(HARNESS_IDS),
  model: z.string().min(1),
  pipeline: Id,
  max_session_turns: z
    .number()
    .int()
    .min(1)
    .default(12)
    .describe(
      'Turns one reused session slot may take before the next spawn starts fresh (§15.5). ' +
        'A shared session only ever grows; without a ceiling a long node eventually dies on a ' +
        'context-window error that reads as a broken harness.',
    ),
})

export const WorkflowSchema = z
  .strictObject({
    // Allowed explicitly: the object is closed, and a `$schema` key is how a
    // JSON file opts into editor validation — the same affordance the YAML
    // payloads get from their `# yaml-language-server:` directive.
    $schema: z
      .string()
      .optional()
      .describe('Optional URL of this schema, for editor validation. Ignored at runtime.'),
    schema_version: z.literal(1).describe('Schema major version. Bumped only on breaking changes.'),
    id: Id.describe('Stable identifier for this workflow. Used in branch names.'),
    plan_ref: z
      .string()
      .optional()
      .describe('The human-readable plan this was emitted alongside.'),
    plan_context_refs: z
      .array(z.string().min(1))
      .default([])
      .describe(
        'Sections of the plan that bound every phase rather than any one of them — its ' +
          'Goals + Non-goals and its Guiding Decisions. Each is a file-and-anchor reference ' +
          'in the same form as `prompt_ref` (`ai-plans/PLAN.md#1-goals`), resolved by the ' +
          'same resolver and handed to the implementer and the reviewer verbatim, marked as ' +
          'plan-level. Empty — the default — means the prompts carry the phase brief alone.',
      ),
    base_branch: z.string().min(1).describe('What dependency-free nodes branch from.'),
    project: ProjectSchema.optional(),
    defaults: DefaultsSchema,
    crew: z
      .record(Id, CrewMemberSchema)
      .default({})
      .describe(
        'The agents this plan is staffed with, by id. Empty — the default — means the ' +
          'workflow is unstaffed and every node falls back to `model` / `defaults.model`, ' +
          'which is how workflows written before rosters existed keep running.',
      ),
    resources: z.record(Id, ResourceSchema).describe('Named capacity pools. `lane` is required.'),
    gates: z.record(Id, GateSchema).default({}),
    nodes: z.array(NodeSchema).min(1),
    pipelines: z
      .record(Id, PipelineSchema)
      .default({})
      .describe(
        'Pipelines this workflow authors. Optional: `defaults.pipeline` may name one the ' +
          'package ships (see BUILT_IN_PIPELINES), and a declared id shadows a built-in of ' +
          'the same name. A pipeline is machinery, not plan data — requiring every emitted ' +
          'workflow to carry a verbatim copy would duplicate it into every plan, and a fix ' +
          'to the shipped one would never reach a plan already written.',
      ),
    data: Passthrough.optional(),
  })
  .describe(
    'An executable plan: the phase DAG, the pipelines phases run through, the capacity ' +
      'pools they contend for, and the gates they must pass.',
  )

export type Workflow = z.infer<typeof WorkflowSchema>
export type WorkflowInput = z.input<typeof WorkflowSchema>
export type Node = z.infer<typeof NodeSchema>
export type Dependency = z.infer<typeof DependencySchema>
export type Gate = z.infer<typeof GateSchema>
export type Project = z.infer<typeof ProjectSchema>
export type ProjectDatabase = z.infer<typeof DatabaseSchema>
export type Resource = z.infer<typeof ResourceSchema>
export type CrewMember = z.infer<typeof CrewMemberSchema>
export type Pipeline = z.infer<typeof PipelineSchema>
export type SideEffect = z.infer<typeof SideEffectSchema>
export type HarnessId = (typeof HARNESS_IDS)[number]
export type EffectId = (typeof EFFECT_IDS)[number]
export type AgentRole = (typeof AGENT_ROLES)[number]
