/**
 * What a transcript row says before you open it.
 *
 * No DOM here on purpose: everything asserted below is a decision
 * `transcript.ts` makes about *text*, and a rendering test would prove it
 * through two layers that have their own reasons to change.
 */
import { expect, test } from 'vitest'
import { bodyOf, fold, hasMore, headlineOf, present } from '../src/transcript.ts'

const thinking = (text: string): unknown => ({ type: 'thinking', text })
const said = (text: string): unknown => ({ type: 'assistant_text', text })
const used = (name: string, input: unknown): unknown => ({
  type: 'tool_use',
  name,
  id: `t-${name}`,
  input,
})

/**
 * The whole point of the collapsed row. `JSON.stringify` of a structured tool
 * call starts with `{`, so a headline taken off the front of the payload said
 * nothing at all — and said it identically for every tool.
 */
test('a tool call shows the argument that says what it did', () => {
  expect(present(used('Bash', { command: 'pnpm test', timeout: 120_000 })).headline).toBe(
    'pnpm test',
  )
  expect(present(used('Read', { file_path: '/repo/src/index.ts' })).headline).toBe(
    '/repo/src/index.ts',
  )
})

/** A tool nobody here has heard of still gets a line rather than a brace. */
test('an unknown tool falls back to its payload', () => {
  expect(present(used('Weather', { city: 'Recife' })).headline).toBe('{')
  expect(present(used('Weather', 'Recife, please')).headline).toBe('Recife, please')
})

/** A headline is one line. A command with a heredoc in it is still one line. */
test('a headline stops at the first newline', () => {
  const view = present(used('Bash', { command: 'python3 <<EOF\nprint(1)\nEOF' }))
  expect(view.headline).toBe('python3 <<EOF')
  expect(view.body).toContain('print(1)')
})

/**
 * A streamed thought arrives as a dozen events. A dozen separately collapsible
 * rows is not a thought the operator can open; it is twelve chevrons over one
 * paragraph.
 */
test('consecutive thinking folds into one row', () => {
  const rows = fold([thinking('First,'), thinking('then,'), thinking('finally.')], 0)

  expect(rows).toHaveLength(1)
  expect(rows[0]?.shape).toBe('thinking')
  expect(bodyOf(rows[0]!)).toBe('First,\n\nthen,\n\nfinally.')
  expect(headlineOf(rows[0]!)).toBe('First,')
})

/** Grouping is by adjacency, so the sequence that happened is the one shown. */
test('a tool call between two thoughts keeps them apart', () => {
  const rows = fold([thinking('before'), used('Bash', { command: 'ls' }), thinking('after')], 0)

  expect(rows.map((row) => row.shape)).toEqual(['thinking', 'tool', 'thinking'])
})

/** Keys are absolute, so rows already on screen are not remounted by an append. */
test('a row is keyed by its index in the served tail', () => {
  const rows = fold([said('a'), thinking('b'), thinking('c'), said('d')], 40)

  expect(rows.map((row) => row.at)).toEqual([40, 41, 43])
})

/**
 * A chevron that reveals what is already on screen teaches the operator not to
 * trust chevrons.
 */
test('a row whose headline is the whole body has nothing to open', () => {
  const result = (summary: string): unknown => ({ type: 'tool_result', id: 't', ok: true, summary })

  expect(hasMore(fold([result('2 files changed')], 0)[0]!)).toBe(false)
  expect(hasMore(fold([result('2 files changed\n src/a.ts\n src/b.ts')], 0)[0]!)).toBe(true)
  // A tool *call* always has more, even a one-argument one: the headline is the
  // argument and the body is the payload it was pulled out of.
  expect(hasMore(fold([used('Bash', { command: 'ls' })], 0)[0]!)).toBe(true)
})

/** Prose is never folded, and says so by shape rather than by the view's guess. */
test('prose, thinking and tools are three shapes', () => {
  expect(present(said('done')).shape).toBe('prose')
  expect(present(thinking('hmm')).shape).toBe('thinking')
  expect(present(used('Bash', { command: 'ls' })).shape).toBe('tool')
  expect(present({ type: 'tool_result', id: 't', ok: true, summary: 'ok' }).shape).toBe('tool')
  // A permission request is something the operator has to read, not machinery
  // to hide: it is the one `tool`-authored entry that stays prose.
  expect(present({ type: 'permission_request', tool: 'Bash', detail: {} }).shape).toBe('prose')
})

// ---------------------------------------------------------------------------
// Who said it
// ---------------------------------------------------------------------------

