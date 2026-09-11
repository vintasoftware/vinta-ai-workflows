/**
 * `vinta-flow purge [run-id]` — §11's stated requirement.
 *
 * This command exists because agent transcripts and gate logs capture
 * repository contents verbatim. That makes `.vinta-flow/runs/` a data-at-rest
 * surface with a retention obligation, and an obligation with no mechanism is
 * a promise. This is the mechanism.
 *
 * It is also the only destructive command in the package, so it is built to be
 * one:
 *
 * - **It says exactly what it will delete, before it deletes it.** Every target
 *   path, listed. Not a count, not a glob — the paths, because a count cannot be
 *   checked and a glob has to be mentally expanded by the person least able to
 *   afford being wrong about it.
 * - **It asks.** `--yes` skips the question for scripts; `--dry-run` prints the
 *   list and stops, so "what would this remove" never requires being brave.
 * - **It cannot leave `.vinta-flow/runs/`.** A run id is not a path: it is
 *   rejected outright if it contains a separator or a `..` segment, and the
 *   resolved target is then re-checked for containment before anything is
 *   unlinked. Two checks, because the first is a syntactic guess about what
 *   paths mean and the second is the actual question being asked. `fs.rm` does
 *   not follow symlinks, so a run directory that is a link to somewhere else
 *   loses the link and not the somewhere else.
 *
 * What it removes is the run *directory* — the frozen workflow snapshot, the
 * transcripts, the raw streams and the gate logs. It does not touch `flow.db`:
 * the event log carries opaque identifiers only (§11), it is the source of
 * truth every projection is rebuilt from, and dropping it would take the
 * post-mortem down with the transcripts it was supposed to replace.
 */
import { readdir, rm } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

import { FAILED, OK, USAGE, type Io } from './io.ts'
import { runsRootFor } from './paths.ts'

export const PURGE_USAGE = `usage: vinta-flow purge [run-id] [--repo <dir>] [--yes] [--dry-run]

  Deletes run state under .vinta-flow/runs/ — transcripts, raw streams, gate
  logs and the frozen workflow snapshot. With no run id, every run is listed.

  --repo <dir>   The project whose .vinta-flow/ store is purged.
                 Defaults to the current directory.
  --yes          Skip the confirmation. For scripts.
  --dry-run      List what would be deleted and stop.`

/** A run id is a single directory name, never a path. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export async function purgeCommand(argv: readonly string[], io: Io): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        repo: { type: 'string' },
        yes: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
      },
      allowPositionals: true,
    })
  } catch {
    io.err(PURGE_USAGE)
    return USAGE
  }
  if (parsed.positionals.length > 1) {
    io.err(PURGE_USAGE)
    return USAGE
  }

  const repoPath = resolve(parsed.values.repo ?? process.cwd())
  const runsRoot = runsRootFor(repoPath)
  const runId = parsed.positionals[0]

  const targets =
    runId === undefined ? await everyRun(runsRoot) : await within(runsRoot, runId, io)
  if (targets === null) return FAILED

  if (targets.length === 0) {
    io.out(
      runId === undefined
        ? 'vinta-flow: no run state to purge.'
        : `vinta-flow: no run state for "${runId}".`,
    )
    return OK
  }

  io.out('vinta-flow purge — the following run state will be permanently deleted:')
  for (const target of targets) io.out(`  ${relative(repoPath, target)}`)
  io.out('')
  io.out('These directories hold agent transcripts and gate logs, which contain')
  io.out('repository contents verbatim. Deletion cannot be undone.')

  if (parsed.values['dry-run'] === true) {
    io.out('')
    io.out('--dry-run: nothing was deleted.')
    return OK
  }

  if (parsed.values.yes !== true && !(await io.confirm(`Delete ${targets.length} run directories?`))) {
    io.err('vinta-flow: cancelled. Nothing was deleted.')
    return FAILED
  }

  for (const target of targets) await rm(target, { recursive: true, force: true })
  io.out(`vinta-flow: deleted ${targets.length} run director${targets.length === 1 ? 'y' : 'ies'}.`)
  return OK
}

/**
 * Resolves one run id inside `runsRoot`, or refuses.
 *
 * The containment re-check after `resolve` is not redundant with the pattern
 * above it: the pattern encodes an assumption about what characters can mean
 * "go up", and this asks the resolver the question directly.
 */
async function within(runsRoot: string, runId: string, io: Io): Promise<string[] | null> {
  if (!RUN_ID.test(runId)) {
    io.err(`vinta-flow: refusing "${runId}" — a run id is a single name, not a path.`)
    return null
  }

  const target = resolve(runsRoot, runId)
  if (!target.startsWith(runsRoot + sep)) {
    io.err(`vinta-flow: refusing "${runId}" — it resolves outside .vinta-flow/runs/.`)
    return null
  }
  return (await everyRun(runsRoot)).includes(target) ? [target] : []
}

/** Every run directory, or none when the store has never been written. */
async function everyRun(runsRoot: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(runsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(runsRoot, entry.name))
    .sort()
}
