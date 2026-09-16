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
 * Every role has two forms of prompt, selected by `continuation` (§15.3): the
 * cold one, for a session that has never seen this phase, and a delta for one
 * that already holds the brief, the plan-level bounds and its own prior work.
 * The three rules above bind both — and the third binds the delta hardest,
 * because a reviewer continuation that dropped `VERDICT_MARKER` would look like
 * a harmless trim and fail every node it touched.
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
  /**
   * Which of `nodes` the fixer's own crew member implemented, when the roster
   * staffed this conflict (`integration/staffing.ts`). Node ids, so §11 holds.
   */
  readonly implemented?: readonly string[]
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
  /**
   * True where this turn **continues a session that already ran** (§15.3): the
   * fixer picking up the implementer's session, or the reviewer picking up its
   * own across rounds. The scheduler decides this — it owns the ledger and
   * knows whether the entry was usable — and this module only decides what a
   * continued turn is told.
   *
   * Absent or false is the cold prompt, byte for byte as before, and that is
   * the only safe default: a delta sent into a session that does not carry the
   * brief instructs an agent to fix findings against work it has never seen.
   * §15.2 is the other half of that rule — every invalid ledger entry must fall
   * back to a fresh session *and* a non-continuation prompt.
   */
  readonly continuation?: boolean
  /**
   * Set where this turn continues a session that last ran on a **different
   * node** — the same agent, in the same directory, starting a new phase.
   *
   * Such a turn is not a delta: the session's brief is for work that is
   * finished, so it gets the new phase's brief in full. What it also needs, and
   * what nothing else can tell it, is that the worktree moved while it was
   * away. Its memory of the tree is a memory of the *last* phase's branch, and
   * silently letting it act on that is how an agent edits a file it believes it
   * already changed, or codes against a model it believes it already wrote.
   */
  readonly reorientation?: Reorientation
}

export interface Reorientation {
  /** The phase this session last worked on. */
  readonly priorNodeId: string
  /**
   * Whether the prior phase's work is in this tree — true exactly when this
   * node depends on it. The single most important line in the preamble: a
   * session that remembers writing a model and does not know it is absent will
   * code against something that is not there.
   */
  readonly priorWorkPresent: boolean
  /**
   * Files that differ between what the session last saw and what is checked out
   * now, or null when the host could not compute it.
   *
   * Null is not "nothing changed" and must never read as it. A host with no
   * `laneDelta` says so plainly and tells the agent to treat its whole memory
   * of the tree as stale, which is slower and correct.
   */
  readonly changedFiles: readonly string[] | null
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

  // A continued turn is a delta (§15.3). It is composed from the journal alone:
  // the brief and the plan-level sections are deliberately not resolved, since
  // resolving a document this prompt will not carry could only fail a turn over
  // a reference it does not use — and the cold prompt that opened this session
  // already read them.
  if (request.continuation === true && request.reorientation === undefined) {
    const resumed = resume(request, request.workspace)
    if (role === 'implementer') return renderImplementerContinuation(resumed)
    if (role === 'reviewer') return renderReviewerContinuation(resumed)
    return renderFixerContinuation(resumed)
  }

  // A cross-phase continuation takes the cold prompt — it is a new phase, and
  // the brief is what a new phase is — with the re-orientation in front of it.
  // Ordered that way deliberately: what changed under the agent has to be read
  // before the instructions it would otherwise act on from memory.
  const materials = gather(request, request.workspace)
  const preamble =
    request.reorientation === undefined ? '' : renderReorientation(request.reorientation, materials)
  if (role === 'implementer') return preamble + renderImplementer(materials)
  if (role === 'reviewer') return preamble + renderReviewer(materials)
  return preamble + renderFixer(materials)
}

/**
 * The conflict fixer's prompt. Shared with `integration/fixer.ts`, not forked.
 *
 * `implemented` is told to the agent because the fixer is now the member who
 * wrote one side, and knowing which side is yours changes how you resolve: the
 * temptation is to keep your own and call it merged. It is told together with
 * the reason it cannot be trusted as memory — this is a fresh session in the
 * integration worktree, not the lane that phase was written in — because the
 * alternative is an agent that acts on recall of files it has not read here.
 */
