/**
 * One PR per node, opened through the `gh` CLI the user already logged into —
 * the same no-credentials rule the harness adapters follow (§11). Nothing here
 * reads a token or talks to an API.
 *
 * **This never throws.** Opening a PR is how a finished run is reported, not
 * the work the run did. A missing or unauthenticated `gh` must leave the
 * branches, the merges and the wave spine exactly as they are and say so, not
 * turn hours of completed work into a failed run.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export interface OpenPrOptions {
  readonly cwd: string
  readonly nodeId: string
  /** The node's computed base — never `base_branch` for a node with dependencies. */
  readonly base: string
  readonly head: string
  readonly title: string
  readonly body: string
  readonly draft: boolean
  /** Overridden in tests. Never points at a real remote there. */
  readonly ghPath?: string
}

export interface PrResult {
  readonly opened: boolean
  readonly nodeId: string
  readonly base: string
  readonly head: string
  readonly url?: string
  /** Why it did not open. `unavailable` is the degraded, non-failing case. */
  readonly reason?: 'unavailable' | 'failed'
  /** Operator-facing and identifier-only: never `gh`'s output, which is repo content. */
  readonly message?: string
}

export async function openPullRequest(options: OpenPrOptions): Promise<PrResult> {
  const args = [
    'pr',
    'create',
    '--base',
    options.base,
    '--head',
    options.head,
    '--title',
    options.title,
    '--body',
    options.body,
    ...(options.draft ? ['--draft'] : []),
  ]

  const where = { opened: false as const, nodeId: options.nodeId, base: options.base, head: options.head }
  try {
    const { stdout } = await exec(options.ghPath ?? 'gh', args, { cwd: options.cwd })
    return { ...where, opened: true, url: stdout.trim() }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return {
        ...where,
        reason: 'unavailable',
        message: `gh is not installed or not on PATH; open the PR for node ${options.nodeId} manually (base ${options.base}, head ${options.head})`,
      }
    }
    return {
      ...where,
      reason: 'failed',
      message: `gh exited ${String(code)} opening the PR for node ${options.nodeId} (base ${options.base}, head ${options.head})`,
    }
  }
}
