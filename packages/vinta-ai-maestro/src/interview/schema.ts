/**
 * Builds `schemas/interview-round.v1.schema.json` and
 * `schemas/interview-answers.v1.schema.json` from the zod schemas in
 * `document.ts`. Pure — no IO, so the drift check in `tests/interview.test.ts`
 * and the generator CLI can both import it.
 *
 * Same arrangement as `src/review/schema.ts`: each document's shape has one
 * source of truth, and the committed JSON Schema is byte-compared against it
 * in the test suite. Regenerate with
 *
 *   node --experimental-strip-types src/interview/generate.ts
 */
import { z } from 'zod'
import {
  INTERVIEW_ANSWERS_SCHEMA_URL,
  INTERVIEW_ROUND_SCHEMA_URL,
  InterviewAnswersSchema,
  InterviewRoundSchema,
} from './document.ts'

const GENERATED =
  'GENERATED from packages/vinta-ai-maestro/src/interview/document.ts — edit there, not here. ' +
  'See schemas/README.md for versioning rules.'

function build(
  schema: z.ZodType,
  id: string,
  title: string,
  about: string,
): Record<string, unknown> {
  // The schemas `document.ts` gave an id (`.meta({ id })`) land in `$defs`
  // under that name and are referenced from where they are used, so the JSON
  // reads like the hand-written file it replaced: one `explainer`, one
  // `option`, one `decision`, rather than the union repeated inline.
  const generated = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' })
  const { $schema: _schema, description, ...body } = generated as Record<string, unknown>
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: id,
    title,
    description: `${String(description)} ${about} ${GENERATED}`,
    ...body,
  }
}

export function buildInterviewRoundSchema(): Record<string, unknown> {
  return build(
    InterviewRoundSchema,
    INTERVIEW_ROUND_SCHEMA_URL,
    'interview round (v1)',
    'Lives at `<interview-dir>/rounds/round-NN.json`, where `<interview-dir>` is `.vinta-ai-workflows/interviews/<slug>/` in a target project (gitignored). Written by the agent running the interview; served to the browser by `vinta-ai-maestro interview`.',
  )
}

export function buildInterviewAnswersSchema(): Record<string, unknown> {
  return build(
    InterviewAnswersSchema,
    INTERVIEW_ANSWERS_SCHEMA_URL,
    'interview answers (v1)',
    'Lives at `<interview-dir>/answers/round-NN.json`, beside the round it answers. Written by `vinta-ai-maestro interview` when the page submits; read by the agent once `vinta-ai-maestro interview wait` returns.',
  )
}

/** The exact bytes the committed schema files must contain. */
export function serializeInterviewRoundSchema(): string {
  return `${JSON.stringify(buildInterviewRoundSchema(), null, 2)}\n`
}

export function serializeInterviewAnswersSchema(): string {
  return `${JSON.stringify(buildInterviewAnswersSchema(), null, 2)}\n`
}
