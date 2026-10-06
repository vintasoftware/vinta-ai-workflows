/**
 * The plan review page (§19) on screen.
 *
 * The plans client is an in-memory double, and that is deliberate: the wire is
 * covered against a real daemon in `tests/review.test.ts`, and what this file
 * asserts is the page — that every surface a reviewer comments on produces the
 * right anchor, that the graph is coloured by review state, and that sending,
 * revealing and approving do what the buttons say. The double mutates its
 * review through the same pure functions the daemon uses, so the rules the
 * page displays are the real ones.
 */
import { cleanup, fireEvent, render, waitFor, within, type RenderResult } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import type {
  PlanReviewResponse,
  PlanViewResponse,
  PresenceResponse,
} from '../../src/daemon/schemas.ts'
import {
  addComment,
  addReply,
  approve,
  deleteDraft,
  emptyReview,
  postMessage,
  setCommentStatus,
  type PlanReview,
} from '../../src/review/document.ts'
import { WorkflowSchema } from '../../src/types.ts'
import { App } from '../src/App.tsx'
import { createClient } from '../src/client.ts'
import type { NewCommentInput, PlansClient } from '../src/plans-client.ts'
import { cardColorOf, cardLabelOf } from './render-app.tsx'
import { startStubDaemon, type StubDaemon } from './stub-daemon.ts'

const ID = '2026-03-04-bookmark-folders'
const PLAN_REF = 'ai-plans/2026-03-04-BOOKMARK_FOLDERS_IMPLEMENTATION_PLAN.md'
const FIXTURES = join(import.meta.dirname, '..', '..', 'tests', 'fixtures')

const WORKFLOW = WorkflowSchema.parse(
  JSON.parse(readFileSync(join(FIXTURES, 'plan-feature-example.workflow.json'), 'utf8')),
)
const MARKDOWN = readFileSync(
  join(FIXTURES, 'plan-review', '2026-03-04-BOOKMARK_FOLDERS_IMPLEMENTATION_PLAN.md'),
  'utf8',
)

function view(overrides: Partial<PlanViewResponse> = {}): PlanViewResponse {
  const phases: PlanViewResponse['phases'] = {}
  for (const node of WORKFLOW.nodes) {
    phases[node.id] = {
      brief: `### ${node.name}\n\nThe brief of ${node.id}.`,
      prompts: {
        implementer: `You are implementing ${node.id}.`,
        fixer: `You are fixing ${node.id}. Read the gate log.`,
      },
      chores: { review: `Review ${node.id} until approved.`, deslop: 'Rewrite the comments.' },
      error: null,
    }
  }
  return {
    id: ID,
    stamp: 'stamp-1',
    workflow: WORKFLOW,
    valid: true,
    issues: [],
    waves: { p1: 1, p2: 2, p3: 2, p4: 3, p5: 4 },
    plan: { ref: PLAN_REF, title: 'Bookmark Folders — Implementation Plan', markdown: MARKDOWN },
    phases,
    ...overrides,
  }
}

interface Double extends PlansClient {
  review_: PlanReview
  presence: PresenceResponse
  readonly comments: NewCommentInput[]
  readonly messages: { body: string; send: string }[]
}

/** The plans API, in memory, mutated with the daemon's own document functions. */
function double(planView: PlanViewResponse = view()): Double {
  const now = '2026-10-05T10:00:00.000Z'
  const human = { kind: 'human' } as const
  const state: Double = {
    review_: emptyReview(ID),
    presence: { state: 'away', lastSeenAt: null },
    comments: [],
    messages: [],
    list: async () => [],
    view: async () => planView,
    review: async () => response(),
    schedule: async () => ({ status: 'completed', projectedMs: 0, nodes: [], criticalPath: [] }),
    comment: async (_id, input) => {
      state.comments.push(input)
      return change((review) =>
        addComment(
          review,
          { anchor: input.anchor, body: input.body, author: human, ...(input.quote === undefined ? {} : { quote: input.quote }) },
          now,
        ),
      )
    },
    reply: async (_id, commentId, body) => change((review) => addReply(review, commentId, { body, author: human }, now)),
    setStatus: async (_id, commentId, status) => change((review) => setCommentStatus(review, commentId, status, now)),
    discard: async (_id, commentId) => change((review) => deleteDraft(review, commentId)),
    message: async (_id, body, send) => {
      state.messages.push({ body, send })
      return change((review) => postMessage(review, { body, author: human, send }, now))
    },
    approve: async () => change((review) => approve(review, human, now)),
  }
  return state

  function change(mutate: (review: PlanReview) => PlanReview): PlanReviewResponse {
    state.review_ = mutate(state.review_)
    return response()
  }

  function response(): PlanReviewResponse {
    return {
      id: ID,
      stamp: planView.stamp,
      path: `ai-plans/${ID}.review.json`,
      review: state.review_,
      presence: state.presence,
    }
  }
}

