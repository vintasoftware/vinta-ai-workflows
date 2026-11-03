/**
 * Where the transcript box is scrolled to.
 *
 * Rendered directly rather than through the app: the behaviour under test is
 * about scroll offsets, and jsdom gives every element a height of zero, so the
 * box has to be given a size by hand. Through the app there would be nowhere
 * to put one.
 */
import { cleanup, fireEvent, render, type RenderResult } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { Transcript, TRANSCRIPT_WINDOW } from '../src/Transcript.tsx'

afterEach(cleanup)

/** jsdom lays nothing out; a scroller needs a height to have a bottom. */
function size(box: HTMLElement, { content, view }: { content: number; view: number }): void {
  Object.defineProperty(box, 'scrollHeight', { value: content, configurable: true })
  Object.defineProperty(box, 'clientHeight', { value: view, configurable: true })
}

/**
 * The same, for a test that needs the content to *grow* when rows are added.
 * A fixed `scrollHeight` cannot show what prepending sixty rows does to the
 * reader's position, which is the whole subject of the anchoring test.
 */
function sizeByRows(box: HTMLElement, { row, view }: { row: number; view: number }): void {
  Object.defineProperty(box, 'scrollHeight', {
    get: () => box.querySelectorAll('li').length * row,
    configurable: true,
  })
  Object.defineProperty(box, 'clientHeight', { value: view, configurable: true })
}

const lines = (count: number): readonly unknown[] =>
  Array.from({ length: count }, (_, index) => ({ type: 'assistant_text', text: `line ${index}` }))

/**
 * The same count, as entries that do not fold into each other.
 *
 * Consecutive prose from one author is one row by design (`transcript.ts`'s
 * `GROUPED`), so `lines(100)` is a hundred entries and a single `li`. The tests
 * below that measure the list's *geometry* need one row per entry, and a tool
 * result is the cheapest entry that never groups.
 */
const rowsOf = (count: number): readonly unknown[] =>
  Array.from({ length: count }, (_, index) => ({
    type: 'tool_result',
    id: `t${index}`,
    ok: true,
    summary: `line ${index}`,
  }))

const boxOf = (view: RenderResult): HTMLElement =>
  view.container.querySelector('.entries') as HTMLElement

/**
 * `fireEvent` rather than a bare `dispatchEvent`, because the handler now sets
 * state as well as a ref — the button that offers the way back has to render —
 * and only the wrapped form flushes that before the next assertion reads it.
 */
const scrollTo = (box: HTMLElement, top: number): void => {
  box.scrollTop = top
  fireEvent.scroll(box)
}

test('a new entry scrolls the box to the newest row', () => {
  const view = render(<Transcript entries={lines(8)} />)
  const box = view.container.querySelector('.entries') as HTMLElement
  size(box, { content: 2_000, view: 480 })

  view.rerender(<Transcript entries={lines(9)} />)

  expect(box.scrollTop).toBe(2_000)
})

/**
 * An operator who has scrolled up is reading. Following them back down to a
 * row they did not ask for loses their place mid-sentence, which is worse than
 * the problem the following exists to fix.
 */
test('an operator who has scrolled away is left where they are', () => {
  const view = render(<Transcript entries={lines(8)} />)
  const box = view.container.querySelector('.entries') as HTMLElement
  size(box, { content: 2_000, view: 480 })

  // 900 from the top of a 2000px column: nowhere near the bottom.
  box.scrollTop = 900
  box.dispatchEvent(new Event('scroll', { bubbles: true }))
  view.rerender(<Transcript entries={lines(9)} />)

  expect(box.scrollTop).toBe(900)
})

/** Scrolling back to the bottom opts back in, without a button to press. */
test('returning to the bottom resumes following', () => {
  const view = render(<Transcript entries={lines(8)} />)
  const box = view.container.querySelector('.entries') as HTMLElement
  size(box, { content: 2_000, view: 480 })

  box.scrollTop = 900
  box.dispatchEvent(new Event('scroll', { bubbles: true }))
  box.scrollTop = 1_520
  box.dispatchEvent(new Event('scroll', { bubbles: true }))
  view.rerender(<Transcript entries={lines(9)} />)

  expect(box.scrollTop).toBe(2_000)
})

