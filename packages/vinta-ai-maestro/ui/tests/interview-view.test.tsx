/**
 * The interview page (§20) on screen.
 *
 * The client is an in-memory double: the wire is covered against a real
 * server in `tests/interview.test.ts`, and what this file asserts is the page
 * — one decision per screen, the rail's state, a submit refused while a
 * required decision is open, the answers' shape, the read-only round after
 * submission, and the switch to the next round when the agent writes it.
 */
import { cleanup, fireEvent, render, waitFor, type RenderResult } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import type { InterviewAnswers, InterviewRound } from '../../src/interview/document.ts'
import { InterviewRoundSchema } from '../../src/interview/document.ts'
import type { InterviewState } from '../../src/interview/wire.ts'
import { InterviewApp } from '../src/Interview.tsx'
import { InterviewRefused, type InterviewClient } from '../src/interview-client.ts'
import { flatten, fromAnswers, missing, pick, toAnswers, typeOther, waive } from '../src/interview-model.ts'

const POLL_MS = 40

function round(n = 1, overrides: Partial<InterviewRound> = {}): InterviewRound {
  return InterviewRoundSchema.parse({
    schema_version: 1,
    round: n,
    interview: { slug: 'order-tags', title: 'Order tags — spec interview', skill: 'create-spec' },
    intro: 'Before I draft the spec I need the decisions below.',
    groups: [
      {
        id: 'A',
        title: 'Problem & customer',
        decisions: [
          {
            id: 'A1',
            title: 'Who is the primary user of order tags?',
            short: 'Primary user',
            why: 'Mixing audiences optimizes the wrong workflow.',
            context: 'The repo has an **ops** admin and a customer dashboard.',
            input: {
              type: 'single',
              options: [
                { value: 'ops', label: 'Internal ops staff', consequences: 'No customer UI in v1.', recommended: true },
                { value: 'tenants', label: 'Tenant admins', tags: [{ label: 'Bigger scope', tone: 'warn' }] },
              ],
              allow_other: true,
            },
          },
          {
            id: 'A2',
            title: 'What do they do today without tags?',
            short: 'Workaround',
            required: false,
            input: { type: 'text', label: 'Describe the workaround' },
          },
        ],
      },
      {
        id: 'D',
        title: 'State, edges',
        decisions: [
          {
            id: 'D4',
            title: 'Two people edit the same tags. Who wins?',
            short: 'Concurrency',
            explainer: { title: 'How each rule behaves', path: 'docs/D4-concurrency.md' },
            input: {
              type: 'multi',
              options: [
                { value: 'lww', label: 'Last write wins' },
                { value: 'lock', label: 'Optimistic lock' },
              ],
            },
          },
        ],
      },
    ],
    ...overrides,
  })
}

interface Double extends InterviewClient {
  state_: InterviewState
  rounds: Map<number, InterviewRound>
  readonly submitted: Map<number, InterviewAnswers>
  readonly docs: Map<string, string>
  refuse: string | null
}

function double(first: InterviewRound | null = round()): Double {
  const rounds = new Map<number, InterviewRound>()
  if (first !== null) rounds.set(first.round, first)
  const state = (): InterviewState => {
    const list = [...rounds.values()].sort((a, b) => a.round - b.round)
    const summaries = list.map((r) => ({
      round: r.round,
      title: r.interview.title,
      kind: r.kind,
      answered: client.submitted.has(r.round),
      error: null,
    }))
    return {
      rounds: summaries,
      latest: list.at(-1)?.round ?? null,
      current: summaries.find((s) => !s.answered)?.round ?? null,
    }
  }
  const client: Double = {
    state_: { rounds: [], latest: null, current: null },
    rounds,
    submitted: new Map(),
    docs: new Map([['docs/D4-concurrency.md', '# How each rule behaves\n\nA table.']]),
    refuse: null,
    state: async () => state(),
    round: async (n) => {
      const found = rounds.get(n)
      if (found === undefined) throw new InterviewRefused('unknown_round')
      return found
    },
    answers: async (n) => {
      const found = client.submitted.get(n)
      if (found === undefined) throw new InterviewRefused('unknown_answers')
      return found
    },
    submit: async (n, answers) => {
      if (client.refuse !== null) throw new InterviewRefused(client.refuse)
      client.submitted.set(n, { ...answers, submitted_at: '2026-10-05T10:00:00.000Z' })
      return `/tmp/answers/round-0${n}.json`
    },
    doc: async (path) => {
      const found = client.docs.get(path)
      if (found === undefined) throw new InterviewRefused('unknown_doc')
      return found
    },
    docUrl: (path) => `http://stub/api/interview/docs/${path}`,
  }
  return client
}

