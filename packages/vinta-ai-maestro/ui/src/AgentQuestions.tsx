/**
 * The card an agent's question is answered on (`src/questions`).
 *
 * Built so the common case is a click.
 *
 * - **One question** is the whole card. Its options are buttons — the label,
 *   and under it the consequence the agent wrote — with the one it recommends
 *   marked, and a single-choice question answers the moment an option is
 *   clicked: a "Send" step there is a second click that decides nothing.
 * - **Several questions** are a wizard: one question per step, a row of steps
 *   across the top that says which are answered, and a review step at the end
 *   that shows every answer before anything is sent. Picking an option on a
 *   single-choice step moves on by itself; a multi-choice step, or one answered
 *   in words, moves on with Next. Any step can be revisited from the row or the
 *   review, and nothing is sent until the review's Send.
 *
 * **Other** is always the last choice: an option that holds a text field, for
 * the answer none of the agent's options covers. It is a choice like the rest,
 * so on a single-choice question it is exclusive — typing in it selects it and
 * clears the option that was picked, and picking an option deselects it. What
 * the agent receives is then one answer, never an option with a contradicting
 * sentence beside it. On a multi-choice question it is one more checkbox, and
 * the text goes along with whichever options are ticked. A question with no
 * options is answered in the field alone.
 *
 * The number keys pick an option on the step in view — the key after the last
 * option picks Other and puts the cursor in it — while no text field has focus.
 *
 * The answer goes up as option indices plus text — never the labels — so the
 * journal row it becomes holds the operator's words and identifiers only.
 */
import { useState, type KeyboardEvent } from 'react'
import { HStack } from 'vinta-design-system/layout'
import { Button } from 'vinta-design-system/ui/button'
import { Textarea } from 'vinta-design-system/ui/textarea'
import {
  ANSWER_TEXT_LIMIT,
  type AgentAnswer,
  type AgentAsk,
  type AgentQuestion,
} from '../../src/questions/shape.ts'
import { Chip } from './Chip.tsx'
import { Prose } from './Markdown.tsx'

const RECOMMENDED = /\s*\(recommended\)\s*/i

const plain = (label: string): string => label.replace(RECOMMENDED, ' ').trim()

/** One question's state: the options ticked, whether Other is, and what is typed in it. */
interface Choice {
  readonly picked: readonly number[]
  readonly other: boolean
  readonly text: string
}

const EMPTY: Choice = { picked: [], other: false, text: '' }

/** A question with no options has nothing but Other, so Other is always on. */
const otherOn = (question: AgentQuestion, choice: Choice): boolean =>
  question.options.length === 0 || choice.other

function isAnswered(question: AgentQuestion, choice: Choice): boolean {
  return choice.picked.length > 0 || (otherOn(question, choice) && choice.text.trim() !== '')
}

function toAnswer(question: AgentQuestion, choice: Choice): AgentAnswer {
  const text = otherOn(question, choice) ? choice.text.trim() : ''
  // Single choice: Other replaces the option, it never rides beside one.
  const selected = question.multiSelect || text === '' ? [...choice.picked] : []
  return text === '' ? { selected } : { selected, text }
}

