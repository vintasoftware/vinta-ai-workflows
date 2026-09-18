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
  'run_chore',
  'git_branch',
  'git_merge',
  'git_push',
  'open_pr',
  'write_tracking',
  'await_human',
  'notify',
] as const

export const AGENT_ROLES = ['implementer', 'reviewer', 'fixer', 'chore', 'conflict-fixer'] as const

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

// ---------------------------------------------------------------------------
// Chores — a declared agent turn inside a phase, for work that is neither
// implementing the brief nor judging it
//
// A gate is a shell command that says pass or fail. A chore is an agent that
// *changes* the tree: rewrite the comments this phase wrote, add the changelog
// entry, extract the strings that need translating. Both are per-phase
// machinery, and that is where the resemblance stops — which is why this is a
// separate registry rather than a second kind of gate.
//
// Three things would break if they shared one. A gate result is cached on the
// lane's tree hash, and a step that edits the tree invalidates its own key by
// running. A gate queues on a `test-suite`-style pool, while an agent turn
// contends for a harness slot and a model quota, which admission control
// already manages. And a gate is the thing standing between a phase and its
// merge; a chore is not allowed to be, which is what `on_failure` defaults to
// `continue` for.
//
// The chore says what to do; the prompt renderer says everything else — which
// phase this is, the diff as the scope, the project's commands, the commit
// protocol, and the one bound that keeps a general slot from turning into a
// second implementer: do what the chore says and nothing more.
// ---------------------------------------------------------------------------

export const ChoreSchema = z.strictObject({
  prompt: z
    .string()
    .min(1)
    .optional()
    .describe('The instruction, inline. Exactly one of `prompt` and `prompt_ref` is required.'),
  prompt_ref: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Where the instruction lives, in `prompt_ref` form (`ai-plans/PLAN.md#deslop`), resolved ' +
        'by the same resolver as a phase brief. Prefer it over `prompt` for anything longer ' +
        'than a sentence: it keeps the text reviewable in the plan rather than in a JSON string.',
    ),
  skill: z
    .string()
    .min(1)
    .optional()
    .describe(
      'A skill the agent should use, named in the prompt rather than passed as a harness flag — ' +
        'codex and opencode have no skills, and a chore that only works on one harness is a ' +
        'chore that silently does nothing on the other two.',
    ),
  session: z
    .string()
    .min(1)
    .default('main')
    .describe(
      'The session slot this turn continues (§15). `main` — the default — is the implementer’s: ' +
        'the agent that wrote the phase already holds the brief, the diff and its own reasons, ' +
        'and that is most of what makes a chore cheap. A slot no other effect names starts a ' +
        'fresh session every time and pays for a cold context.',
    ),
  model: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Overrides the model the phase’s implementer would otherwise run at. A mechanical pass ' +
        'does not need the tier the phase was staffed at.',
    ),
  on_failure: z
    .enum(['continue', 'fail'])
    .default('continue')
    .describe(
      '`continue` — the default — journals a failed chore and moves on to the gates. A chore is ' +
        'polish, and losing an implemented phase to one that timed out is the worse trade. ' +
        '`fail` is for a chore whose output the phase is not correct without.',
    ),
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
// this feature need at once, and is any of them too low a tier for what it was
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
  chores: z
    .array(Id)
    .optional()
    .describe(
      'The chores this phase runs, in order. Optional rather than defaulted, and that is the ' +
        'whole of its override rule: absent takes `defaults.chores`, and a list — `[]` included ' +
        '— replaces it. Merging instead would leave no way to skip a run-wide chore on the one ' +
        'phase it makes no sense for.',
    ),
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
  max_fix_rounds: z
    .number()
    .int()
    .min(0)
    .default(2)
    .describe(
      'Rounds the fixer gets to clear a review’s findings before the phase fails. Two is a ' +
        'budget, not a target, and it is measured in *rounds* rather than findings — a first ' +
        'review raising four legitimate blockers can exhaust it while every round is making ' +
        'progress. Raise it on a phase you expect to be argued over; it is the knob that ' +
        'decides how much a phase gets to be wrong before it is handed to `--on-failure`.',
    ),
})

