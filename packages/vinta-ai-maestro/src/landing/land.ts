/**
 * Landing a finished run: which PR to merge, and which of the rest are done.
 *
 * A run opens three kinds of PR — one per phase, one per `integ-<id>` branch,
 * and one for the plan — and only the plan PR lands the plan: it is the final
 * wave branch, carrying every phase with every conflict resolved once. The
 * others are review units. An observed landing of 36 such PRs, with nothing
 * saying which to merge, merged them in an order that resolved the same
 * conflicts several times against different bases; two hand resolutions were
 * wrong and each broke CI a branch later. Afterwards six phase PRs were still
 * open, their only commit a GitHub "Update branch" merge whose parents were
 * both already in the base — three of them showing as conflicting, all of them
 * reading as pending work.
 *
 * So this says the one order there is, and tells a PR whose work has landed
 * from one that still carries something: a PR is **landed** when every commit
 * it has that its base lacks is a merge whose parents are all in the base —
 * which is what an "Update branch" merge on a phase whose work arrived through
 * the plan PR looks like, and what an empty one looks like too.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { Journal } from '../journal/journal.ts'

const run = promisify(execFile)

export type PrState = 'open' | 'merged' | 'closed'

/** The forge, as far as landing needs it. `gh` in production; a fake in tests. */
export interface Forge {
  view(url: string): Promise<{ readonly state: PrState; readonly head: string; readonly base: string } | null>
  close(url: string, comment: string): Promise<boolean>
}

export interface ReviewUnit {
  readonly kind: 'phase' | 'integration'
  readonly nodeId: string
  readonly url: string
  readonly state: PrState | 'unknown'
  readonly head: string | null
  readonly base: string | null
  /** True when everything it adds is already in its base; null when that could not be read. */
  readonly landed: boolean | null
}

export interface LandingPlan {
  readonly runId: string
  readonly baseBranch: string
  readonly plan: { readonly url: string; readonly state: PrState | 'unknown' } | null
  readonly units: readonly ReviewUnit[]
}

export interface LandingOptions {
  readonly repoPath: string
  readonly journal: Journal
  readonly runId: string
  readonly forge: Forge
}

/** Every PR the run opened, read from the journal, with each one's state now. */
export async function planLanding(options: LandingOptions): Promise<LandingPlan> {
  const { journal, runId, forge, repoPath } = options
  const workflow = journal.readWorkflow(runId)
  let planUrl: string | null = null
  const opened: { kind: 'phase' | 'integration'; nodeId: string; url: string }[] = []
  for (const event of journal.events(runId)) {
    const payload = event.payload as { url?: string; kind?: string }
    if (event.type === 'run_pr' && typeof payload.url === 'string') planUrl = payload.url
    if (event.type === 'node_pr' && typeof payload.url === 'string' && 'nodeId' in event && event.nodeId !== null) {
      opened.push({ kind: payload.kind === 'integration' ? 'integration' : 'phase', nodeId: event.nodeId, url: payload.url })
    }
  }

  const remote = await firstRemote(repoPath)
  const units: ReviewUnit[] = []
  for (const pr of opened) {
    const view = await forge.view(pr.url)
    if (view === null) {
      units.push({ ...pr, state: 'unknown', head: null, base: null, landed: null })
      continue
    }
    const landed =
      view.state === 'open' ? await addsNothing(repoPath, remote, view.head, workflow.base_branch) : view.state === 'merged'
    units.push({ ...pr, state: view.state, head: view.head, base: view.base, landed })
  }

  const planView = planUrl === null ? null : await forge.view(planUrl)
  return {
    runId,
    baseBranch: workflow.base_branch,
    plan: planUrl === null ? null : { url: planUrl, state: planView?.state ?? 'unknown' },
    units,
  }
}

/** The comment a landed PR is closed with. */
export function landedComment(baseBranch: string, planUrl: string | null): string {
  return (
    `Everything this PR adds is already in \`${baseBranch}\`` +
    (planUrl === null ? '' : ` — it landed through the plan PR ${planUrl}`) +
    '. Closing it as landed, not abandoned. (`vinta-ai-maestro land`)'
  )
}

/**
 * Whether `head` adds nothing to `base`: every commit on it that `base` lacks
 * is a merge whose parents are all in `base`. Null when either ref cannot be
 * read — an unknown is never reported as landed.
 */
export async function addsNothing(
  repoPath: string,
  remote: string | null,
  head: string,
  base: string,
): Promise<boolean | null> {
  if (remote !== null) await gitOk(repoPath, ['fetch', '--quiet', remote, base, head])
  const headRef = await resolveRef(repoPath, remote, head)
  const baseRef = await resolveRef(repoPath, remote, base)
  if (headRef === null || baseRef === null) return null
  let lines: string[]
  try {
    lines = (await git(repoPath, ['rev-list', '--parents', `${baseRef}..${headRef}`])).split('\n').filter((line) => line !== '')
  } catch {
    return null
  }
  for (const line of lines) {
    const [, ...parents] = line.split(' ')
    if (parents.length < 2) return false
    for (const parent of parents) {
      if (!(await gitOk(repoPath, ['merge-base', '--is-ancestor', parent, baseRef]))) return false
    }
  }
  return true
}

/** The forge as `gh` answers. A missing `gh` reads every PR as unknown and closes none. */
export function ghForge(repoPath: string, ghPath = 'gh'): Forge {
  return {
    async view(url) {
      try {
        const { stdout } = await run(ghPath, ['pr', 'view', url, '--json', 'state,headRefName,baseRefName'], { cwd: repoPath })
        const parsed = JSON.parse(stdout) as { state?: string; headRefName?: string; baseRefName?: string }
        const state = parsed.state === 'MERGED' ? 'merged' : parsed.state === 'CLOSED' ? 'closed' : 'open'
        return { state, head: parsed.headRefName ?? '', base: parsed.baseRefName ?? '' }
      } catch {
        return null
      }
    },
    async close(url, comment) {
      try {
        await run(ghPath, ['pr', 'close', url, '--comment', comment], { cwd: repoPath })
        return true
      } catch {
        return false
      }
    },
  }
}

async function resolveRef(repoPath: string, remote: string | null, branch: string): Promise<string | null> {
  for (const ref of [...(remote === null ? [] : [`refs/remotes/${remote}/${branch}`]), `refs/heads/${branch}`]) {
    if (await gitOk(repoPath, ['rev-parse', '--verify', '--quiet', ref])) return ref
  }
  return null
}

export async function firstRemote(repoPath: string): Promise<string | null> {
  try {
    const remotes = (await git(repoPath, ['remote'])).split('\n').filter((line) => line !== '')
    return remotes[0] ?? null
  } catch {
    return null
  }
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run('git', [...args], { cwd })
  return stdout.trim()
}

async function gitOk(cwd: string, args: readonly string[]): Promise<boolean> {
  try {
    await run('git', [...args], { cwd })
    return true
  } catch {
    return false
  }
}
