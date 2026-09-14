import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openJournal, type Journal } from '../src/journal/journal.ts'
import { AgentLeaseBroker } from '../src/resources/agent-leases.ts'
import { ResourcePools } from '../src/resources/pools.ts'
import type { Resource } from '../src/types.ts'

const dirs: string[] = []
const journals: Journal[] = []

afterEach(() => {
  for (const journal of journals.splice(0)) journal.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function rig() {
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
  const broker = new AgentLeaseBroker(pools, journal, {
    ttlMs: 90,
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
