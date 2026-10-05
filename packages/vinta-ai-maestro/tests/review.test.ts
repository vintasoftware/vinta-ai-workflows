/**
 * Plan review (§19): the review document, its two-process store, the plan
 * view, the `validate` and `review` commands, and the daemon's plan routes.
 *
 * Every repository here is a temporary copy of the plan-feature worked example
 * — `plan-feature-example.workflow.json` beside a synthetic markdown plan whose
 * headings its `prompt_ref` anchors name — so the prompts composed in these
 * tests are the real ones a run would send for that plan.
 */
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { describeAnchor, reviewCommand } from '../src/cli/review.ts'
import { validateCommand } from '../src/cli/validate.ts'
import type { Io } from '../src/cli/io.ts'
import {
  PlanListResponseSchema,
  PlanReviewResponseSchema,
  PlanViewResponseSchema,
  startDaemon,
  type Daemon,
} from '../src/daemon/index.ts'
import { openJournal, type Journal } from '../src/journal/journal.ts'
import {
  addComment,
  addReply,
  approve,
  awaitingAgent,
  buildPlanView,
  checkReferences,
  containedPath,
  createReviewStore,
  deleteDraft,
  emptyReview,
  markDelivered,
  postMessage,
  ReviewRefusal,
  setCommentStatus,
  undelivered,
  unsentThreads,
  type PlanReview,
} from '../src/review/index.ts'
import { serializePlanReviewSchema } from '../src/review/schema.ts'
import { WorkflowSchema } from '../src/types.ts'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const ID = '2026-03-04-bookmark-folders'
const WORKFLOW_FILE = `ai-plans/${ID}.workflow.json`
const PLAN_FILE = 'ai-plans/2026-03-04-BOOKMARK_FOLDERS_IMPLEMENTATION_PLAN.md'
const SCHEMA_PATH = join(import.meta.dirname, '..', '..', '..', 'schemas', 'plan-review.v1.schema.json')

const HUMAN = { kind: 'human' } as const
const AGENT = { kind: 'agent', name: 'claude-code' } as const
const T0 = '2026-10-05T10:00:00.000Z'
const T1 = '2026-10-05T10:01:00.000Z'