afterEach(() => {
  cleanup()
  localStorage.clear()
})

async function open(client: Double): Promise<RenderResult> {
  const page = render(<InterviewApp client={client} pollMs={POLL_MS} />)
  await waitFor(() => expect(page.container.querySelector('[data-round]')).not.toBe(null))
  return page
}

function click(container: HTMLElement, selector: string): void {
  const element = container.querySelector(selector)
  if (!(element instanceof HTMLElement)) throw new Error(`nothing matches ${selector}`)
  fireEvent.click(element)
}

function type(container: HTMLElement, selector: string, value: string): void {
  const element = container.querySelector(selector)
  if (!(element instanceof HTMLTextAreaElement) && !(element instanceof HTMLInputElement)) {
    throw new Error(`no field matches ${selector}`)
  }
  fireEvent.change(element, { target: { value } })
}

const text = (container: HTMLElement, selector: string): string =>
  container.querySelector(selector)?.textContent ?? ''

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

test('the answers payload carries values, other, text and notes by input type, and nothing else', () => {
  const r = round()
  const placed = flatten(r)
  const [a1, a2, d4] = placed.map((p) => p.decision)
  if (a1 === undefined || a2 === undefined || d4 === undefined) throw new Error('fixture')
  const draft = {
    answers: {
      A1: typeOther(a1, pick(a1, { status: 'skipped', values: [], other: '', text: '', note: ' keep ' }, 'ops'), ''),
      A2: { status: 'answered' as const, values: [], other: '', text: ' spreadsheet ', note: '' },
      D4: waive(d4, { status: 'skipped', values: [], other: '', text: '', note: '' }, true),
    },
    questions: [{ id: 'q1', decision_id: 'A1', body: 'Why?' }],
    general_note: ' carry this ',
  }
  expect(missing(placed, draft)).toEqual([])
  expect(toAnswers(r, placed, draft)).toEqual({
    schema_version: 1,
    round: 1,
    interview: 'order-tags',
    answers: [
      { decision_id: 'A1', status: 'answered', values: ['ops'], note: 'keep' },
      { decision_id: 'A2', status: 'answered', text: 'spreadsheet' },
      { decision_id: 'D4', status: 'waived' },
    ],
    questions: [{ id: 'q1', decision_id: 'A1', body: 'Why?' }],
    general_note: 'carry this',
  })
  // Other on a radio replaces the option; on a checkbox it rides beside them.
  expect(typeOther(a1, pick(a1, draft.answers.A1, 'tenants'), 'partners').values).toEqual([])
  expect(typeOther(d4, pick(d4, draft.answers.D4, 'lww'), 'merge').values).toEqual(['lww'])
  expect(pick(d4, pick(d4, draft.answers.D4, 'lww'), 'lww').values).toEqual([])
  // A submitted round reads back into the same shape.
  expect(fromAnswers(toAnswers(r, placed, draft)).answers['A2']?.text).toBe('spreadsheet')
})

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

