import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openJournal, type Journal } from '../src/journal/journal.ts'
import { AgentLeaseBroker } from '../src/resources/agent-leases.ts'
import { ResourcePools } from '../src/resources/pools.ts'
import type { Resource } from '../src/types.ts'

const RUN_ID = 'run-1'

const dirs: string[] = []
const journals: Journal[] = []

afterEach(() => {
  for (const journal of journals.splice(0)) journal.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Yields to the microtask queue so pending grants and releases settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

function rig(options: { readonly parkedWaitTtlMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-agent-lease-'))
  dirs.push(dir)
  const journal = openJournal(dir)
  journals.push(journal)
  const resources: Record<string, Resource> = {
    'test-suite': { capacity: 1, kind: 'semaphore' },
  }
  const pools = new ResourcePools(resources, { agingMs: 0 })

  let now = 1_000
  let next = 0
  const timers = new Map<NodeJS.Timeout, { readonly at: number; readonly run: () => void }>()
  const tick = (ms: number): void => {
    now += ms
    for (const [timer, entry] of [...timers]) {
      if (entry.at <= now) {
        timers.delete(timer)
        entry.run()
      }
    }
  }
  const broker = new AgentLeaseBroker(pools, journal, RUN_ID, {
    ttlMs: 90,
    ...(options.parkedWaitTtlMs === undefined ? {} : { parkedWaitTtlMs: options.parkedWaitTtlMs }),
    now: () => now,
    id: () => `lease-${++next}`,
    setTimer: (run, delay) => {
      const timer = { id: next } as unknown as NodeJS.Timeout
      timers.set(timer, { at: now + delay, run })
      return timer
    },
    clearTimer: (timer) => {
      timers.delete(timer)
    },
  })
  return { broker, journal, pools, tick }
}

describe('agent-held resource leases', () => {
  it('uses the existing pool and journals the expiring holder', async () => {
    const { broker, journal, pools } = rig()
    const grant = await broker.acquire(['test-suite'], 'phase-a')

    expect(pools.held('test-suite')).toBe(1)
    expect(journal.leases()).toEqual([
      {
        resource: 'test-suite',
        holder_node: 'phase-a',
        lease_id: grant.leaseId,
        acquired_at: expect.any(Number),
        expires_at: grant.expiresAt,
      },
    ])

    broker.release(grant.leaseId)
    broker.release(grant.leaseId)
    expect(pools.held('test-suite')).toBe(0)
    expect(journal.leases()).toEqual([])
  })

  it('expires a client that stops renewing, so the next waiter can run', async () => {
    const { broker, pools, tick } = rig()
    await broker.acquire(['test-suite'], 'wedged')

    let granted = false
    const next = broker.acquire(['test-suite'], 'next').then((grant) => {
      granted = true
      return grant
    })
    await Promise.resolve()
    expect(granted).toBe(false)

    tick(90)
    const grant = await next
    expect(granted).toBe(true)
    expect(pools.held('test-suite')).toBe(1)
    broker.release(grant.leaseId)
  })

  /**
   * The starvation this exists to prevent, at broker level: the hopping client
   * asked first, and an in-process waiter that arrived during the hop must not
   * inherit its place. Aging is off in this rig, so arrival order is the only
   * thing deciding — which is exactly the property a dropped queue entry broke.
   */
  it('a rejoining hop keeps the place in line it took on its first ask', async () => {
    const { broker, pools, tick } = rig()
    const holder = await broker.acquire(['test-suite'], 'holder')

    const first = broker.hop(['test-suite'], 'agent', { withinMs: 50 })
    tick(50)
    const queued = await first
    expect(queued).toEqual({ waiting: true, waitToken: expect.any(String) })
    if ('leaseId' in queued) throw new Error('unreachable')
    // Answering "not yet" cost the client nothing: it is still in the queue.
    expect(pools.waiting).toBe(1)

    // An in-process waiter arrives *after* the agent did.
    let inProcess = false
    const later = pools.acquire(['test-suite']).then((lease) => {
      inProcess = true
      return lease
    })
    await settle()
    expect(pools.waiting).toBe(2)

    broker.release(holder.leaseId)
    await settle()
    expect(inProcess).toBe(false)

    const rejoined = await broker.hop(['test-suite'], 'agent', {
      waitToken: queued.waitToken,
      withinMs: 50,
    })
    if (!('leaseId' in rejoined)) throw new Error('the rejoining hop was not granted')
    // One wait, one slot: rejoining collects the grant its parked entry already
    // won rather than booking a second one.
    expect(pools.held('test-suite')).toBe(1)

    // A token is spent once. Hopping on it again is a new wait at the back, not
    // a second helping of the same one.
    const stale = broker.hop(['test-suite'], 'agent', {
      waitToken: queued.waitToken,
      withinMs: 50,
    })
    tick(50)
    expect(await stale).toEqual({ waiting: true, waitToken: expect.any(String) })
    expect(pools.held('test-suite')).toBe(1)

    broker.release(rejoined.leaseId)
    await settle()
    expect(inProcess).toBe(true)
    ;(await later).release()
  })

  /**
   * A client that retried without waiting for its answer has two hops on one
   * token, both watching the same grant. The queue handed over one slot, so
   * exactly one of them may come back with a lease.
   */
  it('grants once when two hops race on the same wait token', async () => {
    const { broker, pools, tick } = rig()
    const holder = await broker.acquire(['test-suite'], 'holder')

    const first = broker.hop(['test-suite'], 'agent', { withinMs: 50 })
    tick(50)
    const queued = await first
    if ('leaseId' in queued) throw new Error('unreachable')

    const both = [
      broker.hop(['test-suite'], 'agent', { waitToken: queued.waitToken, withinMs: 50 }),
      broker.hop(['test-suite'], 'agent', { waitToken: queued.waitToken, withinMs: 50 }),
    ]
    broker.release(holder.leaseId)
    await settle()
    tick(50)
    const outcomes = await Promise.all(both)

    const granted = outcomes.filter((outcome) => 'leaseId' in outcome)
    expect(granted).toHaveLength(1)
    expect(pools.held('test-suite')).toBe(1)
    // The loser is not refused, just still waiting — on a new place in the
    // queue, since the one it was holding a token for has been spent.
    const loser = outcomes.find((outcome) => !('leaseId' in outcome))
    expect(loser).toEqual({ waiting: true, waitToken: expect.any(String) })
    if (loser === undefined || 'leaseId' in loser) throw new Error('unreachable')
    expect(loser.waitToken).not.toBe(queued.waitToken)

    // Closing gives back both the granted lease and the still-parked wait.
    broker.close()
    await settle()
    expect(pools.held('test-suite')).toBe(0)
    expect(pools.waiting).toBe(0)
  })

  /**
   * The other half of parking: a place held for a client that never comes back
   * is capacity nobody can use, and a grant that lands on one is worse — a real
   * slot held by no process. Both have to time out.
   */
  it('reaps a parked wait whose client stopped hopping, and gives back a grant it won', async () => {
    const { broker, pools, tick } = rig({ parkedWaitTtlMs: 1_000 })
    const holder = await broker.acquire(['test-suite'], 'holder')

    const first = broker.hop(['test-suite'], 'agent', { withinMs: 50 })
    tick(50)
    await first
    expect(pools.waiting).toBe(1)

    // The client is gone, but the slot frees anyway and the parked wait — still
    // first in line — takes it.
    broker.release(holder.leaseId)
    await settle()
    expect(pools.held('test-suite')).toBe(1)
    expect(pools.waiting).toBe(0)

    tick(1_000)
    await settle()
    expect(pools.held('test-suite')).toBe(0)
  })

  it('reaps a parked wait that never reached the head of the queue', async () => {
    const { broker, pools, tick } = rig({ parkedWaitTtlMs: 1_000 })
    await broker.acquire(['test-suite'], 'holder')

    const first = broker.hop(['test-suite'], 'agent', { withinMs: 50 })
    tick(50)
    await first
    expect(pools.waiting).toBe(1)

    tick(1_000)
    await settle()
    expect(pools.waiting).toBe(0)
  })

  it('renewal replaces the deadline and a stale timer cannot release it', async () => {
    const { broker, pools, tick } = rig()
    const first = await broker.acquire(['test-suite'], 'phase-a')

    tick(60)
    const renewed = broker.renew(first.leaseId)
    expect(renewed?.expiresAt).toBe(1_150)
    tick(30)
    expect(pools.held('test-suite')).toBe(1)
    tick(60)
    expect(pools.held('test-suite')).toBe(0)
    expect(broker.renew(first.leaseId)).toBeNull()
  })
})

/**
 * The table write was never the whole job. `leases` is not projected from
 * anything, so a row in it reaches a watching client only when some event
 * happens along and makes the browser re-read the snapshot — which is why an
 * agent's queue could move for minutes while the resource panel showed the
 * holders it had last time something unrelated was journalled.
 */
describe('the events behind an agent-held lease', () => {
  const leaseEvents = (journal: Journal) =>
    journal.events(RUN_ID).filter((event) => event.type === 'agent_lease')

  it('journals both edges, keyed to the holder node and the lease', async () => {
    const { broker, journal } = rig()
    const grant = await broker.acquire(['test-suite'], 'phase-a')

    expect(leaseEvents(journal)).toMatchObject([
      {
        nodeId: 'phase-a',
        type: 'agent_lease',
        payload: { phase: 'acquired', lease_id: grant.leaseId, resources: ['test-suite'] },
      },
    ])

    broker.release(grant.leaseId)
    expect(leaseEvents(journal)).toMatchObject([
      { payload: { phase: 'acquired' } },
      {
        nodeId: 'phase-a',
        payload: { phase: 'released', lease_id: grant.leaseId, resources: ['test-suite'] },
      },
    ])
  })

  it('writes the release once however many times release is called', async () => {
    const { broker, journal } = rig()
    const grant = await broker.acquire(['test-suite'], 'phase-a')

    // A client's `finally` and the expiry timer race routinely; `release` is
    // idempotent and the record of it has to be too.
    broker.release(grant.leaseId)
    broker.release(grant.leaseId)

    expect(leaseEvents(journal).map((event) => event.payload)).toMatchObject([
      { phase: 'acquired' },
      { phase: 'released' },
    ])
  })

  it('says nothing on a renewal, which is a heartbeat and not a transition', async () => {
    const { broker, journal, tick } = rig()
    const grant = await broker.acquire(['test-suite'], 'phase-a')

    tick(60)
    expect(broker.renew(grant.leaseId)).not.toBeNull()
    tick(60)
    expect(broker.renew(grant.leaseId)).not.toBeNull()

    // Two renewals, no rows: the holder set has not changed since the grant
    // announced it, and a row per heartbeat for the length of every command an
    // agent runs would bury the edges that are real.
    expect(leaseEvents(journal).map((event) => event.payload)).toMatchObject([
      { phase: 'acquired' },
    ])
  })

  it('announces an expiry, so a lease nobody released still moves the panel', async () => {
    const { broker, journal, tick } = rig()
    await broker.acquire(['test-suite'], 'wedged')

    // The client is gone rather than finished. The release comes from the
    // timer, and is exactly as much of a capacity change as a clean one.
    tick(90)

    expect(leaseEvents(journal).map((event) => event.payload)).toMatchObject([
      { phase: 'acquired' },
      { phase: 'released', resources: ['test-suite'] },
    ])
  })

  /**
   * §11. The broker is never told what command the lease is for, so this is
   * asserted as the *whole* key set rather than as the absence of a string: a
   * field added later that carried one fails here rather than passing a
   * substring check nobody updated.
   */
  it('carries pool ids and a lease id, and no command or repository content', async () => {
    const { broker, journal } = rig()
    const grant = await broker.acquire(['test-suite'], 'phase-a')
    broker.release(grant.leaseId)

    expect(leaseEvents(journal).map((event) => Object.keys(event.payload).sort())).toEqual([
      ['lease_id', 'phase', 'resources'],
      ['lease_id', 'phase', 'resources'],
    ])
  })

  /**
   * History, not state. `leases` holds live processes and is cleared on open,
   * so folding these rows into it on a rebuild would resurrect capacity
   * nothing holds.
   */
  it('changes no projection, and survives a rebuild unaltered', async () => {
    const { broker, journal } = rig()
    const grant = await broker.acquire(['test-suite'], 'phase-a')
    broker.release(grant.leaseId)

    const before = journal.events(RUN_ID)
    journal.rebuildProjections()

    expect(journal.events(RUN_ID)).toEqual(before)
    expect(journal.leases()).toEqual([])
  })
})
