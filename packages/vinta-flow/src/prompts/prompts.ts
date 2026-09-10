/**
 * Prompt composition: what each agent role is actually told, in one place.
 *
 * `spawn_agent` declares a `prompt_template` (§5.2) and, until this module
 * existed, nothing consumed it: every role was handed `node.prompt_ref` as its
 * entire prompt. An implementer copes with that — it is standing in the
 * repository and the reference names a file — but a reviewer handed the same
 * bare string is never told it is reviewing, never states the `VERDICT:` line
 * the executor reads back, and takes the fail-closed default. The node then
 * burns its fix rounds on a review that was never asked for.
 *
 * So `prompt_template` is the seam. It selects one of the renderers below and
 * parameterises it with the materials the scheduler already holds: the phase
 * brief resolved from `prompt_ref`, the node's branch and base as the journal
 * recorded them, the dependency closure, and the facts of the turn that failed.
 *
 * Three rules shape everything here.
 *
 * **Context is the dependency closure, never "everything finished so far".**
 * A sibling lane's work is not in this phase's base branch. Describing it as
 * implemented makes the implementer code against files its worktree does not
 * contain, which is correct sequentially and wrong the moment two phases run at
 * once. `dependencyClosure` is therefore an *ancestor* walk, and a sibling can
 * never appear in it.
 *
 * **Plan-level context is carried, never summarised, and never unlabelled.**
 * `plan_context_refs` names the plan sections that bound every phase — Goals +
 * Non-goals, Guiding Decisions. An implementer who has not read the non-goals
 * scope-creeps and one who has not read the decisions re-litigates them, so
 * both they and the reviewer get those sections whole. They are also the two
 * roles that can act on them: the reviewer measures scope creep against the
 * non-goals, while the fixer is told to change exactly what a finding names and
 * nothing else, and handing it the plan's goals would only widen that.
 *
 * **The reviewer's protocol and the executor's parser are one definition.**
 * `readVerdict` is exported from here and imported by `executor.ts`, and the
 * reviewer prompt asks for `VERDICT_MARKER`. A prompt that asked for a form the
 * parser does not accept would fail every node silently, so the two cannot be
 * allowed to drift apart.
 *
 * **A prompt carries repository content; nothing else here may.** The brief,
 * the dependency summaries and the review findings are the *point* of a prompt
 * and are handed to the agent. They never reach a log line, an error message, a
 * journal payload or a process argument — every `PromptError` below names the
 * node id and the `prompt_ref` and stops there.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { computeWaves } from '../graph.ts'
import type { Journal } from '../journal/journal.ts'
import type { GuardContext } from '../pipeline/guard.ts'
import { AGENT_ROLES, type AgentRole, type Node, type Workflow } from '../types.ts'

/** The line the reviewer is asked to end on, and the one `executor.ts` reads. */
export const VERDICT_MARKER = 'VERDICT:'

/** Matched against the reviewer's own last words, never stored. */
const VERDICT_PATTERN = /verdict\s*[:=]\s*(pass|fail)/i

/**
 * The verdict a turn stated, or `undefined` when it stated none. The one
 * definition of the protocol: the reviewer prompt asks for what this accepts.
 */
export function readVerdict(text: string): 'pass' | 'fail' | undefined {
  const match = VERDICT_PATTERN.exec(text)
  const stated = match?.[1]
  if (stated === undefined) return undefined
  return stated.toLowerCase() === 'pass' ? 'pass' : 'fail'
}

/**
 * A prompt that could not be composed. Identifiers only — the node id, the
 * reference, and what about the reference did not resolve.
 */
export class PromptError extends Error {}

/** How much of an agent's final report is carried into the next prompt. */
const SUMMARY_LIMIT = 4_000

/** How far back in a transcript a final report is looked for. */
const TRANSCRIPT_WINDOW = 50

/** What the journal is asked for. Narrow, so a test double is two methods. */
export type PromptJournal = Pick<Journal, 'tailTranscript' | 'nodes'>

/** One member of a phase's dependency closure, as the implementer is told it. */
export interface DependencyContext {
  readonly id: string
  readonly name: string
  /** The `depends_on` artifact, where this is a direct dependency. */
  readonly artifact: string | null
  /** The dependency's own final report, recovered from its transcript. */
  readonly summary: string | null
}

