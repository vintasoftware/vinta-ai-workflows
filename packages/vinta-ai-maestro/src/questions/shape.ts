/**
 * The shape of an agent's question and of the operator's answer to it, with
 * no parsing attached — so the daemon's wire schemas, and the browser through
 * them, can use it without pulling in the YAML reader `agent-questions.ts`
 * needs. See that file for what the shapes mean.
 */
import { z } from 'zod'

/** Generous next to what agents are told, because truncating a question changes it. */
export const MAX_QUESTIONS = 8
export const MAX_OPTIONS = 8
/** What the operator may type per question. The UI enforces the same bound. */
export const ANSWER_TEXT_LIMIT = 4_000

export const AgentQuestionOptionSchema = z.strictObject({
  label: z.string(),
  description: z.string().optional(),
})

export const AgentQuestionSchema = z.strictObject({
  /** A short chip label. */
  header: z.string(),
  question: z.string(),
  multiSelect: z.boolean(),
  /** May be empty: a question with no options is answered in free text. */
  options: z.array(AgentQuestionOptionSchema).max(MAX_OPTIONS),
})

/** Where a question came from: the `NEEDS_INPUT` report, or a question tool call. */
export const AgentQuestionSourceSchema = z.enum(['report', 'tool'])

export const AgentAskSchema = z.strictObject({
  source: AgentQuestionSourceSchema,
  /** The tool's name, for a `tool` ask. */
  tool: z.string().optional(),
  /** The report's one-line `blocked_on`, when it gave one. */
  blockedOn: z.string().optional(),
  /** The report's one-line `done_so_far`, when it gave one. */
  doneSoFar: z.string().optional(),
  questions: z.array(AgentQuestionSchema).min(1).max(MAX_QUESTIONS),
})

/**
 * One question's answer: the indices of the options picked, plus whatever the
 * operator typed. Indices rather than labels, so the journal row that carries
 * the answer holds identifiers and the human's own words, never the agent's.
 */
export const AgentAnswerSchema = z.strictObject({
  selected: z.array(z.number().int().min(0).max(MAX_OPTIONS - 1)).max(MAX_OPTIONS),
  text: z.string().max(ANSWER_TEXT_LIMIT).optional(),
})

export const AgentAnswersSchema = z.array(AgentAnswerSchema).min(1).max(MAX_QUESTIONS)

export type AgentQuestionOption = z.infer<typeof AgentQuestionOptionSchema>
export type AgentQuestion = z.infer<typeof AgentQuestionSchema>
export type AgentQuestionSource = z.infer<typeof AgentQuestionSourceSchema>
export type AgentAsk = z.infer<typeof AgentAskSchema>
export type AgentAnswer = z.infer<typeof AgentAnswerSchema>
