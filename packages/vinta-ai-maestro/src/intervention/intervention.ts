/**
 * What the monitor is allowed to change about a run, and how it says so.
 *
 * The monitor reads a run and explains it (`monitor/monitor.ts`). This is the
 * other half: a run that is *mis-tuned* rather than broken — every phase doing
 * what it was asked, every gate reporting honestly, and the whole thing paying
 * for a test database it re-creates on every gate run because the command says
 * `pytest` and not `pytest --reuse-db`. Nobody needs waking up for that, and
 * the post-mortem finds it out an afternoon too late to help the run it
 * happened in.
 *
 * ## Verbs, not a file handle
 *
 * The monitor has a shell and it runs in the repository, so the short version
 * of this feature is a sentence in its brief telling it to edit
 * `workflow.json`. That would be wrong in the way this package is consistently
 * not wrong: **no unvalidated bytes reach a run's definition.** Every other
 * write to a workflow goes through `parseWorkflow`, and a model holding an
 * `Edit` tool over the snapshot is a second path to the same file with none of
 * the gate in front of it.
 *
 * So the model authors a *proposal* and this module applies it. What that buys
 * is not only validation — it is that the monitor's authority becomes
 * enumerable. "The monitor is not an orchestrator" stops being a claim in a
 * docstring and becomes the set of verbs that exist, which is this file.
 *
 * ## The line the verbs draw
 *
 * > The monitor may change **how** the work is executed. It may never change
 * > **what** work is done.
 *
 * `depends_on`, `prompt_ref`, `touches`, `base_branch`, `pipeline`, and adding
 * or removing phases are therefore not expressible here. Not refused at
 * runtime — *unrepresentable*, which is the same reason `CREW_ROLES` is
 * disjoint rather than checked. It is the line `amend/diff.ts` already draws
 * between `TOPOLOGY_KINDS` / `body_changed` and everything else, so it falls
 * out of machinery that exists.
 *
 * ## Why three verbs are safe and one needs a permit
 *
 * `retime_gate`, `rebudget_fixes` and `retier_phase` are bounded by their own
 * schema types. Set any of them wrongly and the run costs more time or more
 * money; none of them can make a failing gate pass.
 *
 * `retune_gate` can. `--reuse-db` is harmless and `-k not_slow` is a
 * catastrophe, and they are the same edit to the same string. With no human in
 * the loop, a monitor that "optimised" a slow gate by narrowing its selection
 * would produce a run that goes green and ships nothing working — and it would
 * look like success in every log there is. Two mechanisms, and both apply:
 *
 * 1. **The gate must declare `tuning.allowed_flags`** (`types.ts`). A gate that
 *    declares none is not tunable, which is the default. The bound on an
 *    autonomous edit is a list a human wrote in a committed file.
 * 2. **Additions only, in order.** The proposed command must be the existing
 *    command's tokens, in sequence, with new ones inserted. Mechanical, and it
 *    rules out rewriting the selection rather than trusting that nobody will.
 *
 * Neither alone is enough. (1) without (2) permits `pytest -k slow --reuse-db`,
 * which adds an allowed flag and rewrites the suite on the way past. (2)
 * without (1) permits adding `--ignore=tests/slow`, which is purely additive
 * and guts the gate.
 *
 * ## Evidence
 *
 * Every verb requires `evidence`, and no check here can verify it: a model can
 * write a plausible sentence about a log line it never opened. It is required
 * anyway, for two reasons that do not depend on it being true. It is what the
 * post-mortem scores an intervention against afterwards, and a verb that
 * cannot say why it fired is a verb nobody can audit — which, for a change
 * applied with no human present, is the whole of the accountability.
 *
 * **Evidence is the monitor's prose about a run it read.** It is the one field
 * in this module that is not an identifier or a number, and it is journalled
 * in the intervention record rather than in an event payload (§11) for exactly
 * that reason.
 */
import { z } from 'zod'

import type { Workflow } from '../types.ts'
import type { ValidationIssue } from '../validate.ts'

