/**
 * Builds the JSON Schema document from the zod schemas. Pure — no IO, so tests
 * and the generator CLI can both import it.
 */
import { z } from 'zod'
import { WorkflowSchema } from '../types.ts'

export function buildSchema(): Record<string, unknown> {
  // `io: 'input'` so fields with defaults stay optional — this schema validates
  // documents people and skills write, not the parsed result.
  const generated = z.toJSONSchema(WorkflowSchema, { target: 'draft-2020-12', io: 'input' })

  // Drop zod's own $schema and description: the first is re-set below to the
  // canonical URL, the second is folded into the fuller one the repo convention
  // wants (what the artifact is, where it lives, who writes and reads it).
  const { $schema: _schema, description, ...body } = generated as Record<string, unknown>
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://github.com/vintasoftware/vinta-ai-workflows/schemas/workflow.v1.schema.json',
    title: 'vinta-flow workflow',
    description:
      `${String(description)} Lives at \`ai-plans/<feature-kebab>.workflow.json\` in a target ` +
      'project, emitted by `plan-feature` alongside the human-readable plan and executed by ' +
      '`vinta-flow`. GENERATED from packages/vinta-flow/src/types.ts — edit there, not here. ' +
      'See schemas/README.md for versioning rules.',
    ...body,
  }
}

/** The exact bytes the committed schema file must contain. */
export function serializeSchema(): string {
  return `${JSON.stringify(buildSchema(), null, 2)}\n`
}
