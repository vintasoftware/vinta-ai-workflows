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
import type { HarnessAdapter } from '../harness/adapter.ts'
import type { NodeStatus } from '../journal/events.ts'
import type { Journal } from '../journal/journal.ts'
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
}

export interface RunDigest {
  readonly runId: string
  readonly workflowId: string
  readonly status: string
  readonly baseBranch: string
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

  const names = new Map(workflow.nodes.map((node) => [node.id, node.name]))
  const failures = failureReasons(journal, runId)

  const nodes = journal.nodes(runId).map((node): NodeDigest => {
    const entries = journal.tailTranscript(runId, node.node_id, SCAN_LIMIT) as readonly unknown[]
    return {
      nodeId: node.node_id,
      name: names.get(node.node_id) ?? node.node_id,
      status: node.status,
      wave: node.wave,
      harness: node.harness,
      failure: failures.get(node.node_id) ?? null,
      question: journal.pendingQuestion(runId, node.node_id)?.question.question ?? null,
      trouble: troubleOf(entries),
      lastWord: lastWordOf(entries),
    }
  })

  return {
    runId: row.id,
    workflowId: row.workflow_id,
    status: row.status,
    baseBranch: row.base_branch,
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
    '',
  ]
  for (const node of digest.nodes) {
    lines.push(`## ${node.nodeId} — ${node.name}`)
    lines.push(`status: ${node.status} · wave ${node.wave} · harness ${node.harness}`)
    if (node.failure !== null) lines.push(`failed because: ${node.failure}`)
    if (node.question !== null) lines.push(`waiting on the operator: ${node.question}`)
    for (const line of node.trouble) lines.push(`- ${line}`)
    if (node.lastWord !== null) lines.push(`last said: ${node.lastWord}`)
    lines.push('')
  }
  return lines.join('\n')
}

/** The monitor's standing instructions — its brief, not the operator's question. */
export function brief(digest: RunDigest): string {
  return [
    'You are the monitor for a parallel implementation run. Several coding agents are',
    'working in isolated git worktrees on phases of one plan. You do not write code and',
    'you hold no permissions.',
    '',
    'Your job is to answer the operator’s questions about this run: what is happening,',
    'what is blocked, why something failed, and what it would take to move forward.',
    '',
    'Answer from the run state below. Be specific and brief — name phases by their id,',
    'say what your evidence is, and say plainly when the state does not tell you',
    'something rather than filling the gap. If a phase is waiting on the operator,',
    'explain what the question means and what each answer would do; the operator',
    'decides, not you.',
    '',
    '--- run state ---',
    describe(digest),
  ].join('\n')
}

export interface MonitorOptions {
  readonly adapter: HarnessAdapter
  /** The dearest model on the roster: this is the reasoning, not the typing. */
  readonly model: string
  /** Where it runs. The repository, not a lane — it writes nothing. */
  readonly cwd: string
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

  constructor(private readonly options: MonitorOptions) {}

  /** The session this conversation is continuing, for tests and for the API. */
  get session(): string | null {
    return this.#session
  }

  /** Reported with every answer: the operator should know who is talking. */
  get model(): string {
    return this.options.model
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

    const outcome = await this.options.adapter.spawn({
      // Not a node. The id is a label for the journal and the logs, and it
      // cannot collide with a phase because a phase id has no colon in it.
      nodeId: `monitor:${digest.runId}`,
      cwd: this.options.cwd,
      prompt,
      model: this.options.model,
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

    const said: string[] = []
    for await (const event of outcome.session.events) {
      if (event.type === 'session_started') this.#session = event.sessionId
      if (event.type === 'assistant_text') said.push(event.text)
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
  constructor(readonly kind: string) {
    super(`monitor unavailable: ${kind}`)
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
