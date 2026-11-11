/**
 * The daemon side of `--permission judged` (§17.6): one judge per run, behind
 * the endpoint a judged session's hook calls.
 *
 * **Decisions are remembered for the run.** An agent runs the same handful of
 * commands dozens of times a phase — the test runner, the linter, `git status`
 * — and asking the classifier each time spends its latency on a question it
 * has already answered. The memo is keyed on the lane and a hash of the call,
 * holds only decisions the classifier actually *made*, and is bounded. A
 * denial for want of an answer is not remembered: the next ask may reach it.
 *
 * Every judgement is journalled as `system_one_judged` — tool name, decision,
 * score — and a remembered one is not, because nothing was asked.
 */
import { createHash } from 'node:crypto'
import type { PermissionJudgePort } from '../daemon/control.ts'
import type { Journal } from '../journal/journal.ts'
import type { SystemOne } from './config.ts'
import { judgePermission } from './judges.ts'

const MEMO_LIMIT = 512

export interface PermissionJudgeOptions {
  readonly systemOne: SystemOne
  readonly journal: Pick<Journal, 'append'>
  readonly runId: string
}

export function createPermissionJudge(options: PermissionJudgeOptions): PermissionJudgePort | undefined {
  const config = options.systemOne.judges.permission
  if (config === undefined) return undefined
  const { adapter } = options.systemOne
  const memo = new Map<string, { readonly allow: boolean; readonly reason: string }>()

  return {
    async judge(request) {
      const key = createHash('sha256')
        .update(JSON.stringify([request.cwd, request.tool, request.input]))
        .digest('hex')
      const known = memo.get(key)
      if (known !== undefined) return known

      const decided = await judgePermission(
        { tool: request.tool, input: request.input, cwd: request.cwd },
        config,
        adapter,
      )
      options.journal.append({
        runId: options.runId,
        nodeId: request.holderNode,
        type: 'system_one_judged',
        payload: {
          judge: 'permission',
          subject: request.tool,
          adapter: adapter.id,
          outcome: decided.judgement.outcome,
          decision: decided.judgement.decision,
          ...(decided.judgement.top === undefined ? {} : { top: decided.judgement.top }),
          ...(decided.judgement.score === undefined ? {} : { score: decided.judgement.score }),
          ...(decided.judgement.latencyMs === undefined ? {} : { latency_ms: decided.judgement.latencyMs }),
        },
      })
      const answer = { allow: decided.allow, reason: decided.reason }
      if (decided.judgement.outcome === 'answered') {
        if (memo.size >= MEMO_LIMIT) memo.delete(memo.keys().next().value as string)
        memo.set(key, answer)
      }
      return answer
    },
  }
}
