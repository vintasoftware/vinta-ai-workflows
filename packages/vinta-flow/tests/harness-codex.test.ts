/**
 * Two suites in one file, deliberately — the shape `harness-claude-code.test.ts`
 * established.
 *
 * The unit suite is the one that actually protects this adapter: it drives the
 * JSONL mapping, the stream framing, the refusal table and `preflight` over
 * synthetic CLI output and shell scripts written into a temp dir, and it runs
 * everywhere — no CLI, no login, no tokens spent.
 *
 * The live suite runs `runAdapterContract` against the real CLI and skips
 * itself when `preflight` says the binary is missing or logged out. It must
 * never fail a suite on a machine without an authenticated `codex`, which
 * includes CI.
 *
 * The synthetic frames below are transcribed from a real `codex exec --json`
 * run (codex-cli 0.147.0), including the failure frames — guessing at a vendor
 * schema is how an adapter passes its own tests and none of the vendor's.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  type AgentEvent,
  type AgentSession,
  type AgentTask,
  HarnessCapabilityError,
  type HarnessAdapter,
} from '../src/harness/adapter.ts'
import { CodexAdapter, classifySpawnFailure, mapCliEvent } from '../src/harness/codex.ts'
import { runAdapterContract } from '../src/harness/contract.ts'
import { JsonLines, parseRetryAfter } from '../src/harness/shared.ts'
import { POSIX_SHELL_FIXTURES } from './support/platform.ts'

const temps: string[] = []

const makeTemp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-flow-codex-'))
  temps.push(dir)
  return dir
}

// Cleanup runs even when a test above it threw: a failing run must not leave
// fake binaries behind in the system temp dir.
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

const fakeBin = (body: string): string => {
  const path = join(makeTemp(), 'codex-fake')
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

const VERSION_CASE = `case "$1" in --version) echo "codex-cli 0.147.0"; exit 0;; esac`
const LOGGED_IN = `case "$1$2" in loginstatus) echo "Logged in using ChatGPT"; exit 0;; esac`

/** Well-formed and never issued: the shape of a thread id the vendor has forgotten. */
const UNISSUED_SESSION = '00000000-0000-4000-8000-000000000000'

// ---------------------------------------------------------------------------

describe('JsonLines framing', () => {
  it('reassembles an object split across chunk boundaries', () => {
    const lines = new JsonLines()
    expect(lines.push('{"type":"thread.st')).toEqual([])
    expect(lines.push('arted","thread_')).toEqual([])
    expect(lines.push('id":"01a0-89cd"}\n')).toEqual([
      { type: 'thread.started', thread_id: '01a0-89cd' },
    ])
  })

  it('emits several frames from one chunk and holds an unterminated tail', () => {
    const lines = new JsonLines()
    expect(lines.push('{"a":1}\n{"b":2}\n{"c":')).toEqual([{ a: 1 }, { b: 2 }])
    expect(lines.push('3}\n')).toEqual([{ c: 3 }])
  })

  it('drops blank lines and non-JSON noise without throwing', () => {
    const lines = new JsonLines()
    expect(lines.push('\n\nReading additional input from stdin...\n{"ok":true}\n')).toEqual([
      { ok: true },
    ])
  })
})

