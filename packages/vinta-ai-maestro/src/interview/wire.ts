/**
 * What the interview server says over HTTP, beyond the two documents.
 *
 * Pure zod, no `node:*` imports: the interview page bundles this file, the
 * way the run UI bundles `daemon/schemas.ts`, so a response that stops
 * matching fails in the browser's client rather than rendering as a blank
 * screen.
 */
import { z } from 'zod'

/** One round as the page lists it: enough to pick it, not the round itself. */
export const RoundSummarySchema = z.strictObject({
  round: z.int().min(1),
  title: z.string().nullable(),
  kind: z.enum(['questions', 'readback']).nullable(),
  answered: z.boolean(),
  /**
   * Why the round cannot be shown. Identifiers only — the file's own text
   * never travels — so a broken round says *that* it is broken and where.
   */
  error: z.enum(['invalid_json', 'invalid_round']).nullable(),
})

export const InterviewStateSchema = z.strictObject({
  rounds: z.array(RoundSummarySchema),
  /** The highest round number on disk, or null before the first round. */
  latest: z.int().min(1).nullable(),
  /** The lowest round that is readable and not yet answered, or null. */
  current: z.int().min(1).nullable(),
})

export type RoundSummary = z.infer<typeof RoundSummarySchema>
export type InterviewState = z.infer<typeof InterviewStateSchema>

export const SubmittedResponseSchema = z.strictObject({
  ok: z.literal(true),
  /** Where the answers were written, for the agent reading the server's log. */
  path: z.string(),
})

/** A refusal, by code. Never the text that was refused. */
export const InterviewErrorSchema = z.strictObject({
  error: z.string(),
  issues: z
    .array(z.strictObject({ path: z.string(), message: z.string() }))
    .nullable()
    .optional(),
})

export type InterviewError = z.infer<typeof InterviewErrorSchema>
