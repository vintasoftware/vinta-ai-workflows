/**
 * The tracking directory — `write_tracking`'s output (§5.2, `parallel-lanes.md
 * #TRACKING_DIR`).
 *
 * ```
 * <plan dir>/TRACKING_<plan id>/
 *   run.md                # the conductor's, on the current wave branch
 *   phase-<node id>.md    # the lane's own, on that phase's branch
 *   waves/wave-<N>.md     # the conductor's, in the wave merge commit
 * ```
 *
 * **Why a directory, and why the ownership split matters here.** Concurrent
 * lanes commit on branches that later merge; one shared file would conflict on
 * every wave merge for no reason. So a lane writes exactly one path — its own
 * `phase-<id>.md`, in its own worktree — and the conductor's two paths are
 * written only in the integration worktree. No writer ever touches another's
 * file, which is what makes the merges trivially clean.
 *
 * **Identifiers only.** The skill's `phase-<id>.md` also carries a prose
 * summary a human writes from the diff; nothing here writes one. A summary
 * derived from repository contents or from an agent's narration is exactly the
 * content §2 keeps out of anything but the transcript and the gate log, and an
 * orchestrator that wrote one would be laundering it into a committed file.
 * What is recorded is status, wave, branch names, dependency ids, harness and
 * gate ids — every one of them a name the plan already chose.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { git, gitOk } from '../integration/git.ts'
import type { Workflow } from '../types.ts'

export type TrackingScope = 'run' | 'phase' | 'wave'

/**
 * `ai-plans/PLAN_x.md#phase-1` → `ai-plans/TRACKING_<id>`. A workflow with no
 * `plan_ref` tracks at the repository root, which is the only location that
 * needs no guess.
 *
 * **Joined with `posix`, on every platform, because this is a git path and not
 * a filesystem path.** It is handed to `git add`, to `git commit -- <path>`
 * and — through `parallel-lanes.md`'s own reader — to `git show <rev>:<path>`,
 * and git speaks forward slashes everywhere including Windows. Built with
 * `node:path`'s platform `join` it came out as `ai-plans\TRACKING_x` there,
 * and `git show` answered `fatal: path ... does not exist`: the phase's
 * tracking file was never committed, so the node failed on a path separator.
 * Node resolves a forward-slash path against the filesystem perfectly well on
 * Windows, so there is nothing to trade away by fixing it in this direction.
 */
export function trackingDir(workflow: Pick<Workflow, 'id' | 'plan_ref'>): string {
  const ref = workflow.plan_ref?.split('#')[0]
  const dir = ref === undefined || ref === '' ? '' : posix.dirname(ref)
  const name = `TRACKING_${workflow.id}`
  return dir === '' || dir === '.' ? name : posix.join(dir, name)
}

/**
 * A file under the tracking directory, as a repo-relative git path.
 *
 * The callers used to compose this themselves with `join`, which put the same
 * separator bug back one level up from `trackingDir`. One function owns the
 * rule now, so a new tracking file cannot reintroduce it.
 */
export function trackingPath(
  workflow: Pick<Workflow, 'id' | 'plan_ref'>,
  ...segments: readonly string[]
): string {
  return posix.join(trackingDir(workflow), ...segments)
}

/** One node, as the run record and the phase record both see it. */
export interface PhaseFacts {
  readonly nodeId: string
  readonly wave: number
  readonly status: string
  readonly harness: string
  readonly lane: string | null
  readonly branch: string
  readonly base: string
  readonly dependsOn: readonly string[]
  readonly gates: readonly string[]
}

export interface RunFacts {
  readonly runId: string
  readonly workflowId: string
  readonly baseBranch: string
  readonly phases: readonly PhaseFacts[]
}

export interface WaveFacts {
  readonly wave: number
  readonly branch: string
  /** Node branches merged, in merge order. */
  readonly merged: readonly { readonly nodeId: string; readonly branch: string }[]
  /** Identifiers only: which nodes conflicted over which paths, and for how many rounds. */
  readonly conflicts: readonly {
    readonly nodes: readonly string[]
    readonly paths: readonly string[]
    readonly rounds: number
  }[]
}

export function renderRun(facts: RunFacts): string {
  return [
    `# Run ${facts.runId}`,
    '',
    `- workflow: \`${facts.workflowId}\``,
    `- base branch: \`${facts.baseBranch}\``,
    '',
    '| phase | wave | status | harness | lane | branch |',
    '|---|---|---|---|---|---|',
    ...facts.phases.map(
      (phase) =>
        `| ${phase.nodeId} | ${phase.wave} | ${phase.status} | ${phase.harness} | ` +
        `${phase.lane ?? '—'} | \`${phase.branch}\` |`,
    ),
    '',
  ].join('\n')
}

export function renderPhase(facts: PhaseFacts): string {
  return [
    `# Phase ${facts.nodeId}`,
    '',
    `- status: ${facts.status}`,
    `- wave: ${facts.wave}`,
    `- branch: \`${facts.branch}\``,
    `- base: \`${facts.base}\``,
    `- depends on: ${list(facts.dependsOn)}`,
    `- harness: ${facts.harness}`,
    `- gates: ${list(facts.gates)}`,
    '',
  ].join('\n')
}

export function renderWave(facts: WaveFacts): string {
  return [
    `# Wave ${facts.wave}`,
    '',
    `- branch: \`${facts.branch}\``,
    '- merged, in order:',
    ...(facts.merged.length === 0
      ? ['  - (none)']
      : facts.merged.map((entry) => `  - ${entry.nodeId} — \`${entry.branch}\``)),
    '- conflicts:',
    ...(facts.conflicts.length === 0
      ? ['  - (none)']
      : facts.conflicts.map(
          (conflict) =>
            `  - ${conflict.nodes.join(', ')} over ${conflict.paths.join(', ')} ` +
            `(${conflict.rounds} round${conflict.rounds === 1 ? '' : 's'})`,
        )),
    '',
  ].join('\n')
}

function list(values: readonly string[]): string {
  return values.length === 0 ? '—' : values.map((value) => `\`${value}\``).join(', ')
}

/**
 * Writes one tracking file and commits it in the worktree that owns it.
 *
 * Committing is what makes the record travel: a `phase-<id>.md` left uncommitted
 * in a lane never reaches the wave merge, and the whole point of the layout is
 * that each record rides its own branch. A worktree with nothing to commit —
 * the same record written twice — is a no-op rather than an error.
 *
 * Returns the repo-relative path written.
 */
export async function writeTrackingFile(options: {
  readonly cwd: string
  readonly relPath: string
  readonly body: string
  readonly message: string
}): Promise<string> {
  const absolute = join(options.cwd, options.relPath)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, options.body, 'utf8')

  await git(options.cwd, ['add', '--', options.relPath])
  // `commit` exits non-zero when the index holds nothing new. Expected, not an error.
  await gitOk(options.cwd, ['commit', '-m', options.message, '--', options.relPath])
  return options.relPath
}
