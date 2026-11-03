/**
 * What an editor save writes: the plan's own values, never the project's.
 *
 * The editor shows the *resolved* workflow — the gate commands the project
 * supplies, the pools it declares, every default made explicit — because that
 * is what a run would execute and what a person needs to see. Writing that
 * document back would copy the project's values into the plan, and from then
 * on a change to `.vinta-ai-workflows.yaml` would never reach it: the plan's
 * copy outranks the project, by the very rule that makes per-plan overrides
 * possible.
 *
 * So a save is a patch. The stored file is resolved the same way the editor's
 * copy was, the two resolved documents are compared, and only what the person
 * changed is applied to the stored file. Untouched fields stay as the file had
 * them — absent where it left them absent — whatever the editor displayed.
 */
import { WorkflowSchema, type Workflow } from '../types.ts'
import type { ProjectConfig } from './project-config.ts'
import { resolveDocument, resolveWorkflow } from './resolve.ts'

type Json = Record<string, unknown>
type Segment = string | { readonly id: string }

/**
 * Maps whose entries a plan replaces whole (`resolve.ts`'s merge rules). A
 * field changed on an entry the plan did not declare has to bring the rest of
 * the entry with it, or the plan's half-entry would replace the project's
 * whole one.
 */
const WHOLE_ENTRY_MAPS = ['resources', 'chores', 'crew', 'pipelines']
const WHOLE_ENTRY_PROJECT_MAPS = ['databases', 'services']

export function ownDocument(posted: Workflow, stored: unknown, config: ProjectConfig | null): unknown {
  if (!isObject(stored)) return posted
  const base = baseline(stored, config)
  // A stored file that does not even take the schema's shape has no baseline
  // to diff against, and the posted document is the only description of the
  // plan there is.
  if (base === null) return posted

  const own = structuredClone(stored)
  apply(own, base as unknown as Json, diff(base, posted))
  return own
}

/**
 * What the editor was shown for this file: the resolved document, parsed.
 *
 * The full parse first. When that fails on a cross-reference — a chore the
 * project no longer declares, a gate requiring a pool that was renamed — the
 * document still has a shape, and the shape is enough to diff against. It
 * used to be all or nothing, and "nothing" meant writing the posted document
 * whole: every default made explicit, every project value copied in, a
 * hundred-line diff over a committed file for a one-field edit, whenever the
 * file happened to be invalid at the moment it was saved.
 */
function baseline(stored: Json, config: ProjectConfig | null): Workflow | null {
  const full = resolveWorkflow(stored, config)
  if (full.ok) return full.workflow
  const shaped = WorkflowSchema.safeParse(resolveDocument(stored, config))
  return shaped.success ? shaped.data : null
}

interface Change {
  readonly path: readonly Segment[]
  /** `undefined` deletes. */
  readonly value: unknown
}

function diff(before: unknown, after: unknown, path: Segment[] = []): Change[] {
  if (deepEqual(before, after)) return []
  if (isObject(before) && isObject(after)) {
    const changes: Change[] = []
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      changes.push(...diff(before[key], after[key], [...path, key]))
    }
    return changes
  }
  if (isNodeList(before) && isNodeList(after) && sameIds(before, after)) {
    return after.flatMap((node, i) => diff(before[i], node, [...path, { id: node.id as string }]))
  }
  return [{ path, value: after }]
}

function apply(own: Json, base: Json, changes: readonly Change[]): void {
  for (const change of changes) {
    let target: Json = own
    let reference: unknown = base
    const parents = change.path.slice(0, -1)
    for (const [depth, segment] of parents.entries()) {
      reference = step(reference, segment)
      const next = step(target, segment)
      // An array is stepped through too: `nodes` is one, addressed by id.
      if (isObject(next) || Array.isArray(next)) {
        target = next as Json
        continue
      }
      // The plan has no entry here. Start one the way the merge would read it.
      const seed = seedFor(change.path.slice(0, depth + 1), reference)
      if (typeof segment === 'string') target[segment] = seed
      target = seed
    }
    const last = change.path[change.path.length - 1]
    if (last === undefined) continue
    if (typeof last !== 'string') continue
    if (change.value === undefined) delete target[last]
    else target[last] = change.value
  }
}

/** The new entry for a path the plan did not have: whole, typed, or empty. */
function seedFor(path: readonly Segment[], resolved: unknown): Json {
  const [top, key, sub] = path
  const entry = isObject(resolved) ? structuredClone(resolved) : {}
  if (path.length === 2 && typeof top === 'string' && WHOLE_ENTRY_MAPS.includes(top)) return entry
  if (path.length === 3 && top === 'project' && typeof key === 'string' && WHOLE_ENTRY_PROJECT_MAPS.includes(key) && sub !== undefined) {
    return entry
  }
  if (path.length === 2 && top === 'gates') {
    // A typed gate merges field by field, so the plan says only its type and
    // what it overrides. An untyped one replaces whole.
    return typeof entry.type === 'string' ? { type: entry.type } : entry
  }
  return {}
}

function step(value: unknown, segment: Segment): unknown {
  if (typeof segment === 'string') return isObject(value) ? value[segment] : undefined
  return Array.isArray(value)
    ? value.find((item) => isObject(item) && item.id === segment.id)
    : undefined
}

function isNodeList(value: unknown): value is Json[] {
  return Array.isArray(value) && value.every((item) => isObject(item) && typeof item.id === 'string')
}

function sameIds(a: readonly Json[], b: readonly Json[]): boolean {
  return a.length === b.length && a.every((item, i) => item.id === b[i]?.id)
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