// ---------------------------------------------------------------------------
// The project — what a lane has to become a working checkout of it (§8)
//
// This block used to record only the databases to fork and the command that
// migrates the template they fork from. Everything else a runnable checkout
// needs — env files, compose isolation, redis indices, service namespaces —
// was documented as `prepare-worktree`'s, discovered per worktree and read back
// off the summary.
//
// That division did not survive contact. The daemon provisions its own lanes;
// it never invokes the skill, so the skill's half of the contract simply did
// not run, and a lane came up as a worktree with no `.env`, a compose stack
// publishing the same fixed host ports as its five siblings, and — worse and
// silently — every lane's stack mounting the same `external: true` data
// volumes. The knowledge was real and written down, and nothing executed it.
//
// So the fields below are the ones the daemon must be able to act on itself:
// the files a lane needs a copy of, the commands the project runs, the
// services a lane needs its own namespace inside, and the project's own
// setup hook for whatever remains irreducibly its. `prepare-worktree` still
// owns discovering these for a project that has never declared them — it
// writes this block — and still owns the interactive human path.
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

export const CommandsSchema = z
  .strictObject({
    lint: z.string().min(1).optional(),
    typecheck: z.string().min(1).optional(),
    test: z.string().min(1).optional().describe('The whole suite.'),
    test_one: z
      .string()
      .min(1)
      .optional()
      .describe('A single test or a subtree. The agent appends the target, so end it accordingly.'),
    migrate: z.string().min(1).optional(),
  })
  .describe(
    'The project’s own command lines, handed to every agent verbatim. A fixed vocabulary ' +
      'rather than free-form, because the prompt has to be able to say which one step 3 of ' +
      'the working instructions means. Declaring these is how an agent stops guessing: a ' +
      'project whose suite only runs inside a container, or only against a lane-specific ' +
      'database, has no way of telling one otherwise, and `pytest` is a plausible guess that ' +
      'is wrong in exactly that project.',
  )

export const ServiceSchema = z
  .strictObject({
    namespace: z
      .enum(['index', 'name'])
      .describe(
        'How this lane’s namespace inside the shared server is derived. `index` is a small ' +
          'integer, for a server with a fixed number of slots — redis’s sixteen databases are ' +
          'the case it exists for. `name` is a token derived from the lane, for a server that ' +
          'names things freely: a vhost, a bucket prefix, a schema.',
      ),
    url: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The shared server, without the per-lane segment — `redis://localhost:6379`. Omit it ' +
          'where the namespace *is* the value: an object-storage prefix has no URL to hang off, ' +
          'and the variable then carries the bare token.',
      ),
    url_var: z.string().min(1).describe('Env var the lane reads this service’s address from.'),
    capacity: z
      .number()
      .int()
      .min(1)
      .default(16)
      .describe(
        'How many distinct namespaces the server has. Only meaningful for `index`, where a ' +
          'pool larger than this is refused before anything is created — two lanes on one ' +
          'redis database is the bug this exists to prevent, and reaching it by arithmetic is ' +
          'no better than reaching it by neglect.',
      ),
    create_cmd: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Run once per lane, in the lane. `{namespace}`, `{url}` and `{lane}` are substituted. ' +
          'Declaring a vhost is a `rabbitmqadmin` invocation this package has no business ' +
          'knowing; a project that needs none declares none.',
      ),
    reset_cmd: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Empties this lane’s namespace when the lane is handed to the next phase. Same ' +
          'substitutions. A service without one keeps whatever the last phase left in it, ' +
          'which for a cache is usually right and for a queue usually is not — declaring this ' +
          'is how a project says which of those it has.',
      ),
  })
  .describe('A shared server each lane gets its own namespace inside.')