/**
 * The bug the three tests above could not see, because all three stop at nine
 * entries.
 *
 * The number of rows *shown* is `min(entries.length, TRANSCRIPT_WINDOW)`, so it
 * stops changing the moment the transcript outgrows one window. An effect keyed
 * on it therefore followed perfectly up to entry sixty and then never again —
 * not on the next entry, and not after the operator scrolled back to the bottom
 * to ask for it. Which is exactly what a long-running phase does at minute two.
 */
test('following survives a transcript longer than the window', () => {
  const view = render(<Transcript entries={lines(TRANSCRIPT_WINDOW)} />)
  const box = boxOf(view)
  size(box, { content: 2_000, view: 480 })
  // Not a scroll event: nothing here is the operator scrolling away, so the
  // following is still on and the next entry must be followed to.
  box.scrollTop = 0

  view.rerender(<Transcript entries={lines(TRANSCRIPT_WINDOW + 1)} />)

  expect(box.scrollTop).toBe(2_000)
})

/**
 * "Show earlier" prepends rows, so holding `scrollTop` moves the reader up the
 * page by exactly the height of what arrived. What has to stay fixed is the
 * distance to the *bottom* of the content — the one measurement prepending
 * leaves alone.
 */
test('growing the window leaves the reader on the row they were reading', () => {
  const view = render(<Transcript entries={rowsOf(100)} />)
  const box = boxOf(view)
  sizeByRows(box, { row: 50, view: 500 })

  // 60 rows of 50px is 3000 tall. Parked in the middle: following off, and far
  // enough from the top that asking for earlier rows is a decision, not a side
  // effect of the scroll.
  scrollTo(box, 1_200)
  expect(box.scrollHeight).toBe(3_000)

  fireEvent.click(view.container.querySelector('[data-action="show-earlier"]')!)

  // All 100 rows now: 5000 tall, and the same 1800px from the bottom.
  expect(box.scrollHeight).toBe(5_000)
  expect(box.scrollTop).toBe(3_200)
})

/**
 * An implicit rule needs an explicit escape. A 60px band at the bottom of a
 * scroller is not a control, and it was the only way back into following.
 */
test('a reader who has scrolled away is offered the way back', () => {
  const view = render(<Transcript entries={lines(8)} />)
  const box = boxOf(view)
  size(box, { content: 2_000, view: 480 })
  expect(view.container.querySelector('[data-action="jump-latest"]')).toBeNull()

  scrollTo(box, 900)
  const jump = view.container.querySelector('[data-action="jump-latest"]')
  expect(jump).not.toBeNull()

  fireEvent.click(jump!)

  expect(box.scrollTop).toBe(2_000)
  expect(view.container.querySelector('[data-action="jump-latest"]')).toBeNull()
  // And it is following again, not merely scrolled to the bottom once — proven
  // with a position the click did not leave behind.
  box.scrollTop = 0
  view.rerender(<Transcript entries={lines(9)} />)
  expect(box.scrollTop).toBe(2_000)
})

// ---------------------------------------------------------------------------
// Density: what a row costs before you open it
// ---------------------------------------------------------------------------

const thought = (text: string): unknown => ({ type: 'thinking', text })
const call = (command: string): unknown => ({
  type: 'tool_use',
  name: 'Bash',
  id: `t-${command}`,
  input: { command },
})

const shapesOf = (view: RenderResult): string[] =>
  [...view.container.querySelectorAll('li')].map((row) => row.dataset['shape'] ?? '')

const openRows = (view: RenderResult): string[] =>
  [...view.container.querySelectorAll<HTMLElement>('li[data-open]')].map(
    (row) => row.dataset['shape'] ?? '',
  )

/**
 * The complaint this answers: a transcript where the agent's answer, its
 * private reasoning and four hundred characters of JSON all render as the same
 * two lines at the same weight, so the useful rows are the hardest to find.
 */
test('thinking and tool calls arrive folded, prose does not', () => {
  const view = render(
    <Transcript entries={[thought('hmm'), call('pnpm test'), { type: 'assistant_text', text: 'done' }]} />,
  )

  expect(shapesOf(view)).toEqual(['thinking', 'tool', 'prose'])
  expect(openRows(view)).toEqual(['prose'])
  // Folded, but not silent: the row still says what the call was.
  expect(view.container.querySelector('li[data-shape="tool"] [data-headline]')?.textContent).toBe(
    'pnpm test',
  )
})

