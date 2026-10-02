/**
 * System One (§17): the adapter seam, the shipped adapters, the operator's
 * config, the judges, and `--permission judged` end to end up to the daemon.
 *
 * The executor's use of judge gates and gate triage is covered beside the rest
 * of `run_gate`, in `executor.test.ts`.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { checkSystemOne } from '../src/doctor/index.ts'
import type { AgentTask } from '../src/harness/adapter.ts'
import { ClaudeCodeAdapter } from '../src/harness/claude-code.ts'
import { openJournal } from '../src/journal/journal.ts'
import { clearRedactions, sanitize } from '../src/log/index.ts'
import { MAESTRO_NODE_ENV, MAESTRO_RUN_ENV, MAESTRO_TOKEN_ENV, MAESTRO_URL_ENV } from '../src/resources/agent-leases.ts'
import {
  CommandSystemOneAdapter,
  HttpSystemOneAdapter,
  MockSystemOneAdapter,
  PERMISSION_QUESTION,
  SystemOneConfigError,
  judgePermission,
  loadSystemOne,
  normalizeScores,
  registerSystemOneAdapter,
  runJudgeGate,
} from '../src/system-one/index.ts'
import { judgeHookCommandMain } from '../src/system-one/hook.ts'
import { createPermissionJudge } from '../src/system-one/permission.ts'
import { JudgeSchema, WorkflowSchema, type Workflow } from '../src/types.ts'
import { validateWorkflow } from '../src/validate.ts'
import { fakeCliFromSource } from './support/fake-cli.ts'

const temps: string[] = []
const makeTemp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-system-one-'))
  temps.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const PERMISSION = { tools: ['Bash'], allow_above: 0.9 }

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

describe('normalizeScores', () => {
  it('rescales a distribution onto exactly the asked labels', () => {
    expect(normalizeScores(['a', 'b', 'c'], { scores: { a: 0.6, b: 0.6 } })).toEqual({
      ok: true,
      scores: { a: 0.5, b: 0.5, c: 0 },
    })
  })

  it('reads a single probability for a yes/no question', () => {
    expect(normalizeScores(['yes', 'no'], { yes: 0.25 })).toEqual({ ok: true, scores: { yes: 0.25, no: 0.75 } })
    expect(normalizeScores(['a', 'b'], { yes: 0.25 }).ok).toBe(false)
  })

  it('refuses a label nobody asked about, a non-probability, and an all-zero answer', () => {
    expect(normalizeScores(['yes', 'no'], { scores: { maybe: 1 } }).ok).toBe(false)
    expect(normalizeScores(['yes', 'no'], { scores: { yes: 1.5 } }).ok).toBe(false)
    expect(normalizeScores(['yes', 'no'], { scores: { yes: 0, no: 0 } }).ok).toBe(false)
    expect(normalizeScores(['yes', 'no'], 'yes').ok).toBe(false)
  })
})

describe('HttpSystemOneAdapter', () => {
  const answering = (status: number, body: unknown, seen: Request[] = []): typeof fetch =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(new Request(url, init))
      return new Response(JSON.stringify(body), { status })
    }) as typeof fetch

  it('posts the wire body with the operator\'s bearer token and normalizes the answer', async () => {
    const seen: Request[] = []
    const adapter = new HttpSystemOneAdapter({
      url: 'https://classifier.example.invalid/v1',
      apiKeyEnv: 'S1_KEY',
      env: { S1_KEY: 'sk-test-0123456789' },
      fetch: answering(200, { yes: 0.9 }, seen),
    })
    const outcome = await adapter.classify({ question: 'q?', labels: ['yes', 'no'], input: 'diff' })
    expect(outcome).toMatchObject({ ok: true, scores: { yes: 0.9 } })
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer sk-test-0123456789')
    expect(await seen[0]?.json()).toEqual({ kind: 'yes_no', question: 'q?', labels: ['yes', 'no'], input: 'diff' })
  })

  it('registers the key for redaction', () => {
    clearRedactions()
    new HttpSystemOneAdapter({ url: 'https://x.invalid', apiKeyEnv: 'K', env: { K: 'sk-secret-abcdef123' } })
    expect(sanitize({ note: 'token sk-secret-abcdef123' })['note']).toBe('<redacted>')
    clearRedactions()
  })

  it('is not ready, and refuses, when its key is missing', async () => {
    const adapter = new HttpSystemOneAdapter({ url: 'https://x.invalid', apiKeyEnv: 'MISSING_KEY', env: {} })
    expect(await adapter.preflight()).toEqual({ ready: false, hint: 'export MISSING_KEY before starting the daemon' })
    expect(await adapter.classify({ question: 'q', labels: ['yes', 'no'], input: '' })).toMatchObject({
      ok: false,
      kind: 'unavailable',
    })
  })

  it('reads a busy server as unavailable and a 4xx as invalid, without quoting the body', async () => {
    const busy = new HttpSystemOneAdapter({ url: 'https://x.invalid', fetch: answering(429, { error: 'diff text' }) })
    const bad = new HttpSystemOneAdapter({ url: 'https://x.invalid', fetch: answering(400, { error: 'diff text' }) })
    const q = { question: 'q', labels: ['yes', 'no'], input: 'diff text' }
    const a = await busy.classify(q)
    const b = await bad.classify(q)
    expect(a).toMatchObject({ ok: false, kind: 'unavailable' })
    expect(b).toMatchObject({ ok: false, kind: 'invalid' })
    expect(JSON.stringify([a, b])).not.toContain('diff text')
  })
})

describe('CommandSystemOneAdapter', () => {
  it('sends the question on stdin and reads the answer off stdout', async () => {
    const adapter = new CommandSystemOneAdapter({
      argv: [
        process.execPath,
        '-e',
        `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const q=JSON.parse(s);console.log(JSON.stringify({scores:{[q.labels[1]]:1}}))})`,
      ],
    })
    expect(await adapter.classify({ question: 'q', labels: ['real', 'flaky'], input: 'log' })).toMatchObject({
      ok: true,
      scores: { real: 0, flaky: 1 },
    })
  })

  it('reads a failing command as unavailable', async () => {
    const adapter = new CommandSystemOneAdapter({ argv: [process.execPath, '-e', 'process.exit(3)'] })
    expect(await adapter.classify({ question: 'q', labels: ['yes', 'no'], input: '' })).toMatchObject({
      ok: false,
      kind: 'unavailable',
    })
  })
})

describe('the operator config', () => {
  const write = (body: unknown): string => {
    const path = join(makeTemp(), 'system-one.json')
    writeFileSync(path, JSON.stringify(body))
    return path
  }

  it('builds the adapter its type names and applies judge defaults', () => {
    const systemOne = loadSystemOne(
      write({ adapter: { type: 'http', url: 'https://x.invalid', api_key_env: 'K' }, judges: { permission: {}, gate_triage: {} } }),
      { K: 'sk-0123456789' },
    )
    expect(systemOne.adapter).toBeInstanceOf(HttpSystemOneAdapter)
    expect(systemOne.judges.permission).toEqual({ tools: ['Bash'], allow_above: 0.9 })
    expect(systemOne.judges.gate_triage).toMatchObject({ rerun_above: 0.8, max_reruns: 1 })
  })

  it('takes the key out of the daemon\'s environment, so no agent or gate inherits it', async () => {
    process.env['S1_SCRUB_TEST_KEY'] = 'sk-scrub-0123456789'
    try {
      const systemOne = loadSystemOne(
        write({ adapter: { type: 'http', url: 'https://x.invalid', api_key_env: 'S1_SCRUB_TEST_KEY' } }),
      )
      expect(process.env['S1_SCRUB_TEST_KEY']).toBeUndefined()
      expect(await systemOne.adapter.preflight()).toEqual({ ready: true })
    } finally {
      delete process.env['S1_SCRUB_TEST_KEY']
      clearRedactions()
    }
  })

  it('refuses an unknown adapter type and an adapter block that does not fit its type', () => {
    expect(() => loadSystemOne(write({ adapter: { type: 'nope' } }))).toThrow(SystemOneConfigError)
    expect(() => loadSystemOne(write({ adapter: { type: 'http' } }))).toThrow(SystemOneConfigError)
    expect(() => loadSystemOne(write({ adapter: { type: 'command', argv: [] } }))).toThrow(SystemOneConfigError)
  })

  it('takes out-of-tree adapters through the registry', () => {
    const mock = new MockSystemOneAdapter(() => ({ yes: 1 }), { id: 'custom' })
    registerSystemOneAdapter('custom-test', {
      schema: z.looseObject({ type: z.literal('custom-test') }),
      create: () => mock,
    })
    expect(loadSystemOne(write({ adapter: { type: 'custom-test' } })).adapter).toBe(mock)
  })
})

// ---------------------------------------------------------------------------
// Judge gates in the workflow
// ---------------------------------------------------------------------------

describe('judge gates in a workflow', () => {
  const workflow = (judge: Record<string, unknown>): Workflow =>
    WorkflowSchema.parse({
      schema_version: 1,
      id: 'wf',
      base_branch: 'main',
      defaults: { harness: 'claude-code', model: 'opus', pipeline: 'standard-phase' },
      resources: { lane: { capacity: 1, kind: 'worktree' } },
      gates: { unit: { cmd: 'pytest' }, judged: { judge } },
      nodes: [{ id: 'p1', name: 'One', prompt_ref: 'plan.md#1', gates: ['unit', 'judged'] }],
    })

  it('parses beside a command gate and takes the yes/no defaults', () => {
    const parsed = workflow({ question: 'Logs PHI?', fail_on: ['yes'] })
    expect(parsed.gates['judged']).toMatchObject({
      judge: { labels: ['yes', 'no'], threshold: 0.5, input: 'diff', on_unavailable: 'pass' },
    })
    expect(validateWorkflow(parsed)).toEqual([])
  })

  it('needs exactly one question source, and a fail_on drawn from its labels that is not all of them', () => {
    const messages = (judge: Record<string, unknown>) => validateWorkflow(workflow(judge)).map((issue) => issue.message)
    expect(messages({ fail_on: ['yes'] })).toContain('a judge gate needs exactly one of `question` and `question_ref`')
    expect(messages({ question: 'q', question_ref: 'plan.md#q', fail_on: ['yes'] })).toHaveLength(1)
    expect(messages({ question: 'q', fail_on: ['maybe'] })).toContain('"maybe" is not one of this judge\'s labels')
    expect(messages({ question: 'q', fail_on: ['yes', 'no'] })).toContain(
      'fail_on names every label, so the gate could never pass',
    )
  })
})

describe('runJudgeGate', () => {
  const repo = (): string => {
    const dir = makeTemp()
    g(dir, 'init', '-b', 'main')
    g(dir, 'config', 'user.email', 'fixture@example.invalid')
    g(dir, 'config', 'user.name', 'fixture')
    g(dir, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(dir, 'README.md'), 'base\n')
    g(dir, 'add', '--all')
    g(dir, 'commit', '-m', 'base')
    return dir
  }
  const judge = JudgeSchema.parse({ question: 'q', fail_on: ['yes'], max_input_bytes: 1024 })

  it('counts an oversized diff as unavailable rather than judging a prefix of it', async () => {
    const lane = repo()
    writeFileSync(join(lane, 'big.txt'), 'x'.repeat(4096))
    const adapter = new MockSystemOneAdapter(() => ({ yes: 1 }))
    const ran = await runJudgeGate({
      gateId: 'j',
      judge,
      question: 'q',
      lanePath: lane,
      base: 'main',
      logPath: join(lane, '..', 'j.log'),
      adapter,
    })
    expect(ran.judgement.outcome).toBe('oversized')
    expect(ran.result.exitCode).toBe(0)
    expect(adapter.asked).toHaveLength(0)
  })

  it('judges committed and uncommitted work together, against the merge base', async () => {
    const lane = repo()
    g(lane, 'checkout', '-b', 'phase')
    writeFileSync(join(lane, 'committed.txt'), 'one\n')
    g(lane, 'add', '--all')
    g(lane, 'commit', '-m', 'phase work')
    writeFileSync(join(lane, 'pending.txt'), 'two\n')
    const adapter = new MockSystemOneAdapter(() => ({ yes: 0, no: 1 }))
    await runJudgeGate({ gateId: 'j', judge, question: 'q', lanePath: lane, base: 'main', logPath: join(makeTemp(), 'j.log'), adapter })
    expect(adapter.asked[0]?.input).toContain('committed.txt')
    expect(adapter.asked[0]?.input).toContain('pending.txt')
    expect(adapter.asked[0]?.input).not.toContain('README.md')
  })
})

// ---------------------------------------------------------------------------
// --permission judged
// ---------------------------------------------------------------------------

describe('judgePermission', () => {
  const request = { tool: 'Bash', input: { command: 'pytest -q' }, cwd: '/lanes/one' }

  it('allows only at or above allow_above on `safe`', async () => {
    const safe = new MockSystemOneAdapter(() => ({ safe: 0.95, unsafe: 0.05 }))
    const unsure = new MockSystemOneAdapter(() => ({ safe: 0.7, unsafe: 0.3 }))
    expect((await judgePermission(request, PERMISSION, safe)).allow).toBe(true)
    expect((await judgePermission(request, PERMISSION, unsure)).allow).toBe(false)
    expect(safe.asked[0]).toMatchObject({ question: PERMISSION_QUESTION, labels: ['safe', 'unsafe'] })
    expect(safe.asked[0]?.input).toContain('command: pytest -q')
  })

  it('fails closed when nobody answers', async () => {
    const down = new MockSystemOneAdapter(() => ({ refuse: 'unavailable' }))
    const decided = await judgePermission(request, PERMISSION, down)
    expect(decided.allow).toBe(false)
    expect(decided.judgement).toMatchObject({ outcome: 'unavailable', decision: 'deny' })
  })

  it('does not ask about a tool it was not told to judge', async () => {
    const adapter = new MockSystemOneAdapter(() => ({ unsafe: 1 }))
    expect((await judgePermission({ ...request, tool: 'Read' }, PERMISSION, adapter)).allow).toBe(true)
    expect(adapter.asked).toHaveLength(0)
  })
})

describe('createPermissionJudge', () => {
  it('journals each judgement and remembers only answered ones', async () => {
    const state = makeTemp()
    const journal = openJournal(state)
    try {
      journal.createRun(
        'run-1',
        WorkflowSchema.parse({
          schema_version: 1,
          id: 'wf',
          base_branch: 'main',
          defaults: { harness: 'claude-code', model: 'opus', pipeline: 'standard-phase' },
          resources: { lane: { capacity: 1, kind: 'worktree' } },
          nodes: [{ id: 'p1', name: 'One', prompt_ref: 'plan.md#1' }],
        }),
      )
      let refuse = true
      const adapter = new MockSystemOneAdapter(() => (refuse ? { refuse: 'unavailable' } : { safe: 1 }))
      const judge = createPermissionJudge({
        systemOne: { adapter, judges: { permission: PERMISSION } },
        journal,
        runId: 'run-1',
      })
      const ask = { holderNode: 'p1', tool: 'Bash', input: { command: 'make test' }, cwd: '/lane' }
      expect((await judge?.judge(ask))?.allow).toBe(false)
      refuse = false
      expect((await judge?.judge(ask))?.allow).toBe(true)
      expect((await judge?.judge(ask))?.allow).toBe(true)
      expect(adapter.asked).toHaveLength(2)

      const rows = journal.events('run-1').filter((event) => event.type === 'system_one_judged')
      expect(rows.map((row) => (row.payload as { decision: string }).decision)).toEqual(['deny', 'allow'])
      expect(JSON.stringify(rows)).not.toContain('make test')
    } finally {
      journal.close()
    }
  })

  it('is absent without a permission judge configured', () => {
    expect(
      createPermissionJudge({
        systemOne: { adapter: new MockSystemOneAdapter(() => ({ safe: 1 })), judges: {} },
        journal: { append: () => {} } as never,
        runId: 'r',
      }),
    ).toBeUndefined()
  })
})

describe('the judge hook', () => {
  const env = {
    [MAESTRO_URL_ENV]: 'http://127.0.0.1:9',
    [MAESTRO_TOKEN_ENV]: 'tok',
    [MAESTRO_RUN_ENV]: 'run-1',
    [MAESTRO_NODE_ENV]: 'p1',
  }
  const call = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/lane' })
  const drive = async (options: { env?: Record<string, string>; stdin?: string; fetch?: typeof fetch }) => {
    const out: string[] = []
    const err: string[] = []
    const code = await judgeHookCommandMain({
      stdin: async () => options.stdin ?? call,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      env: options.env ?? env,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    })
    const decision = out.length === 0 ? undefined : (JSON.parse(out[0] as string).hookSpecificOutput as {
      permissionDecision: string
    })
    return { code, decision: decision?.permissionDecision, err }
  }

  it('relays the daemon\'s decision', async () => {
    const seen: Request[] = []
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(new Request(url, init))
      return Response.json({ allow: true, reason: 'judged safe' })
    }) as typeof globalThis.fetch
    expect(await drive({ fetch })).toMatchObject({ code: 0, decision: 'allow' })
    expect(seen[0]?.url).toBe('http://127.0.0.1:9/api/runs/run-1/permission')
    expect(await seen[0]?.json()).toEqual({ holderNode: 'p1', tool: 'Bash', input: { command: 'ls' }, cwd: '/lane' })
  })

  it('denies when it cannot reach the daemon, cannot read the call, or is not in a run', async () => {
    const unreachable = (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch
    expect(await drive({ fetch: unreachable })).toMatchObject({ code: 0, decision: 'deny' })
    expect(await drive({ stdin: 'not json' })).toMatchObject({ code: 0, decision: 'deny' })
    expect(await drive({ env: {} })).toMatchObject({ code: 0, decision: 'deny' })
    const refused = (async () => new Response('{}', { status: 501 })) as typeof fetch
    expect(await drive({ fetch: refused })).toMatchObject({ code: 0, decision: 'deny' })
  })
})

describe('claude-code under --permission judged', () => {
  const task = (cwd: string): AgentTask => ({ nodeId: 'p1', cwd, prompt: 'go', model: 'haiku' })
  const recordingCli = (dir: string): string =>
    fakeCliFromSource(
      dir,
      'claude-judged',
      `import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(join(dir, 'argv.json'))}, JSON.stringify(process.argv.slice(2)))
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess' }))
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }))
`,
    )

  it('runs unprompted with the hook installed and hooks asserted on', async () => {
    const dir = makeTemp()
    const lane = join(dir, 'lanes', 'one')
    mkdirSync(lane, { recursive: true })
    const outcome = await new ClaudeCodeAdapter({
      bin: recordingCli(dir),
      permission: 'judged',
      settingsDir: join(dir, 'settings'),
      judgeHook: { command: 'judge-me', tools: ['Bash', 'WebFetch'], timeoutS: 60 },
    }).spawn(task(lane))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    for await (const _event of outcome.session.events) void _event

    const argv = JSON.parse(readFileSync(join(dir, 'argv.json'), 'utf8')) as string[]
    expect(argv).toContain('bypassPermissions')
    const settings = JSON.parse(readFileSync(argv[argv.indexOf('--settings') + 1] as string, 'utf8'))
    expect(settings.disableAllHooks).toBe(false)
    expect(settings.hooks.PreToolUse).toEqual([
      { matcher: 'Bash|WebFetch', hooks: [{ type: 'command', command: 'judge-me', timeout: 60 }] },
    ])
  })

  it('refuses to spawn without a hook rather than running unchecked', async () => {
    const dir = makeTemp()
    const outcome = await new ClaudeCodeAdapter({
      bin: recordingCli(dir),
      permission: 'judged',
      settingsDir: join(dir, 'settings'),
    }).spawn(task(dir))
    expect(outcome).toMatchObject({ ok: false, kind: 'fatal' })
  })
})

describe('the doctor', () => {
  const workflow = (overrides: Record<string, unknown> = {}): Workflow =>
    WorkflowSchema.parse({
      schema_version: 1,
      id: 'wf',
      base_branch: 'main',
      defaults: { harness: 'claude-code', model: 'opus', pipeline: 'standard-phase' },
      resources: { lane: { capacity: 1, kind: 'worktree' } },
      nodes: [{ id: 'p1', name: 'One', prompt_ref: 'plan.md#1' }],
      ...overrides,
    })
  const systemOne = (judges = {}) => ({ adapter: new MockSystemOneAdapter(() => ({ yes: 1 })), judges })

  it('fails judged without a permission judge, and on a harness that cannot host it', async () => {
    expect(await checkSystemOne(workflow(), systemOne(), 'judged')).toContainEqual(
      expect.objectContaining({ id: 'judged-permission', status: 'fail' }),
    )
    const codex = workflow({ defaults: { harness: 'codex', model: 'gpt', pipeline: 'standard-phase' } })
    expect(await checkSystemOne(codex, systemOne({ permission: PERMISSION }), 'judged')).toContainEqual(
      expect.objectContaining({ id: 'judged-permission', status: 'fail' }),
    )
    expect(await checkSystemOne(workflow(), systemOne({ permission: PERMISSION }), 'judged')).toContainEqual(
      expect.objectContaining({ id: 'judged-permission', status: 'pass' }),
    )
  })

  it('warns about advisory judge gates without a classifier and fails on required ones', async () => {
    const gates = (on_unavailable: string) =>
      workflow({ gates: { j: { judge: { question: 'q', fail_on: ['yes'], on_unavailable } } } })
    expect(await checkSystemOne(gates('pass'), undefined, 'auto')).toEqual([
      expect.objectContaining({ id: 'system-one-gates', status: 'warn' }),
    ])
    expect(await checkSystemOne(gates('fail'), undefined, 'auto')).toEqual([
      expect.objectContaining({ id: 'system-one-gates', status: 'fail' }),
    ])
  })
})
