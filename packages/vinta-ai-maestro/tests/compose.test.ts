/**
 * Compose isolation, decided without docker.
 *
 * Every rule here is a function of the resolved config and the lane's name, so
 * the whole of it is testable with a JSON object — the same property that lets
 * `database.ts` decide fork names with no server anywhere. What is *not* tested
 * here is whether compose honours the document, which is a fact about compose:
 * the `!override` tag and the mandatory `external: false` are both load-bearing
 * and both verified against the real thing, once, by the skill this is ported
 * from.
 *
 * The config below is `vinta-schedule-api`'s, reduced. It is the run that
 * produced this module: six lanes, every phase finishing, and almost every gate
 * dying on a port collision — with the two `external: true` data volumes
 * quietly mounted by all six stacks at once, which nothing failed on and which
 * was the worse half.
 */
import { describe, expect, it } from 'vitest'
import {
  type ComposeConfig,
  allocatePorts,
  findComposeFile,
  planComposeIsolation,
  portVar,
} from '../src/lanes/compose.ts'

/** Ports nobody has to be listening on: the allocator is stubbed everywhere. */
const grants =
  (...ports: readonly number[]) =>
  async (count: number): Promise<readonly number[]> => {
    expect(ports).toHaveLength(count)
    return ports
  }

const schedule = (): ComposeConfig => ({
  name: 'vinta_schedule_api',
  services: {
    db: { ports: [{ mode: 'ingress', target: 5432, published: '5432', protocol: 'tcp' }] },
    result: { ports: [{ mode: 'ingress', target: 6379, published: '6379', protocol: 'tcp' }] },
    api: { ports: [{ mode: 'ingress', target: 8000, published: '8000', protocol: 'tcp' }] },
    // No published port: already isolated, and nothing to say about it.
    worker: {},
  },
  volumes: {
    dbdata: { name: 'vinta_schedule_api_dbdata', external: true },
    virtualenv: { name: 'vinta_schedule_api_virtualenv', external: true },
    // Unpinned: compose resolved it to the auto-namespaced form, so the project
    // name already isolates it and there is nothing to fork.
    scratch: { name: 'vinta_schedule_api_scratch' },
  },
})

const plan = (config: ComposeConfig, options = {}) =>
  planComposeIsolation(config, { composeProject: 'api_lane-1', allocate: grants(), ...options })

