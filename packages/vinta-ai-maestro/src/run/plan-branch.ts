/**
 * The run's plan branch: `plan/<workflow-id>/base`.
 *
 * Every run starts by cutting it from `base_branch`, and from then on it is
 * the run's wave-0 — dependency-free phases branch from it, lanes are reset to
 * it, the first wave merge starts from it. `base_branch` keeps the one job it
 * has that nothing else can do: it is what every pull request targets.
 *
 * The point is the place it gives people to change the run *while it runs*.
 * A commit on this branch that edits `.vinta-ai-workflows.yaml` or the plan's
 * workflow file is picked up and applied to the live run
 * (`src/config/reload.ts`), and because it is a commit on the branch the plan
 * lands from, the change ships with the plan and reaches `base_branch` through
 * the same review. A commit on `main` reaches no run it was not meant for.
 *
 * Named as a leaf beside the run's other branches rather than as their parent:
 * `plan/<id>` cannot be a branch while `plan/<id>/phase-*` are, because a ref
 * is a file and git will not make the same path a file and a directory.
 *
 * Every message here names branches and nothing else (§11).
 */
import { git, gitLines, gitOk } from '../integration/git.ts'

export function planBranchName(workflowId: string): string {
  return `plan/${workflowId}/base`
}

export type PlanBranchResult =
  | { readonly ok: true; readonly branch: string; readonly head: string; readonly created: boolean }
  | { readonly ok: false; readonly message: string }

/**
 * Makes sure the plan branch exists and contains `baseBranch`.
 *
 * - **Missing** — cut from `baseBranch`.
 * - **Already contains `baseBranch`** — used as it is. That is a branch
 *   somebody prepared on purpose (a config change committed before the run), or
 *   the branch an earlier run of the same plan left.
 * - **Behind `baseBranch` with nothing of its own** — moved forward, unless a
 *   worktree has it checked out: moving a ref under somebody's checkout leaves
 *   their working tree describing a commit the branch no longer points at.
 * - **Diverged** — refused. Either side could be the one that matters, and
 *   picking one is the operator's call.
 *
 * `resume` skips the last three: the branch is the run's own by then, and the
 * base moving on underneath it is exactly what must not move a resumed run.
 */
export async function ensurePlanBranch(
  repoPath: string,
  workflowId: string,
  baseBranch: string,
  options: { readonly resume?: boolean } = {},
): Promise<PlanBranchResult> {
  const branch = planBranchName(workflowId)
  const ref = `refs/heads/${branch}`

  const base = await commitOf(repoPath, baseBranch)
  if (base === null) {
    return { ok: false, message: `vinta-ai-maestro: base branch "${baseBranch}" does not resolve to a commit.` }
  }

  const existing = await commitOf(repoPath, ref)
  if (existing === null) {
    await git(repoPath, ['branch', branch, base])
    return { ok: true, branch, head: base, created: true }
  }
  if (options.resume === true) return { ok: true, branch, head: existing, created: false }

  if (await isAncestor(repoPath, base, existing)) {
    return { ok: true, branch, head: existing, created: false }
  }

  if (await isAncestor(repoPath, existing, base)) {
    const holder = await checkedOutAt(repoPath, ref)
    if (holder !== null) {
      return {
        ok: false,
        message:
          `vinta-ai-maestro: plan branch "${branch}" is behind "${baseBranch}" and is checked out ` +
          `at ${holder}. Bring it up to date there, or check out something else, and start again.`,
      }
    }
    await git(repoPath, ['branch', '--force', branch, base])
    return { ok: true, branch, head: base, created: false }
  }

  return {
    ok: false,
    message:
      `vinta-ai-maestro: plan branch "${branch}" has diverged from "${baseBranch}". Merge or ` +
      `rebase it onto "${baseBranch}", or delete it to start from "${baseBranch}" alone.`,
  }
}

/** The commit a ref names, or null when it names none. */
export async function commitOf(repoPath: string, ref: string): Promise<string | null> {
  try {
    return (await git(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim()
  } catch {
    return null
  }
}

async function isAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean> {
  return await gitOk(repoPath, ['merge-base', '--is-ancestor', ancestor, descendant])
}

/** The worktree path holding `ref` checked out, or null. */
async function checkedOutAt(repoPath: string, ref: string): Promise<string | null> {
  const lines = await gitLines(repoPath, ['worktree', 'list', '--porcelain'])
  let path: string | null = null
  for (const line of lines) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
    else if (line === `branch ${ref}`) return path
  }
  return null
}
