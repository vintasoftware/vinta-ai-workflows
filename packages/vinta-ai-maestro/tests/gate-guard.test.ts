/**
 * The gate guard: the matcher, the hook claude-code runs, the daemon side that
 * journals a block, and where it is installed.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { checkGateGuard } from '../src/doctor/index.ts'
import { createGateGuard } from '../src/guard/guard.ts'
import { guardHookMain } from '../src/guard/hook.ts'
import { checkCommand, shellLineOf } from '../src/guard/match.ts'
import { openJournal } from '../src/journal/journal.ts'
import { WorkflowSchema, type Workflow } from '../src/types.ts'

function workflow(overrides: Record<string, unknown> = {}): Workflow {
  return WorkflowSchema.parse({
    schema_version: 1,
    id: 'wf',
    base_branch: 'main',
    defaults: { harness: 'claude-code', model: 'sonnet', pipeline: 'standard-phase' },
    resources: {
      lane: { capacity: 2, kind: 'worktree' },
      'test-suite': { capacity: 1, kind: 'semaphore', match: ['pytest*', 'uv run pytest*'] },
    },
    gates: {
      unit: { cmd: 'uv run pytest --reuse-db', scoped_cmd: 'uv run pytest {changed_files}', requires: ['test-suite'] },
      types: { cmd: 'uv run mypy .' },
      smells: { judge: { question: 'Does this log PHI?', fail_on: ['yes'] } },
    },
    nodes: [{ id: 'p1', name: 'One', prompt_ref: 'plan.md#phase-1', gates: ['types', 'unit'] }],
    ...overrides,
  })
}

describe('checkCommand', () => {
  const wf = workflow()

  it('names the gate whose full command was typed', () => {
    expect(checkCommand(wf, 'uv run mypy .')).toEqual({ rule: 'gate', gate: 'types' })
    expect(checkCommand(wf, '  uv   run pytest   --reuse-db ')).toEqual({ rule: 'gate', gate: 'unit' })
  })

  it('treats a narrowed run as inner-loop work: it needs the lease, not the gate verb', () => {
    // The scoped form of `unit` with files in it, and an agent running two test
    // files, are the same line. The second is the work; it owes the pool only.
    expect(checkCommand(wf, 'uv run pytest app/models.py app/views.py')).toEqual({ rule: 'pool', pool: 'test-suite' })
  })

  it('looks inside compound lines and past environment assignments', () => {
    expect(checkCommand(wf, 'cd api && DJANGO_SETTINGS=test uv run mypy .')).toEqual({ rule: 'gate', gate: 'types' })
    expect(checkCommand(wf, 'git status; uv run mypy . | tail -5')).toEqual({ rule: 'gate', gate: 'types' })
  })

  it('asks for the lease on a pooled command, and is satisfied by `with`', () => {
    expect(checkCommand(wf, 'pytest tests/test_one.py -k slow')).toEqual({ rule: 'pool', pool: 'test-suite' })
    expect(checkCommand(wf, 'vinta-ai-maestro with test-suite -- pytest tests/test_one.py')).toBeNull()
    expect(checkCommand(wf, "npx vinta-ai-maestro with test-suite -- 'uv run pytest -x tests/a.py'")).toBeNull()
  })

  it('still refuses a gate wrapped in a lease: the gate verb is what runs a gate', () => {
    expect(checkCommand(wf, 'vinta-ai-maestro with test-suite -- uv run mypy .')).toEqual({ rule: 'gate', gate: 'types' })
  })

  it('lets the verbs themselves, and everything unrelated, through', () => {
    expect(checkCommand(wf, 'vinta-ai-maestro gate unit')).toBeNull()
    expect(checkCommand(wf, 'git diff --stat')).toBeNull()
    expect(checkCommand(wf, 'uv run mypy app/models.py')).toBeNull()
  })

  it('reads a codex shell wrapper and an opencode bash call, and ignores claude-code’s', () => {
    expect(shellLineOf('codex', 'command_execution', { command: "/bin/zsh -lc 'uv run mypy .'" })).toBe('uv run mypy .')
    expect(shellLineOf('opencode', 'bash', { command: 'pytest' })).toBe('pytest')
    expect(shellLineOf('claude-code', 'Bash', { command: 'pytest' })).toBeNull()
  })
})

describe('the daemon side', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('refuses with the verb to use, journals ids only, and reads the definition as amended', () => {
    const dir = mkdtempSync(join(tmpdir(), 'maestro-guard-'))
    dirs.push(dir)
    const journal = openJournal(dir)
    let current = workflow()
    journal.createRun('run-1', current)
    const guard = createGateGuard({ journal, runId: 'run-1', workflow: () => current })

    const denied = guard.check({ holderNode: 'p1', command: 'uv run mypy .' })
    expect(denied.allow).toBe(false)
    expect(denied.reason).toContain('vinta-ai-maestro gate types')

    const rows = journal.events('run-1').filter((event) => event.type === 'bare_gate_blocked')
    expect(rows.map((row) => row.payload)).toEqual([{ rule: 'gate', gate: 'types', harness: 'claude-code' }])
    expect(JSON.stringify(rows)).not.toContain('mypy')

    // A retune moves what the guard matches.
    current = workflow({ gates: { types: { cmd: 'uv run mypy --strict .' } } })
    expect(guard.check({ holderNode: 'p1', command: 'uv run mypy .' }).allow).toBe(true)
    journal.close()
  })
})

describe('the hook', () => {
  const env = {
    VINTA_AI_MAESTRO_URL: 'http://127.0.0.1:1',
    VINTA_AI_MAESTRO_TOKEN: 't',
    VINTA_AI_MAESTRO_RUN_ID: 'run-1',
    VINTA_AI_MAESTRO_NODE_ID: 'p1',
  }
  const call = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'uv run mypy .' } })

  async function drive(options: { env?: Record<string, string>; stdin?: string; fetch?: typeof fetch }) {
    const out: string[] = []
    const code = await guardHookMain({
      stdin: async () => options.stdin ?? call,
      out: (text) => out.push(text),
      env: options.env ?? env,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    })
    return { code, out }
  }

  it('prints a denial with the daemon’s reason', async () => {
    let asked: unknown
    const { code, out } = await drive({
      fetch: (async (url: string, init: RequestInit) => {
        asked = { url, body: JSON.parse(init.body as string) }
        return new Response(JSON.stringify({ allow: false, reason: 'use the gate verb' }), { status: 200 })
      }) as typeof fetch,
    })
    expect(code).toBe(0)
    expect(asked).toEqual({
      url: 'http://127.0.0.1:1/api/runs/run-1/guard',
      body: { holderNode: 'p1', command: 'uv run mypy .' },
    })
    expect(JSON.parse(out[0] as string).hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'vinta-ai-maestro: use the gate verb',
    })
  })

  it('never prints an allow, and stays silent on every failure', async () => {
    const allowed = await drive({
      fetch: (async () => new Response(JSON.stringify({ allow: true }), { status: 200 })) as typeof fetch,
    })
    const unreachable = await drive({
      fetch: (async () => {
        throw new Error('ECONNREFUSED')
      }) as typeof fetch,
    })
    const refused = await drive({ fetch: (async () => new Response('', { status: 500 })) as typeof fetch })
    const unattributed = await drive({ env: {} })
    const garbage = await drive({ stdin: 'not json' })
    const otherTool = await drive({ stdin: JSON.stringify({ tool_name: 'Edit', tool_input: {} }) })
    for (const result of [allowed, unreachable, refused, unattributed, garbage, otherTool]) {
      expect(result).toEqual({ code: 0, out: [] })
    }
  })
})

describe('where it is installed', () => {
  it('is reported per harness: enforced on claude-code, detected elsewhere', () => {
    const wf = workflow({
      nodes: [
        { id: 'p1', name: 'One', prompt_ref: 'plan.md#phase-1' },
        { id: 'p2', name: 'Two', prompt_ref: 'plan.md#phase-2', harness: 'codex' },
      ],
    })
    expect(checkGateGuard(wf).map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'gate-guard:claude-code', status: 'pass' },
      { id: 'gate-guard:codex', status: 'warn' },
    ])
    // Nothing to guard, nothing to report.
    expect(checkGateGuard(workflow({ gates: {}, resources: { lane: { capacity: 1, kind: 'worktree' } } }))).toEqual([])
  })
})

