/**
 * Pull requests, opened through the `gh` CLI the user already logged into —
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
  /** The phase this PR belongs to. Absent for the plan-level PR, which belongs to none. */
  readonly nodeId?: string
  /** What the operator-facing message calls this PR. Defaults to `node <id>`. */
  readonly label?: string
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
  readonly nodeId?: string
  readonly base: string
  readonly head: string
  readonly url?: string
  /**
   * True when `gh` refused because this head already has a PR, and the URL is
   * that one. A retried phase or a resumed run asks again, and "it is already
   * open" is the answer it wanted, not a failure.
   */
  readonly existing?: boolean
  /** Why it did not open. `unavailable` is the degraded, non-failing case. */
  readonly reason?: 'unavailable' | 'failed'
  /** Operator-facing and identifier-only: never `gh`'s output, which is repo content. */
  readonly message?: string
}

/**
 * `gh pr create`'s refusal for a head that already has an open PR. `gh` puts
 * the existing PR's URL after the colon, on the next line.
 */
const EXISTING_PR = /already exists:?\s*(https?:\/\/\S+)/

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

  const where = {
    opened: false as const,
    ...(options.nodeId === undefined ? {} : { nodeId: options.nodeId }),
    base: options.base,
    head: options.head,
  }
  const label = options.label ?? `node ${options.nodeId ?? '?'}`
  try {
    const { stdout } = await exec(options.ghPath ?? 'gh', args, { cwd: options.cwd })
    return { ...where, opened: true, url: stdout.trim() }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return {
        ...where,
        reason: 'unavailable',
        message: `gh is not installed or not on PATH; open the PR for ${label} manually (base ${options.base}, head ${options.head})`,
      }
    }
    // Only the URL is taken from `gh`'s words, and only from this one refusal.
    const existing = EXISTING_PR.exec(String((error as { stderr?: unknown }).stderr ?? ''))
    if (existing?.[1] !== undefined) {
      return { ...where, opened: true, existing: true, url: existing[1] }
    }
    return {
      ...where,
      reason: 'failed',
      message: `gh exited ${String(code)} opening the PR for ${label} (base ${options.base}, head ${options.head})`,
    }
  }
}
