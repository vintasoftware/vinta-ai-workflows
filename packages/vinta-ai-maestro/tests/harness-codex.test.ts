/**
 * Two suites in one file, deliberately — the shape `harness-claude-code.test.ts`
 * established.
 *
 * The unit suite is the one that actually protects this adapter: it drives the
 * notification mapping, the usage arithmetic, the refusal table, `preflight`,
 * and whole sessions against a fake `codex app-server` that speaks the
 * protocol over stdio (`support/fake-codex-app-server.ts`). It runs everywhere
 * — no CLI, no login, no tokens spent.
 *
 * The live suite runs `runAdapterContract` against the real CLI and skips
 * itself when `preflight` says the binary is missing or logged out. It must
 * never fail a suite on a machine without an authenticated `codex`, which
 * includes CI.
 *
 * The payloads below are transcribed from recorded app-server sessions
 * (codex-cli 0.147.0), including the failures — guessing at a vendor schema is
 * how an adapter passes its own tests and none of the vendor's.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AgentEvent, AgentSession, AgentTask, HarnessAdapter } from '../src/harness/adapter.ts'
import {
  CodexAdapter,
  type CodexAdapterOptions,
  classifySpawnFailure,
  mapNotification,
  turnRefusal,
  usageBetween,
  wakeMessage,
} from '../src/harness/codex.ts'
import { runAdapterContract } from '../src/harness/contract.ts'
import { AGENT_PERMISSIONS, codexThreadPolicy } from '../src/harness/permissions.ts'
import { operatorGuidance, parseRetryAfter } from '../src/harness/shared.ts'
import { type FakeCliSpec, fakeCli } from './support/fake-cli.ts'
import {
  FAKE_THREAD,
  type FakeAppServer,
  type FakeAppServerSpec,
  agentMessage,
  childTurn,
  command,
  fakeCodexAppServer,
  itemCompleted,
  itemStarted,
  reasoning,
  spawnAgent,
  threadStatus,
  tokenUsage,
  turnCompleted,
  turnStarted,
} from './support/fake-codex-app-server.ts'

const temps: string[] = []

const makeTemp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-codex-'))
  temps.push(dir)
  return dir
}

// Cleanup runs even when a test above it threw: a failing run must not leave
// fake binaries behind in the system temp dir.
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

/** A fake for `preflight`, which only ever runs `--version` and `login status`. */
const fakeBin = (spec: FakeCliSpec): string => fakeCli(makeTemp(), 'codex-fake', spec)

/** What this CLI answers `--version` with, which `preflight` reports verbatim. */
const VERSION = 'codex-cli 0.147.0'

/** Well-formed and never issued: the shape of a thread id the vendor has forgotten. */
const UNISSUED_SESSION = '00000000-0000-4000-8000-000000000000'

const notification = (method: string, params: Record<string, unknown>): unknown => ({ method, params })

// ---------------------------------------------------------------------------

describe('notification mapping', () => {
  const started = (item: Record<string, unknown>): AgentEvent[] =>
    mapNotification(notification('item/started', { item, threadId: 't', turnId: 'u' }))
  const completed = (item: Record<string, unknown>): AgentEvent[] =>
    mapNotification(notification('item/completed', { item, threadId: 't', turnId: 'u' }))

  it('maps a completed agent message and a completed reasoning item', () => {
    expect(completed(agentMessage('m1', 'ok'))).toEqual([{ type: 'assistant_text', text: 'ok' }])
    expect(completed(reasoning('r1', ['weighing', 'deciding']))).toEqual([
      { type: 'thinking', text: 'weighing\n\ndeciding' },
    ])
  })

  it('reads text only when an item is whole, never from its start or its deltas', () => {
    expect(started(agentMessage('m1', ''))).toEqual([])
    expect(
      mapNotification(notification('item/agentMessage/delta', { itemId: 'm1', delta: 'o' })),
    ).toEqual([])
    // Encrypted reasoning arrives empty and says nothing.
    expect(completed(reasoning('r1'))).toEqual([])
  })

  it('opens a command on item/started and closes it on item/completed, under the name the guard reads', () => {
    const open = command('exec-1', '42', 'ls')
    expect(started(open)).toEqual([{ type: 'tool_use', id: 'exec-1', name: 'command_execution', input: open }])
    expect(completed(command('exec-1', '42', 'ls', { exitCode: 0, output: 'a.txt\n' }))).toEqual([
      { type: 'tool_result', id: 'exec-1', ok: true, summary: 'a.txt\n' },
    ])
  })

  it('maps a non-zero exit, a failed status and a declined call to a result that is not ok', () => {
    const ok = (item: Record<string, unknown>): boolean => {
      const event = completed(item)[0]
      return event?.type === 'tool_result' ? event.ok : true
    }
    expect(ok({ id: 'c', type: 'commandExecution', exitCode: 2, status: 'completed' })).toBe(false)
    expect(ok({ id: 'c', type: 'commandExecution', exitCode: null, status: 'declined' })).toBe(false)
    expect(ok({ id: 'f', type: 'fileChange', changes: [], status: 'failed' })).toBe(false)
  })

  it('names an MCP call after the tool it called, and a sub-agent call after its tool', () => {
    const mcp = { id: 'm1', type: 'mcpToolCall', server: 'figma', tool: 'read_page', status: 'inProgress' }
    expect(started(mcp)).toEqual([{ type: 'tool_use', id: 'm1', name: 'figma.read_page', input: mcp }])
    const spawn = spawnAgent('s1', 'child', 'inProgress')
    expect(started(spawn)[0]).toMatchObject({ type: 'tool_use', name: 'spawn_agent' })
  })

  it('maps a compaction item to a compaction with no counts', () => {
    expect(completed({ type: 'contextCompaction', id: 'k1' })).toEqual([
      { type: 'context_compacted', trigger: 'auto' },
    ])
  })

  it('maps an error the server gave up on to a reason token, and ignores one it is retrying', () => {
    const error = {
      message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header',
      codexErrorInfo: 'other',
      additionalDetails: null,
    }
    expect(mapNotification(notification('error', { error, willRetry: true, threadId: 't', turnId: 'u' }))).toEqual([])
    expect(mapNotification(notification('error', { error, willRetry: false, threadId: 't', turnId: 'u' }))).toEqual([
      { type: 'error', message: 'codex: not-authenticated' },
    ])
  })

  it('never lets vendor prose reach an error event', () => {
    const prose = "The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account."
    const events = mapNotification(
      notification('error', { error: { message: prose, codexErrorInfo: 'badRequest' }, willRetry: false }),
    )
    expect(events).toEqual([{ type: 'error', message: 'codex: unclassified' }])
  })

  it('ignores methods, item types and malformed notifications it has never seen', () => {
    expect(mapNotification(notification('a/variant/shipped/next/year', { payload: 1 }))).toEqual([])
    expect(completed({ id: 'x', type: 'plan', text: 'step 1' })).toEqual([])
    expect(completed({ type: 'agentMessage', text: 'no id' })).toEqual([])
    expect(completed({ id: 'u', type: 'userMessage', content: [] })).toEqual([])
    expect(mapNotification(notification('item/started', { item: 'not an object' }))).toEqual([])
    expect(mapNotification({ method: 'item/started' })).toEqual([])
    expect(mapNotification(null)).toEqual([])
    expect(mapNotification('a bare string')).toEqual([])
    expect(mapNotification([1, 2, 3])).toEqual([])
  })
})