export function AgentQuestions({
  ask,
  busy,
  onSubmit,
}: {
  readonly ask: AgentAsk
  readonly busy: boolean
  readonly onSubmit: (answers: AgentAnswer[]) => void
}) {
  const count = ask.questions.length
  const [choices, setChoices] = useState<readonly Choice[]>(() => ask.questions.map(() => EMPTY))
  // `count` is the review step. A lone question has no steps and no review.
  const [step, setStep] = useState(0)
  const wizard = count > 1

  const choiceAt = (index: number, from: readonly Choice[] = choices): Choice => from[index] ?? EMPTY
  const answeredAt = (index: number, from: readonly Choice[] = choices): boolean => {
    const question = ask.questions[index]
    return question !== undefined && isAnswered(question, choiceAt(index, from))
  }
  const complete = ask.questions.every((_, index) => answeredAt(index))
  const answers = (from: readonly Choice[]): AgentAnswer[] =>
    ask.questions.map((question, index) => toAnswer(question, choiceAt(index, from)))
  /** The next unanswered step after `from`, else the review. */
  const nextStep = (from: number, state: readonly Choice[]): number => {
    for (let index = from + 1; index < count; index += 1) if (!answeredAt(index, state)) return index
    return count
  }
  const update = (index: number, change: (choice: Choice) => Choice): readonly Choice[] => {
    const next = choices.map((choice, at) => (at === index ? change(choice) : choice))
    setChoices(next)
    return next
  }

  const choose = (index: number, option: number) => {
    const multi = ask.questions[index]?.multiSelect ?? false
    // A radio stays picked when clicked again, as a radio does; the way out of
    // a choice is another choice. Picking one deselects Other.
    const next = update(index, (choice) =>
      multi
        ? {
            ...choice,
            picked: choice.picked.includes(option)
              ? choice.picked.filter((value) => value !== option)
              : [...choice.picked, option].sort((a, b) => a - b),
          }
        : { ...choice, picked: [option], other: false },
    )
    if (multi) return
    if (!wizard) onSubmit(answers(next))
    else setStep(nextStep(index, next))
  }

  /** Other ticked or unticked. On a single-choice question it clears the option. */
  const setOther = (index: number, on: boolean) => {
    const multi = ask.questions[index]?.multiSelect ?? false
    update(index, (choice) => ({ ...choice, other: on, picked: on && !multi ? [] : choice.picked }))
  }

  /** Typing is choosing Other. */
  const type = (index: number, text: string) => {
    const multi = ask.questions[index]?.multiSelect ?? false
    update(index, (choice) => ({ text, other: true, picked: multi ? choice.picked : [] }))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (busy || event.target instanceof HTMLTextAreaElement) return
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const index = wizard ? step : 0
    const question = ask.questions[index]
    if (question === undefined || index >= count) return
    const digit = Number.parseInt(event.key, 10)
    if (!Number.isInteger(digit) || digit < 1) return
    if (digit <= question.options.length) {
      event.preventDefault()
      choose(index, digit - 1)
    } else if (digit === question.options.length + 1) {
      event.preventDefault()
      setOther(index, true)
      event.currentTarget
        .querySelector<HTMLTextAreaElement>(`[data-agent-question="${index}"] [data-field="agent-answer"]`)
        ?.focus()
    }
  }

  const questionView = (question: AgentQuestion, index: number) => (
    <QuestionStep
      key={index}
      index={index}
      question={question}
      choice={choiceAt(index)}
      busy={busy}
      // The step row already names the question in a wizard.
      showHeader={!wizard}
      onChoose={(option) => choose(index, option)}
      onOther={(on) => setOther(index, on)}
      onText={(text) => type(index, text)}
    />
  )

  return (
    <div className="agent-questions flex flex-col gap-4" data-agent-questions onKeyDown={onKeyDown}>
      {ask.blockedOn !== undefined && (
        <p className="text-sm text-muted-foreground" data-blocked-on>
          Blocked on: {ask.blockedOn}
        </p>
      )}

      {!wizard && ask.questions[0] !== undefined && (
        <>
          {questionView(ask.questions[0], 0)}
          <HStack gap={2} wrap className="controls">
            <Button
              type="button"
              size="sm"
              data-op="answer"
              disabled={busy || !complete}
              onClick={() => onSubmit(answers(choices))}
            >
              Send answer
            </Button>
          </HStack>
        </>
      )}

      {wizard && (
        <>
          <ol className="flex flex-wrap items-center gap-1.5" aria-label="Questions" data-steps>
            {ask.questions.map((question, index) => (
              <li key={index}>
                <StepButton
                  label={question.header}
                  number={index + 1}
                  current={step === index}
                  done={answeredAt(index)}
                  onClick={() => setStep(index)}
                  data-step={index}
                />
              </li>
            ))}
            <li>
              <StepButton
                label="Review"
                number={null}
                current={step === count}
                done={false}
                disabled={!complete}
                onClick={() => setStep(count)}
                data-step="review"
              />
            </li>
          </ol>

          {step < count && ask.questions[step] !== undefined && (
            <>
              <p className="text-xs text-muted-foreground" data-step-count>
                Question {step + 1} of {count}
              </p>
              {questionView(ask.questions[step], step)}
              <HStack gap={2} wrap className="controls">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-op="back"
                  disabled={busy || step === 0}
                  onClick={() => setStep(step - 1)}
                >
                  Back
                </Button>
                <Button
                  type="button"
                  size="sm"
                  data-op="next"
                  disabled={busy || !answeredAt(step)}
                  onClick={() => setStep(nextStep(step, choices))}
                >
                  {nextStep(step, choices) === count ? 'Review answers' : 'Next'}
                </Button>
              </HStack>
            </>
          )}

          {step === count && (
            <>
              <dl className="flex flex-col gap-3" data-review>
                {ask.questions.map((question, index) => (
                  <div key={index} className="flex flex-col gap-1" data-review-item={index}>
                    <dt className="flex flex-wrap items-center gap-2 text-sm">
                      <Chip tone="attention">{question.header}</Chip>
                      <button
                        type="button"
                        className="text-xs text-muted-foreground underline underline-offset-2"
                        data-op="edit"
                        onClick={() => setStep(index)}
                      >
                        Change
                      </button>
                    </dt>
                    <dd className="text-sm" data-review-answer>
                      {summary(question, toAnswer(question, choiceAt(index)))}
                    </dd>
                  </div>
                ))}
              </dl>
              <HStack gap={2} wrap className="controls">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-op="back"
                  disabled={busy}
                  onClick={() => setStep(count - 1)}
                >
                  Back
                </Button>
                <Button
                  type="button"
                  size="sm"
                  data-op="answer"
                  disabled={busy || !complete}
                  onClick={() => onSubmit(answers(choices))}
                >
                  Send answers
                </Button>
              </HStack>
            </>
          )}
        </>
      )}
    </div>
  )
}

