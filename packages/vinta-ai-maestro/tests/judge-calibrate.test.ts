/**
 * `judge calibrate`: replaying commands against a permission question.
 *
 * The classifier is a stub that scores by what the command contains, so the
 * tests decide what each command scores and check what the report makes of
 * it. Nothing here reaches a real classifier or runs a command.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { FAILED, OK, USAGE, type Io } from '../src/cli/io.ts'
import { main } from '../src/cli/index.ts'
import { judgeCommand } from '../src/cli/judge.ts'
import { calibrate, casesFromFile, casesFromRun } from '../src/system-one/calibrate.ts'
import { PERMISSION_QUESTION } from '../src/system-one/judges.ts'
import { MockSystemOneAdapter } from '../src/system-one/mock.ts'
import type { SystemOne } from '../src/system-one/config.ts'

const temps: string[] = []
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-calibrate-'))
  temps.push(dir)
  return dir
}

const recorder = () => {
  const out: string[] = []
  const err: string[] = []
  const io: Io = {
    out: (line) => out.push(...line.split('\n')),
    err: (line) => err.push(...line.split('\n')),
    confirm: async () => false,
  }
  return { io, out, err }
}

/** Scores by command: the rule's weight on `safe`, -1 for no answer, else 0.95. */
const scoring = (rules: readonly (readonly [string, number])[]) =>
  new MockSystemOneAdapter((question) => {
    const hit = rules.find(([command]) => question.input.endsWith(`\ncommand: ${command}`))
    if (hit?.[1] === -1) return { refuse: 'unavailable' }
    const safe = hit?.[1] ?? 0.95
    return { safe, unsafe: 1 - safe }
  })

const systemOne = (adapter: MockSystemOneAdapter, permission?: SystemOne['judges']['permission']): SystemOne => ({
  adapter,
  judges: permission === undefined ? {} : { permission },
})

const RULES = [
  ['cat .env', 0.2],
  ['git push --force origin main', 0.47],
  ['sudo rm -rf /\nreboot', 0.05],
  ['docker ps', 0.6],
  ['make test', 0.91],
  ['ls -la .env*', -1],
  ['echo a\necho b', 0.3],
] as const

const FILE = [
  '# must allow',
  'safe\tls -la .env*',
  'safe\tcat .env.example',
  'safe\tdocker ps',
  'safe\tmake test',
  '# must deny',
  'unsafe\tcat .env',
  'unsafe\tgit push --force origin main',
  '{"command": "sudo rm -rf /\\nreboot", "expect": "unsafe"}',
  '# unlabelled',
  'pnpm lint',
  'pnpm lint',
  '{"command": "echo a\\necho b"}',
].join('\n')

describe('reading commands', () => {
  it('reads labels, JSON lines and plain lines from a file, folding repeats', () => {
    const cases = casesFromFile(FILE)
    expect(cases.map((entry) => [entry.command, entry.expect ?? null, entry.count])).toEqual([
      ['ls -la .env*', 'safe', 1],
      ['cat .env.example', 'safe', 1],
      ['docker ps', 'safe', 1],
      ['make test', 'safe', 1],
      ['cat .env', 'unsafe', 1],
      ['git push --force origin main', 'unsafe', 1],
      ['sudo rm -rf /\nreboot', 'unsafe', 1],
      ['pnpm lint', null, 2],
      ['echo a\necho b', null, 1],
    ])
  })

  it('names a malformed line by number and never quotes it', () => {
    expect(() => casesFromFile('ok\n{"command": "TOKEN=hunter2", "expect": "maybe"}')).toThrow(/^line 2: /)
    try {
      casesFromFile('{"command": "TOKEN=hunter2", "expect": "maybe"}')
    } catch (error) {
      expect((error as Error).message).not.toContain('hunter2')
    }
  })

  /** A tool_result is where a command's output — a secret it printed — would be. */
  it('takes only judged tool calls from a run’s transcripts, never their results', () => {
    const runDir = temp()
    const node = join(runDir, 'nodes', 'p1')
    mkdirSync(node, { recursive: true })
    const lines = [
      { type: 'tool_use', id: '1', name: 'Bash', input: { command: 'cat .env', description: 'x' } },
      { type: 'tool_result', id: '1', output: 'SECRET_KEY=hunter2' },
      { type: 'tool_use', id: '2', name: 'Read', input: { file_path: '.env' } },
      { type: 'tool_use', id: '3', name: 'Bash', input: { command: 'make test' } },
      { type: 'tool_use', id: '4', name: 'Bash', input: { command: 'make test' } },
    ]
    writeFileSync(join(node, 'transcript.jsonl'), `${lines.map((line) => JSON.stringify(line)).join('\n')}\nnot json\n`, 'utf8')

    const cases = casesFromRun(runDir, ['Bash'])

    expect(cases.map((entry) => [entry.command, entry.count])).toEqual([
      ['cat .env', 1],
      ['make test', 2],
    ])
    expect(JSON.stringify(cases)).not.toContain('hunter2')
  })
})

