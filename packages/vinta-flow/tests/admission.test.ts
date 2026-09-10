import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AdmissionControl,
  type AdmissionOptions,
  type AdmissionOutcome,
  type CapacityWait,
  backoffMs,
} from '../src/admission/admission.ts'
import type { Clock } from '../src/admission/clock.ts'
import type { AgentTask } from '../src/harness/adapter.ts'
import { MockAdapter } from '../src/harness/mock.ts'
import { Journal, openJournal } from '../src/journal/journal.ts'
import type { NodeStatus } from '../src/journal/events.ts'
import { parseWorkflow } from '../src/validate.ts'
import type { Workflow } from '../src/types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUN = 'run-1'

const golden = (): Workflow => {
  const result = parseWorkflow(
    JSON.parse(readFileSync(join(HERE, 'fixtures', 'golden-workflow.json'), 'utf8')),
  )
  if (!result.ok) throw new Error('golden workflow fixture is invalid')
  return result.workflow
}

const task = (nodeId: string): AgentTask => ({
  nodeId,
  cwd: '/tmp/lane-1',
  prompt: 'implement the widget model',
  model: 'opus',
})

/**
 * Time under test. A capacity wait is minutes to hours long; sleeping through
 * one would trade a fast suite for a slow one and still not be deterministic.
 * Timers fire in deadline order so "the harness woke once, then everyone
 * resumed" is observable rather than a race.
 */
class ManualClock implements Clock {
  #now: number
  #timers: { at: number; wake: () => void; live: boolean }[] = []

  constructor(start = 1_700_000_000_000) {
    this.#now = start
  }

  now(): number {
    return this.#now
  }

  at(at: number, wake: () => void): () => void {
    const timer = { at, wake, live: true }
    this.#timers.push(timer)
    return () => {
      timer.live = false
    }
  }

  /** Moves to `now + ms`, firing everything due, earliest deadline first. */
  advance(ms: number): void {
    const target = this.#now + ms
    for (;;) {
      const due = this.#timers
        .filter((t) => t.live && t.at <= target)
        .sort((a, b) => a.at - b.at)[0]
      if (!due) break
      due.live = false
      this.#now = Math.max(this.#now, due.at)
      due.wake()
    }
    this.#now = target
  }

  get pending(): number {
    return this.#timers.filter((t) => t.live).length
  }
}