export const INTERVENTION_SCHEMA_URL =
  'https://github.com/vintasoftware/vinta-ai-workflows/schemas/intervention.v1.schema.json'

const Id = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase kebab-case')
  .min(1)

/**
 * Why the change is being made, in the monitor's own words.
 *
 * Bounded because it is written by a model and read by a person: a paragraph
 * is a finding, and anything longer is the transcript, which already exists
 * somewhere it can be read properly.
 */
const Evidence = z
  .string()
  .min(1)
  .max(600)
  .describe(
    'What was observed and where — the gate log line, the durations, the transcript. ' +
      'Unverifiable by construction and required regardless: it is what an intervention ' +
      'is audited and scored against, and a change made with nobody watching that cannot ' +
      'say why it was made is not auditable at all.',
  )

export const RetuneGateSchema = z.strictObject({
  verb: z.literal('retune_gate'),
  gate: Id.describe('The gate id, as the workflow declares it.'),
  cmd: z
    .string()
    .min(1)
    .describe(
      'The proposed command. Must be the current command’s argv tokens, in order, plus ' +
        'tokens drawn from this gate’s `tuning.allowed_flags`. Nothing may be removed or ' +
        'rewritten.',
    ),
  evidence: Evidence,
})

export const RetimeGateSchema = z.strictObject({
  verb: z.literal('retime_gate'),
  gate: Id,
  timeout_s: z.number().int().min(1).describe('The proposed timeout, in seconds.'),
  evidence: Evidence,
})

export const RebudgetFixesSchema = z.strictObject({
  verb: z.literal('rebudget_fixes'),
  node: Id.describe('The phase id.'),
  max_fix_rounds: z.number().int().min(0).max(10),
  evidence: Evidence,
})

export const RetierPhaseSchema = z.strictObject({
  verb: z.literal('retier_phase'),
  node: Id,
  model: z
    .string()
    .min(1)
    .describe(
      'The model to hand this phase. Must already be on the run’s roster — a monitor that ' +
        'could name any string could spend money on a model the plan never staffed, and ' +
        'could name one that does not exist.',
    ),
  evidence: Evidence,
})

export const InterventionVerbSchema = z.discriminatedUnion('verb', [
  RetuneGateSchema,
  RetimeGateSchema,
  RebudgetFixesSchema,
  RetierPhaseSchema,
])

export const InterventionSchema = z
  .strictObject({
    $schema: z
      .string()
      .optional()
      .describe('Optional URL of this schema, for editor validation. Ignored at runtime.'),
    schema_version: z.literal(1).describe('Schema major version. Bumped only on breaking changes.'),
    /**
     * Deliberately allowed to be empty, and the common answer.
     *
     * A monitor that must propose something will propose something. Most slow
     * phases are slow because the work is hard, and "this phase is taking a
     * while and the plan is fine" has to be an expressible conclusion or the
     * feature manufactures changes to justify having been woken up.
     */
    changes: z
      .array(InterventionVerbSchema)
      .max(4)
      .describe(
        'What to change, or nothing. Empty is a real and expected answer: a phase that is ' +
          'slow because its work is hard needs no amendment, and a monitor that cannot say ' +
          'so will invent one.',
      ),
    summary: z
      .string()
      .min(1)
      .max(1000)
      .describe('One paragraph on what was found, whether or not anything is being changed.'),
  })
  .describe(
    'The monitor’s proposal for a run it was woken up about: a closed set of execution-' +
      'tuning verbs, applied by the host through §9’s amend path. It cannot express a change ' +
      'to what a phase builds — only to how the run executes it.',
  )

export type Intervention = z.infer<typeof InterventionSchema>
export type InterventionVerb = z.infer<typeof InterventionVerbSchema>
export type InterventionVerbId = InterventionVerb['verb']