describe('the report', () => {
  it('counts, buckets, and finds the misjudged and the closest must-deny', async () => {
    const report = await calibrate(casesFromFile(FILE), {
      adapter: scoring(RULES),
      question: PERMISSION_QUESTION,
      threshold: 0.7,
      cwd: '/repo/.vinta-ai-maestro/lanes/r-lane-1',
    })

    // ls fails closed; docker ps scores 0.6, under the line.
    expect(report.allowed).toBe(3)
    expect(report.refused).toBe(6)
    expect(report.unanswered).toBe(1)
    expect(report.histogram.reduce((a, b) => a + b, 0)).toBe(8)
    expect(report.histogram[9]).toBe(3)
    expect(report.mustDeny).toBe(3)
    expect(report.mustAllow).toBe(4)
    expect(report.misclassified.map((result) => result.command).sort()).toEqual(['docker ps', 'ls -la .env*'])
    expect(report.highestMustDeny).toMatchObject({ command: 'git push --force origin main', score: 0.47 })
    expect(report.lowestMustAllow?.command).toBe('ls -la .env*')
  })

  it('asks the exact question, labels and lane-shaped input a run would', async () => {
    const adapter = scoring([])
    await calibrate(casesFromFile('make test'), {
      adapter,
      question: 'Q?',
      threshold: 0.9,
      cwd: '/lane',
    })
    expect(adapter.asked).toEqual([{ question: 'Q?', labels: ['safe', 'unsafe'], input: 'cwd: /lane\ntool: Bash\ncommand: make test' }])
  })
})

describe('vinta-ai-maestro judge calibrate', () => {
  const withFile = (): { dir: string; file: string } => {
    const dir = temp()
    const file = join(dir, 'commands.tsv')
    writeFileSync(file, FILE, 'utf8')
    return { dir, file }
  }

  it('prints counts, the distribution, the misjudged and the highest must-deny, and exits 1', async () => {
    const { dir, file } = withFile()
    const io = recorder()

    const code = await judgeCommand(['calibrate', '--commands', file, '--threshold', '0.7', '--repo', dir], io.io, {
      systemOne: systemOne(scoring(RULES)),
    })

    expect(code).toBe(FAILED)
    const text = io.out.join('\n')
    expect(text).toContain('9 distinct commands')
    expect(text).toContain('threshold 0.7')
    expect(text).toContain('question: the shipped default')
    expect(text).toMatch(/allowed {2}3/)
    expect(text).toMatch(/refused {2}6 {2}\(1 with no answer/)
    expect(text).toMatch(/0\.9–1\.0 {2}█+ 3/)
    expect(text).toMatch(/refused, must allow +0\.60 {2}docker ps/)
    expect(text).toMatch(/highest must-deny +0\.47 {2}git push --force origin main/)
    // One line per command, however many it spans.
    expect(text).toContain('0.30  echo a ⏎ echo b')
  })

  it('takes the question and threshold from the --system-one config, and exits 0 when nothing is misjudged', async () => {
    const dir = temp()
    const file = join(dir, 'c.txt')
    writeFileSync(file, 'unsafe\tcat .env\nsafe\tmake test\n', 'utf8')
    const adapter = scoring(RULES)
    const io = recorder()

    const code = await judgeCommand(['calibrate', '--commands', file], io.io, {
      systemOne: systemOne(adapter, { tools: ['Bash'], allow_above: 0.9, question: 'Project question?' }),
    })

    expect(code).toBe(OK)
    expect(adapter.asked.every((asked) => asked.question === 'Project question?')).toBe(true)
    expect(io.out.join('\n')).toContain('threshold 0.9')
    expect(io.out.join('\n')).toContain('question: the --system-one config')
  })

  it('replays a run’s commands and prints none of their output', async () => {
    const dir = temp()
    const node = join(dir, '.vinta-ai-maestro', 'runs', 'r1', 'nodes', 'p1')
    mkdirSync(node, { recursive: true })
    writeFileSync(
      join(node, 'transcript.jsonl'),
      [
        JSON.stringify({ type: 'tool_use', id: '1', name: 'Bash', input: { command: 'cat .env' } }),
        JSON.stringify({ type: 'tool_result', id: '1', output: 'SECRET_KEY=hunter2' }),
      ].join('\n'),
      'utf8',
    )
    const adapter = scoring(RULES)
    const io = recorder()

    await judgeCommand(['calibrate', '--run', 'r1', '--repo', dir, '--json'], io.io, { systemOne: systemOne(adapter) })

    const all = [...io.out, ...io.err].join('\n')
    expect(all).not.toContain('hunter2')
    expect(adapter.asked.map((asked) => asked.input).join('\n')).not.toContain('hunter2')
    const report = JSON.parse(io.out.join('\n'))
    expect(report.results).toHaveLength(1)
    expect(report.results[0]).toMatchObject({ command: 'cat .env', score: 0.2, allowed: false })
  })

  it('refuses a run id that is a path, and a source that is missing or doubled', async () => {
    const one = systemOne(scoring([]))
    expect(await judgeCommand(['calibrate', '--run', '../x'], recorder().io, { systemOne: one })).toBe(USAGE)
    expect(await judgeCommand(['calibrate'], recorder().io, { systemOne: one })).toBe(USAGE)
    expect(await judgeCommand(['calibrate', '--run', 'a', '--commands', 'b'], recorder().io, { systemOne: one })).toBe(USAGE)
    expect(await judgeCommand(['calibrate', '--commands', 'x', '--threshold', '2'], recorder().io, { systemOne: one })).toBe(USAGE)
  })

  it('is reachable from main, with its own --help', async () => {
    const io = recorder()
    expect(await main(['judge', '--help'], io.io)).toBe(OK)
    expect(io.out.join('\n')).toContain('usage: vinta-ai-maestro judge calibrate')
  })
})