let daemon: StubDaemon | null = null

afterEach(async () => {
  cleanup()
  window.location.hash = ''
  await daemon?.close()
  daemon = null
})

async function openReview(plans: Double): Promise<RenderResult> {
  daemon = await startStubDaemon({ runs: [], snapshots: {} })
  window.location.hash = `#/plans/${ID}`
  const page = render(<App client={createClient(daemon.origin, daemon.token)} plans={plans} />)
  await waitFor(() => expect(page.container.querySelector('[data-plan-review]')).not.toBe(null))
  await waitFor(() => expect(page.container.querySelector('[data-phase="p1"]')).not.toBe(null))
  return page
}

function click(container: HTMLElement, selector: string): void {
  const element = container.querySelector(selector)
  if (!(element instanceof HTMLElement)) throw new Error(`nothing matches ${selector}`)
  fireEvent.click(element)
}

async function saveComment(container: HTMLElement, text: string): Promise<void> {
  const box = container.querySelector('[data-field="comment"]')
  if (!(box instanceof HTMLTextAreaElement)) throw new Error('no composer')
  fireEvent.change(box, { target: { value: text } })
  click(container, '[data-action="save-comment"]')
}

test('opens on the first phase, with the plan’s title, validity and review state', async () => {
  const { container } = await openReview(double())
  expect(container.querySelector('h1')?.textContent).toBe('Bookmark Folders — Implementation Plan')
  expect(container.querySelector('[data-phase="p1"]')?.textContent).toContain('BookmarkFolder model + migration')
  expect(container.querySelector('[data-staffing]')?.textContent).toContain('tier1 · tier 1 · claude-haiku-4-5')
  expect(container.querySelector('[data-pipeline="standard-phase"]')?.textContent).toContain('types, unit')
  // Review state, not run state: an unreviewed phase is "No comments", never "Pending".
  await waitFor(() => expect(cardLabelOf(container, 'p1')).toContain('No comments'))
})

test('a comment on a prompt is anchored to that prompt, colours its phase, and is sent as a batch', async () => {
  const plans = double()
  const { container } = await openReview(plans)

  click(container, '[data-tab="fixer"]')
  expect(container.querySelector('[data-prompt="fixer"]')?.textContent).toContain('You are fixing p1')
  click(container, '[data-action="comment-prompt"]')
  expect(container.querySelector('[data-target]')?.textContent).toBe('Fixer prompt · p1')

  await saveComment(container, 'Check that the migration reverses.')
  await waitFor(() => expect(container.querySelector('[data-comment="c1"]')).not.toBe(null))
  expect(plans.comments[0]?.anchor).toEqual({ kind: 'prompt', node: 'p1', role: 'fixer' })
  expect(within(container.querySelector('[data-comment="c1"]') as HTMLElement).getByText('draft')).toBeTruthy()

  // The phase turns "has open comments" on the canvas and in the table.
  await waitFor(() => expect(cardLabelOf(container, 'p1')).toContain('Open comments'))
  expect(cardColorOf(container, 'p1')).toContain('awaiting_human')
  expect(container.querySelector('[data-phase-row="p1"] .chip')?.getAttribute('data-tone')).toBe('attention')

  click(container, '[data-action="send-comments"]')
  await waitFor(() => expect(plans.messages).toEqual([{ body: '', send: 'unsent' }]))
  // Sending switches to the conversation, which shows what went.
  await waitFor(() => expect(container.querySelector('[data-sent-comments]')?.textContent).toContain('c1'))
})