/** Why a proposed verb was not applied. Prose belongs to the issues. */
export type InterventionRefusalCode =
  | 'invalid_proposal'
  | 'unknown_gate'
  | 'unknown_node'
  | 'gate_not_tunable'
  | 'flag_not_allowed'
  | 'command_not_additive'
  | 'command_unparseable'
  | 'model_not_on_roster'
  | 'no_effect'

export interface InterventionRefusal {
  readonly ok: false
  readonly code: InterventionRefusalCode
  readonly issues: readonly ValidationIssue[]
}

export interface InterventionApplied {
  readonly ok: true
  /** The proposal with every refused verb dropped. Never empty. */
  readonly applied: readonly InterventionVerb[]
  /** Verbs that were refused, each with why. An applied proposal may still have these. */
  readonly refused: readonly { readonly verb: InterventionVerb; readonly refusal: InterventionRefusal }[]
  /** The workflow to hand to `amendRun`. */
  readonly workflow: Workflow
}

export type InterventionResult = InterventionApplied | InterventionRefusal

/**
 * Applies a proposal to a workflow, verb by verb.
 *
 * **Partial application is deliberate.** A proposal of three changes where one
 * names a gate that does not exist applies the other two and reports the third
 * as refused. The alternative — all or nothing — makes one hallucinated gate id
 * discard two correct improvements, and the monitor has no way to learn which
 * one was wrong because it is not in the loop to be told. Every refusal is
 * carried out, so the record says exactly what was proposed and what happened
 * to each part of it.
 *
 * Pure: no journal, no git, no IO. `amendRun` owns whether the *run* may take
 * the result, and this owns whether the monitor may propose it.
 */
export function applyIntervention(
  workflow: Workflow,
  intervention: Intervention,
): InterventionResult {
  let next = workflow
  const applied: InterventionVerb[] = []
  const refused: { verb: InterventionVerb; refusal: InterventionRefusal }[] = []

  for (const verb of intervention.changes) {
    const outcome = applyVerb(next, verb)
    if (outcome.ok) {
      next = outcome.workflow
      applied.push(verb)
    } else {
      refused.push({ verb, refusal: outcome })
    }
  }

  if (applied.length === 0) {
    // Not an error when the proposal was empty — but there is nothing to amend
    // either, and handing `amendRun` an identical workflow would journal an
    // amendment in which nothing moved.
    return {
      ok: false,
      code: refused[0]?.refusal.code ?? 'no_effect',
      issues:
        refused.length === 0
          ? [{ path: ['changes'], message: 'the proposal changes nothing' }]
          : refused.flatMap((entry) => entry.refusal.issues),
    }
  }

  return { ok: true, applied, refused, workflow: next }
}

// ---------------------------------------------------------------------------
// One verb at a time
// ---------------------------------------------------------------------------

type VerbResult = { readonly ok: true; readonly workflow: Workflow } | InterventionRefusal

function applyVerb(workflow: Workflow, verb: InterventionVerb): VerbResult {
  switch (verb.verb) {
    case 'retune_gate':
      return retuneGate(workflow, verb)
    case 'retime_gate':
      return retimeGate(workflow, verb)
    case 'rebudget_fixes':
      return rebudgetFixes(workflow, verb)
    case 'retier_phase':
      return retierPhase(workflow, verb)
  }
}

