/**
 * Replaying commands against a permission question, to choose the question
 * and its threshold on evidence instead of by feel (§17.6).
 *
 * The permission judge fails closed, so a question that is too cautious does
 * not look broken — it looks like agents that cannot list a directory, and the
 * cost surfaces as phases that stall. The only way to see it is to put the
 * commands a real run issued to the question and read the scores. That is all
 * this does, through `judgePermission` itself, so what is measured is the exact
 * path a run takes: the same rendering of the call, the same labels, the same
 * fail-closed reading of a refusal.
 *
 * **Commands only, as recorded.** The input is what the agent asked to run —
 * from a run's transcripts or from a file — and nothing is read about what the
 * command printed. A command line that itself carries a secret was already in
 * the transcript; nothing here goes looking for more, and a classifier's own
 * error message is reduced to its kind.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { SystemOneAdapter } from './adapter.ts'
import { judgePermission, PERMISSION_LABELS, type JudgeOutcome } from './judges.ts'

export type PermissionLabel = (typeof PERMISSION_LABELS)[number]

/** One distinct command, and what it should be judged when that is known. */
export interface CalibrationCase {
  readonly tool: string
  /** The call's input exactly as recorded: `{ command }` for `Bash`. */
  readonly input: unknown
  /** The command line, for display and de-duplication. */
  readonly command: string
  readonly expect?: PermissionLabel
  /** How many times the source recorded it. */
  readonly count: number
}

export interface CalibrationResult extends CalibrationCase {
  /** Weight on `safe`, or null when the classifier did not answer. */
  readonly score: number | null
  readonly allowed: boolean
  readonly outcome: JudgeOutcome
}

export interface CalibrationReport {
  readonly threshold: number
  readonly results: readonly CalibrationResult[]
  readonly allowed: number
  readonly refused: number
  /** Refused because the classifier gave no usable answer. Counted in `refused`. */
  readonly unanswered: number
  /** Ten buckets of the score on `safe`, `[0, 0.1)` up to `[0.9, 1]`. */
  readonly histogram: readonly number[]
  readonly mustDeny: number
  readonly mustAllow: number
  /** Labelled cases judged the other way. */
  readonly misclassified: readonly CalibrationResult[]
  readonly highestMustDeny: CalibrationResult | null
  readonly lowestMustAllow: CalibrationResult | null
}

export interface CalibrateOptions {
  readonly adapter: SystemOneAdapter
  readonly question: string
  readonly threshold: number
  /** What the classifier is told the working directory is. */
  readonly cwd: string
  /** How many questions are in flight at once. */
  readonly concurrency?: number
}

export async function calibrate(
  cases: readonly CalibrationCase[],
  options: CalibrateOptions,
): Promise<CalibrationReport> {
  const results: CalibrationResult[] = new Array(cases.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < cases.length) {
      const index = next
      next += 1
      const entry = cases[index] as CalibrationCase
      const decision = await judgePermission(
        { tool: entry.tool, input: entry.input, cwd: options.cwd },
        { tools: [entry.tool], allow_above: options.threshold, question: options.question },
        options.adapter,
      )
      const { judgement } = decision
      results[index] = {
        ...entry,
        score: judgement.outcome === 'answered' ? (judgement.score ?? null) : null,
        allowed: decision.allow,
        outcome: judgement.outcome,
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 4) }, worker))

  const histogram = new Array<number>(10).fill(0)
  for (const result of results) {
    if (result.score === null) continue
    const bucket = Math.min(9, Math.floor(result.score * 10))
    histogram[bucket] = (histogram[bucket] ?? 0) + 1
  }
  const deny = results.filter((result) => result.expect === 'unsafe')
  const allow = results.filter((result) => result.expect === 'safe')
  const scoreOf = (result: CalibrationResult): number => result.score ?? 0
  return {
    threshold: options.threshold,
    results,
    allowed: results.filter((result) => result.allowed).length,
    refused: results.filter((result) => !result.allowed).length,
    unanswered: results.filter((result) => result.outcome !== 'answered').length,
    histogram,
    mustDeny: deny.length,
    mustAllow: allow.length,
    misclassified: [
      ...deny.filter((result) => result.allowed),
      ...allow.filter((result) => !result.allowed),
    ],
    highestMustDeny: deny.reduce<CalibrationResult | null>(
      (best, result) => (best === null || scoreOf(result) > scoreOf(best) ? result : best),
      null,
    ),
    lowestMustAllow: allow.reduce<CalibrationResult | null>(
      (worst, result) => (worst === null || scoreOf(result) < scoreOf(worst) ? result : worst),
      null,
    ),
  }
}

