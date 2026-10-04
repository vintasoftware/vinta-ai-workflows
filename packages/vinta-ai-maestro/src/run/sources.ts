/**
 * Where a run's definition came from: `runs/<id>/sources.json`.
 *
 * The frozen `workflow.json` beside it is the *resolved* document, and a
 * resolved document cannot be re-resolved — once the project's gate command
 * has been folded into a gate there is no telling it from one the plan wrote.
 * A config reload (`src/config/reload.ts`) needs the layers themselves, so the
 * run keeps them: the plan file's own JSON, the project configuration it was
 * laid over, the plan branch being watched, and the last commit of it that was
 * applied.
 *
 * A file rather than an event because it is replaced as the run moves on and
 * read only by this run's own process — on start, and again on a resume, which
 * is why it cannot live in memory alone.
 *
 * It holds repository content verbatim, as `workflow.json` already does, and
 * sits under the same store `.gitignore` is told to exclude.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { ProjectConfig } from '../config/project-config.ts'
import type { Journal } from '../journal/journal.ts'

export interface RunSources {
  /** Repo-relative, `/`-separated. Null when the file lives outside the repository. */
  readonly workflow_path: string | null
  /** The branch whose commits are applied to the run. */
  readonly plan_branch: string
  /** The last commit of it the run's definition reflects. */
  readonly head: string
  /** The workflow file's own JSON, as of `head` (or the run's start). */
  readonly authored: unknown
  /** `.vinta-ai-workflows.yaml` as of `head`, or null where there is none. */
  readonly config: ProjectConfig | null
}

/** What a caller hands `startRun` for a fresh run. The branch is `startRun`'s. */
export interface RunSourcesInput {
  /** The workflow file as the operator named it, absolute or relative to the cwd. */
  readonly path: string
  readonly authored: unknown
  readonly config: ProjectConfig | null
}

const FILE = 'sources.json'

export function repoRelative(repoPath: string, path: string): string | null {
  const inside = relative(repoPath, resolve(path))
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return null
  return inside.split(sep).join('/')
}

export function writeSources(journal: Journal, runId: string, sources: RunSources): void {
  const dir = join(journal.root, 'runs', runId)
  mkdirSync(dir, { recursive: true })
  const target = join(dir, FILE)
  const temporary = `${target}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(sources, null, 2)}\n`, 'utf8')
  renameSync(temporary, target)
}

/** Null for a run started before sources were kept, or by a host that keeps none. */
export function readSources(journal: Journal, runId: string): RunSources | null {
  try {
    const raw = JSON.parse(readFileSync(join(journal.root, 'runs', runId, FILE), 'utf8')) as RunSources
    return typeof raw.plan_branch === 'string' && typeof raw.head === 'string' ? raw : null
  } catch {
    return null
  }
}