export function composeConflictPrompt(context: ConflictContext): string {
  const mine = context.implemented ?? []
  return [
    `Resolve the merge conflict from merging ${context.incoming} into ${context.into}.`,
    `Conflicted paths: ${context.paths.join(' ')}`,
    `Nodes involved: ${context.nodes.join(' ')}`,
    ...(mine.length === 0
      ? []
      : [
          `You implemented ${mine.join(' ')}. This is a different worktree and a fresh ` +
            'session, so read the files here rather than recalling them — and do not ' +
            'privilege your own side of the conflict.',
        ]),
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

/**
 * What a *continued* turn is composed from: identifiers, the lane, and the
 * facts of the turn that just ended. Everything a cold prompt reads off disk is
 * absent by construction rather than by convention — a continuation renderer
 * cannot re-send a brief it was never handed, which is the one mistake §15.3 is
 * about.
 */
interface Continuation {
  readonly workflow: Workflow
  readonly node: Node
  readonly workspace: string
  readonly branch: string
  readonly baseBranch: string
  /** The reviewer's findings, when this node's last turn was a review. */
  readonly findings: string | null
  readonly facts: GuardContext
}

/** What a cold turn is composed from: the above, plus everything read off disk. */
interface Materials extends Continuation {
  readonly brief: string
  /**
   * The plan's own bounding sections — Goals + Non-goals, Guiding Decisions —
   * resolved verbatim from `workflow.plan_context_refs`. Empty where the
   * workflow names none, and then nothing about the prompt changes.
   */
  readonly planContext: readonly string[]
  readonly dependencies: readonly DependencyContext[]
}

/** The identifiers and turn facts both prompt forms are built on. */
function resume(request: SpawnPromptRequest, workspace: string): Continuation {
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
    findings: lastReport(journal, runId, node.id),
    facts: request.facts,
  }
}

function gather(request: SpawnPromptRequest, workspace: string): Materials {
  const { workflow, node, runId, journal } = request

  return {
    ...resume(request, workspace),
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
    // The resolution root is the *lane*, and saying so is most of the fix. A
    // lane is a fresh worktree of the base branch, so a plan that is untracked,
    // or committed on some other branch, exists in the checkout the operator is
    // looking at and nowhere the run can see it. That is the common cause by
    // some distance, and "names no readable file" sends people to check the
    // spelling of a path that is spelled correctly.
    //
    // The path and the lane directory are identifiers, not content: no line of
    // the document is read before this throws (§11).
    throw new PromptError(
      `node "${nodeId}": ${field} "${promptRef}" names no readable file under ${workspace} — ` +
        'a lane is a fresh worktree of the base branch, so an uncommitted plan, or one ' +
        'committed on another branch, is not in it',
    )
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

/**
 * What the agent has to know before it reads anything else.
 *
 * Three facts, in the order they matter. It is the same session and the same
 * directory — so nothing it knows about *this repository's* conventions,
 * layout or tooling is wasted, which is the whole reason the session was kept.
 * The tree is on a different branch — so its memory of the branch it last
 * worked on describes something that is not here. And, specifically, the last
 * phase's own work either is or is not underneath it.
 *
 * The file list is the part that makes this safe rather than merely hopeful. A
 * general "things may have changed" invites an agent to decide for itself what
 * to trust; a list of paths is checkable.
 */
function renderReorientation(reorientation: Reorientation, materials: Materials): string {
  const { changedFiles, priorNodeId, priorWorkPresent } = reorientation
  const lines = [
    '## Before you start: the worktree moved',
    '',
    `You are the same agent, in the same directory (\`${materials.workspace}\`), and`,
    'everything you learned about this repository still holds — where things live, how',
    'it is tested, what its conventions are. Keep all of it.',
    '',
    `What changed is the checkout. You last worked on ${priorNodeId}; this tree is now`,
    `\`${materials.branch}\`, cut from \`${materials.baseBranch}\`. Your own commits from`,
    priorWorkPresent
      ? `${priorNodeId} ARE in this tree — it is a dependency of this phase, so what you`
      : `${priorNodeId} are NOT in this tree — this phase does not depend on it, so anything`,
    priorWorkPresent
      ? 'built there is underneath you and you may rely on it.'
      : 'you wrote there is absent here. Do not rely on it, import it, or assume it exists.',
    '',
  ]

  if (changedFiles === null) {
    lines.push(
      'The set of files that changed could not be computed, so treat your memory of every',
      'file’s *contents* as stale and re-read before editing. Your memory of the',
      'repository’s shape is still good.',
    )
  } else if (changedFiles.length === 0) {
    lines.push('No file differs from what you last saw. Only the branch is different.')
  } else {
    lines.push(
      'These files differ from what you last saw. Re-read any you intend to touch; your',
      'memory of their contents is out of date:',
      ...changedFiles.map((file) => `- ${file}`),
      '',
      'Every other file is as you left it.',
    )
  }

  return section(lines) + '\n\n'
}

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
    ...commandBlock(materials),
    ...gateBlock(materials),
    ...leaseBlock(materials),
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
    hasCommands(materials)
      ? '3. Inner loop, scoped to what you touched, through the project’s commands\n' +
        '   above: lint clean, then each new test on its own, then the subtree you\n' +
        '   touched. Do not go on while any of them is red.'
      : '3. Inner loop, scoped to what you touched: lint clean, then each new test on\n' +
        '   its own, then the scoped suite. Do not go on while any of them is red.',
    // Imperative, and naming the command. It read "Outer gate, only once the
    // inner loop is green. These run against your lane:" followed by the gate
    // commands — a description of what would happen to the lane later, which is
    // exactly how agents took it. They finished the scoped suite in step 3 and
    // went to step 5 having run no gate at all.
    '4. Outer gate, once the inner loop is green. Run every one of these yourself',
    '   and read what it returns — step 3 does not speak for them, and the phase is',
    '   judged on these:',
    ...gateList(materials),
    '5. A red outer gate sends you back to step 2, for as long as you have room to',
    '   work. It is not a reason to leave the work uncommitted — see below.',
    ...foreground(),
    ...commitProtocol(materials),
    '',
    '## Required output (a single final report)',
    '- Status: SUCCESS or FAILURE, and why.',
    '- Files created or modified, paths only.',
    ...gateReport(materials),
    '- A 5–15 line summary of what you implemented and the decisions you took.',
    '- Deviations from the phase body above, and your reasoning.',
    "- Anything you could not do, with an explanation.",
  ])
}

