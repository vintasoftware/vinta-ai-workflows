/**
 * The workflow files the editor (§10's Editor row) reads and writes.
 *
 * A run's `workflow.json` is *frozen* (§5.3) and is not this. These are the
 * source documents a run is started **from** — the thing `plan-feature` emits
 * and a person edits before anything is scheduled — so they live beside the
 * store rather than inside a run directory, and nothing here ever touches a
 * run's snapshot.
 *
 * Three rules, all of them enforced below rather than documented:
 *
 * - **The id is the filename, and the id is the schema's.** Ids match the
 *   workflow schema's own kebab-case rule, which contains no `/`, no `.` and
 *   no `..`, so a request cannot name a path outside the directory. Validating
 *   the id is the whole of the traversal defence; there is no second sanitiser
 *   to disagree with the first.
 * - **Writes are atomic.** A workflow is written to a temporary file in the
 *   same directory and renamed over the target, so a crash mid-write leaves the
 *   previous document intact rather than a truncated one. `rename` within a
 *   directory is atomic on both platforms this package targets.
 * - **Nothing here logs.** A workflow carries plan prose and repository paths
 *   (§11); a read that fails answers with a reason code, never with the bytes
 *   it could not parse or the path it could not open.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The workflow schema's own id rule. Kebab-case, so never a path segment. */
const WORKFLOW_ID = /^[a-z0-9][a-z0-9-]*$/

/** Where workflows live when the daemon is not told otherwise. */
export const WORKFLOWS_DIRNAME = 'workflows'

export type WorkflowRead =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: 'missing' | 'unreadable' }

export interface WorkflowStore {
  readonly dir: string
  /** Every `<id>.json` whose stem is a legal workflow id, sorted. */
  list(): string[]
  read(id: string): WorkflowRead
  /** Pretty-printed, atomic. Creates the directory on first write. */
  write(id: string, workflow: unknown): void
}

export function isWorkflowId(value: string): boolean {
  return WORKFLOW_ID.test(value)
}

export function createWorkflowStore(dir: string): WorkflowStore {
  return {
    dir,

    list(): string[] {
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        // An absent directory is an empty list, not an error: a project that
        // has never been edited has no workflows, and saying so is the answer.
        return []
      }
      return entries
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => entry.slice(0, -'.json'.length))
        .filter(isWorkflowId)
        .sort()
    },

    read(id: string): WorkflowRead {
      if (!isWorkflowId(id)) return { ok: false, reason: 'missing' }
      let text: string
      try {
        text = readFileSync(pathOf(id), 'utf8')
      } catch {
        return { ok: false, reason: 'missing' }
      }
      try {
        return { ok: true, value: JSON.parse(text) }
      } catch {
        return { ok: false, reason: 'unreadable' }
      }
    },

    write(id: string, workflow: unknown): void {
      if (!isWorkflowId(id)) throw new Error('workflow id is not writable')
      mkdirSync(dir, { recursive: true })
      const target = pathOf(id)
      const temporary = `${target}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify(workflow, null, 2)}\n`, 'utf8')
      renameSync(temporary, target)
    },
  }

  function pathOf(id: string): string {
    return join(dir, `${id}.json`)
  }
}
