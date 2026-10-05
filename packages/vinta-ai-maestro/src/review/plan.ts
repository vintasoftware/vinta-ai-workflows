/**
 * A plan as its reviewer sees it, before anything has run (§19).
 *
 * Three things a person has to look at to approve a plan, and none of them is
 * the JSON:
 *
 * - **The plan itself** — the markdown `plan-feature` wrote, which is what the
 *   phases' briefs are cut from.
 * - **The graph** — the workflow resolved over the project's configuration,
 *   because that is what a run executes: a gate the plan names only by type
 *   runs the project's command, and the reviewer should see that command.
 * - **The prompts** — what each agent will actually be told. These are
 *   composed by the same function the scheduler calls (`composeSpawnPrompt`),
 *   over a journal that has no history, so they are exactly the cold prompts a
 *   run would send, minus the two things only a run knows: the phase's branch
 *   (shown as `HEAD`) and its dependencies' final reports.
 *
 * Nothing is cached. A plan is small, prompts are string assembly, and the
 * page asks for the view again only when `planStamp` says a file under it
 * changed — which is the whole point of reviewing with the agent: it edits the
 * plan and the page shows the edit.
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { choresFor } from '../chores.ts'
import { loadProjectConfig, PROJECT_CONFIG_FILE, type ProjectConfig } from '../config/project-config.ts'
import { resolveDocument, resolveWorkflow } from '../config/resolve.ts'
import { computeWaves, findCycle } from '../graph.ts'
import { composeSpawnPrompt, PromptError, resolveBrief, type PromptJournal } from '../prompts/prompts.ts'
import { WorkflowSchema, type Workflow } from '../types.ts'
import type { ValidationIssue } from '../validate.ts'
import { PROMPT_ROLES, type PromptRole } from './document.ts'
import { checkReferences, containedPath, readContained, referencesContained } from './references.ts'

export const WORKFLOW_FILE_SUFFIX = '.workflow.json'

/** Where an issue came from, so the page can say which file to open. */
export type IssueSource = 'workflow' | 'config' | 'reference'

export interface PlanIssue extends ValidationIssue {
  readonly source: IssueSource
}

export interface PhaseMaterials {
  /** The phase's section of the plan, or null when its `prompt_ref` resolves to nothing. */
  readonly brief: string | null
  /** The cold prompt per role. Absent when composition failed — see `error`. */
  readonly prompts: Partial<Record<PromptRole, string>>
  /** Each chore's turn prompt, by chore id. */
  readonly chores: Readonly<Record<string, string>>
  /** Why the prompts could not be composed. A node id and a reference, never prose. */
  readonly error: string | null
}

export interface PlanDocument {
  readonly ref: string
  readonly title: string | null
  readonly markdown: string
}

export interface PlanView {
  readonly id: string
  /**
   * The resolved workflow, or null when it does not even have a workflow's
   * shape. A workflow that parses but fails a graph or reference check is
   * still returned, so the page can draw what is there and list what is wrong.
   */
  readonly workflow: Workflow | null
  readonly valid: boolean
  readonly issues: readonly PlanIssue[]
  readonly waves: Readonly<Record<string, number>>
  readonly plan: PlanDocument | null
  readonly phases: Readonly<Record<string, PhaseMaterials>>
}

export type PlanViewResult =
  | { readonly ok: true; readonly view: PlanView }
  | { readonly ok: false; readonly reason: 'missing' | 'unreadable' }

/** The run id a cold prompt is composed under. It names nothing in the journal. */
const PREVIEW_RUN = 'plan-review'

/** A journal with no history: no branches, no transcripts, no review ledger. */
const EMPTY_JOURNAL: PromptJournal = {
  nodes: () => [],
  tailTranscript: () => [],
  reviewLedger: () => [],
}

export interface Inspection {
  readonly workflow: Workflow | null
  readonly issues: readonly PlanIssue[]
  readonly waves: Readonly<Record<string, number>>
}

