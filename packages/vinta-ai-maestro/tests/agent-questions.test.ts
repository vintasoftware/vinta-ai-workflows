import { describe, expect, it } from 'vitest'
import {
  answered,
  decodeAnswers,
  encodeAnswers,
  formatAnswers,
  parseNeedsInput,
  QuestionWatch,
  questionsFromTool,
  recommendedAnswers,
  type AgentAsk,
} from '../src/questions/agent-questions.ts'

const BLOCK = `status: NEEDS_INPUT
blocked_on: left-pad declares no license
done_so_far: parser committed
questions:
  - header: License
    question: "\`left-pad\` declares no license. How should I proceed?"
    multi_select: false
    options:
      - label: Find alternative (Recommended)
        description: Use an MIT package instead.
      - label: Treat as forbidden
        description: Implement the helper inline.
      - label: Other
        description: Something else.`

describe('parseNeedsInput', () => {
  it('reads a fenced block after a report', () => {
    const ask = parseNeedsInput(`I stopped before installing a dependency.\n\n\`\`\`yaml\n${BLOCK}\n\`\`\`\n`)
    expect(ask).toEqual({
      source: 'report',
      blockedOn: 'left-pad declares no license',
      doneSoFar: 'parser committed',
      questions: [
        {
          header: 'License',
          question: '`left-pad` declares no license. How should I proceed?',
          multiSelect: false,
          // The "Other" option is dropped: the free-text field is the other.
          options: [
            { label: 'Find alternative (Recommended)', description: 'Use an MIT package instead.' },
            { label: 'Treat as forbidden', description: 'Implement the helper inline.' },
          ],
        },
      ],
    })
  })

  it('reads the block indented the way the skill prompt shows it, with prose after it', () => {
    const indented = BLOCK.split('\n')
      .map((line) => `    ${line}`)
      .join('\n')
    const ask = parseNeedsInput(`Report:\n\n${indented}\n\nThat is all.`)
    expect(ask?.questions[0]?.header).toBe('License')
    expect(ask?.questions[0]?.options).toHaveLength(2)
  })

  it('accepts bare-string options and the other spellings of multi-select', () => {
    const ask = parseNeedsInput(
      'status: NEEDS_INPUT\nquestions:\n  - question: Which apps?\n    multiSelect: true\n    options: [web, admin]\n',
    )
    expect(ask?.questions[0]).toEqual({
      header: 'Question 1',
      question: 'Which apps?',
      multiSelect: true,
      options: [{ label: 'web' }, { label: 'admin' }],
    })
  })

  it('reads a report that only mentions the protocol as no ask', () => {
    expect(parseNeedsInput('I did not need to return status: NEEDS_INPUT this time.')).toBeNull()
    expect(parseNeedsInput('status: NEEDS_INPUT\nblocked_on: nothing to ask\n')).toBeNull()
    expect(parseNeedsInput('All done. Status: SUCCESS')).toBeNull()
  })
})

describe('questionsFromTool', () => {
  const questions = [
    {
      header: 'Storage',
      question: 'Where do invoices go?',
      options: [{ label: 'Existing table', description: 'No migration.' }, { label: 'New table' }],
    },
  ]

  it('reads all three vendors’ tools', () => {
    for (const name of ['AskUserQuestion', 'question', 'request_user_input']) {
      expect(questionsFromTool(name, { questions })?.questions[0]?.options).toHaveLength(2)
    }
    expect(questionsFromTool('question', { questions: [{ ...questions[0], multiple: true }] })?.questions[0]?.multiSelect).toBe(true)
  })

  it('ignores every other tool and malformed input', () => {
    expect(questionsFromTool('Read', { questions })).toBeNull()
    expect(questionsFromTool('AskUserQuestion', { prompt: 'hi' })).toBeNull()
  })
})

