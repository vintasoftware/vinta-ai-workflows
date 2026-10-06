/**
 * Prompt composition: what each agent role is actually told, in one place.
 *
 * `spawn_agent` declares a `prompt_template` (§5.2) and, until this module
 * existed, nothing consumed it: every role was handed `node.prompt_ref` as its
 * entire prompt. An implementer copes with that — it is standing in the
 * repository and the reference names a file — but a fixer handed the same bare
 * string is never told which gate went red, and a review chore is never told
 * to state the `VERDICT:` line the executor reads back.
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
 * the implementer gets those sections whole, and so does a cold review chore,
 * whose reviewer measures scope creep against the non-goals. The fixer is told
 * to turn a named gate green and nothing else, and handing it the plan's goals
 * would only widen that.
 *
 * **The review's protocol and the executor's parser are one definition.**
 * `readVerdict` is exported from here and imported by `executor.ts`, and the
 * review chore's prompt asks for `VERDICT_MARKER`. A prompt that asked for a
 * form the parser does not accept would fail every review silently, so the two
 * cannot be allowed to drift apart.
 *
 * Every role has two forms of prompt, selected by `continuation` (§15.3): the
 * cold one, for a session that has never seen this phase, and a delta for one
 * that already holds the brief, the plan-level bounds and its own prior work.
 * The three rules above bind both — and the third binds the delta hardest,
 * because a review continuation that dropped `VERDICT_MARKER` would look like a
 * harmless trim and send every phase it touched to the operator.
 *
 * **A prompt carries repository content; nothing else here may.** The brief,
 * the dependency summaries and the gate output are the *point* of a prompt
 * and are handed to the agent. They never reach a log line, an error message, a
 * journal payload or a process argument — every `PromptError` below names the
 * node id and the `prompt_ref` and stops there.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { computeWaves } from '../graph.ts'
import type { Journal } from '../journal/journal.ts'
import type { GuardContext } from '../pipeline/guard.ts'
import { AGENT_ROLES, isJudgeGate, type AgentRole, type Chore, type ChoreTiming, type Node, type Workflow } from '../types.ts'

/** The line a review chore is asked to end on, and the one `executor.ts` reads. */
export const VERDICT_MARKER = 'VERDICT:'

/** Matched against the review turn's own last words, never stored. */
const VERDICT_PATTERN = /verdict\s*[:=]\s*(pass|fail)/i

/**
 * The verdict a turn stated, or `undefined` when it stated none. The one
 * definition of the protocol: the review chore's prompt asks for what this
 * accepts.
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
  /** The guard context of this invocation: the gate that failed. */
  readonly facts: GuardContext
  /**
   * True where this turn **continues a session that already ran** (§15.3): the
   * fixer or a chore picking up the implementer's session. The scheduler
   * decides this — it owns the ledger and
   * knows whether the entry was usable — and this module only decides what a
   * continued turn is told.
   *
   * Absent or false is the cold prompt, byte for byte as before, and that is
   * the only safe default: a delta sent into a session that does not carry the
   * brief instructs an agent to fix a gate against work it has never seen.
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
  /**
   * The chore this turn runs, for `prompt_template: 'chore'` and nothing else.
   *
   * A chore's instruction is the *point* of its turn, so unlike a phase brief
   * it is resolved for a continuation too. §15.3's rule is that a delta must
   * not re-send what the session already holds; this is not that — the session
   * has never been told to do this, and a chore turn without its instruction is
   * an agent asked to do nothing in particular to a diff.
   */
  readonly chore?: ChorePrompt
}

/** The chore a `run_chore` turn is running, as the scheduler resolved it. */
export interface ChorePrompt {
  readonly id: string
  readonly chore: Chore
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

  // A chore is dispatched on its own instruction rather than on the phase's, so
  // it branches before the delta rule below — both its forms carry that
  // instruction, and only the framing around it differs.
  if (role === 'chore') {
    const chore = choreMaterials(request, request.workspace)
    if (request.continuation === true && request.reorientation === undefined) {
      return renderChoreContinuation(resume(request, request.workspace), chore)
    }
    const cold = gather(request, request.workspace)
    const preamble =
      request.reorientation === undefined ? '' : renderReorientation(request.reorientation, cold)
    return preamble + renderChore(cold, chore)
  }