export type InspectionResult =
  | ({ readonly ok: true } & Inspection)
  | { readonly ok: false; readonly reason: 'missing' | 'unreadable' }

/**
 * Loads a workflow the way a run would — layered over the project's
 * configuration — and checks it the way a run would find out, references
 * included. `vinta-ai-maestro validate` prints this; the review page draws it.
 */
export async function inspectWorkflow(
  repoDir: string,
  workflowPath: string,
  id: string,
): Promise<InspectionResult> {
  let authored: unknown
  try {
    authored = JSON.parse(readFileSync(workflowPath, 'utf8'))
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { ok: false, reason: 'missing' }
      : { ok: false, reason: 'unreadable' }
  }

  const loaded = await loadProjectConfig(repoDir)
  const config: ProjectConfig | null = loaded.ok ? loaded.config : null
  const issues: PlanIssue[] = loaded.ok
    ? []
    : loaded.issues.map((issue) => ({ ...issue, source: 'config' as const }))

  const resolved = resolveWorkflow(authored, config)
  let workflow: Workflow | null = null
  if (resolved.ok) {
    workflow = resolved.workflow
  } else {
    issues.push(...resolved.issues.map((issue) => ({ ...issue, source: 'workflow' as const })))
    // The graph checks failed but the shape may not have: a cycle or an
    // unknown crew id is worth seeing on the canvas, not only in a list.
    const shaped = WorkflowSchema.safeParse(resolveDocument(authored, config))
    if (shaped.success) workflow = shaped.data
  }

  if (workflow !== null && workflow.id !== id) {
    issues.push({ path: ['id'], message: 'does not match the filename', source: 'workflow' })
  }

  const references = workflow === null ? [] : checkReferences(workflow, repoDir)
  issues.push(...references.map((issue) => ({ ...issue, source: 'reference' as const })))

  return { ok: true, workflow, issues, waves: workflow === null ? {} : wavesOf(workflow) }
}

export async function buildPlanView(
  repoDir: string,
  plansDir: string,
  id: string,
): Promise<PlanViewResult> {
  const inspected = await inspectWorkflow(repoDir, join(plansDir, `${id}${WORKFLOW_FILE_SUFFIX}`), id)
  if (!inspected.ok) return inspected
  const { workflow, issues, waves } = inspected
  return {
    ok: true,
    view: {
      id,
      workflow,
      valid: issues.length === 0,
      issues,
      waves,
      plan: workflow === null ? null : planDocument(repoDir, workflow),
      phases: workflow === null ? {} : materials(repoDir, workflow),
    },
  }
}

/**
 * A fingerprint of every file the view is built from. The page polls this,
 * not the view: a stat per file is cheap, and composing every prompt of a
 * plan once a second for a page nobody is editing would not be.
 */
export function planStamp(repoDir: string, plansDir: string, id: string): string | null {
  const workflowPath = join(plansDir, `${id}${WORKFLOW_FILE_SUFFIX}`)
  const parts = [stat(workflowPath), stat(join(repoDir, PROJECT_CONFIG_FILE))]
  if (parts[0] === null) return null

  let authored: unknown
  try {
    authored = JSON.parse(readFileSync(workflowPath, 'utf8'))
  } catch {
    return parts.join('|')
  }
  for (const ref of referencedFiles(authored)) {
    const contained = containedPath(repoDir, ref)
    parts.push(contained.ok ? stat(contained.path) : `${ref}:none`)
  }
  return parts.join('|')
}

function stat(path: string): string | null {
  try {
    const info = statSync(path)
    return `${info.mtimeMs}:${info.size}`
  } catch {
    return null
  }
}

