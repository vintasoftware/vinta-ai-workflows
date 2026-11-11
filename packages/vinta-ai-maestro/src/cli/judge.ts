/**
 * `vinta-ai-maestro judge calibrate` — the permission judge's question and
 * threshold, measured against commands agents actually ran.
 *
 * The judge fails closed, so a question that refuses routine work never looks
 * broken; it looks like a run that stalls. This puts a run's recorded `Bash`
 * calls — or a file of commands, each optionally labelled with the answer it
 * must get — to a candidate question at a candidate threshold, and reports what
 * would have been allowed, what refused, how the scores spread, which labelled
 * commands came out the wrong way, and how close the most dangerous must-deny
 * command came to the line. Nothing is run: only the classifier is asked.
 *
 * Commands are printed as recorded and nothing else is: not their output, which
 * the transcripts' `tool_result` events hold and this never reads, and not a
 * classifier's error text, which is reduced to its kind.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { calibrate, casesFromFile, casesFromRun, type CalibrationReport, type CalibrationResult } from '../system-one/calibrate.ts'
import { loadSystemOne, SystemOneConfigError, type SystemOne } from '../system-one/config.ts'
import { PERMISSION_QUESTION } from '../system-one/judges.ts'
import { FAILED, OK, USAGE, type Io } from './io.ts'
import { laneRootFor, runsRootFor } from './paths.ts'

export const JUDGE_USAGE = `usage: vinta-ai-maestro judge calibrate --system-one <config.json>
                                         (--run <run-id> | --commands <file>)
                                         [--question <text> | --question-file <file>]
                                         [--threshold <p>] [--repo <dir>] [--json]

  Replays commands against the permission judge's question (--permission
  judged) and reports, at the threshold: how many would be allowed and
  refused, the distribution of scores on "safe", every labelled command judged
  the wrong way, and the highest-scoring must-deny command. Nothing is run;
  only the classifier is asked. Exits 1 when a labelled command is misjudged.

  --system-one <file>   The classifier, as for \`run\`. Its permission judge's
                        question, threshold and tools are the defaults below.
  --run <run-id>        Every judged tool call the run's agents made, from its
                        transcripts, once per distinct command.
  --commands <file>     One command per line. Prefix "safe<TAB>" or
                        "unsafe<TAB>" to say what it must be judged; a line
                        may also be {"command": "…", "expect": "unsafe"}.
                        Blank lines and # comments are skipped.
  --question <text>     The question to try. Default: the config's, else the
  --question-file <f>   shipped one.
  --threshold <p>       allow_above to try, 0–1. Default: the config's, else 0.9.
  --repo <dir>          The project. Defaults to the current directory.
  --json                The report as JSON, every command with its score.

  Commands are printed as recorded, never their output.`

export interface JudgeDeps {
  /** The classifier, instead of loading --system-one. For tests. */
  readonly systemOne?: SystemOne
}

