/**
 * Questions an *agent* raises, as opposed to the ones a pipeline asks (§9.1).
 *
 * An agent that needs a decision it should not make alone has two ways to say
 * so, and the scheduler listens for both:
 *
 * - **A `NEEDS_INPUT` report.** The protocol every shipped skill and every
 *   prompt in `src/prompts` teaches: stop at a clean point and end the turn
 *   with a YAML block — `status: NEEDS_INPUT`, `questions:` with a header, the
 *   question and two to four options each. This is the one that works on every
 *   harness, because it is only text.
 * - **The harness's own question tool**, when the agent reaches for it anyway:
 *   claude-code's `AskUserQuestion`, opencode's `question`, Codex's
 *   `request_user_input`. Headless, none of them can reach a person, so a call
 *   that was the agent's last act is read as the same thing a report is.
 *
 * Both become one `AgentAsk`. It is agent prose about a repository, so it is
 * written to the transcript and never to the journal (§11): the pause that
 * waits on it journals a fixed sentence and an effect id, and the API reads
 * the questions back out of the transcript when it renders the card.
 *
 * Nothing here knows about the scheduler. It is parsing, a small state machine
 * over `AgentEvent`s, and the two directions an answer travels in — encoded
 * for the journal as option indices, formatted for the agent as prose.
 */
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import type { AgentEvent } from '../harness/adapter.ts'
import {
  type AgentAnswer,
  AgentAnswersSchema,
  type AgentAsk,
  type AgentQuestion,
  MAX_OPTIONS,
  MAX_QUESTIONS,
} from './shape.ts'

export * from './shape.ts'

/** The tool names that mean "ask the human", across the three harnesses. */
export const QUESTION_TOOLS: ReadonlySet<string> = new Set([
  'AskUserQuestion',
  'question',
  'request_user_input',
])

/** The sentence the journal's `human_question` row carries for an agent ask. Fixed: §11. */
export const AGENT_QUESTION_TEXT = 'The agent stopped to ask for a decision.'

const HEADER_LIMIT = 40
const QUESTION_LIMIT = 4_000
const LABEL_LIMIT = 300
const DESCRIPTION_LIMIT = 2_000
const NOTE_LIMIT = 500

const RECOMMENDED = /\(recommended\)/i
/** An "Other" option is the free-text field's job; listing one as an option is noise. */
const OTHER = /^\s*other\b/i

// ---------------------------------------------------------------------------
// Normalising what an agent wrote
// ---------------------------------------------------------------------------

const OptionInput = z.union([
  z.string(),
  z.looseObject({
    label: z.string(),
    description: z.string().optional(),
  }),
])

const QuestionInput = z.looseObject({
  header: z.string().optional(),
  question: z.string(),
  multi_select: z.boolean().optional(),
  multiSelect: z.boolean().optional(),
  multiple: z.boolean().optional(),
  options: z.array(OptionInput).optional(),
})

const QuestionsInput = z.array(QuestionInput).min(1)

