/**
 * A stand-in `codex app-server`: JSON-RPC over stdio, scripted as data.
 *
 * The adapter is a protocol client now, so a fake that prints lines and exits
 * would test nothing that breaks. This one answers requests, plays a script of
 * notifications after each `turn/start`, sends server requests and reads the
 * replies, and writes every message the client sent to a log the test reads
 * back — the handshake, the thread parameters, the wake turn's input and the
 * cleanup are all assertions about what the *client* said.
 *
 * Every shape below was transcribed from a recorded session against codex-cli
 * 0.147.0. The script is Node source built by `fakeCliFromSource`, so it runs
 * as the same program on every platform.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fakeCliFromSource } from './fake-cli.ts'

/**
 * One step of a turn's script. Strings `$THREAD` and `$TURN` anywhere in a
 * payload become the thread id and the id of the turn being played.
 */
export type FakeStep =
  | { readonly notify: string; readonly params: unknown }
  /** A server→client request; the reply lands in the log. */
  | { readonly request: string; readonly params: unknown }
  | { readonly delayMs: number }
  /** Hold the script until the client has sent this method (counting from the start). */
  | { readonly waitFor: string }
  | { readonly exit: number }

export interface FakeAppServerSpec {
  /** What `--version` prints. */
  readonly version?: string
  /** What `login status` prints, and its exit code. */
  readonly login?: { readonly output: string; readonly exit: number }
  /** Exit at startup instead of serving: what a server that cannot boot does. */
  readonly boot?: { readonly stderr: string; readonly exit: number }
  /** Replies that replace the defaults, by method. */
  readonly replies?: Readonly<
    Record<string, { readonly result?: unknown; readonly error?: { readonly code: number; readonly message: string } }>
  >
  readonly threadId?: string
  /** The script after the reply to the Nth `turn/start`. Turns past the end play nothing. */
  readonly turns?: readonly (readonly FakeStep[])[]
  /** Successive answers to `thread/backgroundTerminals/list`; the last one repeats. */
  readonly terminals?: readonly (readonly unknown[])[]
  /** Notifications sent right after the reply to `thread/resume` (the usage replay). */
  readonly afterResume?: readonly FakeStep[]
}

export interface FakeAppServer {
  readonly bin: string
  /** Every message the client sent, in order. The argv and pid are the first entry. */
  log(): Array<Record<string, unknown>>
  /** The client's requests and notifications with this method. */
  sent(method: string): Array<Record<string, unknown>>
}

export const FAKE_THREAD = 'thread-fake'

