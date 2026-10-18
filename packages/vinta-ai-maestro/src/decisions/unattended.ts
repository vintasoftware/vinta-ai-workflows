/**
 * What the run decided while nobody was watching: every question a
 * `--retry-after` timer or the run coordinator answered, and every operation
 * the coordinator made on its own.
 *
 * An observed run answered 79 of its 125 questions this way — 22 review loops
 * stopped, agents' design questions given their first option, one of them
 * after sixty seconds — and one of those answers added a database migration.
 * Each was journalled, and none was anywhere a person would look: the operator
 * came back to a finished run whose PR said nothing about choices nobody made.
 * So the list is folded out of the journal here, once, and `status`, the plan
 * PR body, the post-mortem and the run view all render this one fold.
 *
 * The journal holds identifiers: a question's effect id, its kind, the plan's
 * question text and the answer's value. What an agent's question was *about*
 * is the agent's prose and lives in the phase's `decisions.jsonl` (§11), so a
 * caller that may show it passes `AgentDetails` read from there.
 */
import type { HumanAnswer, HumanQuestionKind, OperatorOp, StoredEvent } from '../journal/events.ts'
import type { Decision } from './decisions.ts'

/** What kind of question it was, from the effect id the scheduler gave it. */
export type UnattendedCategory = 'retry' | 'agent_question' | 'plan_question' | 'merge_commit' | 'other'

export interface UnattendedAnswer {
  readonly type: 'answer'
  readonly at: number
  readonly node: string
  readonly effect: string
  readonly category: UnattendedCategory
  /** A `--retry-after` timer (`unattended`) or the run coordinator. */
  readonly by: 'unattended' | 'coordinator'
  readonly kind: HumanQuestionKind | null
  /** The question as journalled: the plan's text, or a fixed sentence. */
  readonly question: string | null
  readonly answer: HumanAnswer
  /** How long the question stood before it was answered. */
  readonly waitedMs: number | null
}

export type CoordinatorActionKind = Exclude<OperatorOp, 'resume'> | 'amend' | 'exec' | 'gate_cache_invalidate'

export interface CoordinatorAction {
  readonly type: 'action'
  readonly at: number
  readonly node: string | null
  readonly action: CoordinatorActionKind
  /** An amendment's targets, an `exec` target or a gate id. */
  readonly target?: string
  /** Steering text: the coordinator's own reason, given to the agent. */
  readonly text?: string
  /** An `exec` that exited non-zero. */
  readonly failed?: true
}

export type UnattendedDecision = UnattendedAnswer | CoordinatorAction

/** One answered agent question, as the phase's `decisions.jsonl` records it. */
export interface AgentDetail {
  readonly header: string
  readonly answer: string
}

/** The agent's own words for a question, by effect id. */
export type AgentDetails = (effect: string) => readonly AgentDetail[]

export function categoryOf(effect: string): UnattendedCategory {
  if (effect.startsWith('retry:')) return 'retry'
  if (effect.startsWith('agent-question:')) return 'agent_question'
  if (effect.startsWith('host:')) return 'merge_commit'
  if (/^(operator-pause|login|deferred):/.test(effect)) return 'other'
  return 'plan_question'
}

/** The fold, oldest first. */
export function unattendedDecisions(events: readonly StoredEvent[]): UnattendedDecision[] {
  const asked = new Map<string, { readonly at: number; readonly kind: HumanQuestionKind; readonly question: string }>()
  const found: UnattendedDecision[] = []
  for (const event of events) {
    switch (event.type) {
      case 'human_question':
        asked.set(event.payload.effect_id, { at: event.ts, kind: event.payload.kind, question: event.payload.question })
        continue
      case 'human_answered': {
        const { effect_id: effect, unattended, by, answer } = event.payload
        const question = asked.get(effect)
        if (by !== 'coordinator' && unattended !== true) continue
        found.push({
          type: 'answer',
          at: event.ts,
          node: event.nodeId,
          effect,
          category: categoryOf(effect),
          by: by === 'coordinator' ? 'coordinator' : 'unattended',
          kind: question?.kind ?? null,
          question: question?.question ?? null,
          answer,
          waitedMs: question === undefined ? null : event.ts - question.at,
        })
        continue
      }
      case 'node_operation': {
        const { op, by, text, delivery } = event.payload
        // `delivered` is the later half of a `queued` row, and `ignored` did nothing.
        if (by !== 'coordinator' || op === 'resume' || delivery === 'delivered' || delivery === 'ignored') continue
        found.push({
          type: 'action',
          at: event.ts,
          node: event.nodeId,
          action: op,
          ...(text === undefined ? {} : { text }),
        })
        continue
      }
      case 'workflow_amended':
        if (event.payload.author !== 'coordinator' && event.payload.author !== 'monitor') continue
        found.push({
          type: 'action',
          at: event.ts,
          node: null,
          action: 'amend',
          ...(event.payload.targets === undefined ? {} : { target: event.payload.targets.join(', ') }),
        })
        continue
      case 'workspace_exec':
        if (event.payload.by !== 'coordinator') continue
        found.push({
          type: 'action',
          at: event.ts,
          node: null,
          action: 'exec',
          target: event.payload.target,
          ...(event.payload.exit_code === 0 ? {} : { failed: true as const }),
        })
        continue
      case 'gate_cache_invalidated':
        if (event.payload.by !== 'coordinator') continue
        found.push({ type: 'action', at: event.ts, node: null, action: 'gate_cache_invalidate', target: event.payload.gate })
        continue
      default:
        continue
    }
  }
  return found
}

