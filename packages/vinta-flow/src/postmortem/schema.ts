/**
 * Builds `schemas/postmortem.v1.schema.json` from the zod schema in
 * `postmortem.ts`. Pure — no IO, so the drift check in
 * `tests/postmortem.test.ts` and any generator CLI can both import it.
 *
 * Same arrangement as `src/schema/build.ts`, and for the same reason: the
 * artifact's shape has exactly one source of truth, and a hand-edited JSON
 * Schema is a second one that silently stops matching. Regenerate with
 *
 *   node --experimental-strip-types src/postmortem/generate.ts
 *
 * The committed file is byte-compared in the test suite, so drift fails there
 * rather than in a consumer.
 */
import { z } from 'zod'
import { POSTMORTEM_SCHEMA_URL, PostMortemSchema } from './postmortem.ts'

export function buildPostMortemSchema(): Record<string, unknown> {
  // `io: 'input'` for consistency with the workflow schema: this validates
  // documents as they are written and read, not a parsed result.
  const generated = z.toJSONSchema(PostMortemSchema, { target: 'draft-2020-12', io: 'input' })
  const { $schema: _schema, description, ...body } = generated as Record<string, unknown>
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: POSTMORTEM_SCHEMA_URL,
    title: 'vinta-flow plan post-mortem',
    description:
      `${String(description)} Lives at \`.vinta-flow/runs/<run-id>/postmortem.json\` in a ` +
      'target project, emitted by `vinta-flow` after a run ends and read by `plan-feature` ' +
      'when planning the next feature in the same repo. GENERATED from ' +
      'packages/vinta-flow/src/postmortem/postmortem.ts — edit there, not here. See ' +
      'schemas/README.md for versioning rules.',
    ...body,
  }
}

/** The exact bytes the committed schema file must contain. */
export function serializePostMortemSchema(): string {
  return `${JSON.stringify(buildPostMortemSchema(), null, 2)}\n`
}

