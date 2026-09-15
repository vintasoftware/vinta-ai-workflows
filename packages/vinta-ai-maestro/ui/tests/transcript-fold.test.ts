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