describe('CLI frame mapping', () => {
  it('maps the thread frame to a session start', () => {
    expect(mapCliEvent({ type: 'thread.started', thread_id: 't-1' })).toEqual([
      { type: 'session_started', sessionId: 't-1' },
    ])
  })

  it('ignores the turn frame that only says a turn began', () => {
    expect(mapCliEvent({ type: 'turn.started' })).toEqual([])
  })

  it('maps a completed agent message and a completed reasoning item', () => {
    expect(
      mapCliEvent({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'ok' } }),
    ).toEqual([{ type: 'assistant_text', text: 'ok' }])
    expect(
      mapCliEvent({ type: 'item.completed', item: { id: 'item_1', type: 'reasoning', text: 'weighing' } }),
    ).toEqual([{ type: 'thinking', text: 'weighing' }])
  })

  it('opens a command execution on item.started and closes it on item.completed', () => {
    const started = {
      id: 'item_1',
      type: 'command_execution',
      command: '/bin/zsh -lc ls',
      aggregated_output: '',
      exit_code: null,
      status: 'in_progress',
    }
    expect(mapCliEvent({ type: 'item.started', item: started })).toEqual([
      { type: 'tool_use', id: 'item_1', name: 'command_execution', input: started },
    ])
    expect(
      mapCliEvent({
        type: 'item.completed',
        item: { ...started, aggregated_output: 'a.txt\n', exit_code: 0, status: 'completed' },
      }),
    ).toEqual([{ type: 'tool_result', id: 'item_1', ok: true, summary: 'a.txt\n' }])
  })

  it('maps a non-zero exit and a failed status to a tool result that is not ok', () => {
    const fail = (item: Record<string, unknown>): boolean => {
      const event = mapCliEvent({ type: 'item.completed', item })[0]
      return event?.type === 'tool_result' ? event.ok : true
    }
    expect(fail({ id: 'c', type: 'command_execution', exit_code: 2, status: 'completed' })).toBe(false)
    expect(fail({ id: 'c', type: 'command_execution', exit_code: 0, status: 'failed' })).toBe(false)
  })

  it('names an MCP call after the tool it called', () => {
    const item = { id: 'm1', type: 'mcp_tool_call', server: 'figma', tool: 'read_page', status: 'in_progress' }
    expect(mapCliEvent({ type: 'item.started', item })).toEqual([
      { type: 'tool_use', id: 'm1', name: 'figma.read_page', input: item },
    ])
  })

  it('drops item.updated, which is progress on a call already announced', () => {
    expect(
      mapCliEvent({
        type: 'item.updated',
        item: { id: 'item_1', type: 'command_execution', aggregated_output: 'partial' },
      }),
    ).toEqual([])
  })

  it('maps the terminal turn frame to usage plus a session end', () => {
    expect(
      mapCliEvent({
        type: 'turn.completed',
        usage: {
          input_tokens: 17960,
          cached_input_tokens: 11264,
          cache_write_input_tokens: 0,
          output_tokens: 5,
          reasoning_output_tokens: 0,
        },
      }),
    ).toEqual([
      // Codex prices nothing, so `costUsd` is absent rather than guessed.
      //
      // `input` is 17960 − 11264: this vendor's `input_tokens` is the *whole*
      // prompt with the cached part inside it, where Anthropic's is the fresh
      // remainder with the cache counted beside it (§15.6). Carried through
      // raw, a cross-harness token sum would mean two different things at
      // once, and a cache-read share computed from it would be wrong by
      // exactly the cached prefix. The subtraction is what makes `input` mean
      // the same thing in all three adapters.
      { type: 'usage', input: 6696, output: 5, cacheRead: 11264, cacheWrite: 0 },
      { type: 'session_ended', result: 'ok' },
    ])
  })

  it('omits a cache counter the CLI did not send rather than reporting a zero', () => {
    // Unknown is not zero (§15.6): a turn that reported no cache figures must
    // not aggregate as one that achieved a 0% hit rate.
    const [usage] = mapCliEvent({
      type: 'turn.completed',
      usage: { input_tokens: 900, output_tokens: 30 },
    })
    expect(usage).toEqual({ type: 'usage', input: 900, output: 30 })
    expect(usage).not.toHaveProperty('cacheRead')
    expect(usage).not.toHaveProperty('cacheWrite')
  })

  it('never reports a negative token count when the vendor’s own figures disagree', () => {
    // The subtraction is floored. A vendor is not owed arithmetic consistency,
    // and a negative count would poison every total it is summed into.
    expect(
      mapCliEvent({
        type: 'turn.completed',
        usage: { input_tokens: 10, cached_input_tokens: 40, output_tokens: 1 },
      })[0],
    ).toEqual({ type: 'usage', input: 0, output: 1, cacheRead: 40 })
  })

  it('maps a failed turn to an error carrying only a classified reason token', () => {
    const events = mapCliEvent({
      type: 'turn.failed',
      error: { message: '{"type":"error","status":429,"error":{"message":"rate limit exceeded"}}' },
    })
    expect(events).toEqual([
      { type: 'error', message: 'codex: rate-limited' },
      { type: 'session_ended', result: 'error' },
    ])
  })

  it('never lets vendor prose reach an error event', () => {
    const prose = "The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account."
    const fromStream = mapCliEvent({ type: 'error', message: prose })
    const fromItem = mapCliEvent({ type: 'item.completed', item: { id: 'e', type: 'error', message: prose } })
    for (const events of [fromStream, fromItem]) {
      expect(events).toEqual([{ type: 'error', message: 'codex: unclassified' }])
    }
  })

  it('ignores frame types, item types and malformed frames it has never seen', () => {
    expect(mapCliEvent({ type: 'a_variant_shipped_next_year', payload: 1 })).toEqual([])
    expect(mapCliEvent({ type: 'item.completed', item: { id: 'x', type: 'todo_list', items: [] } })).toEqual([])
    expect(mapCliEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'no id' } })).toEqual([])
    expect(mapCliEvent({ type: 'thread.started' })).toEqual([])
    expect(mapCliEvent({ type: 'item.started', item: 'not an object' })).toEqual([])
    expect(mapCliEvent(null)).toEqual([])
    expect(mapCliEvent('a bare string')).toEqual([])
    expect(mapCliEvent([1, 2, 3])).toEqual([])
  })

  it('maps a whole recorded run end to end through the framer', () => {
    const transcript = [
      '{"type":"thread.started","thread_id":"01a089cd-a59f-7801-a868-97dffc90d029"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I will inspect the directory."}}',
      '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc ls","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc ls","aggregated_output":"a.txt\\n","exit_code":0,"status":"completed"}}',
      '{"type":"a_variant_shipped_next_year"}',
      '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"The file name is a.txt."}}',
      '{"type":"turn.completed","usage":{"input_tokens":35676,"cached_input_tokens":28800,"output_tokens":108}}',
      '',
    ].join('\n')

    const lines = new JsonLines()
    const events: AgentEvent[] = []
    // Byte-at-a-time is the worst framing a pipe can hand you; it must not
    // change the result at all.
    for (const char of transcript) {
      for (const frame of lines.push(char)) events.push(...mapCliEvent(frame))
    }

    expect(events.map((e) => e.type)).toEqual([
      'session_started',
      'assistant_text',
      'tool_use',
      'tool_result',
      'assistant_text',
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
    expect(kindOf('Error: spawn codex ENOENT', null)).toBe('fatal')
    expect(kindOf('/bin/sh: codex: command not found', 127)).toBe('fatal')
  })

  it('calls a logged-out CLI fatal', () => {
    expect(kindOf('Not logged in. Run `codex login`.')).toBe('fatal')
    expect(kindOf('401 Unauthorized')).toBe('fatal')
    expect(kindOf('OAuth token has expired')).toBe('fatal')
  })

  it('calls a directory codex will not run in fatal, since waiting cannot fix it', () => {
    expect(kindOf('Not inside a trusted directory and --skip-git-repo-check was not specified.')).toBe(
      'fatal',
    )
  })

  it('calls an exhausted usage window quota, not fatal', () => {
    expect(kindOf("You've hit your usage limit. Try again in 2 hours.")).toBe('quota')
    expect(kindOf('insufficient_quota')).toBe('quota')
  })

  it('calls a rate limit a rate limit', () => {
    expect(kindOf('{"status":429,"error":{"type":"rate_limit_error"}}')).toBe('rate_limit')
    expect(kindOf('Too many requests, slow down')).toBe('rate_limit')
  })

  it('calls a per-account session cap concurrency', () => {
    expect(kindOf('too many concurrent sessions for this account')).toBe('concurrency')
    expect(kindOf('Maximum concurrent turns reached')).toBe('concurrency')
  })

  it('calls an upstream hiccup transient', () => {
    expect(kindOf('stream disconnected before completion')).toBe('transient')
    expect(kindOf('503 Service Unavailable')).toBe('transient')
    expect(kindOf('fetch failed: ECONNRESET')).toBe('transient')
  })

  it('defaults an unrecognized failure to fatal rather than an unbounded wait', () => {
    expect(kindOf("The 'gpt-5.4-mini' model is not supported", 1)).toBe('fatal')
    expect(kindOf('something nobody has ever seen', 3)).toBe('fatal')
  })

  it('calls a refused resume stale — but only where a session id was carried', () => {
    // §15.4's rule in both directions. Codex names the thing three ways
    // depending on which layer answers, and none of them is stale when there
    // was no token to expire.
    for (const prose of [
      'Error: thread not found: 5f2c1b90',
      'no session found for the given id',
      'could not load rollout for 5f2c1b90',
    ]) {
      expect(classifySpawnFailure(prose, 1, 'phase-1', { resuming: true }).kind).toBe(
        'stale_session',
      )
      expect(kindOf(prose)).toBe('fatal')
    }
  })

  it('reads a stale session ahead of a pattern that would otherwise match it', () => {
    // Why the row is hoisted rather than merely listed: read as `transient`,
    // a forgotten session would be waited on forever — it does not come back.
    const prose = 'stream disconnected: thread not found'
    expect(classifySpawnFailure(prose, 1, 'phase-1', { resuming: true }).kind).toBe('stale_session')
    expect(kindOf(prose)).toBe('transient')
  })

  it('never waits on a stale session, and never quotes the vendor about one', () => {
    const refusal = classifySpawnFailure(
      'thread not found: 5f2c1b90; retry after 60 seconds',
      1,
      'phase-7',
      { resuming: true },
    )
    expect(refusal.kind).toBe('stale_session')
    // Not a wait: the answer is one retry on a fresh session, now (§15.4).
    expect(refusal.retryAfter).toBe(undefined)
    expect(refusal.message.includes('resume-session-unknown')).toBe(true)
    expect(refusal.message.includes('5f2c1b90')).toBe(false)
  })

  it('never puts vendor prose in the refusal message', () => {
    const refusal = classifySpawnFailure("You've hit your usage limit", 1, 'phase-7')
    expect(refusal.message.includes('phase-7')).toBe(true)
    expect(refusal.message.toLowerCase().includes('usage limit')).toBe(false)
  })

  it('carries a reported reset time and omits it when none was reported', () => {
    const now = new Date('2026-01-01T10:00:00.000Z')
    const withReset = classifySpawnFailure(
      "You've hit your usage limit. Try again in 2 hours 30 minutes.",
      1,
      'phase-1',
      { now },
    )
    expect(withReset.retryAfter?.toISOString()).toBe('2026-01-01T12:30:00.000Z')
    expect(classifySpawnFailure('429 rate limit', 1, 'phase-1', { now }).retryAfter).toBe(undefined)
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
  })

  it('reads codex’s relative phrasing, including a compound duration', () => {
    expect(parseRetryAfter('try again in 45 seconds', now)?.toISOString()).toBe(
      '2026-01-01T10:00:45.000Z',
    )
    expect(parseRetryAfter('try again in 1 hour 5 min', now)?.toISOString()).toBe(
      '2026-01-01T11:05:00.000Z',
    )
  })

  it('reads an ISO and an epoch reset field', () => {
    expect(parseRetryAfter('resets at 2026-01-01T15:30:00Z', now)?.toISOString()).toBe(
      '2026-01-01T15:30:00.000Z',
    )
    expect(parseRetryAfter('{"resets_at":1767283200}', now)?.toISOString()).toBe(
      '2026-01-01T16:00:00.000Z',
    )
  })

  it('reads a wall-clock reset and rolls it forward when it has passed', () => {
    const local = new Date('2026-01-01T12:00:00')
    expect(parseRetryAfter('Your limit will reset at 3pm', local)?.getHours()).toBe(15)
    const late = new Date('2026-01-01T16:00:00')
    expect(parseRetryAfter('Your limit will reset at 3pm', late)?.getDate()).toBe(2)
  })

  it('reports nothing when the vendor said nothing', () => {
    expect(parseRetryAfter('overloaded', now)).toBe(undefined)
  })
})