/** What will be sent, as a line: the options' labels, then the Other text. */
function summary(question: AgentQuestion, answer: AgentAnswer): string {
  const parts = answer.selected
    .map((choice) => question.options[choice]?.label)
    .filter((label): label is string => label !== undefined)
    .map(plain)
  if (answer.text !== undefined) parts.push(question.options.length === 0 ? answer.text : `Other: ${answer.text}`)
  return parts.length === 0 ? 'Not answered' : parts.join(', ')
}

function StepButton({
  label,
  number,
  current,
  done,
  disabled = false,
  onClick,
  'data-step': dataStep,
}: {
  readonly label: string
  readonly number: number | null
  readonly current: boolean
  readonly done: boolean
  readonly disabled?: boolean
  readonly onClick: () => void
  readonly 'data-step': number | string
}) {
  return (
    <button
      type="button"
      aria-current={current ? 'step' : undefined}
      data-step={dataStep}
      data-done={done ? 'true' : undefined}
      disabled={disabled}
      onClick={onClick}
      className={
        'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ' +
        'disabled:cursor-not-allowed disabled:opacity-50 ' +
        (current
          ? 'border-tone-attention bg-tone-attention-soft font-medium text-tone-attention-foreground'
          : 'border-border text-muted-foreground hover:border-tone-attention')
      }
    >
      {number !== null && (
        <span
          aria-hidden="true"
          className={
            'grid size-4 place-items-center rounded-full text-[10px] ' +
            (done ? 'bg-tone-attention text-background' : 'border border-current')
          }
        >
          {done ? '✓' : number}
        </span>
      )}
      {label}
      {done && <span className="sr-only"> (answered)</span>}
    </button>
  )
}

/** The radio dot or checkbox square: the selection reads without colour. */
function Mark({ multi, selected }: { readonly multi: boolean; readonly selected: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={
        'mt-0.5 grid size-4 shrink-0 place-items-center border-2 ' +
        (multi ? 'rounded-[4px] ' : 'rounded-full ') +
        (selected ? 'border-tone-attention bg-tone-attention' : 'border-muted-foreground')
      }
    >
      {selected && <span className={'size-1.5 bg-background ' + (multi ? 'rounded-[1px]' : 'rounded-full')} />}
    </span>
  )
}

