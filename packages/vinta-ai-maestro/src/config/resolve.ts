/**
 * Layering a plan over its project: the authored workflow file on top of
 * `.vinta-ai-workflows.yaml`, resolved into the workflow a run executes.
 *
 * The layers, lowest first — a value set in a higher one wins:
 *
 * 1. **`commands.*`**, the project's own lines, shared with `implement-plan`.
 *    A typed gate's `cmd` and `scoped_cmd` start here.
 * 2. **`maestro.*`**, what maestro does differently or what every plan would
 *    otherwise repeat — per-type gate defaults, pools, chores, run defaults,
 *    the `project` block.
 * 3. **The plan's workflow file.**
 * 4. **The run's own amendments**, which are not this file's: they are made to
 *    a resolved snapshot, and `src/config/reload.ts` keeps them on top when the
 *    layers below move mid-run.
 *
 * ## The merge rules
 *
 * They are the ones the workflow document already follows, applied one level
 * up, so nobody has to learn a second set:
 *
 * - **Maps keyed by id merge per id, and the higher layer's entry wins whole.**
 *   `gates`, `resources`, `chores`, `codegen`, `project.services`, `project.databases`. A
 *   plan redeclaring the `test-suite` pool replaces the project's, rather than
 *   inheriting half of it.
 * - **A typed gate is the one exception, merged field by field.** That is what
 *   `type` is for: `{ "type": "test", "timeout_s": 600 }` keeps the project's
 *   command and changes only how long it may take.
 * - **Lists replace.** `defaults.chores`, `defaults.gates`, a node's `gates`,
 *   `env_files`, `append_only`. Merging a list would leave no way to say "not this one here",
 *   which is the reason `nodes[].chores: []` is an opt-out today.
 * - **Plain objects merge field by field.** `defaults`, `project`,
 *   `project.commands`, `project.compose`.
 *
 * Merged on the raw documents, before either is parsed — the resolved document
 * is then parsed exactly once, by the same `parseWorkflow` everything else
 * uses, so a value is checked against the same rules whichever layer set it.
 */
import { GATE_TYPES, isJudgeGate, type GateType, type Workflow } from '../types.ts'
import { parseWorkflow, type ParseResult, type ValidationIssue } from '../validate.ts'
import { PROJECT_CONFIG_FILE, type ProjectConfig } from './project-config.ts'

type Json = Record<string, unknown>

/**
 * Which `commands.*` line a gate type inherits. `typecheck` reads `build`
 * because that is what the config calls the repo-wide type/build gate.
 */
const COMMAND_SOURCES: Readonly<Record<GateType, { readonly cmd: string; readonly scoped?: string }>> = {
  test: { cmd: 'test_unit', scoped: 'test_unit_scoped' },
  lint: { cmd: 'lint', scoped: 'lint_scoped' },
  typecheck: { cmd: 'build' },
  e2e: { cmd: 'e2e' },
}

/** `commands.*` keys copied into `project.commands`, which agents are handed verbatim. */
const PROJECT_COMMAND_SOURCES: Readonly<Record<string, string>> = {
  lint: 'lint',
  typecheck: 'build',
  test: 'test_unit',
}

/**
 * The resolved document, unparsed. Exported for the editor, which shows the
 * effective values beside the plan's own and must not save the former.
 */
