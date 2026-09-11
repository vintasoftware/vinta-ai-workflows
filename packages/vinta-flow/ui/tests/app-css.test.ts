/**
 * The two things about `app.css` that a rendering test cannot catch.
 *
 * jsdom has no layout engine, so nothing here — and nothing anywhere in this
 * suite — can prove that a box is the size it looks. What a test *can* do is
 * read the stylesheet and hold it to the rules that were learned the expensive
 * way, which is why this file asserts on CSS text rather than on a rendered
 * node.
 *
 * The first rule is the one that cost a whole canvas: a declaration in this
 * document beats a Web Component's own `:host` rule whatever the specificity,
 * so `.dag { display: block }` flattened the graph's flex column, collapsed its
 * viewport to nothing, and rendered an empty box in every view while every
 * test stayed green.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'

// From the package root: `import.meta.url` is an http URL under jsdom.
const SOURCE = readFileSync(resolve(process.cwd(), 'ui/src/app.css'), 'utf8')
/** Comments in this file quote CSS, braces and all, so they go first. */
const CSS = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '')

/** The declarations of every rule whose selector list matches `selector`. */
function declarationsFor(selector: string): string {
  return [...CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, selectors]) =>
      (selectors ?? '').split(',').some((one) => one.trim() === selector),
    )
    .map(([, , body]) => body ?? '')
    .join('\n')
}

test('the host of the canvas is never given a display by this document', () => {
  // `<vinta-dag>` lays itself out as a flex column in its own `:host` rule, and
  // an outer rule would win. Size it, colour it, border it — never lay it out.
  for (const selector of ['.dag', 'vinta-dag']) {
    expect(declarationsFor(selector)).not.toMatch(/(^|[;\s])display\s*:/)
  }
  expect(declarationsFor('.dag')).toContain('height:')
})

test('the page is a bounded column and the header is one row', () => {
  const app = declarationsFor('.app')
  expect(app).toMatch(/max-width:\s*\d/)
  expect(app).toMatch(/padding:\s*\d/)
  expect(app).toMatch(/margin:\s*0 auto/)

  // The chrome is styled rather than left to the browser: a row with a rule
  // under it, a title that is not a blue underlined anchor, and a reminder
  // control wearing the same border as every other control on the page.
  const head = declarationsFor('.app-head')
  expect(head).toMatch(/display:\s*flex/)
  expect(head).toMatch(/border-bottom:/)
  expect(declarationsFor('.app-head > h1 a')).toMatch(/color:\s*var\(--text\)/)
  expect(CSS).toContain('.app-head select')
})