/** Folds repeats into one case each, keeping the first label any of them carried. */
function distinct(
  entries: readonly { tool: string; input: unknown; command: string; expect?: PermissionLabel }[],
): CalibrationCase[] {
  const byKey = new Map<string, CalibrationCase>()
  for (const entry of entries) {
    const key = `${entry.tool}\u0000${entry.command}`
    const seen = byKey.get(key)
    if (seen === undefined) {
      byKey.set(key, { ...entry, count: 1 })
      continue
    }
    byKey.set(key, {
      ...seen,
      count: seen.count + 1,
      ...(seen.expect === undefined && entry.expect !== undefined ? { expect: entry.expect } : {}),
    })
  }
  return [...byKey.values()]
}

/**
 * Every judged call a run's agents made, read from its transcripts.
 *
 * Only `tool_use` events for `tools`, and only their input — never a
 * `tool_result`, which is where a command's output, and so any secret it
 * printed, would be.
 */
export function casesFromRun(runDir: string, tools: readonly string[]): CalibrationCase[] {
  const nodesDir = join(runDir, 'nodes')
  let nodes: string[]
  try {
    nodes = readdirSync(nodesDir).sort()
  } catch {
    return []
  }
  const found: { tool: string; input: unknown; command: string }[] = []
  for (const node of nodes) {
    let text: string
    try {
      text = readFileSync(join(nodesDir, node, 'transcript.jsonl'), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let event: unknown
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event === null || typeof event !== 'object') continue
      const { type, name, input } = event as { type?: unknown; name?: unknown; input?: unknown }
      if (type !== 'tool_use' || typeof name !== 'string' || !tools.includes(name)) continue
      found.push({ tool: name, input, command: commandOf(input) })
    }
  }
  return distinct(found)
}

/**
 * Commands from a file, one per line:
 *
 * - `<command>` — unlabelled;
 * - `safe<TAB><command>` or `unsafe<TAB><command>` — with the expected answer;
 * - a JSON object `{"command": "…", "expect": "safe" | "unsafe"}` — for a
 *   command that spans lines.
 *
 * Blank lines and lines starting with `#` are skipped. A malformed line is an
 * error naming its line number, never its text.
 */
export function casesFromFile(text: string, tool = 'Bash'): CalibrationCase[] {
  const found: { tool: string; input: unknown; command: string; expect?: PermissionLabel }[] = []
  const lines = text.split(/\r?\n/)
  lines.forEach((line, index) => {
    if (line.trim() === '' || line.trimStart().startsWith('#')) return
    if (line.trimStart().startsWith('{')) {
      let parsed: { command?: unknown; expect?: unknown }
      try {
        parsed = JSON.parse(line) as { command?: unknown; expect?: unknown }
      } catch {
        throw new Error(`line ${index + 1}: not valid JSON`)
      }
      if (typeof parsed.command !== 'string' || parsed.command === '') {
        throw new Error(`line ${index + 1}: "command" must be a non-empty string`)
      }
      if (parsed.expect !== undefined && !isLabel(parsed.expect)) {
        throw new Error(`line ${index + 1}: "expect" must be "safe" or "unsafe"`)
      }
      found.push({
        tool,
        input: { command: parsed.command },
        command: parsed.command,
        ...(parsed.expect === undefined ? {} : { expect: parsed.expect }),
      })
      return
    }
    const labelled = /^(safe|unsafe)\t(.+)$/.exec(line)
    const command = labelled === null ? line : (labelled[2] as string)
    found.push({
      tool,
      input: { command },
      command,
      ...(labelled === null ? {} : { expect: labelled[1] as PermissionLabel }),
    })
  })
  return distinct(found)
}

const isLabel = (value: unknown): value is PermissionLabel =>
  value === 'safe' || value === 'unsafe'

function commandOf(input: unknown): string {
  if (input !== null && typeof input === 'object') {
    const command = (input as Record<string, unknown>)['command']
    if (typeof command === 'string') return command
  }
  try {
    return JSON.stringify(input) ?? String(input)
  } catch {
    return '(unserializable)'
  }
}
