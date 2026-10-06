/**
 * The run coordinator: one agent per run that watches it, fixes what is wrong
 * with it, and tunes how it executes — and the one an operator talks to.
 *
 * It does not orchestrate. The scheduler dispatches phases, the integrator
 * merges waves, the gates decide what passes; none of that moves here. What
 * moved here is everything a person used to have to notice and do by hand
 * while a run went on without them: a phase whose agent loops on a database it
 * cannot reach, an `env_files` entry nobody declared, a gate command missing
 * its reuse flag, a phase queued for an hour behind a fix round that hung, an
 * error maestro logged about itself at three in the morning.
 *
 * **It is woken, not polled by a person.** `coordinator/loop.ts` wakes it when
 * a phase fails, an attempt errors, maestro logs an error, a phase waits too
 * long for the integration worktree, or a phase or gate crosses a cost
 * threshold. The operator can also ask it anything, in the same conversation:
 * one session holds both, so "what did you do about p7?" has an answer.
 *
 * **It acts through the run's own API, with a token of its own.** From its
 * shell it drives `vinta-ai-maestro`: tell a running agent something, redirect
 * it, pause, abort or retry a phase, answer a question, amend the live run,
 * and run a command in a lane or the integration worktree with that
 * worktree's environment. Every one of those is attributed to it in the
 * journal, and what it may not do is refused where the request lands, not
 * merely discouraged in its brief (`coordinator/policy.ts`): it may change
 * *how* the run executes, never *what* the plan builds, and it may never make
 * a check weaker. It answers only questions a `--retry-after` timer could
 * answer, never one a person is holding, and it cannot halt the run.
 *
 * **It is not in the permission path**, for the reason it never was: a phase
 * makes hundreds of tool calls, and a model turn before each would make the
 * coordinator the most expensive thing in the run. Permissions are settled
 * structurally, once per spawn (`harness/read-access.ts`).
 *
 * **It reads a digest first, not the transcripts.** The digest is bounded by
 * construction — statuses, failure reasons, pending questions, the last few
 * refusals, one trimmed last word per phase — and it is the index: enough to
 * know which phase is worth opening.
 *
 * Built per run and kept for the run (`cli/serve.ts`), so the operator's
 * questions and the wake-ups share one session and one turn at a time. For a
 * run that is not live — asked about days later — it has no token and no
 * powers, and reads.
 */
import { dirname, join } from 'node:path'

import type { AgentTask, HarnessAdapter, SpawnOutcome } from '../harness/adapter.ts'
import { type ModelFallbacks, spawnWithFallbacks } from '../harness/fallback.ts'
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

/** How the coordinator reaches the run, when the run is live. */
export interface CoordinatorReach {
  /** The run id every command takes. */
  readonly runId: string
}

/**
 * The coordinator's standing instructions.
 *
 * **It is told how to go and look, and what it may do once it has.** The
 * first version of this agent summarised a digest and could say a phase had
 * failed without ever saying what the phase had written; the second could
 * look but not touch, and an operator found it "sort of useless" — it could
 * explain the database the agents could not reach and do nothing about it.
 *
 * **The project's commands run in a worktree's own environment or not at
 * all.** A shell in the main checkout does not have a lane's database,
 * compose project or ports, so a test run from there contends with the lanes
 * instead of observing them; one monitor reported a port conflict in a gate
 * that had never run. `exec` runs the command in the job, with the worktree's
 * environment, which is what makes "run the failing test yourself" safe to
 * say at all.
 *
 * **What it may not do is listed as plainly as what it may.** A model told
 * only what it can do will find a way to want it, and the server refuses the
 * rest anyway; saying so up front saves the turn it would spend finding out.
 */
export function brief(digest: RunDigest, live: CoordinatorReach | null): string {
  const run = digest.runId
  return [
    'You are the run coordinator for a parallel implementation run. Several coding',
    'agents work in isolated git worktrees on phases of one plan. You do not orchestrate:',
    'the scheduler dispatches phases, merges waves and runs gates. Your job is to keep the',
    'run healthy and moving — find out what is wrong, fix what is broken around the',
    'agents, steer the ones that are stuck, and tune how the run executes — and to tell the',
    'operator, plainly, what you found and what you did.',
    '',
    'Your working directory is the repository. The run state below is an index, not the',
    'evidence; when it matters, go and look:',
    '',
    `- **The plan.** ${digest.planRef ?? 'named in the workflow document under ai-plans/'}.`,
    '  Each phase names the section of it that briefs the agent.',
    '- **What a phase wrote.** `git -C <worktree> diff <base>...<branch>`,',
    '  `git -C <worktree> log --oneline <base>..<branch>`, `git -C <worktree> status --porcelain`.',
    '- **The run’s record.** The journal is SQLite at',
    `  \`${digest.storePath}/flow.db\`; the \`events\` table carries every status change, gate`,
    '  result, wait and decision as JSON in `payload_json`. Transcripts are JSONL under',
    `  \`${digest.storePath}/runs/<run>/nodes/<node>/transcript.jsonl\`, gate logs beside them`,
    '  under `gates/`. The integration worktree’s own gate logs are under `nodes/_integration/`.',
    `- **Maestro’s own log** — \`vinta-ai-maestro logs ${run}\` for this run’s job.`,
    '',
    ...(live === null ? notLive() : powers(run)),
    '',
    'Answer specifically and briefly. Name phases by id, say what your evidence was — the',
    'command you ran, the line you read — and say plainly when you could not find out.',
    '',
    '--- run state ---',
    describe(digest),
  ].join('\n')
}

