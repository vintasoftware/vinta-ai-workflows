/**
 * Reading outside the lane without gaining the right to write there.
 *
 * A lane is a worktree of the repository, so most of what a phase needs is
 * already in it. What is not is everything the *operator's* checkout holds and
 * the branch does not: a plan committed after the lane was cut, a spec that was
 * never committed at all, a sibling package's source that a brief refers to by
 * absolute path. Reaching for any of those is refused before the model sees a
 * byte — `claude` denies a read outside its working directory with
 * `decision_reason_type: "workingDir"` — and the refusal reads like a prompt
 * awaiting an answer ("you haven't granted it yet") when it is a dead end.
 *
 * `--add-dir` lifts that. It also lifts the *write* confinement, which is the
 * problem: the lane sits at `<repo>/.vinta-ai-maestro/lanes/<lane>`, inside the
 * very directory being granted, so granting the repository hands every agent
 * the operator's working copy and every sibling lane to write into. Today that
 * is impossible for free, because the working directory is the boundary; the
 * grant would spend a property nobody asked to sell.
 *
 * So the grant is paired with a deny list, and the shape of that list is forced
 * by how the vendor resolves rules: **deny beats allow, with no carve-out.**
 * `deny: <repo>/**` plus `allow: <lane>/**` refuses the lane too — verified
 * against the CLI, not inferred. The only expressible form is a deny list that
 * never names the lane in the first place, which is what `writeDenyRules`
 * builds: walking from each granted root down to the lane, denying the
 * *siblings* at every step. Everything under the root except the corridor
 * leading to the lane, and the lane itself.
 *
 * **This covers the file tools and not `Bash`.** A shell redirection was never
 * confined to the working directory and is not confined now — the boundary it
 * crosses is the OS's, which is what a sandbox is for, and turning on the
 * vendor's sandbox also turns off the network that `pnpm install` needs. So
 * this restores exactly the protection that the grant would otherwise remove,
 * and claims nothing beyond it.
 */

import { join } from 'node:path'

/** Lists a directory's entries. Unreadable or absent reads as empty. */
export type ListDir = (dir: string) => readonly string[]

/** The file-editing tools. `Bash` is deliberately absent — see the module note. */
const WRITING_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const

export interface ReadGrant {
  /** Directories to grant beyond the working directory, as absolute paths. */
  readonly roots: readonly string[]
  /** The working directory: the one place under those roots that stays writable. */
  readonly lane: string
}

/**
 * Settings globs denying writes everywhere in `roots` except the lane.
 *
 * A directory on the way down to the lane is not denied — a rule covering it
 * would cover the lane inside it — so each step denies that directory's *other*
 * children instead. Both the entry and its subtree are named, because a
 * root-level file is written at its own path and a directory's contents are
 * written below it.
 *
 * Enumerated at spawn rather than globbed, because a glob cannot say "except".
 * A directory created later at one of these levels is therefore not covered:
 * that is a gap in the guard, and a small one — the exposure worth closing is
 * the operator's existing source, which is what is on disk when a lane starts.
 */
export function writeDenyRules(grant: ReadGrant, list: ListDir): readonly string[] {
  const rules: string[] = []

  for (const root of grant.roots) {
    const descent = below(root, grant.lane)
    // A root that does not contain the lane needs no corridor: deny all of it.
    if (descent === null) {
      rules.push(...deny(root))
      continue
    }
    // Down the corridor, denying the siblings at each step. The last step is
    // the lane's own parent, whose other children are the sibling lanes.
    //
    // Paths are built with `join` from the root the caller gave, never
    // reassembled out of split segments: a rebuilt path loses the leading
    // separator on POSIX and the drive on Windows, and the failure is silent —
    // every listing comes back empty, no rule is written, and the grant ships
    // with no guard at all.
    let here = root
    for (const next of descent) {
      for (const entry of list(here)) {
        if (entry !== next) rules.push(...deny(join(here, entry)))
      }
      here = join(here, next)
    }
  }
  return rules
}

/**
 * The segments leading from `root` down to `path`, or null when `path` is not
 * under it.
 *
 * Both sides are this tool's own spellings — the lane root is derived from the
 * repository path the operator gave — so they are compared as written. Two
 * spellings of one directory is a different problem, and the answer to it is
 * not to guess here.
 */
function below(root: string, path: string): readonly string[] | null {
  const from = segmentsOf(root)
  const to = segmentsOf(path)
  if (to.length <= from.length) return null
  return from.every((segment, index) => to[index] === segment) ? to.slice(from.length) : null
}

/** `--add-dir` arguments for the granted roots. */
export function addDirArgs(grant: ReadGrant): readonly string[] {
  return grant.roots.flatMap((root) => ['--add-dir', root])
}

/**
 * Both forms of one path, for every writing tool.
 *
 * `//` is the settings syntax for an absolute path, and separators are
 * normalized to `/` because these are globs rather than paths — a Windows
 * backslash reads as an escape.
 */
function deny(path: string): readonly string[] {
  const target = path.replace(/\\/g, '/').replace(/^\/+/, '')
  return WRITING_TOOLS.flatMap((tool) => [`${tool}(//${target})`, `${tool}(//${target}/**)`])
}

const segmentsOf = (path: string): readonly string[] =>
  path.replace(/\\/g, '/').split('/').filter(Boolean)
