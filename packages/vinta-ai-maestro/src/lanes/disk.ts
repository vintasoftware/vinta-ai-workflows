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
import { readdir, lstat, statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface DiskProbe {
  readonly requiredBytes: number
  readonly availableBytes: number
  readonly fits: boolean
}

export class DiskProbeError extends Error {
  constructor(readonly probe: DiskProbe) {
    super(
      `lane pool needs ${probe.requiredBytes} bytes, ` +
        `${probe.availableBytes} available — refusing to provision`,
    )
    this.name = 'DiskProbeError'
  }
}

/**
 * Apparent size of a directory tree. Symlinks are not followed, which is the
 * point: a lane that symlinks its dependency tree costs nothing for it.
 */
export async function measureBytes(root: string): Promise<number> {
  const entry = await lstat(root)
  if (entry.isSymbolicLink()) return 0
  if (!entry.isDirectory()) return entry.size

  const children = await readdir(root)
  const sizes = await Promise.all(children.map((child) => measureBytes(join(root, child))))
  return sizes.reduce((total, size) => total + size, entry.size)
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