describe('QuestionWatch', () => {
  const ask = { questions: [{ question: 'Proceed?', header: 'Go', options: [{ label: 'Yes' }, { label: 'No' }] }] }

  it('joins streamed prose before parsing it', () => {
    const watch = new QuestionWatch()
    watch.observe({ type: 'tool_use', name: 'Read', id: 't1', input: {} })
    const half = BLOCK.length / 2
    watch.observe({ type: 'assistant_text', text: BLOCK.slice(0, half) })
    watch.observe({ type: 'assistant_text', text: BLOCK.slice(half) })
    watch.observe({ type: 'session_ended', result: 'ok' })
    expect(watch.result()?.source).toBe('report')
  })

  it('takes a question tool that was the agent’s last act', () => {
    const watch = new QuestionWatch()
    watch.observe({ type: 'tool_use', name: 'AskUserQuestion', id: 'q1', input: ask })
    watch.observe({ type: 'tool_result', id: 'q1', ok: false, summary: 'not available' })
    watch.observe({ type: 'assistant_text', text: 'I need to know whether to proceed.' })
    expect(watch.result()).toMatchObject({ source: 'tool', tool: 'AskUserQuestion' })
  })

  it('drops a question the agent moved past, or the harness answered', () => {
    const moved = new QuestionWatch()
    moved.observe({ type: 'tool_use', name: 'AskUserQuestion', id: 'q1', input: ask })
    moved.observe({ type: 'tool_use', name: 'Edit', id: 'e1', input: {} })
    expect(moved.result()).toBeNull()

    const answered = new QuestionWatch()
    answered.observe({ type: 'tool_use', name: 'AskUserQuestion', id: 'q1', input: ask })
    answered.observe({ type: 'tool_result', id: 'q1', ok: true, summary: 'Yes' })
    expect(answered.result()).toBeNull()
  })

  it('never asks for an interrupted turn', () => {
    const watch = new QuestionWatch()
    watch.observe({ type: 'assistant_text', text: BLOCK })
    watch.observe({ type: 'session_ended', result: 'interrupted' })
    expect(watch.result()).toBeNull()
  })
})

describe('answers', () => {
  const ask: AgentAsk = {
    source: 'report',
    questions: [
      {
        header: 'Storage',
        question: 'Where do invoices go?',
        multiSelect: false,
        options: [{ label: 'New table' }, { label: 'Existing table (Recommended)' }],
      },
      { header: 'Apps', question: 'Which apps?', multiSelect: true, options: [{ label: 'web' }, { label: 'admin' }] },
      { header: 'Name', question: 'What is the flag called?', multiSelect: false, options: [] },
    ],
  }

  it('round-trips through the journal’s string and fits the ask', () => {
    const encoded = encodeAnswers([
      { selected: [1, 0] },
      { selected: [0, 1, 1, 7] },
      { selected: [], text: '  invoices_v2  ' },
    ])
    expect(decodeAnswers(encoded, ask)).toEqual([
      // One option on a single-choice question; out-of-range and repeated
      // indices dropped; text trimmed.
      { selected: [1] },
      { selected: [0, 1] },
      { selected: [], text: 'invoices_v2' },
    ])
  })

  it('reads text on a single-choice question as Other, replacing the option sent with it', () => {
    const decoded = decodeAnswers(
      encodeAnswers([{ selected: [1], text: 'a view over both' }, { selected: [0], text: 'and mobile' }, { selected: [] }]),
      ask,
    )
    expect(decoded[0]).toEqual({ selected: [], text: 'a view over both' })
    // Multi-choice keeps both: Other is one more box ticked.
    expect(decoded[1]).toEqual({ selected: [0], text: 'and mobile' })
  })

  it('keeps an undecodable answer as free text instead of dropping it', () => {
    expect(decodeAnswers('just use the old table', ask)[0]).toEqual({
      selected: [],
      text: 'just use the old table',
    })
  })

  it('answers an unattended run with the recommended options', () => {
    const answers = recommendedAnswers(ask)
    expect(answers[0]).toEqual({ selected: [1] })
    expect(answers[1]).toEqual({ selected: [0] })
    expect(answers[2]?.text).toMatch(/No operator is available/)
    expect(answered(ask, answers)).toBe(true)
    expect(answered(ask, [{ selected: [] }])).toBe(false)
  })

  it('restates each question with its answer for the agent', () => {
    const message = formatAnswers(ask, [
      { selected: [], text: 'a view over both' },
      { selected: [0, 1], text: 'and mobile' },
      { selected: [] },
    ])
    expect(message).toContain('1. Storage — Where do invoices go?\n   Answer: a view over both')
    expect(message).toContain('   Answer: web; admin\n   Other: and mobile')
    expect(message).toContain('3. Name — What is the flag called?\n   Answer: (left unanswered)')
    expect(formatAnswers(ask, recommendedAnswers(ask), { unattended: true })).toMatch(/^Nobody answered/)
  })
})
