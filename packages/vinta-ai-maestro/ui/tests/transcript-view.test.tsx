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
  const view = render(<Transcript entries={lines(100)} />)
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