test('opens on the first decision with its context, options and consequences, and lists every decision in the rail', async () => {
  const { container } = await open(double())
  expect(text(container, '[data-interview-title]')).toContain('Order tags — spec interview')
  expect(text(container, '[data-interview-title]')).toContain('Round 1')
  expect(container.querySelector('h1')?.textContent).toBe('Who is the primary user of order tags?')
  expect(text(container, '[data-why]')).toContain('Mixing audiences')
  expect(text(container, '[data-intro]')).toContain('Before I draft')
  expect(container.querySelector('[data-context] strong')?.textContent).toBe('ops')
  expect(text(container, '[data-option="ops"] [data-consequences]')).toContain('No customer UI in v1.')
  expect(container.querySelector('[data-option="ops"] [data-recommended]')).not.toBe(null)
  expect(container.querySelector('[data-option="tenants"] [data-slot="badge"]')?.textContent).toBe('Bigger scope')
  expect(container.querySelector('[data-option="__other"]')).not.toBe(null)

  const rail = [...container.querySelectorAll('[data-decision-link]')].map((link) => [
    link.getAttribute('data-decision-link'),
    link.getAttribute('data-state'),
  ])
  expect(rail).toEqual([
    ['A1', 'open'],
    ['A2', 'open'],
    ['D4', 'open'],
  ])
  expect(text(container, '[data-progress]')).toBe('0 / 3')
})

test('picking an option marks the decision done, and the rail moves between decisions', async () => {
  const { container } = await open(double())
  click(container, '[data-option="ops"] button')
  expect(container.querySelector('[data-option="ops"] button')?.getAttribute('aria-checked')).toBe('true')
  expect(container.querySelector('[data-decision-link="A1"]')?.getAttribute('data-state')).toBe('done')
  expect(text(container, '[data-progress]')).toBe('1 / 3')

  click(container, '[data-decision-link="D4"]')
  expect(container.querySelector('h1')?.textContent).toContain('Who wins?')
  // The explainer document is fetched and drawn.
  await waitFor(() => expect(text(container, '[data-explainer]')).toContain('A table.'))
  click(container, '[data-option="lww"] button')
  click(container, '[data-option="lock"] button')
  expect(container.querySelectorAll('[data-options] [aria-checked="true"]')).toHaveLength(2)

  click(container, '[data-action="prev"]')
  expect(container.querySelector('h1')?.textContent).toContain('do today')
  // Waiving an optional text decision counts as done too.
  click(container, '[data-field="waive"]')
  expect(container.querySelector('[data-decision-link="A2"]')?.getAttribute('data-state')).toBe('waived')
  expect(text(container, '[data-status]')).toContain('All decisions answered')
})

test('a submit with a required decision open is refused and jumps to it', async () => {
  const client = double()
  const { container } = await open(client)
  click(container, '[data-decision-link="D4"]')
  click(container, '[data-action="submit"]')
  expect(client.submitted.size).toBe(0)
  expect(container.querySelector('h1')?.textContent).toContain('primary user')
  expect(container.querySelector('[data-decision-link="A1"]')?.getAttribute('data-state')).toBe('missing')
  expect(text(container, '[data-status]')).toContain('highlighted')
})

test('a submitted round carries the answers, the questions and the note, then shows read-only', async () => {
  const client = double()
  const { container } = await open(client)
  click(container, '[data-option="__other"] button')
  type(container, '[data-field="other"]', 'Partner integrations')
  type(container, '[data-field="note"]', 'Only the EU tenants at first')
  type(container, '[data-field="question"]', 'Can both be true?')
  click(container, '[data-action="ask-question"]')
  expect(container.querySelectorAll('[data-question]')).toHaveLength(1)
  type(container, '[data-field="general-note"]', 'Ship before Q3')

  click(container, '[data-action="next"]')
  type(container, '[data-field="text"]', 'A spreadsheet of order ids')
  click(container, '[data-action="next"]')
  click(container, '[data-option="lock"] button')
  click(container, '[data-action="submit"]')

  await waitFor(() => expect(client.submitted.size).toBe(1))
  const sent = client.submitted.get(1)
  expect(sent?.answers).toEqual([
    { decision_id: 'A1', status: 'answered', values: [], other: 'Partner integrations', note: 'Only the EU tenants at first' },
    { decision_id: 'A2', status: 'answered', text: 'A spreadsheet of order ids' },
    { decision_id: 'D4', status: 'answered', values: ['lock'] },
  ])
  expect(sent?.questions?.[0]).toMatchObject({ decision_id: 'A1', body: 'Can both be true?' })
  expect(sent?.general_note).toBe('Ship before Q3')

  await waitFor(() => expect(container.querySelector('[data-round][data-readonly]')).not.toBe(null))
  expect(container.querySelector('[data-submitted]')).not.toBe(null)
  expect(container.querySelector('[data-action="submit"]')).toBe(null)
  expect(text(container, '[data-status]')).toContain('Waiting for the agent')
  // The draft is gone from the browser: a reload shows the submitted answers, not a stale draft.
  expect(localStorage.getItem('vinta-ai-maestro-interview:order-tags:1')).toBe(null)
})