// ---------------------------------------------------------------------------

describe('declared capabilities', () => {
  it('declares injection false, which is what §7 says codex exec can do', () => {
    expect(new CodexAdapter().capabilities.inject).toBe(false)
    expect(new CodexAdapter().capabilities.interrupt).toBe(true)
    expect(new CodexAdapter().capabilities.resume).toBe(true)
    expect(new CodexAdapter().capabilities.pty).toBe(true)
  })
})

describe('binary resolution', () => {
  it('prefers the option, then the env var, then the bare name', () => {
    expect(new CodexAdapter({ bin: '/opt/codex-work' }).bin).toBe('/opt/codex-work')

    const previous = process.env['VINTA_FLOW_CODEX_BIN']
    process.env['VINTA_FLOW_CODEX_BIN'] = '/opt/from-env'
    try {
      expect(new CodexAdapter().bin).toBe('/opt/from-env')
      delete process.env['VINTA_FLOW_CODEX_BIN']
      expect(new CodexAdapter().bin).toBe('codex')
    } finally {
      if (previous === undefined) delete process.env['VINTA_FLOW_CODEX_BIN']
      else process.env['VINTA_FLOW_CODEX_BIN'] = previous
    }
  })
})

describe.runIf(POSIX_SHELL_FIXTURES)('preflight against a fake binary', () => {
  it('reports not installed, with the command that installs it', async () => {
    const missing = join(makeTemp(), 'definitely-not-here')
    const result = await new CodexAdapter({ bin: missing }).preflight()
    expect(result.installed).toBe(false)
    expect(result.authenticated).toBe(false)
    expect(result.hint?.includes('VINTA_FLOW_CODEX_BIN')).toBe(true)
  })

  it('reports not installed when the binary exists but cannot answer --version', async () => {
    const result = await new CodexAdapter({ bin: fakeBin('exit 1') }).preflight()
    expect(result.installed).toBe(false)
  })

  it('distinguishes a logged-out CLI from a missing one, with the login command', async () => {
    const bin = fakeBin(`${VERSION_CASE}\necho 'Not logged in'\nexit 1`)
    const result = await new CodexAdapter({ bin }).preflight()
    expect(result.installed).toBe(true)
    expect(result.authenticated).toBe(false)
    expect(result.version).toBe('codex-cli 0.147.0')
    expect(result.hint).toBe(`${bin} login`)
  })

  it('reports ready when the CLI says it is logged in', async () => {
    const bin = fakeBin(`${VERSION_CASE}\n${LOGGED_IN}\nexit 0`)
    expect(await new CodexAdapter({ bin }).preflight()).toEqual({
      installed: true,
      authenticated: true,
      version: 'codex-cli 0.147.0',
    })
  })

  it('does not call an unfamiliar diagnostic a login failure', async () => {
    const bin = fakeBin(`${VERSION_CASE}\necho 'error: unrecognized subcommand' >&2\nexit 2`)
    expect((await new CodexAdapter({ bin }).preflight()).authenticated).toBe(true)
  })
})