/**
 * `AgentDetails` over one phase's decisions: each answered question's header
 * and the answer line, joined on the effect id the scheduler stamps on them.
 * A decision the list kept only once — the same question asked again and
 * answered the same way — has no effect for the repeat, which shows no detail.
 */
export function agentDetailsFrom(decisions: readonly Decision[]): AgentDetails {
  const byEffect = new Map<string, AgentDetail[]>()
  for (const entry of decisions) {
    if (entry.kind !== 'answer' || entry.effect === undefined) continue
    const [first = '', ...rest] = entry.text.split('\n')
    const header = first.split(' — ')[0]?.trim() ?? ''
    const answer = rest
      .find((line) => line.startsWith('Answer: '))
      ?.slice('Answer: '.length)
      .trim()
    if (header === '' || answer === undefined) continue
    const list = byEffect.get(entry.effect) ?? []
    list.push({ header, answer })
    byEffect.set(entry.effect, list)
  }
  return (effect) => byEffect.get(effect) ?? []
}

/**
 * `AgentDetails` for a whole run, reading each phase's decisions once, when
 * one of its questions is first described. The node is in the effect id
 * (`agent-question:<node>:<n>`).
 */
export function runAgentDetails(
  source: { decisions(runId: string, nodeId: string): readonly Decision[] },
  runId: string,
): AgentDetails {
  const byNode = new Map<string, AgentDetails>()
  return (effect) => {
    const node = effect.split(':')[1] ?? ''
    let found = byNode.get(node)
    if (found === undefined) {
      found = agentDetailsFrom(source.decisions(runId, node))
      byNode.set(node, found)
    }
    return found(effect)
  }
}

export interface DescribeOptions {
  readonly details?: AgentDetails
  /**
   * Leave out the coordinator's steering text: for a body published to a
   * forge, where only identifiers, plan text and the agents' short labels go.
   */
  readonly published?: boolean
}

/**
 * One line for a person: `p12 · unattended after 30m 00s · agent question →
 * Migration: Add published_at (Recommended)`.
 */
export function describeUnattended(entry: UnattendedDecision, options: DescribeOptions = {}): string {
  if (entry.type === 'action') {
    const where = entry.node ?? 'run'
    const what = ACTION_LABEL[entry.action]
    const target = entry.target === undefined ? '' : ` ${entry.target}`
    const failed = entry.failed === true ? ' (failed)' : ''
    const text = entry.text === undefined || options.published === true ? '' : ` — "${clip(entry.text, 120)}"`
    return `${where} · coordinator · ${what}${target}${failed}${text}`
  }
  const who =
    entry.by === 'coordinator'
      ? 'coordinator'
      : `unattended${entry.waitedMs === null ? '' : ` after ${waited(entry.waitedMs)}`}`
  return `${entry.node} · ${who} · ${answerText(entry, options.details)}`
}

function answerText(entry: UnattendedAnswer, details: AgentDetails | undefined): string {
  switch (entry.category) {
    case 'retry':
      return entry.answer === 'retry' ? 'failed attempt → retried' : `failed attempt → ${String(entry.answer)}`
    case 'merge_commit':
      return `refused merge commit → ${String(entry.answer)}`
    case 'agent_question': {
      const found = details?.(entry.effect) ?? []
      if (found.length > 0) {
        return `agent question → ${found.map((detail) => `${clip(detail.header, 40)}: ${clip(detail.answer, 100)}`).join('; ')}`
      }
      return `agent question → ${optionsOf(entry.answer)}`
    }
    default: {
      const question = entry.question === null ? 'question' : `"${clip(entry.question, 100)}"`
      return `${question} → ${String(entry.answer)}`
    }
  }
}

/** `option 1; option 2` from an encoded agent answer, or the raw value. */
function optionsOf(answer: HumanAnswer): string {
  if (typeof answer === 'string') {
    try {
      const parsed = JSON.parse(answer) as unknown
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => {
            const selected = (item as { selected?: unknown }).selected
            return Array.isArray(selected) && selected.length > 0
              ? selected.map((choice) => `option ${Number(choice) + 1}`).join(' + ')
              : 'free text'
          })
          .join('; ')
      }
    } catch {
      // Not an encoded answer: shown as it is.
    }
  }
  return String(answer)
}

const ACTION_LABEL: Record<CoordinatorActionKind, string> = {
  add_context: 'added context',
  redirect: 'redirected',
  pause: 'paused',
  abort: 'aborted',
  fresh: 'dropped the session',
  amend: 'amended',
  exec: 'ran a command in',
  gate_cache_invalidate: 'invalidated the gate cache for',
}

function clip(text: string, limit: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

/** `30m 00s`, `1h 05m`, `45s`. */
function waited(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}
