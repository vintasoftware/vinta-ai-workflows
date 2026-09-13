/**
 * Two suites in one file, deliberately.
 *
 * The unit suite is the one that actually protects this adapter: it drives the
 * JSONL mapping, the stream framing and the refusal table over synthetic CLI
 * output, and it runs everywhere — no CLI, no login, no tokens spent. It even
 * covers `preflight` and `spawn` end to end, against fake binaries written into
 * a temp dir — a Node program plus the launcher npm would install beside it —
 * that impersonate each state the real binary can be in, on either platform.
 *
 * The live suite runs `runAdapterContract` against the real CLI, and skips
 * itself when `preflight` says the binary is missing or logged out. It must
 * never fail a suite on a machine without an authenticated CLI — which
 * includes CI, and includes the machine this was written on, where `claude` is
 * a shell alias rather than anything on PATH.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
import { commandInvocation } from '../src/platform/platform.ts'
import { JsonLines, parseRetryAfter } from '../src/harness/shared.ts'
import { type FakeCliSpec, fakeCli, fakeCliFromSource } from './support/fake-cli.ts'

const temps: string[] = []

const makeTemp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-claude-'))
  temps.push(dir)
  return dir
}

// Cleanup runs even when a test above it threw: a failing run must not leave
// fake binaries behind in the system temp dir.
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

/**
 * A fake `claude`, one per temp dir so no two fixtures can shadow each other.
 *
 * Each fixture gets its own directory because `fakeCli` writes two files under
 * a fixed name and the tests below hand several different fakes to several
 * different adapters within one run.
 */
const fakeBin = (spec: FakeCliSpec): string => fakeCli(makeTemp(), 'claude-fake', spec)

/** What this CLI answers `--version` with, which `preflight` reports verbatim. */
const VERSION = '1.2.3 (Claude Code)'

