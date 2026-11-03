/**
 * The things about `app.css` that a rendering test cannot catch.
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
 *
 * The second is the design system's: the graph's status colours are its
 * tones, so the canvas and the badges beside it cannot disagree — and
 * `waiting_on_capacity` is painted with the waiting tone, never the failing
 * one (§6.1). The chrome itself is no longer styled here — it is the design
 * system's shell, and the design system's own suite covers it.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'

// From the package root: `import.meta.url` is an http URL under jsdom.
const SOURCE = readFileSync(resolve(process.cwd(), 'ui/src/app.css'), 'utf8')
/** Comments in this file quote CSS, braces and all, so they go first. */
const CSS = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * The declarations of every rule whose selector list matches `selector`. The
 * text before a `{` also holds any `@import` / `@source` statements since the
 * previous rule, so only what follows the last `;` is the selector.
 */
function declarationsFor(selector: string): string {
  return [...CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, selectors]) =>
      (selectors ?? '')
        .split(';')
        .at(-1)
        ?.split(',')
        .some((one) => one.trim() === selector),
    )
    .map(([, , body]) => body ?? '')
    .join('\n')
}

test('the host of the canvas is never given a display by this document', () => {
  // `<vinta-dag>` lays itself out as a flex column in its own `:host` rule, and
  // an outer rule would win. Size it, colour it, border it — never lay it out.
  for (const selector of ['.dag', 'vinta-dag', '.pipeline', 'state-machine-editor']) {
    expect(declarationsFor(selector)).not.toMatch(/(^|[;\s])display\s*:/)
  }
  expect(declarationsFor('.dag')).toContain('height:')
})

test('the stylesheet is the design system’s, and scans it for utilities', () => {
  expect(CSS).toContain("@import 'tailwindcss'")
  expect(CSS).toContain("@import 'vinta-design-system/styles/tokens.css'")
  expect(CSS).toContain("@import 'vinta-design-system/styles/fonts.css'")
  // Tailwind only emits the classes it sees; without this the components'
  // classes would resolve to nothing and every card would be an unstyled div.
  expect(CSS).toMatch(/@source\s+'\.\.\/\.\.\/\.\.\/design-system\/src'/)
})

test('the graph paints each status with the tone the badges use', () => {
  const dag = declarationsFor('vinta-dag')
  const expected: Record<string, string> = {
    pending: 'idle',
    running: 'active',
    waiting_on_capacity: 'wait',
    awaiting_human: 'attention',
    done: 'ok',
    failed: 'error',
  }
  for (const [status, tone] of Object.entries(expected)) {
    expect(dag).toMatch(new RegExp(`--vdag-status-${status}:\\s*var\\(--tone-${tone}\\)`))
  }
  // Edges are drawn with the stroke token, not the hairline: a border that
  // fades to a 10% white at night is right for a card and invisible for a line.
  expect(dag).toMatch(/--vdag-line:\s*var\(--line\)/)
})