describe.runIf(POSIX_SHELL_FIXTURES)('spawn against a fake binary', () => {
  const task = (): AgentTask => ({
    nodeId: 'phase-1',
    cwd: makeTemp(),
    prompt: 'implement the widget model',
    model: 'gpt-5.2-codex',
  })

  const scripted = (...lines: string[]): string =>
    fakeBin(
      [
        `${VERSION_CASE}`,
        // Drain the prompt off stdin the way the real CLI does, then play a run.
        'cat > /dev/null',
        ...lines,
      ].join('\n'),
    )

  it('drives a whole scripted run into the normalized stream', async () => {
    const bin = scripted(
      `echo '{"type":"thread.started","thread_id":"thread-fake"}'`,
      `echo '{"type":"turn.started"}'`,
      `echo '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"working"}}'`,
      `echo '{"type":"unknown_future_frame"}'`,
      `echo '{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":4}}'`,
      'exit 0',
    )
    const outcome = await new CodexAdapter({ bin }).spawn(task())
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(outcome.session.id).toBe('thread-fake')
    const seen: AgentEvent[] = []
    for await (const event of outcome.session.events) seen.push(event)
    expect(seen).toEqual([
      { type: 'session_started', sessionId: 'thread-fake' },
      { type: 'assistant_text', text: 'working' },
      { type: 'usage', input: 3, output: 4 },
      { type: 'session_ended', result: 'ok' },
    ])
  })

  it('rejects send with a capability error instead of silently dropping the message', async () => {
    const bin = scripted(
      `echo '{"type":"thread.started","thread_id":"thread-quiet"}'`,
      // Still running when the send lands, which is the case that matters.
      'sleep 5',
    )
    const outcome = await new CodexAdapter({ bin }).spawn(task())
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    let rejected: unknown
    await outcome.session.send('also update the changelog').catch((error: unknown) => {
      rejected = error
    })
    expect(rejected instanceof HarnessCapabilityError).toBe(true)
    expect((rejected as HarnessCapabilityError).capability).toBe('inject')

    await outcome.session.kill()
    const seen: AgentEvent[] = []
    for await (const event of outcome.session.events) seen.push(event)
    // And nothing that looks like the message got into the transcript.
    expect(seen.some((e) => e.type === 'user_message')).toBe(false)
    expect(seen[seen.length - 1]).toEqual({ type: 'session_ended', result: 'interrupted' })
    // Spawns a real codex process: ~1s alone, but it sat exactly on vitest's
    // 5s default and flaked about one run in four under parallel load.
  }, 60_000)

  it('classifies a CLI that refuses before announcing a thread', async () => {
    const bin = fakeBin(
      `${VERSION_CASE}\ncat > /dev/null\necho "You've hit your usage limit. Try again in 2 hours." >&2\nexit 1`,
    )
    const now = Date.now()
    const outcome = await new CodexAdapter({ bin }).spawn(task())
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.kind).toBe('quota')
    const waitMs = (outcome.retryAfter?.getTime() ?? 0) - now
    expect(waitMs >= 7_200_000 && waitMs < 7_260_000).toBe(true)
  })

  it('classifies a refused resume as stale only when the task carried the id', async () => {
    // The wiring §15.4 turns on, through a real process: the identical CLI
    // failure is a stale token only for the spawn that offered one. Without
    // it there was nothing to expire, so it keeps its ordinary reading.
    const bin = fakeBin(
      `${VERSION_CASE}\ncat > /dev/null\necho 'Error: thread not found: 5f2c1b90' >&2\nexit 1`,
    )
    const adapter = new CodexAdapter({ bin })

    const resumed = await adapter.spawn({ ...task(), resumeSessionId: '5f2c1b90' })
    expect(resumed.ok === false && resumed.kind).toBe('stale_session')

    const cold = await adapter.spawn(task())
    expect(cold.ok === false && cold.kind).toBe('fatal')
  })

  it('classifies a binary that is not there at all', async () => {
    const outcome = await new CodexAdapter({ bin: join(makeTemp(), 'nope') }).spawn(task())
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.kind).toBe('fatal')
  })

  it('ends the stream once when the CLI dies mid-turn', async () => {
    const bin = scripted(`echo '{"type":"thread.started","thread_id":"thread-dies"}'`, 'exit 3')
    const outcome = await new CodexAdapter({ bin }).spawn(task())
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const seen: AgentEvent[] = []
    for await (const event of outcome.session.events) seen.push(event)
    expect(seen.filter((e) => e.type === 'session_ended').length).toBe(1)
    expect(seen[seen.length - 1]).toEqual({ type: 'session_ended', result: 'error' })
  })

  it('returns an injected refusal of every kind without starting a process', async () => {
    const adapter = new CodexAdapter({ bin: join(makeTemp(), 'never-run') })
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

/** Codex refuses to run outside a git repository it was not told to trust. */
const makeRepo = (): string => {
  const dir = makeTemp()
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

const liveAdapter = new CodexAdapter()
const live = await liveAdapter.preflight()

if (!live.installed || !live.authenticated) {
  const reason = live.installed
    ? `the CLI at "${liveAdapter.bin}" is not logged in — run \`${live.hint ?? ''}\` yourself`
    : `no codex binary at "${liveAdapter.bin}" — set VINTA_FLOW_CODEX_BIN`
  describe.skip(`harness adapter contract: codex (live) — skipped: ${reason}`, () => {
    it('is skipped', () => {})
  })
} else {
  runAdapterContract('codex (live)', { describe, it, expect }, () => {
    const real = new CodexAdapter()
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
      cwd: makeRepo(),
      prompt: 'Reply with exactly: ok',
      // Codex model slugs are account- and plan-gated, so the contract runs
      // on whatever this machine's CLI is configured to use.
      model: '',
    }
    return {
      adapter,
      task,
      // A well-formed id no account has ever been issued, which is the only
      // way to observe the real CLI's wording for a thread it does not have
      // (§15.4). Where the vendor changes that wording this is the test that
      // says so — the pattern table cannot notice on its own.
      staleResumeTask: { ...task, resumeSessionId: UNISSUED_SESSION },
      forceRefusal: real.refuseNext.bind(real),
      // A real codex turn is a network round trip plus CLI startup: roughly a
      // second to spawn and several more to drain. The contract's default
      // deadline leaves too little margin for a slow network, and it is this
      // adapter that needs the room, not the other two.
      hangMs: 30_000,
      dispose: async () => {
        for (const session of started) await session.kill()
      },
    }
  })
}
