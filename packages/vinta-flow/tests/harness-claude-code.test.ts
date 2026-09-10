/**
 * Two suites in one file, deliberately.
 *
 * The unit suite is the one that actually protects this adapter: it drives the
 * JSONL mapping, the stream framing and the refusal table over synthetic CLI
 * output, and it runs everywhere — no CLI, no login, no tokens spent. It even
 * covers `preflight` end to end, against shell scripts written into a temp dir
 * that impersonate each state the real binary can be in.
 *
 * The live suite runs `runAdapterContract` against the real CLI, and skips
 * itself when `preflight` says the binary is missing or logged out. It must
 * never fail a suite on a machine without an authenticated CLI — which
 * includes CI, and includes the machine this was written on, where `claude` is
 * a shell alias rather than anything on PATH.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AgentEvent, AgentSession, AgentTask, HarnessAdapter } from '../src/harness/adapter.ts'
import {
  ClaudeCodeAdapter,
  classifySpawnFailure,
  mapCliEvent,
} from '../src/harness/claude-code.ts'
import { runAdapterContract } from '../src/harness/contract.ts'
import { JsonLines, parseRetryAfter } from '../src/harness/shared.ts'

const temps: string[] = []

const makeTemp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-flow-claude-'))
  temps.push(dir)
  return dir
}

// Cleanup runs even when a test above it threw: a failing run must not leave
// fake binaries behind in the system temp dir.
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

const fakeBin = (body: string): string => {
  const path = join(makeTemp(), 'claude-fake')
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

const VERSION_CASE = `case "$1" in --version) echo "1.2.3 (Claude Code)"; exit 0;; esac`

// ---------------------------------------------------------------------------

describe('JsonLines framing', () => {
  it('reassembles an object split across chunk boundaries', () => {
    const lines = new JsonLines()
    expect(lines.push('{"type":"sys')).toEqual([])
    expect(lines.push('tem","subtype":"in')).toEqual([])
    expect(lines.push('it","session_id":"abc"}\n')).toEqual([
      { type: 'system', subtype: 'init', session_id: 'abc' },
    ])
  })

  it('emits several frames from one chunk and holds an unterminated tail', () => {
    const lines = new JsonLines()
    const frames = lines.push('{"a":1}\n{"b":2}\n{"c":')
    expect(frames).toEqual([{ a: 1 }, { b: 2 }])
    expect(lines.push('3}\n')).toEqual([{ c: 3 }])
  })

  it('drops blank lines and non-JSON noise without throwing', () => {
    const lines = new JsonLines()
    expect(lines.push('\n\nnot json at all\n{"ok":true}\n')).toEqual([{ ok: true }])
  })
})

describe('CLI frame mapping', () => {
  it('maps the init frame to a session start', () => {
    expect(mapCliEvent({ type: 'system', subtype: 'init', session_id: 's-1' })).toEqual([
      { type: 'session_started', sessionId: 's-1' },
    ])
  })

  it('maps assistant text, thinking and tool use from one message', () => {
    const events = mapCliEvent({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'considering' },
          { type: 'text', text: 'reading the brief' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'src/widget.ts' } },
        ],
      },
    })
    expect(events).toEqual([
      { type: 'thinking', text: 'considering' },
      { type: 'assistant_text', text: 'reading the brief' },
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'src/widget.ts' } },
    ])
  })

  it('maps a tool result off the synthetic user turn', () => {
    expect(
      mapCliEvent({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: '42 lines' }] },
      }),
    ).toEqual([{ type: 'tool_result', id: 'tool-1', ok: true, summary: '42 lines' }])
  })

  it('marks a failed tool result as not ok', () => {
    const events = mapCliEvent({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tool-2', is_error: true, content: [{ type: 'text', text: 'boom' }] },
        ],
      },
    })
    expect(events).toEqual([{ type: 'tool_result', id: 'tool-2', ok: false, summary: 'boom' }])
  })

  it('ignores prompt text on the user turn, which the adapter already emitted', () => {
    expect(
      mapCliEvent({ type: 'user', message: { content: [{ type: 'text', text: 'do the thing' }] } }),
    ).toEqual([])
  })

  it('maps the terminal result frame to usage plus a session end', () => {
    expect(
      mapCliEvent({
        type: 'result',
        subtype: 'success',
        is_error: false,
        total_cost_usd: 0.0412,
        usage: { input_tokens: 1200, output_tokens: 340 },
      }),
    ).toEqual([
      { type: 'usage', input: 1200, output: 340, costUsd: 0.0412 },
      { type: 'session_ended', result: 'ok' },
    ])
  })

  it('maps a failed result to an error carrying the status token only', () => {
    const events = mapCliEvent({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      result: 'the agent said something that must not reach a log field',
      usage: { input_tokens: 10, output_tokens: 2 },
    })
    expect(events).toEqual([
      { type: 'usage', input: 10, output: 2 },
      { type: 'error', message: 'claude-code result: error_max_turns' },
      { type: 'session_ended', result: 'error' },
    ])
  })

  it('maps a permission control request', () => {
    expect(
      mapCliEvent({
        type: 'control_request',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } },
      }),
    ).toEqual([{ type: 'permission_request', tool: 'Bash', detail: { command: 'ls' } }])
  })

  it('ignores frame types, block types and malformed frames it has never seen', () => {
    expect(mapCliEvent({ type: 'a_variant_shipped_next_year', payload: 1 })).toEqual([])
    expect(mapCliEvent({ type: 'stream_event', event: { delta: 'x' } })).toEqual([])
    expect(mapCliEvent({ type: 'system', subtype: 'compact_boundary' })).toEqual([])
    expect(
      mapCliEvent({ type: 'assistant', message: { content: [{ type: 'server_tool_use' }] } }),
    ).toEqual([])
    expect(mapCliEvent({ type: 'assistant', message: { content: 'not an array' } })).toEqual([])
    expect(mapCliEvent(null)).toEqual([])
    expect(mapCliEvent('a bare string')).toEqual([])
    expect(mapCliEvent([1, 2, 3])).toEqual([])
  })

  it('maps a whole recorded run end to end through the framer', () => {
    const transcript = [
      '{"type":"system","subtype":"init","session_id":"sess-9","tools":["Read"]}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"looking"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}',
      '{"type":"future_variant"}',
      '{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":5,"output_tokens":6}}',
      '',
    ].join('\n')

    const lines = new JsonLines()
    const events: AgentEvent[] = []
    // Byte-at-a-time is the worst framing a socket can hand you; it must not
    // change the result at all.
    for (const char of transcript) {
      for (const frame of lines.push(char)) events.push(...mapCliEvent(frame))
    }

    expect(events.map((e) => e.type)).toEqual([
      'session_started',
      'assistant_text',
      'tool_use',
      'tool_result',
      'usage',
      'session_ended',
    ])
  })
})

// ---------------------------------------------------------------------------

describe('spawn refusal classification', () => {
  const kindOf = (output: string, code: number | null = 1): string =>
    classifySpawnFailure(output, code, 'phase-1').kind

  it('calls a missing binary fatal', () => {
    expect(kindOf('Error: spawn claude ENOENT', null)).toBe('fatal')
    expect(kindOf('/bin/sh: claude: command not found', 127)).toBe('fatal')
  })

  it('calls a logged-out CLI fatal', () => {
    expect(kindOf('Invalid API key · Please run /login')).toBe('fatal')
    expect(kindOf('You are not logged in. Run claude and use /login')).toBe('fatal')
    expect(kindOf('OAuth token has expired')).toBe('fatal')
  })

  it('calls an exhausted usage window quota, not fatal', () => {
    expect(kindOf('Claude usage limit reached. Your limit will reset at 3pm.')).toBe('quota')
    expect(kindOf('Credit balance is too low')).toBe('quota')
  })

  it('calls a rate limit a rate limit', () => {
    expect(kindOf('API Error: 429 rate_limit_error')).toBe('rate_limit')
    expect(kindOf('Too many requests, slow down')).toBe('rate_limit')
  })

  it('calls a per-account session cap concurrency', () => {
    expect(kindOf('too many concurrent sessions for this account')).toBe('concurrency')
    expect(kindOf('Maximum concurrent agents reached')).toBe('concurrency')
  })

  it('calls an upstream hiccup transient', () => {
    expect(kindOf('API Error: 529 Overloaded')).toBe('transient')
    expect(kindOf('fetch failed: ECONNRESET')).toBe('transient')
    expect(kindOf('503 Service Unavailable')).toBe('transient')
  })

  it('defaults an unrecognized failure to fatal rather than an unbounded wait', () => {
    expect(kindOf('something nobody has ever seen', 3)).toBe('fatal')
  })

  it('never puts vendor prose in the refusal message', () => {
    const refusal = classifySpawnFailure('Claude usage limit reached at 3pm', 1, 'phase-7')
    expect(refusal.message.includes('phase-7')).toBe(true)
    expect(refusal.message.toLowerCase().includes('claude usage limit')).toBe(false)
  })

  it('carries a reported reset time and omits it when none was reported', () => {
    const now = new Date('2026-01-01T10:00:00.000Z')
    const withReset = classifySpawnFailure(
      'usage limit reached; resets at 2026-01-01T15:30:00Z',
      1,
      'phase-1',
      now,
    )
    expect(withReset.retryAfter?.toISOString()).toBe('2026-01-01T15:30:00.000Z')
    expect(classifySpawnFailure('429 rate limit', 1, 'phase-1', now).retryAfter).toBe(undefined)
  })

  it('never attaches a retry time to fatal, which is not a wait', () => {
    const refusal = classifySpawnFailure('not logged in; retry after 60 seconds', 1, 'n', new Date())
    expect(refusal.kind).toBe('fatal')
    expect(refusal.retryAfter).toBe(undefined)
  })
})

describe('reported reset times', () => {
  const now = new Date('2026-01-01T10:00:00.000Z')

  it('reads a retry-after header in seconds', () => {
    expect(parseRetryAfter('retry-after: 120', now)?.toISOString()).toBe('2026-01-01T10:02:00.000Z')
    expect(parseRetryAfter('please retry in 30 seconds', now)?.toISOString()).toBe(
      '2026-01-01T10:00:30.000Z',
    )
  })

  it('reads an epoch reset field', () => {
    expect(parseRetryAfter('{"resets_at":1767283200}', now)?.toISOString()).toBe(
      '2026-01-01T16:00:00.000Z',
    )
  })

  it('reads a wall-clock reset and rolls it forward when it has passed', () => {
    const local = new Date('2026-01-01T12:00:00')
    const at = parseRetryAfter('Your limit will reset at 3pm', local)
    expect(at?.getHours()).toBe(15)
    expect(at?.getDate()).toBe(1)

    const late = new Date('2026-01-01T16:00:00')
    expect(parseRetryAfter('Your limit will reset at 3pm', late)?.getDate()).toBe(2)
  })

  it('reports nothing when the vendor said nothing', () => {
    expect(parseRetryAfter('overloaded', now)).toBe(undefined)
  })
})

// ---------------------------------------------------------------------------

describe('binary resolution', () => {
  it('prefers the option, then the env var, then the bare name', () => {
    expect(new ClaudeCodeAdapter({ bin: '/opt/claude-work' }).bin).toBe('/opt/claude-work')

    const previous = process.env['VINTA_FLOW_CLAUDE_BIN']
    process.env['VINTA_FLOW_CLAUDE_BIN'] = '/opt/from-env'
    try {
      expect(new ClaudeCodeAdapter().bin).toBe('/opt/from-env')
      delete process.env['VINTA_FLOW_CLAUDE_BIN']
      expect(new ClaudeCodeAdapter().bin).toBe('claude')
    } finally {
      if (previous === undefined) delete process.env['VINTA_FLOW_CLAUDE_BIN']
      else process.env['VINTA_FLOW_CLAUDE_BIN'] = previous
    }
  })
})

describe('preflight against a fake binary', () => {
  it('reports not installed, with the command that installs it', async () => {
    const missing = join(makeTemp(), 'definitely-not-here')
    const result = await new ClaudeCodeAdapter({ bin: missing }).preflight()
    expect(result.installed).toBe(false)
    expect(result.authenticated).toBe(false)
    expect(result.hint?.includes('VINTA_FLOW_CLAUDE_BIN')).toBe(true)
  })

  it('reports not installed when the binary exists but cannot answer --version', async () => {
    const bin = fakeBin('exit 1')
    const result = await new ClaudeCodeAdapter({ bin }).preflight()
    expect(result.installed).toBe(false)
  })

  it('distinguishes a logged-out CLI from a missing one, with the login command', async () => {
    const bin = fakeBin(`${VERSION_CASE}\necho 'Invalid API key · Please run /login' >&2\nexit 1`)
    const result = await new ClaudeCodeAdapter({ bin }).preflight()
    expect(result.installed).toBe(true)
    expect(result.authenticated).toBe(false)
    expect(result.version).toBe('1.2.3 (Claude Code)')
    expect(result.hint).toBe(`${bin} /login`)
  })

  it('reports ready when the CLI starts a session', async () => {
    const bin = fakeBin(
      `${VERSION_CASE}\necho '{"type":"system","subtype":"init","session_id":"probe"}'\nexit 0`,
    )
    const result = await new ClaudeCodeAdapter({ bin }).preflight()
    expect(result).toEqual({ installed: true, authenticated: true, version: '1.2.3 (Claude Code)' })
  })

  it('does not call an unfamiliar diagnostic a login failure', async () => {
    const bin = fakeBin(`${VERSION_CASE}\necho 'warning: config file is new' >&2\nexit 2`)
    const result = await new ClaudeCodeAdapter({ bin }).preflight()
    expect(result.authenticated).toBe(true)
  })
})

describe('spawn against a fake binary', () => {
  const task = (): AgentTask => ({
    nodeId: 'phase-1',
    cwd: makeTemp(),
    prompt: 'implement the widget model',
    model: 'haiku',
  })

  it('drives a whole scripted run into the normalized stream', async () => {
    const bin = fakeBin(
      [
        `${VERSION_CASE}`,
        // Read the prompt off stdin the way the real CLI does, then play a run.
        'head -n 1 > /dev/null',
        `echo '{"type":"system","subtype":"init","session_id":"sess-fake"}'`,
        `echo '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}'`,
        `echo '{"type":"unknown_future_frame"}'`,
        `echo '{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":3,"output_tokens":4},"total_cost_usd":0.01}'`,
        'exit 0',
      ].join('\n'),
    )
    const outcome = await new ClaudeCodeAdapter({ bin }).spawn(task())
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(outcome.session.id).toBe('sess-fake')
    const seen: AgentEvent[] = []
    for await (const event of outcome.session.events) seen.push(event)
    expect(seen).toEqual([
      { type: 'session_started', sessionId: 'sess-fake' },
      { type: 'assistant_text', text: 'working' },
      { type: 'usage', input: 3, output: 4, costUsd: 0.01 },
      { type: 'session_ended', result: 'ok' },
    ])
  })

  it('classifies a CLI that refuses before announcing a session', async () => {
    const bin = fakeBin(
      `${VERSION_CASE}\necho 'Claude usage limit reached. Resets at 2026-01-01T15:30:00Z' >&2\nexit 1`,
    )
    const outcome = await new ClaudeCodeAdapter({ bin }).spawn(task())
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.kind).toBe('quota')
    expect(outcome.retryAfter?.toISOString()).toBe('2026-01-01T15:30:00.000Z')
  })

  it('classifies a binary that is not there at all', async () => {
    const outcome = await new ClaudeCodeAdapter({ bin: join(makeTemp(), 'nope') }).spawn(task())
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.kind).toBe('fatal')
  })

  it('ends the stream once when the CLI dies mid-turn', async () => {
    const bin = fakeBin(
      [
        `${VERSION_CASE}`,
        'head -n 1 > /dev/null',
        `echo '{"type":"system","subtype":"init","session_id":"sess-dies"}'`,
        'exit 3',
      ].join('\n'),
    )
    const outcome = await new ClaudeCodeAdapter({ bin }).spawn(task())
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const seen: AgentEvent[] = []
    for await (const event of outcome.session.events) seen.push(event)
    expect(seen.filter((e) => e.type === 'session_ended').length).toBe(1)
    expect(seen[seen.length - 1]).toEqual({ type: 'session_ended', result: 'error' })
  })

  it('returns an injected refusal of every kind without starting a process', async () => {
    const adapter = new ClaudeCodeAdapter({ bin: join(makeTemp(), 'never-run') })
    for (const kind of ['rate_limit', 'concurrency', 'quota', 'transient', 'fatal'] as const) {
      adapter.refuseNext(kind)
      const outcome = await adapter.spawn(task())
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.kind).toBe(kind)
    }
  })
})

// ---------------------------------------------------------------------------
// Live contract, preflight-gated.
// ---------------------------------------------------------------------------

const liveAdapter = new ClaudeCodeAdapter()
const live = await liveAdapter.preflight()

if (!live.installed || !live.authenticated) {
  const reason = live.installed
    ? `the CLI at "${liveAdapter.bin}" is not logged in — run \`${live.hint ?? ''}\` yourself`
    : `no Claude Code binary at "${liveAdapter.bin}" — set VINTA_FLOW_CLAUDE_BIN`
  describe.skip(`harness adapter contract: claude-code (live) — skipped: ${reason}`, () => {
    it('is skipped', () => {})
  })
} else {
  runAdapterContract('claude-code (live)', { describe, it, expect }, () => {
    const real = new ClaudeCodeAdapter()
    const started: AgentSession[] = []
    // An assertion that throws mid-stream skips the drain that would have ended
    // the child. Recording every session is what makes `dispose` able to
    // guarantee the suite leaves nothing running behind it.
    const adapter: HarnessAdapter = {
      id: real.id,
      capabilities: real.capabilities,
      preflight: () => real.preflight(),
      spawn: async (task) => {
        const outcome = await real.spawn(task)
        if (outcome.ok) started.push(outcome.session)
        return outcome
      },
    }
    return {
      adapter,
      // A measured live turn drains in ~3.4s, which leaves too little margin
      // under the default 5s deadline once the network is slow — the same
      // ~1.5s gap that made the codex live suite flake. The deadline still
      // exists to fail fast on a genuinely hung stream; it just isn't sized
      // to a good day.
      hangMs: 30_000,
      task: { nodeId: 'contract', cwd: makeTemp(), prompt: 'Reply with exactly: ok', model: 'haiku' },
      forceRefusal: real.refuseNext.bind(real),
      dispose: async () => {
        for (const session of started) await session.kill()
      },
    }
  })
}
