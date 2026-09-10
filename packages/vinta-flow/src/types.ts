/**
 * Source of truth for the workflow document.
 *
 * `schemas/workflow.v1.schema.json` at the repo root is GENERATED from this
 * file (`pnpm --filter vinta-flow schema:gen`) and drift-checked in CI. Edit
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
// Pipeline state machines — vinta-state-machine-editor's own shape, so the
// editor loads and saves these with no translation layer.
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
  model: z.string().optional().describe('Overrides defaults.model.'),
  max_fix_rounds: z.number().int().min(0).default(2),
})

export const DefaultsSchema = z.strictObject({
  harness: z.enum(HARNESS_IDS),
  model: z.string().min(1),
  pipeline: Id,
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
    base_branch: z.string().min(1).describe('What dependency-free nodes branch from.'),
    defaults: DefaultsSchema,
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
export type Resource = z.infer<typeof ResourceSchema>
export type Pipeline = z.infer<typeof PipelineSchema>
export type SideEffect = z.infer<typeof SideEffectSchema>
export type HarnessId = (typeof HARNESS_IDS)[number]
export type EffectId = (typeof EFFECT_IDS)[number]
export type AgentRole = (typeof AGENT_ROLES)[number]