function retuneGate(workflow: Workflow, verb: z.infer<typeof RetuneGateSchema>): VerbResult {
  const at = ['gates', verb.gate]
  const gate = workflow.gates[verb.gate]
  if (gate === undefined) {
    return refuse('unknown_gate', at, `no gate "${verb.gate}" is declared by this workflow`)
  }
  if (gate.tuning === undefined) {
    return refuse(
      'gate_not_tunable',
      [...at, 'tuning'],
      `gate "${verb.gate}" declares no \`tuning\` block, so its command is not the monitor's to change`,
    )
  }
  if (gate.cmd === verb.cmd) {
    return refuse('no_effect', [...at, 'cmd'], `gate "${verb.gate}" already runs this command`)
  }

  const current = tokenize(gate.cmd)
  const proposed = tokenize(verb.cmd)
  if (current === null || proposed === null) {
    return refuse(
      'command_unparseable',
      [...at, 'cmd'],
      `gate "${verb.gate}"'s command cannot be split into argv tokens, so an addition cannot be told from a rewrite`,
    )
  }

  const additions = addedTokens(current, proposed)
  if (additions === null) {
    return refuse(
      'command_not_additive',
      [...at, 'cmd'],
      `the proposed command for gate "${verb.gate}" removes or rewrites existing tokens; only additions are permitted`,
    )
  }

  const allowed = new Set(gate.tuning.allowed_flags)
  // Named rather than counted: an operator reading this has to be able to add
  // the flag to `allowed_flags` without going and diffing the two commands.
  const disallowed = additions.filter((token) => !allowed.has(token))
  if (disallowed.length > 0) {
    return refuse(
      'flag_not_allowed',
      [...at, 'tuning', 'allowed_flags'],
      `gate "${verb.gate}" does not permit adding ${disallowed.map((token) => `\`${token}\``).join(', ')}`,
    )
  }

  return {
    ok: true,
    workflow: {
      ...workflow,
      gates: { ...workflow.gates, [verb.gate]: { ...gate, cmd: verb.cmd } },
    },
  }
}

function retimeGate(workflow: Workflow, verb: z.infer<typeof RetimeGateSchema>): VerbResult {
  const at = ['gates', verb.gate]
  const gate = workflow.gates[verb.gate]
  if (gate === undefined) {
    return refuse('unknown_gate', at, `no gate "${verb.gate}" is declared by this workflow`)
  }
  if (gate.timeout_s === verb.timeout_s) {
    return refuse('no_effect', [...at, 'timeout_s'], `gate "${verb.gate}" already has this timeout`)
  }
  return {
    ok: true,
    workflow: {
      ...workflow,
      gates: { ...workflow.gates, [verb.gate]: { ...gate, timeout_s: verb.timeout_s } },
    },
  }
}

function rebudgetFixes(workflow: Workflow, verb: z.infer<typeof RebudgetFixesSchema>): VerbResult {
  const index = workflow.nodes.findIndex((node) => node.id === verb.node)
  const node = workflow.nodes[index]
  if (node === undefined) {
    return refuse('unknown_node', ['nodes'], `no phase "${verb.node}" is declared by this workflow`)
  }
  if (node.max_fix_rounds === verb.max_fix_rounds) {
    return refuse(
      'no_effect',
      ['nodes', index, 'max_fix_rounds'],
      `phase "${verb.node}" already has this fix budget`,
    )
  }
  return {
    ok: true,
    workflow: replaceNode(workflow, index, { ...node, max_fix_rounds: verb.max_fix_rounds }),
  }
}

function retierPhase(workflow: Workflow, verb: z.infer<typeof RetierPhaseSchema>): VerbResult {
  const index = workflow.nodes.findIndex((node) => node.id === verb.node)
  const node = workflow.nodes[index]
  if (node === undefined) {
    return refuse('unknown_node', ['nodes'], `no phase "${verb.node}" is declared by this workflow`)
  }

  // The roster, plus `defaults.model`, is the closed set of models this plan
  // was written to spend on. A monitor naming a model from outside it could
  // spend at a rate nobody budgeted, or name one that does not exist and fail
  // every remaining phase at spawn.
  const roster = new Set<string>([
    workflow.defaults.model,
    ...Object.values(workflow.crew).map((member) => member.model),
  ])
  if (!roster.has(verb.model)) {
    return refuse(
      'model_not_on_roster',
      ['crew'],
      `this run is not staffed with the model named for phase "${verb.node}"; its roster is ${[...roster]
        .sort()
        .map((model) => `\`${model}\``)
        .join(', ')}`,
    )
  }

  // A crewed phase runs on its *member's* model — `crew` and `model` are
  // mutually exclusive and the member carries one (`types.ts`). Reading
  // `node.model ?? defaults.model` here would call a phase staffed at tier 1
  // "already on opus" and refuse the one retier that was worth making.
  const current =
    (node.crew === undefined ? undefined : workflow.crew[node.crew]?.model) ??
    node.model ??
    workflow.defaults.model
  if (current === verb.model) {
    return refuse(
      'no_effect',
      ['nodes', index, 'model'],
      `phase "${verb.node}" already runs on this model`,
    )
  }

  // `crew` carries a model of its own and is mutually exclusive with `model`
  // (`types.ts`), so a phase assigned to a member is retiered by moving it off
  // the roster rather than by giving it two sources of truth.
  const { crew: _crew, ...rest } = node
  return { ok: true, workflow: replaceNode(workflow, index, { ...rest, model: verb.model }) }
}

// ---------------------------------------------------------------------------
// The additive-argv rule
// ---------------------------------------------------------------------------

/**
 * A command as argv tokens, or null where this rule has nothing true to say.
 *
 * Deliberately *not* a shell parser, and deliberately not in
 * `platform/platform.ts` beside `shellQuote`. A gate command is run by the
 * platform's own shell and the two disagree about nearly everything, so a
 * general splitter would have to be right about both to be worth having. This
 * has a much smaller job: decide whether one string is another string plus
 * some arguments.
 *
 * It therefore refuses everything it cannot be certain about — any shell
 * metacharacter at all, which means a pipeline, a `&&` chain, a redirect, a
 * substitution or a variable. "Plus new tokens" is not a meaningful claim about
 * `pytest | tee log`, and a gate written that way simply is not retunable. That
 * is the conservative direction, and it is where a rule guarding an unattended
 * edit belongs.
 *
 * What is left is a plain command line with POSIX-style quoting, which is what
 * a tunable gate looks like in practice. Backslash escaping is not handled
 * either: it is rare in a gate command and its meaning differs between the two
 * shells, so it refuses with everything else.
 */
function tokenize(cmd: string): readonly string[] | null {
  if (/[|&;<>(){}`$\\!*?[\]~#]/.test(cmd)) return null

  const tokens: string[] = []
  let token = ''
  let open = false
  let quote = ''

  for (const char of cmd) {
    if (quote !== '') {
      if (char === quote) quote = ''
      else token += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      // A quoted empty string is a token, so presence is tracked rather than
      // inferred from the characters that arrived.
      open = true
      continue
    }
    if (/\s/.test(char)) {
      if (open || token !== '') tokens.push(token)
      token = ''
      open = false
      continue
    }
    token += char
    open = true
  }

  // An unterminated quote is a command this cannot read, not an empty token.
  if (quote !== '') return null
  if (open || token !== '') tokens.push(token)
  return tokens.length === 0 ? null : tokens
}

/**
 * The tokens `proposed` adds to `current`, or null if it does anything else.
 *
 * A subsequence walk: every token of `current` must appear in `proposed`, in
 * the same order, and whatever `proposed` has besides them is the addition.
 * Order matters because argv order matters — a rule that compared multisets
 * would accept a command whose subcommand had moved behind a flag.
 */
function addedTokens(
  current: readonly string[],
  proposed: readonly string[],
): readonly string[] | null {
  const additions: string[] = []
  let cursor = 0
  for (const token of proposed) {
    if (cursor < current.length && current[cursor] === token) {
      cursor += 1
      continue
    }
    additions.push(token)
  }
  // Every original token has to have been consumed: anything left means the
  // proposal dropped or rewrote it.
  return cursor === current.length ? additions : null
}

// ---------------------------------------------------------------------------

function refuse(
  code: InterventionRefusalCode,
  path: readonly (string | number)[],
  message: string,
): InterventionRefusal {
  return { ok: false, code, issues: [{ path: [...path], message }] }
}

function replaceNode(
  workflow: Workflow,
  index: number,
  node: Workflow['nodes'][number],
): Workflow {
  return {
    ...workflow,
    nodes: workflow.nodes.map((existing, i) => (i === index ? node : existing)),
  }
}
