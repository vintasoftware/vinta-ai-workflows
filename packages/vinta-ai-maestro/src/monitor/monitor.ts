/**
 * The run's spokesperson: one agent that reads the journal and answers the
 * operator in prose.
 *
 * A parallel run is eight phases in eight worktrees, and until now the only way
 * to learn what happened to one was to read a status table, open three
 * transcripts and correlate them by hand. This is the thing you can ask
 * instead — what is blocked, why p1 died, what it would take to move on.
 *
 * Three decisions shape it, and each is a decision *against* something.
 *
 * **It is not in the permission path.** The obvious thought, once an agent has
 * been refused something, is to put a smarter agent in front of the refusals.
 * But a phase makes hundreds of tool calls — one node in one real run made 179 —
 * and a model turn before each is latency and cost spent on questions like "may
 * I run ruff", which should never have been questions. Permissions are settled
 * structurally instead, once per spawn and for free (`harness/read-access.ts`).
 * What reaches a person is a *decision* — a gate failed, a review said no — and
 * that is what this explains.
 *
 * **It reads a digest, not the transcripts.** Piping every agent's output into
 * a second agent would make the monitor the most expensive thing in the run and
 * tie its cost to the work rather than to the questions. The digest is bounded
 * by construction: statuses, failure reasons, pending questions, the last few
 * refusals, one trimmed last word per phase. A one-hour run and a one-day run
 * produce digests of about the same size.
 *
 * **It has no authority.** It can be asked to explain a pause; it cannot answer
 * one. §9.1's question is resolved by the operator through the endpoint it has
 * always used. An agent that could quietly approve its colleagues' work would
 * turn a checkpoint into a formality, and the checkpoint is the point.
 *
 * It needs no lane — it writes nothing and runs in the repository — and it is
 * built on demand, including for a run that finished days ago, which is when
 * "why did this fail" is usually asked.
 */
import { dirname, join } from 'node:path'

import type { HarnessAdapter } from '../harness/adapter.ts'
import type { NodeStatus } from '../journal/events.ts'
import type { Journal } from '../journal/journal.ts'
import { MONITOR_ROLE, OPERATOR_ROLE } from '../journal/transcript.ts'
import type { Workflow } from '../types.ts'

/** How much of an agent's last word to carry. A gist, not a transcript. */
const LAST_WORD_LIMIT = 600

/** Refusals and errors per node: enough to see a pattern, not to drown in one. */
const TROUBLE_LIMIT = 6

/** How far back in a transcript to look for them. */
const SCAN_LIMIT = 200

export interface NodeDigest {
  readonly nodeId: string
  readonly name: string
  readonly status: NodeStatus
  readonly wave: number
  readonly harness: string
  /** Why it failed, as the scheduler recorded it. */
  readonly failure: string | null
  /** The §9.1 question it is parked on, if it is parked. */
  readonly question: string | null
  /** Refusals and errors from its transcript, oldest first. */
  readonly trouble: readonly string[]
  /** The last thing the agent said, trimmed. */
  readonly lastWord: string | null
  /** Where this phase's brief lives, in the plan document. */
  readonly promptRef: string | null
  /** The worktree its agent worked in — an absolute path, or null before it started. */
  readonly lanePath: string | null
  /** The branch it committed to, and what that branch was cut from. */
  readonly branch: string | null
  readonly baseBranch: string | null
}

export interface RunDigest {
  readonly runId: string
  readonly workflowId: string
  readonly status: string
  readonly baseBranch: string
  /** The checkout everything hangs off — the monitor's own working directory. */
  readonly repoPath: string
  /** `<repo>/.vinta-ai-maestro`: the journal, the run directories, the lanes. */
  readonly storePath: string
  /** The plan document this run executes, if the workflow names one. */
  readonly planRef: string | null
  readonly nodes: readonly NodeDigest[]
}

/**
 * What the monitor is told about a run, assembled from the journal.
 *
 * Null for a run the journal has never heard of, which is the same answer the
 * API gives for one: a monitor for a run that does not exist would be a
 * conversation about nothing.
 */