export function fakeCodexAppServer(dir: string, spec: FakeAppServerSpec = {}): FakeAppServer {
  const logPath = join(dir, 'app-server.log')
  const bin = fakeCliFromSource(dir, 'codex-fake', render(spec, logPath))
  const log = (): Array<Record<string, unknown>> => {
    try {
      return readFileSync(logPath, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    } catch {
      return []
    }
  }
  return { bin, log, sent: (method) => log().filter((entry) => entry['method'] === method) }
}

function render(spec: FakeAppServerSpec, logPath: string): string {
  const config = {
    version: spec.version ?? 'codex-cli 0.147.0',
    login: spec.login ?? { output: 'Logged in using ChatGPT', exit: 0 },
    boot: spec.boot ?? null,
    replies: spec.replies ?? {},
    threadId: spec.threadId ?? FAKE_THREAD,
    turns: spec.turns ?? [],
    terminals: spec.terminals ?? [[]],
    afterResume: spec.afterResume ?? [],
    logPath,
  }
  return `
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const config = ${JSON.stringify(config)}
const argv = process.argv.slice(2)
if (argv[0] === '--version') { process.stdout.write(config.version + '\\n'); process.exit(0) }
if (argv[0] === 'login') { process.stdout.write(config.login.output + '\\n'); process.exit(config.login.exit) }
const record = (entry) => appendFileSync(config.logPath, JSON.stringify(entry) + '\\n')
record({ argv, pid: process.pid })
if (config.boot) { process.stderr.write(config.boot.stderr + '\\n'); process.exit(config.boot.exit) }

let thread = config.threadId
let turnCount = 0
let activeTurn = null
let listCalls = 0
let nextRequest = 1000
const seen = []
const waiters = []
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
const fill = (value, turn) =>
  JSON.parse(JSON.stringify(value ?? null).split('$THREAD').join(thread).split('$TURN').join(turn ?? ''))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = (method) =>
  seen.includes(method) ? Promise.resolve() : new Promise((resolve) => waiters.push({ method, resolve }))

async function play(steps, turn) {
  for (const step of steps) {
    if ('delayMs' in step) await sleep(step.delayMs)
    else if ('waitFor' in step) await waitFor(step.waitFor)
    else if ('exit' in step) process.exit(step.exit)
    else if ('request' in step) send({ id: nextRequest++, method: step.request, params: fill(step.params, turn) })
    else {
      const params = fill(step.params, turn)
      if (step.notify === 'turn/started') activeTurn = turn
      if (step.notify === 'turn/completed' && activeTurn === turn) activeTurn = null
      send({ method: step.notify, params })
    }
  }
}

const turnObject = (id, status) => ({ id, items: [], itemsView: 'notLoaded', status, error: null, startedAt: null, completedAt: null, durationMs: null })

function reply(message) {
  const { id, method, params } = message
  const override = config.replies[method]
  if (override) {
    if (override.error) return send({ id, error: override.error })
    if (method === 'thread/start' || method === 'thread/resume') {
      const result = fill(override.result)
      if (result && result.thread && result.thread.id) thread = result.thread.id
      return send({ id, result })
    }
    return send({ id, result: fill(override.result) })
  }
  switch (method) {
    case 'initialize':
      return send({ id, result: { userAgent: 'fake/0.147.0', codexHome: '/tmp/fake', platformFamily: 'unix', platformOs: 'macos' } })
    case 'account/read':
      return send({ id, result: { account: { type: 'chatgpt', email: null, planType: 'plus' }, requiresOpenaiAuth: true } })
    case 'thread/start':
      send({ id, result: { thread: { id: thread, parentThreadId: null, ephemeral: false, status: { type: 'idle' } } } })
      return send({ method: 'thread/started', params: { thread: { id: thread, parentThreadId: null, status: { type: 'idle' } } } })
    case 'thread/resume':
      thread = params.threadId
      send({ id, result: { thread: { id: thread, parentThreadId: null, ephemeral: false, status: { type: 'idle' } } } })
      return void play(config.afterResume, null)
    case 'turn/start': {
      const turn = 'turn-' + (++turnCount)
      send({ id, result: { turn: turnObject(turn, 'inProgress') } })
      return void play(config.turns[turnCount - 1] ?? [], turn)
    }
    case 'turn/steer':
      return send({ id, result: { turnId: params.expectedTurnId } })
    case 'turn/interrupt': {
      send({ id, result: {} })
      if (activeTurn === null) return
      const turn = activeTurn
      activeTurn = null
      return send({ method: 'turn/completed', params: { threadId: thread, turn: turnObject(turn, 'interrupted') } })
    }
    case 'thread/backgroundTerminals/list': {
      const data = config.terminals[Math.min(listCalls++, config.terminals.length - 1)] ?? []
      return send({ id, result: { data: fill(data), nextCursor: null } })
    }
    case 'thread/backgroundTerminals/clean':
      return send({ id, result: {} })
    default:
      return send({ id, error: { code: -32601, message: 'method not found: ' + method } })
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  record(message)
  if (typeof message.method === 'string') {
    seen.push(message.method)
    for (const waiter of waiters.splice(0)) {
      if (waiter.method === message.method) waiter.resolve()
      else waiters.push(waiter)
    }
  }
  if (typeof message.method === 'string' && message.id !== undefined) reply(message)
}).on('close', () => process.exit(0))
`
}

// ---------------------------------------------------------------------------
// Payload builders — the recorded shapes, minus what the adapter never reads.
// ---------------------------------------------------------------------------

export const turnStarted = (): FakeStep => ({
  notify: 'turn/started',
  params: { threadId: '$THREAD', turn: { id: '$TURN', items: [], status: 'inProgress', error: null } },
})

export const turnCompleted = (
  status: 'completed' | 'failed' | 'interrupted' = 'completed',
  error: unknown = null,
): FakeStep => ({
  notify: 'turn/completed',
  params: { threadId: '$THREAD', turn: { id: '$TURN', items: [], status, error } },
})

export const itemStarted = (item: Record<string, unknown>, threadId = '$THREAD'): FakeStep => ({
  notify: 'item/started',
  params: { item, threadId, turnId: '$TURN', startedAtMs: 0 },
})

/** `turnId` is overridable because a backgrounded command reports under the turn that started it. */
export const itemCompleted = (
  item: Record<string, unknown>,
  options: { readonly threadId?: string; readonly turnId?: string } = {},
): FakeStep => ({
  notify: 'item/completed',
  params: { item, threadId: options.threadId ?? '$THREAD', turnId: options.turnId ?? '$TURN', completedAtMs: 0 },
})

export const agentMessage = (id: string, text: string): Record<string, unknown> => ({
  type: 'agentMessage',
  id,
  text,
  phase: 'final_answer',
  memoryCitation: null,
})

export const reasoning = (id: string, summary: readonly string[] = []): Record<string, unknown> => ({
  type: 'reasoning',
  id,
  summary,
  content: [],
})

export const command = (
  id: string,
  processId: string | null,
  line: string,
  done?: { readonly exitCode: number; readonly output?: string },
): Record<string, unknown> => ({
  type: 'commandExecution',
  id,
  pluginId: null,
  scriptPath: null,
  command: `/bin/zsh -lc '${line}'`,
  cwd: '/lane',
  processId,
  source: 'unifiedExecStartup',
  status: done === undefined ? 'inProgress' : done.exitCode === 0 ? 'completed' : 'failed',
  commandActions: [],
  aggregatedOutput: done?.output ?? null,
  exitCode: done?.exitCode ?? null,
  durationMs: done === undefined ? null : 1,
})

export const tokenUsage = (total: {
  readonly input: number
  readonly cached?: number
  readonly output: number
}): FakeStep => {
  const breakdown = {
    totalTokens: total.input + total.output,
    inputTokens: total.input,
    cachedInputTokens: total.cached ?? 0,
    cacheWriteInputTokens: 0,
    outputTokens: total.output,
    reasoningOutputTokens: 0,
  }
  return {
    notify: 'thread/tokenUsage/updated',
    // `last` restates the same figures on purpose: the server re-sends it,
    // and an adapter that summed it would count this response twice.
    params: { threadId: '$THREAD', turnId: '$TURN', tokenUsage: { total: breakdown, last: breakdown, modelContextWindow: 258400 } },
  }
}

export const threadStatus = (threadId: string, type: 'active' | 'idle'): FakeStep => ({
  notify: 'thread/status/changed',
  params: { threadId, status: type === 'active' ? { type, activeFlags: [] } : { type } },
})

/** A sub-agent thread's own turn boundary; its turn id is its own business. */
export const childTurn = (threadId: string, phase: 'started' | 'completed'): FakeStep => ({
  notify: `turn/${phase}`,
  params: {
    threadId,
    turn: { id: `${threadId}-turn`, items: [], status: phase === 'started' ? 'inProgress' : 'completed', error: null },
  },
})

export const spawnAgent = (id: string, child: string, status: 'inProgress' | 'completed'): Record<string, unknown> => ({
  type: 'collabAgentToolCall',
  id,
  tool: 'spawnAgent',
  status,
  senderThreadId: '$THREAD',
  receiverThreadIds: status === 'completed' ? [child] : [],
  prompt: 'run the checks',
  model: null,
  reasoningEffort: null,
  agentsStates: status === 'completed' ? { [child]: { status: 'pendingInit', message: null } } : {},
})
