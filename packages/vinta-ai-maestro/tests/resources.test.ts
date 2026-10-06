import { describe, expect, it } from 'vitest'
import { ResourcePools, type ResourcePoolsOptions } from '../src/resources/pools.ts'
import type { Resource } from '../src/types.ts'

const semaphore = (capacity: number): Resource => ({ capacity, kind: 'semaphore' })

const pools = (
  capacities: Record<string, number>,
  options: ResourcePoolsOptions = {},
): ResourcePools =>
  new ResourcePools(
    Object.fromEntries(Object.entries(capacities).map(([id, n]) => [id, semaphore(n)])),
    options,
  )

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Yields to the microtask queue so pending grants settle before we assert. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

/**
 * Fails loudly instead of relying on the suite timeout. Deadlock-freedom is
 * the claim under test, so "it eventually finished" has to be an assertion.
 */
async function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Deterministic PRNG so a failing property-test iteration is reproducible. */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

describe('resource pools', () => {
  it('never exceeds capacity under randomized concurrent arrivals', async () => {
    const ITERATIONS = 250
    const names = ['alpha', 'beta', 'gamma', 'lane']

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const random = rng(iteration + 1)
      const capacities = Object.fromEntries(
        names.map((name) => [name, 1 + Math.floor(random() * 3)]),
      )
      // Aging spans both regimes: 0 is strict FIFO, a large value is pure
      // bypass. The invariant must hold in either.
      const pool = pools(capacities, { agingMs: random() < 0.5 ? 0 : 10_000 })
      const violations: string[] = []

      const holders = Array.from({ length: 16 }, async () => {
        const needs = names.filter(() => random() < 0.5)
        const arrival = Math.floor(random() * 5)
        const hold = Math.floor(random() * 7)

        for (let i = 0; i < arrival; i += 1) await Promise.resolve()
        const lease = await pool.acquire(needs)
        try {
          for (const name of needs) {
            if (pool.held(name) > pool.capacity(name)) violations.push(name)
          }
          for (let i = 0; i < hold; i += 1) await Promise.resolve()
        } finally {
          lease.release()
        }
      })

      await within(5_000, Promise.all(holders))
      expect(violations, `iteration ${iteration}`).toEqual([])
      for (const name of names) expect(pool.held(name)).toBe(0)
      expect(pool.waiting).toBe(0)
    }
  })

  it('grants blocked holders in arrival order', async () => {
    const pool = pools({ slot: 1 }, { agingMs: 0 })
    const order: string[] = []

    const first = await pool.acquire(['slot'])
    const rest = ['b', 'c', 'd'].map(async (id) => {
      const lease = await pool.acquire(['slot'])
      order.push(id)
      lease.release()
    })
    await settle()
    expect(order).toEqual([])

    first.release()
    await within(1_000, Promise.all(rest))
    expect(order).toEqual(['b', 'c', 'd'])
  })

  it('lets young holders be bypassed so free capacity is not idled', async () => {
    // `lane` is busy, so the two-pool holder cannot run. `test-suite` is free
    // and someone can use it — strict FIFO would waste it.
    const pool = pools({ lane: 1, 'test-suite': 1 }, { agingMs: 10_000 })
    const laneHolder = await pool.acquire(['lane'])

    let bypassed = false
    const long = pool.acquire(['lane', 'test-suite'])
    const short = pool.acquire(['test-suite']).then((lease) => {
      bypassed = true
      lease.release()
    })

    await within(1_000, short)
    expect(bypassed).toBe(true)
    expect(pool.waiting).toBe(1)

    laneHolder.release()
    ;(await within(1_000, long)).release()
  })

  it('stops bypassing once the blocked holder has aged', async () => {
    const pool = pools({ lane: 1, 'test-suite': 1 }, { agingMs: 0 })
    const laneHolder = await pool.acquire(['lane'])

    const granted: string[] = []
    const long = pool.acquire(['lane', 'test-suite']).then((lease) => {
      granted.push('long')
      return lease
    })
    const short = pool.acquire(['test-suite']).then((lease) => {
      granted.push('short')
      lease.release()
    })

    // The aged holder reserved `test-suite`, so the newcomer cannot take it
    // even though the slot is free.
    await settle()
    expect(granted).toEqual([])
    expect(pool.held('test-suite')).toBe(0)

    laneHolder.release()
    ;(await within(1_000, long)).release()
    await within(1_000, short)
    expect(granted).toEqual(['long', 'short'])
  })

  it('aging rescues a long waiter from a continuous stream of newcomers', async () => {
    // The starvation shape: the long waiter needs both pools at once, while
    // newcomers each need only one. Arrivals are spaced tighter than they are
    // held and alternate between the pools, so the two are never both free at
    // any moment a young waiter is scanned. Only aging gets `long` in.
    const pool = pools({ lane: 1, 'test-suite': 1 }, { agingMs: 25 })
    const blockLane = await pool.acquire(['lane'])
    const blockSuite = await pool.acquire(['test-suite'])

    let longGranted = false
    let arrivalsAfterLong = 0
    const long = pool.acquire(['lane', 'test-suite']).then((lease) => {
      longGranted = true
      return lease
    })

    const stream: Promise<void>[] = []
    for (let i = 0; i < 40; i += 1) {
      stream.push(
        pool.acquire([i % 2 === 0 ? 'lane' : 'test-suite']).then(async (lease) => {
          if (longGranted) arrivalsAfterLong += 1
          await sleep(10)
          lease.release()
        }),
      )
      await sleep(3)
      // Released one at a time, so a pool is never free at the same instant as
      // the other — a newcomer takes each as it opens.
      if (i === 2) blockLane.release()
      if (i === 3) blockSuite.release()
    }

    ;(await within(5_000, long)).release()
    await within(5_000, Promise.all(stream))
    // Granted while newcomers were still queueing, not after they all drained.
    expect(arrivalsAfterLong).toBeGreaterThan(0)
  })

  it('acquires all or nothing', async () => {
    const pool = pools({ alpha: 1, beta: 2, gamma: 2 }, { agingMs: 0 })
    const blocker = await pool.acquire(['alpha'])

    let granted = false
    const pending = pool.acquire(['gamma', 'alpha', 'beta']).then((lease) => {
      granted = true
      return lease
    })

    await settle()
    expect(granted).toBe(false)
    expect(pool.held('beta')).toBe(0)
    expect(pool.held('gamma')).toBe(0)
    expect(pool.held('alpha')).toBe(1)

    blocker.release()
    const lease = await within(1_000, pending)
    expect(pool.held('beta')).toBe(1)
    lease.release()
  })

  it('does not deadlock when two holders declare the same pools in opposite orders', async () => {
    const pool = pools({ 'test-suite': 1, lane: 1 }, { agingMs: 0 })
    const done: string[] = []

    const holder = async (id: string, needs: readonly string[]): Promise<void> => {
      const lease = await pool.acquire(needs)
      try {
        await sleep(5)
      } finally {
        lease.release()
      }
      done.push(id)
    }

    await within(
      2_000,
      Promise.all([
        holder('forward', ['lane', 'test-suite']),
        holder('reverse', ['test-suite', 'lane']),
      ]),
    )

    expect(done.sort()).toEqual(['forward', 'reverse'])
    expect(pool.held('lane')).toBe(0)
    expect(pool.held('test-suite')).toBe(0)
  })

  it('releases idempotently', async () => {
    const pool = pools({ slot: 1 }, { agingMs: 0 })
    const lease = await pool.acquire(['slot'])
    expect(pool.held('slot')).toBe(1)

    lease.release()
    lease.release()
    lease.release()
    expect(pool.held('slot')).toBe(0)

    // The double release must not have widened the pool: exactly one of two
    // contenders may hold the slot.
    const a = await pool.acquire(['slot'])
    let bGranted = false
    const b = pool.acquire(['slot']).then((held) => {
      bGranted = true
      return held
    })
    await settle()
    expect(bGranted).toBe(false)
    expect(pool.held('slot')).toBe(1)

    a.release()
    ;(await within(1_000, b)).release()
    expect(pool.held('slot')).toBe(0)
  })

  /**
   * The agent lease endpoint answers a waiting client every few seconds instead
   * of holding one HTTP request open for the whole wait. That only works if
   * leaving the queue is real: a caller that walks away and stays queued gets
   * granted a slot nobody is waiting for, which is capacity held by no one
   * until its lease expires.
   */
  describe('a wait that is abandoned', () => {
    it('leaves the queue, so the slot goes to whoever is still waiting', async () => {
      const pool = pools({ slot: 1 }, { agingMs: 0 })
      const a = await pool.acquire(['slot'])

      const leaving = new AbortController()
      const abandoned = pool.acquire(['slot'], { signal: leaving.signal })
      let stayedGranted = false
      const stayed = pool.acquire(['slot']).then((held) => {
        stayedGranted = true
        return held
      })
      await settle()
      expect(pool.waiting).toBe(2)

      leaving.abort()
      await expect(abandoned).rejects.toThrow(/abandoned/)
      expect(pool.waiting).toBe(1)

      a.release()
      await settle()
      // The slot went to the waiter that stayed, not to the one that left.
      expect(stayedGranted).toBe(true)
      ;(await within(1_000, stayed)).release()
      expect(pool.held('slot')).toBe(0)
    })

    it('takes nothing when it is abandoned before it ever queues', async () => {
      const pool = pools({ slot: 1 }, { agingMs: 0 })
      const leaving = new AbortController()
      leaving.abort()

      await expect(pool.acquire(['slot'], { signal: leaving.signal })).rejects.toThrow(/abandoned/)
      expect(pool.held('slot')).toBe(0)
      expect(pool.waiting).toBe(0)
    })

    it('ignores an abort that loses the race to the grant', async () => {
      // Aborting after the grant is too late by construction: the waiter is off
      // the queue and holding real capacity, and the lease is the holder's to
      // release.
      const pool = pools({ slot: 1 }, { agingMs: 0 })
      const leaving = new AbortController()

      const lease = await pool.acquire(['slot'], { signal: leaving.signal })
      leaving.abort()
      await settle()

      expect(pool.held('slot')).toBe(1)
      lease.release()
      expect(pool.held('slot')).toBe(0)
    })
  })

  it('releases on the throwing path when the caller uses finally', async () => {
    const pool = pools({ slot: 1 }, { agingMs: 0 })

    await expect(
      (async () => {
        const lease = await pool.acquire(['slot'])
        try {
          throw new Error('boom')
        } finally {
          lease.release()
        }
      })(),
    ).rejects.toThrow('boom')

    expect(pool.held('slot')).toBe(0)
  })
})
