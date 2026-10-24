/**
 * Pools shared by every run on the machine (`scope: host`). Two runs on one
 * laptop each had a `test-suite` of capacity 1 and ran two full suites at
 * once: a ten-minute suite took 28 to 42 minutes and kept hitting its timeout.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { HostSlots } from '../src/resources/host-slots.ts'
import { ResourcePools } from '../src/resources/pools.ts'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-host-slots-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const resources = { 'test-suite': { capacity: 1, kind: 'semaphore', scope: 'host' } } as const

/** Two runs in one process: what matters is that they share nothing but the lock directory. */
const run = (id: string, pid: number, alive: (pid: number) => boolean = () => true) =>
  new ResourcePools(resources, { agingMs: 0, hostSlots: new HostSlots({ root, run: id, pid, alive }) })

describe('host-scoped pools', () => {
  it('makes a second run wait for the first run’s slot, and grants it on release', async () => {
    const first = run('run-a', 1001)
    const second = run('run-b', 1002)
    const lease = await first.acquire(['test-suite'])

    let granted = false
    const waiting = second.acquire(['test-suite']).then((held) => {
      granted = true
      return held
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(granted).toBe(false)
    expect(second.hostHolders('test-suite')).toEqual([{ pid: 1001, run: 'run-a' }])

    lease.release()
    const held = await waiting
    expect(granted).toBe(true)
    held.release()
  }, 10_000)

  it('takes over a slot whose run has died', async () => {
    const dead = run('run-dead', 4242)
    await dead.acquire(['test-suite'])
    const alive = run('run-b', 1002, (pid) => pid !== 4242)
    const lease = await alive.acquire(['test-suite'])
    expect(alive.hostHolders('test-suite')).toEqual([{ pid: 1002, run: 'run-b' }])
    lease.release()
  })

  it('leaves a slot another run is half-way through writing', () => {
    mkdirSync(join(root, 'test-suite'), { recursive: true })
    writeFileSync(join(root, 'test-suite', 'slot-0.lock'), '')
    const slots = new HostSlots({ root, run: 'run-b', pid: 1002, alive: () => false })
    expect(slots.tryTake('test-suite', 1)).toBeNull()
    // Long enough ago, it was a run that died between open and write.
    const old = new Date(Date.now() - 60_000)
    utimesSync(join(root, 'test-suite', 'slot-0.lock'), old, old)
    expect(slots.tryTake('test-suite', 1)).not.toBeNull()
  })

  it('counts this run only for a pool that is not host-scoped', async () => {
    const own = { 'test-suite': { capacity: 1, kind: 'semaphore' } } as const
    const a = new ResourcePools(own, { agingMs: 0, hostSlots: new HostSlots({ root, run: 'a', pid: 1 }) })
    const b = new ResourcePools(own, { agingMs: 0, hostSlots: new HostSlots({ root, run: 'b', pid: 2 }) })
    const both = await Promise.all([a.acquire(['test-suite']), b.acquire(['test-suite'])])
    expect(both).toHaveLength(2)
    for (const lease of both) lease.release()
  })
})
