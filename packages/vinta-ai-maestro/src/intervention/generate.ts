/**
 * Writes `schemas/intervention.v1.schema.json` at the repo root from the zod
 * schema in `intervention.ts`.
 *
 *   node --experimental-strip-types src/intervention/generate.ts            write it
 *   node --experimental-strip-types src/intervention/generate.ts --check    fail if it drifted
 *
 * `tests/intervention.test.ts` runs the same comparison, so a forgotten
 * regeneration fails the suite rather than reaching a consumer. The schema
 * lives at the repo root because `schemas/` is where this repo documents every
 * payload its skills and its daemon exchange.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serializeInterventionSchema } from './schema.ts'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const OUT = join(REPO_ROOT, 'schemas', 'intervention.v1.schema.json')

const serialized = serializeInterventionSchema()

if (process.argv.includes('--check')) {
  let committed: string | null = null
  try {
    committed = readFileSync(OUT, 'utf8')
  } catch {
    console.error(
      `missing ${OUT} — run \`node --experimental-strip-types src/intervention/generate.ts\``,
    )
    process.exit(1)
  }
  if (committed !== serialized) {
    console.error(`${OUT} is out of date with src/intervention/intervention.ts — regenerate it`)
    process.exit(1)
  }
  console.log('schema up to date')
} else {
  writeFileSync(OUT, serialized)
  console.log(`wrote ${OUT}`)
}