/** Well-formed and never issued: the shape of a session id the vendor has forgotten. */
const UNISSUED_SESSION = '00000000-0000-4000-8000-000000000000'

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

  /**
   * The frame that was being dropped, byte for byte as the CLI emits it.
   *
   * A read outside the working directory is not *asked* about — there is no
   * `can_use_tool` request to answer — it is decided, and announced like this.
   * Until this mapping existed the orchestrator saw nothing: no event, no
   * journal row, no transcript line, and a session that went on to end
   * successfully having written nothing.
   */
  it('maps a refusal the CLI decided on its own', () => {
    expect(
      mapCliEvent({
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'Read',
        tool_use_id: 'toolu_01',
        decision_reason_type: 'workingDir',
        decision_reason: 'Path is outside allowed working directories',
        message: 'Claude requested permissions to read from /repo/src/secret.ts, …',
      }),
    ).toEqual([{ type: 'permission_denied', tool: 'Read', reason: 'workingDir' }])
  })

  /**
   * §11: the prose names the file that was being read. The decision token is a
   * fixed word, which is what an operator acts on anyway — and the `tool_use`
   * row above it in the transcript already carries what was attempted.
   */
  it('carries the decision token and never the vendor’s prose', () => {
    const [event] = mapCliEvent({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Read',
      decision_reason_type: 'workingDir',
      decision_reason: 'Path is outside allowed working directories',
      message: 'Claude requested permissions to read from /repo/src/secret.ts, …',
    })

    expect(JSON.stringify(event)).not.toContain('secret.ts')
    expect(JSON.stringify(event)).not.toContain('outside allowed')
  })

  /** A refusal with no reason attached is still a refusal, and still said. */
  it('names a refusal that came with no decision token', () => {
    expect(
      mapCliEvent({ type: 'system', subtype: 'permission_denied', tool_name: 'Write' }),
    ).toEqual([{ type: 'permission_denied', tool: 'Write', reason: 'denied' }])
  })

  it('ignores a refusal that does not say which tool', () => {
    expect(mapCliEvent({ type: 'system', subtype: 'permission_denied' })).toEqual([])
  })

  /**
   * The frame that says the turn is over and nothing was done — emitted just
   * before a `result` that reports `is_error: false`.
   */
  it('maps a turn the CLI says ended blocked', () => {
    expect(
      mapCliEvent({
        type: 'system',
        subtype: 'post_turn_summary',
        status_category: 'blocked',
        status_detail: 'Please grant access and I will retrieve the secret value for you.',
        needs_action: 'Please grant access and I will retrieve the secret value for you.',
      }),
    ).toEqual([{ type: 'error', message: 'claude-code: the turn ended blocked' }])
  })

  /** The agent's own words about what it wanted (§11). The category is ours. */
  it('keeps the agent’s words out of the blocked report', () => {
    const [event] = mapCliEvent({
      type: 'system',
      subtype: 'post_turn_summary',
      status_category: 'blocked',
      needs_action: 'Please grant access to /repo/src/secret.ts',
    })

    expect(JSON.stringify(event)).not.toContain('secret.ts')
  })

  /** Every other category is an ordinary turn, and the set is the vendor's. */
  it('says nothing about a turn that finished', () => {
    expect(mapCliEvent({ type: 'system', subtype: 'post_turn_summary', status_category: 'completed' })).toEqual([])
    expect(mapCliEvent({ type: 'system', subtype: 'post_turn_summary' })).toEqual([])
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

  it('carries the cache counters off the same usage object', () => {
    // §15.6. They were sitting unread beside the two counts this already
    // mapped, which is the only reason session reuse was unmeasurable.
    expect(
      mapCliEvent({
        type: 'result',
        subtype: 'success',
        is_error: false,
        usage: {
          input_tokens: 1200,
          output_tokens: 340,
          cache_read_input_tokens: 18_400,
          cache_creation_input_tokens: 2_100,
        },
      })[0],
    ).toEqual({ type: 'usage', input: 1200, output: 340, cacheRead: 18_400, cacheWrite: 2_100 })
  })

  it('omits a cache counter the CLI did not send rather than reporting a zero', () => {
    // A missing figure is unknown, and §15.6 turns unknown into "no hit rate
    // to state" — while a reported 0 is a genuine cold turn. Emitting 0 here
    // would erase the difference for every consumer downstream.
    const usage = mapCliEvent({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 0 },
    })[0]
    expect(usage).toEqual({ type: 'usage', input: 5, output: 6, cacheRead: 0 })
    expect(usage).not.toHaveProperty('cacheWrite')
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
      { now },
    )
    expect(withReset.retryAfter?.toISOString()).toBe('2026-01-01T15:30:00.000Z')
    expect(classifySpawnFailure('429 rate limit', 1, 'phase-1', { now }).retryAfter).toBe(undefined)
  })

  it('calls a refused resume stale — but only where a session id was carried', () => {
    // §15.4's rule, in both directions. The CLI's own wording for an id it no
    // longer has, first with the token that was refused and then without one:
    // with nothing to be stale, the same words are whatever they were before.
    const prose = 'No conversation found with session ID: 5f2c1b90'
    expect(classifySpawnFailure(prose, 1, 'phase-1', { resuming: true }).kind).toBe('stale_session')
    expect(kindOf(prose)).toBe('fatal')
    expect(classifySpawnFailure(prose, 1, 'phase-1', { resuming: false }).kind).toBe('fatal')
  })

  it('reads a stale session ahead of a pattern that would otherwise match it', () => {
    // Why the row is hoisted rather than merely listed: a vendor announcing a
    // forgotten session in the same breath as a network word would otherwise
    // be classified `transient` and waited on forever — a session nobody has
    // does not come back after a backoff.
    const prose = 'ECONNRESET while resuming: no conversation found'
    expect(classifySpawnFailure(prose, 1, 'phase-1', { resuming: true }).kind).toBe('stale_session')
    expect(kindOf(prose)).toBe('transient')
  })

  it('never waits on a stale session, and never quotes the vendor about one', () => {
    const refusal = classifySpawnFailure(
      'No conversation found with session ID: 5f2c1b90; retry after 60 seconds',
      1,
      'phase-7',
      { resuming: true },
    )
    expect(refusal.kind).toBe('stale_session')
    // Not a wait: the answer is one retry on a fresh session, now (§15.4).
    expect(refusal.retryAfter).toBe(undefined)
    expect(refusal.message.includes('phase-7')).toBe(true)
    expect(refusal.message.includes('resume-session-unknown')).toBe(true)
    expect(refusal.message.toLowerCase().includes('5f2c1b90')).toBe(false)
  })

  it('never attaches a retry time to fatal, which is not a wait', () => {
    const refusal = classifySpawnFailure('not logged in; retry after 60 seconds', 1, 'n', {
      now: new Date(),
    })
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

    const previous = process.env['VINTA_AI_MAESTRO_CLAUDE_BIN']
    process.env['VINTA_AI_MAESTRO_CLAUDE_BIN'] = '/opt/from-env'
    try {
      expect(new ClaudeCodeAdapter().bin).toBe('/opt/from-env')
      delete process.env['VINTA_AI_MAESTRO_CLAUDE_BIN']
      expect(new ClaudeCodeAdapter().bin).toBe('claude')
    } finally {
      if (previous === undefined) delete process.env['VINTA_AI_MAESTRO_CLAUDE_BIN']
      else process.env['VINTA_AI_MAESTRO_CLAUDE_BIN'] = previous
    }
  })
})