/**
 * That the phase is judged on commits, and that the turn is not over until the
 * work is on the branch.
 *
 * This is not a reminder. A phase ran four sessions, reported `SUCCESS` with a
 * green inner loop, and never once ran `git commit`: its deliverables existed
 * only as untracked files. The reviewer reads `git diff <base>...<branch>` and
 * so saw an empty diff, reported "phase not implemented at all", and the fixer
 * re-implemented — also without committing — until the fix rounds ran out. Then
 * the lane was recycled and the files were deleted.
 *
 * Every instruction the agent had was *about* committing (`never commit while a
 * gate is red`) and none of them said it had to. An agent that reads its
 * instructions carefully and never commits is following them.
 *
 * **That line is gone now, and this is the second half of the same bug.** Adding
 * this section next to it produced a prompt that said both things: "the turn is
 * not complete until `git status` is empty of your work" and "never commit while
 * a gate is red". Whenever the gate could not be turned green inside the turn —
 * which is most of why fix rounds exist — the two were a contradiction with a
 * `never` on one side, and agents resolved it the way the stronger word points:
 * they left everything uncommitted. The reviewer then found a full tree and an
 * empty diff and raised the BLOCKER it is told to raise, and a fix round went on
 * re-implementing work that was sitting on the disk.
 *
 * Both agents were following their instructions exactly. So the rule is now
 * unconditional in one direction: a red gate changes the *report*, never the
 * decision to commit. The gate node downstream is the authority on whether the
 * phase passes, and it can only judge what is on the branch.
 *
 * `git add -A` is refused explicitly because projects keep untracked local
 * files at the worktree root — env files the pool copied in, a virtualenv a
 * hook built, a database file — and sweeping those onto the phase branch is its
 * own kind of damage. (The pool's rescue commit does use `--all`, on purpose
 * and only when the alternative is deletion; that is a different trade.)
 */
/**
 * That the turn has to finish inside itself.
 *
 * An implementer started five commands with `run_in_background: true` and
 * closed its turn with "I'll wait for the test result notification before
 * continuing to the outer gate." There is no notification: a headless session
 * ends when the turn ends, and whatever it backgrounded is killed with it.
 * Three sessions ended that way — no report, no commit — and the reviewer
 * failed each of them for uncommitted work, which was true and was not the
 * cause.
 *
 * Nothing in the prompt had said so, and "run this in the background and wait
 * for it" is an entirely reasonable thing to believe when you have a tool that
 * offers it.
 */
