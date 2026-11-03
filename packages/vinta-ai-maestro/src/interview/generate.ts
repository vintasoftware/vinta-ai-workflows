/**
 * Writes `schemas/interview-round.v1.schema.json` and
 * `schemas/interview-answers.v1.schema.json` at the repo root from the zod
 * schemas in `document.ts`.
 *
 *   node --experimental-strip-types src/interview/generate.ts            write them
 *   node --experimental-strip-types src/interview/generate.ts --check    fail if either drifted
 *
 * They live at the repo root because the documents they describe are read
 * and written by an agent running a shipped skill (`interview-ui`), and
 * `schemas/` is where this repo documents skill-facing payloads.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serializeInterviewAnswersSchema, serializeInterviewRoundSchema } from './schema.ts'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const SCHEMAS = join(REPO_ROOT, 'schemas')

const FILES: readonly (readonly [string, string])[] = [
  ['interview-round.v1.schema.json', serializeInterviewRoundSchema()],
  ['interview-answers.v1.schema.json', serializeInterviewAnswersSchema()],
]

if (process.argv.includes('--check')) {
  let stale = false
  for (const [name, serialized] of FILES) {
    const out = join(SCHEMAS, name)
    let committed: string | null = null
    try {
      committed = readFileSync(out, 'utf8')
    } catch {
      console.error(`missing ${out} — run \`node --experimental-strip-types src/interview/generate.ts\``)
      stale = true
      continue
    }
    if (committed !== serialized) {
      console.error(`${out} is out of date with src/interview/document.ts — regenerate it`)
      stale = true
    }
  }
  if (stale) process.exit(1)
  console.log('schemas up to date')
} else {
  for (const [name, serialized] of FILES) {
    const out = join(SCHEMAS, name)
    writeFileSync(out, serialized)
    console.log(`wrote ${out}`)
  }
}
