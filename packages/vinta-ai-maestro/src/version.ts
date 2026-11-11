/**
 * Which `vinta-ai-maestro` this process is, and which one is installed now.
 *
 * Two readings of the same `package.json`, a process lifetime apart. A `ui`
 * left up for days kept serving the code it loaded at boot after the package
 * under it was upgraded, and nothing said so: the app, the API and the job
 * launcher all quietly ran the old release beside jobs started from the new
 * one. `RUNNING_VERSION` is fixed at module load; `installedVersion()` reads
 * the file again, so a long-lived process can notice it has been replaced.
 *
 * The same relative path from `src/version.ts` and `dist/version.js`, so the
 * source and the build both read the package's own manifest.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const MANIFEST = fileURLToPath(new URL('../package.json', import.meta.url))

/** The version in the package's manifest as it is on disk now, or null when it cannot be read. */
export function installedVersion(path: string = MANIFEST): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

/** The version this process loaded. */
export const RUNNING_VERSION: string = installedVersion() ?? 'unknown'