function foreground(): string[] {
  return [
    '',
    '## Run everything in the foreground',
    'Do not start background tasks — no `run_in_background`, no `&`, no detached',
    'processes you intend to come back to. This session is headless: it ends when',
    'your turn ends, nothing will notify you, and anything still running is killed',
    'with it. A turn that finishes by waiting for a background result finishes',
    'having done nothing, and the phase is then judged on an empty branch.',
    'Long commands are fine — run them and wait for them to return.',
  ]
}

function commitProtocol(materials: Continuation): string[] {
  return [
    '',
    '## Committing is part of the work, not after it',
    `Your phase is reviewed and merged **from the commits on \`${materials.branch}\`**. The`,
    `reviewer reads \`git diff ${materials.baseBranch}...${materials.branch}\` and nothing else:`,
    'a file you wrote and did not commit does not exist as far as the rest of this',
    'run is concerned, and the lane it sits in is reset before the next phase.',
    '',
    'So the turn is not complete until `git status --porcelain` is empty of your',
    'work. Stage **by explicit path** — never `git add -A` or `git add .`, because',
    'this worktree holds local files that are not yours to commit — then commit to',
    `\`${materials.branch}\`. The repository's own git hooks run when you do; if one`,
    'rewrites your files, stage the result and commit again rather than bypassing',
    'it.',
    '',
    '**Commit whether or not you succeeded.** A gate you could not turn green, a',
    'test you could not make pass, a phase you got half way through: none of them',
    'is a reason to end the turn with the work only on disk. Commit it and report',
    'FAILURE, saying what is still red. A commit is not a claim that the phase is',
    'finished — it is what makes the work exist for the reviewer, for the fixer who',
    'acts on their findings, and for the next turn on this branch. The alternative',
    'is not "a clean branch": it is a phase that is reviewed as though you had',
    'written nothing, fixed by someone writing it a second time, and then deleted',
    'with the lane.',
  ]
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

/**
 * The node's gates: the outer gate the phase has to survive, as commands. Read
 * off the workflow, not off the lane, so a continued turn can restate them
 * without any of the materials a cold prompt resolves from disk.
 */
/**
 * The project's own command lines, in the order the inner loop uses them.
 *
 * A fixed vocabulary, glossed here rather than in the document, so an agent is
 * told what each one is *for* and not merely that it exists.
 */
const COMMAND_GLOSS = [
  ['lint', 'Lint'],
  ['typecheck', 'Typecheck'],
  ['test_one', 'One test, or one subtree — append the target'],
  ['test', 'The whole suite'],
  ['migrate', 'Migrate'],
] as const

/**
 * What the project says its own commands are.
 *
 * This exists because of a specific and entirely avoidable failure: an agent
 * told to "run the scoped suite" and given no command runs `pytest`, which in a
 * project whose suite only runs as `docker compose run --rm api python -m
 * pytest …` fails for reasons that have nothing to do with its code — against a
 * database it cannot see, or with no database at all. It then debugs that.
 *
 * Empty when the project declares none, and then every prompt is byte for byte
 * what it was: a workflow written before this field existed cannot be made
 * worse by it.
 */
function commandBlock(materials: Continuation): string[] {
  const commands = materials.workflow.project?.commands
  if (commands === undefined) return []
  const lines = COMMAND_GLOSS.flatMap(([key, gloss]) => {
    const command = commands[key]
    return command === undefined ? [] : [`- ${gloss}: \`${command}\``]
  })
  if (lines.length === 0) return []

  return [
    '',
    '## The project’s commands',
    'Use these exactly as written, from your own worktree. Do not substitute the',
    'underlying tool and do not invent an equivalent: in this project a command may',
    'only work inside a container, with a specific environment, or against this',
    'lane’s own database, and the bare tool call that looks equivalent is not.',
    ...lines,
  ]
}

/** The route from an agent's inner loop into the scheduler's semaphore pools. */
function leaseBlock(materials: Continuation): string[] {
  const resources = Object.entries(materials.workflow.resources)
    .filter(([, resource]) => resource.kind === 'semaphore')
    .map(([id]) => id)
    .sort()
  if (resources.length === 0) return []

  return [
    '',
    '## Resource leases for heavy commands',
    'This run coordinates scarce machine capacity through these resources:',
    ...resources.map((id) => `- \`${id}\``),
    'Before a heavy inner-loop command, take the matching resource through the',
    'daemon. It waits — for as long as it takes — until capacity is free, then runs',
    'your command and releases the lease on exit:',
    `    vinta-ai-maestro with ${resources[0]} -- <command>`,
    'Do not run that command bare: a bare command is invisible to the pool and may',
    'stampede the same CPU, memory, or shared server as sibling lanes.',
    '',
    '**Waiting is the expected outcome, not a failure.** If it prints that it is',
    'waiting for a resource, another lane holds it and yours is queued — let it',
    'wait. Do not interrupt it, do not add a timeout, and do not retry it in some',
    'other form.',
    '',
    'And if it genuinely fails, that is the answer to the command, not permission',
    'to run it yourself: say so in your report. Running the command unleased is',
    'worse than not running it, because it takes the capacity anyway and the pool',
    'cannot see that it did.',
  ]
}

/** Whether there is a `## The project’s commands` section to point step 3 at. */
const hasCommands = (materials: Continuation): boolean => commandBlock(materials).length > 0

/**
 * The node's gates, as the command that runs one.
 *
 * It used to print `id: <cmd>` — the gate's declared command line, verbatim —
 * which is how the gates came to be run four and five times a phase against a
 * tree nothing had changed, every one of them outside the cache and outside the
 * pool. Given the command, an agent runs the command; there was nothing else on
 * the page to run.
 *
 * So the command is gone and the id is the whole of it. `gateBlock` below says
 * what the verb does and why it is not the same as typing the line, and this is
 * the list every step points at.
 */
function gateList(materials: Continuation): string[] {
  const gates = materials.node.gates.filter((id) => materials.workflow.gates[id] !== undefined)
  return gates.length === 0
    ? ['   - the repository’s own type/build check and its test suite.']
    : gates.map((id) => `   - \`vinta-ai-maestro gate ${id}\``)
}

/**
 * The report line that says which gates ran and what they said.
 *
 * A record, and deliberately not a substitute for one. The reviewer is told in
 * the same breath to run the gates itself — that instruction predates this and
 * stays exactly as it was, because the bug it was written for was reviewers
 * reaching a verdict on an implementer's word. What this adds is something to
 * check *against*: a phase whose report claims a green `unit` and whose gate
 * node then fails on `unit` is a specific, findable disagreement, and before
 * this there was nothing on either side to compare.
 */
function gateReport(materials: Continuation): string[] {
  // The ids are deliberately not interpolated: they are already on the page
  // twice, and a list spliced mid-sentence re-wraps this paragraph differently
  // for every workflow that reads it.
  if (!hasGates(materials)) return []
  return [
    '- Every gate you ran, by id, and what it returned. If you did not run one of',
    '  the gates listed above, say so and say why rather than leaving it out.',
  ]
}

/** Whether this node has declared gates to point the verb at. */
const hasGates = (materials: Continuation): boolean =>
  materials.node.gates.some((id) => materials.workflow.gates[id] !== undefined)

/**
 * How to run a gate, and why by id rather than by command.
 *
 * The companion to `leaseBlock`, and written for the same failure one level up.
 * `leaseBlock` gets an agent to queue for a resource before a heavy command;
 * this removes the step where an agent decides what the heavy command *is*. The
 * observed run had an implementer running `project.commands` — lint, typecheck,
 * a scoped suite — and reporting the outer gate as done, because step 4 was
 * phrased as a description of what would run against its lane later. There was
 * no way for the phase to notice: the gate node ran the real suite afterwards
 * and found what the implementer had never looked at.
 *
 * Only rendered for a node with declared gates. A node with none has no id to
 * name, and a block explaining a verb it cannot use is one more thing to
 * misread.
 */
function gateBlock(materials: Continuation): string[] {
  const first = materials.node.gates.find((id) => materials.workflow.gates[id] !== undefined)
  if (first === undefined) return []

  return [
    '',
    '## The outer gate — ask the orchestrator to run it',
    'This plan declares its gates, and the orchestrator runs them for you. Ask for',
    'one by id, from your own worktree:',
    `    vinta-ai-maestro gate ${first}`,
    'It runs the plan’s own command for that gate, in your lane, and exits with the',
    'gate’s exit code — `0` is green. It prints the path to the gate’s output; read',
    'that file when a gate is red, rather than inferring what broke from the code.',
    '',
    '**Run gates this way rather than running their commands yourself.** Three',
    'things are true of a gate the orchestrator ran and none of them survive a',
    'command you typed: the result is cached against your lane’s contents, so a',
    'gate you have already run on an unchanged tree returns instantly the next time',
    'anyone asks; the machine capacity it needs is queued for rather than taken out',
    'from under the other lanes; and what runs is the command this plan declares —',
    'the same one the orchestrator will run to judge this phase. Something you ran',
    'that resembles the gate is not the gate, and reporting it as one is how a',
    'phase passes review and fails its gate afterwards.',
    '',
    'Waiting is the expected outcome, not a failure: it queues for capacity and then',
    'runs a suite. Let it finish — do not interrupt it, add a timeout, or retry it',
    'in some other form. And if it refuses outright, that is the answer to the gate',
    'rather than permission to run the command by hand: say so in your report.',
  ]
}

/**
 * The reviewer's other source of evidence: what is on disk but not on the
 * branch.
 *
 * Shared by both reviewer prompts, because the round *after* a fix is if
 * anything the more likely one to find uncommitted work — the fixer has just
 * been told to commit, and whether it did is the question.
 *
 * **Scoped to a diff that is missing the work**, which it was not. "Where you
 * find uncommitted work, that *is* the finding" made any unclean tree a
 * BLOCKER — and a lane's tree is essentially never clean. The pool copies
 * configuration into it, links dependency trees, and the gates the reviewer was
 * just asked to run leave caches and build output behind; the implementer is
 * told by name not to stage any of it. So a phase could be implemented,
 * committed and correct, and still fail review for the files the harness itself
 * created around it.
 *
 * The failure this was written for is narrower and worth keeping: work that
 * exists only in the tree. That one needs saying because the fixer's response
 * to it — commit what is there — is the opposite of its response to a phase
 * that was never implemented, and the reviewer is the only one positioned to
 * tell those apart.
 */
function workingTree(materials: Continuation): string[] {
  return [
    '',
    '**Check the working tree too, before you conclude anything from an empty or a',
    'thin diff:**',
    `    git -C ${materials.workspace} status --porcelain`,
    'An implementer that did the work and never committed it leaves a full tree and',
    'an empty diff. That is a real failure, and it is not "the phase was not',
    'implemented" — the difference decides whether the fixer writes the code again',
    'or simply commits it, and getting it wrong costs the phase every fix round it',
    'has. Where the phase’s work is in the tree and missing from the diff, that',
    '*is* the finding: name the paths, make it a BLOCKER, and say the work needs',
    'committing rather than writing again.',
    '',
    'An unclean tree is **not by itself a finding.** A lane carries files nobody is',
    'meant to commit — configuration the pool copied in, dependency trees it',
    'linked, caches and build output the gates you just ran produced — and the',
    'implementer is told by name not to stage them. If the diff holds the phase’s',
    'work, do not raise what is sitting in the tree beside it.',
  ]
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
    ...workingTree(materials),
    ...commandBlock(materials),
    ...gateBlock(materials),
    ...leaseBlock(materials),
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
    '   and **you run these yourself and read what they print** — an implementer',
    '   saying they were green is a claim, not evidence, and a verdict reached',
    '   without running them is a guess:',
    ...gateList(materials),
    '   Say in your report that you ran them and what they returned. If you could',
    '   not run them, that is a finding, not something to pass over.',
    // The implementer now reports its own gate runs, and that report is a thing
    // to check rather than a thing to accept. Saying so here because the
    // obvious misreading of a new "gates I ran" section in the material under
    // review is that the running has been done — which is the reviewer bug this
    // layer was written for, arriving from a new direction.
    '   The implementer’s report lists the gates it ran and what they returned.',
    '   That is a claim to check against your own run, not one to accept in place',
    '   of it. Running them again is cheap: an unchanged tree is served from cache.',
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
    ...verdictProtocol(),
  ])
}