export function resolveDocument(authored: unknown, config: ProjectConfig | null): unknown {
  if (!isObject(authored)) return authored
  const commands = isObject(config?.commands) ? config.commands : {}
  const maestro = isObject(config?.maestro) ? (config.maestro as Json) : {}

  const doc: Json = { ...authored }

  const defaultBranch = isObject(config?.project) ? config.project.default_branch : undefined
  if (doc.base_branch === undefined && typeof defaultBranch === 'string') {
    doc.base_branch = defaultBranch
  }

  const defaults = mergeFields(maestro.defaults, authored.defaults)
  if (defaults !== undefined) doc.defaults = defaults

  const resources = mergeById(maestro.resources, authored.resources)
  if (resources !== undefined) doc.resources = resources

  const chores = mergeById(maestro.chores, authored.chores)
  if (chores !== undefined) doc.chores = chores

  const codegen = mergeById(maestro.codegen, authored.codegen)
  if (codegen !== undefined) doc.codegen = codegen

  if (authored.append_only === undefined && Array.isArray(maestro.append_only)) {
    doc.append_only = [...maestro.append_only]
  }

  const gates = resolveGates(gateTypeDefaults(commands, maestro.gates), authored.gates)
  if (gates !== undefined) doc.gates = gates

  const defaultGates = isObject(defaults) && Array.isArray(defaults.gates) ? defaults.gates : undefined
  if (defaultGates !== undefined && Array.isArray(doc.nodes)) {
    doc.nodes = doc.nodes.map((node) =>
      isObject(node) && node.gates === undefined ? { ...node, gates: [...defaultGates] } : node,
    )
  }

  const project = resolveProject(maestro.project, authored.project, commands)
  if (project !== undefined) doc.project = project

  return doc
}

/**
 * Resolves and parses. The one entry point the load paths use, so a plan is
 * never validated without its project under it — a typed gate with no command
 * is only an error once nothing below it supplies one.
 */
export function resolveWorkflow(authored: unknown, config: ProjectConfig | null): ParseResult {
  const resolved = resolveDocument(authored, config)
  const missing = commandlessGates(authored, resolved)
  if (missing.length > 0) return { ok: false, issues: missing }
  return parseWorkflow(resolved)
}

export type { Workflow }

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/** What each gate type inherits, from both project layers. Types with nothing are absent. */
function gateTypeDefaults(commands: Json, configured: unknown): Map<GateType, Json> {
  const byType = new Map<GateType, Json>()
  const fromConfig = isObject(configured) ? configured : {}
  for (const type of GATE_TYPES) {
    const source = COMMAND_SOURCES[type]
    const inherited: Json = {}
    if (typeof commands[source.cmd] === 'string') inherited.cmd = commands[source.cmd]
    // A scoped line with no placeholder is the skill-era shape — `pnpm
    // test:patient`, one package picked by the agent reading it. Run by the
    // daemon, which cannot read it, it would gate every phase on that one
    // package. Only a line that says *how* it is scoped is inherited.
    const scoped = source.scoped === undefined ? undefined : commands[source.scoped]
    if (typeof scoped === 'string' && hasScopePlaceholder(scoped)) inherited.scoped_cmd = scoped
    const merged = { ...inherited, ...(isObject(fromConfig[type]) ? fromConfig[type] : {}) }
    if (Object.keys(merged).length > 0) byType.set(type, merged)
  }
  return byType
}

/**
 * The gate table. Every type the project can run is available under the
 * type's own name, which is what lets a plan list `"gates": ["typecheck",
 * "test"]` on its nodes and declare no table at all; a plan entry of the same
 * id replaces it, and a typed plan entry under any id inherits from it.
 */
function resolveGates(byType: Map<GateType, Json>, authored: unknown): Json | undefined {
  const declared = isObject(authored) ? authored : {}
  if (byType.size === 0 && !isObject(authored)) return undefined

  const gates: Json = {}
  for (const [type, inherited] of byType) {
    if (typeof inherited.cmd === 'string') gates[type] = { type, ...inherited }
  }
  for (const [id, gate] of Object.entries(declared)) {
    const type = isObject(gate) && !('judge' in gate) ? gate.type : undefined
    const inherited = typeof type === 'string' ? byType.get(type as GateType) : undefined
    gates[id] = inherited === undefined || !isObject(gate) ? gate : { ...inherited, ...gate }
  }
  return gates
}

/**
 * Typed gates nothing gave a command to, located on the plan's entry. Checked
 * before the parse because the parse would report them as a union that matched
 * neither branch, which is true and tells nobody what to do.
 */