function notLive(): string[] {
  return [
    '**This run is not live**, so there is nothing to act on: read, and explain. Do not run',
    'the project’s own commands — its tests, gates, linters, `docker compose` — from here:',
    'they would run without any lane’s environment and report on your shell, not the run.',
  ]
}

function powers(run: string): string[] {
  return [
    '--- what you can do ---',
    'Every command below talks to this run’s job with your own token, and every one is',
    'recorded as yours.',
    '',
    `- \`vinta-ai-maestro status ${run}\` — every phase’s state, what it waits on.`,
    `- \`vinta-ai-maestro node context ${run} <phase> "<text>"\` — tell a running agent something`,
    '  (it arrives as from the run coordinator). The cheapest fix for an agent going in circles.',
    `- \`vinta-ai-maestro node redirect ${run} <phase> "<instruction>"\` — interrupt its turn and`,
    '  give it a new instruction.',
    `- \`vinta-ai-maestro node pause|abort|retry ${run} <phase>\` — abort fails the phase and blocks`,
    '  its dependents until a retry; retry runs a failed phase again from a cold start.',
    `- \`vinta-ai-maestro node answer ${run} <phase> "<choice>"\` — answer the question a phase is`,
    '  parked on, when it is one a `--retry-after` timer could answer (a failure’s retry/stop, an',
    '  agent’s own question, a refused merge commit).',
    `- \`vinta-ai-maestro workflow ${run}\` prints the run’s definition as it stands;`,
    `  \`vinta-ai-maestro amend ${run} <file.json>\` applies an edited copy to the live run. A`,
    '  phase that is running cannot take a change to itself until it stops.',
    `- \`vinta-ai-maestro exec ${run} <lane|integration> -- <command>\` — run a command in a lane or`,
    '  the integration worktree with that worktree’s environment (its database, compose project,',
    '  ports). In `integration` it holds the worktree, so no merge moves underneath it. Lane',
    '  names are in `status` and in the run state below.',
    '',
    '--- how to act ---',
    '- Look before you act, and make the smallest change that fixes the cause. Most slow',
    '  phases are slow because the work is hard; doing nothing is often right.',
    '- The project’s own commands — tests, gates, linters, `docker compose` — only ever through',
    '  `exec`, never from the repository root.',
    '- A lane whose phase is running belongs to its agent. Tell the agent (`node context`), or',
    '  pause the phase first, before you change files there. Change the integration worktree',
    '  only through `exec`, which holds it.',
    '- Prefer reversible actions: commit rather than discard; never `git reset --hard`,',
    '  `git clean`, a force-push, or deleting a branch, a lane or a database.',
    '',
    '--- what you may not do ---',
    'These are refused by the run itself (`coordinator_forbidden`); do not look for a way',
    'around them — say what you would have done and why, and the operator decides.',
    '- Change what the plan builds: add or remove phases, change dependencies, briefs, touch',
    '  lists, the base branch, pipelines, chores, a deferred phase’s condition.',
    '- Make a check weaker: drop a gate or a chore from a phase or the defaults, remove or',
    '  rewrite a gate’s command (a gate whose `tuning.allowed_flags` lists a flag may gain it),',
    '  change a judge gate, change `hooks`, allow ungated phases, narrow `gate_scope`, lower',
    '  `wave_gates`.',
    '- Answer a question that is the operator’s — a deferred phase’s start, a plan’s human',
    '  gate, a phase the operator paused — or pause or stop the whole run.',
  ]
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
  /**
   * The model as the run has it *now*, read on every question.
   *
   * A monitor is built once, at job start, from the snapshot as it then was;
   * an amendment that changes the crew's models — the thing an operator does
   * when a model is out of credits — moved the snapshot and not this. The
   * monitor kept thinking with the old model until a pause and resume rebuilt
   * it. Absent, `model` stands for the whole run, as it did before.
   */
  readonly modelFor?: () => string
  /**
   * `defaults.model_fallbacks`. The dearest model is the likeliest to be the
   * one sold as scarce credits, and a monitor that went unavailable the moment
   * they ran out would be gone exactly when a stalled run needs explaining.
   */
  readonly fallbacks?: ModelFallbacks
  /** Where it runs: the repository. It reaches lanes through `exec`. */
  readonly cwd: string
  /**
   * The environment that gives it its powers — the run's API, its own token,
   * the run id and the launcher on `PATH` — read on every turn, because the
   * job only knows them once its daemon is listening. Undefined for a run that
   * is not live, which then gets the read-only brief.
   */
  readonly env?: () => Readonly<Record<string, string>> | undefined
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
  /** One turn at a time: the operator's questions and the wake-ups share a session. */
  #turn: Promise<unknown> = Promise.resolve()
  readonly #options: MonitorOptions
  /** The model it is on now: `options.model`, until that runs out of quota. */
  #model: string
  /** The model the run last declared, so a declaration that moved is told apart from a fallback. */
  #declared: string

  // A field and an assignment rather than the parameter property its neighbours
  // use. Both are fine for the shipped binary, whose shebang asks for
  // `--experimental-transform-types` precisely so that parameter properties
  // work (`cli/bin.ts`). This form additionally loads under the cheaper
  // strip-only mode, which is what an ad-hoc `node src/...` reaches for.
  constructor(options: MonitorOptions) {
    this.#options = options
    this.#model = options.model
    this.#declared = options.model
  }

  /**
   * Takes a re-declared model before a question. A fallback the quota forced
   * is kept across questions, as before; what moves the monitor is the
   * *declaration* changing underneath it — an amendment.
   */
  #refresh(): void {
    const declared = this.#options.modelFor?.() ?? this.#options.model
    if (declared === this.#declared) return
    this.#declared = declared
    this.#model = declared
  }

  /** A spawn down the fallback chain; the model it landed on is kept for the next one. */
  async #spawn(task: AgentTask): Promise<SpawnOutcome> {
    const { outcome, model } = await spawnWithFallbacks(this.#options.adapter, task, this.#options.fallbacks)
    if (outcome.ok) this.#model = model
    return outcome
  }

  /** The session this conversation is continuing, for tests and for the API. */
  get session(): string | null {
    return this.#session
  }

  /** Reported with every answer: the operator should know who is talking. */
  get model(): string {
    return this.#model
  }

  /** Runs `work` after every turn already queued, so two never share the session at once. */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#turn.then(work, work)
    this.#turn = next.catch(() => undefined)
    return next
  }

  /** The operator asks something. */
  async ask(digest: RunDigest, question: string): Promise<string> {
    return await this.#serial(() => this.#converse(digest, '--- the operator asks ---', question, true))
  }

  /**
   * Something woke the coordinator (`coordinator/loop.ts`). The same session
   * the operator talks to, so what it did on one wake-up is what it knows on
   * the next one and what it can tell the operator about.
   */
  async wake(digest: RunDigest, triggerLines: string): Promise<string> {
    return await this.#serial(() =>
      this.#converse(
        digest,
        '--- you were woken because ---',
        [
          triggerLines,
          '',
          'Nobody is waiting for this turn. Find out what is going on; act if, and only if, a',
          'change will help; and end with a short summary for the operator: what you saw, what',
          'you did (the commands), and what you left for them to decide.',
        ].join('\n'),
        false,
      ),
    )
  }

  async #converse(digest: RunDigest, heading: string, text: string, fromOperator: boolean): Promise<string> {
    this.#refresh()
    const env = this.#options.env?.()
    const cold = this.#session === null
    const prompt = cold
      ? `${brief(digest, env === undefined ? null : { runId: digest.runId })}\n\n${heading}\n${text}`
      : ['The run has moved on since your last turn. Here is its state now.', '', describe(digest), '', heading, text].join(
          '\n',
        )

    const outcome = await this.#spawn({
      // Not a node. The id is a label for the journal and the logs, and it
      // cannot collide with a phase because a phase id has no colon in it.
      nodeId: `monitor:${digest.runId}`,
      cwd: this.#options.cwd,
      prompt,
      model: this.#model,
      ...(env === undefined ? {} : { env }),
      ...(cold ? {} : { resumeSessionId: this.#session as string }),
    })

    if (!outcome.ok) {
      // A stale session is the one refusal worth absorbing: the vendor has
      // forgotten a conversation the operator still wants to have, and starting
      // a new one costs a digest rather than an error message.
      if (outcome.kind === 'stale_session' && !cold) {
        this.#session = null
        return await this.#converse(digest, heading, text, fromOperator)
      }
      // The kind is a fixed token. The adapter's message may quote a harness,
      // and this string reaches a browser (§11).
      throw new MonitorUnavailable(outcome.kind)
    }

    // The operator's words, in the record, before the answer exists — so a
    // question whose answer never arrives is still visibly a question that was
    // asked, rather than nothing at all. A wake-up's reason is not anyone's
    // words; the `coordinator_woke` event is its record.
    if (fromOperator) {
      this.#options.journal?.appendTranscript(digest.runId, MONITOR_NODE, {
        type: 'user_message',
        text,
        // The operator's, not the coordinator's — the same §7 rule a phase's
        // transcript follows (`journal/transcript.ts`).
        by: { role: OPERATOR_ROLE },
      })
    }

    // Journalled **as it arrives**, so anything reading the conversation back
    // — this daemon's own endpoint, a reloaded tab — sees a coordinator
    // thinking rather than one that has not answered yet. `thinking` is kept
    // because it is most of what there is to see while a model works.
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
