/**
 * Shared infrastructure, with a namespace per lane.
 *
 * `database.ts` already draws the right distinction for Postgres: `delivery:
 * 'external'` means one shared server with a forked database per lane, and it
 * works — the Nth lane costs a `CREATE DATABASE … TEMPLATE`, not a server.
 * Nothing equivalent existed for redis, rabbit or object storage, so those had
 * two options and both were wrong. Boot one per lane, and six lanes is six
 * servers on a laptop. Share one with no isolation, and six lanes write to key
 * `session:1` and read each other's.
 *
 * So this generalizes what the external-Postgres path does: **one server, and a
 * name inside it per lane.** A redis database index, a rabbit vhost, a key
 * prefix in a bucket — the same idea, spelled differently by each engine, which
 * is why the engine is not modelled here. What is modelled is how the namespace
 * is *derived* and how it reaches the lane:
 *
 * - `index` — a small integer, for a server with a fixed number of slots.
 *   Redis's sixteen databases are the case this exists for.
 * - `name` — a token derived from the lane, for a server that names things
 *   freely. A vhost, a bucket prefix, a schema.
 *
 * Everything else is the project's own command lines, which is the honest place
 * for it: creating a vhost and emptying one are `rabbitmqadmin` invocations
 * this package has no business knowing, and a project that needs neither
 * declares neither.
 *
 * Pure, like `database.ts` and for the same reason: the names, the URLs and
 * the commands are a function of the spec and the lane, so all of it is
 * decidable in a test with no server anywhere.
 */

/** How a lane's namespace inside a shared service is derived. */
export type NamespaceKind = 'index' | 'name'

export interface ServiceSpec {
  readonly id: string
  readonly namespace: NamespaceKind
  /**
   * The shared server, without the per-lane segment — `redis://localhost:6379`.
   * Absent where the namespace *is* the value: an object-storage prefix has no
   * URL to hang off, and the variable carries the bare token.
   */
  readonly url?: string
  /** Env var the lane reads this service's address from. */
  readonly urlVar: string
  /** How many distinct namespaces the server has. Only meaningful for `index`. */
  readonly capacity: number
  /** Run once per lane. `{namespace}`, `{url}` and `{lane}` are substituted. */
  readonly createCmd?: string
  /** Returns the namespace to empty, on recycle. Same substitutions. */
  readonly resetCmd?: string
}

/** One lane's slice of one shared service. */
export interface ServicePlan {
  readonly id: string
  readonly namespace: string
  readonly urlVar: string
  /** What the lane's `urlVar` is set to. */
  readonly url: string
  readonly createCmd: string | null
  /** Null means this lane's slice cannot be emptied — see `LanePool.recycle`. */
  readonly resetCmd: string | null
}

export interface LaneIdentity {
  readonly laneName: string
  /** The lane's position in the pool. What an `index` namespace is derived from. */
  readonly laneIndex: number
}

/**
 * More lanes than the server has room for.
 *
 * Refused rather than wrapped with a modulo. Two lanes on one redis database
 * is not "tight", it is the bug this module exists to prevent, arrived at by
 * arithmetic instead of by neglect — and it would be found by a test failing
 * in a sibling lane rather than by anything naming a cause.
 */
export class ServiceCapacityError extends Error {
  constructor(
    readonly service: string,
    readonly capacity: number,
    readonly lanes: number,
  ) {
    super(
      `service "${service}" has ${capacity} namespaces and the pool needs ${lanes} — ` +
        'raise its capacity, or run fewer lanes',
    )
    this.name = 'ServiceCapacityError'
  }
}

/**
 * A token safe to put in a vhost, a bucket prefix or a schema name.
 *
 * Lane names are already kebab-case identifiers, so this is a guard rather than
 * a transformation — but a caller-supplied lane name (`laneNames`, a staffed
 * run naming worktrees after crew members) has only the pool's word for it.
 */
const token = (value: string): string => value.replaceAll(/[^A-Za-z0-9_-]/g, '_')

const fill = (
  template: string,
  values: { namespace: string; url: string; lane: string },
): string =>
  template
    .replaceAll('{namespace}', values.namespace)
    .replaceAll('{url}', values.url)
    .replaceAll('{lane}', values.lane)

/** What one lane gets of one shared service. */
export function planService(spec: ServiceSpec, lane: LaneIdentity): ServicePlan {
  if (spec.namespace === 'index' && lane.laneIndex >= spec.capacity) {
    throw new ServiceCapacityError(spec.id, spec.capacity, lane.laneIndex + 1)
  }

  const namespace =
    spec.namespace === 'index' ? String(lane.laneIndex) : token(lane.laneName)
  // With a server, the namespace is a path segment on it; without one, the
  // namespace is the whole answer — which is what an S3 prefix is.
  const url = spec.url === undefined ? namespace : `${spec.url.replace(/\/+$/, '')}/${namespace}`
  const values = { namespace, url, lane: lane.laneName }

  return {
    id: spec.id,
    namespace,
    urlVar: spec.urlVar,
    url,
    createCmd: spec.createCmd === undefined ? null : fill(spec.createCmd, values),
    resetCmd: spec.resetCmd === undefined ? null : fill(spec.resetCmd, values),
  }
}
