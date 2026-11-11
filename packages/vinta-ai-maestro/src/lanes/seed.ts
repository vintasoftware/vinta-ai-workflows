/**
 * `project.lane_seed`: the ignored caches a lane is given when it is handed to
 * a phase without them.
 *
 * A recycle cleans every ignored file a lane holds (§8), and a new lane has
 * none, so a gate that narrows by a cache — `pytest --testmon` and its
 * `.testmondata` — finds none in most lanes and runs its cold form. Copying the
 * cache from where the phase's work came from makes the next run the scoped
 * one. Only files git ignores are copied, and never over one the lane has: a
 * seed is a cache, never the phase's work.
 */
import { cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { gitOk } from '../integration/git.ts'

export interface SeedSource {
  /** What the journal calls it: a lane name, `integration` or `checkout`. */
  readonly name: string
  readonly path: string
}

/** Copies each `paths` entry the lane lacks from the first source that has it. */
export async function seedLane(
  lanePath: string,
  paths: readonly string[],
  sources: readonly SeedSource[],
): Promise<readonly { readonly path: string; readonly from: string }[]> {
  const seeded: { path: string; from: string }[] = []
  for (const path of paths) {
    const target = join(lanePath, path)
    if (existsSync(target)) continue
    // `check-ignore` answers for a path that does not exist yet, from the
    // lane's own ignore rules: a tracked path is never a cache to copy.
    if (!(await gitOk(lanePath, ['check-ignore', '-q', '--', path]))) continue
    const source = sources.find((candidate) => existsSync(join(candidate.path, path)))
    if (source === undefined) continue
    await cp(join(source.path, path), target, { recursive: true, errorOnExist: false, force: false })
    seeded.push({ path, from: source.name })
  }
  return seeded
}