const by = (role: string, entry: unknown): unknown => ({ ...(entry as object), by: { role } })

/**
 * The scheduler appends to `state.node.id` for every spawn whatever the role, so
 * a phase's transcript already held the implementer, the reviewer and every fix
 * round, in order and indistinguishable. The role was in scope at the append and
 * simply not written down.
 */
test('an entry says which agent produced it', () => {
  const view = present(by('reviewer', said('VERDICT: fail')))

  expect(view.role).toBe('reviewer')
  expect(view.body).toBe('VERDICT: fail')
})

test('a slot rides along when the turn ran on one', () => {
  const view = present({ type: 'assistant_text', text: 'done', by: { role: 'fixer', slot: 'main' } })

  expect(view.role).toBe('fixer')
  expect(view.slot).toBe('main')
})

/**
 * `by` is a sibling key the daemon only started writing recently. Every line of
 * every run before that lacks it, and an old transcript has to read as a
 * transcript rather than as an error — which is the whole reason it is a sibling
 * and not an envelope.
 */
test('an entry written before attribution existed still renders', () => {
  const view = present(said('from an older run'))

  expect(view.role).toBeNull()
  expect(view.slot).toBeNull()
  expect(view.body).toBe('from an older run')
  expect(view.kind).toBe('assistant_text')
})

/** A `by` that is there but malformed is not worth failing a row over. */
test('an unreadable attribution reads as none', () => {
  expect(present({ type: 'assistant_text', text: 'x', by: 'reviewer' }).role).toBeNull()
  expect(present({ type: 'assistant_text', text: 'x', by: { slot: 'main' } }).role).toBeNull()
})

/** Two agents thinking in sequence is two thoughts, not one. */
test('a change of author breaks a thinking group', () => {
  const rows = fold(
    [by('implementer', thinking('mine')), by('reviewer', thinking('theirs'))],
    0,
  )

  expect(rows).toHaveLength(2)
  expect(rows.map((row) => row.role)).toEqual(['implementer', 'reviewer'])
})

test('one author’s consecutive thinking still folds', () => {
  const rows = fold([by('fixer', thinking('a')), by('fixer', thinking('b'))], 0)

  expect(rows).toHaveLength(1)
  expect(rows[0]?.role).toBe('fixer')
})

/**
 * Gates were the one thing missing from a phase's transcript entirely: four
 * agents' output in order, and no sign of the thing that judged them.
 */
test('a gate run is a row, carrying identifiers and an exit code', () => {
  const view = present({
    type: 'gate_run',
    gate: 'unit',
    exitCode: 1,
    status: 'failed',
    cached: false,
    by: { role: 'gate' },
  })

  expect(view.kind).toBe('gate_run')
  expect(view.role).toBe('gate')
  expect(view.label).toContain('unit')
  expect(view.tone).toBe('error')
  // Never folded: the verdict is what the rest of the phase turns on.
  expect(view.shape).toBe('prose')
})

test('a cached gate does not claim to have run', () => {
  const view = present({
    type: 'gate_run',
    gate: 'lint',
    exitCode: 0,
    status: 'passed',
    cached: true,
    by: { role: 'gate' },
  })

  expect(view.tone).toBe('ok')
  expect(view.body).toContain('cached')
})

/**
 * §7, in the one place it is easy to lose. Steering does not arrive out of band:
 * the adapter injects it and echoes it back as a `user_message` on the agent's
 * own event stream, so it reaches the append inside the same loop as everything
 * the model said. Stamping the loop's role would file the operator's words under
 * the implementer that received them.
 */
test('the operator’s steering is never the agent’s', () => {
  const view = present({ type: 'user_message', text: 'prefer a migration', by: { role: 'operator' } })

  expect(view.role).toBe('operator')
  expect(view.author).toBe('operator')
  expect(view.label).toContain('Operator')
})

/**
 * A band above the row already names the author, so the row does not repeat it.
 * An *un*attributed row still has to say it, because nothing else will.
 */
test('an attributed row stops repeating who it is', () => {
  expect(present(said('done')).label).toBe('Agent')
  expect(present(by('implementer', said('done'))).label).toBe('')

  expect(present(thinking('hmm')).label).toBe('Agent · thinking')
  expect(present(by('reviewer', thinking('hmm'))).label).toBe('thinking')

  // Labels that describe the *event* stay useful under any band.
  expect(present(by('fixer', used('Bash', { command: 'ls' }))).label).toBe('Tool · Bash')
})