/** One chevron opens one row, and leaves its neighbours alone. */
test('a row opens on its own', () => {
  const view = render(<Transcript entries={[call('pnpm test'), call('pnpm lint')]} />)

  const first = view.container.querySelector('li[data-entry="0"] [data-action="toggle-entry"]')!
  fireEvent.click(first)

  expect(view.container.querySelector('li[data-entry="0"]')?.hasAttribute('data-open')).toBe(true)
  expect(view.container.querySelector('li[data-entry="1"]')?.hasAttribute('data-open')).toBe(false)
  expect(first.getAttribute('aria-expanded')).toBe('true')
})

/** The header control is for "show me all of this now". */
test('the header opens every row of one kind and leaves the other kind folded', () => {
  const view = render(<Transcript entries={[thought('hmm'), call('pnpm test'), call('pnpm lint')]} />)

  fireEvent.click(view.container.querySelector('[data-action="fold-tool"]')!)

  expect(openRows(view)).toEqual(['tool', 'tool'])

  fireEvent.click(view.container.querySelector('[data-action="fold-thinking"]')!)

  expect(openRows(view)).toEqual(['thinking', 'tool', 'tool'])
})

/**
 * A bulk toggle is a reset. Honouring a row the operator closed by hand three
 * minutes ago, underneath a button that just said "open all of these", would
 * make the button lie about what it did.
 */
test('a header toggle clears the rows opened by hand', () => {
  const view = render(<Transcript entries={[call('pnpm test'), call('pnpm lint')]} />)

  fireEvent.click(view.container.querySelector('li[data-entry="0"] [data-action="toggle-entry"]')!)
  expect(openRows(view)).toEqual(['tool'])

  // On, then off: back where it started, with no row left open by the override.
  fireEvent.click(view.container.querySelector('[data-action="fold-tool"]')!)
  fireEvent.click(view.container.querySelector('[data-action="fold-tool"]')!)

  expect(openRows(view)).toEqual([])
})

/** Twelve events, one thought, one chevron. */
test('a streamed thought is one row', () => {
  const view = render(
    <Transcript entries={Array.from({ length: 12 }, (_, index) => thought(`part ${index}`))} />,
  )

  expect(view.container.querySelectorAll('li')).toHaveLength(1)
  expect(view.container.querySelectorAll('[data-action="toggle-entry"]')).toHaveLength(1)

  fireEvent.click(view.container.querySelector('[data-action="toggle-entry"]')!)

  const body = view.container.querySelector('.entry-body')?.textContent ?? ''
  expect(body).toContain('part 0')
  expect(body).toContain('part 11')
})

/**
 * An agent writes markdown. It used to render as the asterisks and backticks,
 * which is most of what made a transcript hard to read.
 */
test('an agent’s answer renders as the markdown it is', () => {
  const view = render(
    <Transcript
      entries={[
        {
          type: 'assistant_text',
          text: '## Plan\n\n- read `src/a.ts`\n- run the suite\n\n```ts\nconst a = 1\n```',
        },
      ]}
    />,
  )

  const body = view.container.querySelector('.entry-body')!
  expect(body.querySelector('h2')?.textContent).toBe('Plan')
  expect(body.querySelectorAll('li')).toHaveLength(2)
  expect(body.querySelector('li code')?.textContent).toBe('src/a.ts')
  // A fenced block is a code block, highlighted as what the fence said.
  expect(body.querySelector('pre.code')?.getAttribute('data-lang')).toBe('ts')
  expect(body.querySelector('pre.code')?.textContent).toContain('const a = 1')
  // And the asterisks are gone.
  expect(body.textContent).not.toContain('##')
})

/** Raw HTML in an answer is text. Repository content never becomes markup (§11). */
test('markup in an answer is shown, not rendered', () => {
  const view = render(
    <Transcript entries={[{ type: 'assistant_text', text: 'see <img src=x onerror=alert(1)> here' }]} />,
  )

  expect(view.container.querySelector('.entry-body img')).toBe(null)
})

/** The operator's own words are set apart, the way a chat sets the reader's side apart. */
test('the operator’s message is set apart from the agent’s', () => {
  const view = render(<Transcript entries={[{ type: 'user_message', text: 'prefer a migration' }]} />)

  const row = view.container.querySelector('li[data-kind="user_message"]')!
  expect([...row.classList]).toContain('entry-operator')
  expect(row.querySelector('.entry-body')?.textContent).toContain('prefer a migration')
})

