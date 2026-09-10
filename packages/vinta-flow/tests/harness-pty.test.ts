/**
 * Interactive takeover (§9's fifth operation), end to end and without a CLI.
 *
 * Everything below runs against a **fake binary** written into a temp dir: a
 * shell script that reports the argv it was given, echoes lines back, and
 * prints its own terminal size on request. That last one is the whole reason a
 * script is enough — a resize is observable as the tty's `winsize`, which
 * `stty size` reads, so "the resize reached the terminal" is an assertion
 * rather than a spy on a method call.
 *
 * Three claims this file exists to hold to.
 *
 * - **No orphan, proved with a pid.** Every teardown path is followed by
 *   `kill(pid, 0)` on the pty leader *and* on a background process the script
 *   started inside it, because the leader dying while its children keep the
 *   worktree open is exactly the failure `signalGroup` exists to prevent.
 * - **The session id survives the round trip.** §9 makes it the handoff token,
 *   so the assertion is that the id the headless session had is the id the
 *   terminal was opened with and the id the resume asked for.
 * - **An unauthenticated peer never reaches a shell.** Asserted by counting
 *   attaches, not by watching a socket close: a socket that closes after a
 *   process was spawned has already lost.
 *
 * Nothing here logs terminal bytes. They are collected into a local string and
 * matched; they never reach a message, and the assertions quote only the fixed
 * markers the fake script itself prints.
 */
import { execFileSync, spawn as spawnChild } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import {
  HarnessCapabilityError,
  type AgentSession,
  type AgentTask,
  type HarnessAdapter,
  type PtyHandle,
} from '../src/harness/adapter.ts'
import { ClaudeCodeAdapter } from '../src/harness/claude-code.ts'
import { CodexAdapter } from '../src/harness/codex.ts'
import { MockAdapter } from '../src/harness/mock.ts'
import { OpencodeAdapter } from '../src/harness/opencode.ts'
import { AdmissionControl } from '../src/admission/admission.ts'
import { runControl } from '../src/daemon/control.ts'
import { startDaemon, type Daemon } from '../src/daemon/server.ts'
import { ResourcePools } from '../src/resources/pools.ts'
import { createScheduler } from '../src/scheduler/index.ts'
import { PtyClientFrameSchema, PtyServerFrameSchema } from '../src/daemon/pty-frames.ts'
import { takeOver, takeovers, type TakeoverTarget } from '../src/daemon/pty.ts'
import { EventFrameSchema } from '../src/daemon/schemas.ts'
import { openJournal } from '../src/journal/journal.ts'
import { WorkflowSchema, type Workflow } from '../src/types.ts'
import { POSIX_SHELL_FIXTURES } from './support/platform.ts'

