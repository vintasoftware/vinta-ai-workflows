/**
 * The pool's disk probe.
 *
 * Disk is the constraint that actually bites a lane pool: N lanes means N
 * dependency trees and N database clones. The probe therefore measures against
 * N×, not 1×, and the pool refuses to provision on a failed probe rather than
 * filling the filesystem partway through the first wave — a half-provisioned
 * pool leaves worktrees, cloned databases and a stalled run to clean up by
 * hand, which is strictly worse than not starting.
 */
import { execFile } from 'node:child_process'
import { readdir, lstat, stat, statfs } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { describeWorktrees, type WorktreeCount } from './count.ts'

const run = promisify(execFile)

export interface DiskProbe {
  readonly requiredBytes: number
  readonly availableBytes: number
  readonly fits: boolean
}

export class DiskProbeError extends Error {
  constructor(
    readonly probe: DiskProbe,
    /** What was being sized, when the probe was for the pool rather than one more lane. */
    readonly count?: WorktreeCount,
  ) {
    super(
      `lane pool${count === undefined ? '' : ` of ${describeWorktrees(count)}`} needs ` +
        `${probe.requiredBytes} bytes, ${probe.availableBytes} available — refusing to provision`,
    )
    this.name = 'DiskProbeError'
  }
}

/**
 * Apparent size of a directory tree. Symlinks are not followed: a linked tree
 * is not copied into a lane, and following links would count pnpm's store
 * once per link into it.
 */
export async function measureBytes(root: string): Promise<number> {
  const entry = await lstat(root)
  if (entry.isSymbolicLink()) return 0
  if (!entry.isDirectory()) return entry.size

  const children = await readdir(root)
  const sizes = await Promise.all(children.map((child) => measureBytes(join(root, child))))
  return sizes.reduce((total, size) => total + size, entry.size)
}

/**
 * What one new worktree costs on disk, sized from what provisioning puts in it
 * rather than from the main checkout as it happens to look.
 *
 * Measuring the main checkout — the first version — charged every lane for
 * things no lane gets: `.git` with its whole object store, the maestro store
 * (which holds the lane pool itself, so the estimate grew with every lane
 * provisioned), ignored build caches, and any other worktree nested under the
 * repository. One run's estimate went from 4.0 to 9.5 GiB a lane while its
 * real lanes held about 1.1 GiB, and a resume was refused on the strength of it.
 *
 * So a lane is the sum of:
 *
 * - **The tracked tree at `baseRef`**, from git's own blob sizes — what
 *   `worktree add` checks out. `HEAD` stands in when the ref does not resolve
 *   (a plan branch the run has not cut yet is cut from the base anyway).
 * - **The index git keeps for the worktree**, about the size of the main
 *   checkout's.
 * - **The copied dependency tree** (`node_modules` at the root, what
 *   `LanePool.#copyDeps` copies), at full size even where a clone will share
 *   its blocks — the filesystem may not support cloning. A tree that is itself
 *   a link is linked into the lane and costs nothing.
 * - **The declared env files**, which are copied.
 *
 * What the project's own `setup_cmd` builds inside a lane is not counted: it is
 * not knowable before the command runs, and guessing it from the main
 * checkout's ignored files is the overcount this replaced.
 */
export async function estimateLaneBytes(options: {
  readonly repoPath: string
  readonly baseRef: string
  readonly envFiles?: readonly string[]
  /** The git binary. Defaults to `git` on PATH. */
  readonly git?: string
}): Promise<number> {
  const { repoPath, baseRef } = options
  const git = options.git ?? 'git'
  const [tracked, index, deps, env] = await Promise.all([
    trackedBytes(git, repoPath, baseRef),
    indexBytes(git, repoPath),
    depsBytes(join(repoPath, 'node_modules')),
    Promise.all(
      (options.envFiles ?? []).map((file) =>
        stat(join(repoPath, file)).then(
          (entry) => entry.size,
          () => 0,
        ),
      ),
    ),
  ])
  return tracked + index + deps + env.reduce((total, size) => total + size, 0)
}

/** Sum of blob sizes in a tree, or the same at `HEAD` when `ref` does not resolve. */
async function trackedBytes(git: string, repoPath: string, ref: string): Promise<number> {
  for (const candidate of ref === 'HEAD' ? ['HEAD'] : [ref, 'HEAD']) {
    try {
      const { stdout } = await run(git, ['ls-tree', '-r', '-l', '-z', candidate], {
        cwd: repoPath,
        maxBuffer: 1024 ** 3,
      })
      let total = 0
      // `<mode> <type> <object> <size>\t<path>`, NUL-terminated. A submodule is
      // a `commit` whose size is `-`, and `worktree add` does not check it out.
      for (const record of stdout.split('\0')) {
        const tab = record.indexOf('\t')
        if (tab === -1) continue
        const size = Number(record.slice(0, tab).trim().split(/\s+/)[3])
        if (Number.isFinite(size)) total += size
      }
      return total
    } catch {
      // The next candidate. An unresolvable ref is not an error here.
    }
  }
  return 0
}

async function indexBytes(git: string, repoPath: string): Promise<number> {
  try {
    const { stdout } = await run(git, ['rev-parse', '--git-path', 'index'], { cwd: repoPath })
    const path = stdout.trim()
    return (await stat(isAbsolute(path) ? path : join(repoPath, path))).size
  } catch {
    return 0
  }
}

async function depsBytes(path: string): Promise<number> {
  const entry = await lstat(path).catch(() => null)
  if (entry === null || entry.isSymbolicLink()) return 0
  return measureBytes(path)
}

/** Free space on the filesystem that will hold `path`, which need not exist yet. */
async function availableBytes(path: string): Promise<number> {
  let probe = path
  for (;;) {
    try {
      const fs = await statfs(probe)
      return fs.bavail * fs.bsize
    } catch {
      const parent = dirname(probe)
      if (parent === probe) throw new Error('no existing ancestor to probe for free space')
      probe = parent
    }
  }
}

export async function probePoolDisk(
  poolRoot: string,
  perLaneBytes: number,
  laneCount: number,
): Promise<DiskProbe> {
  const requiredBytes = perLaneBytes * laneCount
  const available = await availableBytes(poolRoot)
  return { requiredBytes, availableBytes: available, fits: requiredBytes <= available }
}
