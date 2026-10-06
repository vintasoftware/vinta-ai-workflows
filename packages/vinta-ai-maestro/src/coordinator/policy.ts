/**
 * What the run coordinator may change about a live run, checked where its
 * amendment lands (`POST /api/runs/:id/amend` with the coordinator's token).
 *
 * The coordinator is an agent with a shell and nobody watching, so its brief
 * is not where its limits live. Two lines, and everything else is its to
 * change:
 *
 * - **What the plan builds is the operator's.** The set of phases, their
 *   dependencies, briefs, touch lists, base branch, pipeline, a deferred
 *   phase's condition, the plan documents. A coordinator that concludes the
 *   plan is wrong says so in the conversation; it does not rewrite it.
 * - **A check may only get stricter.** No gate dropped from a phase or from
 *   the defaults, no chore dropped, no gate definition removed, no judge gate
 *   or chore definition edited, no review pipeline touched, `hooks`,
 *   `allow_ungated_phases`, `gate_scope` and `wave_gates` never loosened. A
 *   gate's command is the one subtle case: `--reuse-db` and `-k "not slow"` are
 *   the same edit to the same string, so a command may only gain tokens, in
 *   order, and only tokens its gate lists in `tuning.allowed_flags` — a list a
 *   person wrote in a committed file. A gate with no `tuning` block is not
 *   tunable, which is the default.
 *
 * What is left is *how* the run executes: models, harnesses and the crew, fix
 * budgets, gate timeouts and the pools they hold, resources, the `project`
 * block's environment (`env_files`, compose, databases, setup commands),
 * model fallbacks. Those can make a run slower or dearer when set wrongly;
 * none of them can make a failing check pass.
 */
import { diffWorkflows } from '../amend/diff.ts'
import type { AmendmentKind } from '../journal/events.ts'
import { isJudgeGate, type Gate, type Workflow } from '../types.ts'

export interface PolicyIssue {
  readonly path: readonly (string | number)[]
  readonly message: string
}

/** Amendment kinds that change what the plan builds. */
const WHAT_KINDS: ReadonlySet<AmendmentKind> = new Set<AmendmentKind>([
  'node_added',
  'node_removed',
  'dependency_added',
  'dependency_removed',
  'dependency_reordered',
  'base_branch_changed',
  'pipeline_changed',
])

const WAVE_GATES_ORDER = ['off', 'final', 'every'] as const

/** Every reason the coordinator may not make this amendment. Empty means it may. */
export function coordinatorRefusals(before: Workflow, after: Workflow): readonly PolicyIssue[] {
  const issues: PolicyIssue[] = []
  const refuse = (path: readonly (string | number)[], message: string): void => {
    issues.push({ path, message })
  }

  for (const change of diffWorkflows(before, after).changes) {
    if (WHAT_KINDS.has(change.kind)) {
      refuse(['nodes', change.node], `${change.kind.replaceAll('_', ' ')} on ${change.node} changes what the plan builds`)
    }
  }

  for (const field of ['base_branch', 'plan_ref', 'plan_context_refs', 'pipelines', 'chores'] as const) {
    if (!same(before[field], after[field])) refuse([field], `\`${field}\` is the plan's, not the coordinator's`)
  }

  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]))
  for (const node of before.nodes) {
    const next = afterNodes.get(node.id)
    if (next === undefined) continue
    for (const field of ['name', 'prompt_ref', 'touches', 'deferred'] as const) {
      if (!same(node[field], next[field])) {
        refuse(['nodes', node.id, field], `${node.id}'s \`${field}\` is the plan's, not the coordinator's`)
      }
    }
    for (const gate of dropped(node.gates, next.gates)) {
      refuse(['nodes', node.id, 'gates'], `${node.id} may not lose gate "${gate}"`)
    }
    for (const chore of dropped(node.chores ?? [], next.chores ?? [])) {
      refuse(['nodes', node.id, 'chores'], `${node.id} may not lose chore "${chore}"`)
    }
  }

  for (const gate of dropped(before.defaults.gates ?? [], after.defaults.gates ?? [])) {
    refuse(['defaults', 'gates'], `the defaults may not lose gate "${gate}"`)
  }
  for (const chore of dropped(before.defaults.chores, after.defaults.chores)) {
    refuse(['defaults', 'chores'], `the defaults may not lose chore "${chore}"`)
  }
  if (!before.defaults.allow_ungated_phases && after.defaults.allow_ungated_phases) {
    refuse(['defaults', 'allow_ungated_phases'], 'ungated phases may not be allowed')
  }
  if (before.defaults.gate_scope === 'full' && after.defaults.gate_scope !== 'full') {
    refuse(['defaults', 'gate_scope'], 'phase gates may not be narrowed')
  }
  if (WAVE_GATES_ORDER.indexOf(after.defaults.wave_gates) < WAVE_GATES_ORDER.indexOf(before.defaults.wave_gates)) {
    refuse(['defaults', 'wave_gates'], 'the merged tree may not be checked less often')
  }
  if (!same(before.project?.hooks, after.project?.hooks)) {
    refuse(['project', 'hooks'], 'git hooks are the operator’s to change')
  }

  for (const [id, gate] of Object.entries(before.gates)) {
    const next = after.gates[id]
    if (next === undefined) {
      refuse(['gates', id], `gate "${id}" may not be removed`)
      continue
    }
    issues.push(...gateRefusals(id, gate, next))
  }

  return issues
}