/**
 * An edit, opened, is a diff: the two strings the harness was given, one red
 * and one green, highlighted as the file's language. The row itself carries
 * the size of the change.
 */
test('an edit opens into a diff of its two sides', () => {
  const view = render(
    <Transcript
      entries={[
        {
          type: 'tool_use',
          name: 'Edit',
          id: 'e1',
          input: { file_path: 'src/a.ts', old_string: 'const a = 1', new_string: 'const a = 2\nconst b = 3' },
        },
        { type: 'tool_result', id: 'e1', ok: true, summary: 'The file has been updated.' },
      ]}
    />,
  )

  const row = view.container.querySelector('li[data-kind="tool_use"]')!
  expect(row.querySelector('.entry-author')?.textContent).toBe('Edit')
  expect(row.querySelector('[data-headline]')?.textContent).toBe('src/a.ts')
  expect(row.querySelector('[data-counts]')?.textContent).toBe('+2−1')
  expect(row.querySelector('[data-result]')?.getAttribute('data-tone')).toBe('ok')

  fireEvent.click(row.querySelector('[data-action="toggle-entry"]')!)

  const lines = [...row.querySelectorAll('[data-edit] tr[data-line]')]
  expect(lines.map((line) => line.getAttribute('data-line'))).toEqual(['del', 'add', 'add'])
  expect(lines[0]?.textContent).toContain('const a = 1')
  expect(lines[2]?.textContent).toContain('const b = 3')
  // What the tool said back, under the diff.
  expect(row.querySelector('[data-output]')?.textContent).toBe('The file has been updated.')
})

/** A shell call opens into the command and what it printed. */
test('a shell call opens into its command and output', () => {
  const view = render(
    <Transcript
      entries={[
        call('pnpm test'),
        { type: 'tool_result', id: 't-pnpm test', ok: false, summary: 'FAIL src/a.test.ts\n  2 failing' },
      ]}
    />,
  )

  const row = view.container.querySelector('li[data-kind="tool_use"]')!
  expect(row.querySelector('.entry-author')?.textContent).toBe('Shell')
  fireEvent.click(row.querySelector('[data-action="toggle-entry"]')!)

  expect(row.querySelector('[data-command]')?.textContent).toContain('pnpm test')
  expect(row.querySelector('[data-command]')?.getAttribute('data-lang')).toBe('bash')
  expect(row.querySelector('[data-output]')?.textContent).toContain('2 failing')
  expect([...(row.querySelector('[data-output]')?.classList ?? [])]).toContain('border-tone-error')
})

/** Reading is most of what an agent does and the least of what the operator came to see. */
test('a stretch of exploring is one row that opens into its calls', () => {
  const view = render(
    <Transcript
      entries={[
        { type: 'tool_use', name: 'Read', id: 'r1', input: { file_path: 'src/a.ts' } },
        { type: 'tool_result', id: 'r1', ok: true, summary: '40 lines' },
        { type: 'tool_use', name: 'Grep', id: 'g1', input: { pattern: 'invoice', path: 'src' } },
        { type: 'tool_result', id: 'g1', ok: true, summary: '3 matches' },
        { type: 'tool_use', name: 'Read', id: 'r2', input: { file_path: 'src/b.ts' } },
        { type: 'tool_result', id: 'r2', ok: true, summary: '12 lines' },
      ]}
    />,
  )

  expect(view.container.querySelectorAll('li[data-entry]')).toHaveLength(1)
  const row = view.container.querySelector('li[data-group="exploring"]')!
  expect(row.querySelector('.entry-author')?.textContent).toBe('Explored')
  expect(row.querySelector('[data-headline]')?.textContent).toBe('2 reads, 1 search')

  fireEvent.click(row.querySelector('[data-action="toggle-entry"]')!)

  const calls = [...row.querySelectorAll('[data-call]')]
  expect(calls.map((item) => item.getAttribute('data-call'))).toEqual(['r1', 'g1', 'r2'])
  expect(calls[1]?.textContent).toContain('Grep')
  expect(calls[1]?.textContent).toContain('invoice in src')
  expect(calls[2]?.querySelector('[data-result]')?.getAttribute('data-tone')).toBe('ok')
})

