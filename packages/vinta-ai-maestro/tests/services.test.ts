/**
 * Shared infrastructure, decided without a server.
 *
 * The question every case here answers is the one a six-lane run on a laptop
 * asks: is this six servers, or one server with six names inside it? The
 * external-Postgres path in `database.ts` had the right answer and only for
 * Postgres, so redis, rabbit and object storage were each left with two wrong
 * options — one server per lane, or one server and no isolation at all.
 */
import { describe, expect, it } from 'vitest'
import { ServiceCapacityError, planService, type ServiceSpec } from '../src/lanes/services.ts'

const redis = (): ServiceSpec => ({
  id: 'redis',
  namespace: 'index',
  url: 'redis://localhost:6379',
  urlVar: 'REDIS_URL',
  capacity: 16,
  resetCmd: 'redis-cli -u {url} -n {namespace} FLUSHDB',
})

const lane = (laneName: string, laneIndex: number) => ({ laneName, laneIndex })

describe('a lane’s slice of a shared service', () => {
  it('gives each lane its own database index on one redis', () => {
    const one = planService(redis(), lane('run-1-lane-1', 0))
    const two = planService(redis(), lane('run-1-lane-2', 1))

    expect(one.url).toBe('redis://localhost:6379/0')
    expect(two.url).toBe('redis://localhost:6379/1')
    expect(one.urlVar).toBe('REDIS_URL')
  })

  it('refuses a pool larger than the server has slots for', () => {
    // Rather than wrapping with a modulo. Two lanes on one redis database is
    // exactly the bug this exists to prevent, and arriving at it by arithmetic
    // is no better than arriving at it by neglect — it would be found by a test
    // failing in a *sibling* lane, with nothing naming a cause.
    const small: ServiceSpec = { ...redis(), capacity: 2 }

    expect(() => planService(small, lane('run-1-lane-3', 2))).toThrow(ServiceCapacityError)
    expect(() => planService(small, lane('run-1-lane-3', 2))).toThrow(/raise its capacity/)
  })

  it('names a vhost after the lane where the server names things freely', () => {
    const plan = planService(
      {
        id: 'rabbit',
        namespace: 'name',
        url: 'amqp://guest:guest@localhost:5672',
        urlVar: 'RABBITMQ_URL',
        capacity: 16,
        createCmd: 'rabbitmqadmin declare vhost name={namespace}',
        resetCmd: 'rabbitmqadmin purge queue name={namespace}',
      },
      lane('run-1-lane-1', 0),
    )

    expect(plan.url).toBe('amqp://guest:guest@localhost:5672/run-1-lane-1')
    expect(plan.createCmd).toBe('rabbitmqadmin declare vhost name=run-1-lane-1')
    expect(plan.resetCmd).toBe('rabbitmqadmin purge queue name=run-1-lane-1')
  })

  it('carries the bare namespace where there is no server to hang it off', () => {
    // An object-storage prefix is not an address, it is the isolation itself.
    const plan = planService(
      { id: 'storage', namespace: 'name', urlVar: 'S3_PREFIX', capacity: 16 },
      lane('run-1-lane-2', 1),
    )

    expect(plan.url).toBe('run-1-lane-2')
    expect(plan.createCmd).toBeNull()
    expect(plan.resetCmd).toBeNull()
  })

  it('substitutes the lane, the namespace and the resolved url into a command', () => {
    const plan = planService(
      { ...redis(), createCmd: 'echo {lane} {namespace} {url}' },
      lane('run-1-lane-4', 3),
    )

    expect(plan.createCmd).toBe('echo run-1-lane-4 3 redis://localhost:6379/3')
  })

  it('makes a caller-supplied lane name safe to put in a vhost', () => {
    // A staffed run names worktrees after crew members, so the pool has only
    // the caller's word for what a lane is called.
    const plan = planService(
      { id: 'storage', namespace: 'name', urlVar: 'PREFIX', capacity: 16 },
      lane('run-1/crew 1', 0),
    )

    expect(plan.namespace).toBe('run-1_crew_1')
  })

  it('does not double the separator on a server url that ends in one', () => {
    const plan = planService({ ...redis(), url: 'redis://localhost:6379/' }, lane('l', 2))

    expect(plan.url).toBe('redis://localhost:6379/2')
  })
})