function gateRefusals(id: string, before: Gate, after: Gate): readonly PolicyIssue[] {
  const at = ['gates', id]
  if (isJudgeGate(before) || isJudgeGate(after)) {
    return same(before, after) ? [] : [{ path: at, message: `judge gate "${id}" may not be changed` }]
  }
  const issues: PolicyIssue[] = []
  if (!same(before.tuning, after.tuning)) {
    issues.push({ path: [...at, 'tuning'], message: `gate "${id}"'s \`tuning\` is its permit, and the operator's` })
  }
  if (!same(before.type, after.type)) {
    issues.push({ path: [...at, 'type'], message: `gate "${id}"'s \`type\` may not be changed` })
  }
  const allowed = new Set(before.tuning?.allowed_flags ?? [])
  for (const field of ['cmd', 'scoped_cmd'] as const) {
    const was = before[field]
    const now = after[field]
    if (was === now) continue
    if (was === undefined || now === undefined) {
      issues.push({ path: [...at, field], message: `gate "${id}"'s \`${field}\` may not be added or removed` })
      continue
    }
    const refusal = commandRefusal(id, was, now, allowed)
    if (refusal !== null) issues.push({ path: [...at, field], message: refusal })
  }
  return issues
}

/** Why `proposed` is not `current` plus permitted flags, or null when it is. */
function commandRefusal(
  gate: string,
  current: string,
  proposed: string,
  allowed: ReadonlySet<string>,
): string | null {
  if (allowed.size === 0) {
    return `gate "${gate}" declares no \`tuning.allowed_flags\`, so its command is not the coordinator's to change`
  }
  const was = tokenize(current)
  const now = tokenize(proposed)
  if (was === null || now === null) {
    return `gate "${gate}"'s command cannot be split into argv tokens, so an addition cannot be told from a rewrite`
  }
  const additions = addedTokens(was, now)
  if (additions === null) return `gate "${gate}"'s command may only gain tokens, not lose or rewrite them`
  const disallowed = additions.filter((token) => !allowed.has(token))
  return disallowed.length === 0
    ? null
    : `gate "${gate}" does not permit adding ${disallowed.map((token) => `\`${token}\``).join(', ')}`
}

/** What `before` has that `after` does not. */
function dropped(before: readonly string[], after: readonly string[]): readonly string[] {
  const kept = new Set(after)
  return before.filter((entry) => !kept.has(entry))
}

/** Structural equality, independent of key order. */
function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b)
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : inner,
  ) ?? 'undefined'
}

// ---------------------------------------------------------------------------
// The additive-argv rule
// ---------------------------------------------------------------------------

/**
 * A command as argv tokens, or null where this rule has nothing true to say.
 *
 * Deliberately *not* a shell parser. A gate command is run by the platform's
 * own shell, and the two disagree about nearly everything, so this has a much
 * smaller job: decide whether one string is another string plus some
 * arguments. It refuses everything it cannot be certain about — any shell
 * metacharacter at all, so a pipeline, a `&&` chain, a redirect, a
 * substitution or a variable. "Plus new tokens" is not a meaningful claim
 * about `pytest | tee log`, and a gate written that way is not tunable. That
 * is the conservative direction, where a rule guarding an unattended edit
 * belongs. Backslash escaping is refused with everything else.
 */
export function tokenize(cmd: string): readonly string[] | null {
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
export function addedTokens(
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
  return cursor === current.length ? additions : null
}
