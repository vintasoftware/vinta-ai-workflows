/**
 * Writes `schemas/plan-review.v1.schema.json` at the repo root from the zod
 * schema in `document.ts`.
 *
 *   node --experimental-strip-types src/review/generate.ts            write it
 *   node --experimental-strip-types src/review/generate.ts --check    fail if it drifted
 *
 * The schema lives at the repo root because the document it describes is read
 * by an agent running `plan-feature`, a shipped skill, and `schemas/` is where
 * this repo documents skill-facing payloads.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serializePlanReviewSchema } from './schema.ts'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const OUT = join(REPO_ROOT, 'schemas', 'plan-review.v1.schema.json')

const serialized = serializePlanReviewSchema()

if (process.argv.includes('--check')) {
  let committed: string | null = null
  try {
    committed = readFileSync(OUT, 'utf8')
  } catch {
    console.error(`missing ${OUT} — run \`node --experimental-strip-types src/review/generate.ts\``)
    process.exit(1)
  }
  if (committed !== serialized) {
    console.error(`${OUT} is out of date with src/review/document.ts — regenerate it`)
    process.exit(1)
  }
  console.log('schema up to date')
} else {
  writeFileSync(OUT, serialized)
  console.log(`wrote ${OUT}`)
}