const choiceClass = (selected: boolean): string =>
  'flex items-start gap-2.5 rounded-md border px-3 py-2 text-left text-sm transition-colors ' +
  'hover:border-tone-attention ' +
  (selected
    ? 'border-tone-attention bg-tone-attention-soft ring-2 ring-tone-attention'
    : 'border-border bg-background')

function QuestionStep({
  index,
  question,
  choice,
  busy,
  showHeader,
  onChoose,
  onOther,
  onText,
}: {
  readonly index: number
  readonly question: AgentQuestion
  readonly choice: Choice
  readonly busy: boolean
  readonly showHeader: boolean
  readonly onChoose: (option: number) => void
  readonly onOther: (on: boolean) => void
  readonly onText: (text: string) => void
}) {
  const multi = question.multiSelect
  const other = otherOn(question, choice)
  const field = (
    <Textarea
      aria-label={question.options.length === 0 ? `Your answer to ${question.header}` : `Other answer to ${question.header}`}
      data-field="agent-answer"
      rows={question.options.length === 0 ? 3 : 1}
      className="min-h-9"
      maxLength={ANSWER_TEXT_LIMIT}
      placeholder={question.options.length === 0 ? 'Type your answer' : 'Type your own answer'}
      value={choice.text}
      disabled={busy}
      onChange={(event) => onText(event.target.value)}
    />
  )

  return (
    <fieldset className="flex flex-col gap-2" data-agent-question={index} aria-label={question.header}>
      <legend className="mb-2 flex flex-wrap items-baseline gap-2">
        {showHeader && <Chip tone="attention">{question.header}</Chip>}
        {multi && <span className="text-xs text-muted-foreground">Pick any that apply.</span>}
        {/* Markdown, as the transcript renders it: agents quote paths and identifiers in backticks. */}
        <Prose text={question.question} className="min-w-0 basis-full text-sm font-medium [&_p]:my-0" />
      </legend>

      {question.options.length === 0 && field}

      {question.options.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2" role={multi ? 'group' : 'radiogroup'}>
          {question.options.map((option, at) => {
            const selected = choice.picked.includes(at)
            const recommended = RECOMMENDED.test(option.label)
            const label = plain(option.label)
            return (
              <button
                key={at}
                type="button"
                role={multi ? 'checkbox' : 'radio'}
                aria-checked={selected}
                aria-label={recommended ? `${label} (recommended)` : label}
                title={option.description}
                data-option={at}
                data-selected={selected ? 'true' : undefined}
                disabled={busy}
                onClick={() => onChoose(at)}
                className={choiceClass(selected) + ' disabled:opacity-60'}
              >
                <Mark multi={multi} selected={selected} />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2 font-medium">
                    {label}
                    {recommended && (
                      <span className="text-xs font-normal text-tone-attention-foreground" data-recommended>
                        Recommended
                      </span>
                    )}
                  </span>
                  {option.description !== undefined && (
                    <span className="text-xs text-muted-foreground">{option.description}</span>
                  )}
                </span>
                {at < 9 && (
                  <kbd aria-hidden="true" className="ml-auto text-[10px] text-muted-foreground">
                    {at + 1}
                  </kbd>
                )}
              </button>
            )
          })}

          {/* Other: a choice like the rest, holding the field it is answered in. */}
          <div className={choiceClass(other) + ' flex-col sm:col-span-2'} data-other data-selected={other ? 'true' : undefined}>
            <button
              type="button"
              role={multi ? 'checkbox' : 'radio'}
              aria-checked={other}
              aria-label="Other"
              data-option="other"
              disabled={busy}
              onClick={() => onOther(multi ? !other : true)}
              className="flex w-full items-start gap-2.5 text-left disabled:opacity-60"
            >
              <Mark multi={multi} selected={other} />
              <span className="flex-1 font-medium">Other</span>
              {question.options.length < 9 && (
                <kbd aria-hidden="true" className="ml-auto text-[10px] text-muted-foreground">
                  {question.options.length + 1}
                </kbd>
              )}
            </button>
            {field}
          </div>
        </div>
      )}
    </fieldset>
  )
}
