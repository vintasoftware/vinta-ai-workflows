/**
 * Whether a workflow's references reach its plan.
 *
 * `validate.ts` checks the document; it cannot check that `prompt_ref` names a
 * heading that exists, because it never opens the plan. A run finds that out
 * when the first lane resolves its brief — an hour in, for a typo. This finds
 * it while the plan is still being written, which is when `plan-feature` runs
 * `vinta-ai-maestro validate` and when the review page loads.
 *
 * **Every reference is held inside the repository first.** The review page
 * reads these files on a request from a browser, and a reference is just text
 * in a document somebody may have been sent: `../../.ssh/id_rsa#x` must name
 * nothing rather than something. A path that is absolute, climbs out of the
 * checkout, or resolves through a symlink to somewhere outside it is reported
 * as an issue and never read.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { PromptError, resolveBrief } from '../prompts/prompts.ts'
import type { Workflow } from '../types.ts'
import type { ValidationIssue } from '../validate.ts'

/** A plan larger than this is not one a person reviews in a browser. */
export const MAX_PLAN_BYTES = 2 * 1024 * 1024

/** The file half of `file.md#anchor`. */
export function refPath(ref: string): string {
  const hash = ref.lastIndexOf('#')
  return hash === -1 ? ref : ref.slice(0, hash)
}

/** The anchor half, or the empty string. */
export function refAnchor(ref: string): string {
  const hash = ref.lastIndexOf('#')
  return hash === -1 ? '' : ref.slice(hash + 1)
}

export type Contained =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: 'outside' | 'missing' }

/**
 * The absolute path a repo-relative reference names, if it stays inside the
 * repository after symlinks are followed.
 */
export function containedPath(repoDir: string, ref: string): Contained {
  const path = refPath(ref)
  if (path === '' || isAbsolute(path)) return { ok: false, reason: 'outside' }
  const target = resolve(repoDir, path)
  if (escapes(repoDir, target)) return { ok: false, reason: 'outside' }
  let real: string
  let root: string
  try {
    real = realpathSync(target)
    root = realpathSync(repoDir)
  } catch {
    return { ok: false, reason: 'missing' }
  }
  if (escapes(root, real)) return { ok: false, reason: 'outside' }
  return { ok: true, path: real }
}

/** Reads a contained reference's file, bounded. Null when it cannot be read. */
export function readContained(repoDir: string, ref: string): string | null {
  const contained = containedPath(repoDir, ref)
  if (!contained.ok) return null
  try {
    const text = readFileSync(contained.path, 'utf8')
    return Buffer.byteLength(text) > MAX_PLAN_BYTES ? null : text
  } catch {
    return null
  }
}

/**
 * Every reference in the workflow that would fail when a run resolved it.
 * Paths are the document's own, so the CLI and the browser print the same
 * location the validator would.
 */
export function checkReferences(workflow: Workflow, repoDir: string): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  if (workflow.plan_ref !== undefined) {
    const problem = fileProblem(repoDir, workflow.plan_ref)
    if (problem !== null) issues.push({ path: ['plan_ref'], message: problem })
  }

  workflow.plan_context_refs.forEach((ref, index) => {
    const problem = sectionProblem(repoDir, ref, 'plan_context_refs')
    if (problem !== null) issues.push({ path: ['plan_context_refs', index], message: problem })
  })

  workflow.nodes.forEach((node, index) => {
    const problem = sectionProblem(repoDir, node.prompt_ref, 'prompt_ref')
    if (problem !== null) issues.push({ path: ['nodes', index, 'prompt_ref'], message: problem })
  })

  for (const [id, chore] of Object.entries(workflow.chores)) {
    if (chore.prompt_ref === undefined) continue
    const problem = sectionProblem(repoDir, chore.prompt_ref, 'prompt_ref')
    if (problem !== null) issues.push({ path: ['chores', id, 'prompt_ref'], message: problem })
  }

  return issues
}

/** True when every file a prompt would read is inside the repository. */
export function referencesContained(workflow: Workflow, repoDir: string): boolean {
  const refs = [
    ...workflow.plan_context_refs,
    ...workflow.nodes.map((node) => node.prompt_ref),
    ...Object.values(workflow.chores).flatMap((chore) =>
      chore.prompt_ref === undefined ? [] : [chore.prompt_ref],
    ),
  ]
  return refs.every((ref) => containedPath(repoDir, ref).ok)
}

function fileProblem(repoDir: string, ref: string): string | null {
  const contained = containedPath(repoDir, ref)
  if (!contained.ok) {
    return contained.reason === 'outside'
      ? 'names a file outside the repository'
      : 'names no readable file in the repository'
  }
  return null
}

function sectionProblem(repoDir: string, ref: string, field: string): string | null {
  const problem = fileProblem(repoDir, ref)
  if (problem !== null) return problem
  try {
    resolveBrief(repoDir, 'review', ref, field)
    return null
  } catch (error) {
    if (!(error instanceof PromptError)) throw error
    const anchor = refAnchor(ref)
    return anchor === ''
      ? 'names an empty file'
      : `no heading in ${refPath(ref)} matches "#${anchor}"`
  }
}

function escapes(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}
