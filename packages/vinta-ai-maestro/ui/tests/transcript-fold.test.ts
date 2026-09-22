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
 * A phase runs its chores one after another, on the same slot, as the same
 * role. Banded on the role alone they would read as one long turn by somebody
 * called Chore — which is the problem attribution was added to solve, one level
 * down.
 */
test('a chore turn says which chore it was', () => {
  const view = present({
    type: 'assistant_text',
    text: 'rewrote four comments',
    by: { role: 'chore', slot: 'main', chore: 'deslop' },
  })

  expect(view.role).toBe('chore')
  expect(view.chore).toBe('deslop')
})

test('a change of chore breaks a thinking group, even under one role', () => {
  const chore = (id: string, entry: unknown): unknown => ({
    ...(entry as object),
    by: { role: 'chore', slot: 'main', chore: id },
  })
  const rows = fold([chore('deslop', thinking('a')), chore('changelog', thinking('b'))], 0)

  expect(rows).toHaveLength(2)
  expect(rows.map((row) => row.chore)).toEqual(['deslop', 'changelog'])
})

test('every other role carries no chore', () => {
  expect(present(by('reviewer', said('VERDICT: pass'))).chore).toBeNull()
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

/**
 * The monitor's intervention proposal, which reached the operator's
 * conversation as the JSON its schema demands.
 *
 * It is journalled there on purpose — a run that retuned itself should say so
 * where a person is already looking — and the consequence was that the useful
 * part, the summary paragraph, arrived a thousand characters into one unwrapped
 * line of braces. The document is the record's; the row is the reader's.
 */
const proposed = (body: unknown): unknown => ({
  type: 'assistant_text',
  text: JSON.stringify(body),
  by: { role: 'monitor' },
})

test('an intervention proposal reads as what it says', () => {
  const view = present(
    proposed({
      schema_version: 1,
      summary: 'The unit gate rebuilds its database on every run.',
      changes: [
        {
          verb: 'retune_gate',
          gate: 'unit',
          cmd: 'pytest --reuse-db',
          evidence: 'unit.log line 3: Creating test database…',
        },
      ],
    }),
  )

  expect(view.kind).toBe('intervention')
  expect(view.shape).toBe('prose')
  expect(view.label).toBe('Proposal')
  // Something was proposed about a live run, so the row carries a dot.
  expect(view.tone).toBe('attention')
  expect(view.body).toContain('The unit gate rebuilds its database on every run.')
  expect(view.body).toContain('Proposed 1 change:')
  expect(view.body).toContain('1. Gate unit — run: pytest --reuse-db')
  expect(view.body).toContain('Evidence: unit.log line 3')
  // And none of the punctuation it was carried in.
  expect(view.body).not.toContain('schema_version')
  expect(view.body).not.toContain('"verb"')
})

/**
 * The expected outcome, and the one the tone must not shout about: a monitor
 * that looked and found the run fine. `intervention.ts` says twice that empty
 * `changes` is a real answer — a dot on every one of them would spend the
 * signal on the case that needs no attention at all.
 */
test('a proposal that changes nothing says so, quietly', () => {
  const view = present(
    proposed({ schema_version: 1, summary: 'Both phases are doing hard work.', changes: [] }),
  )

  expect(view.body).toContain('Both phases are doing hard work.')
  expect(view.body).toContain('Proposed no changes.')
  expect(view.tone).toBe(null)
})

/** The brief forbids a code fence and the model writes one anyway. */
test('a fenced proposal is still a proposal', () => {
  const body = JSON.stringify({ schema_version: 1, summary: 'Nothing to change.', changes: [] })
  const view = present({ type: 'assistant_text', text: `\`\`\`json\n${body}\n\`\`\`` })

  expect(view.kind).toBe('intervention')
  expect(view.body).toContain('Nothing to change.')
})

/** Every verb gets a sentence. A table keyed on the daemon's union guarantees it. */
test('each verb renders as a sentence', () => {
  const view = present(
    proposed({
      schema_version: 1,
      summary: 'Three adjustments.',
      changes: [
        { verb: 'retime_gate', gate: 'e2e', timeout_s: 3600, evidence: 'killed at its ceiling' },
        { verb: 'rebudget_fixes', node: 'p1', max_fix_rounds: 4, evidence: 'three rounds of drift' },
        { verb: 'retier_phase', node: 'p2', model: 'opus-5', evidence: 'no precedent in this repo' },
      ],
    }),
  )

  expect(view.body).toContain('Proposed 3 changes:')
  expect(view.body).toContain('1. Gate e2e — time out after 3600s')
  expect(view.body).toContain('2. Phase p1 — 4 fix rounds')
  expect(view.body).toContain('3. Phase p2 — run on opus-5')
})

/**
 * A verb this build has not heard of still gets a row, for the reason an
 * unparsed entry does: a record that silently drops what happened lies.
 */
test('a verb from a newer daemon is shown rather than dropped', () => {
  const view = present(
    proposed({
      schema_version: 1,
      summary: 'One change.',
      changes: [{ verb: 'reheat_gate', gate: 'unit', degrees: 11, evidence: 'it was cold' }],
    }),
  )

  expect(view.body).toContain('1. reheat_gate —')
  expect(view.body).toContain('"gate":"unit"')
  expect(view.body).toContain('Evidence: it was cold')
})

/** An answer is prose, and prose that mentions braces is still prose. */
test('an ordinary answer is untouched', () => {
  const view = present(said('It failed because `{` was unbalanced in the fixture.'))

  expect(view.kind).toBe('assistant_text')
  expect(view.body).toBe('It failed because `{` was unbalanced in the fixture.')
})

/**
 * Not every JSON answer is a proposal — an older intervention, or a model that
 * replied in JSON when nobody asked it to. Indenting is not much, but it is the
 * difference between a paragraph of braces and something a person can skim.
 */
test('any other JSON answer is at least indented', () => {
  const view = present(said('{"verdict":"unclear","looked_at":["p0","p1"]}'))

  expect(view.kind).toBe('assistant_text')
  expect(view.body).toContain('\n  "verdict": "unclear"')
})

/**
 * Two proposals in a row are two proposals. `assistant_text` groups, because a
 * streamed answer arrives in pieces and means one thing; a document does not.
 */
test('proposals do not fold into each other', () => {
  const one = proposed({ schema_version: 1, summary: 'First look.', changes: [] })
  const rows = fold([one, one], 0)

  expect(rows).toHaveLength(2)
})