export function runDigest(journal: Journal, runId: string, workflow: Workflow): RunDigest | null {
  const row = journal.run(runId)
  if (row === undefined) return null

  const declared = new Map(workflow.nodes.map((node) => [node.id, node]))
  const failures = failureReasons(journal, runId)
  // `Journal.root` is `<project>/.vinta-ai-maestro`, so its parent is the checkout.
  const storePath = journal.root
  const repoPath = dirname(storePath)

  const nodes = journal.nodes(runId).map((node): NodeDigest => {
    const entries = journal.tailTranscript(runId, node.node_id, SCAN_LIMIT) as readonly unknown[]
    const spec = declared.get(node.node_id)
    return {
      nodeId: node.node_id,
      name: spec?.name ?? node.node_id,
      status: node.status,
      wave: node.wave,
      harness: node.harness,
      failure: failures.get(node.node_id) ?? null,
      question: journal.pendingQuestion(runId, node.node_id)?.question.question ?? null,
      trouble: troubleOf(entries),
      lastWord: lastWordOf(entries),
      promptRef: spec?.prompt_ref ?? null,
      // The name is what the journal records; the path is what a shell needs.
      lanePath: node.lane === null ? null : join(storePath, 'lanes', node.lane),
      branch: node.branch,
      baseBranch: node.base_branch,
    }
  })

  return {
    runId: row.id,
    workflowId: row.workflow_id,
    status: row.status,
    baseBranch: row.base_branch,
    repoPath,
    storePath,
    planRef: workflow.plan_ref ?? null,
    nodes,
  }
}

/** The reason each failed node recorded, from its own `node_status` event. */
function failureReasons(journal: Journal, runId: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const event of journal.events(runId)) {
    if (event.type !== 'node_status' || event.nodeId === null) continue
    const payload = event.payload as { status?: string; reason?: string }
    if (payload.status === 'failed' && typeof payload.reason === 'string') {
      found.set(event.nodeId, payload.reason)
    }
  }
  return found
}

/**
 * The refusals and errors in a node's transcript.
 *
 * These are the entries that explain a failure rather than describe the work.
 * A run whose phases were refused sixty-nine shell commands is exactly the case
 * where reading these in order *is* the diagnosis — and the case that motivated
 * carrying a refusal's own sentence rather than only its token.
 */
function troubleOf(entries: readonly unknown[]): readonly string[] {
  const found: string[] = []
  for (const entry of entries) {
    const row = entry as {
      type?: string
      tool?: string
      reason?: string
      detail?: string
      message?: string
    }
    if (row.type === 'permission_denied') {
      found.push(`refused ${row.tool ?? '?'}: ${row.detail ?? row.reason ?? 'no reason given'}`)
    } else if (row.type === 'error' && typeof row.message === 'string') {
      found.push(`error: ${row.message}`)
    }
  }
  // The newest are the ones that ended the turn.
  return found.slice(-TROUBLE_LIMIT)
}

function lastWordOf(entries: readonly unknown[]): string | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const row = entries[i] as { type?: string; text?: string }
    if (row.type === 'assistant_text' && typeof row.text === 'string' && row.text.trim() !== '') {
      return row.text.slice(0, LAST_WORD_LIMIT)
    }
  }
  return null
}

/**
 * The digest as the monitor reads it.
 *
 * Prose rather than JSON: a model reads this, and a short paragraph per phase
 * costs fewer tokens and is understood better than the same facts in braces.
 */