function commandlessGates(authored: unknown, resolved: unknown): ValidationIssue[] {
  if (!isObject(resolved) || !isObject(resolved.gates)) return []
  const declared = isObject(authored) && isObject(authored.gates) ? authored.gates : {}
  const issues: ValidationIssue[] = []
  for (const [id, gate] of Object.entries(resolved.gates)) {
    if (!isObject(gate) || 'judge' in gate || gate.cmd !== undefined) continue
    const type = typeof gate.type === 'string' ? (gate.type as GateType) : undefined
    const source = type === undefined ? undefined : COMMAND_SOURCES[type]
    issues.push({
      path: ['gates', id, 'cmd'],
      message:
        source === undefined || !(id in declared)
          ? `gate "${id}" has no \`cmd\``
          : `gate "${id}" is typed "${type}" but nothing gives it a command — set \`cmd\` here, ` +
            `\`maestro.gates.${type}.cmd\` or \`commands.${source.cmd}\` in ${PROJECT_CONFIG_FILE}`,
    })
  }
  return issues
}

export function hasScopePlaceholder(command: string): boolean {
  return command.includes('{changed_files}') || command.includes('{touches}')
}

// ---------------------------------------------------------------------------
// Gates that will never narrow
// ---------------------------------------------------------------------------

/** The gate types a phase is expected to narrow: the ones with a `*_scoped` line. */
type ScopableType = 'test' | 'lint'

/**
 * A gate that runs its full command on every phase although the run asked for
 * scoped phase gates.
 *
 * `typed` says whether the gate inherits from the project at all: an untyped
 * gate the plan named `test` replaces the project's whole, so no
 * `commands.test_unit_scoped` would reach it however it were written.
 */
export interface UnscopedGate {
  readonly gateId: string
  readonly type: ScopableType
  readonly typed: boolean
  readonly reason:
    | {
        /** `commands.<key>` is set, and was passed over for having no placeholder. */
        readonly kind: 'placeholderless'
        readonly key: string
      }
    | { readonly kind: 'none' }
}

/**
 * The `test` and `lint` gates a phase uses that will run their full `cmd` on
 * every phase, every fix round, under `defaults.gate_scope: scoped`.
 *
 * Nothing at run time says this: `phaseGate` falls back to `cmd` when a gate
 * has no `scoped_cmd`, which is correct, and silent. One observed run spent two
 * hours running a 6,528-test suite — six to nine minutes each time — on every
 * phase gate and every fix round, because its `commands.test_unit_scoped` was
 * the skill-era `pytest <app>/tests/`: a line for an agent to fill in, which
 * `gateTypeDefaults` rightly refuses to inherit and then told nobody about.
 * This is the finding that run needed at minute zero; `doctor` reports it, and
 * through the preflight so does the start of a run.
 *
 * A gate is a `test` or `lint` gate by its `type`, or — untyped — by its id,
 * because a plan that declares `gates.test.cmd` and nothing else has still
 * named its suite. `typecheck` and `e2e` are left out: neither has a scoped
 * line to forget, and a type check narrowed to the changed files is not one.
 *
 * Only gates some phase runs, through its own `gates` or `defaults.gates`: a
 * gate the table carries and nothing uses costs nothing. `config` is the
 * project's file, `null` when there is none or it is not to hand — then every
 * finding is `none`, which is still true of the gate.
 */
export function unscopedGates(workflow: Workflow, config: ProjectConfig | null): UnscopedGate[] {
  if (workflow.defaults.gate_scope !== 'scoped') return []
  const commands = isObject(config?.commands) ? config.commands : {}
  const used = new Set([...(workflow.defaults.gates ?? []), ...workflow.nodes.flatMap((node) => node.gates)])
  const found: UnscopedGate[] = []
  for (const [gateId, gate] of Object.entries(workflow.gates)) {
    if (!used.has(gateId) || isJudgeGate(gate) || gate.scoped_cmd !== undefined) continue
    const type = gate.type ?? gateId
    if (type !== 'test' && type !== 'lint') continue
    const key = COMMAND_SOURCES[type].scoped
    const line = key === undefined ? undefined : commands[key]
    // A line *with* a placeholder that still did not arrive was overridden or
    // never offered (an untyped gate inherits nothing): saying it was ignored
    // for the placeholder would send the reader to fix the wrong thing.
    found.push({
      gateId,
      type,
      typed: gate.type !== undefined,
      reason:
        key !== undefined && typeof line === 'string' && !hasScopePlaceholder(line)
          ? { kind: 'placeholderless', key }
          : { kind: 'none' },
    })
  }
  return found
}

