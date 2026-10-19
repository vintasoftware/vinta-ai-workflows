/**
 * The sweep for containers nobody owns.
 *
 * A killed gate or `with` command stops the containers it started
 * (`platform/containers.ts`), but only when maestro is the one that killed it.
 * A command an agent ran bare and the harness then killed, a `docker compose
 * run` left behind by an agent's parallel tool calls, a job that died with a
 * suite running — none of those pass through a kill of ours, and each leaves a
 * one-off container running against a lane's databases. One observed run had
 * two of them, for 6 and 22 minutes, before the coordinator stopped them by
 * hand.
 *
 * A one-off container in a lane no phase is running in has no live owner: a
 * phase's commands, its gates and an `exec` into it all run while the lane is
 * held. So the sweep stops those, and only those. A lane that is busy is
 * skipped, because its phase may be running a container on purpose, and the
 * integration worktree is never swept here: whoever holds it owns what it
 * runs, and its own kills already clean up.
 */
import { composeOneOffs, removeContainers, type DockerExec, dockerExec } from '../platform/containers.ts'

export interface SweptLane {
  readonly lane: string
  readonly stopped: readonly string[]
}

export interface SweepOptions {
  /** Every lane of the run with its compose project, when it has one. */
  readonly lanes: readonly { readonly name: string; readonly project: string | undefined }[]
  /** True while a phase or an `exec` is running in the lane. */
  readonly busy: (lane: string) => boolean
  readonly exec?: DockerExec
}

export async function sweepOrphanContainers(options: SweepOptions): Promise<readonly SweptLane[]> {
  const exec = options.exec ?? dockerExec
  const swept: SweptLane[] = []
  for (const lane of options.lanes) {
    if (lane.project === undefined || lane.project === '' || options.busy(lane.name)) continue
    const found = await composeOneOffs(lane.project, exec)
    if (found.length === 0) continue
    // Re-checked after the docker round trip: a phase that took the lane in the
    // meantime owns what is running in it now.
    if (options.busy(lane.name)) continue
    const stopped = await removeContainers(
      found.map((container) => container.id),
      exec,
    )
    if (stopped.length > 0) swept.push({ lane: lane.name, stopped })
  }
  return swept
}

export interface OrphanSweep {
  stop(): void
}

/**
 * Sweeps on a timer for the life of a run. One sweep at a time: docker can be
 * slow under the very load an orphan causes, and two overlapping sweeps would
 * race each other's `rm`. Never throws into the run.
 */
export function startOrphanSweep(options: {
  readonly everyMs: number
  readonly lanes: () => SweepOptions['lanes']
  readonly busy: SweepOptions['busy']
  readonly onStopped: (lane: string, count: number) => void
  readonly exec?: DockerExec
}): OrphanSweep {
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    void sweepOrphanContainers({
      lanes: options.lanes(),
      busy: options.busy,
      ...(options.exec === undefined ? {} : { exec: options.exec }),
    })
      .then((swept) => {
        for (const lane of swept) options.onStopped(lane.lane, lane.stopped.length)
      })
      .catch(() => {})
      .finally(() => {
        running = false
      })
  }, options.everyMs)
  timer.unref?.()
  return { stop: () => clearInterval(timer) }
}