/**
 * The verdict protocol, in the one place both reviewer prompts read it from.
 *
 * `readVerdict` above is what the executor runs over the reviewer's last words,
 * and this is what asks for the form it accepts — the module header's third
 * rule. A continuation is where that rule is easiest to break: the delta looks
 * like a nudge to an agent that was already told the protocol two turns ago, so
 * dropping it feels harmless. It is not. Nothing carries a verdict between
 * turns; every turn is parsed on its own and a turn that states none takes the
 * fail-closed default, which fails the node and burns its fix rounds on a
 * review nobody asked for. So this block is not optional in either form, and
 * sharing it is what stops one of them from drifting.
 */
function verdictProtocol(): string[] {
  return [
    '## How to report',
    'List your findings, each with its triage level, file and line. Then end your',
    'final message with one line, exactly:',
    `    ${VERDICT_MARKER} pass`,
    'or',
    `    ${VERDICT_MARKER} fail`,
    `Use \`${VERDICT_MARKER} fail\` if any BLOCKER stands. That line is read by the`,
    'orchestrator; a turn that ends without it is taken as a failure, so it must be',
    'the last thing you write.',
  ]
}

function renderFixer(materials: Materials): string {
  const { node, workflow } = materials
  return section([
    `You are fixing ${node.id}: ${node.name} of plan ${workflow.id}.`,
    `Work entirely inside \`${materials.workspace}\`, on branch \`${materials.branch}\`.`,
    ...commandBlock(materials),
    ...gateBlock(materials),
    ...leaseBlock(materials),
    '',
    '## What failed',
    ...failure(materials),
    '',
    '## The phase this branch is implementing',
    materials.brief,
    '',
    '## What to do',
    'Fix exactly what is listed above, and nothing else — an unrelated change here',
    'is scope creep the reviewer will send back. Then re-run the inner loop, and run',
    'each of these yourself:',
    ...gateList(materials),
    ...gateStopCondition(),
    ...foreground(),
    ...commitProtocol(materials),
    '',
    '## Required output',
    '- Status: SUCCESS or FAILURE, and why.',
    '- Files modified, paths only.',
    ...gateReport(materials),
    '- What you changed for each finding, and any finding you did not act on.',
  ])
}

