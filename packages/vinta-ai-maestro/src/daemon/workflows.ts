/**
 * The workflow files the editor (§10's Editor row) reads and writes.
 *
 * **These are source, not run state.** A workflow is authored by `plan-feature`
 * beside its markdown plan, reviewed by a human, and committed — it is the
 * document a run is started *from*, and the same file `vinta-ai-maestro run` is
 * pointed at. `.vinta-ai-maestro/` is the opposite category: journal, transcripts,
 * gate logs and each run's *frozen* `workflow.json` (§5.3, §11), gitignored and
 * purgeable. So the editor edits the repository's `ai-plans/`, which is where
 * `plan-feature` writes and where a reviewer looks, and nothing here ever
 * touches a run's snapshot.
 *
 * Four rules, all of them enforced below rather than documented:
 *
 * - **The filename is `<id>.workflow.json`, and the id is the schema's.** That
 *   is the name `plan-feature` emits (`BOOKMARK_FOLDERS` →
 *   `ai-plans/bookmark-folders.workflow.json`), and the suffix is what keeps
 *   the markdown plan's other JSON siblings — `<feature>.postmortem.json` —
 *   from being offered as workflows. Ids match the workflow schema's own
 *   kebab-case rule, which contains no `/`, no `.` and no `..`, so a request
 *   cannot name a path outside the directory. Validating the id is the whole of
 *   the traversal defence; there is no second sanitiser to disagree with it.
 * - **Writes are atomic.** A workflow is written to a temporary file in the
 *   same directory and renamed over the target, so a crash mid-write leaves the
 *   previous document intact rather than a truncated one. `rename` within a
 *   directory is atomic on both platforms this package targets.
 * - **A failed write leaves nothing behind.** The temporary file is removed if
 *   the rename never happens. This directory is committed and read by people; a
 *   stray `…workflow.json.4711.tmp` in a reviewed diff is litter that
 *   `.vinta-ai-maestro/` could absorb and `ai-plans/` cannot.
 * - **Nothing here logs.** A workflow carries plan prose and repository paths
 *   (§11); a read that fails answers with a reason code, never with the bytes
 *   it could not parse or the path it could not open.
 */
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/** The workflow schema's own id rule. Kebab-case, so never a path segment. */
const WORKFLOW_ID = /^[a-z0-9][a-z0-9-]*$/

/**
 * Where workflows live when the daemon is not told otherwise: the project's
 * plan directory, committed, beside the markdown plan each one was derived
 * from. Not under `.vinta-ai-maestro/` — see the note above.
 */
export const PLANS_DIRNAME = 'ai-plans'

/** `plan-feature`'s filename convention, and the only one this store reads. */
export const WORKFLOW_SUFFIX = '.workflow.json'

/** The plan directory of a project checkout. */
export function plansDirFor(projectDir: string): string {
  return join(projectDir, PLANS_DIRNAME)
}

export type WorkflowRead =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: 'missing' | 'unreadable' }

export interface WorkflowStore {
  readonly dir: string
  /** Every `<id>.workflow.json` whose stem is a legal workflow id, sorted. */
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
        .filter((entry) => entry.endsWith(WORKFLOW_SUFFIX))
        .map((entry) => entry.slice(0, -WORKFLOW_SUFFIX.length))
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
      try {
        writeFileSync(temporary, `${JSON.stringify(workflow, null, 2)}\n`, 'utf8')
        renameSync(temporary, target)
      } catch (error) {
        rmSync(temporary, { force: true })
        throw error
      }
    },
  }

  function pathOf(id: string): string {
    return join(dir, `${id}${WORKFLOW_SUFFIX}`)
  }
}