/** The distinct files a workflow points into, read loosely: the stamp must not need a valid document. */
function referencedFiles(authored: unknown): string[] {
  if (authored === null || typeof authored !== 'object') return []
  const doc = authored as Record<string, unknown>
  const refs: string[] = []
  if (typeof doc.plan_ref === 'string') refs.push(doc.plan_ref)
  if (Array.isArray(doc.plan_context_refs)) {
    for (const ref of doc.plan_context_refs) if (typeof ref === 'string') refs.push(ref)
  }
  if (Array.isArray(doc.nodes)) {
    for (const node of doc.nodes) {
      const ref = (node as { prompt_ref?: unknown } | null)?.prompt_ref
      if (typeof ref === 'string') refs.push(ref)
    }
  }
  const files = new Set(refs.map((ref) => (ref.includes('#') ? ref.slice(0, ref.lastIndexOf('#')) : ref)))
  return [...files].filter((file) => file !== '').sort()
}

function wavesOf(workflow: Workflow): Record<string, number> {
  try {
    return Object.fromEntries(computeWaves(workflow.nodes))
  } catch {
    // A cycle: there are no waves, and the issue list already says why.
    return {}
  }
}

function planDocument(repoDir: string, workflow: Workflow): PlanDocument | null {
  // Without a `plan_ref` the plan is whatever file the phases point into —
  // `plan-feature` always writes one, but a hand-written workflow may not.
  const ref = workflow.plan_ref ?? workflow.nodes[0]?.prompt_ref.split('#')[0]
  if (ref === undefined || ref === '') return null
  const markdown = readContained(repoDir, ref)
  if (markdown === null) return null
  const heading = /^#\s+(.+)$/m.exec(markdown)
  return { ref, title: heading?.[1]?.trim() ?? null, markdown }
}

function materials(repoDir: string, workflow: Workflow): Record<string, PhaseMaterials> {
  // Composition reads every reference, so it runs only when every one of them
  // stays inside the repository. The issue list already names the one that
  // does not; composing around it would be reading the file anyway.
  const contained = referencesContained(workflow, repoDir)
  // A prompt lists the phase's dependency closure in wave order, and a cycle
  // has no waves. The issue list names the cycle; the briefs still show.
  const blocked = !contained
    ? 'a reference names a file outside the repository'
    : findCycle(workflow.nodes) !== null
      ? 'the graph has a dependency cycle'
      : null
  const out: Record<string, PhaseMaterials> = {}

  for (const node of workflow.nodes) {
    const brief = contained ? sectionText(repoDir, node.prompt_ref) : null
    if (blocked !== null) {
      out[node.id] = { brief, prompts: {}, chores: {}, error: blocked }
      continue
    }
    const prompts: Partial<Record<PromptRole, string>> = {}
    const chores: Record<string, string> = {}
    let error: string | null = null
    try {
      for (const role of PROMPT_ROLES) {
        prompts[role] = composeSpawnPrompt({
          template: role,
          workflow,
          node,
          runId: PREVIEW_RUN,
          journal: EMPTY_JOURNAL,
          workspace: repoDir,
          facts: {},
        })
      }
      for (const { id, chore } of choresFor(workflow, node)) {
        chores[id] = composeSpawnPrompt({
          template: 'chore',
          workflow,
          node,
          runId: PREVIEW_RUN,
          journal: EMPTY_JOURNAL,
          workspace: repoDir,
          facts: {},
          chore: { id, chore },
        })
      }
    } catch (thrown) {
      // `PromptError`'s message names the node and the reference, never the
      // document's text — safe to show, and it is the fix.
      if (!(thrown instanceof PromptError)) throw thrown
      error = thrown.message
    }
    out[node.id] = { brief, prompts, chores, error }
  }
  return out
}

/** The phase's brief, through the resolver the scheduler uses — so the two agree on what a section is. */
function sectionText(repoDir: string, ref: string): string | null {
  try {
    return resolveBrief(repoDir, 'review', ref)
  } catch (error) {
    if (error instanceof PromptError) return null
    throw error
  }
}