/**
 * The finding as one line and its remedy, shared by `doctor` and the run's
 * startup warnings so the two never say it differently.
 *
 * The configured line itself is not quoted: a command line is repository
 * content (§13.4), and a check line carries identifiers only (§11). The key is
 * enough to find it.
 */
export function describeUnscopedGate(finding: UnscopedGate): { readonly label: string; readonly remedy: string } {
  const why =
    finding.reason.kind === 'placeholderless'
      ? `commands.${finding.reason.key} in ${PROJECT_CONFIG_FILE} has no {changed_files} or {touches} ` +
        'placeholder, so it is not inherited — a scoped line must say how it is scoped'
      : 'it has no scoped_cmd, and nothing configures one'
  const scopedKey = COMMAND_SOURCES[finding.type].scoped ?? ''
  const example =
    finding.type === 'test'
      ? 'pytest --testmon {changed_files}, vitest related {changed_files} --run'
      : 'ruff check {changed_files}, eslint {changed_files}'
  const where = finding.typed
    ? `commands.${scopedKey} (or maestro.gates.${finding.type}.scoped_cmd) in ${PROJECT_CONFIG_FILE}, ` +
      `or gates.${finding.gateId}.scoped_cmd in the plan,`
    : `gates.${finding.gateId}.scoped_cmd in the plan (or give it type: ${finding.type} so it inherits ` +
      `commands.${scopedKey})`
  return {
    label:
      `gate ${finding.gateId}: runs its full command on every phase and every fix round, ` +
      `although gate_scope is scoped — ${why}`,
    remedy:
      `set ${where} to a line with {changed_files} or {touches} — e.g. ${example} — ` +
      'or set maestro.defaults.gate_scope: full to accept a full run per phase',
  }
}

// ---------------------------------------------------------------------------
// The project block
// ---------------------------------------------------------------------------

/**
 * `project`, when either layer declares one. Neither declaring one is a
 * project whose lanes are worktrees and nothing else, and inventing a block
 * out of `commands.*` alone would also invent a `migrate_cmd` it has not got.
 */
function resolveProject(configured: unknown, authored: unknown, commands: Json): Json | undefined {
  if (!isObject(configured) && !isObject(authored)) return undefined
  const lower = isObject(configured) ? configured : {}
  const upper = isObject(authored) ? authored : {}

  const project: Json = { ...lower, ...upper }

  const inherited: Json = {}
  for (const [key, source] of Object.entries(PROJECT_COMMAND_SOURCES)) {
    if (typeof commands[source] === 'string') inherited[key] = commands[source]
  }
  const projectCommands = mergeFields(inherited, mergeFields(lower.commands, upper.commands))
  if (projectCommands !== undefined && Object.keys(projectCommands).length > 0) {
    project.commands = projectCommands
  }

  const databases = mergeById(lower.databases, upper.databases)
  if (databases !== undefined) project.databases = databases
  const services = mergeById(lower.services, upper.services)
  if (services !== undefined) project.services = services
  const compose = mergeFields(lower.compose, upper.compose)
  if (compose !== undefined) project.compose = compose

  return project
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/** Field by field, upper wins. Undefined when neither side is an object. */
function mergeFields(lower: unknown, upper: unknown): Json | undefined {
  if (!isObject(lower)) return isObject(upper) ? upper : (upper as Json | undefined)
  if (upper === undefined) return { ...lower }
  if (!isObject(upper)) return upper as Json
  return { ...lower, ...upper }
}

/**
 * Per id, upper's entry wins whole. A non-object upper is returned untouched
 * so the parse reports it where the plan wrote it, rather than this hiding it
 * under the project's map.
 */
function mergeById(lower: unknown, upper: unknown): Json | undefined {
  return mergeFields(lower, upper)
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