/** Everything a conflict-fixer prompt says. Identifiers and plan references. */
export interface ConflictContext {
  readonly into: string
  readonly incoming: string
  readonly nodes: readonly string[]
  readonly paths: readonly string[]
  readonly promptRefs: readonly string[]
}

export interface SpawnPromptRequest {
  /** `spawn_agent`'s `prompt_template` param, exactly as the pipeline wrote it. */
  readonly template: unknown
  readonly workflow: Workflow
  readonly node: Node
  readonly runId: string
  readonly journal: PromptJournal
  /**
   * The lane checkout the agent will run in, or `null` when the lane has no
   * worktree on disk. A projection (`simulate.ts`) drives the real scheduler
   * over lanes that were never provisioned: nothing spawns, no repository
   * exists, and its report promises identifiers only — so there is no brief to
   * resolve and the reference is passed through. A real run never takes that
   * branch, because a lane is provisioned before a node is dispatched into it.
   */
  readonly workspace: string | null
  /** The guard context of this invocation: the gate that failed, the verdict. */
  readonly facts: GuardContext
}

/**
 * The prompt one `spawn_agent` hands its agent.
 *
 * A pipeline that declares no `prompt_template` is opting out: it gets the
 * reference, which is what `AgentTask.prompt` carried before this module. A
 * template that names no known role is an authoring mistake and fails loudly.
 */
export function composeSpawnPrompt(request: SpawnPromptRequest): string {
  const { template, node } = request
  if (template === undefined) return node.prompt_ref

  const role = knownTemplate(template, node.id)
  if (role === 'conflict-fixer') {
    // A conflict is not a phase: it has no brief, no lane and no diff of its
    // own, and the integrator spawns its fixer directly (`integration/fixer.ts`).
    throw new PromptError(
      `node "${node.id}": prompt_template "conflict-fixer" is the integrator's, not a pipeline's`,
    )
  }
  if (request.workspace === null) return node.prompt_ref

  const materials = gather(request, request.workspace)
  if (role === 'implementer') return renderImplementer(materials)
  if (role === 'reviewer') return renderReviewer(materials)
  return renderFixer(materials)
}

/** The conflict fixer's prompt. Shared with `integration/fixer.ts`, not forked. */
export function composeConflictPrompt(context: ConflictContext): string {
  return [
    `Resolve the merge conflict from merging ${context.incoming} into ${context.into}.`,
    `Conflicted paths: ${context.paths.join(' ')}`,
    `Nodes involved: ${context.nodes.join(' ')}`,
    `Phase briefs: ${context.promptRefs.join(' ')}`,
    'Resolve for both phases’ intents. Never resolve with --ours or --theirs.',
  ].join('\n')
}

function knownTemplate(template: unknown, nodeId: string): AgentRole {
  const known = (AGENT_ROLES as readonly string[]).find((role) => role === template)
  if (known === undefined) {
    // The template id is authored data, safe to name; the brief is not.
    throw new PromptError(
      `node "${nodeId}": unknown prompt_template "${String(template)}" ` +
        `(known: ${AGENT_ROLES.join(', ')})`,
    )
  }
  return known as AgentRole
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

interface Materials {
  readonly workflow: Workflow
  readonly node: Node
  readonly workspace: string
  readonly branch: string
  readonly baseBranch: string
  readonly brief: string
  /**
   * The plan's own bounding sections — Goals + Non-goals, Guiding Decisions —
   * resolved verbatim from `workflow.plan_context_refs`. Empty where the
   * workflow names none, and then nothing about the prompt changes.
   */
  readonly planContext: readonly string[]
  readonly dependencies: readonly DependencyContext[]
  /** The reviewer's findings, when this node's last turn was a review. */
  readonly findings: string | null
  readonly facts: GuardContext
}

function gather(request: SpawnPromptRequest, workspace: string): Materials {
  const { workflow, node, runId, journal } = request
  const row = journal.nodes(runId).find((candidate) => candidate.node_id === node.id)

  return {
    workflow,
    node,
    workspace,
    // `git_branch` runs before the first spawn and journals both, so the
    // fallbacks only ever cover a pipeline that spawns before it branches.
    branch: row?.branch ?? 'HEAD',
    baseBranch: row?.base_branch ?? workflow.base_branch,
    brief: resolveBrief(workspace, node.id, node.prompt_ref),
    planContext: workflow.plan_context_refs.map((ref) =>
      resolveBrief(workspace, node.id, ref, 'plan_context_refs'),
    ),
    dependencies: dependencyClosure(workflow.nodes, node.id).map((id) => ({
      id,
      name: workflow.nodes.find((candidate) => candidate.id === id)?.name ?? id,
      artifact: node.depends_on.find((dep) => dep.node === id)?.artifact ?? null,
      summary: lastReport(journal, runId, id),
    })),
    findings: lastReport(journal, runId, node.id),
    facts: request.facts,
  }
}

/**
 * The phase's **transitive dependencies**, in wave order then declaration
 * order. Never a sibling: an ancestor walk cannot reach one, which is the whole
 * point — a sibling's work is not in this phase's base branch.
 */
export function dependencyClosure(nodes: readonly Node[], id: string): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const closure = new Set<string>()
  const queue = [...(byId.get(id)?.depends_on ?? [])].map((dep) => dep.node)

  while (queue.length > 0) {
    const next = queue.shift() as string
    if (closure.has(next) || !byId.has(next)) continue
    closure.add(next)
    for (const dep of byId.get(next)?.depends_on ?? []) queue.push(dep.node)
  }

  const waves = computeWaves(nodes)
  const order = nodes.map((node) => node.id)
  return [...closure].sort(
    (a, b) =>
      (waves.get(a) ?? 0) - (waves.get(b) ?? 0) || order.indexOf(a) - order.indexOf(b),
  )
}