/** A checkout holding the worked example: workflow, plan, nothing else. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-review-'))
  mkdirSync(join(dir, 'ai-plans'), { recursive: true })
  cpSync(join(FIXTURES, 'plan-feature-example.workflow.json'), join(dir, WORKFLOW_FILE))
  cpSync(join(FIXTURES, 'plan-review', '2026-03-04-BOOKMARK_FOLDERS_IMPLEMENTATION_PLAN.md'), join(dir, PLAN_FILE))
  return dir
}

function editWorkflow(dir: string, change: (doc: Record<string, unknown>) => void): void {
  const path = join(dir, WORKFLOW_FILE)
  const doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  change(doc)
  writeFileSync(path, JSON.stringify(doc), 'utf8')
}

function recordingIo(): Io & { readonly outs: string[]; readonly errs: string[] } {
  const outs: string[] = []
  const errs: string[] = []
  return {
    outs,
    errs,
    out: (line) => outs.push(line),
    err: (line) => errs.push(line),
    confirm: async () => false,
  }
}

function storeIn(dir: string, alive: (pid: number) => boolean = () => true) {
  return createReviewStore({
    plansDir: join(dir, 'ai-plans'),
    stateRoot: join(dir, '.vinta-ai-maestro'),
    workflowId: ID,
    alive,
  })
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

describe('the review document', () => {
  it('keeps the committed JSON Schema in step with the zod source', () => {
    expect(readFileSync(SCHEMA_PATH, 'utf8')).toBe(serializePlanReviewSchema())
  })

  it('numbers comments and never reuses an id the agent may already have answered', () => {
    let review = emptyReview(ID)
    review = addComment(review, { anchor: { kind: 'plan' }, body: 'one', author: HUMAN }, T0)
    review = addComment(review, { anchor: { kind: 'plan' }, body: 'two', author: HUMAN }, T0)
    review = deleteDraft(review, 'c1')
    review = addComment(review, { anchor: { kind: 'plan' }, body: 'three', author: HUMAN }, T0)
    expect(review.comments.map((comment) => comment.id)).toEqual(['c2', 'c3'])
  })

  it('keeps a person’s comment a draft until it is sent, and sends every unsent thread at once', () => {
    let review = emptyReview(ID)
    review = addComment(review, { anchor: { kind: 'phase', node: 'p1' }, body: 'split it', author: HUMAN }, T0)
    review = addComment(
      review,
      { anchor: { kind: 'prompt', node: 'p2', role: 'fixer' }, body: 'check the flag', author: HUMAN },
      T0,
    )
    expect(unsentThreads(review).map((comment) => comment.id)).toEqual(['c1', 'c2'])
    expect(undelivered(review)).toEqual([])

    review = postMessage(review, { body: '', author: HUMAN, send: 'unsent' }, T1)
    expect(unsentThreads(review)).toEqual([])
    expect(review.comments.every((comment) => comment.sent_at === T1)).toBe(true)
    const [message] = undelivered(review)
    expect(message?.comment_ids).toEqual(['c1', 'c2'])
  })

  it('treats a person’s new reply on a sent thread as unsent again', () => {
    let review = emptyReview(ID)
    review = addComment(review, { anchor: { kind: 'plan' }, body: 'why four waves?', author: HUMAN }, T0)
    review = postMessage(review, { body: '', author: HUMAN, send: 'unsent' }, T0)
    review = addReply(review, 'c1', { body: 'p5 waits for everything', author: AGENT }, T1)
    expect(unsentThreads(review)).toEqual([])
    review = addReply(review, 'c1', { body: 'then move it out', author: HUMAN }, T1)
    expect(unsentThreads(review).map((comment) => comment.id)).toEqual(['c1'])
  })

  it('refuses a message with nothing in it, and a draft deletion after the agent has read it', () => {
    let review = emptyReview(ID)
    expect(() => postMessage(review, { body: '  ', author: HUMAN, send: 'unsent' }, T0)).toThrow(ReviewRefusal)
    review = addComment(review, { anchor: { kind: 'plan' }, body: 'x', author: HUMAN }, T0)
    review = postMessage(review, { body: '', author: HUMAN, send: 'unsent' }, T0)
    expect(() => deleteDraft(review, 'c1')).toThrow(ReviewRefusal)
  })

  it('reopens an approved review when the person writes again', () => {
    let review = approve(emptyReview(ID), HUMAN, T0)
    expect(review.status).toBe('approved')
    expect(() => approve(review, HUMAN, T0)).toThrow(ReviewRefusal)
    review = postMessage(review, { body: 'actually, one more thing', author: HUMAN }, T1)
    expect(review.status).toBe('open')
    expect(review.approved_at).toBeUndefined()
  })

  it('knows when the agent owes an answer: a delivered message with nothing from the agent after it', () => {
    let review = postMessage(emptyReview(ID), { body: 'split p2', author: HUMAN }, T0)
    expect(awaitingAgent(review)).toBe(false)
    review = markDelivered(review, undelivered(review).map((message) => message.id), T1)
    expect(awaitingAgent(review)).toBe(true)
    review = postMessage(review, { body: 'done', author: AGENT }, T1)
    expect(awaitingAgent(review)).toBe(false)
  })

  it('resolves and reopens a thread', () => {
    let review = addComment(emptyReview(ID), { anchor: { kind: 'plan' }, body: 'x', author: HUMAN }, T0)
    review = setCommentStatus(review, 'c1', 'resolved', T1)
    expect(review.comments[0]).toMatchObject({ status: 'resolved', resolved_at: T1 })
    review = setCommentStatus(review, 'c1', 'open', T1)
    expect(review.comments[0]?.resolved_at).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

describe('the review store', () => {
  it('reads a missing review as an empty one and writes it beside the workflow', () => {
    const dir = repo()
    const store = storeIn(dir)
    const read = store.read()
    expect(read).toMatchObject({ ok: true, exists: false })
    store.update((review) => addComment(review, { anchor: { kind: 'plan' }, body: 'x', author: HUMAN }, T0))
    const onDisk = JSON.parse(readFileSync(join(dir, 'ai-plans', `${ID}.review.json`), 'utf8')) as PlanReview
    expect(onDisk.comments).toHaveLength(1)
    expect(onDisk.$schema).toContain('plan-review.v1.schema.json')
  })

  it('never overwrites a review somebody broke by hand', () => {
    const dir = repo()
    const path = join(dir, 'ai-plans', `${ID}.review.json`)
    writeFileSync(path, '{ not json', 'utf8')
    const store = storeIn(dir)
    expect(store.read()).toEqual({ ok: false, reason: 'invalid' })
    expect(() => store.update((review) => review)).toThrow(ReviewRefusal)
    expect(readFileSync(path, 'utf8')).toBe('{ not json')
  })

  it('says listening while a waiter beats, working once it picked something up, and away after', () => {
    const dir = repo()
    let pidAlive = true
    const store = storeIn(dir, () => pidAlive)
    const now = Date.parse(T1)
    expect(store.presence(now)).toEqual({ state: 'away', lastSeenAt: null })

    store.heartbeat(T0, T1)
    expect(store.presence(now)).toEqual({ state: 'listening', since: T0 })

    store.update((review) => postMessage(review, { body: 'split p2', author: HUMAN }, T1))
    store.update((review) => markDelivered(review, ['m1'], T1))
    store.leave(T1)
    expect(store.presence(now + 1_000)).toEqual({ state: 'working', lastSeenAt: T1 })
    expect(store.presence(now + 60 * 60_000)).toEqual({ state: 'away', lastSeenAt: T1 })

    // A waiter whose process died is not listening, however fresh its beat.
    store.heartbeat(T0, T1)
    pidAlive = false
    expect(store.presence(now).state).not.toBe('listening')
  })
})

// ---------------------------------------------------------------------------
// References and the plan view
// ---------------------------------------------------------------------------

describe('references', () => {
  it('holds every reference inside the repository', () => {
    const dir = repo()
    expect(containedPath(dir, PLAN_FILE).ok).toBe(true)
    expect(containedPath(dir, '../outside.md')).toEqual({ ok: false, reason: 'outside' })
    expect(containedPath(dir, '/etc/passwd')).toEqual({ ok: false, reason: 'outside' })
    const outside = mkdtempSync(join(tmpdir(), 'vinta-ai-maestro-outside-'))
    writeFileSync(join(outside, 'secret.md'), '# secret\n', 'utf8')
    symlinkSync(join(outside, 'secret.md'), join(dir, 'ai-plans', 'linked.md'))
    expect(containedPath(dir, 'ai-plans/linked.md#secret')).toEqual({ ok: false, reason: 'outside' })
  })

  it('reports an anchor that names no heading, at the node it belongs to', () => {
    const dir = repo()
    const workflow = WorkflowSchema.parse(
      JSON.parse(readFileSync(join(FIXTURES, 'plan-feature-example.workflow.json'), 'utf8')),
    )
    expect(checkReferences(workflow, dir)).toEqual([])
    const broken = {
      ...workflow,
      nodes: workflow.nodes.map((node) =>
        node.id === 'p3' ? { ...node, prompt_ref: `${PLAN_FILE}#phase-9` } : node,
      ),
    }
    expect(checkReferences(broken, dir)).toEqual([
      { path: ['nodes', 2, 'prompt_ref'], message: `no heading in ${PLAN_FILE} matches "#phase-9"` },
    ])
  })
})

describe('the plan view', () => {
  it('composes each phase’s real cold prompts from the plan', async () => {
    const dir = repo()
    const built = await buildPlanView(dir, join(dir, 'ai-plans'), ID)
    if (!built.ok) throw new Error('expected a view')
    const { view } = built
    expect(view.valid).toBe(true)
    expect(view.plan?.title).toBe('Bookmark Folders — Implementation Plan')
    expect(view.waves).toEqual({ p1: 1, p2: 2, p3: 2, p4: 3, p5: 4 })
    const p2 = view.phases.p2
    expect(p2?.error).toBeNull()
    expect(p2?.brief).toContain('a `FolderViewSet` mirroring `TagViewSet`')
    expect(p2?.prompts.implementer).toContain('a `FolderViewSet` mirroring `TagViewSet`')
    expect(p2?.prompts.implementer).toContain('Users can group bookmarks into folders')
    expect(p2?.prompts.fixer).toBeTruthy()
    // The review is a chore (§16), so its prompt is among the chores'.
    expect(Object.keys(p2?.chores ?? {})).toEqual(['review', 'deslop'])
    expect(p2?.chores['review']).toContain('VERDICT: pass')
  })

  it('still draws a plan whose graph is wrong, and lists why', async () => {
    const dir = repo()
    editWorkflow(dir, (doc) => {
      const nodes = doc.nodes as { id: string; depends_on?: unknown[] }[]
      const p1 = nodes.find((node) => node.id === 'p1')
      if (p1 !== undefined) p1.depends_on = [{ node: 'p4', artifact: 'a cycle' }]
    })
    const built = await buildPlanView(dir, join(dir, 'ai-plans'), ID)
    if (!built.ok) throw new Error('expected a view')
    expect(built.view.valid).toBe(false)
    expect(built.view.workflow?.nodes).toHaveLength(5)
    expect(built.view.issues.some((issue) => issue.source === 'workflow')).toBe(true)
    expect(built.view.waves).toEqual({})
  })

  it('never reads a plan_ref that leaves the repository', async () => {
    const dir = repo()
    editWorkflow(dir, (doc) => {
      doc.plan_ref = '../../etc/hosts'
    })
    const built = await buildPlanView(dir, join(dir, 'ai-plans'), ID)
    if (!built.ok) throw new Error('expected a view')
    expect(built.view.plan).toBeNull()
    expect(built.view.issues).toContainEqual({
      path: ['plan_ref'],
      message: 'names a file outside the repository',
      source: 'reference',
    })
  })
})

// ---------------------------------------------------------------------------
// The CLI
// ---------------------------------------------------------------------------

describe('vinta-ai-maestro validate', () => {
  it('passes the worked example and says how big it is', async () => {
    const dir = repo()
    const io = recordingIo()
    expect(await validateCommand([join(dir, WORKFLOW_FILE), '--repo', dir], io)).toBe(0)
    expect(io.outs.join('\n')).toContain('valid — 5 phases in 4 waves')
  })

  it('reports a broken anchor as JSON for an agent, and exits 1', async () => {
    const dir = repo()
    editWorkflow(dir, (doc) => {
      const nodes = doc.nodes as { id: string; prompt_ref: string }[]
      const p2 = nodes.find((node) => node.id === 'p2')
      if (p2 !== undefined) p2.prompt_ref = `${PLAN_FILE}#phase-twelve`
    })
    const io = recordingIo()
    expect(await validateCommand([join(dir, WORKFLOW_FILE), '--repo', dir, '--json'], io)).toBe(1)
    const report = JSON.parse(io.outs[0] ?? '{}') as { ok: boolean; issues: unknown[] }
    expect(report.ok).toBe(false)
    expect(report.issues).toEqual([
      {
        source: 'reference',
        path: 'nodes[1].prompt_ref',
        message: `no heading in ${PLAN_FILE} matches "#phase-twelve"`,
      },
    ])
  })

  it('refuses a file not named <id>.workflow.json, and a bad command line', async () => {
    const dir = repo()
    const renamed = join(dir, 'ai-plans', 'plan.json')
    cpSync(join(dir, WORKFLOW_FILE), renamed)
    expect(await validateCommand([renamed, '--repo', dir], recordingIo())).toBe(1)
    expect(await validateCommand([], recordingIo())).toBe(2)
  })
})

describe('vinta-ai-maestro review', () => {
  /** A clock that moves only when the command sleeps. */
  function virtualClock(start = Date.parse(T0)) {
    let now = start
    return { now: () => now, sleep: async (ms: number) => void (now += ms) }
  }

  it('times out with a JSON line the agent can loop on', async () => {
    const dir = repo()
    const io = recordingIo()
    const clock = virtualClock()
    expect(
      await reviewCommand(['wait', join(dir, WORKFLOW_FILE), '--repo', dir, '--timeout', '2'], io, clock),
    ).toBe(0)
    expect(JSON.parse(io.outs[0] ?? '{}')).toMatchObject({ kind: 'timeout', workflow_id: ID, messages: [] })
  })

  it('hands over what the person sent, spelled out, and marks it delivered', async () => {
    const dir = repo()
    const store = storeIn(dir)
    store.update((review) =>
      addComment(
        review,
        {
          anchor: { kind: 'prompt', node: 'p2', role: 'fixer' },
          body: 'make it check the flag-off path',
          quote: 'Read the gate’s output before the code',
          author: HUMAN,
        },
        T0,
      ),
    )
    store.update((review) => postMessage(review, { body: 'two things', author: HUMAN, send: 'unsent' }, T0))

    const io = recordingIo()
    expect(await reviewCommand(['wait', join(dir, WORKFLOW_FILE), '--repo', dir], io, virtualClock())).toBe(0)
    const handed = JSON.parse(io.outs[0] ?? '{}')
    expect(handed).toMatchObject({
      kind: 'messages',
      review_path: `ai-plans/${ID}.review.json`,
      messages: [
        {
          id: 'm1',
          body: 'two things',
          comments: [
            {
              id: 'c1',
              where: 'the fixer prompt of phase p2',
              quote: 'Read the gate’s output before the code',
              body: 'make it check the flag-off path',
            },
          ],
        },
      ],
    })
    const after = store.read()
    if (!after.ok) throw new Error('expected a review')
    expect(undelivered(after.review)).toEqual([])
  })

  it('says "approved" when the last thing the person did was approve', async () => {
    const dir = repo()
    storeIn(dir).update((review) => approve(review, HUMAN, T0))
    const io = recordingIo()
    await reviewCommand(['wait', join(dir, WORKFLOW_FILE), '--repo', dir], io, virtualClock())
    expect(JSON.parse(io.outs[0] ?? '{}')).toMatchObject({ kind: 'approved', status: 'approved' })
  })

  it('replies in the chat and on a thread, resolving it, as the agent', async () => {
    const dir = repo()
    const store = storeIn(dir)
    store.update((review) => addComment(review, { anchor: { kind: 'plan' }, body: 'x', author: HUMAN }, T0))
    const workflow = join(dir, WORKFLOW_FILE)
    expect(await reviewCommand(['reply', workflow, '--repo', dir, '-m', 'On it.', '--as', 'codex'], recordingIo())).toBe(0)
    expect(
      await reviewCommand(
        ['reply', workflow, '--repo', dir, '--comment', 'c1', '--resolve', '-m', 'Done in Phase 2.'],
        recordingIo(),
      ),
    ).toBe(0)
    const read = store.read()
    if (!read.ok) throw new Error('expected a review')
    expect(read.review.conversation.at(-1)).toMatchObject({ body: 'On it.', author: { kind: 'agent', name: 'codex' } })
    expect(read.review.comments[0]).toMatchObject({ status: 'resolved', replies: [{ author: { kind: 'agent' } }] })

    expect(
      await reviewCommand(['reply', workflow, '--repo', dir, '--comment', 'c9', '-m', 'x'], recordingIo()),
    ).toBe(1)
    expect(await reviewCommand(['reply', workflow, '--resolve', '-m', 'x'], recordingIo())).toBe(2)
  })

  it('names every anchor in words', () => {
    expect(describeAnchor({ kind: 'plan' })).toBe('the plan as a whole')
    expect(describeAnchor({ kind: 'section', section: '2-guiding-decisions', heading: '2. Guiding Decisions' })).toBe(
      'plan section "2. Guiding Decisions" (#2-guiding-decisions)',
    )
    expect(describeAnchor({ kind: 'gate', gate: 'unit', node: 'p3' })).toBe('gate unit on phase p3')
  })
})