// ---------------------------------------------------------------------------
// Whose rows these are
// ---------------------------------------------------------------------------

const from = (role: string, entry: unknown): unknown => ({ ...(entry as object), by: { role } })

const bandsOf = (view: RenderResult): string[] =>
  [...view.container.querySelectorAll<HTMLElement>('[data-turn]')].map(
    (band) => band.dataset['turn'] ?? '',
  )

/**
 * The complaint: a phase's transcript is an implementer, a reviewer and a fix
 * round or three appended to one file in order, and mid-scroll there was no way
 * to tell which of them you were reading.
 */
test('the list says where one agent stops and the next starts', () => {
  const view = render(
    <Transcript
      entries={[
        from('implementer', { type: 'assistant_text', text: 'implemented' }),
        from('reviewer', { type: 'assistant_text', text: 'VERDICT: fail' }),
        from('fixer', { type: 'assistant_text', text: 'fixed' }),
        from('reviewer', { type: 'assistant_text', text: 'VERDICT: pass' }),
        from('gate', { type: 'gate_run', gate: 'unit', exitCode: 0, status: 'passed', cached: false }),
      ]}
    />,
  )

  expect(bandsOf(view)).toEqual(['implementer', 'reviewer', 'fixer', 'reviewer', 'gate'])
  expect(view.container.querySelector('[data-turn="gate"]')?.textContent).toContain('Gate')
})

/** The boundary, not a badge: ninety rows from one agent get one band. */
test('a run of rows from one agent is announced once', () => {
  const view = render(
    <Transcript
      entries={Array.from({ length: 12 }, (_, index) =>
        from('implementer', { type: 'assistant_text', text: `step ${index}` }),
      )}
    />,
  )

  // One band, and — because consecutive prose from one author is one statement
  // — one row holding all twelve.
  expect(bandsOf(view)).toEqual(['implementer'])
  expect(view.container.querySelectorAll('li[data-entry]')).toHaveLength(1)
  expect(view.container.querySelector('.entry-body')?.textContent).toContain('step 11')
})

/** Every transcript recorded before the daemon wrote `by` renders as it did. */
test('an unattributed transcript gets no bands at all', () => {
  const view = render(<Transcript entries={lines(4)} />)

  expect(bandsOf(view)).toEqual([])
  expect(view.container.querySelectorAll('li[data-entry]')).toHaveLength(1)
})

/** A role this build has never heard of shows as itself, not as nothing. */
test('an unknown role is still a band', () => {
  const view = render(
    <Transcript entries={[from('archaeologist', { type: 'assistant_text', text: 'hm' })]} />,
  )

  expect(view.container.querySelector('[data-turn="archaeologist"]')?.textContent).toContain(
    'archaeologist',
  )
})

/**
 * The band is pinned to the top of the scroller — and this test cannot say so.
 *
 * jsdom has no layout engine, so "is it stuck" is unanswerable here: every box
 * is zero high, and `position` changes nothing the DOM will report. That was
 * checked in a browser by hand. What is left for a test is the set of classes
 * without which it silently is *not* stuck, and "silently" is the word that
 * earns the assertion — a band that has lost `bg-card` renders perfectly in
 * every test this suite can run, and in a real browser has the transcript
 * sliding through its letters.
 *
 * `overflow-y-auto` is asserted on the *list*, because that is the whole
 * arrangement rather than a second fact about it: `top-0` resolves against the
 * nearest scrolling ancestor, and the band is a direct child of the one element
 * that scrolls. Move the scroller, or give anything between the two an
 * `overflow`, `transform`, `filter` or `contain`, and the band quietly pins to
 * something else or to nothing.
 */
test('the author band carries what pins it to the scroller', () => {
  const view = render(
    <Transcript
      entries={[
        from('implementer', { type: 'assistant_text', text: 'implemented' }),
        from('reviewer', { type: 'assistant_text', text: 'VERDICT: pass' }),
      ]}
    />,
  )

  const band = view.container.querySelector<HTMLElement>('[data-turn="reviewer"]')!
  for (const pinned of ['sticky', 'top-0', 'z-10', 'bg-card']) {
    expect([...band.classList]).toContain(pinned)
  }

  const list = band.parentElement!
  expect(list.tagName).toBe('OL')
  expect([...list.classList]).toContain('overflow-y-auto')
})