/**
 * What a file-and-anchor reference points at: a repo-relative file, optionally
 * with a `#anchor` naming one heading's section. `prompt_ref` names the phase
 * brief this way and `plan_context_refs` names the plan's bounding sections the
 * same way, so one resolver serves both — `field` only decides which of them a
 * failure is reported against.
 *
 * Read out of the lane worktree, which is a checkout of the repository the plan
 * lives in. A reference that resolves to nothing throws rather than letting the
 * bare reference reach an agent as its whole prompt. The error names the node
 * and the reference; the document's own text never appears in it.
 */
export function resolveBrief(
  workspace: string,
  nodeId: string,
  promptRef: string,
  field = 'prompt_ref',
): string {
  const hash = promptRef.lastIndexOf('#')
  const path = hash === -1 ? promptRef : promptRef.slice(0, hash)
  const anchor = hash === -1 ? '' : promptRef.slice(hash + 1)

  let text: string
  try {
    text = readFileSync(join(workspace, path), 'utf8')
  } catch {
    throw new PromptError(`node "${nodeId}": ${field} "${promptRef}" names no readable file`)
  }

  const brief = anchor === '' ? text.trim() : (sectionOf(text, anchor) ?? '')
  if (brief === '') {
    throw new PromptError(`node "${nodeId}": ${field} "${promptRef}" resolved to nothing`)
  }
  return brief
}

/** One heading's section: from its line to the next heading of the same depth or shallower. */
function sectionOf(text: string, anchor: string): string | null {
  const lines = text.split('\n')
  const target = slug(anchor)
  let start = -1
  let depth = 0

  for (let i = 0; i < lines.length; i += 1) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(lines[i] as string)
    if (heading === null) continue
    const title = heading[2] as string
    const found = slug(title)
    // Slug equality, the `phase-1` prefix of a `## Phase 1: Data model`, or an
    // explicit `{#anchor}` the author wrote.
    if (found === target || found.startsWith(`${target}-`) || title.includes(`{#${anchor}}`)) {
      start = i
      depth = (heading[1] as string).length
      break
    }
  }
  if (start === -1) return null

  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    const heading = /^(#{1,6})\s+/.exec(lines[i] as string)
    if (heading !== null && (heading[1] as string).length <= depth) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n').trim()
}

function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

/**
 * The last thing an agent said in a node's transcript — its final report.
 *
 * This is how a dependency's summary is recovered without reading its lane: the
 * transcript is durable, it is already the one place §5.3 puts agent output,
 * and a dependency's lane has usually been recycled by the time a dependent
 * runs.
 */
