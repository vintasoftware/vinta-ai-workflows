/**
 * Where a running `ui` says which release it is serving.
 *
 * `.vinta-ai-maestro/ui/<pid>.json`, one per `ui` process — two may serve one
 * project on two ports — holding the pid, the version it loaded and when it
 * started. No URL and no token: this file exists so other commands can tell
 * the operator a `ui` is stale, and that needs nothing that grants access.
 *
 * `run` and `status` read it and warn when a live `ui` loaded a different
 * version than the one they are; the `ui` itself rereads its own manifest
 * (`installedVersion`) and warns when the package under it was replaced.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

import { isAlive } from '../job/job.ts'
import { RUNNING_VERSION } from '../version.ts'
import type { Io } from './io.ts'
import { storeFor } from './paths.ts'

const UiRecordSchema = z.object({
  pid: z.number().int().positive(),
  version: z.string(),
  startedAt: z.number(),
})

export type UiRecord = z.infer<typeof UiRecordSchema>

const uiDirFor = (repoPath: string): string => join(storeFor(repoPath), 'ui')

export function writeUiRecord(repoPath: string, record: UiRecord): void {
  const dir = uiDirFor(repoPath)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${record.pid}.json`)
  const temp = `${path}.tmp`
  writeFileSync(temp, `${JSON.stringify(record)}\n`)
  renameSync(temp, path)
}

export function removeUiRecord(repoPath: string, pid: number): void {
  rmSync(join(uiDirFor(repoPath), `${pid}.json`), { force: true })
}

/** Every `ui` serving this project whose process is alive. A dead one's record is dropped. */
export function liveUis(repoPath: string, alive: (pid: number) => boolean = isAlive): UiRecord[] {
  let names: string[]
  try {
    names = readdirSync(uiDirFor(repoPath)).filter((name) => /^\d+\.json$/.test(name))
  } catch {
    return []
  }
  const live: UiRecord[] = []
  for (const name of names) {
    let record: UiRecord | null = null
    try {
      const parsed = UiRecordSchema.safeParse(JSON.parse(readFileSync(join(uiDirFor(repoPath), name), 'utf8')))
      record = parsed.success ? parsed.data : null
    } catch {
      record = null
    }
    if (record !== null && alive(record.pid)) live.push(record)
    else rmSync(join(uiDirFor(repoPath), name), { force: true })
  }
  return live
}

/** One line per live `ui` serving a release other than `version`. On stderr; never fails the command. */
export function warnStaleUis(
  repoPath: string,
  io: Io,
  version: string = RUNNING_VERSION,
  alive?: (pid: number) => boolean,
): void {
  for (const ui of liveUis(repoPath, alive)) {
    if (ui.version === version) continue
    io.err(
      `vinta-ai-maestro: the ui running as pid ${ui.pid} is serving ${ui.version}, but this is ${version}. ` +
        'Restart it (stop it, then run `vinta-ai-maestro ui` again) to serve this version.',
    )
  }
}
