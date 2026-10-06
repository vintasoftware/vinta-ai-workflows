/**
 * Compose isolation — the part `COMPOSE_PROJECT_NAME` does not cover.
 *
 * The pool has always set `COMPOSE_PROJECT_NAME` per lane and a comment here
 * used to call it "the isolation key for every `docker compose` any project
 * command might reach for". It is not. It namespaces containers, networks and
 * *auto-named* volumes, and leaves two extremely common patterns untouched:
 *
 * 1. **Volumes pinned by name, or declared `external: true`.** These are
 *    addressed by name, so every lane's stack mounts the *same physical
 *    volume*. For a database volume that is N postmasters on one data
 *    directory — not a collision that fails loudly, but corruption that
 *    surfaces later and somewhere else. For a dependency volume it is a lane
 *    installing a package into its five siblings mid-run.
 * 2. **Fixed host port bindings** (`ports: - "5432:5432"`). A published host
 *    port collides across compose projects no matter what they are called.
 *
 * The fix is a generated override, never an edit to the project's own compose
 * files: those are tracked, and rewriting them would put the isolation into the
 * phase's diff. It re-pins every leaky volume to a lane-namespaced,
 * non-external one, and either strips host port publishing or moves it to a
 * port this lane was actually granted.
 *
 * **Detection carries no project, service or volume name.** Everything comes
 * from `docker compose config --format json`. A volume leaks when it is
 * external, or when its resolved name differs from the auto-namespaced
 * `<project>_<key>` — which is what a fixed top-level `name:` looks like after
 * compose has resolved it.
 *
 * This is a TypeScript port of `prepare-worktree`'s
 * `gen-compose-worktree-override.sh`, which had all of the above right and
 * which the daemon never ran, because the daemon provisions its own lanes and
 * never invokes the skill. The script remains the human path; this is the one
 * the pool executes. They must not drift: the detection rules are the contract.
 *
 * Planning is pure and separate from probing on purpose. `planComposeIsolation`
 * takes a parsed config and returns a document, so every rule here is decidable
 * in a test with no docker, no daemon and no containers anywhere in sight —
 * exactly as `database.ts` decides fork names without a server.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** One entry of a service's resolved `ports:` list. */
export interface ComposePort {
  readonly target?: number
  /** Present exactly when the service publishes to a host port. */
  readonly published?: string | number
  readonly protocol?: string
  readonly mode?: string
}

export interface ComposeService {
  readonly ports?: readonly ComposePort[]
}

export interface ComposeVolume {
  /** Compose's *resolved* name — auto-namespaced, or the fixed `name:`. */
  readonly name?: string
  readonly external?: boolean
}

/** What `docker compose config --format json` says, narrowed to what matters. */
export interface ComposeConfig {
  readonly name?: string
  readonly services?: Readonly<Record<string, ComposeService | null>>
  readonly volumes?: Readonly<Record<string, ComposeVolume | null>>
}

/** A host port the lane was granted, and the variable that carries it. */
export interface PublishedPort {
  readonly service: string
  readonly target: number
  readonly published: number
  readonly envVar: string
}

/** A volume that was shared and is now the lane's own. */
export interface ForkedVolume {
  readonly key: string
  /** Why it leaked: `external: true`, or the fixed name it carried. */
  readonly reason: string
  readonly name: string
}

export interface ComposeIsolation {
  /** The override document. Written out of tree; never into the worktree. */
  readonly overrideYaml: string
  readonly volumes: readonly ForkedVolume[]
  /** Services whose host port publishing the override drops entirely. */
  readonly portsStrippedFrom: readonly string[]
  readonly published: readonly PublishedPort[]
  /** Added to the lane's environment — one variable per granted port. */
  readonly env: Readonly<Record<string, string>>
  /** Volume keys that leak and were deliberately left shared. */
  readonly sharedVolumes: readonly string[]
}

export interface ComposeIsolationOptions {
  /** The lane's `COMPOSE_PROJECT_NAME`, which every new name is built from. */
  readonly composeProject: string
  /**
   * Services that must keep a *reachable* host port, republished on one this
   * lane was granted rather than the one the project pinned.
   *
   * Empty is the right default and is usually right outright: where the
   * project's own test command runs inside compose — `docker compose run --rm
   * api python -m pytest …` — services reach each other by container DNS on the
   * lane's own network, and a published port buys nothing but a collision.
   */
  readonly publish?: readonly string[]
  /**
   * Volume keys that leak and are to be left leaking.
   *
   * The escape hatch for the one decision this module should not make for a
   * team: re-pinning a shared dependency volume is *correct*, and it costs
   * every lane the install that sharing it was avoiding. A read-only cache with
   * no dependency churn in the plan is safe to keep shared; a data volume never
   * is.
   */
  readonly sharedVolumes?: readonly string[]
  /** Grants `count` free host ports. Injected so the planner stays pure. */
  readonly allocate?: (count: number) => Promise<readonly number[]>
}