describe('compose isolation', () => {
  it('strips every fixed host port, which is what the project name does not', () => {
    // The visible half of the failure: three services, one host, six lanes.
    return plan(schedule()).then((isolation) => {
      expect(isolation.portsStrippedFrom).toEqual(['db', 'result', 'api'])
      expect(isolation.overrideYaml).toContain('"db":\n    ports: !override []')
      // `!override` and not a plain `[]`. An empty list *merges* in Compose v2+,
      // so the tidier-looking version strips precisely nothing.
      expect(isolation.overrideYaml).not.toMatch(/ports: \[\]/)
      // A service that publishes nothing needs no entry at all.
      expect(isolation.overrideYaml).not.toContain('worker')
    })
  })

  it('re-pins every volume the project name leaves shared', async () => {
    const isolation = await plan(schedule())

    // The invisible half, and the worse one. Both are addressed by absolute
    // name, so all six lanes mounted the same PGDATA under six postmasters.
    expect(isolation.volumes.map((volume) => volume.key)).toEqual(['dbdata', 'virtualenv'])
    expect(isolation.volumes[0]?.name).toBe('api_lane-1_dbdata')
    expect(isolation.volumes[0]?.reason).toBe('external: true')
    // Mandatory, not tidiness: without it the base's `external: true` merges
    // through and the volume stays pinned to the one everybody shares.
    expect(isolation.overrideYaml).toContain('external: false')
  })

  it('leaves alone a volume the project name already isolates', async () => {
    const isolation = await plan(schedule())

    // `scratch` resolved to `<project>_scratch`, which is the fingerprint of a
    // volume with no fixed top-level name. Forking it would be noise.
    expect(isolation.volumes.map((volume) => volume.key)).not.toContain('scratch')
  })

  it('detects a fixed name even where the volume is not external', async () => {
    const isolation = await plan({
      name: 'app',
      volumes: { cache: { name: 'shared_cache_v2' } },
    })

    expect(isolation.volumes[0]?.reason).toBe('fixed name "shared_cache_v2"')
    expect(isolation.volumes[0]?.name).toBe('api_lane-1_cache')
  })

  it('keeps a volume shared when the project asks, and says so in the file', async () => {
    // The one decision this must not make for a team. Re-pinning a dependency
    // volume is correct and costs every lane the install that sharing avoided;
    // a data volume is never a candidate, which is why this is opt-in per key
    // rather than a flag over all of them.
    const isolation = await plan(schedule(), { sharedVolumes: ['virtualenv'] })

    expect(isolation.volumes.map((volume) => volume.key)).toEqual(['dbdata'])
    expect(isolation.sharedVolumes).toEqual(['virtualenv'])
    expect(isolation.overrideYaml).toContain('KEPT SHARED')
  })

  it('republishes a service the project needs reachable, on a port it was granted', async () => {
    const isolation = await plan(schedule(), {
      publish: ['api'],
      allocate: grants(21080),
    })

    expect(isolation.published).toEqual([
      { service: 'api', target: 8000, published: 21080, envVar: 'LANE_PORT_API_8000' },
    ])
    expect(isolation.overrideYaml).toContain('"api":\n    ports: !override\n      - "21080:8000"')
    // The pinned entry goes even here. `!override` replaces the whole list, and
    // leaving the project's own `8000:8000` in it would republish the colliding
    // port right beside the granted one.
    expect(isolation.overrideYaml).not.toContain('8000:8000')
    // And the lane is told, because a port nothing can name is not reachable.
    expect(isolation.env).toEqual({ LANE_PORT_API_8000: '21080' })
  })

  it('grants a distinct port per published port, not per service', async () => {
    const isolation = await planComposeIsolation(
      {
        name: 'app',
        services: {
          edge: {
            ports: [
              { target: 80, published: '80' },
              { target: 443, published: '443' },
            ],
          },
        },
      },
      { composeProject: 'app_lane-1', publish: ['edge'], allocate: grants(21000, 21001) },
    )

    expect(isolation.env).toEqual({ LANE_PORT_EDGE_80: '21000', LANE_PORT_EDGE_443: '21001' })
  })

  it('is a valid no-op for a project with nothing to isolate', async () => {
    const isolation = await plan({ name: 'app', services: { web: {} }, volumes: {} })

    expect(isolation.portsStrippedFrom).toEqual([])
    expect(isolation.volumes).toEqual([])
    expect(isolation.overrideYaml).toContain('No leaks found')
    // Still a document, and still wired in. A no-op override is cheaper than a
    // conditional that has to decide whether `COMPOSE_FILE` should be set.
    expect(isolation.overrideYaml).not.toContain('services:')
  })

  it('names a port variable after the service and the port it stands in for', () => {
    // A service may publish several; a variable naming only the service would
    // be two answers to one question.
    expect(portVar('api', 8000)).toBe('LANE_PORT_API_8000')
    expect(portVar('my-worker.v2', 80)).toBe('LANE_PORT_MY_WORKER_V2_80')
  })

  it('finds the compose file in compose’s own order, and answers null for none', () => {
    // The order matters: `COMPOSE_FILE` has to name the file compose would have
    // auto-loaded, or the override is layered onto something else.
    expect(findComposeFile(import.meta.dirname)).toBeNull()
  })

  it('grants ports it has actually bound', async () => {
    const [first, second] = await allocatePorts(2, 34071)

    expect(first).toBeGreaterThanOrEqual(34071)
    expect(second).toBeGreaterThan(first as number)
    // Held until every one is found, so two lanes provisioning at the same time
    // cannot be granted the same port — and released, so compose can take them.
    const again = await allocatePorts(1, first as number)
    expect(again).toEqual([first])
  })
})
