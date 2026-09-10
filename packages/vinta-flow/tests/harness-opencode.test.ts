/**
 * Three suites in one file.
 *
 * The **unit suite** is the one that actually protects this adapter, and it
 * runs everywhere — no opencode install, no login, no tokens spent. Where it
 * needs a server to talk to it stands one up with `node:http` on loopback, so
 * the real `fetch` path, the real SSE framing and the real HTTP status
 * classification are exercised against a stub rather than mocked away.
 *
 * The **lifecycle suite** is the one the acceptance criterion names: a server
 * this adapter starts must be gone after `close()` — no listening socket, no
 * child process. It runs a fake `opencode` binary (a Node script that answers
 * the handful of routes the adapter uses) so the process supervision is real
 * even though the product is not, and it asserts the absence rather than
 * assuming it.
 *
 * The **live suite** runs `runAdapterContract` against a real opencode and
 * skips itself when `preflight` says the binary is missing or logged out. It
 * must never fail a suite on a machine without one — which includes CI, and
 * includes the machine this was written on.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createSocketServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AgentEvent, AgentSession, AgentTask, HarnessAdapter } from '../src/harness/adapter.ts'
import { runAdapterContract } from '../src/harness/contract.ts'
import {
  OpencodeAdapter,
  OpencodeEventMapper,
  SseFrames,
  classifySpawnFailure,
  parseModel,
} from '../src/harness/opencode.ts'
import { parseRetryAfter } from '../src/harness/shared.ts'
import { POSIX_SHELL_FIXTURES } from './support/platform.ts'

const temps: string[] = []

const makeTemp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-flow-opencode-'))
  temps.push(dir)
  return dir
}

// Cleanup runs even when a test above it threw: a failing run must not leave
// fake binaries behind in the system temp dir.
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// A stub opencode server: enough of the API for the adapter to be exercised.
// ---------------------------------------------------------------------------

interface Stub {
  readonly url: string
  readonly prompts: string[]
  readonly aborts: string[]
  /** Push one bus event down the shared SSE stream. */
  emit(event: unknown): void
  /** End the stream without stopping the server, as a dropped connection does. */
  dropStream(): void
  promptStatus: number
  promptRetryAfter: string | null
  providers: unknown[]
  close(): Promise<void>
}