const cleanups: (() => void | Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const makeTemp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-flow-pty-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * A CLI stand-in with a terminal's three observable behaviours: it says what
 * it was invoked with, it echoes, and it reports its window size. The
 * background `sleep` is the orphan detector — it shares the pty's process
 * group, so it survives a teardown that signalled only the leader.
 */
const FAKE_CLI = `#!/bin/sh
sleep 300 &
echo "child:$!"
echo "args:$*"
while IFS= read -r line; do
  case "$line" in
    size) stty size ;;
    quit) exit 7 ;;
    *) echo "echo:$line" ;;
  esac
done
`

const fakeCli = (): string => {
  const path = join(makeTemp(), 'harness-fake')
  writeFileSync(path, FAKE_CLI)
  chmodSync(path, 0o755)
  return path
}

/** `kill(pid, 0)` signals nothing and answers one question: is that pid there. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const DEADLINE_MS = 5_000

/**
 * `deadlineMs` is a parameter because one wait here is not like the others:
 * everything else is a signal or a byte on a pipe, while booting a whole Node
 * process is seconds of work on a loaded machine. Sizing every wait to the
 * slowest would hide a hang; sizing that one to the fastest is a flake.
 */
async function until(
  what: string,
  done: () => boolean,
  deadlineMs: number = DEADLINE_MS,
): Promise<void> {
  const stop = Date.now() + deadlineMs
  while (!done()) {
    if (Date.now() > stop) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Collects the terminal's output for matching. Never logged (§11). */
function reader(handle: PtyHandle): { text: () => string; sawChildPid: () => number } {
  let text = ''
  handle.onData((data) => {
    text += data
  })
  return {
    text: () => text,
    sawChildPid: () => Number(/child:(\d+)/.exec(text)?.[1] ?? 0),
  }
}

const TASK: AgentTask = {
  nodeId: 'phase-1',
  cwd: tmpdir(),
  prompt: 'implement the widget model',
  model: 'sonnet',
}

// ---------------------------------------------------------------------------
// The adapters
// ---------------------------------------------------------------------------

describe.runIf(POSIX_SHELL_FIXTURES)('attachPty against a fake binary', () => {
  it('hands the session id to the CLI, moves bytes both ways, and resizes the tty', async () => {
    const cwd = makeTemp()
    const adapter = new ClaudeCodeAdapter({ bin: fakeCli() })
    const handle = await adapter.attachPty('sess-42', { cwd, cols: 80, rows: 24 })
    const out = reader(handle)

    // The handoff token, on the wire to the CLI as `--resume <id>`.
    expect(handle.sessionId).toBe('sess-42')
    await until('the CLI to report its argv', () => out.text().includes('args:--resume sess-42'))
    expect(alive(handle.pid)).toBe(true)

    // Bytes in, bytes out.
    handle.write('hello\n')
    await until('an echo', () => out.text().includes('echo:hello'))

    // A resize is observable as the tty's own window size, which is the only
    // way to tell it reached the terminal rather than a method on a handle.
    handle.resize(120, 40)
    handle.write('size\n')
    await until('the reported window size', () => out.text().includes('40 120'))

    const child = out.sawChildPid()
    expect(child > 0).toBe(true)

    await handle.detach()
    // `detach` resolves only after the reap, so neither of these is a race.
    expect(alive(handle.pid)).toBe(false)
    await until('the process group to go', () => !alive(child))
  })

  it('codex opens the same session interactively', async () => {
    const adapter = new CodexAdapter({ bin: fakeCli() })
    const handle = await adapter.attachPty('thread-9', { cwd: makeTemp() })
    const out = reader(handle)
    await until('the CLI to report its argv', () => out.text().includes('args:resume thread-9'))
    await handle.detach()
    expect(alive(handle.pid)).toBe(false)
  })

  it('reports the exit code when the terminal ends on its own', async () => {
    const adapter = new ClaudeCodeAdapter({ bin: fakeCli() })
    const handle = await adapter.attachPty('sess-1', { cwd: makeTemp() })
    handle.write('quit\n')
    expect(await handle.exited).toBe(7)
    // Detaching an already-dead terminal is not an error, and still leaves
    // nothing behind.
    await handle.detach()
    expect(alive(handle.pid)).toBe(false)
  })

  it('refuses where the harness declared no pty', async () => {
    const adapter = new OpencodeAdapter()
    expect(adapter.capabilities.pty).toBe(false)
    await expect(adapter.attachPty('sess-1')).rejects.toBeInstanceOf(HarnessCapabilityError)
  })
})

// ---------------------------------------------------------------------------
// The round trip
// ---------------------------------------------------------------------------

describe('interrupt → attach → detach → resume', () => {
  it('carries the same session id through all four steps', async () => {
    const adapter = new MockAdapter()
    const outcome = await adapter.spawn(TASK)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const sessionId = outcome.session.id

    let interrupted = false
    let resumedWith: string | null = null
    const target: TakeoverTarget = {
      adapter,
      sessionId,
      cwd: makeTemp(),
      interrupt: async () => {
        interrupted = true
        await outcome.session.interrupt()
      },
      resume: async (id) => {
        resumedWith = id
        await adapter.spawn({ ...TASK, resumeSessionId: id })
      },
    }

    const handle = await takeOver(target, 100, 30)
    // The headless turn is stopped *before* the terminal opens: §7's trap is
    // one session serving a parser and a human at once.
    expect(interrupted).toBe(true)
    expect(handle.sessionId).toBe(sessionId)

    await handle.detach()
    await until('the resume', () => resumedWith !== null)
    expect(resumedWith).toBe(sessionId)
    // And the resume is a *resume*, not a new session: the id reached the task.
    expect(adapter.spawned[1]?.resumeSessionId).toBe(sessionId)
    expect(alive(handle.pid)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The daemon channel
// ---------------------------------------------------------------------------

const RUN_ID = 'run-pty'

const WORKFLOW: Workflow = WorkflowSchema.parse({
  schema_version: 1,
  id: 'wf-pty',
  base_branch: 'main',
  defaults: { harness: 'claude-code', model: 'opus', pipeline: 'solo' },
  resources: { lane: { capacity: 1, kind: 'worktree' } },
  pipelines: {
    solo: {
      states: [
        { id: 'work', name: 'Work', position: { x: 0, y: 0 } },
        { id: 'done', name: 'Done', position: { x: 200, y: 0 }, data: { outcome: 'done' } },
      ],
      transitions: [{ id: 't', from: 'work', to: 'done' }],
      initialStateIds: ['work'],
      finalStateIds: ['done'],
    },
  },
  nodes: [{ id: 'a', name: 'A', prompt_ref: 'plan.md#a' }],
})

interface Rig {
  readonly daemon: Daemon
  readonly journal: ReturnType<typeof openJournal>
  /** How many times a takeover was actually opened. The count an auth test asserts on. */
  readonly attaches: () => number
  readonly handles: PtyHandle[]
}

async function rig(options: { readonly offer?: boolean } = {}): Promise<Rig> {
  const dir = makeTemp()
  const journal = openJournal(dir)
  journal.createRun(RUN_ID, WORKFLOW)

  const bin = fakeCli()
  const real = new ClaudeCodeAdapter({ bin })
  const handles: PtyHandle[] = []
  let attaches = 0
  const adapter = {
    id: real.id,
    capabilities: real.capabilities,
    attachPty: async (sessionId: string, attach: { cwd: string; cols?: number; rows?: number }) => {
      attaches += 1
      const handle = await real.attachPty(sessionId, attach)
      handles.push(handle)
      return handle
    },
  }

  const daemon = await startDaemon({ journal, pollMs: 5 })
  daemon.register({
    runId: RUN_ID,
    control: {
      statuses: { a: 'running' },
      answer: () => {},
      addContext: () => {},
      redirect: () => {},
      pause: () => {},
      abortNode: () => {},
    },
    pools: { capacity: () => 1, held: () => 0, waiting: 0 },
    admission: { ceiling: () => 1, inFlight: () => 0, wakeAt: () => undefined },
  })

  if (options.offer !== false) {
    cleanups.push(
      takeovers.offer(RUN_ID, 'a', {
        adapter,
        sessionId: 'sess-live',
        cwd: makeTemp(),
        interrupt: async () => {},
        resume: async () => {},
      }),
    )
  }

  cleanups.push(async () => {
    for (const handle of handles) await handle.detach()
    // A test may already have closed it; closing twice is not a failure of
    // anything this file is about.
    await daemon.close().catch(() => {})
    journal.close()
  })

  return { daemon, journal, attaches: () => attaches, handles }
}

/** One client socket, with every frame it received, split by channel. */
function connect(
  daemon: Daemon,
  token: string | null,
  runId: string = RUN_ID,
): {
  readonly socket: WebSocket
  readonly opened: Promise<void>
  /** The HTTP status the upgrade was refused with, when it was refused. */
  readonly refused: Promise<number | null>
  text: () => string
  frames: () => unknown[]
} {
  const url = new URL('/ws', daemon.url.replace('http', 'ws'))
  url.searchParams.set('run', runId)
  url.searchParams.set('since', '0')
  if (token !== null) url.searchParams.set('token', token)

  const socket = new WebSocket(url)
  const frames: unknown[] = []
  let text = ''
  let refuse: (status: number | null) => void = () => {}
  const refused = new Promise<number | null>((resolve) => {
    refuse = resolve
  })

  socket.on('message', (raw) => {
    const frame: unknown = JSON.parse(String(raw))
    frames.push(frame)
    const pty = PtyServerFrameSchema.safeParse(frame)
    if (pty.success && pty.data.type === 'data') text += pty.data.data
  })
  // `ws` hands the refusal to this listener instead of erroring, and expects
  // the listener to abort the request — which is what makes the raw 401
  // observable rather than a generic socket error.
  socket.on('unexpected-response', (request, response) => {
    request.destroy()
    refuse(response.statusCode ?? null)
  })
  socket.on('error', () => {})
  socket.on('close', () => refuse(null))
  cleanups.push(() => {
    if (socket.readyState === WebSocket.OPEN) socket.close()
  })

  return {
    socket,
    opened: new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve())
      socket.on('close', () => reject(new Error('socket closed before it opened')))
      socket.on('error', (error) => reject(error))
    }),
    refused,
    text: () => text,
    frames: () => frames,
  }
}

const send = (socket: WebSocket, frame: unknown): void => {
  // Validated on the way out, so a test cannot pass by sending something the
  // daemon's own schema would have rejected.
  socket.send(JSON.stringify(PtyClientFrameSchema.parse(frame)))
}

describe.runIf(POSIX_SHELL_FIXTURES)('the PTY channel on the daemon socket', () => {
  it('carries terminal bytes both ways, and resizes', async () => {
    const r = await rig()
    const client = connect(r.daemon, r.daemon.token)
    await client.opened

    send(client.socket, { channel: 'pty', type: 'attach', nodeId: 'a', cols: 80, rows: 24 })
    await until('the attach', () =>
      client
        .frames()
        .some(
          (frame) =>
            PtyServerFrameSchema.safeParse(frame).data?.type === 'attached' &&
            (frame as { sessionId: string }).sessionId === 'sess-live',
        ),
    )
    await until('the CLI argv', () => client.text().includes('args:--resume sess-live'))

    send(client.socket, { channel: 'pty', type: 'input', data: 'hello\n' })
    await until('an echo', () => client.text().includes('echo:hello'))

    send(client.socket, { channel: 'pty', type: 'resize', cols: 120, rows: 40 })
    send(client.socket, { channel: 'pty', type: 'input', data: 'size\n' })
    await until('the reported window size', () => client.text().includes('40 120'))

    const pid = r.handles[0]?.pid ?? 0
    expect(pid > 0).toBe(true)
    send(client.socket, { channel: 'pty', type: 'detach' })
    await until('the terminal to go', () => !alive(pid))
  })

  it('keeps the event channel working on the same socket', async () => {
    const r = await rig()
    const client = connect(r.daemon, r.daemon.token)
    await client.opened

    send(client.socket, { channel: 'pty', type: 'attach', nodeId: 'a', cols: 80, rows: 24 })
    await until('the terminal', () => client.text().includes('args:--resume sess-live'))

    r.journal.append({ runId: RUN_ID, nodeId: 'a', type: 'node_status', payload: { status: 'running' } })

    const events = (): { type: string }[] =>
      client.frames().flatMap((frame) => EventFrameSchema.safeParse(frame).data?.events ?? [])
    await until('an event frame carrying the appended event', () =>
      events().some((event) => event.type === 'node_status'),
    )
    // And the terminal is still the terminal: two channels, one socket, no
    // interference either way.
    send(client.socket, { channel: 'pty', type: 'input', data: 'still here\n' })
    await until('an echo after the event frame', () =>
      client.text().includes('echo:still here'),
    )
  })

  it('refuses a node nobody offered, without spawning anything', async () => {
    const r = await rig({ offer: false })
    const client = connect(r.daemon, r.daemon.token)
    await client.opened

    send(client.socket, { channel: 'pty', type: 'attach', nodeId: 'a', cols: 80, rows: 24 })
    await until('the refusal', () =>
      client.frames().some((frame) => {
        const parsed = PtyServerFrameSchema.safeParse(frame)
        return parsed.success && parsed.data.type === 'error' && parsed.data.reason === 'unknown_node'
      }),
    )
    expect(r.attaches()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The producer: a scheduler running a node is what makes the button work.
//
// Everything above offers its own target by hand. This one does not: it runs a
// real `Scheduler` against the process-wide registry the daemon's `EventStream`
// already defaults to, which is the whole production wiring of §9's take over —
// and the assertion is that an authenticated `attach` for a node the scheduler
// is running opens a terminal rather than answering `unknown_node`.
// ---------------------------------------------------------------------------

const LIVE_RUN_ID = 'run-live'
const HARNESS_ID = 'claude-code'

/** One agent turn per node, and `b` behind `a` so one node is never in flight. */
const LIVE_WORKFLOW: Workflow = WorkflowSchema.parse({
  schema_version: 1,
  id: 'wf-live',
  base_branch: 'main',
  defaults: { harness: HARNESS_ID, model: 'opus', pipeline: 'solo' },
  resources: { lane: { capacity: 1, kind: 'worktree' } },
  pipelines: {
    solo: {
      states: [
        {
          id: 'work',
          name: 'Work',
          position: { x: 0, y: 0 },
          onEnter: [{ id: 'e-work', definitionId: 'spawn_agent', params: { role: 'implementer' } }],
        },
        { id: 'done', name: 'Done', position: { x: 200, y: 0 }, data: { outcome: 'done' } },
      ],
      transitions: [{ id: 't', from: 'work', to: 'done' }],
      initialStateIds: ['work'],
      finalStateIds: ['done'],
    },
  },
  nodes: [
    { id: 'a', name: 'A', prompt_ref: 'plan.md#a' },
    { id: 'b', name: 'B', prompt_ref: 'plan.md#b', depends_on: [{ node: 'a', artifact: "a's" }] },
  ],
})

/**
 * A harness whose turn stays live until the test ends it. `MockAdapter`'s
 * script drains in microtasks, and a turn that is over is a turn with no
 * offer — so the stream here is `session_started`, then silence, which is the
 * shape an operator actually clicks the button on. `attachPty` is the mock's
 * own: a real pty running `cat`, so the terminal is a process with a pid.
 */
function liveHarness(): {
  readonly adapter: HarnessAdapter
  readonly handles: PtyHandle[]
  live(): boolean
  end(): void
} {
  const mock = new MockAdapter({ id: HARNESS_ID })
  const handles: PtyHandle[] = []
  let parked = 0
  let open!: () => void
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })

  const adapter: HarnessAdapter = {
    id: mock.id,
    capabilities: mock.capabilities,
    preflight: () => mock.preflight(),
    async spawn(task) {
      const outcome = await mock.spawn(task)
      if (!outcome.ok) return outcome
      const inner = outcome.session
      const session: AgentSession = {
        id: inner.id,
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: 'session_started', sessionId: inner.id }
            parked += 1
            await gate
            parked -= 1
            yield { type: 'session_ended', result: 'ok' }
          },
        },
        send: (text) => inner.send(text),
        interrupt: () => inner.interrupt(),
        kill: () => inner.kill(),
      }
      return { ok: true, session }
    },
    attachPty: async (sessionId, attach) => {
      const handle = await mock.attachPty(sessionId, attach)
      handles.push(handle)
      return handle
    },
  }
  return { adapter, handles, live: () => parked > 0, end: () => open() }
}

interface LiveRig {
  readonly daemon: Daemon
  readonly journal: ReturnType<typeof openJournal>
  readonly harness: ReturnType<typeof liveHarness>
  readonly finished: Promise<{ statuses: Readonly<Record<string, string>> }>
  /** The id the live session announced — what an `attached` frame must carry. */
  sessionId(): string | null
  end(): void
}

async function liveRig(): Promise<LiveRig> {
  const dir = makeTemp()
  const journal = openJournal(dir)
  journal.createRun(LIVE_RUN_ID, LIVE_WORKFLOW)

  const laneRoot = join(dir, 'lanes')
  // The lane worktree the terminal opens in has to exist: `cwd` is the lane's,
  // and a pty is a real process in a real directory.
  mkdirSync(join(laneRoot, `${LIVE_RUN_ID}-lane-1`), { recursive: true })

  const harness = liveHarness()
  const pools = new ResourcePools(LIVE_WORKFLOW.resources)
  const admission = new AdmissionControl({
    journal,
    runId: LIVE_RUN_ID,
    ceilings: { [HARNESS_ID]: 2 },
  })
  // No `takeovers` here on purpose: both the scheduler and `EventStream`
  // default to the process-wide registry, and this test is about that default
  // being the one wire the button needed.
  const scheduler = createScheduler({
    workflow: LIVE_WORKFLOW,
    runId: LIVE_RUN_ID,
    journal,
    pools,
    admission,
    adapters: { [HARNESS_ID]: harness.adapter },
    executor: { execute: async () => ({}) },
    laneRoot,
  })

  const daemon = await startDaemon({ journal, pollMs: 5 })
  daemon.register({
    runId: LIVE_RUN_ID,
    control: runControl(scheduler),
    pools,
    admission,
  })

  const finished = scheduler.run()
  cleanups.push(async () => {
    harness.end()
    await finished.catch(() => undefined)
    for (const handle of harness.handles) await handle.detach()
    await daemon.close().catch(() => {})
    admission.close()
    journal.close()
  })

  return {
    daemon,
    journal,
    harness,
    finished,
    sessionId: () =>
      journal.nodes(LIVE_RUN_ID).find((row) => row.node_id === 'a')?.session_id ?? null,
    end: () => harness.end(),
  }
}

describe.runIf(POSIX_SHELL_FIXTURES)('a node the scheduler is running', () => {
  it('is attachable over the daemon socket, and detaching leaves no process behind', async () => {
    const r = await liveRig()
    await until('node a to open a session', () => r.harness.live())
    const sessionId = r.sessionId()
    expect(sessionId).toBeTruthy()

    const client = connect(r.daemon, r.daemon.token, LIVE_RUN_ID)
    await client.opened
    send(client.socket, { channel: 'pty', type: 'attach', nodeId: 'a', cols: 80, rows: 24 })

    // The assertion the button was missing: `attached`, carrying the id the
    // headless turn is running under — not `unknown_node`.
    await until('the attach', () =>
      client.frames().some((frame) => {
        const parsed = PtyServerFrameSchema.safeParse(frame)
        return parsed.success && parsed.data.type === 'attached'
      }),
    )
    const attached = client
      .frames()
      .map((frame) => PtyServerFrameSchema.safeParse(frame).data)
      .find((frame) => frame?.type === 'attached')
    expect(attached).toMatchObject({ nodeId: 'a', sessionId })
    expect(
      client.frames().some((frame) => PtyServerFrameSchema.safeParse(frame).data?.type === 'error'),
    ).toBe(false)

    // A real terminal in the node's lane: bytes go both ways through `cat`.
    const pid = r.harness.handles[0]?.pid ?? 0
    expect(pid > 0).toBe(true)
    send(client.socket, { channel: 'pty', type: 'input', data: 'ping\n' })
    await until('an echo from the terminal', () => client.text().includes('ping'))

    send(client.socket, { channel: 'pty', type: 'detach' })
    await until('the terminal to go', () => !alive(pid))

    // And the run finishes with nothing left pointing at it.
    r.end()
    const report = await r.finished
    expect(report.statuses).toEqual({ a: 'done', b: 'done' })
    expect(takeovers.find(LIVE_RUN_ID, 'a')).toBeUndefined()
    expect(takeovers.find(LIVE_RUN_ID, 'b')).toBeUndefined()
  })

  it('still refuses a node that is not running', async () => {
    const r = await liveRig()
    await until('node a to open a session', () => r.harness.live())

    // `b` is behind `a` and has never started. Nothing offered it, so nothing
    // is reachable — the registry's default, unchanged by a run being live.
    const client = connect(r.daemon, r.daemon.token, LIVE_RUN_ID)
    await client.opened
    send(client.socket, { channel: 'pty', type: 'attach', nodeId: 'b', cols: 80, rows: 24 })
    await until('the refusal', () =>
      client.frames().some((frame) => {
        const parsed = PtyServerFrameSchema.safeParse(frame)
        return parsed.success && parsed.data.type === 'error' && parsed.data.reason === 'unknown_node'
      }),
    )
    expect(r.harness.handles.length).toBe(0)
  })
})

describe.runIf(POSIX_SHELL_FIXTURES)('the authorization boundary', () => {
  it('rejects an unauthenticated upgrade before any terminal exists', async () => {
    const r = await rig()
    for (const token of [null, 'not-the-token']) {
      const client = connect(r.daemon, token)
      // A bare 401 on the raw socket: the protocol switch never happened, so
      // there was never a WebSocket for `EventStream.attach` to be called with
      // — and `attach` is the only thing that builds a `PtyChannel`.
      expect(await client.refused).toBe(401)
      // The claim that matters is not "the socket closed". It is that no
      // process was created: a peer that got a shell and then lost the socket
      // has already won.
      expect(r.attaches()).toBe(0)
      expect(r.handles.length).toBe(0)
    }

    // The same request with the token does open one, so the assertion above is
    // about the token and not about a channel that never works.
    const good = connect(r.daemon, r.daemon.token)
    await good.opened
    send(good.socket, { channel: 'pty', type: 'attach', nodeId: 'a', cols: 80, rows: 24 })
    await until('the attach', () => r.attaches() === 1)
  })

  it('tears the terminal down when the socket drops', async () => {
    const r = await rig()
    const client = connect(r.daemon, r.daemon.token)
    await client.opened
    send(client.socket, { channel: 'pty', type: 'attach', nodeId: 'a', cols: 80, rows: 24 })
    await until('the attach', () => r.handles.length === 1)
    const pid = r.handles[0]?.pid ?? 0

    client.socket.terminate()
    await until('the terminal to go', () => !alive(pid))
  })

  it('leaves no orphan when the daemon shuts down mid-attach', async () => {
    const r = await rig()
    const client = connect(r.daemon, r.daemon.token)
    await client.opened
    send(client.socket, { channel: 'pty', type: 'attach', nodeId: 'a', cols: 80, rows: 24 })
    await until('the attach', () => r.handles.length === 1)
    const pid = r.handles[0]?.pid ?? 0

    await r.daemon.close()
    await until('the terminal to go', () => !alive(pid))
  })
})

// ---------------------------------------------------------------------------
// The hard case: the daemon is killed rather than closed.
// ---------------------------------------------------------------------------

describe.runIf(POSIX_SHELL_FIXTURES)('a daemon killed mid-attach', () => {
  it('leaves no orphan pty', async () => {
    const dir = makeTemp()
    const script = join(dir, 'attach.ts')
    const ptyModule = join(import.meta.dirname, '..', 'src', 'harness', 'pty.ts')
    // The marker is *not* the terminal's bytes: the child reports a fixed word
    // and a pid, never what the program said (§11). It reports them only once
    // the program has actually spoken, because "mid-attach" means a terminal
    // that is running — killing during node-pty's own spawn handshake is a
    // race with a helper process, not with an attached shell.
    writeFileSync(
      script,
      [
        `import { openPty } from ${JSON.stringify(ptyModule)}`,
        `const handle = openPty({ sessionId: 's', file: '/bin/sh',`,
        `  args: ['-c', 'echo up; sleep 300'],`,
        `  env: process.env, attach: { cwd: ${JSON.stringify(dir)} } })`,
        `let announced = false`,
        `handle.onData((data) => {`,
        `  if (announced || !data.includes('up')) return`,
        `  announced = true`,
        `  process.stdout.write('running ' + handle.pid + '\\n')`,
        `})`,
        `setInterval(() => {}, 1000)`,
      ].join('\n'),
    )

    const child = spawnChild(process.execPath, ['--experimental-strip-types', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    cleanups.push(() => {
      child.kill('SIGKILL')
    })

    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      out += chunk
    })
    await until('the child to report a running terminal', () => out.includes('\n'), 30_000)
    const pid = Number(/running (\d+)/.exec(out)?.[1] ?? 0)
    expect(alive(pid)).toBe(true)

    // SIGKILL, so no exit hook and no teardown code runs at all. What must
    // still hold is that the pty leader is gone: the master descriptor dies
    // with the process, and the kernel hangs up the session behind it.
    child.kill('SIGKILL')
    try {
      await until('the pty leader to go', () => !alive(pid), 15_000)
    } catch (error) {
      // Naming the survivor is the difference between "flaky" and a diagnosis.
      throw new Error(
        `${String(error)} :: ${execFileSync('ps', [
          '-o',
          'pid=,ppid=,stat=,command=',
          '-p',
          String(pid),
        ]).toString()}`,
      )
    }
  }, 60_000)
})

// ---------------------------------------------------------------------------
// The declaration itself.
// ---------------------------------------------------------------------------

describe('declared pty capabilities', () => {
  it('matches §7 for every shipped adapter', () => {
    expect(new ClaudeCodeAdapter().capabilities.pty).toBe(true)
    expect(new CodexAdapter().capabilities.pty).toBe(true)
    expect(new OpencodeAdapter().capabilities.pty).toBe(false)
  })
})
