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
 *
 * **A daemon that does not answer is not a daemon with nothing running.** Under
 * the load a full suite puts on a laptop, `docker ps` can take longer than its
 * time limit, and the cleanup used to read that as "no containers" — the one
 * answer that leaves a killed suite's container running against the databases
 * of the attempt after it, unnoticed. One observed timed-out gate's container
 * was still running nine minutes later beside its rerun's. So the stop says
 * `null` when docker ran out of time, the default cleanup asks once more with
 * far more patience, and the gate runner owes the project a sweep when even
 * that fails (`gates/runner.ts`).
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

/** The second try's limit, for a daemon slow under load rather than gone. */
const PATIENT_DOCKER_TIMEOUT_MS = 120_000

function dockerWithin(timeout: number): DockerExec {
  return async (args) => {
    const { stdout } = await execFileAsync('docker', [...args], { timeout, windowsHide: true })
    return stdout
  }
}

export const dockerExec: DockerExec = dockerWithin(DOCKER_TIMEOUT_MS)

const patientDockerExec: DockerExec = dockerWithin(PATIENT_DOCKER_TIMEOUT_MS)

/**
 * Whether a docker call failed by running out of time — `execFile` kills it and
 * says `killed`. Anything else (no binary, no daemon, a refusal) is an answer:
 * nothing of ours can be running where docker cannot run anything.
 */
export function dockerTimedOut(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { killed?: unknown }).killed === true
}

export interface OneOff {
  readonly id: string
  readonly createdAtMs: number
}

/** Every running one-off container of a compose project. */
export async function composeOneOffs(project: string, exec: DockerExec = dockerExec): Promise<readonly OneOff[]> {
  return (await queryOneOffs(project, exec)) ?? []
}

/** `composeOneOffs`, with null where docker ran out of time and the answer is unknown. */
async function queryOneOffs(project: string, exec: DockerExec): Promise<readonly OneOff[] | null> {
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
  } catch (error) {
    return dockerTimedOut(error) ? null : []
  }
}

/** Force-removes containers; `run --rm` ones are gone either way. Returns those removed. */
export async function removeContainers(
  ids: readonly string[],
  exec: DockerExec = dockerExec,
): Promise<readonly string[]> {
  return (await removeOrUnknown(ids, exec)) ?? []
}

async function removeOrUnknown(ids: readonly string[], exec: DockerExec): Promise<readonly string[] | null> {
  if (ids.length === 0) return []
  try {
    await exec(['rm', '-f', ...ids])
    return ids
  } catch (error) {
    return dockerTimedOut(error) ? null : []
  }
}

/**
 * Stops the one-off containers of `project` created since `sinceMs`. Awaited
 * by the caller before it releases whatever lock the command held, so the
 * next holder never shares the lane's databases with a container nobody owns.
 * Null when docker ran out of time before it could say.
 */
export async function stopOneOffsSince(
  project: string,
  sinceMs: number,
  exec: DockerExec = dockerExec,
): Promise<readonly string[] | null> {
  const found = await queryOneOffs(project, exec)
  if (found === null) return null
  const mine = found.filter((container) => container.createdAtMs >= sinceMs - CLOCK_SLACK_MS)
  return removeOrUnknown(
    mine.map((container) => container.id),
    exec,
  )
}

/**
 * What a gate or a `with` command stops after it was killed: the containers
 * stopped, or null when docker could not be asked in time. Injected in tests.
 */
export type ContainerCleanup = (project: string, sinceMs: number) => Promise<readonly string[] | null>

export const stopComposeOneOffs: ContainerCleanup = async (project, sinceMs) =>
  (await stopOneOffsSince(project, sinceMs)) ?? (await stopOneOffsSince(project, sinceMs, patientDockerExec))
