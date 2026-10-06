/**
 * Builds `schemas/intervention.v1.schema.json` from the zod schema in
 * `intervention.ts`. Pure — no IO, so the drift check in
 * `tests/intervention.test.ts` and the generator CLI can both import it.
 *
 * Same arrangement as `src/postmortem/schema.ts`, and for the same reason: the
 * artifact has exactly one source of truth, and a hand-edited JSON Schema is a
 * second one that silently stops matching. Regenerate with
 *
 *   node --experimental-strip-types src/intervention/generate.ts
 *
 * The committed file is byte-compared in the test suite, so drift fails there
 * rather than in a consumer.
 */
import { z } from 'zod'
import { INTERVENTION_SCHEMA_URL, InterventionSchema } from './intervention.ts'

export function buildInterventionSchema(): Record<string, unknown> {
  // `io: 'input'` for the same reason the other two use it: this validates a
  // document as it is written and read, not a parsed result.
  const generated = z.toJSONSchema(InterventionSchema, { target: 'draft-2020-12', io: 'input' })
  const { $schema: _schema, description, ...body } = generated as Record<string, unknown>
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: INTERVENTION_SCHEMA_URL,
    title: 'vinta-ai-maestro monitor intervention',
    description:
      `${String(description)} Written by the run monitor when a watchdog wakes it about a ` +
      'phase that has outrun its threshold, and applied by `vinta-ai-maestro` through §9’s ' +
      'amend path. GENERATED from ' +
      'packages/vinta-ai-maestro/src/intervention/intervention.ts — edit there, not here. ' +
      'See schemas/README.md for versioning rules.',
    ...body,
  }
}

/** The exact bytes the committed schema file must contain. */
export function serializeInterventionSchema(): string {
  return `${JSON.stringify(buildInterventionSchema(), null, 2)}\n`
}