const clip = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`

function normalise(raw: z.infer<typeof QuestionsInput>): AgentQuestion[] {
  return raw.slice(0, MAX_QUESTIONS).map((question, index) => {
    const options = (question.options ?? [])
      .map((option) =>
        typeof option === 'string'
          ? { label: option.trim() }
          : {
              label: option.label.trim(),
              ...(option.description === undefined || option.description.trim() === ''
                ? {}
                : { description: clip(option.description.trim(), DESCRIPTION_LIMIT) }),
            },
      )
      .filter((option) => option.label !== '' && !OTHER.test(option.label))
      .slice(0, MAX_OPTIONS)
      .map((option) => ({ ...option, label: clip(option.label, LABEL_LIMIT) }))
    const header = question.header?.trim()
    return {
      header: clip(header === undefined || header === '' ? `Question ${index + 1}` : header, HEADER_LIMIT),
      question: clip(question.question.trim(), QUESTION_LIMIT),
      multiSelect: question.multi_select ?? question.multiSelect ?? question.multiple ?? false,
      options,
    }
  })
}

const oneLine = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? clip(value.trim(), NOTE_LIMIT) : undefined

// ---------------------------------------------------------------------------
// The `NEEDS_INPUT` report
// ---------------------------------------------------------------------------

const STATUS_LINE = /^([ \t]*)(?:[-*][ \t]+)?status:[ \t]*["']?NEEDS_INPUT["']?[ \t]*$/im

/**
 * The questions in a `NEEDS_INPUT` block, or null when `text` has none that
 * parse.
 *
 * Agents write the block fenced, unfenced, indented the way the prompt showed
 * it, and followed by a sentence of prose. So the block is found by its status
 * line, dedented to that line's indentation, ended at the first line that
 * leaves it, and — when it still does not parse — shortened from the end one
 * line at a time. A report that only *mentions* the protocol has no
 * `questions:` that validate and reads as no ask at all.
 */
export function parseNeedsInput(text: string): AgentAsk | null {
  const match = STATUS_LINE.exec(text)
  if (match === null) return null
  const indent = match[1]?.length ?? 0
  const lines = text.slice(match.index).split('\n')

  const block: string[] = []
  for (const [index, line] of lines.entries()) {
    if (index > 0) {
      if (/^\s*```/.test(line)) break
      const lead = line.length - line.trimStart().length
      if (line.trim() !== '' && lead < indent) break
    }
    block.push(line.slice(Math.min(indent, line.length - line.trimStart().length)))
  }
  // The status line may carry a list marker the agent copied from prose.
  block[0] = block[0]?.replace(/^[-*][ \t]+/, '') ?? ''

  for (let end = block.length; end > 0; end -= 1) {
    const ask = askFromYaml(block.slice(0, end).join('\n'))
    if (ask !== null) return ask
  }
  return null
}

function askFromYaml(source: string): AgentAsk | null {
  let doc: unknown
  try {
    doc = parseYaml(source)
  } catch {
    return null
  }
  if (typeof doc !== 'object' || doc === null) return null
  const record = doc as Record<string, unknown>
  const questions = QuestionsInput.safeParse(record['questions'])
  if (!questions.success) return null
  const blockedOn = oneLine(record['blocked_on'])
  const doneSoFar = oneLine(record['done_so_far'])
  return {
    source: 'report',
    ...(blockedOn === undefined ? {} : { blockedOn }),
    ...(doneSoFar === undefined ? {} : { doneSoFar }),
    questions: normalise(questions.data),
  }
}

// ---------------------------------------------------------------------------
// The question tools
// ---------------------------------------------------------------------------

/**
 * The questions in a question tool's input, or null when the input is not the
 * shape any of the three vendors uses. The three agree on `questions: [...]`
 * with a header, the question and labelled options; they differ only in what
 * multi-select is called, which `normalise` reads every spelling of.
 */
export function questionsFromTool(name: string, input: unknown): AgentAsk | null {
  if (!QUESTION_TOOLS.has(name) || typeof input !== 'object' || input === null) return null
  const questions = QuestionsInput.safeParse((input as Record<string, unknown>)['questions'])
  if (!questions.success) return null
  return { source: 'tool', tool: name, questions: normalise(questions.data) }
}

// ---------------------------------------------------------------------------
// Watching a turn
// ---------------------------------------------------------------------------

/**
 * Reads one agent turn as it is drained, and says at the end whether the
 * agent stopped to ask.
 *
 * - The **report** is the agent's last stretch of prose: every `assistant_text`
 *   since its last tool call, concatenated, because opencode streams a part as
 *   deltas and a block split across them would otherwise never parse.
 * - A **tool** ask counts only while it is still the agent's last act. Any later
 *   tool call means the agent moved on without an answer, and a successful
 *   result means the harness answered it somewhere this daemon cannot see.
 *
 * An interrupted turn never asks: it ended because an operator redirected or
 * took it over, and they are already looking at it.
 */
export class QuestionWatch {
  #prose: string[] = []
  #tool: { readonly id: string; readonly ask: AgentAsk } | null = null
  #interrupted = false