/**
 * What "green" is, for a fixer that may not reach it.
 *
 * Both fixer prompts said to re-run the gates "until they are green", and the
 * `commitProtocol` section immediately below said to commit and report FAILURE
 * whether or not anything went green. Read together those are a loop with no
 * exit and a rule about how to exit it, and the observed resolution was the
 * wrong one: a fixer that could not turn a gate green had been given no
 * described way to stop, so it kept going until the turn ended — with the work
 * uncommitted, which is the exact failure `commitProtocol` exists to prevent.
 *
 * This is the same word that section uses, in the place the contradiction was.
 */
function gateStopCondition(): string[] {
  return [
    'Keep at it while you have a red gate you know how to fix and room to fix it.',
    'A gate you cannot turn green is not a reason to keep going until the turn ends:',
    'commit what you have and report FAILURE naming the gate and what it said. Green',
    'is what you are aiming at, not the condition for finishing.',
  ]
}

// ---------------------------------------------------------------------------
// Continuation renderers (§15.3)
// ---------------------------------------------------------------------------
//
// A continued turn is handed to a session that already holds the phase brief,
// the plan-level bounds, the dependency closure and its own prior work. Each
// renderer below is therefore a *delta*: the facts that are new since that
// session last spoke, and what to do about them. Re-sending the brief here
// would not merely waste the prefix these prompts exist to cache — it would
// tell an agent to implement what it has already implemented, and tell a
// reviewer to review a diff it has already reviewed.
//
// What a delta may still restate is anything the *host* knows and the session
// cannot: which turn this is, what came back from the gate or the reviewer, and
// the machine-read protocol the executor parses. Those are cheap, and each of
// them is wrong to leave out.

