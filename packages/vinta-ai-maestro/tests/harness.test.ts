import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import type { AgentEvent, AgentTask } from '../src/harness/adapter.ts'
import { runAdapterContract } from '../src/harness/contract.ts'
import {
  CACHED_SCRIPT,
  ERRORING_SCRIPT,
  MockAdapter,
  type MockAdapterOptions,
} from '../src/harness/mock.ts'

const TASK: AgentTask = {
  nodeId: 'phase-1',
  // A directory that exists, because the contract's takeover assertions open a
  // real pty in it — a pty cannot be chdir'd into a path that is not there.
  cwd: tmpdir(),
  prompt: 'implement the widget model',
  model: 'sonnet',
}

/** A token this mock has been told it no longer has (§15.4). */
const FORGOTTEN_SESSION = 'a-session-the-vendor-pruned'

const fixture = (options: MockAdapterOptions = {}) => {
  const adapter = new MockAdapter({ staleSessions: [FORGOTTEN_SESSION], ...options })
  return {
    adapter,
    task: TASK,
    // The mock is the only adapter that can produce a forgotten session
    // without a vendor, so it is the one that runs the contract's
    // `stale_session` assertions everywhere rather than only where three CLIs
    // are installed and logged in.
    staleResumeTask: { ...TASK, resumeSessionId: FORGOTTEN_SESSION },
    forceRefusal: adapter.refuseNext.bind(adapter),
  }
}

// Both branches of every capability-conditional assertion have to be exercised
// by something, and the mock is the only adapter that can be configured into
// either. Running the suite twice is what proves the contract itself is right,
// not just that one adapter passes it.
runAdapterContract('mock adapter', { describe, it, expect }, () => fixture())
runAdapterContract(
  'mock adapter without inject, interrupt or pty',
  { describe, it, expect },
  () => fixture({ capabilities: { inject: false, interrupt: false, pty: false } }),
)

const collect = async (adapter: MockAdapter): Promise<AgentEvent[]> => {
  const outcome = await adapter.spawn(TASK)
  if (!outcome.ok) throw new Error(`spawn refused: ${outcome.kind}`)
  const seen: AgentEvent[] = []
  for await (const event of outcome.session.events) seen.push(event)
  return seen
}

describe('mock adapter', () => {
  it('plays a scripted run through to its result', async () => {
    const events = await collect(new MockAdapter())
    expect(events.map((e) => e.type)).toEqual([
      'session_started',
      'assistant_text',
      'tool_use',
      'tool_result',
      'assistant_text',
      'usage',
      'session_ended',
    ])
    expect(events[events.length - 1]).toEqual({ type: 'session_ended', result: 'ok' })
  })

  it('plays a run that errors', async () => {
    const events = await collect(new MockAdapter({ script: ERRORING_SCRIPT }))
    expect(events.some((e) => e.type === 'error')).toBe(true)
    expect(events[events.length - 1]).toEqual({ type: 'session_ended', result: 'error' })
  })

  it('consumes its spawn plan in order, then succeeds', async () => {
    const adapter = new MockAdapter({
      spawns: ['rate_limit', 'concurrency', 'ok'],
      retryAfter: new Date(1_700_000_000_000),
    })
    const first = await adapter.spawn(TASK)
    const second = await adapter.spawn(TASK)
    const third = await adapter.spawn(TASK)
    const fourth = await adapter.spawn(TASK)

    expect(first.ok === false && first.kind).toBe('rate_limit')
    expect(first.ok === false ? first.retryAfter?.getTime() : undefined).toBe(1_700_000_000_000)
    expect(second.ok === false && second.kind).toBe('concurrency')
    expect(third.ok).toBe(true)
    expect(fourth.ok).toBe(true)
    // Refused spawns are not work: admission control must not see them as such.
    expect(adapter.spawned.length).toBe(2)
  })

  it('resumes under the session id it was given', async () => {
    const adapter = new MockAdapter()
    const outcome = await adapter.spawn({ ...TASK, resumeSessionId: 'prior-session' })
    expect(outcome.ok && outcome.session.id).toBe('prior-session')
  })

  it('refuses a forgotten session as stale, and resumes every other id', async () => {
    // The two halves of §15.4 on one adapter: the token it was told to forget
    // is refused, and the next spawn — the fresh retry the host answers with —
    // goes through. A refusal is not work, so it leaves `spawned` alone.
    const adapter = new MockAdapter({ staleSessions: ['gone'] })
    const refused = await adapter.spawn({ ...TASK, resumeSessionId: 'gone' })
    expect(refused.ok === false && refused.kind).toBe('stale_session')
    expect(refused.ok === false && refused.message.includes('phase-1')).toBe(true)

    const retried = await adapter.spawn(TASK)
    expect(retried.ok).toBe(true)
    expect(adapter.spawned.length).toBe(1)
  })

  it('does not call a spawn stale when it carried no session id at all', async () => {
    // There was nothing to be forgotten, so the id being on the forget-list is
    // beside the point — the spawn is ordinary.
    const adapter = new MockAdapter({ staleSessions: [TASK.nodeId, 'gone'] })
    expect((await adapter.spawn(TASK)).ok).toBe(true)
  })

  it('plays back the cache counters a continued turn reports', async () => {
    // §15.6's fixture: a resumed turn whose prefix came off the vendor's cache
    // instead of being rebuilt. `DEFAULT_SCRIPT` reports neither counter, which
    // is what a harness that does not report them looks like, and accounting
    // has to keep the two apart.
    const cached = await collect(new MockAdapter({ script: CACHED_SCRIPT }))
    expect(cached.find((e) => e.type === 'usage')).toEqual({
      type: 'usage',
      input: 300,
      output: 120,
      cacheRead: 11_400,
      cacheWrite: 900,
    })
    const cold = (await collect(new MockAdapter())).find((e) => e.type === 'usage')
    expect(cold).not.toHaveProperty('cacheRead')
    expect(cold).not.toHaveProperty('cacheWrite')
  })

  it('renders an injected message in the transcript where it was sent', async () => {
    const adapter = new MockAdapter()
    const outcome = await adapter.spawn(TASK)
    if (!outcome.ok) throw new Error('spawn refused')
    const iterator = outcome.session.events[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.next()
    await outcome.session.send('use the existing helper')

    const next = await iterator.next()
    expect(next.value).toEqual({ type: 'user_message', text: 'use the existing helper' })
  })

  it('truncates the script when interrupted mid-stream', async () => {
    const adapter = new MockAdapter()
    const outcome = await adapter.spawn(TASK)
    if (!outcome.ok) throw new Error('spawn refused')
    const iterator = outcome.session.events[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.next()
    await outcome.session.interrupt()

    const rest: AgentEvent[] = []
    for (;;) {
      const step = await iterator.next()
      if (step.done === true) break
      rest.push(step.value)
    }
    expect(rest).toEqual([{ type: 'session_ended', result: 'interrupted' }])
  })
})