/** Where compose looks for its file, in the order compose looks. */
export const COMPOSE_FILENAMES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
] as const

/**
 * The environment variable carrying one granted port.
 *
 * Named after the service and the port it stands in for, because a service may
 * publish several and a variable that named only the service would be two
 * answers to one question.
 */
export const portVar = (service: string, target: number): string =>
  `LANE_PORT_${service.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_')}_${target}`

/** Every published port of one service, in declaration order. */
function publishedPorts(service: ComposeService | null): ComposePort[] {
  return (service?.ports ?? []).filter((port) => {
    const published = port.published
    return published !== undefined && published !== null && String(published) !== ''
  })
}

/**
 * Why this volume is not isolated by the project name, or null when it is.
 *
 * The auto-namespaced form is what compose resolves an unpinned volume to, so a
 * resolved name that differs from it is the fingerprint of a fixed top-level
 * `name:` — which is the only way to detect one after resolution.
 */
function leak(key: string, volume: ComposeVolume | null, project: string): string | null {
  if (volume?.external === true) return 'external: true'
  const resolved = volume?.name
  if (resolved !== undefined && resolved !== '' && resolved !== `${project}_${key}`) {
    return `fixed name "${resolved}"`
  }
  return null
}

/** A YAML scalar that cannot be misread. JSON strings are valid YAML ones. */
const y = (value: string): string => JSON.stringify(value)

/**
 * The override for one lane. Pure: the same config and options give the same
 * document, and nothing here touches a disk, a socket or a container.
 */
export async function planComposeIsolation(
  config: ComposeConfig,
  options: ComposeIsolationOptions,
): Promise<ComposeIsolation> {
  const project = config.name ?? 'compose'
  const shareable = new Set(options.sharedVolumes ?? [])
  const publishable = new Set(options.publish ?? [])

  const volumes: ForkedVolume[] = []
  const sharedVolumes: string[] = []
  for (const [key, volume] of Object.entries(config.volumes ?? {})) {
    const reason = leak(key, volume, project)
    if (reason === null) continue
    if (shareable.has(key)) sharedVolumes.push(key)
    else volumes.push({ key, reason, name: `${options.composeProject}_${key}` })
  }

  const stripped: string[] = []
  const wanted: { service: string; target: number }[] = []
  for (const [service, spec] of Object.entries(config.services ?? {})) {
    const ports = publishedPorts(spec)
    if (ports.length === 0) continue
    if (publishable.has(service)) {
      for (const port of ports) {
        // A published port with no target is not something to republish: there
        // is no container port to map it onto.
        if (port.target !== undefined) wanted.push({ service, target: port.target })
      }
    }
    // Stripped either way. A service keeping a port gets its whole `ports:`
    // list replaced by the lane's own, so the pinned entries must go first —
    // `!override` replaces the list, and leaving them in would republish the
    // colliding port beside the granted one.
    stripped.push(service)
  }

  const granted =
    wanted.length === 0 ? [] : await (options.allocate ?? allocatePorts)(wanted.length)
  const published: PublishedPort[] = wanted.map(({ service, target }, index) => ({
    service,
    target,
    published: granted[index] as number,
    envVar: portVar(service, target),
  }))

  return {
    overrideYaml: render(project, options.composeProject, volumes, sharedVolumes, stripped, published),
    volumes,
    portsStrippedFrom: stripped,
    published,
    env: Object.fromEntries(published.map((port) => [port.envVar, String(port.published)])),
    sharedVolumes,
  }
}