test('the plan tab comments on a section by its heading', async () => {
  const plans = double()
  const { container } = await openReview(plans)
  click(container, '[data-tab="plan"]')
  await waitFor(() => expect(container.querySelector('[data-section="2-guiding-decisions"]')).not.toBe(null))
  click(container, '[data-section="2-guiding-decisions"] [data-action="comment-section"]')
  expect(container.querySelector('[data-target]')?.textContent).toBe('2. Guiding Decisions')
  await saveComment(container, 'Why per-tenant?')
  await waitFor(() =>
    expect(plans.comments[0]?.anchor).toEqual({
      kind: 'section',
      section: '2-guiding-decisions',
      heading: '2. Guiding Decisions',
    }),
  )
  // A phase's own section links back to the graph.
  expect(container.querySelector('[data-section^="phase-2"] [data-action="show-phase"]')?.textContent).toContain('p2')
})

test('a thread’s location opens the thing it is about', async () => {
  const plans = double()
  plans.review_ = addComment(
    emptyReview(ID),
    { anchor: { kind: 'gate', gate: 'unit', node: 'p3' }, body: 'Run e2e too', author: { kind: 'human' } },
    '2026-10-05T10:00:00.000Z',
  )
  const { container } = await openReview(plans)
  await waitFor(() => expect(container.querySelector('[data-comment="c1"]')).not.toBe(null))
  click(container, '[data-comment="c1"] [data-action="reveal"]')
  await waitFor(() => expect(container.querySelector('[data-phase="p3"]')).not.toBe(null))
  expect(container.querySelector('[data-gate="unit"]')?.textContent).toContain('uv run pytest')
})

test('the chat says no agent is listening and how to attach one', async () => {
  const { container } = await openReview(double())
  click(container, '[data-tab="chat"]')
  const away = container.querySelector('[data-presence="away"]')
  expect(away?.textContent).toContain(`vinta-ai-maestro review wait ai-plans/${ID}.workflow.json`)
})

test('the chat shows the agent listening, and sends a message as typed', async () => {
  const plans = double()
  plans.presence = { state: 'listening', since: '2026-10-05T10:00:00.000Z' }
  const { container } = await openReview(plans)
  click(container, '[data-tab="chat"]')
  await waitFor(() => expect(container.querySelector('[data-presence="listening"]')).not.toBe(null))
  const box = container.querySelector('[data-field="message"]') as HTMLTextAreaElement
  fireEvent.change(box, { target: { value: 'Split phase 2.' } })
  fireEvent.keyDown(box, { key: 'Enter' })
  await waitFor(() => expect(plans.messages).toEqual([{ body: 'Split phase 2.', send: 'none' }]))
  await waitFor(() => expect(container.querySelector('[data-message="m1"]')?.textContent).toContain('Split phase 2.'))
})

test('approving with open comments asks first', async () => {
  const plans = double()
  plans.review_ = addComment(
    emptyReview(ID),
    { anchor: { kind: 'plan' }, body: 'one thing', author: { kind: 'human' } },
    '2026-10-05T10:00:00.000Z',
  )
  const { container } = await openReview(plans)
  click(container, '[data-action="approve"]')
  expect(container.querySelector('[data-confirm-approve]')?.textContent).toContain('1 open, 1 unsent — approve anyway?')
  click(container, '[data-action="approve-confirm"]')
  await waitFor(() => expect(container.querySelector('[data-approved]')).not.toBe(null))
  expect(plans.review_.status).toBe('approved')
})

test('a plan with issues lists them and colours the phase they belong to', async () => {
  const plans = double(
    view({
      valid: false,
      issues: [
        { path: 'nodes[1].prompt_ref', source: 'reference', message: 'no heading matches "#phase-9"' },
      ],
    }),
  )
  const { container } = await openReview(plans)
  await waitFor(() => expect(cardLabelOf(container, 'p2')).toContain('Has issues'))
  click(container, '[data-action="checks"]')
  await waitFor(() => expect(container.querySelector('[data-issue="nodes[1].prompt_ref"]')).not.toBe(null))
})

test('the gates tab is a phase-by-gate matrix of the resolved commands', async () => {
  const { container } = await openReview(double())
  click(container, '[data-tab="gates"]')
  await waitFor(() => expect(container.querySelector('[data-gate-matrix]')).not.toBe(null))
  expect(container.querySelector('[data-cell="p1:unit"] [aria-label="runs"]')).not.toBe(null)
  expect(container.querySelector('[data-gate-definition="unit"]')?.textContent).toContain('test-suite')
})
