/**
 * Writes `schemas/postmortem.v1.schema.json` at the repo root from the zod
 * schema in `postmortem.ts`.
 *
 *   node --experimental-strip-types src/postmortem/generate.ts            write it
 *   node --experimental-strip-types src/postmortem/generate.ts --check    fail if it drifted
 *
 * `tests/postmortem.test.ts` runs the same comparison, so a forgotten
 * regeneration fails the suite rather than reaching a consumer. The schema
 * lives at the repo root, not in this package, because the artifact it
 * describes is read by `plan-feature` — a shipped skill — and `schemas/` is
 * where this repo documents skill-facing payloads.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serializePostMortemSchema } from './schema.ts'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const OUT = join(REPO_ROOT, 'schemas', 'postmortem.v1.schema.json')

const serialized = serializePostMortemSchema()

if (process.argv.includes('--check')) {
  let committed: string | null = null
  try {
    committed = readFileSync(OUT, 'utf8')
  } catch {
    console.error(`missing ${OUT} — run \`node --experimental-strip-types src/postmortem/generate.ts\``)
    process.exit(1)
  }
  if (committed !== serialized) {
    console.error(`${OUT} is out of date with src/postmortem/postmortem.ts — regenerate it`)
    process.exit(1)
  }
  console.log('schema up to date')
} else {
  writeFileSync(OUT, serialized)
  console.log(`wrote ${OUT}`)
}