test('the next round opens on its own once the agent writes it, with the agent’s replies in view', async () => {
  const client = double()
  const { container } = await open(client)
  click(container, '[data-option="ops"] button')
  click(container, '[data-decision-link="D4"]')
  click(container, '[data-option="lock"] button')
  click(container, '[data-action="submit"]')
  await waitFor(() => expect(container.querySelector('[data-round][data-readonly]')).not.toBe(null))

  client.rounds.set(
    2,
    round(2, {
      intro: 'Round two.',
      replies: [{ decision_id: 'A1', question: 'Can both be true?', answer: 'Yes, with a **visibility** rule.' }],
      groups: [
        {
          id: 'A',
          title: 'Problem & customer',
          decisions: [
            {
              id: 'A1',
              title: 'Shared tags, then?',
              input: { type: 'confirm', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] },
              required: true,
              waivable: true,
            },
          ],
        },
      ],
    }),
  )
  await waitFor(() => expect(container.querySelector('[data-round="2"]')).not.toBe(null))
  expect(container.querySelector('[data-round][data-readonly]')).toBe(null)
  expect(text(container, '[data-replies]')).toContain('Can both be true?')
  expect(container.querySelector('[data-replies] strong')?.textContent).toBe('visibility')
  expect(text(container, '[data-interview-title]')).toContain('Round 2')
  // The round picker lists both, and going back shows the submitted one read-only.
  const select = container.querySelector('[data-round-select]')
  expect(select).not.toBe(null)
  fireEvent.change(select as HTMLSelectElement, { target: { value: '1' } })
  await waitFor(() => expect(container.querySelector('[data-round="1"][data-readonly]')).not.toBe(null))
  expect(text(container, '[data-status]')).toContain('Round 2 is open')
  click(container, '[data-action="open-current"]')
  await waitFor(() => expect(container.querySelector('[data-round="2"]')).not.toBe(null))
})

test('a refused submission is explained, and a draft survives a remount', async () => {
  const client = double()
  client.refuse = 'already_submitted'
  const first = await open(client)
  click(first.container, '[data-option="ops"] button')
  click(first.container, '[data-decision-link="D4"]')
  click(first.container, '[data-option="lww"] button')
  click(first.container, '[data-action="submit"]')
  await waitFor(() => expect(text(first.container, '[data-status]')).toContain('already submitted'))
  cleanup()

  const second = await open(client)
  expect(second.container.querySelector('[data-decision-link="A1"]')?.getAttribute('data-state')).toBe('done')
  // Reopened on the first decision still open, not on the first decision.
  expect(second.container.querySelector('h1')?.textContent).toContain('do today')
})

test('before the first round, the page waits', async () => {
  const client = double(null)
  const { container } = render(<InterviewApp client={client} pollMs={POLL_MS} />)
  await waitFor(() => expect(text(container, '[data-empty]')).toContain('Waiting for the first round'))
  client.rounds.set(1, round())
  await waitFor(() => expect(container.querySelector('[data-round="1"]')).not.toBe(null))
})
