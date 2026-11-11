/**
 * Setting a worktree's uncommitted work aside under a ref, without touching
 * the worktree or its index: a scratch index takes `HEAD` plus everything in
 * the tree, untracked files included, and the result is committed on top of
 * `HEAD` and pointed at by `ref`. Ignored files stay out, as they do from any
 * commit. What is set aside can be read back with `git show <ref>` or checked
 * out by hand; nothing ever applies it automatically.
 */
import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Who a rescue commit is by. Never the agent: it did not write this commit. */
const WIP_AUTHOR = 'vinta-ai-maestro'
const WIP_EMAIL = 'vinta-ai-maestro@localhost'

/** The uncommitted paths of a worktree, as `status --porcelain` names them. */
export async function uncommittedPaths(cwd: string): Promise<string[]> {
  const { stdout } = await run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd })
  return stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.slice(3))
}

/** Commits the worktree's state on top of `HEAD` under `ref`. Throws when git does. */
export async function setAsideWork(cwd: string, ref: string, message: string): Promise<string> {
  const index = join(cwd, '.git-wip-index')
  const scratch = { ...process.env, GIT_INDEX_FILE: index }
  try {
    await run('git', ['read-tree', 'HEAD'], { cwd, env: scratch })
    await run('git', ['add', '--all'], { cwd, env: scratch })
    const { stdout: tree } = await run('git', ['write-tree'], { cwd, env: scratch })
    const { stdout: commit } = await run('git', ['commit-tree', tree.trim(), '-p', 'HEAD', '-m', message], {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: WIP_AUTHOR,
        GIT_AUTHOR_EMAIL: WIP_EMAIL,
        GIT_COMMITTER_NAME: WIP_AUTHOR,
        GIT_COMMITTER_EMAIL: WIP_EMAIL,
      },
    })
    await run('git', ['update-ref', ref, commit.trim()], { cwd })
    return commit.trim()
  } finally {
    await rm(index, { force: true })
  }
}

/**
 * Puts the worktree back at `HEAD`: tracked changes undone, untracked files
 * that are not ignored removed. Ignored files — caches, the lane's databases,
 * its dependency tree — are left exactly where they are.
 */
export async function restoreToHead(cwd: string): Promise<void> {
  await run('git', ['checkout', '--force', 'HEAD', '--', '.'], { cwd })
  await run('git', ['reset', '--quiet', 'HEAD'], { cwd })
  await run('git', ['clean', '--force', '-d', '--quiet'], { cwd })
}
