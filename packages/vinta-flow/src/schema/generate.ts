/**
 * Writes `schemas/workflow.v1.schema.json` at the repo root from the zod schemas
 * in `src/types.ts`.
 *
 *   pnpm --filter vinta-flow schema:gen      write it
 *   pnpm --filter vinta-flow schema:check    fail if the committed file drifted
 *
 * The schema lives at the repo root, not in this package, because `plan-feature`
 * — a shipped skill — produces the documents it describes, and schemas/ is where
 * this repo documents skill-produced payloads.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serializeSchema } from './build.ts'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const OUT = join(REPO_ROOT, 'schemas', 'workflow.v1.schema.json')

const serialized = serializeSchema()

if (process.argv.includes('--check')) {
  let committed: string | null = null
  try {
    committed = readFileSync(OUT, 'utf8')
  } catch {
    console.error(`missing ${OUT} — run \`pnpm --filter vinta-flow schema:gen\``)
    process.exit(1)
  }
  if (committed !== serialized) {
    console.error(
      `${OUT} is out of date with src/types.ts — run \`pnpm --filter vinta-flow schema:gen\``,
    )
    process.exit(1)
  }
  console.log('schema up to date')
} else {
  writeFileSync(OUT, serialized)
  console.log(`wrote ${OUT}`)
}
