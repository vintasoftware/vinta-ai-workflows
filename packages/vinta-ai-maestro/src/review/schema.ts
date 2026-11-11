/**
 * Builds `schemas/plan-review.v1.schema.json` from the zod schema in
 * `document.ts`. Pure — no IO, so the drift check in `tests/review.test.ts`
 * and the generator CLI can both import it.
 *
 * Same arrangement as `src/postmortem/schema.ts`: the document's shape has one
 * source of truth, and the committed JSON Schema is byte-compared against it
 * in the test suite. Regenerate with
 *
 *   node --experimental-strip-types src/review/generate.ts
 */
import { z } from 'zod'
import { PLAN_REVIEW_SCHEMA_URL, PlanReviewSchema } from './document.ts'

export function buildPlanReviewSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(PlanReviewSchema, { target: 'draft-2020-12', io: 'input' })
  const { $schema: _schema, description, ...body } = generated as Record<string, unknown>
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: PLAN_REVIEW_SCHEMA_URL,
    title: 'vinta-ai-maestro plan review',
    description:
      `${String(description)} Lives at \`ai-plans/<workflow-id>.review.json\` in a target project, ` +
      'beside the plan and its `.workflow.json`, and is committed with them. Written by the ' +
      '`vinta-ai-maestro` review page and by `vinta-ai-maestro review reply`; read by the agent ' +
      'running `plan-feature` through `vinta-ai-maestro review wait`. GENERATED from ' +
      'packages/vinta-ai-maestro/src/review/document.ts — edit there, not here. See ' +
      'schemas/README.md for versioning rules.',
    ...body,
  }
}

/** The exact bytes the committed schema file must contain. */
export function serializePlanReviewSchema(): string {
  return `${JSON.stringify(buildPlanReviewSchema(), null, 2)}\n`
}