function render(
  project: string,
  composeProject: string,
  volumes: readonly ForkedVolume[],
  sharedVolumes: readonly string[],
  stripped: readonly string[],
  published: readonly PublishedPort[],
): string {
  const lines = [
    '# GENERATED by vinta-ai-maestro. Do not edit: it is rewritten whenever the',
    '# lane is provisioned or recycled, and it is not part of the phase’s diff.',
    '#',
    '# It neutralizes the compose isolation leaks COMPOSE_PROJECT_NAME does not',
    '# cover — volumes pinned by name or declared external, and fixed host port',
    '# bindings — so this lane’s stack cannot collide with another lane’s or with',
    '# the main checkout’s.',
    `# Source project: ${project}   Lane: ${composeProject}`,
  ]
  for (const key of [...sharedVolumes].sort()) {
    lines.push(`# KEPT SHARED, by the project’s own request: ${key}`)
  }
  lines.push('')

  const byService = new Map<string, PublishedPort[]>()
  for (const port of published) {
    byService.set(port.service, [...(byService.get(port.service) ?? []), port])
  }

  if (stripped.length > 0) {
    lines.push('services:')
    for (const service of [...stripped].sort()) {
      lines.push(`  ${y(service)}:`)
      const keeps = byService.get(service) ?? []
      if (keeps.length === 0) {
        // `!override []` REPLACES the list. A plain `ports: []` merges in
        // Compose v2+ and would strip precisely nothing.
        lines.push('    ports: !override []')
        continue
      }
      lines.push('    ports: !override')
      for (const port of keeps) lines.push(`      - ${y(`${port.published}:${port.target}`)}`)
    }
    lines.push('')
  }

  if (volumes.length > 0) {
    lines.push('volumes:')
    for (const volume of [...volumes].sort((a, b) => a.key.localeCompare(b.key))) {
      lines.push(`  ${y(volume.key)}:`)
      lines.push(`    name: ${y(volume.name)}`)
      // Mandatory, not tidiness: without it the base's `external: true` merges
      // through and the volume stays pinned to the one everybody shares.
      lines.push('    external: false')
    }
    lines.push('')
  }

  if (stripped.length === 0 && volumes.length === 0) {
    lines.push('# No leaks found: every volume is already namespaced by the project')
    lines.push('# name and no service publishes a fixed host port. A valid no-op.')
    lines.push('')
  }

  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * Host ports nothing is listening on, taken by binding them.
 *
 * Deterministic-by-lane-index would have been simpler and is not enough: a
 * second run on the same machine, or a container left up by the last one, makes
 * the arithmetic agree with itself and disagree with reality. So each candidate
 * is *bound* before it is granted — the only question a port can actually
 * answer — and the ones this call hands out are held until every one of them is
 * found, so two lanes provisioning concurrently cannot be granted the same one.
 *
 * It is still a race against the world: the window between releasing a port
 * here and compose binding it is real. It is small, it is the same window every
 * port allocator has, and the alternative — holding the socket until compose
 * wants it — is not something a provisioning step can do.
 */
export async function allocatePorts(count: number, from = 20000): Promise<readonly number[]> {
  const held: { port: number; close: () => Promise<void> }[] = []
  try {
    for (let candidate = from; held.length < count; candidate += 1) {
      if (candidate > 65535) {
        throw new Error(`could not find ${count} free host ports above ${from}`)
      }
      const holder = await hold(candidate)
      if (holder !== null) held.push({ port: candidate, close: holder })
    }
    return held.map((entry) => entry.port)
  } finally {
    await Promise.all(held.map((entry) => entry.close()))
  }
}

/** Binds one port, or null when something already has it. */
function hold(port: number): Promise<(() => Promise<void>) | null> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => {
      resolve(null)
    })
    server.listen(port, '0.0.0.0', () => {
      resolve(
        () =>
          new Promise<void>((closed) => {
            server.close(() => {
              closed()
            })
          }),
      )
    })
  })
}

/** Raised when compose is needed and cannot answer. */
export class ComposeUnavailable extends Error {}

/**
 * The compose file this project would auto-load, or null when it has none.
 *
 * Searched in compose's own order, because that is the one compose itself will
 * pick, and `COMPOSE_FILE` has to name the file that is actually the base.
 */
export function findComposeFile(repoPath: string): string | null {
  return COMPOSE_FILENAMES.find((name) => existsSync(join(repoPath, name))) ?? null
}

/**
 * The project's resolved compose config, or null when the project has no
 * compose file — which is not a failure, just a project with nothing to isolate.
 *
 * `COMPOSE_PROJECT_NAME` is deliberately *not* forced: the auto-namespace
 * comparison in `leak` is only meaningful against the name the project normally
 * resolves to, so the config has to be read the way the project reads it.
 */
export async function readComposeConfig(
  repoPath: string,
  baseFile: string | null,
): Promise<{ config: ComposeConfig; baseFile: string } | null> {
  if (baseFile === null) return null
  let stdout: string
  try {
    ;({ stdout } = await run('docker', ['compose', 'config', '--format', 'json'], {
      cwd: repoPath,
      maxBuffer: 32 * 1024 * 1024,
    }))
  } catch {
    // Named without the output: what compose printed is the project's own
    // config, and §11 keeps it out of an error the same way it keeps it out of
    // a log field.
    throw new ComposeUnavailable(
      `docker compose could not resolve "${baseFile}" — is docker running, and does the config parse?`,
    )
  }
  return { config: JSON.parse(stdout) as ComposeConfig, baseFile }
}
