/**
 * Containers a killed command leaves behind.
 *
 * Killing a gate's process group ends `docker compose run` — the *client*. The
 * container it asked for belongs to the Docker daemon, not to the group, and
 * keeps running. In one observed run a timed-out suite's container went on for
 * minutes with nobody reading its output, and a cancelled one ran for 22 more
 * against the same lane test databases as the rerun, so the two blocked each
 * other while the host's load average climbed past 40. Each one was stopped by
 * hand.
 *
 * So whatever kills a command it started also stops the one-off containers
 * that command started. Compose labels every container it creates with its
 * project (`com.docker.compose.project`) and marks `run` containers
 * `com.docker.compose.oneoff=True`; a lane's project is its own
 * `COMPOSE_PROJECT_NAME`. "Started by this command" is read as "a one-off of
 * the lane's project created at or after the command started" — the closest
 * thing to ownership the labels carry without rewriting the project's command.
 * It can reach a second one-off another command in the same lane started
 * meanwhile, which is a command racing a killed one for the same lane
 * databases, and the trade the report that motivated this asked for.
 *
 * Docker is optional: with no `docker` on `PATH`, or no daemon, every function
 * here does nothing and says so by returning an empty list. Nothing here logs;
 * a container id is the most it returns.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export type DockerExec = (args: readonly string[]) => Promise<string>

const execFileAsync = promisify(execFile)

/** Each docker call is short; one that hangs (a wedged daemon) must not hold a lock forever. */
const DOCKER_TIMEOUT_MS = 30_000

/**
 * Docker reports creation times from its own clock, which on Docker Desktop is
 * a VM's. A container the command started a moment after it began must not be
 * missed for a second of drift.
 */
const CLOCK_SLACK_MS = 2_000

export const dockerExec: DockerExec = async (args) => {
  const { stdout } = await execFileAsync('docker', [...args], {
    timeout: DOCKER_TIMEOUT_MS,
    windowsHide: true,
  })
  return stdout
}

export interface OneOff {
  readonly id: string
  readonly createdAtMs: number
}

/** Every running one-off container of a compose project. */
export async function composeOneOffs(project: string, exec: DockerExec = dockerExec): Promise<readonly OneOff[]> {
  try {
    const ids = (
      await exec([
        'ps',
        '-q',
        '--no-trunc',
        '--filter',
        `label=com.docker.compose.project=${project}`,
        '--filter',
        'label=com.docker.compose.oneoff=True',
      ])
    )
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
    if (ids.length === 0) return []
    const inspected = await exec(['inspect', '--format', '{{.Id}} {{.Created}}', ...ids])
    const found: OneOff[] = []
    for (const line of inspected.split('\n')) {
      const [id, created] = line.trim().split(' ')
      if (id === undefined || id === '' || created === undefined) continue
      const createdAtMs = Date.parse(created)
      if (Number.isNaN(createdAtMs)) continue
      found.push({ id, createdAtMs })
    }
    return found
  } catch {
    return []
  }
}

/** Force-removes containers; `run --rm` ones are gone either way. Returns those removed. */
export async function removeContainers(
  ids: readonly string[],
  exec: DockerExec = dockerExec,
): Promise<readonly string[]> {
  if (ids.length === 0) return []
  try {
    await exec(['rm', '-f', ...ids])
    return ids
  } catch {
    return []
  }
}

/**
 * Stops the one-off containers of `project` created since `sinceMs`. Awaited
 * by the caller before it releases whatever lock the command held, so the
 * next holder never shares the lane's databases with a container nobody owns.
 */
export async function stopOneOffsSince(
  project: string,
  sinceMs: number,
  exec: DockerExec = dockerExec,
): Promise<readonly string[]> {
  const mine = (await composeOneOffs(project, exec)).filter(
    (container) => container.createdAtMs >= sinceMs - CLOCK_SLACK_MS,
  )
  return removeContainers(
    mine.map((container) => container.id),
    exec,
  )
}

/** What a gate or a `with` command stops after it was killed. Injected in tests. */
export type ContainerCleanup = (project: string, sinceMs: number) => Promise<readonly string[]>

export const stopComposeOneOffs: ContainerCleanup = (project, sinceMs) => stopOneOffsSince(project, sinceMs)