/**
 * The fixer, continuing the implementer's own session.
 *
 * It opens by claiming the plan's bounds are already above, which the *cold*
 * fixer is never given — deliberately, since handing the plan's goals to an
 * agent told to change one named thing only widens it. Both are right: the
 * session this continues is the implementer's, and the implementer was given
 * them. The line is true of the context window, not of the fixer's own prompt.
 */
function renderFixerContinuation(materials: Continuation): string {
  const { node } = materials
  return section([
    `Still ${node.id}: ${node.name}, same branch \`${materials.branch}\`, same session.`,
    'You have the phase brief, the plan’s bounds and your own work above — none of',
    'it is repeated here, and none of it has changed.',
    '',
    '## What came back',
    ...failure(materials, [
      'The review did not pass and recorded no findings. Re-read your own diff',
      'against the phase brief already above, and fix what does not match it.',
    ]),
    '',
    '## What to do',
    'Change exactly what is named above and nothing else. Everything else on this',
    'branch stays as it is — an unrelated edit here is scope creep the next review',
    'will send back, and it costs a fix round you may need. Then re-run the inner',
    'loop, and run each of these yourself:',
    ...gateList(materials),
    ...gateStopCondition(),
    ...foreground(),
    ...commitProtocol(materials),
    '',
    '## Required output',
    '- Status: SUCCESS or FAILURE, and why.',
    '- Files modified, paths only.',
    ...gateReport(materials),
    '- What you changed for each finding, and any finding you did not act on.',
  ])
}