export async function judgeCommand(
  argv: readonly string[],
  io: Io,
  deps: JudgeDeps = {},
): Promise<number> {
  const [sub, ...rest] = argv
  if (sub !== 'calibrate') {
    io.err(JUDGE_USAGE)
    return USAGE
  }
  let parsed
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        'system-one': { type: 'string' },
        run: { type: 'string' },
        commands: { type: 'string' },
        question: { type: 'string' },
        'question-file': { type: 'string' },
        threshold: { type: 'string' },
        repo: { type: 'string' },
        json: { type: 'boolean' },
      },
      allowPositionals: false,
    })
  } catch {
    io.err(JUDGE_USAGE)
    return USAGE
  }
  const values = parsed.values
  const sources = [values.run, values.commands].filter((value) => value !== undefined)
  const questions = [values.question, values['question-file']].filter((value) => value !== undefined)
  if (sources.length !== 1 || questions.length > 1) {
    io.err(JUDGE_USAGE)
    return USAGE
  }
  if (deps.systemOne === undefined && values['system-one'] === undefined) {
    io.err('vinta-ai-maestro: judge calibrate needs --system-one <config.json>: the classifier to ask.')
    return USAGE
  }

  let systemOne: SystemOne
  try {
    systemOne = deps.systemOne ?? loadSystemOne(resolve(values['system-one'] as string))
  } catch (error) {
    io.err(`vinta-ai-maestro: ${error instanceof SystemOneConfigError ? error.message : 'cannot load --system-one'}`)
    return FAILED
  }
  const judge = systemOne.judges.permission

  let threshold = judge?.allow_above ?? 0.9
  if (values.threshold !== undefined) {
    threshold = Number(values.threshold)
    if (values.threshold.trim() === '' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      io.err('vinta-ai-maestro: --threshold must be a number from 0 to 1.')
      return USAGE
    }
  }

  let question: string
  let questionFrom: string
  if (values.question !== undefined) {
    question = values.question
    questionFrom = '--question'
  } else if (values['question-file'] !== undefined) {
    try {
      question = readFileSync(resolve(values['question-file']), 'utf8').trim()
    } catch {
      io.err(`vinta-ai-maestro: cannot read --question-file ${values['question-file']}`)
      return FAILED
    }
    questionFrom = values['question-file']
  } else if (judge?.question !== undefined) {
    question = judge.question
    questionFrom = 'the --system-one config'
  } else {
    question = PERMISSION_QUESTION
    questionFrom = 'the shipped default'
  }

  const repoPath = resolve(values.repo ?? process.cwd())
  let cases
  let source: string
  if (values.run !== undefined) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(values.run)) {
      io.err(`vinta-ai-maestro: refusing "${values.run}" — a run id is a single name, not a path.`)
      return USAGE
    }
    cases = casesFromRun(join(runsRootFor(repoPath), values.run), judge?.tools ?? ['Bash'])
    source = `run ${values.run}`
  } else {
    let text: string
    try {
      text = readFileSync(resolve(values.commands as string), 'utf8')
    } catch {
      io.err(`vinta-ai-maestro: cannot read --commands ${values.commands}`)
      return FAILED
    }
    try {
      cases = casesFromFile(text)
    } catch (error) {
      io.err(`vinta-ai-maestro: ${values.commands}: ${(error as Error).message}`)
      return USAGE
    }
    source = values.commands as string
  }
  if (cases.length === 0) {
    io.err(`vinta-ai-maestro: no commands to replay in ${source}.`)
    return FAILED
  }

  const report = await calibrate(cases, {
    adapter: systemOne.adapter,
    question,
    threshold,
    // A lane's path, so "outside the worktree" means what it means in a run.
    cwd: join(laneRootFor(repoPath), `${values.run ?? 'calibrate'}-lane-1`),
  })

  if (values.json === true) {
    io.out(JSON.stringify({ source, question_from: questionFrom, ...report }, null, 2))
  } else {
    printReport(report, source, questionFrom, io)
  }
  return report.misclassified.length > 0 ? FAILED : OK
}

/** One line per command, so a multi-line command cannot pass for several. */
const oneLine = (command: string): string => command.replace(/\r?\n/g, ' ⏎ ')

const score = (result: CalibrationResult): string =>
  result.score === null ? ` ${result.outcome.slice(0, 4)}` : result.score.toFixed(2).padStart(5)

function printReport(report: CalibrationReport, source: string, questionFrom: string, io: Io): void {
  const total = report.results.length
  io.out(`judge calibrate — ${total} distinct commands from ${source}, threshold ${report.threshold}`)
  io.out(`question: ${questionFrom}`)
  io.out('')
  io.out(`  allowed  ${report.allowed}`)
  io.out(
    `  refused  ${report.refused}${report.unanswered === 0 ? '' : `  (${report.unanswered} with no answer from the classifier)`}`,
  )
  io.out('')
  io.out('score on "safe":')
  const widest = Math.max(1, ...report.histogram)
  report.histogram.forEach((count, bucket) => {
    const range = `${(bucket / 10).toFixed(1)}–${((bucket + 1) / 10).toFixed(1)}`
    const bar = '█'.repeat(Math.round((count / widest) * 30))
    io.out(`  ${range}  ${bar}${bar === '' ? '' : ' '}${count}`)
  })

  if (report.mustDeny + report.mustAllow > 0) {
    io.out('')
    io.out(
      `labelled: ${report.mustDeny} must-deny, ${report.mustAllow} must-allow — ` +
        `${report.misclassified.length} misjudged`,
    )
    for (const result of report.misclassified) {
      const how = result.allowed ? 'allowed, must deny ' : 'refused, must allow'
      io.out(`  ${how}  ${score(result)}  ${oneLine(result.command)}`)
    }
    if (report.highestMustDeny !== null) {
      const result = report.highestMustDeny
      io.out(`  highest must-deny    ${score(result)}  ${oneLine(result.command)}`)
    }
    if (report.lowestMustAllow !== null) {
      const result = report.lowestMustAllow
      io.out(`  lowest must-allow    ${score(result)}  ${oneLine(result.command)}`)
    }
  }

  const refused = report.results
    .filter((result) => !result.allowed && result.expect === undefined)
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
  if (refused.length > 0) {
    io.out('')
    io.out('refused, unlabelled — highest score first:')
    for (const result of refused) io.out(`  ${score(result)}  ${oneLine(result.command)}`)
  }
}