/** Yields to the microtask queue so pending admissions settle before we assert. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 16; i += 1) await Promise.resolve()
}

describe('admission control', () => {
  let projectDir: string
  let journal: Journal
  let clock: ManualClock
  let open: AdmissionControl[]

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'vinta-flow-admission-'))
    journal = openJournal(projectDir)
    journal.createRun(RUN, golden())
    clock = new ManualClock()
    open = []
  })

  afterEach(() => {
    for (const control of open) control.close()
    journal.close()
    rmSync(projectDir, { recursive: true, force: true })
  })

  const control = (options: Partial<AdmissionOptions> = {}): AdmissionControl => {
    const made = new AdmissionControl({
      journal,
      runId: RUN,
      ceilings: { mock: 4 },
      clock,
      // A fixed jitter draw keeps every test but the jitter test deterministic.
      random: () => 0.5,
      ...options,
    })
    open.push(made)
    return made
  }

  const statuses = (nodeId: string): NodeStatus[] =>
    journal
      .events(RUN)
      .filter((e) => 'nodeId' in e && e.nodeId === nodeId && e.type === 'node_status')
      .map((e) => (e.payload as { status: NodeStatus }).status)

  const admitted = (outcome: AdmissionOutcome): void => {
    if (outcome.status !== 'admitted') throw new Error(`expected admission, got ${outcome.status}`)
    outcome.release()
  }

  // §6.1: only `fatal` fails a node. Everything else is backpressure — the node
  // waits and then runs, and never reaches a failed status on the way.
  for (const kind of ['rate_limit', 'concurrency', 'quota', 'transient'] as const) {
    it(`waits and then succeeds after a ${kind} refusal`, async () => {
      const adapter = new MockAdapter({ spawns: [kind] })
      const admission = control()

      const refused = await admission.admit(adapter, task('p1'))
      expect(refused.status).toBe('retry')
      if (refused.status !== 'retry') return
      expect(refused.kind).toBe(kind)
      expect(refused.wakeAt).toBeGreaterThan(clock.now())

      // A caller releases its lane here, then waits. The wait is a promise the
      // harness's single timer resolves.
      let woke = false
      const waiting = refused.wait().then(() => {
        woke = true
      })
      await settle()
      expect(woke).toBe(false)

      clock.advance(refused.wakeAt - clock.now())
      await waiting
      expect(woke).toBe(true)

      admitted(await admission.admit(adapter, task('p1')))
      expect(adapter.spawned).toHaveLength(1)
      expect(statuses('p1')).toEqual(['waiting_on_capacity'])
      expect(statuses('p1')).not.toContain('failed')
    })
  }

  it('fails a fatal refusal immediately, with no wait', async () => {
    const adapter = new MockAdapter({ spawns: ['fatal'] })
    const admission = control()

    const outcome = await admission.admit(adapter, task('p1'))
    expect(outcome.status).toBe('failed')
    expect(admission.wakeAt('mock')).toBeUndefined()
    expect(clock.pending).toBe(0)
    // Nothing was journaled as waiting: a broken harness is not backpressure.
    expect(statuses('p1')).toEqual([])
    // And the slot it took is back.
    expect(admission.inFlight('mock')).toBe(0)
  })

  it('halves the ceiling on a concurrency refusal and recovers by one per clean run', async () => {
    const adapter = new MockAdapter()
    const admission = control({ increaseAfter: 2 })
    const seen: number[] = [admission.ceiling('mock')]

    const spawnOnce = async (): Promise<void> => {
      const outcome = await admission.admit(adapter, task('p1'))
      if (outcome.status === 'admitted') outcome.release()
      if (outcome.status === 'retry') clock.advance(outcome.wakeAt - clock.now() + 1)
      seen.push(admission.ceiling('mock'))
    }

    adapter.refuseNext('concurrency')
    await spawnOnce() // 4 -> 2
    await spawnOnce() // clean 1 of 2
    await spawnOnce() // clean 2 of 2 -> 3
    await spawnOnce()
    await spawnOnce() // -> 4
    await spawnOnce()
    await spawnOnce() // already at the configured ceiling

    expect(seen).toEqual([4, 2, 2, 3, 3, 4, 4, 4])
  })

  it('never drops below one and never rises above the configured ceiling', async () => {
    const adapter = new MockAdapter()
    const admission = control({ ceilings: { mock: 3 }, increaseAfter: 1 })
    const seen: number[] = []

    for (let i = 0; i < 4; i += 1) {
      adapter.refuseNext('rate_limit')
      const outcome = await admission.admit(adapter, task('p1'))
      if (outcome.status === 'retry') clock.advance(outcome.wakeAt - clock.now() + 1)
      seen.push(admission.ceiling('mock'))
    }
    expect(seen).toEqual([1, 1, 1, 1]) // 3 -> 1, then floored

    const climb: number[] = []
    for (let i = 0; i < 4; i += 1) {
      admitted(await admission.admit(adapter, task('p1')))
      climb.push(admission.ceiling('mock'))
    }
    expect(climb).toEqual([2, 3, 3, 3])
  })

  it('honors a reported reset time in preference to computed backoff', async () => {
    const retryAfter = new Date(clock.now() + 3_600_000)
    const adapter = new MockAdapter({ spawns: ['quota'], retryAfter })
    // A jitter draw of 1 makes the computed backoff its maximum, so a wake time
    // equal to `retryAfter` cannot be the backoff by coincidence.
    const admission = control({ random: () => 1, maxBackoffMs: 60_000 })

    const outcome = await admission.admit(adapter, task('p1'))
    expect(outcome.status).toBe('retry')
    if (outcome.status !== 'retry') return
    expect(outcome.wakeAt).toBe(retryAfter.getTime())
  })

  it('draws real jitter, bounded by the doubling cap', () => {
    const base = 1_000
    const max = 300_000
    const draws = Array.from({ length: 200 }, () => backoffMs(4, base, max, Math.random))
    const cap = base * 2 ** 3

    expect(new Set(draws).size).toBeGreaterThan(1)
    for (const draw of draws) {
      expect(draw).toBeGreaterThanOrEqual(0)
      expect(draw).toBeLessThanOrEqual(cap)
    }
    // The cap doubles per attempt and then stops at the configured maximum.
    expect(backoffMs(1, base, max, () => 1)).toBe(base)
    expect(backoffMs(2, base, max, () => 1)).toBe(2 * base)
    expect(backoffMs(20, base, max, () => 1)).toBe(max)
  })

  it('resumes a journaled wait across a restart without re-firing it', async () => {
    const retryAfter = new Date(clock.now() + 3_600_000)
    const adapter = new MockAdapter({ spawns: ['quota', 'quota'], retryAfter })
    const before: CapacityWait[] = []
    const first = control({ onWait: (w) => before.push(w) })

    // Two nodes in flight together are both refused, so both reach the park
    // path — one wait window, and §6.1's one notification, not two.
    const outcomes = await Promise.all([
      first.admit(adapter, task('p1')),
      first.admit(adapter, task('p2')),
    ])
    const outcome = outcomes[0]!
    expect(outcomes.map((o) => o.status)).toEqual(['retry', 'retry'])
    if (outcome.status !== 'retry') return
    expect(before).toHaveLength(1)
    expect(before[0]?.wakeAt).toBe(retryAfter.getTime())

    // Simulated restart: every timer, waiter and ceiling in memory is dropped.
    first.close()
    const after: CapacityWait[] = []
    const reopened = control({ onWait: (w) => after.push(w) })

    // The wait resumed at its original wake time, and the operator was not
    // notified a second time about a window they were already told about.
    expect(reopened.wakeAt('mock')).toBe(retryAfter.getTime())
    expect(after).toEqual([])

    // A node admitted during the restored window waits instead of spawning.
    const parked = await reopened.admit(adapter, task('p2'))
    expect(parked.status).toBe('retry')
    if (parked.status !== 'retry') return
    expect(parked.wakeAt).toBe(retryAfter.getTime())
    expect(adapter.spawned).toHaveLength(0)

    let woke = false
    const waiting = parked.wait().then(() => {
      woke = true
    })
    clock.advance(retryAfter.getTime() - clock.now())
    await waiting
    expect(woke).toBe(true)
    expect(reopened.wakeAt('mock')).toBeUndefined()

    // The window is over and the durable record with it: a third boot does not
    // resurrect the wait.
    const third = control()
    expect(third.wakeAt('mock')).toBeUndefined()
    admitted(await third.admit(adapter, task('p2')))
  })

  it('never runs more concurrent spawns than the current ceiling', async () => {
    const adapter = new MockAdapter()
    const admission = control({ ceilings: { mock: 2 } })

    const pending = ['p1', 'p2', 'p3', 'p4'].map((id) => admission.admit(adapter, task(id)))
    await settle()
    expect(adapter.spawned).toHaveLength(2)
    expect(admission.inFlight('mock')).toBe(2)

    // Releasing one admitted session lets exactly one queued node through.
    const first = await pending[0]!
    if (first.status !== 'admitted') throw new Error('expected admission')
    first.release()
    await settle()
    expect(adapter.spawned).toHaveLength(3)
    expect(admission.inFlight('mock')).toBe(2)

    const second = await pending[1]!
    if (second.status !== 'admitted') throw new Error('expected admission')
    second.release()
    await settle()
    expect(adapter.spawned).toHaveLength(4)
    for (const outcome of await Promise.all(pending)) {
      expect(outcome.status).toBe('admitted')
    }
  })

  it('keeps ceilings and waits independent per harness id', async () => {
    const busy = new MockAdapter({ id: 'busy', spawns: ['concurrency'] })
    const calm = new MockAdapter({ id: 'calm' })
    const admission = control({ ceilings: { busy: 4, calm: 4 } })

    const refused = await admission.admit(busy, task('p1'))
    expect(refused.status).toBe('retry')
    expect(admission.ceiling('busy')).toBe(2)

    // Pressure on one vendor must not throttle another: `calm` keeps its full
    // ceiling and is not parked behind `busy`'s timer.
    expect(admission.ceiling('calm')).toBe(4)
    expect(admission.wakeAt('calm')).toBeUndefined()
    admitted(await admission.admit(calm, task('p2')))
    expect(calm.spawned).toHaveLength(1)
  })

  it('rejects a harness with no configured ceiling', async () => {
    const admission = control()
    await expect(admission.admit(new MockAdapter({ id: 'unknown' }), task('p1'))).rejects.toThrow(
      /unknown harness/,
    )
  })
})
