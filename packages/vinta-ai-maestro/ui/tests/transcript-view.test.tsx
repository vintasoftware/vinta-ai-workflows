/**
 * Where the transcript box is scrolled to.
 *
 * Rendered directly rather than through the app: the behaviour under test is
 * about scroll offsets, and jsdom gives every element a height of zero, so the
 * box has to be given a size by hand. Through the app there would be nowhere
 * to put one.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { Transcript } from '../src/Transcript.tsx'

afterEach(cleanup)

/** jsdom lays nothing out; a scroller needs a height to have a bottom. */
function size(box: HTMLElement, { content, view }: { content: number; view: number }): void {
  Object.defineProperty(box, 'scrollHeight', { value: content, configurable: true })
  Object.defineProperty(box, 'clientHeight', { value: view, configurable: true })
}

const lines = (count: number): readonly unknown[] =>
  Array.from({ length: count }, (_, index) => ({ type: 'assistant_text', text: `line ${index}` }))

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
