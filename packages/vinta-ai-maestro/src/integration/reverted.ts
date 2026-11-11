/**
 * Deletions a merge resolution quietly undid.
 *
 * A phase that deletes something does it on purpose — an unused notification
 * kind removed on its agent's answer to a design question, observed — and a
 * resolution that keeps "both sides" keeps the line the phase removed. Nothing
 * downstream notices: unused code breaks no gate, so the deletion never
 * reaches the plan branch and the run reports success. The observed one was
 * found in a manual review after landing. A union merge driver (`append_only`)
 * does the same by construction: it keeps every line either side has, which
 * includes the ones the other side took out.
 *
 * The check is a line count, not a diff: per path, how many copies of a line
 * the result holds against how many a three-way merge of the two sides would
 * (`ours + theirs − base`). More copies than that, of a line one side removed,
 * is a deletion the resolution reverted. Only paths where the result differs
 * from a side that changed them are read, so a clean merge costs two
 * name-only diffs. Lines with no letter or digit in them — braces, blank
 * lines — say nothing about intent and are not counted.
 *
 * Identifiers and counts only (§11): a path, a node, a number. The lines
 * themselves are repository content and stay in the worktree.
 */
import { git } from './git.ts'

/** One path where a merge result kept lines one side deleted. */
export interface RevertedDeletion {
  readonly path: string
  /**
   * The phase whose deletion was reverted. The branch name stands in when no
   * phase of the run on that side changed the path — earlier history, or the
   * plan branch.
   */
  readonly node: string
  /** Lines that side deleted and the result still has. */
  readonly lines: number
}

export interface RevertedDeletionsRequest {
  readonly cwd: string
  /** The commit merged into, as it was before the merge. */
  readonly ours: string
  /** The commit merged in. */
  readonly theirs: string
  /** The merge's outcome, regenerated outputs included. */
  readonly result: string
  /** Which phase made a side's change to a path. */
  readonly attribute: (side: 'ours' | 'theirs', path: string) => Promise<string>
  /** Glob patterns never read: codegen outputs, which the steps regenerate. */
  readonly exclude?: readonly string[]
}

/** Every reverted deletion in `result`, one entry per path and side. Empty when git cannot say. */
export async function revertedDeletions(request: RevertedDeletionsRequest): Promise<RevertedDeletion[]> {
  const { cwd, ours, theirs, result } = request
  let base: string
  try {
    base = (await git(cwd, ['merge-base', ours, theirs])).trim()
  } catch {
    return []
  }
  const specs = ['--', '.', ...(request.exclude ?? []).map((pattern) => `:(exclude,glob)${pattern}`)]
  const changed = async (from: string, to: string): Promise<Set<string>> =>
    new Set(
      (await git(cwd, ['diff', '--name-only', '-z', '--no-renames', from, to, ...specs]))
        .split('\0')
        .filter((path) => path.length > 0),
    )
  const fromResult = { ours: await changed(ours, result), theirs: await changed(theirs, result) }
  const bySide = { ours: await changed(base, ours), theirs: await changed(base, theirs) }

  const found: RevertedDeletion[] = []
  const paths = new Set(
    (['ours', 'theirs'] as const).flatMap((side) => [...bySide[side]].filter((path) => fromResult[side].has(path))),
  )
  for (const path of [...paths].sort()) {
    const b = await lineCounts(cwd, base, path)
    const o = await lineCounts(cwd, ours, path)
    const t = await lineCounts(cwd, theirs, path)
    const r = await lineCounts(cwd, result, path)
    if (b === null || o === null || t === null || r === null) continue
    const reverted = { ours: 0, theirs: 0 }
    for (const [line, inBase] of b) {
      const inOurs = o.get(line) ?? 0
      const inTheirs = t.get(line) ?? 0
      let excess = (r.get(line) ?? 0) - Math.max(0, inOurs + inTheirs - inBase)
      // Charged to whichever side removed the line, ours first; a line both
      // removed is charged once.
      for (const [side, kept] of [['ours', inOurs], ['theirs', inTheirs]] as const) {
        if (excess <= 0 || kept >= inBase || !bySide[side].has(path)) continue
        const charged = Math.min(excess, inBase - kept)
        reverted[side] += charged
        excess -= charged
      }
    }
    for (const side of ['ours', 'theirs'] as const) {
      if (reverted[side] > 0) found.push({ path, node: await request.attribute(side, path), lines: reverted[side] })
    }
  }
  return found
}

/** Bigger than any source file worth counting; `execFile`'s default is 1 MiB. */
const SHOW_LIMIT = 64 * 1024 * 1024

/**
 * How many times each meaningful line appears in `path` at `rev`: an empty map
 * when the path does not exist there, null for a binary file.
 */
async function lineCounts(cwd: string, rev: string, path: string): Promise<Map<string, number> | null> {
  let text: string
  try {
    text = await git(cwd, ['show', `${rev}:${path}`], { maxBuffer: SHOW_LIMIT })
  } catch {
    return new Map()
  }
  if (text.includes('\0')) return null
  const counts = new Map<string, number>()
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (!/[\p{L}\p{N}]/u.test(line)) continue
    counts.set(line, (counts.get(line) ?? 0) + 1)
  }
  return counts
}