describe('usage between two running totals', () => {
  it('subtracts the cached prefix, so input is the fresh remainder in every adapter', () => {
    // §15.6. The OpenAI shape counts the cached prefix inside `inputTokens`;
    // carried through raw, a cross-harness sum would mean two things at once.
    expect(
      usageBetween(undefined, { input: 17960, cached: 11264, cacheWrite: 0, output: 5 }),
    ).toEqual({ type: 'usage', input: 6696, output: 5, cacheRead: 11264, cacheWrite: 0 })
  })

  it('reports only what was added since the last reading', () => {
    const first = { input: 19083, cached: 11008, cacheWrite: 0, output: 118 }
    const second = { input: 38307, cached: 29184, cacheWrite: 0, output: 123 }
    expect(usageBetween(first, second)).toEqual({
      type: 'usage',
      input: 1048,
      output: 5,
      cacheRead: 18176,
      cacheWrite: 0,
    })
  })

  it('reads a total that went down as a reset, never as negative usage', () => {
    const before = { input: 5000, cached: 4000, cacheWrite: 0, output: 300 }
    expect(usageBetween(before, { input: 100, cached: 0, cacheWrite: 0, output: 10 })).toEqual({
      type: 'usage',
      input: 100,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
    })
    // And a vendor whose own figures disagree is floored, not negative.
    expect(usageBetween(undefined, { input: 10, cached: 40, cacheWrite: 0, output: 1 })).toMatchObject({
      input: 0,
    })
  })
})