function lastReport(journal: PromptJournal, runId: string, nodeId: string): string | null {
  const entries = journal.tailTranscript(runId, nodeId, TRANSCRIPT_WINDOW)
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as { type?: string; text?: string } | null
    if (entry === null || typeof entry !== 'object') continue
    if (entry.type === 'assistant_text' && typeof entry.text === 'string' && entry.text !== '') {
      return entry.text.slice(0, SUMMARY_LIMIT)
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function renderImplementer(materials: Materials): string {
  const { node, workflow } = materials
  return section([
    `You are implementing ${node.id}: ${node.name} of plan ${workflow.id}.`,
    '',
    '## Working location',
    `Work entirely inside \`${materials.workspace}\`. cd into it before any command:`,
    'every git, lint, test and build call runs there. Other phases of this plan may',
    'be running right now in sibling worktrees next to yours — never read or write',
    'any path outside your own. Anything you need from another phase is either',
    'already in your base branch or is a dependency the plan failed to declare; say',
    'so in your report rather than reaching for it.',
    `Your branch is \`${materials.branch}\`, cut from \`${materials.baseBranch}\` — derived from`,
    "this phase's dependencies, not from plan order. Commit straight to it.",
    ...planLevel(materials, [
      'These are the whole plan’s Goals, Non-goals and Guiding Decisions, verbatim,',
      'and they bound your phase rather than describe it. A non-goal is out of scope',
      'for the plan and therefore for you — do not build it, and do not treat it as a',
      'task. A decision here is already settled; implement it rather than re-opening',
      'it, and say so in your report if it cannot hold. What you were asked to build',
      'is the phase brief further down, and only that.',
    ]),
    '',
    '## What your phase builds on',
    ...buildsOn(materials),
    '',
    `## Your tasks (${node.id} only)`,
    materials.brief,
    '',
    '## Working instructions',
    '1. Read the code paths your changes touch before you write anything.',
    '2. Implement, matching the patterns already in the repository.',
    '3. Inner loop, scoped to what you touched: lint clean, then each new test on',
    '   its own, then the scoped suite. Do not go on while any of them is red.',
    '4. Outer gate, only once the inner loop is green. These run against your lane',
    '   and must all pass before you commit:',
    ...gateList(materials),
    '5. A red outer gate sends you back to step 2. Never commit while one is red.',
    '',
    '## Required output (a single final report)',
    '- Status: SUCCESS or FAILURE, and why.',
    '- Files created or modified, paths only.',
    '- A 5–15 line summary of what you implemented and the decisions you took.',
    '- Deviations from the phase body above, and your reasoning.',
    "- Anything you could not do, with an explanation.",
  ])
}

/**
 * The plan's Goals + Non-goals and Guiding Decisions, verbatim, under a heading
 * that says whose they are.
 *
 * Verbatim because a summary of a non-goal is a paraphrase of a boundary, and a
 * paraphrased boundary is one an agent argues with. Marked plan-level because
 * the failure mode of pasting them next to a phase brief is an implementer that
 * reads "we are not building X" as "build X", or a reviewer that fails a phase
 * for not delivering the whole plan — so `framing` says, per role, what these
 * sections are for and what they are not.
 *
 * A workflow naming no `plan_context_refs` gets no lines at all from here, which
 * is what makes the field's absence compose exactly as before.
 */
function planLevel(materials: Materials, framing: readonly string[]): string[] {
  if (materials.planContext.length === 0) return []
  return [
    '',
    '## Plan-level decisions — the whole plan’s, not this phase’s',
    ...framing,
    '',
    ...materials.planContext.flatMap((entry) => [entry, '']),
  ]
}

/** The dependency closure, in wave order — and an explicit note about siblings. */
function buildsOn(materials: Materials): string[] {
  if (materials.dependencies.length === 0) {
    return [`Nothing yet — this phase starts from \`${materials.baseBranch}\`.`]
  }

  const lines: string[] = []
  for (const dependency of materials.dependencies) {
    lines.push(
      `### ${dependency.id}: ${dependency.name}` +
        (dependency.artifact === null ? '' : ` — you need ${dependency.artifact} from it`),
    )
    lines.push(dependency.summary ?? 'No report recorded; read its code on your base branch.')
    lines.push('')
  }
  lines.push(
    'Phases running beside yours are deliberately not listed: their work is not in',
    'your base branch, and coding against it would target files your worktree does',
    'not contain.',
  )
  return lines
}

/** The node's gates: the outer gate the phase has to survive, as commands. */
function gateList(materials: Materials): string[] {
  const gates = materials.node.gates.flatMap((id) => {
    const gate = materials.workflow.gates[id]
    return gate === undefined ? [] : [`   - ${id}: \`${gate.cmd}\``]
  })
  return gates.length === 0
    ? ['   - the repository’s own type/build check and its test suite.']
    : gates
}

function renderReviewer(materials: Materials): string {
  const { node, workflow } = materials
  return section([
    `You are reviewing ${node.id}: ${node.name} of plan ${workflow.id}.`,
    'You review: read, run and report, but never edit code. Every issue you find',
    'is reported, not fixed — a fixer agent acts on your findings after you.',
    '',
    '## What to review',
    `The diff of \`${materials.branch}\` against its base \`${materials.baseBranch}\`:`,
    `    git -C ${materials.workspace} diff ${materials.baseBranch}...${materials.branch}`,
    'Read the full diff of every changed file. Spot-checking is not enough.',
    '',
    '## What that diff was supposed to implement',
    materials.brief,
    ...planLevel(materials, [
      'These are the whole plan’s Goals, Non-goals and Guiding Decisions, verbatim.',
      'They are what "scope creep" and "plan compliance" below are measured against:',
      'a change serving a non-goal is scope creep, and one that contradicts a guiding',
      'decision is a finding even where the phase body says nothing about it. Do not',
      'ask this diff to satisfy the whole plan — it implements one phase, and the',
      'phase body above is the only thing it was asked for.',
    ]),
    '',
    '## The three layers, all of them, in order',
    '1. Mechanical. The changed-file list matches the report; the whole diff read;',
    '   the outer gate confirmed green — vague confirmation means you re-run it:',
    ...gateList(materials),
    '   Scope creep and unrelated churn surfaced; a scan of the diff for secrets',
    '   (password, secret, token, api_key, AKIA, BEGIN … KEY).',
    '2. Plan compliance. Every change the phase body asked for is implemented;',
    '   every test it named exists and its assertions exercise the named behaviour;',
    '   the acceptance line is satisfiable by this diff; repo conventions followed;',
    '   new comments read as plain English, one idea per sentence.',
    '3. Independent judgment. Correctness, edge cases, and one structural question:',
    '   is there a reframe that would make whole branches, helpers or layers',
    '   disappear rather than be polished? Finding nothing in a large multi-file',
    '   diff is suspicious — read it again.',
    '',
    'Triage each finding as BLOCKER, SHOULD-FIX or NIT.',
    '',
    '## How to report',
    'List your findings, each with its triage level, file and line. Then end your',
    'final message with one line, exactly:',
    `    ${VERDICT_MARKER} pass`,
    'or',
    `    ${VERDICT_MARKER} fail`,
    `Use \`${VERDICT_MARKER} fail\` if any BLOCKER stands. That line is read by the`,
    'orchestrator; a turn that ends without it is taken as a failure, so it must be',
    'the last thing you write.',
  ])
}

function renderFixer(materials: Materials): string {
  const { node, workflow } = materials
  return section([
    `You are fixing ${node.id}: ${node.name} of plan ${workflow.id}.`,
    `Work entirely inside \`${materials.workspace}\`, on branch \`${materials.branch}\`.`,
    '',
    '## What failed',
    ...failure(materials),
    '',
    '## The phase this branch is implementing',
    materials.brief,
    '',
    '## What to do',
    'Fix exactly what is listed above, and nothing else — an unrelated change here',
    'is scope creep the reviewer will send back. Then re-run the inner loop, and',
    'these, until they are green:',
    ...gateList(materials),
    '',
    '## Required output',
    '- Status: SUCCESS or FAILURE, and why.',
    '- Files modified, paths only.',
    '- What you changed for each finding, and any finding you did not act on.',
  ])
}

/**
 * The gate's log reference where a gate failed, and the reviewer's findings
 * otherwise. Read from the facts of this turn rather than guessed from the
 * transcript: after a red gate the last thing in the transcript is the review
 * that passed, which is not what needs fixing.
 */
function failure(materials: Materials): string[] {
  const gate = materials.facts.gate
  const exitCode = gate?.['exit_code']
  if (typeof exitCode === 'number' && exitCode !== 0) {
    const id = gate?.['id']
    const logRef = gate?.['log_ref']
    return [
      `Gate ${typeof id === 'string' ? id : 'unknown'} failed with exit code ${exitCode}.`,
      typeof logRef === 'string'
        ? `Its output is at ${logRef} — read it first; it says what broke.`
        : 'Re-run the gate command below to see what broke.',
    ]
  }

  return materials.findings === null
    ? ['The review did not pass. Re-read the diff against the phase body below and', 'fix what does not match it.']
    : ['The reviewer reported:', '', materials.findings]
}

/** Joins rendered lines and trims the trailing blank a block naturally leaves. */
function section(lines: readonly string[]): string {
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`
}