// ---------------------------------------------------------------------------
// The daemon's plan routes
// ---------------------------------------------------------------------------

describe('plan routes', () => {
  const open: { daemon: Daemon; journal: Journal }[] = []
  afterEach(async () => {
    for (const { daemon, journal } of open.splice(0)) {
      await daemon.close()
      journal.close()
    }
  })

  async function serve(dir: string): Promise<Daemon> {
    const journal = openJournal(dir)
    const daemon = await startDaemon({ journal, pollMs: 5, warn: () => {} })
    open.push({ daemon, journal })
    return daemon
  }

  async function call(daemon: Daemon, path: string, init: { method?: string; body?: unknown; token?: string | null } = {}) {
    const token = init.token === undefined ? daemon.token : init.token
    const response = await fetch(`${daemon.url}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    return { status: response.status, body: (await response.json()) as unknown }
  }

  it('lists plans and serves one with its prompts, behind the token', async () => {
    const daemon = await serve(repo())
    expect((await call(daemon, '/api/plans', { token: null })).status).toBe(401)

    const list = PlanListResponseSchema.parse((await call(daemon, '/api/plans')).body)
    expect(list.plans).toEqual([
      {
        id: ID,
        title: 'Bookmark Folders — Implementation Plan',
        planRef: PLAN_FILE,
        phases: 5,
        valid: true,
        status: 'open',
        openComments: 0,
        unsentComments: 0,
      },
    ])

    const view = PlanViewResponseSchema.parse((await call(daemon, `/api/plans/${ID}`)).body)
    expect(view.phases.p1?.prompts.implementer).toContain('BookmarkFolder')
    expect(view.stamp).not.toBe('')
    expect((await call(daemon, '/api/plans/..%2F..%2Fetc')).status).toBe(404)
    expect((await call(daemon, '/api/plans/nope')).status).toBe(404)
  })

  it('records a person’s comments, sends them, and approves — always as the person', async () => {
    const dir = repo()
    const daemon = await serve(dir)
    const base = `/api/plans/${ID}`

    const commented = await call(daemon, `${base}/comments`, {
      method: 'POST',
      body: { anchor: { kind: 'gate', gate: 'unit', node: 'p2' }, body: 'needs the e2e suite too' },
    })
    expect(commented.status).toBe(200)
    expect(PlanReviewResponseSchema.parse(commented.body).review.comments[0]?.author).toEqual({ kind: 'human' })

    // An author in the body is a typo the strict schema refuses, not an override.
    const spoofed = await call(daemon, `${base}/comments`, {
      method: 'POST',
      body: { anchor: { kind: 'plan' }, body: 'x', author: { kind: 'agent' } },
    })
    expect(spoofed.status).toBe(400)

    const sent = PlanReviewResponseSchema.parse(
      (await call(daemon, `${base}/messages`, { method: 'POST', body: { body: '', send: 'unsent' } })).body,
    )
    expect(sent.review.conversation[0]?.comment_ids).toEqual(['c1'])
    expect(sent.presence).toEqual({ state: 'away', lastSeenAt: null })
    expect((await call(daemon, `${base}/comments/c1`, { method: 'DELETE' })).status).toBe(409)
    expect((await call(daemon, `${base}/comments/c7/status`, { method: 'PUT', body: { status: 'resolved' } })).status).toBe(404)

    const approved = PlanReviewResponseSchema.parse(
      (await call(daemon, `${base}/approve`, { method: 'POST', body: {} })).body,
    )
    expect(approved.review.status).toBe('approved')
    expect((await call(daemon, `${base}/approve`, { method: 'POST', body: {} })).status).toBe(409)

    const onDisk = JSON.parse(readFileSync(join(dir, 'ai-plans', `${ID}.review.json`), 'utf8')) as PlanReview
    expect(onDisk.status).toBe('approved')
  })

  it('moves the stamp when the agent edits the plan, so the page re-reads it', async () => {
    const dir = repo()
    const daemon = await serve(dir)
    const before = PlanReviewResponseSchema.parse((await call(daemon, `/api/plans/${ID}/review`)).body).stamp
    const plan = join(dir, PLAN_FILE)
    writeFileSync(plan, `${readFileSync(plan, 'utf8')}\n<!-- edited -->\n`, 'utf8')
    const after = PlanReviewResponseSchema.parse((await call(daemon, `/api/plans/${ID}/review`)).body).stamp
    expect(after).not.toBe(before)
  })

  it('projects the plan’s schedule without running anything', async () => {
    const daemon = await serve(repo())
    const result = await call(daemon, `/api/plans/${ID}/schedule`)
    expect(result.status).toBe(200)
    const body = result.body as { status: string; criticalPath: string[]; nodes: unknown[] }
    expect(body.status).toBe('completed')
    expect(body.nodes).toHaveLength(5)
    expect(body.criticalPath.at(-1)).toBe('p5')
  })
})