  // A continued turn is a delta (§15.3). It is composed from the journal alone:
  // the brief and the plan-level sections are deliberately not resolved, since
  // resolving a document this prompt will not carry could only fail a turn over
  // a reference it does not use — and the cold prompt that opened this session
  // already read them.
  if (request.continuation === true && request.reorientation === undefined) {
    const resumed = resume(request, request.workspace)
    if (role === 'implementer') return renderImplementerContinuation(resumed)
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
function lastReport(
  journal: PromptJournal,
  runId: string,
  nodeId: string,
  limit = SUMMARY_LIMIT,
): string | null {
  const entries = journal.tailTranscript(runId, nodeId, TRANSCRIPT_WINDOW)
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as { type?: string; text?: string } | null
    if (entry === null || typeof entry !== 'object') continue
    if (entry.type === 'assistant_text' && typeof entry.text === 'string' && entry.text !== '') {
      return entry.text.slice(0, limit)
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
    ...composeDatabaseBlock(materials),
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
    ...soloTurn('implements this phase'),
    ...foreground(),
    ...commitProtocol(materials),
    ...prContext(materials),
    ...needsInput(),
    '',
    '## Required output (a single final report)',
    '- Status: SUCCESS or FAILURE, and why — or the NEEDS_INPUT block above, alone.',
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
 * only as untracked files. The reviewer read `git diff <base>...<branch>` and
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
/**
 * How an implementer stops for a decision it should not make alone
 * (`src/questions`).
 *
 * Headless, its harness's question tool reaches nobody, and a question written
 * into a report reads as a finished turn: the reviewer fails it for doing
 * nothing. So the question travels as data — the same `NEEDS_INPUT` block the
 * shipped skills teach — which the scheduler parks on, shows the operator as a
 * card, and answers by resuming this same session.
 */
function needsInput(): string[] {
  return [
    '',
    '## When you need a human decision',
    'Some decisions are not yours: a requirement the brief leaves ambiguous or',
    'contradicts, a dependency whose license is unclear, a change outside this',
    'phase, a destructive or irreversible step. Do not guess, and do not end with a',
    'question in prose — nobody reads it. Do not call a question tool either',
    '(AskUserQuestion and the like): nobody is attached to this session to answer it.',
    'Commit what is finished and verified, then end your turn with this block and',
    'nothing after it:',
    '',
    '```yaml',
    'status: NEEDS_INPUT',
    'blocked_on: <one line: the decision you need>',
    'done_so_far: <one line: what is finished and committed>',
    'questions:            # 1 to 4; each must make sense without the transcript',
    '  - header: <12 characters at most, e.g. "Storage">',
    '    question: <the full question, with the evidence needed to answer it: file:line, error>',
    '    multi_select: false',
    '    options:          # 2 to 4; the one you recommend first, ending " (Recommended)"',
    '      - label: <1 to 5 words>',
    '        description: <what happens if the operator picks it>',
    '      - label: <1 to 5 words>',
    '        description: <what happens if the operator picks it>',
    '```',
    'Do not add an "Other" option: the operator can always type their own answer.',
    'This session resumes with the answers, and you continue from where you stopped.',
  ]
}

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

/**
 * That the agent holding this prompt is the one that does the work.
 *
 * Sessions are kept warm on purpose, and `renderReorientation` is the promise
 * that makes it worth doing: every cross-phase turn opens by telling the agent
 * that what it learned about this repository still holds. That is only true if
 * *this* session is what learned it.
 *
 * claude-code agents were instead dispatching the phase to a sub-agent and
 * reporting its summary back. The sub-agent read the codebase, wrote the code
 * and ended; what survived into the next phase was a paragraph. So the warm
 * session was warm about nothing — every phase paid a cold agent's first turn
 * again, and the cached prefix these prompts are shaped around bought a
 * transcript of delegation rather than of the work.
 *
 * The pull is not laziness, which is why a bare "do not delegate" is not
 * enough. The plan-execution skills — `implement-plan`, `implement-phase`,
 * `review-phase`, `amend-plan` — ship into these same repositories, and they
 * are conductors: their entire content is compose a prompt, pick a model,
 * spawn the implementer. A session handed "You are implementing P3 of plan X"
 * matches their descriptions exactly, loads one unprompted, and follows it
 * correctly. Under this orchestrator that conductor is already running — it is
 * what spawned this session — so the skill is being re-entered one level down.
 * Naming those skills is what makes the rule actionable against a skill the
 * runtime surfaced on its own.
 */
function soloTurn(what: string): string[] {
  return [
    '',
    '## Do this work in this session, yourself',
    `You are the agent that ${what} — not an orchestrator for one. Do not spawn,`,
    'dispatch or delegate to a sub-agent (claude-code’s Task/Agent tool, or whatever',
    'your harness calls the same thing) for any part of it: not the work, not a',
    'search of the codebase, not a second opinion on your own output. Read, run and',
    'write yourself.',
    'This session is reused across phases and rounds, and a later turn will open by',
    'telling you that what you learned about this repository still holds. It holds',
    'only because this session is what learned it. A sub-agent’s reading of the code',
    'ends when the sub-agent does, so a delegated turn leaves you holding its summary',
    'and nothing else, and every turn after it pays for a cold start.',
    'A project skill that tells you to spawn an implementer, reviewer or fixer —',
    '`implement-plan`, `implement-phase`, `review-phase`, `amend-plan`, anything',
    'shaped like them — is written for the orchestrator that dispatches phases. That',
    'orchestrator is already running: it is what spawned you, and its job is not this',
    'turn’s. Take what such a skill says about this repository’s conventions, gates',
    'and commit rules; never follow its spawn steps.',
  ]
}

function commitProtocol(materials: Continuation): string[] {
  return [
    '',
    '## Committing is part of the work, not after it',
    `Your phase is reviewed and merged **from the commits on \`${materials.branch}\`**. The`,
    `review reads \`git diff ${materials.baseBranch}...${materials.branch}\` and nothing else:`,
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
    'finished — it is what makes the work exist for the gates, for the review, and',
    'for the next turn on this branch. The alternative is not "a clean branch": it',
    'is a phase that is gated and reviewed as though you had written nothing, and',
    'then deleted with the lane.',
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

/**
 * Where a compose-delivered database is reachable from, and from where it is
 * not.
 *
 * `delivery: compose` boots the lane its own server inside its own compose
 * project, and `server_url` names that server as the compose network sees it
 * — `postgres://db:5432`. The lane's `DATABASE_URL` is built from it, so an
 * agent that runs `pytest` on the host reads a URL whose host resolves only
 * inside the containers, and debugs a connection refusal that is not a bug.
 * The project's commands — a `docker compose run …` line — are where the
 * suite does resolve it, and so is the gate verb, which runs them.
 */
function composeDatabaseBlock(materials: Continuation): string[] {
  const databases = materials.workflow.project?.databases
  if (databases === undefined) return []
  const composed = (['dev', 'test'] as const).flatMap((role) => {
    const database = databases[role]
    return database?.engine === 'postgres' && database.delivery === 'compose'
      ? [`- \`${database.connection_url_var}\` (${role})`]
      : []
  })
  if (composed.length === 0) return []

  return [
    '',
    '## This lane’s database runs inside its own compose stack',
    'The connection string in each of these variables names the server as the',
    'compose network sees it, and it resolves only from inside that network:',
    ...composed,
    'A test runner started bare on the host cannot reach it, and a connection',
    'refusal from one is not a defect in your code. Run the suite through the',
    'project’s commands above, or through the gate verb, which runs them where the',
    'database is reachable. Do not rewrite the variable to point somewhere else.',
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
/**
 * The file the phase's pull request is written from.
 *
 * The summary this agent already writes in its final report is the best
 * description of the change that will ever exist — it is written by whoever
 * made it, while they still remember why. It used to live only in the
 * transcript, and the pull request went out carrying the plan anchor and
 * nothing else: seven PRs from one run each said
 * `ai-plans/…_IMPLEMENTATION_PLAN.md#phase-7` and no more.
 *
 * So it is asked for as a file, at the path the rest of this toolchain already
 * uses (`open-pr-from-context`), and `open_pr` reads it. Absent, the
 * orchestrator composes a body from the run's record — gates, attempts,
 * conflicts — which is better than the anchor and still not what a reviewer
 * wants most, because none of it says what the change *does*.
 *
 * Deliberately **not** committed. It is about the change rather than part of
 * it, and a phase whose diff contains a file describing its own diff is a
 * phase whose review starts with a question about that.
 */
function prContext(materials: Continuation): string[] {
  const path = `.vinta-ai-workflows/prs-context/${materials.workflow.id}/phase-${materials.node.id}.md`
  return [
    '',
    '## Write the pull request description',
    `Before your final report, write \`${path}\`
(create the directories). **Do not commit it** — it describes the change rather
than being part of it.`,
    'Two sections, exactly these headings:',
    '',
    '```markdown',
    '# Title',
    '',
    '<one line, imperative, under 72 characters>',
    '',
    '# Description',
    '',
    '<what this phase changed and why, in Simple English. Lead with the change a',
    'reviewer is about to read. Name the decisions you took and anything you',
    'deliberately left out. Say what you could not do. No preamble, no restating',
    'the phase brief — it is linked from the PR already.>',
    '```',
    '',
    'This is what a human reads on the pull request, so write it for them rather',
    'than for the orchestrator. If you leave the placeholders in, it is discarded',
    'and the PR falls back to a summary built from gate results.',
  ]
}

/**
 * The node's gates an agent can run through the verb — its command gates.
 *
 * A judge gate is left out of every list an agent reads (§17.4): the verb
 * refuses it, because its question is about the finished phase, and a list
 * naming it would send the agent into a refusal it can do nothing about.
 */
function agentGates(materials: Continuation): string[] {
  return materials.node.gates.filter((id) => {
    const gate = materials.workflow.gates[id]
    return gate !== undefined && !isJudgeGate(gate)
  })
}

function gateList(materials: Continuation): string[] {
  const gates = agentGates(materials)
  return gates.length === 0
    ? ['   - the repository’s own type/build check and its test suite.']
    : gates.map((id) => `   - \`vinta-ai-maestro gate ${id}\``)
}

/**
 * The report line that says which gates ran and what they said.
 *
 * A record, and deliberately not a substitute for one. The gate node runs the
 * gates itself afterwards, because a verdict reached on an agent's word is the
 * bug that rule was written for. What this adds is something to check
 * *against*: a phase whose report claims a green `unit` and whose gate node
 * then fails on `unit` is a specific, findable disagreement.
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
  agentGates(materials).length > 0

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
  const first = agentGates(materials)[0]
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
    'phase passes review and fails its gate afterwards. Where the harness allows',
    'it, a gate’s own command typed by hand is refused before it runs, with the',
    '`vinta-ai-maestro gate` line to use instead — follow it rather than working',
    'around it.',
    '',
    'The gate may run narrowed to the files this phase changed; the full suite',
    'runs once the phases are merged. Running a single test file of your own in',
    'the inner loop is fine — it is the gate’s whole command that goes through',
    'the orchestrator.',
    '',
    'Waiting is the expected outcome, not a failure: it queues for capacity and then',
    'runs a suite. Let it finish — do not interrupt it, add a timeout, or retry it',
    'in some other form. And if it refuses outright, that is the answer to the gate',
    'rather than permission to run the command by hand: say so in your report.',
  ]
}

/**
 * How the fixer turns a red gate green (§16): the cause, not the symptom, and
 * nothing beside it. The fix is gated again straight after, and reviewed again
 * after that, so a change beyond the failure is one more thing both have to
 * read.
 */
function fixerProtocol(): string[] {
  return [
    '',
    '## How to fix',
    'Read the gate’s output before the code: it says what broke. Find the cause and',
    'fix that, in the code this phase changed where you can. Do not weaken, skip or',
    'delete a test, loosen a lint rule, or narrow a check to make it pass — a gate',
    'that goes green that way has stopped checking the thing it was there for. If',
    'the failure is in code this phase did not touch, or the gate itself is broken,',
    'say so in your report rather than working around it. Change nothing unrelated.',
  ]
}

/** The fixer's report. */
function fixerOutput(materials: Continuation): string[] {
  return [
    '',
    '## Required output',
    '- Status: SUCCESS or FAILURE, and why.',
    '- The commit this round made, by hash, and the files it changed, paths only.',
    ...gateReport(materials),
    '- What broke, and what you changed to fix it.',
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
    '## What came back',
    ...failure(materials),
    '',
    '## The phase this branch is implementing',
    materials.brief,
    ...fixerProtocol(),
    '',
    '## Verify',
    'Re-run the inner loop, then run each of these yourself:',
    ...gateList(materials),
    ...gateStopCondition(),
    ...soloTurn('fixes what came back'),
    ...foreground(),
    ...commitProtocol(materials),
    'Keep this round to one commit where you can — a hook rewrite aside — with a',
    'message naming the gate it fixes.',
    ...fixerOutput(materials),
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
// Chores
// ---------------------------------------------------------------------------

/** A chore's own text, resolved, plus the identifiers the prompt names it by. */
interface ChoreMaterials {
  readonly id: string
  /** The instruction, from `prompt` verbatim or `prompt_ref` off the lane. */
  readonly instruction: string
  readonly skill: string | null
  readonly when: ChoreTiming
  /** The phase's PR, as `open_pr` stated it. Null before one opened. */
  readonly pr: { readonly url: string; readonly number: number | null } | null
}

/**
 * The chore's instruction, wherever it was declared.
 *
 * A chore reaching here without one is a wiring mistake rather than an
 * authoring one — `validate.ts` refuses a chore with neither instruction, so
 * the only way to arrive empty is a caller that set `prompt_template: 'chore'`
 * and passed no chore. It fails loudly for the same reason an unknown template
 * does: the alternative is an agent turn that runs, costs a model call, and
 * does nothing anybody asked for.
 */
function choreMaterials(request: SpawnPromptRequest, workspace: string): ChoreMaterials {
  const entry = request.chore
  if (entry === undefined) {
    throw new PromptError(
      `node "${request.node.id}": prompt_template "chore" needs a chore, and none was passed`,
    )
  }

  const { id, chore } = entry
  const instruction =
    chore.prompt ??
    (chore.prompt_ref === undefined
      ? undefined
      : resolveBrief(workspace, request.node.id, chore.prompt_ref, `chores.${id}.prompt_ref`))
  if (instruction === undefined) {
    throw new PromptError(`node "${request.node.id}": chore "${id}" declares no instruction`)
  }

  const url = request.facts.pr?.['url']
  const number = request.facts.pr?.['number']
  return {
    id,
    instruction,
    skill: chore.skill ?? null,
    when: chore.when,
    pr: typeof url === 'string' ? { url, number: typeof number === 'number' ? number : null } : null,
  }
}

/**
 * What every chore turn is told besides its own instruction.
 *
 * Three things, and each one is a mistake a general slot would otherwise make.
 *
 * **The scope is this phase's diff.** A chore is handed a whole worktree, and
 * an instruction like "rewrite the comments" reads as an invitation to rewrite
 * the repository's. The diff is the only bound that is true for every chore
 * anybody would write, so it is stated once here rather than in each one.
 *
 * **The instruction is the whole job.** The session this usually continues is
 * the implementer's, which still holds the phase brief and its own unfinished
 * opinions about the code. Without this line a comment pass turns into a second
 * implementation round — which no reviewer asked for and no fix round paid for.
 *
 * **The gates are not this turn's.** `polish` sits immediately in front of the
 * `verify` gate state, so a chore that runs the suite makes the phase pay for
 * it twice. Saying so is what keeps this cheap; the gate right after is what
 * catches a chore that broke something.
 *
 * A review chore is the exception to all three, and has rules of its own.
 */
function choreRules(materials: Continuation, chore: ChoreMaterials, cold: boolean): string[] {
  if (chore.when === 'after_pr') return afterPrRules(materials, chore)
  if (chore.when === 'review') return reviewRules(materials, chore, cold)
  return [
    '',
    '## What this turn is, and is not',
    `Your scope is this phase's own diff — \`git diff ${materials.baseBranch}...${materials.branch}\`,`,
    'plus anything still uncommitted in this worktree. A file this phase did not',
    'touch is out of scope however much it might benefit; reading one to understand',
    'what you are changing is fine, editing it is not.',
    '',
    'Do what the chore says and nothing else. This is not another implementation',
    'round: the phase has already been written and reviewed, and a change that goes',
    'beyond the instruction is one nobody reviewed and nobody asked for. If the',
    'chore turns out not to apply to this diff, change nothing and say so — that is',
    'a complete and correct outcome, not a failure.',
    '',
    "Do not run this phase's gates. They run on their own immediately after this",
    'turn, against what you commit, so running them here costs the most contended',
    'capacity on the machine to learn something the run is about to learn anyway.',
    ...(chore.skill === null
      ? []
      : [
          '',
          `Use the \`${chore.skill}\` skill for this. If your harness has no such skill,`,
          'say so in your report and do the work by the instruction below.',
        ]),
  ]
}

/**
 * The rules for a chore that runs once the phase's PR is open.
 *
 * The opposite bound from an `after_review` chore: the phase is already merged
 * and pushed, so an edit now would be one that no reviewer and no gate saw,
 * on a branch that is already the PR. The turn works *about* the PR — a
 * review canvas, a comment — and leaves the tree as it found it.
 */
function afterPrRules(materials: Continuation, chore: ChoreMaterials): string[] {
  const pr = chore.pr
  return [
    '',
    '## What this turn is, and is not',
    `This phase is done: \`${materials.branch}\` is reviewed, gated, merged and pushed,`,
    pr === null
      ? 'and its pull request is open.'
      : `and its pull request is open: ${pr.url}${pr.number === null ? '' : ` (number ${pr.number})`}.`,
    'This turn is about that pull request. It is not another implementation round.',
    '',
    'Do not edit, stage, commit or push anything in this worktree. A change made now',
    'would reach the PR with no review and no gate behind it. If the chore seems to',
    'need a code change, say so in your report instead.',
    '',
    'Do what the chore says and nothing else. If it does not apply to this PR,',
    'do nothing and say so — that is a complete and correct outcome.',
    ...(chore.skill === null
      ? []
      : [
          '',
          `Use the \`${chore.skill}\` skill for this. If your harness has no such skill,`,
          'say so in your report and do the work by the instruction below.',
        ]),
  ]
}

/**
 * The rules for the phase's review: the thermo-nuclear review loop, run by the
 * agent that wrote the phase (§16).
 *
 * The loop's own procedure lives in the skill the chore names; this says what
 * only the orchestrator knows. The scope and the baseline. That the gates are
 * already green. The budget, which replaces the skill's own pause to ask — a
 * headless turn that stops to ask whether to continue is a turn that ends, so
 * the turn stops and reports, and `unapproved` asks the operator. How a gate
 * question reaches a person, which is the `NEEDS_INPUT` block rather than a
 * question tool nobody is attached to. And the closing `VERDICT:` line.
 *
 * It also lifts, for exactly one agent, the rule every other turn is held to:
 * do not delegate (`soloTurn`). The reviewer is a sub-agent by design — its
 * independence is the point — and it is the only one. The verification, the
 * fixes and the commits stay in this session, which is what makes the next
 * phase's continuation of it worth anything.
 */
function reviewRules(materials: Continuation, chore: ChoreMaterials, cold: boolean): string[] {
  const budget = materials.node.max_fix_rounds
  return [
    '',
    '## What this turn is',
    'This turn is the phase’s code review, and nothing merges until it approves. The',
    'phase’s gates are already green: the review is of code that builds and passes.',
    '',
    'Run it as a review loop, with yourself as the fixer. Spawn one reviewer, hand',
    'it the scope and the stated requirement, and wait for its verdict. Treat',
    'each finding as a lead, not an order: check it against the code, the tests and',
    'the callers, fix the ones that hold up, and reject the ones that do not with',
    'concrete counter-evidence. Then send the same reviewer what changed, the',
    'findings you rejected and why, and any decisions the operator made, and ask it',
    'to review the whole diff again. The loop ends when the reviewer explicitly',
    'approves. Passing gates are not approval.',
    ...(chore.skill === null
      ? []
      : [
          '',
          `Use the \`${chore.skill}\` skill for this: it is the loop’s full procedure and`,
          'names the standard the reviewer applies — a project `REVIEW.md` where there is',
          'one. Where the skill and this prompt disagree, this prompt wins. If your',
          'harness has no such skill, run the loop as this prompt describes it.',
        ]),
    '',
    '## The scope',
    `This phase’s own diff, \`git diff ${materials.baseBranch}...${materials.branch}\`, against the`,
    `baseline \`${materials.baseBranch}\`. Nothing outside it is in scope for the reviewer or`,
    'for your fixes.',
    cold
      ? 'The stated requirement is the phase brief printed below. Hand it to the reviewer'
      : 'The stated requirement is the phase brief already in this session. Hand it to',
    cold
      ? 'verbatim, with the plan-level decisions when they are printed here.'
      : 'the reviewer verbatim, with the plan-level decisions when you were given them.',
    '',
    '## The reviewer',
    'Exactly one reviewer sub-agent for this whole turn. Spawn it with your harness’s',
    'sub-agent tool (claude-code’s Agent tool, or the same thing under another name)',
    'on its most capable model tier, and send every later pass to that same agent so',
    'it keeps its context. It reads and runs commands but edits nothing: check',
    '`git status --porcelain` and `git rev-parse HEAD` before and after each pass,',
    'and if it changed anything, say so in your report and do not build on it.',
    'This turn resumes after any question you stop to ask, and the reviewer may not',
    'be reachable then. If it is not, spawn a fresh one and give it the findings you',
    'rejected, with your counter-evidence, and the operator’s decisions.',
    '',
    '## The budget',
    ...(budget === undefined
      ? [
          'No pass limit. Keep the loop going until the reviewer approves, and do not stop',
          'to ask whether to keep going.',
        ]
      : [
          budget === 0
            ? 'One pass. If the reviewer does not approve on its first pass, stop there: do'
            : `At most ${budget} passes that come back with blockers. If the reviewer has still`,
          budget === 0
            ? 'not ask whether to keep going. Report what is left, and the orchestrator asks'
            : 'not approved after that, stop: do not ask whether to keep going. Report what',
          budget === 0 ? 'the operator.' : 'is left, and the orchestrator asks the operator.',
        ]),
    'If an earlier turn in this session already ran this review and stopped without',
    'approval, the operator chose to continue: pick the loop up where it stopped,',
    'with a fresh budget.',
    '',
    '## What goes to a person instead of into the code',
    'Do not fix a finding that depends on a decision that is not yours: handling for a',
    'scenario no current caller, type or data reaches; a defensive check on data',
    'already validated upstream; a requirement that the docs, tests and code disagree',
    'about; a delete, a migration, or anything that touches production. Fix every',
    'other finding first and commit, then put those to the operator in one batch with',
    'the block under "When you need a human decision", each with the evidence, the',
    'reviewer’s recommendation and yours. For the first two, your recommendation is',
    'normally to reject the finding.',
    '',
    '## Verify and commit',
    'After each round of fixes, run the inner loop, then each of these yourself:',
    ...gateList(materials),
    'Commit each round as one commit whose message names the findings it addresses,',
    'so the reviewer can read the round.',
  ]
}

/**
 * What the review chore reports, ending on the line `readVerdict` parses.
 *
 * `pass` is the reviewer's explicit approval and nothing else. Without it the
 * turn reads as `fail` — a merge on a review's silence is the one failure a
 * review exists to prevent — so the line has to be the last thing written.
 */
function verdictProtocol(): string[] {
  return [
    '',
    '## Required output',
    '- How many passes the reviewer made, and the commit each round of fixes made.',
    '- Each finding: fixed (and how), rejected (and the counter-evidence), or decided',
    '  by the operator.',
    '- The gates you ran and what they returned.',
    '- The reviewer’s final verdict, in one line of its own words.',
    '',
    'End your final message with one line, exactly:',
    `    ${VERDICT_MARKER} pass`,
    'or',
    `    ${VERDICT_MARKER} fail`,
    `\`${VERDICT_MARKER} pass\` means the reviewer explicitly approved the phase. Anything else`,
    `is \`${VERDICT_MARKER} fail\`. The orchestrator reads that line, and a turn that ends`,
    'without it counts as a failed review, so it must be the last thing you write —',
    'unless you are stopping for a decision, when the NEEDS_INPUT block above ends',
    'the turn alone, with no verdict after it.',
  ]
}

/**
 * That this turn delegates exactly one thing, and does the rest itself.
 *
 * `soloTurn`'s rule, minus the reviewer. The pull towards the conductor skills
 * is the same here as anywhere — `review-phase` matches this turn's description
 * closely — and following its spawn steps would hand the fixes to an agent whose
 * context ends with the turn.
 */
function reviewerOnly(): string[] {
  return [
    '',
    '## Do the rest of this work in this session, yourself',
    'The reviewer is the only sub-agent this turn may use. The verification, the',
    'fixes and the commits are yours: do not delegate any of them, or a search of',
    'the codebase. This session is reused across phases, and what you learn here is',
    'only kept if this session is what learned it. A project skill that tells you to',
    'spawn an implementer or a fixer — `implement-plan`, `implement-phase`,',
    '`review-phase`, `amend-plan` — is written for the orchestrator that dispatches',
    'phases, which is already running. Take what it says about this repository’s',
    'conventions; never follow its spawn steps.',
  ]
}

/** What a chore turn has to report back. Short: it is a small job. */
function choreOutput(chore: ChoreMaterials): string[] {
  if (chore.when === 'review') return verdictProtocol()
  return [
    '',
    '## Required output',
    `- Status: SUCCESS or FAILURE, and why. "Nothing to do for ${chore.id}" is SUCCESS.`,
    ...(chore.when === 'after_pr'
      ? ['- Any links the chore produced (a comment, a review URL).']
      : ['- Files modified, paths only.']),
    '- Anything you deliberately left alone, and why.',
  ]
}

/**
 * The parts of a chore turn its timing decides: who it may delegate to, and
 * whether it commits and may stop to ask.
 */
function choreTail(materials: Continuation, chore: ChoreMaterials): string[] {
  const review = chore.when === 'review'
  return [
    ...(review ? reviewerOnly() : soloTurn('runs this chore')),
    ...foreground(),
    ...(chore.when === 'after_pr' ? [] : commitProtocol(materials)),
    ...(review ? needsInput() : []),
    ...choreOutput(chore),
  ]
}

/** The chore, in a session that has never seen this phase. */
function renderChore(materials: Materials, chore: ChoreMaterials): string {
  const { node, workflow } = materials
  const review = chore.when === 'review'
  return section([
    `You are running the \`${chore.id}\` chore over ${node.id}: ${node.name} of plan ${workflow.id}.`,
    `Work entirely inside \`${materials.workspace}\`, on branch \`${materials.branch}\`, which was`,
    `cut from \`${materials.baseBranch}\`. Never read or write a path outside it: sibling`,
    'phases of this plan may be running in worktrees beside yours.',
    ...commandBlock(materials),
    ...(review ? gateBlock(materials) : []),
    ...leaseBlock(materials),
    ...choreRules(materials, chore, true),
    '',
    '## The chore',
    chore.instruction,
    ...(review
      ? [
          ...planLevel(materials, [
            'These are the whole plan’s Goals, Non-goals and Guiding Decisions, verbatim.',
            'Hand them to the reviewer with the phase brief: a change serving a non-goal',
            'is scope creep, and one that contradicts a guiding decision is a finding. The',
            'phase implements one part of the plan, and the brief is all it was asked for.',
          ]),
          '',
          '## The stated requirement',
          'The phase this diff implements, verbatim.',
        ]
      : [
          '',
          '## The phase this diff was implementing',
          'Context for judging what the diff is for. It is not a list of work to do —',
          'the phase is already written and reviewed.',
        ]),
    '',
    materials.brief,
    ...choreTail(materials, chore),
  ])
}

/**
 * The chore, continuing the session that wrote the phase.
 *
 * The usual form by some distance: `session: 'main'` is the default, and the
 * agent that wrote this diff already knows what every line of it was for, which
 * is most of what makes a chore cheap enough to run on every phase.
 */
function renderChoreContinuation(materials: Continuation, chore: ChoreMaterials): string {
  const { node } = materials
  return section([
    `Still ${node.id}: ${node.name}, same branch \`${materials.branch}\`, same session — but a`,
    `different job. This turn is the \`${chore.id}\` chore over the diff you have already`,
    'written. The phase brief and your own work are above; none of it is repeated',
    'here and none of it has changed.',
    ...(chore.when === 'review' ? gateBlock(materials) : []),
    ...choreRules(materials, chore, false),
    '',
    '## The chore',
    chore.instruction,
    ...choreTail(materials, chore),
  ])
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
// tell an agent to implement what it has already implemented.
//
// What a delta may still restate is anything the *host* knows and the session
// cannot: which turn this is, what came back from the gate, and the
// machine-read protocol the executor parses. Those are cheap, and each of
// them is wrong to leave out.

/**
 * The fixer, continuing the implementer's own session.
 *
 * It opens by claiming the plan's bounds are already above, which the *cold*
 * fixer is never given — deliberately, since handing the plan's goals to an
 * agent told to turn one gate green only widens it. Both are right: the session
 * this continues is the implementer's, and the implementer was given them. The
 * line is true of the context window, not of the fixer's own prompt.
 */
function renderFixerContinuation(materials: Continuation): string {
  const { node } = materials
  return section([
    `Still ${node.id}: ${node.name}, same branch \`${materials.branch}\`, same session.`,
    'You have the phase brief, the plan’s bounds and your own work above — none of',
    'it is repeated here, and none of it has changed.',
    '',
    '## What came back',
    ...failure(materials),
    ...fixerProtocol(),
    '',
    '## Verify',
    'Re-run the inner loop, then run each of these yourself:',
    ...gateList(materials),
    ...gateStopCondition(),
    ...soloTurn('fixes what came back'),
    ...foreground(),
    ...commitProtocol(materials),
    'Keep this round to one commit where you can — a hook rewrite aside — with a',
    'message naming the gate it fixes.',
    ...fixerOutput(materials),
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
    ...soloTurn('implements this phase'),
    ...foreground(),
    ...commitProtocol(materials),
    '',
    'Then file the single final report those instructions asked for.',
  ])
}

/**
 * The gate that failed, and where its output is. Read from the facts of this
 * turn: the fixer only ever runs after a red gate, and the fact names it.
 */
function failure(materials: Continuation): string[] {
  const gate = materials.facts.gate
  const exitCode = gate?.['exit_code']
  if (typeof exitCode !== 'number' || exitCode === 0) {
    return [
      'A gate failed, and the orchestrator did not record which. Run each gate below',
      'to find the red one.',
    ]
  }
  const id = gate?.['id']
  const logRef = gate?.['log_ref']
  return [
    `Gate ${typeof id === 'string' ? id : 'unknown'} failed with exit code ${exitCode}.`,
    typeof logRef === 'string'
      ? `Its output is at ${logRef} — read it first; it says what broke.`
      : 'Re-run the gate command below to see what broke.',
  ]
}

/** Joins rendered lines and trims the trailing blank a block naturally leaves. */
function section(lines: readonly string[]): string {
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`
}
