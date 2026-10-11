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
import { mkdtempSync, rmSync } from 'node:fs'
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
import { fakeCli, fakeCliFromSource } from './support/fake-cli.ts'

const temps: string[] = []

const makeTemp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-opencode-'))
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
  /** The parsed body of each prompt, in the order `prompts` lists them. */
  readonly promptBodies: unknown[]
  readonly aborts: string[]
  /** What `GET /session/:id/message` answers: the newest messages, oldest first. */
  messages: unknown[]
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
  const promptBodies: unknown[] = []
  const aborts: string[] = []
  let sessions = 0

  const stub = {
    prompts,
    aborts,
    messages: [] as unknown[],
    promptStatus: 204,
    promptRetryAfter: null as string | null,
    providers: [{ id: 'anthropic' }] as unknown[],
  }

  const json = (res: ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  const handle = (req: IncomingMessage, res: ServerResponse, body: string): void => {
    const url = req.url ?? ''
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
    if (req.method === 'GET' && /^\/session\/[^/]+\/message(\?|$)/.test(url)) {
      return json(res, 200, stub.messages)
    }
    if (req.method === 'POST' && url.endsWith('/prompt_async')) {
      prompts.push(url)
      try {
        promptBodies.push(JSON.parse(body))
      } catch {
        promptBodies.push(null)
      }
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

  const server = createHttpServer((req, res) => {
    // The event stream is a GET that never ends, so only a request that has a
    // body waits for it.
    if (req.method !== 'POST') {
      req.resume()
      handle(req, res, '')
      return
    }
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
    })
    req.on('end', () => handle(req, res, body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  // The handler closes over `stub`, so the knobs a test turns have to write
  // through to it rather than to a copy.
  return {
    prompts,
    promptBodies,
    aborts,
    get messages(): unknown[] {
      return stub.messages
    },
    set messages(value: unknown[]) {
      stub.messages = value
    },
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

/**
 * Waits for something the adapter does *not* sequence against its own promises.
 *
 * `interrupt` fires the abort without awaiting it, on purpose (see
 * `opencode.ts`): a server that has stopped answering must not be able to hold
 * an operator's interrupt open, and `request()` carries no timeout. The request
 * is therefore still in flight when the turn ends, and a test that reads
 * `stub.aborts` the instant the drain returns is asserting about whichever of
 * the two finished first. That ordering held on this machine and lost on every
 * CI runner — which is the worst way round, because it made the suite look
 * green on the machine the change was written on.
 *
 * The wait does not weaken the assertion: an adapter that never sent the abort
 * still fails, one timeout later, and the caller still checks *which* path was
 * hit and that it was hit once.
 */
async function until(read: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (read()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
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

const textPart = (id: string, text: string, sessionID = SESSION, messageID = 'msg_1'): unknown => ({
  type: 'message.part.updated',
  properties: { part: { id, sessionID, messageID, type: 'text', text } },
})

/**
 * `message.updated` for one message. opencode publishes it before the
 * message's parts, and the mapper routes a part by the role it announces.
 */
const announce = (
  id: string,
  role: 'user' | 'assistant' = 'assistant',
  extra: Record<string, unknown> = {},
  sessionID = SESSION,
): unknown => ({
  type: 'message.updated',
  properties: { sessionID, info: { id, sessionID, role, ...extra } },
})

const idle = (sessionID = SESSION): unknown => ({
  type: 'session.idle',
  properties: { sessionID },
})


/** The child session a background `task` call runs in, in the fixtures below. */
const CHILD = 'ses_child'

/**
 * The `task` tool's part once it has put a sub-agent in the background: the
 * shape opencode 1.19 publishes, metadata and all. `status` is `running` while
 * the call is still in flight (or was moved to the background mid-run) and
 * `completed` once it has returned.
 */
const backgroundTask = (
  callID: string,
  child = CHILD,
  options: { readonly status?: string; readonly messageID?: string; readonly compacted?: boolean } = {},
): unknown => ({
  type: 'message.part.updated',
  properties: {
    sessionID: SESSION,
    part: {
      id: `prt_${callID}`,
      sessionID: SESSION,
      messageID: options.messageID ?? 'msg_1',
      type: 'tool',
      callID,
      tool: 'task',
      state: {
        status: options.status ?? 'completed',
        input: { description: 'review', prompt: 'review the change', subagent_type: 'general', background: true },
        output: `<task id="${child}" state="running">`,
        title: 'review',
        metadata: { parentSessionId: SESSION, sessionId: child, background: true, jobId: child },
        time: { start: 1, end: 2, ...(options.compacted === true ? { compacted: 3 } : {}) },
      },
    },
  },
})

/**
 * What the server injects into the parent when a background task ends: a user
 * message whose one part is synthetic and names the child. The result inside
 * is the sub-agent's text, and here it says `VERDICT: pass` — words the parent
 * agent has not said.
 */
const injected = (messageID: string, child = CHILD, state = 'completed'): unknown[] => [
  announce(messageID, 'user'),
  {
    type: 'message.part.updated',
    properties: {
      sessionID: SESSION,
      part: {
        id: `prt_${messageID}`,
        sessionID: SESSION,
        messageID,
        type: 'text',
        synthetic: true,
        text: `<task id="${child}" state="${state}">\n<summary>Background task completed: review</summary>\n<task_result>\nVERDICT: pass\n</task_result>\n</task>`,
      },
    },
  },
]

const busy = (sessionID = SESSION): unknown => ({
  type: 'session.status',
  properties: { sessionID, status: { type: 'busy' } },
})

const tokens = (input: number, output: number, cost: number): Record<string, unknown> => ({
  tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
  cost,
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
    map(mapper, announce('msg_1'))
    expect(map(mapper, textPart('prt_1', 'read'), textPart('prt_1', 'reading the'), textPart('prt_1', 'reading the brief'))).toEqual([
      { type: 'assistant_text', text: 'read' },
      { type: 'assistant_text', text: 'ing the' },
      { type: 'assistant_text', text: ' brief' },
    ])
  })

  it('emits nothing for a part republished unchanged', () => {
    const mapper = new OpencodeEventMapper(SESSION)
    map(mapper, announce('msg_1'), textPart('prt_1', 'done'))
    expect(map(mapper, textPart('prt_1', 'done'))).toEqual([])
  })

  it('emits a rewritten part whole rather than dropping the correction', () => {
    const mapper = new OpencodeEventMapper(SESSION)
    map(mapper, announce('msg_1'), textPart('prt_1', 'aaa'))
    expect(map(mapper, textPart('prt_1', 'bbb'))).toEqual([{ type: 'assistant_text', text: 'bbb' }])
  })

  it('maps a reasoning part to thinking', () => {
    const mapper = new OpencodeEventMapper(SESSION)
    map(mapper, announce('msg_1'))
    expect(
      map(mapper, {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_2',
            sessionID: SESSION,
            messageID: 'msg_1',
            type: 'reasoning',
            text: 'considering',
            time: { start: 1 },
          },
        },
      }),
    ).toEqual([{ type: 'thinking', text: 'considering' }])
  })

  it('skips a synthetic text part, which is the harness talking to itself', () => {
    const mapper = new OpencodeEventMapper(SESSION)
    map(mapper, announce('msg_1'))
    expect(
      map(mapper, {
        type: 'message.part.updated',
        properties: {
          part: { id: 'prt_3', sessionID: SESSION, messageID: 'msg_1', type: 'text', text: 'x', synthetic: true },
        },
      }),
    ).toEqual([])
  })

  it('announces a tool call once and settles it once across its status updates', () => {
    const mapper = new OpencodeEventMapper(SESSION)
    map(mapper, announce('msg_1'))
    const part = (state: unknown): unknown => ({
      type: 'message.part.updated',
      properties: {
        part: { id: 'prt_4', sessionID: SESSION, messageID: 'msg_1', type: 'tool', callID: 'call_1', tool: 'read', state },
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
    map(mapper, announce('msg_1'))
    expect(
      map(mapper, {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_5',
            sessionID: SESSION,
            messageID: 'msg_1',
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

    // The zeroes are reported ones: these messages carried a `cache` object
    // saying nothing was read or written, which is a cold turn and not an
    // absence of information (§15.6).
    expect(map(mapper, idle())).toEqual([
      { type: 'usage', input: 200, output: 40, costUsd: 0.05, cacheRead: 0, cacheWrite: 0 },
      { type: 'session_ended', result: 'ok' },
    ])
  })

  it('sums the cache counters the provider reported, alongside the tokens', () => {
    // §15.6. opencode nests them under `tokens.cache`, outside `tokens.input` —
    // so the three sum to the prompt and none double-counts another.
    const mapper = new OpencodeEventMapper(SESSION)
    const message = (id: string, read: number, write: number): unknown => ({
      type: 'message.updated',
      properties: {
        info: {
          id,
          sessionID: SESSION,
          role: 'assistant',
          tokens: { input: 100, output: 20, reasoning: 0, cache: { read, write } },
          cost: 0,
        },
      },
    })
    map(mapper, message('msg_1', 9_000, 500))
    map(mapper, message('msg_2', 1_000, 0))

    expect(map(mapper, idle())[0]).toEqual({
      type: 'usage',
      input: 200,
      output: 40,
      cacheRead: 10_000,
      cacheWrite: 500,
    })
  })

  it('reports no cache figures at all where the provider reported none', () => {
    // Unknown is not zero (§15.6): a provider that says nothing about caching
    // must not aggregate as one that achieved a 0% hit rate.
    const mapper = new OpencodeEventMapper(SESSION)
    map(mapper, {
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_1',
          sessionID: SESSION,
          role: 'assistant',
          tokens: { input: 100, output: 20, reasoning: 0 },
          cost: 0,
        },
      },
    })

    const usage = map(mapper, idle())[0]
    expect(usage).toEqual({ type: 'usage', input: 100, output: 20 })
    expect(usage).not.toHaveProperty('cacheRead')
    expect(usage).not.toHaveProperty('cacheWrite')
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

  /**
   * §6.1's other half: the server's window closing under a running turn, which
   * is a wait rather than a failed phase. Read from `data`, because that is
   * where the sentence is — matched against the refusal table and dropped,
   * never carried, which the assertion on the `error` event below re-checks.
   */
  it('reports a closed window as a capacity refusal, and still carries only the name', () => {
    const mapper = new OpencodeEventMapper(SESSION)

    const events = map(mapper, {
      type: 'session.error',
      properties: {
        sessionID: SESSION,
        error: {
          name: 'ApiError',
          data: { message: 'usage limit reached; resets at 2026-01-01T15:30:00Z' },
        },
      },
    })

    expect(events).toEqual([{ type: 'error', message: 'opencode session error: ApiError' }])
    expect(mapper.refusal?.kind).toBe('quota')
    expect(mapper.refusal?.retryAfter?.toISOString()).toBe('2026-01-01T15:30:00.000Z')
  })

  it('reports no refusal for a fatal error, which is not a wait', () => {
    const mapper = new OpencodeEventMapper(SESSION)

    map(mapper, {
      type: 'session.error',
      properties: {
        sessionID: SESSION,
        error: { name: 'ProviderAuthError', data: { message: 'unauthorized' } },
      },
    })

    // `fatal` is not a wait: parking on a logged-out server would stall the run
    // for a window that never opens.
    expect(mapper.refusal).toBe(undefined)
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

  /**
   * opencode publishes the user's own prompt as parts too. Read as the agent's
   * words, a review prompt's literal `VERDICT: pass` line was an approval the
   * agent never gave: the verdict reader is an unanchored match over the turn's
   * assistant text.
   */
  it('never echoes the prompt as the agent speaking, whichever frame comes first', () => {
    const prompt = 'Review the change.\nEnd with exactly one line:\nVERDICT: pass'
    const announcedFirst = new OpencodeEventMapper(SESSION)
    expect(map(announcedFirst, announce('msg_u', 'user'), textPart('prt_u', prompt, SESSION, 'msg_u'))).toEqual([])

    const partFirst = new OpencodeEventMapper(SESSION)
    expect(map(partFirst, textPart('prt_u', prompt, SESSION, 'msg_u'), announce('msg_u', 'user'))).toEqual([])

    // The guard is the role, not a blanket delay: a part that beat its
    // assistant message out is emitted when the message is announced.
    const early = new OpencodeEventMapper(SESSION)
    expect(map(early, textPart('prt_a', 'VERDICT: fail', SESSION, 'msg_a'))).toEqual([])
    expect(map(early, announce('msg_a'))).toEqual([{ type: 'assistant_text', text: 'VERDICT: fail' }])
  })

  it('maps a permission request in the shape opencode 1.19 publishes it', () => {
    const mapper = new OpencodeEventMapper(SESSION)
    expect(
      map(mapper, {
        type: 'permission.asked',
        properties: {
          id: 'per_1',
          sessionID: SESSION,
          permission: 'bash',
          patterns: ['rm -rf the repository, which is agent output'],
          metadata: { command: 'ls' },
          always: ['*'],
          tool: { messageID: 'msg_1', callID: 'call_1' },
        },
      }),
    ).toEqual([{ type: 'permission_request', tool: 'bash', detail: { command: 'ls' } }])
    expect(
      map(mapper, { type: 'permission.asked', properties: { sessionID: 'ses_other', permission: 'bash' } }),
    ).toEqual([])
  })

  describe('background tasks', () => {
    it('counts a task the agent put in the background until the server reports it', () => {
      const mapper = new OpencodeEventMapper(SESSION)
      map(mapper, announce('msg_1'), backgroundTask('call_1', CHILD, { status: 'running' }))
      expect(mapper.pendingBackground).toBe(1)
      expect(mapper.sawBackground).toBe(true)

      // The child's own idle comes first, and says nothing about the parent.
      map(mapper, idle(CHILD), backgroundTask('call_1'))
      expect(mapper.pendingBackground).toBe(1)

      // The injected result is a user message: it settles the task and is not
      // the agent speaking, whatever the sub-agent wrote.
      expect(map(mapper, ...injected('msg_2'))).toEqual([])
      expect(mapper.pendingBackground).toBe(0)
    })

    it('counts a foreground task once it is moved to the background', () => {
      const mapper = new OpencodeEventMapper(SESSION)
      const foreground = {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_call_1',
            sessionID: SESSION,
            messageID: 'msg_1',
            type: 'tool',
            callID: 'call_1',
            tool: 'task',
            state: { status: 'running', input: {}, metadata: { sessionId: CHILD }, time: { start: 1 } },
          },
        },
      }
      map(mapper, announce('msg_1'), foreground)
      expect(mapper.pendingBackground).toBe(0)
      map(mapper, backgroundTask('call_1', CHILD, { status: 'running' }))
      expect(mapper.pendingBackground).toBe(1)
    })

    it('does not bring a reported task back when its part is republished or pruned', () => {
      const mapper = new OpencodeEventMapper(SESSION)
      map(mapper, announce('msg_1'), backgroundTask('call_1'), ...injected('msg_2'))
      map(mapper, backgroundTask('call_1'), backgroundTask('call_1', CHILD, { compacted: true }))
      expect(mapper.pendingBackground).toBe(0)

      // A new call resuming the finished sub-agent is new work.
      map(mapper, announce('msg_3'), backgroundTask('call_2', CHILD, { messageID: 'msg_3' }))
      expect(mapper.pendingBackground).toBe(1)
    })

    it('lets a task go when its child session is deleted, since a cancelled one reports nothing', () => {
      const mapper = new OpencodeEventMapper(SESSION)
      map(mapper, announce('msg_1'), backgroundTask('call_1'))
      map(mapper, { type: 'session.deleted', properties: { sessionID: CHILD, info: { id: CHILD } } })
      expect(mapper.pendingBackground).toBe(0)
    })

    it('ignores a background task that belongs to another session', () => {
      const mapper = new OpencodeEventMapper(SESSION)
      const theirs = backgroundTask('call_9') as { properties: { part: Record<string, unknown> } }
      theirs.properties.part['sessionID'] = 'ses_other'
      map(mapper, announce('msg_1'), theirs)
      expect(mapper.pendingBackground).toBe(0)
    })

    it('reports each turn only what it added', () => {
      const mapper = new OpencodeEventMapper(SESSION)
      expect(map(mapper, announce('msg_1', 'assistant', tokens(100, 20, 0.01)), idle())[0]).toEqual({
        type: 'usage',
        input: 100,
        output: 20,
        costUsd: 0.01,
        cacheRead: 0,
        cacheWrite: 0,
      })
      // The first message republished unchanged, and a second one: the second
      // turn reports the second message alone.
      const second = map(
        mapper,
        announce('msg_1', 'assistant', tokens(100, 20, 0.01)),
        announce('msg_3', 'assistant', tokens(50, 5, 0.02)),
        idle(),
      )
      expect(second[0]).toEqual({ type: 'usage', input: 50, output: 5, costUsd: 0.02, cacheRead: 0, cacheWrite: 0 })
      // A turn that moved nothing reports nothing.
      expect(map(mapper, idle())).toEqual([{ type: 'session_ended', result: 'ok' }])
    })
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

  // §6.1: a person logging in fixes this, and nothing else does — so it is
  // neither `fatal` (which fails the subtree) nor a wait (which retries).
  it('calls a logged-out server unauthenticated, for the operator', () => {
    expect(kindOf('http 401 unauthorized', 401)).toBe('unauthenticated')
    expect(kindOf('{"name":"ProviderAuthError"}')).toBe('unauthenticated')
    expect(kindOf('no credentials found; run opencode auth login')).toBe('unauthenticated')
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

  it('calls a refused resume stale — but only where a session id was carried', () => {
    // §15.4 in both directions. The bare 404 is the case the guard earns: on
    // the session's own URL it means the server has forgotten it, and with no
    // resumed id in play it means whatever a 404 usually means.
    for (const [prose, code] of [
      ['http 404 {"data":{"name":"Session.NotFound"}}', 404],
      ['session not found', 400],
      ['unknown session', 400],
    ] as const) {
      expect(classifySpawnFailure(prose, code, 'phase-1', { resuming: true }).kind).toBe(
        'stale_session',
      )
      expect(kindOf(prose, code)).not.toBe('stale_session')
    }
  })

  it('reads a stale session ahead of a pattern that would otherwise match it', () => {
    // Why the row is hoisted rather than merely listed: a 404 body carrying an
    // upstream diagnostic would otherwise be waited on as transient, and a
    // session the server has pruned does not come back after a backoff.
    const prose = 'http 404 {"message":"fetch failed"}'
    expect(classifySpawnFailure(prose, 404, 'phase-1', { resuming: true }).kind).toBe(
      'stale_session',
    )
    expect(kindOf(prose, 404)).toBe('transient')
  })

  it('never waits on a stale session, and never quotes the server about one', () => {
    const refusal = classifySpawnFailure('http 404 retry-after: 60', 404, 'phase-7', {
      resuming: true,
    })
    expect(refusal.message).toBe(
      'opencode refused to spawn node phase-7: resume-session-unknown (code 404)',
    )
    // Not a wait: the answer is one retry on a fresh session, now (§15.4).
    expect(refusal.retryAfter).toBe(undefined)
  })

  it('never puts a response body in the refusal message', () => {
    const refusal = classifySpawnFailure('http 429 {"message":"slow down, friend"}', 429, 'phase-7')
    expect(refusal.message).toBe('opencode refused to spawn node phase-7: rate-limited (code 429)')
  })

  it('carries a reported reset time and omits it when none was reported', () => {
    const now = new Date('2026-01-01T10:00:00.000Z')
    const withReset = classifySpawnFailure('http 429 retry-after: 90', 429, 'phase-1', { now })
    expect(withReset.retryAfter?.toISOString()).toBe('2026-01-01T10:01:30.000Z')
    expect(classifySpawnFailure('http 429 rate limit', 429, 'phase-1', { now }).retryAfter).toBe(undefined)
  })

  it('never attaches a retry time to a login refusal, which is not a wait', () => {
    const refusal = classifySpawnFailure('http 401 unauthorized retry-after: 60', 401, 'n', {
      now: new Date(),
    })
    expect(refusal.kind).toBe('unauthenticated')
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

    const previous = process.env['VINTA_AI_MAESTRO_OPENCODE_BIN']
    process.env['VINTA_AI_MAESTRO_OPENCODE_BIN'] = '/opt/from-env'
    try {
      expect(new OpencodeAdapter().bin).toBe('/opt/from-env')
      delete process.env['VINTA_AI_MAESTRO_OPENCODE_BIN']
      expect(new OpencodeAdapter().bin).toBe('opencode')
    } finally {
      if (previous === undefined) delete process.env['VINTA_AI_MAESTRO_OPENCODE_BIN']
      else process.env['VINTA_AI_MAESTRO_OPENCODE_BIN'] = previous
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
      expect(result.hint?.includes('VINTA_AI_MAESTRO_OPENCODE_BIN')).toBe(true)
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
            messageID: 'msg_1',
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
        { type: 'usage', input: 3, output: 4, costUsd: 0.01, cacheRead: 0, cacheWrite: 0 },
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
      // In flight when the turn ended — see `until` above.
      await until(() => stub.aborts.length > 0, 'the abort to reach the server')
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

  it('classifies a 404 on a resumed session as stale, and on a fresh one as not', async () => {
    // The wiring §15.4 turns on, end to end through a real socket: the same
    // status on the same route means "your token is gone" only when a token
    // was handed to us. A session this adapter created moments ago cannot be
    // stale, whatever the server says about it.
    const stub = await startStub()
    stub.promptStatus = 404
    const adapter = new OpencodeAdapter({ baseUrl: stub.url })
    try {
      const resumed = await adapter.spawn(task({ resumeSessionId: 'ses_pruned' }))
      expect(resumed.ok === false && resumed.kind).toBe('stale_session')
      // Not a wait, so nothing is scheduled for later (§15.4).
      expect(resumed.ok === false ? resumed.retryAfter : 'spawned').toBe(undefined)

      const fresh = await adapter.spawn(task())
      expect(fresh.ok === false && fresh.kind === 'stale_session').toBe(false)
    } finally {
      await adapter.close()
      await stub.close()
    }
  })

  it('classifies a logged-out server as unauthenticated and an overloaded one as transient', async () => {
    const stub = await startStub()
    const adapter = new OpencodeAdapter({ baseUrl: stub.url })
    try {
      stub.promptStatus = 401
      const unauthorized = await adapter.spawn(task())
      expect(unauthorized.ok === false && unauthorized.kind).toBe('unauthenticated')

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
        expect(outcome.message.length > 0).toBe(true)
      }
    } finally {
      await adapter.close()
    }
  })
})


/**
 * A turn is not a session where background tasks run (`backgroundWork`). An
 * agent that starts a sub-agent in the background ends its turn while the
 * sub-agent works; opencode injects the result when it is done and starts the
 * next turn by itself. Ended on the first `session.idle`, that turn went
 * unread — and kept running against the lane.
 */
describe('a session with background work still running', () => {
  const spawned = async (
    options: { readonly backgroundIdleMs?: number } = {},
  ): Promise<{ stub: Stub; adapter: OpencodeAdapter; session: AgentSession }> => {
    const stub = await startStub()
    const adapter = new OpencodeAdapter({ baseUrl: stub.url, ...options })
    const outcome = await adapter.spawn(task())
    if (!outcome.ok) throw new Error('spawn refused')
    return { stub, adapter, session: outcome.session }
  }

  const ANSWERED = [{ info: { id: 'msg_9', sessionID: SESSION, role: 'assistant' }, parts: [] }]
  const UNANSWERED = [{ info: { id: 'msg_2', sessionID: SESSION, role: 'user' }, parts: [] }]

  const texts = (seen: readonly AgentEvent[]): string[] =>
    seen.flatMap((event) => (event.type === 'assistant_text' ? [event.text] : []))

  it('stays open while the task runs and ends after the turn it wakes', async () => {
    const { stub, adapter, session } = await spawned()
    try {
      stub.messages = ANSWERED
      stub.emit(announce('msg_1', 'assistant', tokens(3, 4, 0.01)))
      stub.emit(textPart('prt_1', 'Waiting on the reviewer.'))
      stub.emit(backgroundTask('call_1'))
      stub.emit(busy())
      stub.emit(idle())
      // The child finishing: its idle comes before the injection.
      stub.emit({ type: 'session.status', properties: { sessionID: CHILD, status: { type: 'idle' } } })
      stub.emit(idle(CHILD))
      for (const frame of injected('msg_2')) stub.emit(frame)
      stub.emit(busy())
      stub.emit(announce('msg_3', 'assistant', tokens(1, 2, 0.02)))
      stub.emit(textPart('prt_3', 'VERDICT: pass', SESSION, 'msg_3'))
      stub.emit(idle())

      const seen = await drain(session)
      expect(seen.filter((event) => event.type === 'session_ended')).toEqual([
        { type: 'session_ended', result: 'ok' },
      ])
      expect(seen.at(-1)).toEqual({ type: 'session_ended', result: 'ok' })
      // The sub-agent's `VERDICT: pass` is in the injected message, which is
      // not the agent's text; the woken turn's is.
      expect(texts(seen)).toEqual(['Waiting on the reviewer.', 'VERDICT: pass'])
      expect(stub.aborts).toEqual([])
    } finally {
      await adapter.close()
      await stub.close()
    }
  })

  it('does not end when only the child goes idle', async () => {
    const { stub, adapter, session } = await spawned()
    try {
      const seen: AgentEvent[] = []
      const reading = (async () => {
        for await (const event of session.events) seen.push(event)
      })()
      stub.emit(announce('msg_1'))
      stub.emit(backgroundTask('call_1'))
      stub.emit(idle())
      stub.emit({ type: 'session.status', properties: { sessionID: CHILD, status: { type: 'idle' } } })
      stub.emit(idle(CHILD))
      await new Promise<void>((resolve) => setTimeout(resolve, 150))
      expect(seen.some((event) => event.type === 'session_ended')).toBe(false)

      // Still open, so this is what ends it — and it leaves nothing running.
      await session.kill()
      await reading
      expect(seen.at(-1)).toEqual({ type: 'session_ended', result: 'interrupted' })
      await until(() => stub.aborts.length > 0, 'the abort to reach the server')
      expect(stub.aborts).toEqual([`/session/${SESSION}/abort`])
    } finally {
      await adapter.close()
      await stub.close()
    }
  })

  /**
   * opencode's lost wake-up: the result is injected while the parent's loop is
   * finishing, joins that run instead of starting one, and the session goes
   * idle with a user message nobody answered.
   */
  it('prompts again, with no parts, when the session went idle on an unanswered result', async () => {
    const { stub, adapter, session } = await spawned()
    try {
      stub.messages = UNANSWERED
      stub.emit(announce('msg_1'))
      stub.emit(backgroundTask('call_1'))
      for (const frame of injected('msg_2')) stub.emit(frame)
      stub.emit(idle())

      await until(() => stub.prompts.length === 2, 'the re-prompt')
      // No parts: opencode leaves an empty user message out of the model's
      // context, so the turn answers the injected result. Same model as the
      // prompt, so the turn is not quietly run on another one.
      expect(stub.promptBodies[1]).toEqual({
        parts: [],
        model: { providerID: 'anthropic', modelID: 'claude-haiku' },
      })

      stub.messages = ANSWERED
      stub.emit(busy())
      stub.emit(announce('msg_3'))
      stub.emit(textPart('prt_3', 'VERDICT: pass', SESSION, 'msg_3'))
      stub.emit(idle())

      const seen = await drain(session)
      expect(seen.at(-1)).toEqual({ type: 'session_ended', result: 'ok' })
      expect(texts(seen)).toEqual(['VERDICT: pass'])
      expect(stub.prompts.length).toBe(2)
    } finally {
      await adapter.close()
      await stub.close()
    }
  })

  it('prompts again once, and ends when that draws no answer', async () => {
    const { stub, adapter, session } = await spawned()
    try {
      stub.messages = UNANSWERED
      stub.emit(announce('msg_1'))
      stub.emit(backgroundTask('call_1'))
      for (const frame of injected('msg_2')) stub.emit(frame)
      stub.emit(idle())
      await until(() => stub.prompts.length === 2, 'the re-prompt')

      stub.emit(busy())
      stub.emit(idle())

      const seen = await drain(session)
      expect(seen.at(-1)).toEqual({ type: 'session_ended', result: 'ok' })
      expect(stub.prompts.length).toBe(2)
    } finally {
      await adapter.close()
      await stub.close()
    }
  })

  it('ends a session the task never reports back to, and cancels the task', async () => {
    const { stub, adapter, session } = await spawned({ backgroundIdleMs: 100 })
    try {
      stub.emit(announce('msg_1'))
      stub.emit(textPart('prt_1', 'done'))
      stub.emit(backgroundTask('call_1'))
      stub.emit(idle())

      const seen = await drain(session)
      expect(seen.at(-1)).toEqual({ type: 'session_ended', result: 'ok' })
      expect(seen.some((event) => event.type === 'error')).toBe(false)
      await until(() => stub.aborts.length > 0, 'the abort to reach the server')
      expect(stub.aborts).toEqual([`/session/${SESSION}/abort`])
    } finally {
      await adapter.close()
      await stub.close()
    }
  })

  it('keeps a session the task is still talking through open past the silence bound', async () => {
    const { stub, adapter, session } = await spawned({ backgroundIdleMs: 150 })
    try {
      stub.messages = ANSWERED
      stub.emit(announce('msg_1'))
      stub.emit(backgroundTask('call_1'))
      stub.emit(idle())
      // The child at work, inside the bound each time, for longer than it.
      for (let i = 0; i < 4; i += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 75))
        stub.emit(textPart(`prt_child_${i}`, 'reviewing', CHILD, 'msg_child'))
      }
      for (const frame of injected('msg_2')) stub.emit(frame)
      stub.emit(busy())
      stub.emit(announce('msg_3'))
      stub.emit(textPart('prt_3', 'VERDICT: pass', SESSION, 'msg_3'))
      stub.emit(idle())

      const seen = await drain(session)
      expect(texts(seen)).toEqual(['VERDICT: pass'])
      expect(stub.aborts).toEqual([])
    } finally {
      await adapter.close()
      await stub.close()
    }
  })

  it('ends at once on a turn that failed, and cancels what it left running', async () => {
    const { stub, adapter, session } = await spawned()
    try {
      stub.emit(announce('msg_1'))
      stub.emit(backgroundTask('call_1'))
      stub.emit({ type: 'session.error', properties: { sessionID: SESSION, error: { name: 'APIError' } } })
      stub.emit(idle())

      const seen = await drain(session)
      expect(seen.at(-1)).toEqual({ type: 'session_ended', result: 'error' })
      await until(() => stub.aborts.length > 0, 'the abort to reach the server')
      expect(stub.aborts).toEqual([`/session/${SESSION}/abort`])
    } finally {
      await adapter.close()
      await stub.close()
    }
  })

  it('reports each turn its own usage, so the sum is the session', async () => {
    const { stub, adapter, session } = await spawned()
    try {
      stub.messages = ANSWERED
      stub.emit(announce('msg_1', 'assistant', tokens(100, 20, 0.01)))
      stub.emit(backgroundTask('call_1'))
      stub.emit(idle())
      for (const frame of injected('msg_2')) stub.emit(frame)
      stub.emit(busy())
      // The first turn's message republished, unchanged, during the second.
      stub.emit(announce('msg_1', 'assistant', tokens(100, 20, 0.01)))
      stub.emit(announce('msg_3', 'assistant', tokens(50, 5, 0.02)))
      stub.emit(idle())

      const usage = (await drain(session)).flatMap((event) => (event.type === 'usage' ? [event] : []))
      expect(usage.map((event) => [event.input, event.output])).toEqual([
        [100, 20],
        [50, 5],
      ])
      expect(usage[0]?.costUsd).toBeCloseTo(0.01)
      expect(usage[1]?.costUsd).toBeCloseTo(0.02)
    } finally {
      await adapter.close()
      await stub.close()
    }
  })

  it('does not end on an idle before the prompt was answered', async () => {
    // The prompt landed while an earlier run of a resumed session was exiting,
    // which is the same lost wake-up with the operator's prompt in it.
    const { stub, adapter, session } = await spawned()
    try {
      stub.messages = [{ info: { id: 'msg_p', sessionID: SESSION, role: 'user' }, parts: [] }]
      stub.emit(idle())
      await until(() => stub.prompts.length === 2, 'the re-prompt')

      stub.messages = ANSWERED
      stub.emit(busy())
      stub.emit(announce('msg_1'))
      stub.emit(textPart('prt_1', 'on it'))
      stub.emit(idle())

      const seen = await drain(session)
      expect(texts(seen)).toEqual(['on it'])
      expect(seen.at(-1)).toEqual({ type: 'session_ended', result: 'ok' })
    } finally {
      await adapter.close()
      await stub.close()
    }
  })

  it('never shows the prompt opencode echoes back as the agent’s text', async () => {
    const { stub, adapter, session } = await spawned()
    try {
      stub.emit(announce('msg_u', 'user'))
      stub.emit(textPart('prt_u', 'Review it.\nVERDICT: pass', SESSION, 'msg_u'))
      stub.emit(announce('msg_1'))
      stub.emit(idle())

      expect(texts(await drain(session))).toEqual([])
    } finally {
      await adapter.close()
      await stub.close()
    }
  })
})

describe('background work as a capability', () => {
  it('is promised only by a server this adapter starts, whose environment it sets', () => {
    expect(new OpencodeAdapter({ bin: 'opencode' }).capabilities.backgroundWork).toBe(true)
    // Somebody else's server: the switch is in an environment this adapter
    // never set, so nothing is promised — even though a session still holds.
    expect(new OpencodeAdapter({ baseUrl: 'http://127.0.0.1:1' }).capabilities.backgroundWork).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Server lifecycle: the acceptance criterion, asserted rather than assumed.
// ---------------------------------------------------------------------------

/**
 * A stand-in `opencode` that answers the routes the adapter uses and nothing
 * else.
 *
 * Source rather than a spec: a spec describes a CLI that writes some lines and
 * exits, and this one is an HTTP server that has to stay up until it is killed
 * — which is the whole point of the block below. Written as Node it is the
 * same program on either platform, and the launcher `fakeCliFromSource` pairs
 * it with is the shape npm actually installs, so the `.cmd` routing in
 * `commandInvocation` is exercised here too.
 */
const fakeOpencode = (): string =>
  fakeCliFromSource(
    makeTemp(),
    'opencode-fake',
    `import http from 'node:http'
const args = process.argv.slice(2)
if (args[0] === '--version') { process.stdout.write('0.9.9\\n'); process.exit(0) }
const port = Number(args[args.indexOf('--port') + 1])
let sessions = 0
const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const srv = http.createServer((req, res) => {
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
})
srv.on('error', (error) => {
  process.stderr.write('fake listen failed: ' + String(error && error.message) + '\\n')
  process.exit(1)
})
srv.listen(port, '127.0.0.1')
`,
  )

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

describe('server lifecycle', () => {
  /**
   * Short on purpose. The adapter's default boot budget is 30s, which is also
   * vitest's default timeout, so a server that never becomes healthy killed the
   * test before any assertion could say why. Refusing at 8s leaves the failure
   * inside the test, where it can carry the fake's log.
   */
  const BOOT_MS = 8_000


  it('starts a server on a free port and leaves neither socket nor process behind', async () => {
    const adapter = new OpencodeAdapter({ bin: fakeOpencode(), cwd: makeTemp(), startTimeoutMs: BOOT_MS })
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
    const adapter = new OpencodeAdapter({ bin: fakeOpencode(), startTimeoutMs: BOOT_MS })
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
    const adapter = new OpencodeAdapter({ bin: fakeOpencode(), startTimeoutMs: BOOT_MS })
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
    // Answers `--version` so it counts as installed, then refuses to serve.
    const path = fakeCli(makeTemp(), 'opencode-broken', { version: '0.0.1', exit: 9 })

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
    // Answers `--version`, then serves nothing at all: health never succeeds.
    // The linger outlives the 300ms start deadline by two orders of magnitude,
    // so if the adapter failed to kill it the test would see it still running
    // rather than racing a fixture that happened to exit on its own.
    const path = fakeCli(makeTemp(), 'opencode-hangs', { version: '0.0.1', lingerMs: 30_000 })

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

  it('starts its server with background sub-agents switched on, over a lane that says otherwise', async () => {
    // Reports the switch it was started with as its version, which is a
    // channel the adapter already reads back.
    const bin = fakeCliFromSource(
      makeTemp(),
      'opencode-env',
      `import http from 'node:http'
const args = process.argv.slice(2)
if (args[0] === '--version') process.exit(0)
const port = Number(args[args.indexOf('--port') + 1])
const flag = String(process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS)
const srv = http.createServer((req, res) => {
  req.resume()
  const url = req.url || ''
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (url.startsWith('/global/health')) return json(200, { healthy: true, version: 'flag=' + flag })
  if (url.startsWith('/config/providers')) return json(200, { providers: [{ id: 'x' }], default: {} })
  if (url.startsWith('/event')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ok\\n\\n'); return }
  if (req.method === 'POST' && url === '/session') return json(200, { id: 'ses_1' })
  if (req.method === 'POST' && url.endsWith('/prompt_async')) { res.writeHead(204); res.end(); return }
  return json(404, {})
})
srv.listen(port, '127.0.0.1')
`,
    )
    const adapter = new OpencodeAdapter({ bin, startTimeoutMs: BOOT_MS })
    try {
      const outcome = await adapter.spawn(
        task({ env: { OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: 'false', OPENCODE_EXPERIMENTAL: 'false' } }),
      )
      expect(outcome.ok).toBe(true)
      const server = adapter.listServers()[0]
      if (server === undefined) throw new Error('no server was started')
      const health = (await (await fetch(`${server.baseUrl}/global/health`)).json()) as { version: string }
      expect(health.version).toBe('flag=true')
      if (outcome.ok) await outcome.session.kill()
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
    : `no opencode binary at "${liveAdapter.bin}" — set VINTA_AI_MAESTRO_OPENCODE_BIN`
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
    const liveTask: AgentTask = {
      nodeId: 'contract',
      cwd: liveCwd,
      prompt: 'Reply with exactly: ok',
      model: '',
    }
    return {
      adapter,
      // Short enough that the whole run settles inside the contract's own
      // five-second budget, and cheap enough to run on every commit.
      task: liveTask,
      // A session id this server never issued, which is the only way to see
      // what it actually answers for one it does not have (§15.4). Where the
      // answer changes shape this is the test that says so — the pattern table
      // cannot notice on its own.
      staleResumeTask: { ...liveTask, resumeSessionId: 'ses_vintaaimaestrocontractnosuchsession' },
      forceRefusal: liveAdapter.refuseNext.bind(liveAdapter),
      dispose: async () => {
        for (const session of started) await session.kill()
      },
    }
  })
}