describe('the wake message', () => {
  it('names what finished by identifier, and nothing it printed', () => {
    const text = wakeMessage(
      [{ command: 'pnpm test --run', processId: '7', exitCode: 1 }],
      ['01a128fb-child'],
    )
    expect(text).toContain('`pnpm test --run` (session 7) exited with code 1')
    expect(text).toContain('write_stdin with session_id 7')
    expect(text).toContain('Sub-agent 01a128fb-child finished')
  })

  it('keeps a long command to one clipped line', () => {
    const text = wakeMessage([{ command: `run\n${'x'.repeat(500)}`, processId: '1', exitCode: null }], [])
    const line = text.split('\n').find((entry) => entry.includes('session 1')) ?? ''
    expect(line.includes('…')).toBe(true)
    expect(line).toContain('exited;')
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

  it('calls a CLI without the app server fatal, with its own reason', () => {
    const refusal = classifySpawnFailure("error: unrecognized subcommand 'app-server'", 2, 'phase-1')
    expect(refusal.kind).toBe('fatal')
    expect(refusal.message).toContain('app-server-unsupported')
  })

  // §6.1: a person logging in fixes this, and nothing else does — so it is
  // neither `fatal` (which fails the subtree) nor a wait (which retries).
  it('calls a logged-out CLI unauthenticated, for the operator', () => {
    expect(kindOf('Not logged in. Run `codex login`.')).toBe('unauthenticated')
    expect(kindOf('unexpected status 401 Unauthorized: Missing bearer')).toBe('unauthenticated')
    expect(kindOf('OAuth token has expired')).toBe('unauthenticated')
  })

  it('calls a directory codex will not run in fatal, since waiting cannot fix it', () => {
    expect(kindOf('Not inside a trusted directory and --skip-git-repo-check was not specified.')).toBe(
      'fatal',
    )
  })

  it('calls an exhausted usage window quota, by its prose or its structured code', () => {
    expect(kindOf("You've hit your usage limit. Try again in 2 hours.")).toBe('quota')
    expect(kindOf('insufficient_quota')).toBe('quota')
    expect(kindOf('stopped usageLimitExceeded')).toBe('quota')
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
    expect(kindOf('serverOverloaded')).toBe('transient')
  })

  it('defaults an unrecognized failure to fatal rather than an unbounded wait', () => {
    expect(kindOf("The 'gpt-5.4-mini' model is not supported", 1)).toBe('fatal')
    expect(kindOf('something nobody has ever seen', 3)).toBe('fatal')
  })

  it('calls a refused resume stale — but only where a session id was carried', () => {
    // §15.4's rule in both directions. The first line is the server's own
    // wording, recorded against an id it never issued.
    for (const prose of [
      `no rollout found for thread id ${UNISSUED_SESSION}`,
      'Error: thread not found: 5f2c1b90',
      'no session found for the given id',
    ]) {
      expect(classifySpawnFailure(prose, 1, 'phase-1', { resuming: true }).kind).toBe('stale_session')
      expect(kindOf(prose)).toBe('fatal')
    }
  })

  it('reads a stale session ahead of a pattern that would otherwise match it', () => {
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

  it('never attaches a retry time to a login refusal, which is not a wait', () => {
    const refusal = classifySpawnFailure('not logged in; retry after 60 seconds', 1, 'n', {
      now: new Date(),
    })
    expect(refusal.kind).toBe('unauthenticated')
    expect(refusal.retryAfter).toBe(undefined)
  })
})

/**
 * §6.1's other half: the window that closes while a turn is running, where
 * there is no spawn left to refuse.
 */
describe('a window that closes mid-turn', () => {
  // `Z`, like every other clock in this file: an absolute expectation beside
  // a zone-less string asserts the author's offset, not the parser.
  const now = new Date('2026-01-01T10:00:00.000Z')
  const prose = "You've hit your usage limit. Try again in 2 hours."

  it('reads an error the server gave up on, and a failed turn, alike', () => {
    for (const frame of [
      notification('error', { error: { message: prose, codexErrorInfo: 'usageLimitExceeded' }, willRetry: false }),
      notification('turn/completed', { threadId: 't', turn: { id: 'u', status: 'failed', error: { message: prose } } }),
    ]) {
      const refused = turnRefusal(frame, now)
      expect(refused?.kind).toBe('quota')
      expect(refused?.retryAfter?.toISOString()).toBe('2026-01-01T12:00:00.000Z')
    }
  })

  it('reads the structured code when the prose says nothing', () => {
    const frame = notification('error', {
      error: { message: 'stopped', codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } } },
      willRetry: false,
    })
    expect(turnRefusal(frame, now)?.kind).toBe('rate_limit')
  })

  it('reports nothing for a retry in progress, a completed turn, or a turn that failed on its own work', () => {
    expect(turnRefusal(notification('error', { error: { message: prose }, willRetry: true }), now)).toBe(
      undefined,
    )
    expect(
      turnRefusal(notification('turn/completed', { turn: { id: 'u', status: 'completed', error: null } }), now),
    ).toBe(undefined)
    expect(
      turnRefusal(
        notification('turn/completed', { turn: { id: 'u', status: 'failed', error: { message: 'the tests fail' } } }),
        now,
      ),
    ).toBe(undefined)
  })

  it('reports nothing for a fatal signal: a broken harness is not a wait', () => {
    expect(
      turnRefusal(notification('error', { error: { message: 'not logged in; run codex login' }, willRetry: false }), now),
    ).toBe(undefined)
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

  it('reports nothing when the vendor said nothing', () => {
    expect(parseRetryAfter('overloaded', now)).toBe(undefined)
  })
})

// ---------------------------------------------------------------------------

describe('declared capabilities', () => {
  it('declares injection and background work, which the app server makes possible', () => {
    const { capabilities } = new CodexAdapter()
    expect(capabilities.inject).toBe(true)
    expect(capabilities.backgroundWork).toBe(true)
    expect(capabilities.interrupt).toBe(true)
    expect(capabilities.resume).toBe(true)
    expect(capabilities.pty).toBe(true)
  })
})

describe('binary resolution', () => {
  it('prefers the option, then the env var, then the bare name', () => {
    expect(new CodexAdapter({ bin: '/opt/codex-work' }).bin).toBe('/opt/codex-work')

    const previous = process.env['VINTA_AI_MAESTRO_CODEX_BIN']
    process.env['VINTA_AI_MAESTRO_CODEX_BIN'] = '/opt/from-env'
    try {
      expect(new CodexAdapter().bin).toBe('/opt/from-env')
      delete process.env['VINTA_AI_MAESTRO_CODEX_BIN']
      expect(new CodexAdapter().bin).toBe('codex')
    } finally {
      if (previous === undefined) delete process.env['VINTA_AI_MAESTRO_CODEX_BIN']
      else process.env['VINTA_AI_MAESTRO_CODEX_BIN'] = previous
    }
  })
})

describe('preflight against a fake binary', () => {
  it('reports not installed, with the command that installs it', async () => {
    const missing = join(makeTemp(), 'definitely-not-here')
    const result = await new CodexAdapter({ bin: missing }).preflight()
    expect(result.installed).toBe(false)
    expect(result.authenticated).toBe(false)
    expect(result.hint?.includes('VINTA_AI_MAESTRO_CODEX_BIN')).toBe(true)
  })

  it('reports not installed when the binary exists but cannot answer --version', async () => {
    const result = await new CodexAdapter({ bin: fakeBin({ exit: 1 }) }).preflight()
    expect(result.installed).toBe(false)
  })

  it('distinguishes a logged-out CLI from a missing one, with the login command', async () => {
    // The vendor puts this on stdout, not stderr, and the classifier reads
    // both — writing it to the wrong stream would pass for the wrong reason.
    const bin = fakeBin({ version: VERSION, stdout: ['Not logged in'], exit: 1 })
    const result = await new CodexAdapter({ bin }).preflight()
    expect(result.installed).toBe(true)
    expect(result.authenticated).toBe(false)
    expect(result.version).toBe(VERSION)
    expect(result.hint).toBe(`${bin} login`)
  })

  it('reports ready when the CLI says it is logged in', async () => {
    const bin = fakeBin({ version: VERSION, stdout: ['Logged in using ChatGPT'] })
    expect(await new CodexAdapter({ bin }).preflight()).toEqual({
      installed: true,
      authenticated: true,
      version: VERSION,
    })
  })

  it('does not call an unfamiliar diagnostic a login failure', async () => {
    const bin = fakeBin({ version: VERSION, stderr: ['error: unrecognized subcommand'], exit: 2 })
    expect((await new CodexAdapter({ bin }).preflight()).authenticated).toBe(true)
  })

  /**
   * A release older than the app-server protocol this adapter speaks is not a
   * usable install, and the fix is the install command — but the login comes
   * first, so a machine with both problems hears about the one a person must
   * solve before it hears about the one a command solves.
   */
  it('reports a CLI older than the app-server floor as needing an upgrade', async () => {
    const old = fakeBin({ version: 'codex-cli 0.20.0', stdout: ['Logged in using ChatGPT'] })
    const result = await new CodexAdapter({ bin: old }).preflight()
    expect(result.installed).toBe(false)
    expect(result.version).toBe('codex-cli 0.20.0')
    expect(result.hint).toContain('0.147.0')

    const oldAndOut = fakeBin({ version: 'codex-cli 0.20.0', stdout: ['Not logged in'], exit: 1 })
    expect((await new CodexAdapter({ bin: oldAndOut }).preflight()).authenticated).toBe(false)

    const unparseable = fakeBin({ version: 'codex dev build', stdout: ['Logged in using ChatGPT'] })
    expect((await new CodexAdapter({ bin: unparseable }).preflight()).installed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Sessions against a fake app server
// ---------------------------------------------------------------------------

const task = (overrides: Partial<AgentTask> = {}): AgentTask => ({
  nodeId: 'phase-1',
  cwd: makeTemp(),
  prompt: 'implement the widget model',
  model: 'gpt-5.6-luna',
  ...overrides,
})

const server = (spec: FakeAppServerSpec = {}): FakeAppServer => fakeCodexAppServer(makeTemp(), spec)

const start = async (
  fake: FakeAppServer,
  options: Omit<CodexAdapterOptions, 'bin'> = {},
  overrides: Partial<AgentTask> = {},
): Promise<AgentSession> => {
  const outcome = await new CodexAdapter({ bin: fake.bin, ...options }).spawn(task(overrides))
  if (!outcome.ok) throw new Error(`spawn refused: ${outcome.kind} ${outcome.message}`)
  return outcome.session
}

const drain = async (session: AgentSession): Promise<AgentEvent[]> => {
  const seen: AgentEvent[] = []
  for await (const event of session.events) seen.push(event)
  return seen
}

const types = (events: readonly AgentEvent[]): string[] => events.map((event) => event.type)

/** The text inputs of the Nth `turn/start` the client sent. */
const turnInput = (fake: FakeAppServer, index: number): string[] => {
  const params = fake.sent('turn/start')[index]?.['params'] as { input?: { text?: string }[] } | undefined
  return (params?.input ?? []).map((input) => input.text ?? '')
}

/** Polls a condition the fake's log will satisfy, failing loudly rather than hanging. */
const until = async (condition: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A turn that ends cleanly after one reply. */
const plainTurn = [
  turnStarted(),
  itemStarted(reasoning('r1')),
  itemCompleted(reasoning('r1')),
  tokenUsage({ input: 19083, cached: 11008, output: 118 }),
  itemStarted(agentMessage('m1', '')),
  itemCompleted(agentMessage('m1', 'ok')),
  tokenUsage({ input: 38307, cached: 29184, output: 123 }),
  turnCompleted(),
]

describe('spawn against a fake app server', () => {
  it('does the handshake, starts the thread and maps a plain turn end to end', async () => {
    const fake = server({
      turns: [
        [
          turnStarted(),
          itemStarted(reasoning('r1')),
          itemStarted(command('exec-1', '10155', 'ls')),
          itemCompleted(command('exec-1', '10155', 'ls', { exitCode: 0, output: 'a.txt\n' })),
          tokenUsage({ input: 19083, cached: 11008, output: 118 }),
          { notify: 'a/variant/shipped/next/year', params: { threadId: '$THREAD' } },
          itemStarted(agentMessage('m1', '')),
          itemCompleted(agentMessage('m1', 'ok')),
          tokenUsage({ input: 38307, cached: 29184, output: 123 }),
          turnCompleted(),
        ],
      ],
    })
    const session = await start(fake)
    expect(session.id).toBe(FAKE_THREAD)
    const events = await drain(session)
    await session.kill()

    expect(events).toEqual([
      { type: 'session_started', sessionId: FAKE_THREAD },
      { type: 'tool_use', id: 'exec-1', name: 'command_execution', input: command('exec-1', '10155', 'ls') },
      { type: 'tool_result', id: 'exec-1', ok: true, summary: 'a.txt\n' },
      { type: 'assistant_text', text: 'ok' },
      // One usage for the turn, from the running total — not one per response.
      { type: 'usage', input: 38307 - 29184, output: 123, cacheRead: 29184, cacheWrite: 0 },
      { type: 'session_ended', result: 'ok' },
    ])

    const log = fake.log()
    // The prompt never reaches the process table.
    expect(log[0]?.['argv']).toEqual(['app-server'])
    const initialize = fake.sent('initialize')[0]?.['params'] as Record<string, unknown>
    expect(initialize['capabilities']).toEqual({ experimentalApi: true })
    expect(fake.sent('initialized').length).toBe(1)
    const thread = fake.sent('thread/start')[0]?.['params'] as Record<string, unknown>
    expect(thread).toMatchObject({ model: 'gpt-5.6-luna', ephemeral: false, ...codexThreadPolicy('auto') })
    expect(turnInput(fake, 0)).toEqual(['implement the widget model'])
    // Nothing was pending, and the session still cleaned before it went.
    expect(fake.sent('thread/backgroundTerminals/list').length).toBe(1)
    expect(fake.sent('thread/backgroundTerminals/clean').length).toBe(1)
  })

  it('defers to the CLI’s own model when the task names none', async () => {
    const fake = server({ turns: [plainTurn] })
    await drain(await start(fake, {}, { model: '' }))
    const thread = fake.sent('thread/start')[0]?.['params'] as Record<string, unknown>
    expect('model' in thread).toBe(false)
  })

  it('delivers operator text as a labelled second input, and records it as the operator’s', async () => {
    const fake = server({ turns: [plainTurn] })
    const events = await drain(await start(fake, {}, { operatorText: 'keep the migration reversible' }))
    expect(turnInput(fake, 0)).toEqual([
      'implement the widget model',
      operatorGuidance('keep the migration reversible'),
    ])
    expect(events[1]).toEqual({ type: 'user_message', text: 'keep the migration reversible' })
  })

  it('states the operator’s policy on the thread, per mode', async () => {
    for (const permission of AGENT_PERMISSIONS) {
      const fake = server({ turns: [plainTurn] })
      await drain(await start(fake, { permission }))
      const thread = fake.sent('thread/start')[0]?.['params'] as Record<string, unknown>
      expect(thread).toMatchObject(codexThreadPolicy(permission))
    }
  })

  it('resumes a thread with the policy restated, and does not bill the history it replays', async () => {
    const fake = server({
      afterResume: [tokenUsage({ input: 50_000, cached: 40_000, output: 900 })],
      turns: [[turnStarted(), tokenUsage({ input: 60_000, cached: 49_000, output: 950 }), turnCompleted()]],
    })
    const session = await start(fake, { permission: 'full' }, { resumeSessionId: 'thread-old' })
    expect(session.id).toBe('thread-old')
    const events = await drain(session)

    const resume = fake.sent('thread/resume')[0]?.['params'] as Record<string, unknown>
    expect(resume).toMatchObject({ threadId: 'thread-old', ...codexThreadPolicy('full') })
    expect(fake.sent('thread/start').length).toBe(0)
    expect(events.filter((event) => event.type === 'usage')).toEqual([
      { type: 'usage', input: 1_000, output: 50, cacheRead: 9_000, cacheWrite: 0 },
    ])
  })

  it('classifies a resume of a thread the server never had as stale — only when resuming', async () => {
    const message = `no rollout found for thread id ${UNISSUED_SESSION}`
    const stale = server({ replies: { 'thread/resume': { error: { code: -32600, message } } } })
    const resumed = await new CodexAdapter({ bin: stale.bin }).spawn(task({ resumeSessionId: UNISSUED_SESSION }))
    expect(resumed.ok === false && resumed.kind).toBe('stale_session')
    expect(resumed.ok === false && resumed.message.includes(UNISSUED_SESSION)).toBe(false)

    // The same wording from a fresh start is not a forgotten token.
    const cold = server({ replies: { 'thread/start': { error: { code: -32600, message } } } })
    const fresh = await new CodexAdapter({ bin: cold.bin }).spawn(task())
    expect(fresh.ok === false && fresh.kind).toBe('fatal')
  })

  it('answers every approval request — declining it and saying so in the stream', async () => {
    const fake = server({
      turns: [
        [
          turnStarted(),
          itemStarted({ ...command('exec-1', null, 'touch created.txt'), source: 'agent' }),
          {
            request: 'item/commandExecution/requestApproval',
            params: { threadId: '$THREAD', turnId: '$TURN', itemId: 'exec-1', command: "/bin/zsh -lc 'touch created.txt'" },
          },
          { request: 'account/chatgptAuthTokens/refresh', params: { reason: 'unauthorized' } },
          { waitFor: 'thread/backgroundTerminals/list' },
        ],
      ],
    })
    // The turn never ends on its own here, so the replies are what is under
    // test; the session is killed once both have been read.
    const session = await start(fake, { permission: 'ask' })
    const iterator = session.events[Symbol.asyncIterator]()
    const seen: AgentEvent[] = []
    while (!seen.some((event) => event.type === 'permission_request')) {
      const step = await iterator.next()
      if (step.done === true) break
      seen.push(step.value)
    }
    await until(() => fake.log().some((entry) => entry['id'] === 1001 && entry['method'] === undefined))
    await session.kill()

    expect(seen.find((event) => event.type === 'permission_request')).toEqual({
      type: 'permission_request',
      tool: 'command_execution',
      detail: { itemId: 'exec-1', command: "/bin/zsh -lc 'touch created.txt'" },
    })
    const replies = fake.log().filter((entry) => entry['method'] === undefined && 'id' in entry)
    expect(replies.find((entry) => entry['id'] === 1000)?.['result']).toEqual({ decision: 'decline' })
    // A request this client cannot answer is refused, never left open.
    expect(replies.find((entry) => entry['id'] === 1001)?.['error']).toMatchObject({ code: -32601 })
  })

  it('classifies a server that refuses before announcing a thread', async () => {
    const fake = server({ boot: { stderr: "You've hit your usage limit. Try again in 2 hours.", exit: 1 } })
    const now = Date.now()
    const outcome = await new CodexAdapter({ bin: fake.bin }).spawn(task())
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.kind).toBe('quota')
    const waitMs = (outcome.retryAfter?.getTime() ?? 0) - now
    expect(waitMs >= 7_200_000 && waitMs < 7_260_000).toBe(true)
  })

  it('refuses a logged-out server at spawn, before it spends a minute retrying 401s', async () => {
    const fake = server({ replies: { 'account/read': { result: { account: null, requiresOpenaiAuth: true } } } })
    const outcome = await new CodexAdapter({ bin: fake.bin }).spawn(task())
    expect(outcome.ok === false && outcome.kind).toBe('unauthenticated')
    expect(fake.sent('thread/start').length).toBe(0)
  })

  it('classifies a refusal sent as an error reply to the handshake or the first turn', async () => {
    const initialize = server({ replies: { initialize: { error: { code: -32603, message: 'Not logged in' } } } })
    const refusedInit = await new CodexAdapter({ bin: initialize.bin }).spawn(task())
    expect(refusedInit.ok === false && refusedInit.kind).toBe('unauthenticated')
    expect(refusedInit.ok === false && refusedInit.message).toContain('json-rpc -32603')

    const turn = server({ replies: { 'turn/start': { error: { code: -32603, message: 'Too many requests' } } } })
    const refusedTurn = await new CodexAdapter({ bin: turn.bin }).spawn(task())
    expect(refusedTurn.ok === false && refusedTurn.kind).toBe('rate_limit')
  })

  it('classifies a binary that is not there at all', async () => {
    const outcome = await new CodexAdapter({ bin: join(makeTemp(), 'nope') }).spawn(task())
    expect(outcome.ok === false && outcome.kind).toBe('fatal')
  })

  it('records a window that closes mid-turn, and ends the turn as failed', async () => {
    const error = { message: "You've hit your usage limit. Try again in 2 hours.", codexErrorInfo: 'usageLimitExceeded' }
    const fake = server({
      turns: [
        [
          turnStarted(),
          { notify: 'error', params: { error, willRetry: false, threadId: '$THREAD', turnId: '$TURN' } },
          turnCompleted('failed', error),
        ],
      ],
    })
    const session = await start(fake)
    const events = await drain(session)
    expect(session.refusal?.kind).toBe('quota')
    expect(events.filter((event) => event.type === 'error')).toEqual([
      { type: 'error', message: 'codex refused mid-turn: usage-window-exhausted' },
      { type: 'error', message: 'codex: usage-window-exhausted' },
    ])
    expect(events[events.length - 1]).toEqual({ type: 'session_ended', result: 'error' })
  })

  it('ends the stream once when the server dies mid-turn', async () => {
    const fake = server({ turns: [[turnStarted(), { exit: 3 }]] })
    const events = await drain(await start(fake))
    expect(events.filter((event) => event.type === 'session_ended').length).toBe(1)
    expect(events[events.length - 1]).toEqual({ type: 'session_ended', result: 'error' })
  })

  it('returns an injected refusal of every kind without starting a process', async () => {
    const adapter = new CodexAdapter({ bin: join(makeTemp(), 'never-run') })
    for (const kind of ['rate_limit', 'concurrency', 'quota', 'transient', 'stale_session', 'fatal'] as const) {
      adapter.refuseNext(kind)
      const outcome = await adapter.spawn(task())
      expect(outcome.ok === false && outcome.kind).toBe(kind)
    }
  })
})

// ---------------------------------------------------------------------------
// backgroundWork
// ---------------------------------------------------------------------------

const BACKGROUND = 'sleep 20 && echo done > marker.txt'

describe('a session with background work still running', () => {
  /**
   * The case the migration exists for: the agent backgrounds a command and
   * ends its turn. The session must outlive the turn, see the command finish
   * under the *old* turn's id, wake the agent with a turn of its own, and end
   * once — after the agent has read the result.
   */
  it('is held past the turn, woken when the command finishes, and ends once', async () => {
    const fake = server({
      terminals: [[{ itemId: 'exec-bg', processId: '93423', command: BACKGROUND, cwd: '/lane' }], []],
      turns: [
        [
          turnStarted(),
          itemStarted(command('exec-bg', '93423', BACKGROUND)),
          tokenUsage({ input: 1_000, output: 10 }),
          // A new model response: the command was handed back as a session id.
          itemStarted(reasoning('r2')),
          itemCompleted(agentMessage('m1', 'STARTED')),
          tokenUsage({ input: 2_000, output: 20 }),
          turnCompleted(),
          { waitFor: 'thread/backgroundTerminals/list' },
          { delayMs: 300 },
          itemCompleted(command('exec-bg', '93423', BACKGROUND, { exitCode: 0 }), { turnId: 'turn-1' }),
        ],
        [
          turnStarted(),
          itemCompleted(agentMessage('m2', 'marker says done')),
          tokenUsage({ input: 3_500, output: 35 }),
          turnCompleted(),
        ],
      ],
    })
    const events = await drain(await start(fake))

    const wake = events.find((event) => event.type === 'user_message')
    expect(wake?.type === 'user_message' && wake.text).toBe(
      wakeMessage([{ command: BACKGROUND, processId: '93423', exitCode: 0 }], []),
    )
    expect(types(events)).toEqual([
      'session_started',
      'tool_use',
      'assistant_text',
      'usage',
      // The command reports between turns, and the agent is woken after it.
      'tool_result',
      'user_message',
      'assistant_text',
      'usage',
      'session_ended',
    ])
    expect(events[events.length - 1]).toEqual({ type: 'session_ended', result: 'ok' })
    expect(fake.sent('turn/start').length).toBe(2)
    expect(turnInput(fake, 1)).toEqual([wake?.type === 'user_message' ? wake.text : ''])
    // Per turn, each carrying only its own share.
    expect(events.filter((event) => event.type === 'usage').map((event) => event.type === 'usage' && event.output)).toEqual([20, 15])
  })

  it('wakes the agent when a sub-agent it left running finishes', async () => {
    const child = 'thread-child'
    const fake = server({
      turns: [
        [
          turnStarted(),
          itemStarted(spawnAgent('spawn-1', child, 'inProgress')),
          threadStatus(child, 'idle'),
          itemCompleted(spawnAgent('spawn-1', child, 'completed')),
          threadStatus(child, 'active'),
          childTurn(child, 'started'),
          itemStarted(agentMessage('m1', '')),
          itemCompleted(agentMessage('m1', 'LAUNCHED')),
          turnCompleted(),
          { waitFor: 'thread/backgroundTerminals/list' },
          { delayMs: 300 },
          // The sub-agent's own items are its business, not the transcript's.
          itemCompleted(agentMessage('c1', 'CHILD-DONE'), { threadId: child, turnId: `${child}-turn` }),
          threadStatus(child, 'idle'),
          childTurn(child, 'completed'),
        ],
        [turnStarted(), itemCompleted(agentMessage('m2', 'the child is done')), turnCompleted()],
      ],
    })
    const events = await drain(await start(fake))

    expect(fake.sent('turn/start').length).toBe(2)
    expect(turnInput(fake, 1)[0]).toBe(wakeMessage([], [child]))
    expect(events.filter((event) => event.type === 'assistant_text')).toEqual([
      { type: 'assistant_text', text: 'LAUNCHED' },
      { type: 'assistant_text', text: 'the child is done' },
    ])
    expect(events.filter((event) => event.type === 'session_ended')).toEqual([
      { type: 'session_ended', result: 'ok' },
    ])
  })

  it('does not wake for a sub-agent the agent already waited on', async () => {
    const child = 'thread-child'
    const fake = server({
      turns: [
        [
          turnStarted(),
          itemStarted(spawnAgent('spawn-1', child, 'inProgress')),
          itemCompleted(spawnAgent('spawn-1', child, 'completed')),
          threadStatus(child, 'active'),
          threadStatus(child, 'idle'),
          itemCompleted({
            ...spawnAgent('wait-1', child, 'completed'),
            tool: 'wait',
            agentsStates: { [child]: { status: 'completed', message: null } },
          }),
          turnCompleted(),
        ],
      ],
    })
    await drain(await start(fake))
    expect(fake.sent('turn/start').length).toBe(1)
  })

  /**
   * A command that was backgrounded and exited *during* the turn, without the
   * agent ever polling it: nothing is left running, but its result was never
   * read. Ending the session would drop it.
   */
  it('reports a backgrounded command that exited during the turn without being polled', async () => {
    const fake = server({
      turns: [
        [
          turnStarted(),
          itemStarted(command('exec-9', '9', 'pnpm test')),
          itemStarted(reasoning('r2')),
          itemCompleted(command('exec-9', '9', 'pnpm test', { exitCode: 3 })),
          itemCompleted(agentMessage('m1', 'waiting')),
          turnCompleted(),
        ],
        [turnStarted(), itemCompleted(agentMessage('m2', 'tests failed, fixing')), turnCompleted()],
      ],
    })
    await drain(await start(fake))
    expect(fake.sent('turn/start').length).toBe(2)
    expect(turnInput(fake, 1)[0]).toContain('(session 9) exited with code 3')
  })

  it('does not report a command the agent polled, or one that finished inside its own call', async () => {
    const fake = server({
      turns: [
        [
          turnStarted(),
          // Finished inside its call: no new response began while it ran.
          itemStarted(command('exec-1', '1', 'ls')),
          itemCompleted(command('exec-1', '1', 'ls', { exitCode: 0 })),
          // Backgrounded, then polled, then exited.
          itemStarted(command('exec-2', '2', 'pnpm build')),
          itemStarted(reasoning('r2')),
          {
            notify: 'item/commandExecution/terminalInteraction',
            params: { threadId: '$THREAD', turnId: '$TURN', itemId: 'exec-2', processId: '2', stdin: '' },
          },
          itemCompleted(command('exec-2', '2', 'pnpm build', { exitCode: 0 })),
          itemCompleted(agentMessage('m1', 'built')),
          turnCompleted(),
        ],
      ],
    })
    const events = await drain(await start(fake))
    expect(fake.sent('turn/start').length).toBe(1)
    expect(events.some((event) => event.type === 'user_message')).toBe(false)
  })

  it('ends at once on a failed turn, whatever it left running', async () => {
    const fake = server({
      terminals: [[{ itemId: 'exec-bg', processId: '5', command: BACKGROUND, cwd: '/lane' }]],
      turns: [
        [
          turnStarted(),
          itemStarted(command('exec-bg', '5', BACKGROUND)),
          itemStarted(reasoning('r2')),
          turnCompleted('failed', { message: 'the model refused', codexErrorInfo: 'other' }),
        ],
      ],
    })
    const session = await start(fake)
    const events = await drain(session)
    expect(events[events.length - 1]).toEqual({ type: 'session_ended', result: 'error' })
    expect(fake.sent('turn/start').length).toBe(1)
    // And what it left running was cleaned rather than orphaned. The stream
    // closes first; `kill` on an ended session resolves when cleanup has.
    await session.kill()
    expect(fake.sent('thread/backgroundTerminals/clean').length).toBe(1)
  })

  it('ends a held session that hears nothing, cleaning up what it left, the way its turn ended', async () => {
    const fake = server({
      terminals: [[{ itemId: 'exec-bg', processId: '5', command: 'pnpm dev', cwd: '/lane' }]],
      turns: [
        [
          turnStarted(),
          itemStarted(command('exec-bg', '5', 'pnpm dev')),
          itemStarted(reasoning('r2')),
          // Output from the process is not the server working on anything.
          {
            notify: 'item/commandExecution/outputDelta',
            params: { threadId: '$THREAD', turnId: '$TURN', itemId: 'exec-bg', delta: 'listening' },
          },
          turnCompleted(),
        ],
      ],
    })
    const startedAt = Date.now()
    const session = await start(fake, { backgroundIdleMs: 400 })
    const events = await drain(session)
    expect(Date.now() - startedAt >= 400).toBe(true)
    await session.kill()
    expect(events[events.length - 1]).toEqual({ type: 'session_ended', result: 'ok' })
    expect(fake.sent('turn/start').length).toBe(1)
    expect(fake.sent('thread/backgroundTerminals/clean').length).toBe(1)
  })

  it('interrupts the running turn, cleans the background terminals, and leaves no process', async () => {
    const fake = server({
      turns: [[turnStarted(), itemStarted(command('exec-bg', '5', BACKGROUND)), { waitFor: 'never-sent' }]],
    })
    const session = await start(fake)
    const iterator = session.events[Symbol.asyncIterator]()
    await iterator.next()
    await session.interrupt()
    const rest: AgentEvent[] = []
    for (;;) {
      const step = await iterator.next()
      if (step.done === true) break
      rest.push(step.value)
    }
    expect(rest[rest.length - 1]).toEqual({ type: 'session_ended', result: 'interrupted' })
    // Cleanup runs after the stream closes; `kill` resolves when it is done.
    await session.kill()
    const methods = fake.log().map((entry) => entry['method'])
    expect(methods.indexOf('turn/interrupt') >= 0).toBe(true)
    expect(methods.indexOf('thread/backgroundTerminals/clean') > methods.indexOf('turn/interrupt')).toBe(true)
    await until(() => !alive(Number(fake.log()[0]?.['pid'])))
  }, 20_000)

  it('kills idempotently, and the server is gone when kill resolves', async () => {
    const fake = server({ turns: [[turnStarted(), { waitFor: 'never-sent' }]] })
    const outcome = await new CodexAdapter({ bin: fake.bin }).spawn(task())
    if (!outcome.ok) throw new Error('spawn refused')
    await outcome.session.kill()
    await outcome.session.kill()
    const events = await drain(outcome.session)
    expect(events.filter((event) => event.type === 'session_ended')).toEqual([
      { type: 'session_ended', result: 'interrupted' },
    ])
    expect(fake.sent('thread/backgroundTerminals/clean').length).toBe(1)
    await until(() => !alive(Number(fake.log()[0]?.['pid'])))
  })

  it('counts usage once, however often the server restates it', async () => {
    const fake = server({
      turns: [
        [
          turnStarted(),
          tokenUsage({ input: 1_000, cached: 600, output: 10 }),
          // A rate-limit update restates the same total.
          tokenUsage({ input: 1_000, cached: 600, output: 10 }),
          tokenUsage({ input: 2_000, cached: 1_500, output: 30 }),
          turnCompleted(),
        ],
      ],
    })
    const usage = (await drain(await start(fake))).filter((event) => event.type === 'usage')
    expect(usage).toEqual([{ type: 'usage', input: 500, output: 30, cacheRead: 1_500, cacheWrite: 0 }])
  })
})

describe('steering a codex session', () => {
  it('steers the running turn, naming the turn it means', async () => {
    const fake = server({
      turns: [[turnStarted(), { waitFor: 'turn/steer' }, itemCompleted(agentMessage('m1', 'done')), turnCompleted()]],
    })
    const session = await start(fake)
    const iterator = session.events[Symbol.asyncIterator]()
    await iterator.next()
    await session.send('also update the changelog')
    const rest: AgentEvent[] = []
    for (;;) {
      const step = await iterator.next()
      if (step.done === true) break
      rest.push(step.value)
    }
    expect(rest[0]).toEqual({ type: 'user_message', text: 'also update the changelog' })
    const steer = fake.sent('turn/steer')[0]?.['params'] as Record<string, unknown>
    expect(steer).toMatchObject({ threadId: FAKE_THREAD, expectedTurnId: 'turn-1' })
    expect(fake.sent('turn/start').length).toBe(1)
  })

  it('continues a held session with a turn of the operator’s own', async () => {
    const fake = server({
      terminals: [[{ itemId: 'exec-bg', processId: '5', command: 'pnpm dev', cwd: '/lane' }]],
      turns: [
        [turnStarted(), itemStarted(command('exec-bg', '5', 'pnpm dev')), itemStarted(reasoning('r2')), turnCompleted()],
        [turnStarted(), itemCompleted(agentMessage('m2', 'stopping the server')), turnCompleted()],
      ],
    })
    const session = await start(fake, { backgroundIdleMs: 5_000 })
    // Held once the listing has been read and nothing reported.
    await until(() => fake.sent('thread/backgroundTerminals/list').length > 0)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await session.send('stop the dev server')
    await until(() => fake.sent('turn/start').length >= 2)
    expect(turnInput(fake, 1)).toEqual(['stop the dev server'])
    await session.kill()
    const events = await drain(session)
    expect(events.filter((event) => event.type === 'user_message')).toEqual([
      { type: 'user_message', text: 'stop the dev server' },
    ])
  })
})

// ---------------------------------------------------------------------------
// Live contract, preflight-gated.
// ---------------------------------------------------------------------------

/** A lane is a git checkout; the contract runs in one. */
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
    : `no usable codex binary at "${liveAdapter.bin}" — ${live.hint ?? 'set VINTA_AI_MAESTRO_CODEX_BIN'}`
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
      // way to observe the real server's wording for a thread it does not have
      // (§15.4). Where the vendor changes that wording this is the test that
      // says so — the pattern table cannot notice on its own.
      staleResumeTask: { ...task, resumeSessionId: UNISSUED_SESSION },
      forceRefusal: real.refuseNext.bind(real),
      // A real turn is a network round trip plus server startup, which loads
      // the user's MCP servers and skills before the first token.
      hangMs: 60_000,
      dispose: async () => {
        for (const session of started) await session.kill()
      },
    }
  })
}
