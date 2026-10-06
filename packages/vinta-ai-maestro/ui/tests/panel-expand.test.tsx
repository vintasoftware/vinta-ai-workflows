/**
 * The expand control, which until now did two different wrong things.
 *
 * On the run view it swapped a third of a grid row for a whole one — more
 * room, still a strip. On the node view, where the panels sit inside a flex
 * column rather than a grid, `col-span-full` matched nothing and the button
 * changed only the height of the scroller inside. A control that silently does
 * nothing on one of the two screens that offer it is worse than no control, and
 * neither behaviour was covered by a test.
 *
 * The assertions below are about *where the panel is in the document*, because
 * that is the part a rendering test can actually settle: jsdom has no layout
 * engine, so nothing here can prove the overlay covers the page. What it can
 * prove is that the panel left the box that would have clipped it.
 */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { Panel } from '../src/Panel.tsx'

afterEach(cleanup)

const panel = () =>
  render(
    <div style={{ overflow: 'auto' }}>
      <Panel title="Transcript" expandable data-probe>
        <p>the content</p>
      </Panel>
    </div>,
  )

const expandButton = (): HTMLElement =>
  document.body.querySelector('[data-action="expand"]') as HTMLElement

const card = (): HTMLElement => document.body.querySelector('[data-probe]') as HTMLElement

test('a collapsed panel stays where it was rendered', () => {
  const view = panel()

  expect(view.container.querySelector('[data-probe]')).not.toBeNull()
  expect(card().hasAttribute('data-expanded')).toBe(false)
})

/**
 * The node view nests its panels inside scrolling containers, and an overlay is
 * clipped by any of them. Leaving the render tree for `document.body` is what
 * makes "full page" mean the page.
 */
test('expanding lifts the panel out of the box that would clip it', () => {
  const view = panel()

  fireEvent.click(expandButton())

  expect(card().hasAttribute('data-expanded')).toBe(true)
  expect(view.container.querySelector('[data-probe]')).toBeNull()
  expect(card().parentElement).toBe(document.body)
  // The content came with it — a portal that left the children behind would
  // render an empty overlay over a page that still had the panel on it.
  expect(card().textContent).toContain('the content')
})

/** The same button, wearing the other icon, puts it back. */
test('collapsing returns the panel to the page', () => {
  const view = panel()

  fireEvent.click(expandButton())
  expect(expandButton().getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(expandButton())

  expect(view.container.querySelector('[data-probe]')).not.toBeNull()
  expect(card().hasAttribute('data-expanded')).toBe(false)
})

/**
 * An overlay covers its own trigger, so a keyboard user who cannot find the
 * button again is stuck in it.
 */
test('escape closes the full-page view', () => {
  const view = panel()

  fireEvent.click(expandButton())
  fireEvent.keyDown(document, { key: 'Escape' })

  expect(view.container.querySelector('[data-probe]')).not.toBeNull()
})

/**
 * A wheel event that scrolls the document underneath makes the overlay feel
 * like a mistake — and the lock has to come back off, or every panel expanded
 * once leaves the page unscrollable for good.
 */
test('the page behind does not scroll, and scrolls again afterwards', () => {
  panel()

  fireEvent.click(expandButton())
  expect(document.body.style.overflow).toBe('hidden')

  fireEvent.click(expandButton())
  expect(document.body.style.overflow).toBe('')
})

/** A panel that was never told it is expandable offers no control at all. */
test('expand is opt-in', () => {
  render(
    <Panel title="Diff">
      <p>branch</p>
    </Panel>,
  )

  expect(document.body.querySelector('[data-action="expand"]')).toBeNull()
})