export function describe(digest: RunDigest): string {
  const lines = [
    `Run ${digest.runId} of plan "${digest.workflowId}" — status: ${digest.status}.`,
    `Base branch: ${digest.baseBranch}. ${digest.nodes.length} phases.`,
    `Repository: ${digest.repoPath}`,
    `Store: ${digest.storePath} (journal at flow.db, run state under runs/, lane worktrees under lanes/)`,
    ...(digest.planRef === null ? [] : [`Plan document: ${digest.planRef}`]),
    '',
  ]
  for (const node of digest.nodes) {
    lines.push(`## ${node.nodeId} — ${node.name}`)
    lines.push(`status: ${node.status} · wave ${node.wave} · harness ${node.harness}`)
    if (node.promptRef !== null) lines.push(`brief: ${node.promptRef}`)
    if (node.lanePath !== null) lines.push(`worktree: ${node.lanePath}`)
    if (node.branch !== null) {
      lines.push(`branch: ${node.branch}${node.baseBranch === null ? '' : ` (cut from ${node.baseBranch})`}`)
    }
    if (node.failure !== null) lines.push(`failed because: ${node.failure}`)
    if (node.question !== null) lines.push(`waiting on the operator: ${node.question}`)
    for (const line of node.trouble) lines.push(`- ${line}`)
    if (node.lastWord !== null) lines.push(`last said: ${node.lastWord}`)
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * The monitor's standing instructions — its brief, not the operator's question.
 *
 * **It is told how to go and look, not only what happened.** The first version
 * summarised a digest and nothing else, and read exactly as thin as that
 * sounds: it could say a phase had failed and never say what the phase had
 * actually written. It has a shell and it runs in the repository, so the honest
 * brief is the one that hands it the map — where the lanes are, which branch
 * each phase committed to, where the plan lives, where the journal lives — and
 * expects it to read the diff before it draws a conclusion.
 *
 * The digest stays because it is the index: cheap, bounded, and enough to know
 * *which* phase is worth a closer look. What changed is that a closer look is
 * now possible.
 */
export function brief(digest: RunDigest): string {
  return [
    'You are the technical project manager for a parallel implementation run. Several',
    'coding agents work in isolated git worktrees on phases of one plan. You do not',
    'write code and you do not approve anything — you find out what is true and tell',
    'the operator.',
    '',
    'You have a shell, and your working directory is the repository. Use it. The run',
    'state below is an index, not the evidence; when it matters, go and look:',
    '',
    `- **The plan.** ${digest.planRef ?? 'named in the workflow document under ai-plans/'}.`,
    '  Each phase names the section of it that briefs the agent. Read the brief before',
    '  judging whether a phase did what it was asked.',
    '- **What a phase actually wrote.** Every phase has a worktree and a branch:',
    '  `git -C <worktree> diff <base>...<branch>` for the change, `git -C <worktree>`',
    '  `log --oneline <base>..<branch>` for the commits, `git -C <worktree> status`',
    '  `--porcelain` for work it never committed. A phase that failed with an empty',
    '  diff and a phase that failed having written six files are different failures.',
    '- **The run’s own record.** The journal is SQLite at',
    `  \`${digest.storePath}/flow.db\`: the \`events\` table carries every status change,`,
    '  lease and session decision as JSON in `payload_json`. Transcripts are JSONL',
    `  under \`${digest.storePath}/runs/<run>/nodes/<node>/transcript.jsonl\` — one`,
    '  event per line, with `permission_denied` and `error` rows explaining refusals.',
    '  Gate logs sit beside them.',
    '',
    '**Read, never run.** Git commands, the journal and the logs are yours. The',
    'project’s own commands are not: do not run its tests, its gates, its linters, or',
    '`docker compose` anything. Each lane holds its own compose project, its own',
    'database and its own ports, and that isolation lives in an environment your',
    'shell does not have — so the project’s commands run from here contend with the',
    'lanes instead of observing them, and what they report is an artifact of your',
    'running them. A monitor that did this once reported "the final gate fails on a',
    'port conflict" when no gate had run at all, and the operator believed it. Gate',
    'results come from `gate_result` rows in the journal and from the gate logs; if',
    'no gate has run, the honest answer is that none has.',
    '',
    'Answer specifically and briefly. Name phases by id, say what your evidence was —',
    'the command you ran, the line you read — and say plainly when you could not find',
    'out rather than filling the gap. If a phase waits on the operator, explain what',
    'the question means and what each answer would do; the operator decides, not you.',
    '',
    '--- run state ---',
    describe(digest),
  ].join('\n')
}

/**
 * Where the conversation is kept.
 *
 * A reserved node id, so the exchange lands in the same transcript store every
 * phase uses and is read back by the same call. It cannot collide with a phase:
 * node ids are lowercase kebab-case (`types.ts`), so one beginning with `_` is
 * not merely unused but unrepresentable.
 *
 * **It used to be `monitor:conversation`, and that was a Windows bug.** The
 * colon was chosen for exactly the reason the underscore is now — no phase id
 * may contain one — but this id is not only a key: it becomes a *directory*,
 * `<journal>/runs/<run>/nodes/<MONITOR_NODE>`, and a colon is the drive and
 * alternate-stream separator on Windows. `mkdir` there fails with `ENOENT`, so
 * on Windows every question threw on the first append and the endpoint reported
 * the monitor unavailable. It had never worked on that platform, and could not
 * have: a colon is legal in a macOS or Linux filename, so every machine the
 * feature was developed and tested on hid it.
 *
 * The character set here is therefore load-bearing, and `monitor.test.ts` holds
 * it to the characters every platform accepts.
 */
export const MONITOR_NODE = '_monitor-conversation'

export interface MonitorOptions {
  readonly adapter: HarnessAdapter
  /** The dearest model on the roster: this is the reasoning, not the typing. */
  readonly model: string
  /** Where it runs. The repository, not a lane — it writes nothing. */
  readonly cwd: string
  /**
   * Where the conversation is written, so it survives the tab.
   *
   * A monitor that forgot everything on reload would be a worse record than the
   * journal it reads: the operator would have asked the question, got the
   * answer, and be left with neither. Absent for a caller that only wants the
   * answer — the digest tests do — and then nothing is recorded.
   */
  readonly journal?: Journal
}

/**
 * One conversation about one run.
 *
 * The session is kept, so a second question costs a resume rather than a fresh
 * read of the whole digest — the same reason crew members hold theirs (§15).
 * Every turn still carries the current digest, because the run moves while the
 * operator reads: a monitor answering confidently from ten-minute-old state is
 * worse than one that admits it does not know.
 */
export class Monitor {
  #session: string | null = null
  readonly #options: MonitorOptions

  // A field and an assignment rather than the parameter property its neighbours
  // use. Both are fine for the shipped binary, whose shebang asks for
  // `--experimental-transform-types` precisely so that parameter properties
  // work (`cli/bin.ts`). This form additionally loads under the cheaper
  // strip-only mode, which is what an ad-hoc `node src/...` reaches for.
  constructor(options: MonitorOptions) {
    this.#options = options
  }

  /** The session this conversation is continuing, for tests and for the API. */
  get session(): string | null {
    return this.#session
  }

  /** Reported with every answer: the operator should know who is talking. */
  get model(): string {
    return this.#options.model
  }

  async ask(digest: RunDigest, question: string): Promise<string> {
    const cold = this.#session === null
    const prompt = cold
      ? `${brief(digest)}\n\n--- the operator asks ---\n${question}`
      : [
          'The run has moved on since your last answer. Here is its state now.',
          '',
          describe(digest),
          '',
          '--- the operator asks ---',
          question,
        ].join('\n')

    const outcome = await this.#options.adapter.spawn({
      // Not a node. The id is a label for the journal and the logs, and it
      // cannot collide with a phase because a phase id has no colon in it.
      nodeId: `monitor:${digest.runId}`,
      cwd: this.#options.cwd,
      prompt,
      model: this.#options.model,
      ...(cold ? {} : { resumeSessionId: this.#session as string }),
    })

    if (!outcome.ok) {
      // A stale session is the one refusal worth absorbing: the vendor has
      // forgotten a conversation the operator still wants to have, and starting
      // a new one costs a digest rather than an error message.
      if (outcome.kind === 'stale_session' && !cold) {
        this.#session = null
        return await this.ask(digest, question)
      }
      // The kind is a fixed token. The adapter's message may quote a harness,
      // and this string reaches a browser (§11).
      throw new MonitorUnavailable(outcome.kind)
    }

    // The operator's words, in the record, before the answer exists — so a
    // question whose answer never arrives is still visibly a question that was
    // asked, rather than nothing at all.
    this.#options.journal?.appendTranscript(digest.runId, MONITOR_NODE, {
      type: 'user_message',
      text: question,
      // The operator's, not the monitor's — the same §7 rule a phase's
      // transcript follows (`journal/transcript.ts`).
      by: { role: OPERATOR_ROLE },
    })

    // Journalled **as it arrives**, not joined and written at the end.
    //
    // The end was where the whole answer used to appear, which is why a
    // conversation with the monitor was a question, a spinner, and then a wall
    // of text: nothing existed to show until the turn was over. Now the record
    // grows while the turn runs, and anything reading the conversation back —
    // this daemon's own endpoint, a reloaded tab — sees a monitor thinking
    // rather than a monitor that has not answered yet.
    //
    // `thinking` is kept for the same reason it is kept in a phase's
    // transcript: it is most of what there is to see while a model works, and
    // dropping it was what left the browser with nothing to render but a word.
    const said: string[] = []
    for await (const event of outcome.session.events) {
      if (event.type === 'session_started') this.#session = event.sessionId
      if (event.type !== 'thinking' && event.type !== 'assistant_text') continue
      if (event.type === 'assistant_text') said.push(event.text)
      if (event.text.trim() === '') continue
      this.#options.journal?.appendTranscript(digest.runId, MONITOR_NODE, {
        type: event.type,
        text: event.text,
        by: { role: MONITOR_ROLE },
      })
    }
    return said.join('\n').trim()
  }

  /** Start over. A conversation that has gone wrong is cheaper to replace. */
  reset(): void {
    this.#session = null
  }
}

/** The monitor could not be reached. Carries a refusal kind, never prose. */
export class MonitorUnavailable extends Error {
  readonly kind: string

  constructor(kind: string) {
    super(`monitor unavailable: ${kind}`)
    this.kind = kind
  }
}

/**
 * The dearest model on the roster, which is what this should think with.
 *
 * The monitor is read by a person deciding what to do about a failing run, and
 * it is asked a handful of times per run rather than hundreds — so it is the
 * one place where paying for the best reasoning available is plainly right.
 * Falls back to the workflow's default model for a plan with no crew.
 */
export function monitorModel(workflow: Workflow): string {
  const dearest = Object.values(workflow.crew).reduce<{ tier: number; model: string } | null>(
    (best, member) => (best === null || member.tier > best.tier ? member : best),
    null,
  )
  return dearest?.model ?? workflow.defaults.model
}