  observe(event: AgentEvent): void {
    switch (event.type) {
      case 'assistant_text':
        this.#prose.push(event.text)
        return
      case 'tool_use': {
        this.#prose = []
        const ask = questionsFromTool(event.name, event.input)
        this.#tool = ask === null ? null : { id: event.id, ask }
        return
      }
      case 'tool_result':
        if (this.#tool !== null && this.#tool.id === event.id && event.ok) this.#tool = null
        return
      case 'session_ended':
        if (event.result === 'interrupted') this.#interrupted = true
        return
      default:
        return
    }
  }

  result(): AgentAsk | null {
    if (this.#interrupted) return null
    const last = this.#prose.at(-1)
    const report =
      parseNeedsInput(this.#prose.join('')) ?? (last === undefined ? null : parseNeedsInput(last))
    return report ?? this.#tool?.ask ?? null
  }
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/** The answer as the journal and the guard context carry it: a JSON string. */
export function encodeAnswers(answers: readonly AgentAnswer[]): string {
  return JSON.stringify(answers)
}

/**
 * The answers in a journalled or guard-context value, fitted to `ask`.
 *
 * Free text on a single-choice question is its **Other** answer, so it
 * replaces any option sent with it: the agent gets one answer, not an option
 * and a sentence that may contradict it. On a multi-choice question the text
 * goes along with the options.
 *
 * Lenient on purpose: a value that does not decode — a pipeline-style answer
 * typed by hand through the API, say — is kept as free text on the first
 * question rather than dropped, since dropping it would resume the agent with
 * nothing and lose what the operator said.
 */
export function decodeAnswers(value: unknown, ask: AgentAsk): AgentAnswer[] {
  let parsed: AgentAnswer[] | null = null
  if (typeof value === 'string') {
    try {
      const result = AgentAnswersSchema.safeParse(JSON.parse(value))
      if (result.success) {
        parsed = result.data.map((answer) =>
          answer.text === undefined ? { selected: answer.selected } : { selected: answer.selected, text: answer.text },
        )
      }
    } catch {
      parsed = null
    }
  }
  if (parsed === null) {
    const text = value === null || value === undefined ? '' : String(value)
    parsed = text === '' ? [] : [{ selected: [], text }]
  }
  return ask.questions.map((question, index) => {
    const answer = parsed[index]
    if (answer === undefined) return { selected: [] }
    const valid = [...new Set(answer.selected)].filter((choice) => choice < question.options.length)
    const text = answer.text?.trim()
    if (text === undefined || text === '') return { selected: question.multiSelect ? valid : valid.slice(0, 1) }
    return { selected: question.multiSelect ? valid : [], text }
  })
}

/**
 * What an unattended run answers with: each question's recommended option,
 * else its first. A question with no options gets a note telling the agent
 * nobody is there, so it decides and says so rather than asking again.
 */
export function recommendedAnswers(ask: AgentAsk): AgentAnswer[] {
  return ask.questions.map((question) => {
    if (question.options.length === 0) {
      return { selected: [], text: 'No operator is available. Use your best judgement and say so in your report.' }
    }
    const recommended = question.options.findIndex((option) => RECOMMENDED.test(option.label))
    return { selected: [recommended === -1 ? 0 : recommended] }
  })
}

/** Whether every question has a picked option or typed text. */
export function answered(ask: AgentAsk, answers: readonly AgentAnswer[]): boolean {
  return ask.questions.every((_, index) => {
    const answer = answers[index]
    return answer !== undefined && (answer.selected.length > 0 || (answer.text ?? '').trim() !== '')
  })
}

/**
 * The message that resumes the agent: each question restated with the
 * operator's choice and words, so the answer reads without the question in
 * view — the agent has it in context, but a resumed session may have been
 * compacted since.
 */
export function formatAnswers(
  ask: AgentAsk,
  answers: readonly AgentAnswer[],
  options: { readonly unattended?: boolean } = {},
): string {
  const lines = [
    options.unattended === true
      ? 'Nobody answered your questions, so the run answered them itself with the recommended options:'
      : 'The operator answered your questions:',
    '',
  ]
  ask.questions.forEach((question, index) => {
    const answer = answers[index] ?? { selected: [] }
    lines.push(`${index + 1}. ${question.header} — ${question.question}`)
    const picked = answer.selected
      .map((choice) => question.options[choice]?.label)
      .filter((label): label is string => label !== undefined)
    if (picked.length > 0) lines.push(`   Answer: ${picked.join('; ')}`)
    if (answer.text !== undefined) lines.push(`   ${picked.length > 0 ? 'Other' : 'Answer'}: ${answer.text}`)
    if (picked.length === 0 && answer.text === undefined) lines.push('   Answer: (left unanswered)')
  })
  lines.push(
    '',
    'Continue the task from where you stopped, following these answers. If an answer',
    'leaves you blocked again, end your turn with another NEEDS_INPUT block.',
  )
  return lines.join('\n')
}