function renderReviewerContinuation(materials: Continuation): string {
  const { node } = materials
  return section([
    `Still reviewing ${node.id}: ${node.name}. A fixer has acted on the findings you`,
    'raised above; the phase brief and the plan’s bounds are unchanged and already',
    'in this session, so only the diff is new.',
    'You still review rather than edit: report every issue, fix none of them.',
    '',
    '## What to re-review',
    'The diff as it now stands:',
    `    git -C ${materials.workspace} diff ${materials.baseBranch}...${materials.branch}`,
    'Read it again in full. A fix moves lines you had already accepted, so a diff',
    'you only re-read around the findings is one you have not read.',
    '',
    '**Run these again yourself, every round.** A session that remembers running',
    'them last round is remembering a different tree:',
    ...gateList(materials),
    // The verification stays; only the cost of it changed. A reviewer told the
    // repetition is cheap has one fewer reason to talk itself out of it.
    'A round that changed nothing they touch is served from cache and returns at',
    'once, so this costs you very little — and a round that did change something is',
    'exactly the round where last round’s answer is wrong.',
    ...workingTree(materials),
    '',
    '## What to decide',
    '1. Each finding you raised: addressed, addressed in a way that breaks something',
    '   else, or not addressed. Say which, per finding.',
    '2. Anything the fix itself introduced — a new problem in new code is a new',
    '   finding, at its own triage level.',
    '3. Nothing else. Do not re-open what you already passed, and do not raise a',
    '   finding you could have raised last round: the fixer cannot be sent back',
    '   forever, and a moving bar is how a sound phase runs out of fix rounds.',
    '',
    'Triage each finding as BLOCKER, SHOULD-FIX or NIT.',
    '',
    // Restated in full, every round. See `verdictProtocol` for why this is not
    // the sort of repetition a delta is allowed to drop.
    ...verdictProtocol(),
  ])
}

/**
 * The implementer, resumed rather than re-briefed.
 *
 * This turn is not a new instruction: the session was interrupted — it waited
 * for lane capacity, or an operator took its terminal over (§9) and handed it
 * back. So the delta says what the session cannot know for itself, which is
 * that it is running again and that the worktree may have moved underneath it.
 */
function renderImplementerContinuation(materials: Continuation): string {
  const { node } = materials
  return section([
    `Resuming ${node.id}: ${node.name}. Pick up exactly where you left off — nothing`,
    'above is superseded and nothing about the phase has changed.',
    `You are in \`${materials.workspace}\`, on branch \`${materials.branch}\`.`,
    '',
    '## Before you carry on',
    'Run `git status` and `git diff` first. This session was interrupted, and an',
    'operator may have edited or committed in this worktree while it was paused, so',
    'what is on disk is the truth about your progress and your memory of it is not.',
    'If the work is already finished and committed, say so in your report instead of',
    'redoing it — re-implementing what is already committed is the one failure this',
    'message exists to prevent.',
    '',
    '## What is left',
    'Finish the working instructions you were given, in the order you were given',
    'them, ending on a green outer gate:',
    ...gateList(materials),
    ...foreground(),
    ...commitProtocol(materials),
    '',
    'Then file the single final report those instructions asked for.',
  ])
}

/**
 * The gate's log reference where a gate failed, and the reviewer's findings
 * otherwise. Read from the facts of this turn rather than guessed from the
 * transcript: after a red gate the last thing in the transcript is the review
 * that passed, which is not what needs fixing.
 *
 * `absent` is the one line that cannot be shared between the two prompt forms:
 * a cold fixer is pointed at the phase body printed below it, and a continued
 * one at the body already in its own context, which is nowhere on the page.
 */
function failure(
  materials: Continuation,
  absent: readonly string[] = [
    'The review did not pass. Re-read the diff against the phase body below and',
    'fix what does not match it.',
  ],
): string[] {
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

  return materials.findings === null ? [...absent] : ['The reviewer reported:', '', materials.findings]
}

/** Joins rendered lines and trims the trailing blank a block naturally leaves. */
function section(lines: readonly string[]): string {
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`
}