const startStub = async (): Promise<Stub> => {
  const streams = new Set<ServerResponse>()
  const prompts: string[] = []
  const aborts: string[] = []
  let sessions = 0

  const stub = {
    prompts,
    aborts,
    promptStatus: 204,
    promptRetryAfter: null as string | null,
    providers: [{ id: 'anthropic' }] as unknown[],
  }

  const json = (res: ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const url = req.url ?? ''
    req.resume()
    if (url.startsWith('/global/health')) return json(res, 200, { healthy: true, version: '0.9.9' })
    if (url.startsWith('/config/providers')) return json(res, 200, { providers: stub.providers, default: {} })
    if (url.startsWith('/event')) {
      // Registered before the headers go out, so a client whose fetch has
      // resolved is guaranteed to be on the list `emit` writes to.
      streams.add(res)
      res.on('close', () => streams.delete(res))
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(': ready\n\n')
      return
    }
    if (req.method === 'POST' && url === '/session') {
      sessions += 1
      return json(res, 200, { id: `ses_${sessions}` })
    }
    if (req.method === 'POST' && url.endsWith('/prompt_async')) {
      prompts.push(url)
      if (stub.promptStatus >= 400) {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (stub.promptRetryAfter !== null) headers['retry-after'] = stub.promptRetryAfter
        res.writeHead(stub.promptStatus, headers)
        res.end(JSON.stringify({ message: 'a body that must never reach a refusal message' }))
        return
      }
      res.writeHead(204)
      res.end()
      return
    }
    if (req.method === 'POST' && url.endsWith('/abort')) {
      aborts.push(url)
      return json(res, 200, true)
    }
    return json(res, 404, {})
  }

  const server = createHttpServer(handle)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  // The handler closes over `stub`, so the knobs a test turns have to write
  // through to it rather than to a copy.
  return {
    prompts,
    aborts,
    get promptStatus(): number {
      return stub.promptStatus
    },
    set promptStatus(value: number) {
      stub.promptStatus = value
    },
    get promptRetryAfter(): string | null {
      return stub.promptRetryAfter
    },
    set promptRetryAfter(value: string | null) {
      stub.promptRetryAfter = value
    },
    get providers(): unknown[] {
      return stub.providers
    },
    set providers(value: unknown[]) {
      stub.providers = value
    },
    url: `http://127.0.0.1:${port}`,
    emit: (event: unknown): void => {
      for (const stream of streams) stream.write(`data: ${JSON.stringify(event)}\n\n`)
    },
    dropStream: (): void => {
      for (const stream of streams) stream.end()
    },
    close: async (): Promise<void> => {
      for (const stream of streams) stream.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

const drain = async (session: AgentSession): Promise<AgentEvent[]> => {
  const seen: AgentEvent[] = []
  for await (const event of session.events) seen.push(event)
  return seen
}

const task = (overrides: Partial<AgentTask> = {}): AgentTask => ({
  nodeId: 'phase-1',
  cwd: makeTemp(),
  prompt: 'implement the widget model',
  model: 'anthropic/claude-haiku',
  ...overrides,
})

/** The stub's session ids are `ses_N`; the first spawn against a fresh stub gets this one. */
const SESSION = 'ses_1'

const textPart = (id: string, text: string, sessionID = SESSION): unknown => ({
  type: 'message.part.updated',
  properties: { part: { id, sessionID, messageID: 'msg_1', type: 'text', text } },
})

const idle = (sessionID = SESSION): unknown => ({
  type: 'session.idle',
  properties: { sessionID },
})

// ---------------------------------------------------------------------------

describe('SSE framing', () => {
  it('reassembles a record split across chunk boundaries', () => {
    const frames = new SseFrames()
    expect(frames.push('data: {"type":"sess')).toEqual([])
    expect(frames.push('ion.idle","properties":{"ses')).toEqual([])
    expect(frames.push('sionID":"s1"}}\n\n')).toEqual([
      { type: 'session.idle', properties: { sessionID: 's1' } },
    ])
  })

  it('emits several records from one chunk and holds an unterminated tail', () => {
    const frames = new SseFrames()
    expect(frames.push('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c":')).toEqual([{ a: 1 }, { b: 2 }])
    expect(frames.push('3}\n\n')).toEqual([{ c: 3 }])
  })

  it('drops keep-alive comments, unused fields and CRLF without throwing', () => {
    const frames = new SseFrames()
    expect(frames.push(': ping\r\n\r\nevent: message\r\nid: 7\r\ndata: {"ok":true}\r\n\r\n')).toEqual([
      { ok: true },
    ])
  })

  it('ignores a record whose payload is not JSON', () => {
    expect(new SseFrames().push('data: not json\n\ndata: {"ok":1}\n\n')).toEqual([{ ok: 1 }])
  })

  it('joins a multi-line data payload', () => {
    expect(new SseFrames().push('data: {"a":\ndata: 1}\n\n')).toEqual([{ a: 1 }])
  })
})

describe('model resolution', () => {
  it('splits opencode provider/model spelling', () => {
    expect(parseModel('anthropic/claude-sonnet-4')).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4',
    })
  })

  it('leaves a bare model name to the server default rather than guessing a provider', () => {
    expect(parseModel('haiku')).toBe(undefined)
    expect(parseModel('/leading')).toBe(undefined)
    expect(parseModel('trailing/')).toBe(undefined)
  })
})

// ---------------------------------------------------------------------------

describe('server event mapping', () => {
  const map = (mapper: OpencodeEventMapper, ...events: unknown[]): AgentEvent[] =>
    events.flatMap((event) => mapper.map(event))

  it('emits only what a cumulative text part gained, never the whole part again', () => {
    const mapper = new OpencodeEventMapper(SESSION)
    expect(map(mapper, textPart('prt_1', 'read'), textPart('prt_1', 'reading the'), textPart('prt_1', 'reading the brief'))).toEqual([
      { type: 'assistant_text', text: 'read' },
      { type: 'assistant_text', text: 'ing the' },
      { type: 'assistant_text', text: ' brief' },
    ])
  })

  it('emits nothing for a part republished unchanged', () => {
    const mapper = new OpencodeEventMapper(SESSION)
    map(mapper, textPart('prt_1', 'done'))
    expect(map(mapper, textPart('prt_1', 'done'))).toEqual([])
  })

  it('emits a rewritten part whole rather than dropping the correction', () => {
    const mapper = new OpencodeEventMapper(SESSION)
    map(mapper, textPart('prt_1', 'aaa'))
    expect(map(mapper, textPart('prt_1', 'bbb'))).toEqual([{ type: 'assistant_text', text: 'bbb' }])
  })

  it('maps a reasoning part to thinking', () => {
    const mapper = new OpencodeEventMapper(SESSION)
    expect(
      map(mapper, {
        type: 'message.part.updated',
        properties: {
          part: { id: 'prt_2', sessionID: SESSION, type: 'reasoning', text: 'considering', time: { start: 1 } },
        },
      }),
    ).toEqual([{ type: 'thinking', text: 'considering' }])
  })

  it('skips a synthetic text part, which is the harness talking to itself', () => {
    const mapper = new OpencodeEventMapper(SESSION)
    expect(
      map(mapper, {
        type: 'message.part.updated',
        properties: { part: { id: 'prt_3', sessionID: SESSION, type: 'text', text: 'x', synthetic: true } },
      }),
    ).toEqual([])
  })

  it('announces a tool call once and settles it once across its status updates', () => {
    const mapper = new OpencodeEventMapper(SESSION)
    const part = (state: unknown): unknown => ({
      type: 'message.part.updated',
      properties: {
        part: { id: 'prt_4', sessionID: SESSION, type: 'tool', callID: 'call_1', tool: 'read', state },
      },
    })

    // A pending call carries a half-parsed input; announcing it then would put
    // an incomplete argument list in the transcript as if it were the call.
    expect(map(mapper, part({ status: 'pending', raw: '{"fil' }))).toEqual([])
    expect(map(mapper, part({ status: 'running', input: { path: 'src/widget.ts' } }))).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'src/widget.ts' } },
    ])
    expect(map(mapper, part({ status: 'running', input: { path: 'src/widget.ts' } }))).toEqual([])
    expect(
      map(mapper, part({ status: 'completed', input: { path: 'src/widget.ts' }, output: '42 lines' })),
    ).toEqual([{ type: 'tool_result', id: 'call_1', ok: true, summary: '42 lines' }])
    expect(
      map(mapper, part({ status: 'completed', input: { path: 'src/widget.ts' }, output: '42 lines' })),
    ).toEqual([])
  })

  it('announces and fails a tool that errored without ever running', () => {
    const mapper = new OpencodeEventMapper(SESSION)
    expect(
      map(mapper, {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_5',
            sessionID: SESSION,
            type: 'tool',
            callID: 'call_2',
            tool: 'bash',
            state: { status: 'error', input: {}, error: 'exit 1' },
          },
        },
      }),
    ).toEqual([
      { type: 'tool_use', id: 'call_2', name: 'bash', input: {} },
      { type: 'tool_result', id: 'call_2', ok: false, summary: 'exit 1' },
    ])
  })

  it('maps a permission request from its class, not from its rendered title', () => {
    const mapper = new OpencodeEventMapper(SESSION)
    expect(
      map(mapper, {
        type: 'permission.updated',
        properties: {
          id: 'per_1',
          sessionID: SESSION,
          messageID: 'msg_1',
          type: 'bash',
          title: 'rm -rf the repository, which is agent output',
          metadata: { command: 'ls' },
        },
      }),
    ).toEqual([{ type: 'permission_request', tool: 'bash', detail: { command: 'ls' } }])
  })

  it('sums usage across the turn and emits it once, on the terminal frame', () => {
    const mapper = new OpencodeEventMapper(SESSION)
    const message = (id: string, input: number, output: number, cost: number): unknown => ({
      type: 'message.updated',
      properties: {
        info: {
          id,
          sessionID: SESSION,
          role: 'assistant',
          tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
          cost,
        },
      },
    })

    // Republished messages must not double-count, and a user message is not usage.
    expect(map(mapper, message('msg_1', 100, 20, 0.01))).toEqual([])
    expect(map(mapper, message('msg_1', 120, 30, 0.02))).toEqual([])
    expect(map(mapper, message('msg_2', 80, 10, 0.03))).toEqual([])
    expect(
      map(mapper, { type: 'message.updated', properties: { info: { id: 'msg_3', sessionID: SESSION, role: 'user' } } }),
    ).toEqual([])

    expect(map(mapper, idle())).toEqual([
      { type: 'usage', input: 200, output: 40, costUsd: 0.05 },
      { type: 'session_ended', result: 'ok' },
    ])
  })

  it('ends a turn that reported no usage with no usage event', () => {
    expect(new OpencodeEventMapper(SESSION).map(idle())).toEqual([{ type: 'session_ended', result: 'ok' }])
  })

  it('carries only the error name and ends the turn as an error', () => {
    const mapper = new OpencodeEventMapper(SESSION)
    expect(
      map(mapper, {
        type: 'session.error',
        properties: {
          sessionID: SESSION,
          error: { name: 'ProviderAuthError', data: { message: 'vendor prose that must not be logged' } },
        },
      }),
    ).toEqual([{ type: 'error', message: 'opencode session error: ProviderAuthError' }])
    expect(map(mapper, idle())).toEqual([{ type: 'session_ended', result: 'error' }])
  })

  it('reports a message-level error once and only once', () => {
    const mapper = new OpencodeEventMapper(SESSION)
    const failed = {
      type: 'message.updated',
      properties: {
        info: { id: 'msg_1', sessionID: SESSION, role: 'assistant', error: { name: 'MessageOutputLengthError' } },
      },
    }
    expect(map(mapper, failed)).toEqual([
      { type: 'error', message: 'opencode message error: MessageOutputLengthError' },
    ])
    expect(map(mapper, failed)).toEqual([])
  })

  it('ignores every event belonging to another session on the shared stream', () => {
    const mapper = new OpencodeEventMapper(SESSION)
    expect(
      map(
        mapper,
        textPart('prt_9', 'not ours', 'ses_other'),
        idle('ses_other'),
        { type: 'permission.updated', properties: { sessionID: 'ses_other', type: 'bash' } },
        { type: 'session.error', properties: { sessionID: 'ses_other', error: { name: 'ApiError' } } },
        // An unattributed error is not claimed either: attributing it would
        // mark every concurrent lane on this server as failed on a guess.
        { type: 'session.error', properties: { error: { name: 'UnknownError' } } },
        { type: 'message.updated', properties: { info: { id: 'm', sessionID: 'ses_other', role: 'assistant' } } },
      ),
    ).toEqual([])
  })

  it('ignores event types, part types and malformed frames it has never seen', () => {
    const mapper = new OpencodeEventMapper(SESSION)
    expect(
      map(
        mapper,
        { type: 'server.connected', properties: {} },
        { type: 'session.status', properties: { sessionID: SESSION, status: 'busy' } },
        { type: 'todo.updated', properties: { sessionID: SESSION, todos: [] } },
        { type: 'lsp.client.diagnostics', properties: { path: 'a.ts' } },
        { type: 'pty.created', properties: { id: 'pty_1' } },
        { type: 'an.event.shipped.next.year', properties: { anything: true } },
        {
          type: 'message.part.updated',
          properties: { part: { id: 'p', sessionID: SESSION, type: 'step-start' } },
        },
        {
          type: 'message.part.updated',
          properties: { part: { id: 'p', sessionID: SESSION, type: 'tool', callID: 'c', state: {} } },
        },
        { type: 'message.part.updated', properties: {} },
        { type: 'session.idle' },
        null,
        'a bare string',
        [1, 2, 3],
      ),
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------

describe('spawn refusal classification', () => {
  const kindOf = (output: string, code: number | null = 1): string =>
    classifySpawnFailure(output, code, 'phase-1').kind

  it('calls a missing binary fatal', () => {
    expect(kindOf('Error: spawn opencode ENOENT', null)).toBe('fatal')
    expect(kindOf('/bin/sh: opencode: command not found', 127)).toBe('fatal')
  })

  it('calls a logged-out server fatal', () => {
    expect(kindOf('http 401 unauthorized', 401)).toBe('fatal')
    expect(kindOf('{"name":"ProviderAuthError"}')).toBe('fatal')
    expect(kindOf('no credentials found; run opencode auth login')).toBe('fatal')
  })

  it('calls an exhausted usage window quota, not fatal', () => {
    expect(kindOf('usage limit reached for this account')).toBe('quota')
    expect(kindOf('http 402 payment required', 402)).toBe('quota')
  })

  it('calls a rate limit a rate limit', () => {
    expect(kindOf('http 429 rate_limit_error', 429)).toBe('rate_limit')
    expect(kindOf('Too many requests', 429)).toBe('rate_limit')
  })

  it('calls a per-account session cap concurrency', () => {
    expect(kindOf('too many concurrent sessions for this account')).toBe('concurrency')
    expect(kindOf('Maximum concurrent agents reached')).toBe('concurrency')
  })

  it('calls an upstream hiccup transient', () => {
    expect(kindOf('http 503 service unavailable', 503)).toBe('transient')
    expect(kindOf('TypeError: fetch failed ECONNREFUSED', null)).toBe('transient')
  })

  it('defaults an unrecognized failure to fatal rather than an unbounded wait', () => {
    expect(kindOf('something nobody has ever seen', 3)).toBe('fatal')
  })

  it('never puts a response body in the refusal message', () => {
    const refusal = classifySpawnFailure('http 429 {"message":"slow down, friend"}', 429, 'phase-7')
    expect(refusal.message).toBe('opencode refused to spawn node phase-7: rate-limited (code 429)')
  })

  it('carries a reported reset time and omits it when none was reported', () => {
    const now = new Date('2026-01-01T10:00:00.000Z')
    const withReset = classifySpawnFailure('http 429 retry-after: 90', 429, 'phase-1', now)
    expect(withReset.retryAfter?.toISOString()).toBe('2026-01-01T10:01:30.000Z')
    expect(classifySpawnFailure('http 429 rate limit', 429, 'phase-1', now).retryAfter).toBe(undefined)
  })

  it('never attaches a retry time to fatal, which is not a wait', () => {
    const refusal = classifySpawnFailure('http 401 unauthorized retry-after: 60', 401, 'n', new Date())
    expect(refusal.kind).toBe('fatal')
    expect(refusal.retryAfter).toBe(undefined)
  })
})

describe('reported reset times', () => {
  const now = new Date('2026-01-01T10:00:00.000Z')

  it('reads a retry-after header in seconds', () => {
    expect(parseRetryAfter('retry-after: 120', now)?.toISOString()).toBe('2026-01-01T10:02:00.000Z')
  })

  it('reads an epoch reset field', () => {
    expect(parseRetryAfter('{"resets_at":1767283200}', now)?.toISOString()).toBe(
      '2026-01-01T16:00:00.000Z',
    )
  })

  it('reads an ISO reset timestamp', () => {
    expect(parseRetryAfter('resets at 2026-01-01T15:30:00Z', now)?.toISOString()).toBe(
      '2026-01-01T15:30:00.000Z',
    )
  })

  it('reports nothing when the server said nothing', () => {
    expect(parseRetryAfter('http 503 overloaded', now)).toBe(undefined)
  })
})

// ---------------------------------------------------------------------------

describe('binary resolution', () => {
  it('prefers the option, then the env var, then the bare name', () => {
    expect(new OpencodeAdapter({ bin: '/opt/opencode-work' }).bin).toBe('/opt/opencode-work')

    const previous = process.env['VINTA_FLOW_OPENCODE_BIN']
    process.env['VINTA_FLOW_OPENCODE_BIN'] = '/opt/from-env'
    try {
      expect(new OpencodeAdapter().bin).toBe('/opt/from-env')
      delete process.env['VINTA_FLOW_OPENCODE_BIN']
      expect(new OpencodeAdapter().bin).toBe('opencode')
    } finally {
      if (previous === undefined) delete process.env['VINTA_FLOW_OPENCODE_BIN']
      else process.env['VINTA_FLOW_OPENCODE_BIN'] = previous
    }
  })
})

describe('preflight', () => {
  it('reports not installed, with the command that installs it', async () => {
    const adapter = new OpencodeAdapter({ bin: join(makeTemp(), 'definitely-not-here') })
    try {
      const result = await adapter.preflight()
      expect(result.installed).toBe(false)
      expect(result.authenticated).toBe(false)
      expect(result.hint?.includes('VINTA_FLOW_OPENCODE_BIN')).toBe(true)
    } finally {
      await adapter.close()
    }
  })

  it('reports a configured server that will not answer as not installed', async () => {
    // Port 1 on loopback: reserved, and nothing this suite could collide with.
    const adapter = new OpencodeAdapter({ baseUrl: 'http://127.0.0.1:1' })
    try {
      const result = await adapter.preflight()
      expect(result.installed).toBe(false)
      expect(result.authenticated).toBe(false)
    } finally {
      await adapter.close()
    }
  })

  it('reports ready when the server lists a provider', async () => {
    const stub = await startStub()
    const adapter = new OpencodeAdapter({ baseUrl: stub.url, cwd: makeTemp() })
    try {
      expect(await adapter.preflight()).toEqual({
        installed: true,
        authenticated: true,
        version: '0.9.9',
      })
    } finally {
      await adapter.close()
      await stub.close()
    }
  })

  it('distinguishes a server nobody logged in on, with the login command', async () => {
    const stub = await startStub()
    stub.providers = []
    const adapter = new OpencodeAdapter({ baseUrl: stub.url, bin: 'opencode', cwd: makeTemp() })
    try {
      const result = await adapter.preflight()
      expect(result.installed).toBe(true)
      expect(result.authenticated).toBe(false)
      expect(result.hint).toBe('opencode auth login')
    } finally {
      await adapter.close()
      await stub.close()
    }
  })

  it('trims a trailing slash off a configured address instead of doubling it', async () => {
    const stub = await startStub()
    const adapter = new OpencodeAdapter({ baseUrl: `${stub.url}/`, cwd: makeTemp() })
    try {
      expect((await adapter.preflight()).installed).toBe(true)
    } finally {
      await adapter.close()
      await stub.close()
    }
  })
})

// ---------------------------------------------------------------------------

describe('spawn against a stub server', () => {
  it('drives a whole session into the normalized stream', async () => {
    const stub = await startStub()
    const adapter = new OpencodeAdapter({ baseUrl: stub.url })
    try {
      const outcome = await adapter.spawn(task())
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      expect(outcome.session.id).toBe(SESSION)
      expect(stub.prompts).toEqual([`/session/${SESSION}/prompt_async`])

      stub.emit({ type: 'server.connected', properties: {} })
      stub.emit(textPart('prt_1', 'working'))
      stub.emit({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_2',
            sessionID: SESSION,
            type: 'tool',
            callID: 'call_1',
            tool: 'read',
            state: { status: 'completed', input: { path: 'a.ts' }, output: 'ok' },
          },
        },
      })
      stub.emit({ type: 'a.variant.shipped.next.year', properties: { sessionID: SESSION } })
      stub.emit(textPart('prt_9', 'another lane', 'ses_other'))
      stub.emit({
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_1',
            sessionID: SESSION,
            role: 'assistant',
            tokens: { input: 3, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
            cost: 0.01,
          },
        },
      })
      stub.emit(idle())

      expect(await drain(outcome.session)).toEqual([
        { type: 'session_started', sessionId: SESSION },
        { type: 'assistant_text', text: 'working' },
        { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a.ts' } },
        { type: 'tool_result', id: 'call_1', ok: true, summary: 'ok' },
        { type: 'usage', input: 3, output: 4, costUsd: 0.01 },
        { type: 'session_ended', result: 'ok' },
      ])
    } finally {
      await adapter.close()
      await stub.close()
    }
  })

  it('resumes a named session instead of creating one', async () => {
    const stub = await startStub()
    const adapter = new OpencodeAdapter({ baseUrl: stub.url })
    try {
      const outcome = await adapter.spawn(task({ resumeSessionId: 'ses_earlier' }))
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      expect(outcome.session.id).toBe('ses_earlier')
      expect(stub.prompts).toEqual(['/session/ses_earlier/prompt_async'])
      await outcome.session.kill()
      await drain(outcome.session)
    } finally {
      await adapter.close()
      await stub.close()
    }
  })

  it('shows an injected message in the transcript and sends it to the session', async () => {
    const stub = await startStub()
    const adapter = new OpencodeAdapter({ baseUrl: stub.url })
    try {
      const outcome = await adapter.spawn(task())
      if (!outcome.ok) throw new Error('spawn refused')
      await outcome.session.send('also update the changelog')
      stub.emit(idle())

      const seen = await drain(outcome.session)
      expect(seen[1]).toEqual({ type: 'user_message', text: 'also update the changelog' })
      expect(stub.prompts.length).toBe(2)
    } finally {
      await adapter.close()
      await stub.close()
    }
  })

  it('reports a rejected injection by code, never by content', async () => {
    const stub = await startStub()
    const adapter = new OpencodeAdapter({ baseUrl: stub.url })
    try {
      const outcome = await adapter.spawn(task())
      if (!outcome.ok) throw new Error('spawn refused')
      stub.promptStatus = 500
      await outcome.session.send('a steering message')
      stub.emit(idle())

      const seen = await drain(outcome.session)
      expect(seen[2]).toEqual({ type: 'error', message: 'opencode rejected an injected message (code 500)' })
    } finally {
      await adapter.close()
      await stub.close()
    }
  })

  it('aborts the session on interrupt and reports the turn as interrupted', async () => {
    const stub = await startStub()
    const adapter = new OpencodeAdapter({ baseUrl: stub.url })
    try {
      const outcome = await adapter.spawn(task())
      if (!outcome.ok) throw new Error('spawn refused')
      await outcome.session.interrupt()
      // The server's own idle still arrives; the interrupt wins the result.
      stub.emit(idle())

      const seen = await drain(outcome.session)
      expect(seen[seen.length - 1]).toEqual({ type: 'session_ended', result: 'interrupted' })
      expect(stub.aborts).toEqual([`/session/${SESSION}/abort`])
    } finally {
      await adapter.close()
      await stub.close()
    }
  })

  it('does not hold a node open forever when the server never reports idle', async () => {
    const stub = await startStub()
    const adapter = new OpencodeAdapter({ baseUrl: stub.url, interruptTimeoutMs: 20 })
    try {
      const outcome = await adapter.spawn(task())
      if (!outcome.ok) throw new Error('spawn refused')
      await outcome.session.interrupt()
      const seen = await drain(outcome.session)
      expect(seen[seen.length - 1]).toEqual({ type: 'session_ended', result: 'interrupted' })
    } finally {
      await adapter.close()
      await stub.close()
    }
  })

  it('kills idempotently and ends the stream exactly once', async () => {
    const stub = await startStub()
    const adapter = new OpencodeAdapter({ baseUrl: stub.url })
    try {
      const outcome = await adapter.spawn(task())
      if (!outcome.ok) throw new Error('spawn refused')
      await outcome.session.kill()
      await outcome.session.kill()
      stub.emit(idle())

      const seen = await drain(outcome.session)
      expect(seen.filter((event) => event.type === 'session_ended').length).toBe(1)
      expect(seen[seen.length - 1]).toEqual({ type: 'session_ended', result: 'interrupted' })
    } finally {
      await adapter.close()
      await stub.close()
    }
  })

  it('gives a second consumer a finished stream rather than a share of the events', async () => {
    const stub = await startStub()
    const adapter = new OpencodeAdapter({ baseUrl: stub.url })
    try {
      const outcome = await adapter.spawn(task())
      if (!outcome.ok) throw new Error('spawn refused')
      const first = outcome.session.events[Symbol.asyncIterator]()
      await first.next()
      expect(await drain(outcome.session)).toEqual([])

      stub.emit(idle())
      const rest: AgentEvent[] = []
      for (;;) {
        const step = await first.next()
        if (step.done === true) break
        rest.push(step.value)
      }
      expect(rest[rest.length - 1]).toEqual({ type: 'session_ended', result: 'ok' })
    } finally {
      await adapter.close()
      await stub.close()
    }
  })

  it('ends a live session with an error when the event stream drops', async () => {
    const stub = await startStub()
    const adapter = new OpencodeAdapter({ baseUrl: stub.url })
    try {
      const outcome = await adapter.spawn(task())
      if (!outcome.ok) throw new Error('spawn refused')
      stub.dropStream()

      const seen = await drain(outcome.session)
      expect(seen.filter((event) => event.type === 'session_ended').length).toBe(1)
      expect(seen[seen.length - 1]).toEqual({ type: 'session_ended', result: 'error' })
      expect(seen.some((event) => event.type === 'error')).toBe(true)
      // A server whose stream is gone is retired, not reconnected to.
      expect(adapter.listServers().length).toBe(0)
    } finally {
      await adapter.close()
      await stub.close()
    }
  })

  it('classifies a rate-limited prompt as a wait, with the reset the server stated', async () => {
    const stub = await startStub()
    stub.promptStatus = 429
    stub.promptRetryAfter = '90'
    const adapter = new OpencodeAdapter({ baseUrl: stub.url })
    try {
      const now = Date.now()
      const outcome = await adapter.spawn(task())
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.kind).toBe('rate_limit')
      expect(outcome.retryAfter instanceof Date).toBe(true)
      expect((outcome.retryAfter?.getTime() ?? 0) > now + 80_000).toBe(true)
      expect(outcome.message.includes('phase-1')).toBe(true)
      expect(outcome.message.includes('body')).toBe(false)
    } finally {
      await adapter.close()
      await stub.close()
    }
  })

  it('classifies a logged-out server as fatal and an overloaded one as transient', async () => {
    const stub = await startStub()
    const adapter = new OpencodeAdapter({ baseUrl: stub.url })
    try {
      stub.promptStatus = 401
      const unauthorized = await adapter.spawn(task())
      expect(unauthorized.ok === false && unauthorized.kind).toBe('fatal')

      stub.promptStatus = 503
      const overloaded = await adapter.spawn(task())
      expect(overloaded.ok === false && overloaded.kind).toBe('transient')
    } finally {
      await adapter.close()
      await stub.close()
    }
  })

  it('returns an injected refusal of every kind without touching the network', async () => {
    // No server anywhere near this address: a forced refusal must short-circuit.
    const adapter = new OpencodeAdapter({ baseUrl: 'http://127.0.0.1:1' })
    try {
      for (const kind of ['rate_limit', 'concurrency', 'quota', 'transient', 'fatal'] as const) {
        adapter.refuseNext(kind)
        const outcome = await adapter.spawn(task())
        expect(outcome.ok).toBe(false)
        if (outcome.ok) return
        expect(outcome.kind).toBe(kind)
        expect(outcome.message.length > 0).toBe(true)
      }
    } finally {
      await adapter.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Server lifecycle: the acceptance criterion, asserted rather than assumed.
// ---------------------------------------------------------------------------

/** A stand-in `opencode` that answers the routes the adapter uses and nothing else. */
const fakeOpencode = (): string => {
  const path = join(makeTemp(), 'opencode-fake')
  writeFileSync(
    path,
    `#!/usr/bin/env node
const http = require('node:http')
const args = process.argv.slice(2)
if (args[0] === '--version') { process.stdout.write('0.9.9\\n'); process.exit(0) }
const port = Number(args[args.indexOf('--port') + 1])
let sessions = 0
const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
http.createServer((req, res) => {
  const url = req.url || ''
  req.resume()
  if (url.startsWith('/global/health')) return json(res, 200, { healthy: true, version: '0.9.9' })
  if (url.startsWith('/config/providers')) return json(res, 200, { providers: [], default: {} })
  if (url.startsWith('/event')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"type":"server.connected","properties":{}}\\n\\n')
    return
  }
  if (req.method === 'POST' && url === '/session') { sessions += 1; return json(res, 200, { id: 'ses_' + sessions }) }
  if (req.method === 'POST' && url.endsWith('/prompt_async')) { res.writeHead(204); res.end(); return }
  return json(res, 404, {})
}).listen(port, '127.0.0.1')
`,
  )
  chmodSync(path, 0o755)
  return path
}

const alive = (pid: number | undefined): boolean => {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const portFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = createSocketServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })

describe.runIf(POSIX_SHELL_FIXTURES)('server lifecycle', () => {
  it('starts a server on a free port and leaves neither socket nor process behind', async () => {
    const adapter = new OpencodeAdapter({ bin: fakeOpencode(), cwd: makeTemp() })
    let pid: number | undefined
    let port = 0
    try {
      const result = await adapter.preflight()
      expect(result.installed).toBe(true)

      const servers = adapter.listServers()
      expect(servers.length).toBe(1)
      const server = servers[0]
      if (server === undefined) throw new Error('no server was started')
      pid = server.pid
      port = Number(new URL(server.baseUrl).port)
      expect(alive(pid)).toBe(true)
      // Never the vendor default: N lanes cannot all have 4096.
      expect(port > 0 && port !== 4096).toBe(true)
      expect(await portFree(port)).toBe(false)
    } finally {
      await adapter.close()
    }

    expect(adapter.listServers().length).toBe(0)
    expect(alive(pid)).toBe(false)
    expect(await portFree(port)).toBe(true)
  })

  it('reuses one server across sessions in a lane and starts one per lane', async () => {
    const adapter = new OpencodeAdapter({ bin: fakeOpencode() })
    const laneA = makeTemp()
    const laneB = makeTemp()
    let pids: (number | undefined)[] = []
    try {
      const first = await adapter.spawn(task({ nodeId: 'phase-1', cwd: laneA }))
      const second = await adapter.spawn(task({ nodeId: 'phase-2', cwd: laneA }))
      expect(first.ok && second.ok).toBe(true)
      // Two nodes, one server: the process outlives the node that started it.
      expect(adapter.listServers().length).toBe(1)

      const third = await adapter.spawn(task({ nodeId: 'phase-3', cwd: laneB }))
      expect(third.ok).toBe(true)
      expect(adapter.listServers().length).toBe(2)
      pids = adapter.listServers().map((server) => server.pid)
      expect(pids.every((pid) => alive(pid))).toBe(true)
    } finally {
      await adapter.close()
    }

    expect(pids.length).toBe(2)
    expect(pids.some((pid) => alive(pid))).toBe(false)
  })

  it('boots at most one server however many spawns race for a lane', async () => {
    const adapter = new OpencodeAdapter({ bin: fakeOpencode() })
    const lane = makeTemp()
    try {
      const outcomes = await Promise.all([
        adapter.spawn(task({ nodeId: 'phase-1', cwd: lane })),
        adapter.spawn(task({ nodeId: 'phase-2', cwd: lane })),
        adapter.spawn(task({ nodeId: 'phase-3', cwd: lane })),
      ])
      expect(outcomes.every((outcome) => outcome.ok)).toBe(true)
      expect(adapter.listServers().length).toBe(1)
    } finally {
      await adapter.close()
    }
  })

  it('refuses without leaking a process when the binary is not a server', async () => {
    const path = join(makeTemp(), 'opencode-broken')
    writeFileSync(path, '#!/bin/sh\ncase "$1" in --version) echo 0.0.1; exit 0;; esac\nexit 9\n')
    chmodSync(path, 0o755)

    const adapter = new OpencodeAdapter({ bin: path })
    try {
      const outcome = await adapter.spawn(task())
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.kind).toBe('fatal')
      expect(adapter.listServers().length).toBe(0)
    } finally {
      await adapter.close()
    }
  })

  it('classifies a server that never becomes ready as a wait, and kills it', async () => {
    const path = join(makeTemp(), 'opencode-hangs')
    // Answers `--version`, then serves nothing at all: health never succeeds.
    writeFileSync(path, '#!/bin/sh\ncase "$1" in --version) echo 0.0.1; exit 0;; esac\nsleep 30\n')
    chmodSync(path, 0o755)

    const adapter = new OpencodeAdapter({ bin: path, startTimeoutMs: 300 })
    try {
      const outcome = await adapter.spawn(task())
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      // Backpressure, not a broken workflow: the node goes back to pending.
      expect(outcome.kind).toBe('transient')
      expect(adapter.listServers().length).toBe(0)
    } finally {
      await adapter.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Live contract, preflight-gated.
// ---------------------------------------------------------------------------

const liveAdapter = new OpencodeAdapter()
const live = await liveAdapter.preflight()

if (!live.installed || !live.authenticated) {
  await liveAdapter.close()
  const reason = live.installed
    ? `the opencode at "${liveAdapter.bin}" has no authenticated provider — run \`${live.hint ?? ''}\` yourself`
    : `no opencode binary at "${liveAdapter.bin}" — set VINTA_FLOW_OPENCODE_BIN`
  describe.skip(`harness adapter contract: opencode (live) — skipped: ${reason}`, () => {
    it('is skipped', () => {})
  })
} else {
  const liveCwd = makeTemp()
  // One adapter for the whole contract: booting a server per test would pay a
  // process start for every assertion, and the point of this adapter is that
  // the server outlives the sessions.
  afterAll(async () => {
    await liveAdapter.close()
  })

  runAdapterContract('opencode (live)', { describe, it, expect }, () => {
    const started: AgentSession[] = []
    // An assertion that throws mid-stream skips the drain that would have ended
    // the session. Recording every one is what makes `dispose` able to
    // guarantee the suite leaves nothing running behind it.
    const adapter: HarnessAdapter = {
      id: liveAdapter.id,
      capabilities: liveAdapter.capabilities,
      preflight: () => liveAdapter.preflight(),
      spawn: async (candidate) => {
        const outcome = await liveAdapter.spawn(candidate)
        if (outcome.ok) started.push(outcome.session)
        return outcome
      },
      // `pty` is false here, so the contract asserts this rejects rather than
      // that it opens anything.
      attachPty: (sessionId) => liveAdapter.attachPty(sessionId),
    }
    return {
      adapter,
      // Short enough that the whole run settles inside the contract's own
      // five-second budget, and cheap enough to run on every commit.
      task: { nodeId: 'contract', cwd: liveCwd, prompt: 'Reply with exactly: ok', model: '' },
      forceRefusal: liveAdapter.refuseNext.bind(liveAdapter),
      dispose: async () => {
        for (const session of started) await session.kill()
      },
    }
  })
}