export const ComposeSchema = z
  .strictObject({
    enabled: z
      .boolean()
      .default(true)
      .describe(
        'Whether lane provisioning generates a compose override. On by default, and it does ' +
          'nothing at all in a project with no compose file. Where there is one and docker ' +
          'cannot answer, provisioning fails rather than quietly producing lanes that share ' +
          'a data volume — set this to false to say that is genuinely what you want.',
      ),
    publish: z
      .array(z.string().min(1))
      .default([])
      .describe(
        'Services that must keep a reachable host port, republished on one this lane was ' +
          'granted instead of the one the project pinned. Empty is the default and is usually ' +
          'right outright: where the project’s own test command runs inside compose, services ' +
          'reach each other by container DNS on the lane’s own network and a published port ' +
          'buys nothing but a collision. The granted port reaches the lane as ' +
          '`LANE_PORT_<SERVICE>_<CONTAINER_PORT>`.',
      ),
    shared_volumes: z
      .array(z.string().min(1))
      .default([])
      .describe(
        'Volume keys that leak past the project name and are to be left leaking. The escape ' +
          'hatch for the one decision this cannot make for you: re-pinning a shared dependency ' +
          'volume is correct, and it costs every lane the install that sharing it was avoiding. ' +
          'A read-only cache with no dependency churn in the plan is safe here. A data volume ' +
          'never is — that is two servers on one data directory, which is the bug this exists ' +
          'to prevent.',
      ),
  })
  .describe('How a lane’s compose stack is isolated past `COMPOSE_PROJECT_NAME`.')

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
    env_files: z
      .array(z.string().min(1))
      .default([])
      .describe(
        'Repo-relative ignored files every lane needs its own COPY of — `.env`, `.env.docker`, ' +
          '`.envrc`. Copied, never symlinked: lane provisioning appends to them (a connection ' +
          'string, a compose override path), and a symlink would write those lane-specific ' +
          'lines back into the main checkout. A declared file that is missing fails ' +
          'provisioning rather than producing a lane whose stack cannot boot.',
      ),
    commands: CommandsSchema.default({}),
    hooks: z
      .enum(['run', 'skip'])
      .default('run')
      .describe(
        'Whether the repository’s git hooks run on commits made inside a lane. `run` is the ' +
          'default and is what a developer’s own checkout does. `skip` points the lane at an ' +
          'empty `core.hooksPath`, for the case this exists for: a `language: system` ' +
          'pre-commit chain that, in a worktree that has never been committed in, builds a ' +
          'virtualenv per lane before it will let a commit through — observed as four failed ' +
          'commit attempts, one of them a two-minute timeout, and a 510 MB `.venv` per lane. ' +
          'The gates still run; this only stops each lane paying a whole-environment install ' +
          'to make a commit.',
      ),
    services: z
      .record(Id, ServiceSchema)
      .default({})
      .describe(
        'Shared servers each lane gets its own namespace inside, by id. One postgres, one ' +
          'redis, one rabbit on the machine, with a database / db index / vhost per lane — ' +
          'which is the difference between six lanes being viable on a laptop and not. The ' +
          'alternative a project falls into without this is booting a server per lane, or ' +
          'sharing one with no isolation at all.',
      ),
    compose: ComposeSchema.default(() => ({ enabled: true, publish: [], shared_volumes: [] })),
    prepare_cmd: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Run in the repository root **before anything else a run does** — before the preflight, ' +
          'before the template databases, before the first worktree. Its job is to make the ' +
          'shared servers this project’s lanes connect to reachable: `docker compose up -d ' +
          '--wait db redis` for a stack in the root checkout, `brew services start postgresql` ' +
          'for a host install, nothing at all for a project whose lanes boot their own. ' +
          '`setup_cmd` cannot do this — it runs per lane, long after the template database has ' +
          'been created on a server that had to be up already. MUST be idempotent: it runs ' +
          'again before every lane recycle, which is what restores a server that died mid-run. ' +
          'Note that `--wait` only waits for services that declare a `healthcheck`; without one ' +
          'it returns as soon as the container is started, and `createdb` races the server.',
      ),
    setup_cmd: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The project’s own lane-setup command, run inside each freshly provisioned lane with ' +
          'that lane’s environment applied. The escape hatch for whatever a project needs that ' +
          'no field here describes. It MUST be idempotent: it runs again every time the lane is ' +
          'recycled for another phase.',
      ),
  })
  .describe(
    'What a lane needs to be a working checkout of this project. Optional: with no project ' +
      'block a lane is a worktree and nothing else.',
  )

export const DefaultsSchema = z.strictObject({
  harness: z.enum(HARNESS_IDS),
  model: z.string().min(1),
  pipeline: Id,
  chores: z
    .array(Id)
    .default([])
    .describe(
      'The chores every phase runs unless it names its own. Most chores are run-wide — a ' +
        'comment pass, a changelog entry — and repeating them on every node is how one phase ' +
        'ends up quietly missing one.',
    ),
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
    chores: z
      .record(Id, ChoreSchema)
      .default({})
      .describe(
        'Agent turns a phase runs beside its gates, by id. A gate judges and a chore changes ' +
          'the tree, so they are separate registries — see ChoreSchema.',
      ),
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
export type Chore = z.infer<typeof ChoreSchema>
export type Project = z.infer<typeof ProjectSchema>
export type ProjectService = z.infer<typeof ServiceSchema>
export type ProjectCommands = z.infer<typeof CommandsSchema>
export type ProjectDatabase = z.infer<typeof DatabaseSchema>
export type Resource = z.infer<typeof ResourceSchema>
export type CrewMember = z.infer<typeof CrewMemberSchema>
export type Pipeline = z.infer<typeof PipelineSchema>
export type SideEffect = z.infer<typeof SideEffectSchema>
export type HarnessId = (typeof HARNESS_IDS)[number]
export type EffectId = (typeof EFFECT_IDS)[number]
export type AgentRole = (typeof AGENT_ROLES)[number]