describe('preflight against a fake binary', () => {
  it('reports not installed, with the command that installs it', async () => {
    const missing = join(makeTemp(), 'definitely-not-here')
    const result = await new ClaudeCodeAdapter({ bin: missing }).preflight()
    expect(result.installed).toBe(false)
    expect(result.authenticated).toBe(false)
    expect(result.hint?.includes('VINTA_AI_MAESTRO_CLAUDE_BIN')).toBe(true)
  })

  it('reports not installed when the binary exists but cannot answer --version', async () => {
    // No `version` in the spec at all: this fake refuses `--version` the way a
    // half-installed CLI does, which is a different state from having no file.
    const bin = fakeBin({ exit: 1 })
    const result = await new ClaudeCodeAdapter({ bin }).preflight()
    expect(result.installed).toBe(false)
  })

  it('distinguishes a logged-out CLI from a missing one, with the login command', async () => {
    const bin = fakeBin({
      version: VERSION,
      stderr: ['Invalid API key · Please run /login'],
      exit: 1,
    })
    const result = await new ClaudeCodeAdapter({ bin }).preflight()
    expect(result.installed).toBe(true)
    expect(result.authenticated).toBe(false)
    expect(result.version).toBe(VERSION)
    expect(result.hint).toBe(`${bin} /login`)
  })

  it('reports ready when the CLI starts a session', async () => {
    const bin = fakeBin({
      version: VERSION,
      stdout: ['{"type":"system","subtype":"init","session_id":"probe"}'],
    })
    const result = await new ClaudeCodeAdapter({ bin }).preflight()
    expect(result).toEqual({ installed: true, authenticated: true, version: VERSION })
  })

  it('does not call an unfamiliar diagnostic a login failure', async () => {
    const bin = fakeBin({ version: VERSION, stderr: ['warning: config file is new'], exit: 2 })
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
    const bin = fakeBin({
      version: VERSION,
      // Read the prompt off stdin the way the real CLI does, then play a run.
      readsLine: true,
      stdout: [
        '{"type":"system","subtype":"init","session_id":"sess-fake"}',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}',
        '{"type":"unknown_future_frame"}',
        '{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":3,"output_tokens":4},"total_cost_usd":0.01}',
      ],
    })
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

  /**
   * The grant and its guard reach the CLI as arguments, so the assertion is
   * about argv and nothing else.
   *
   * Worth pinning because the failure is invisible: `--add-dir` lifts the
   * working-directory boundary in both directions, so a `--settings` that went
   * missing would not break a run — it would quietly give every agent write
   * access to the operator's checkout and to every sibling lane.
   */
  it('grants the read roots and denies writing in them', async () => {
    const dir = makeTemp()
    const lane = join(dir, 'lanes', 'mine')
    mkdirSync(lane, { recursive: true })
    const bin = fakeCliFromSource(
      dir,
      'claude-argv',
      `import { writeFileSync } from 'node:fs'
if (process.argv.includes('--version')) { console.log(${JSON.stringify(VERSION)}); process.exit(0) }
writeFileSync(${JSON.stringify(join(dir, 'argv.json'))}, JSON.stringify(process.argv.slice(2)))
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-argv' }))
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }))
`,
    )

    const outcome = await new ClaudeCodeAdapter({
      bin,
      readRoots: [dir],
      settingsDir: join(dir, 'settings'),
    }).spawn({ ...task(), cwd: lane })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    for await (const _event of outcome.session.events) void _event

    const argv = JSON.parse(readFileSync(join(dir, 'argv.json'), 'utf8')) as string[]
    expect(argv).toContain('--add-dir')
    expect(argv[argv.indexOf('--add-dir') + 1]).toBe(dir)

    // A path, never the policy itself. On Windows every spawn goes through
    // `cmd.exe`, where a `"` cannot survive a quoted region — `platform.ts`
    // refuses such an argument rather than escaping it, so a JSON argument is
    // a spawn that dies before the binary is reached.
    const settingsPath = argv[argv.indexOf('--settings') + 1] as string
    expect(argv.some((token) => token.includes('"'))).toBe(false)
    // The exact check Windows applies, run from anywhere: `commandInvocation`
    // refuses a token it cannot quote instead of escaping it, so this throwing
    // is the spawn dying before the binary is reached. It is how the JSON
    // version of this failed, on one platform, with 13ms and no output.
    expect(() => commandInvocation('claude', argv, 'win32')).not.toThrow()

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      permissions: { deny: string[] }
    }
    // The corridor: the fake's own directory is denied, the lane is not.
    expect(settings.permissions.deny.some((rule) => rule.includes('claude-argv'))).toBe(true)
    expect(settings.permissions.deny.some((rule) => rule.includes('mine'))).toBe(false)
  })

  /** No roots, no grant — and therefore no policy that could contradict one. */
  it('passes neither when nothing is granted', async () => {
    const dir = makeTemp()
    const bin = fakeCliFromSource(
      dir,
      'claude-bare',
      `import { writeFileSync } from 'node:fs'
if (process.argv.includes('--version')) { console.log(${JSON.stringify(VERSION)}); process.exit(0) }
writeFileSync(${JSON.stringify(join(dir, 'bare.json'))}, JSON.stringify(process.argv.slice(2)))
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-bare' }))
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }))
`,
    )

    const outcome = await new ClaudeCodeAdapter({ bin }).spawn(task())
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    for await (const _event of outcome.session.events) void _event

    const argv = JSON.parse(readFileSync(join(dir, 'bare.json'), 'utf8')) as string[]
    expect(argv).not.toContain('--add-dir')
    expect(argv).not.toContain('--settings')
  })

  /**
   * The vendor reports `is_error: false` for a turn it has just said was
   * blocked: from its side nothing went wrong — it was asked for something it
   * could not do and said so. From this side the turn produced nothing, and
   * reporting it as a clean end is what let a phase pass having written no code
   * and then fail two steps later under another name.
   *
   * It matters beyond the record: a reviewer's verdict is read back out of the
   * transcript, and a session that did not end `ok` falls back to `fail` rather
   * than to whatever the tail happens to contain.
   */
  it('does not end ok when the turn reported an error', async () => {
    const bin = fakeBin({
      version: VERSION,
      readsLine: true,
      stdout: [
        '{"type":"system","subtype":"init","session_id":"sess-blocked"}',
        '{"type":"system","subtype":"permission_denied","tool_name":"Read","decision_reason_type":"workingDir"}',
        '{"type":"system","subtype":"post_turn_summary","status_category":"blocked"}',
        // The vendor's own verdict on the same turn.
        '{"type":"result","subtype":"success","is_error":false}',
      ],
    })

    const outcome = await new ClaudeCodeAdapter({ bin }).spawn(task())
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const seen: AgentEvent[] = []
    for await (const event of outcome.session.events) seen.push(event)

    expect(seen).toEqual([
      { type: 'session_started', sessionId: 'sess-blocked' },
      { type: 'permission_denied', tool: 'Read', reason: 'workingDir' },
      { type: 'error', message: 'claude-code: the turn ended blocked' },
      { type: 'session_ended', result: 'error' },
    ])
  })

  /** The ordinary path is untouched: no error, no reinterpretation. */
  it('still ends ok when nothing went wrong', async () => {
    const bin = fakeBin({
      version: VERSION,
      readsLine: true,
      stdout: [
        '{"type":"system","subtype":"init","session_id":"sess-fine"}',
        '{"type":"system","subtype":"post_turn_summary","status_category":"completed"}',
        '{"type":"result","subtype":"success","is_error":false}',
      ],
    })

    const outcome = await new ClaudeCodeAdapter({ bin }).spawn(task())
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const seen: AgentEvent[] = []
    for await (const event of outcome.session.events) seen.push(event)

    expect(seen.at(-1)).toEqual({ type: 'session_ended', result: 'ok' })
  })

  it('classifies a CLI that refuses before announcing a session', async () => {
    const bin = fakeBin({
      version: VERSION,
      // The vendor's own wording, byte for byte: the reset time is parsed back
      // out of this line, so paraphrasing it would test nothing.
      stderr: ['Claude usage limit reached. Resets at 2026-01-01T15:30:00Z'],
      exit: 1,
    })
    const outcome = await new ClaudeCodeAdapter({ bin }).spawn(task())
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.kind).toBe('quota')
    expect(outcome.retryAfter?.toISOString()).toBe('2026-01-01T15:30:00.000Z')
  })

  it('classifies a refused resume as stale only when the task carried the id', async () => {
    // The wiring §15.4 turns on, through a real process: the identical CLI
    // failure is a stale token only for the spawn that offered one. Without
    // it there was nothing to expire, so it keeps its ordinary reading.
    const bin = fakeBin({
      version: VERSION,
      // `readsLine` rather than a read to EOF: this adapter keeps stdin open
      // for injection, so a fake that waits for EOF waits forever.
      readsLine: true,
      stderr: ['No conversation found with session ID: 5f2c1b90'],
      exit: 1,
    })
    const adapter = new ClaudeCodeAdapter({ bin })

    const resumed = await adapter.spawn({ ...task(), resumeSessionId: '5f2c1b90' })
    expect(resumed.ok === false && resumed.kind).toBe('stale_session')

    const cold = await adapter.spawn(task())
    expect(cold.ok === false && cold.kind).toBe('fatal')
  })

  it('classifies a binary that is not there at all', async () => {
    const outcome = await new ClaudeCodeAdapter({ bin: join(makeTemp(), 'nope') }).spawn(task())
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.kind).toBe('fatal')
  })

  it('ends the stream once when the CLI dies mid-turn', async () => {
    const bin = fakeBin({
      version: VERSION,
      readsLine: true,
      stdout: ['{"type":"system","subtype":"init","session_id":"sess-dies"}'],
      exit: 3,
    })
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
    for (const kind of [
      'rate_limit',
      'concurrency',
      'quota',
      'transient',
      'stale_session',
      'fatal',
    ] as const) {
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
    : `no Claude Code binary at "${liveAdapter.bin}" — set VINTA_AI_MAESTRO_CLAUDE_BIN`
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
      // The contract detaches every handle it opens, so unlike sessions these
      // need no recording — `detach` is what proves there is no orphan.
      attachPty: (sessionId, attach) => real.attachPty(sessionId, attach),
    }
    const task: AgentTask = {
      nodeId: 'contract',
      cwd: makeTemp(),
      prompt: 'Reply with exactly: ok',
      model: 'haiku',
    }
    return {
      adapter,
      // A measured live turn drains in ~3.4s, which leaves too little margin
      // under the default 5s deadline once the network is slow — the same
      // ~1.5s gap that made the codex live suite flake. The deadline still
      // exists to fail fast on a genuinely hung stream; it just isn't sized
      // to a good day.
      hangMs: 30_000,
      task,
      // A well-formed id no account has ever been issued, which is the only
      // way to observe the real CLI's wording for a session it does not have
      // (§15.4). Where the vendor changes that wording this is the test that
      // says so — the pattern table cannot notice on its own.
      staleResumeTask: { ...task, resumeSessionId: UNISSUED_SESSION },
      forceRefusal: real.refuseNext.bind(real),
      dispose: async () => {
        for (const session of started) await session.kill()
      },
    }
  })
}
