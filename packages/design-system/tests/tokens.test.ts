/**
 * The token contract, held to by reading the stylesheet.
 *
 * jsdom resolves no custom properties and computes no colours, so the test
 * that matters here is structural: every semantic token the light theme
 * declares has a dark value, every tone has all three of its parts in both
 * themes, and every tone is exposed to Tailwind. A tone that exists in one
 * theme and not the other would be a badge that goes transparent at night.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'

const SOURCE = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8')
const CSS = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '')

const TONES = ['idle', 'active', 'wait', 'attention', 'ok', 'error'] as const
const PARTS = ['', '-soft', '-foreground'] as const

/** The custom properties declared inside the first block whose selector is `selector`. */
function declared(selector: string): Set<string> {
  const start = CSS.indexOf(`${selector} {`)
  expect(start, `a "${selector}" block`).toBeGreaterThanOrEqual(0)
  const body = CSS.slice(start, CSS.indexOf('\n}', start))
  return new Set([...body.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map(([, name]) => name ?? ''))
}

const light = declared(':root')
const dark = declared('.dark')
const theme = declared('@theme inline')

test('every tone has a strong colour, a soft tint and a text colour, in both themes', () => {
  for (const tone of TONES) {
    for (const part of PARTS) {
      const token = `--tone-${tone}${part}`
      expect(light, `${token} in :root`).toContain(token)
      expect(dark, `${token} in .dark`).toContain(token)
      expect(theme, `--color-tone-${tone}${part} in @theme`).toContain(
        `--color-tone-${tone}${part}`,
      )
    }
  }
})

test('the dark theme overrides every semantic token the light theme declares', () => {
  // Primitives (`--vinta-600`) and shape (`--radius`, `--font-*`) are
  // theme-agnostic by design; the semantic layer is everything else.
  const semantic = [...light].filter(
    (token) =>
      !/^--(vinta|slate|green|amber|red|violet)-\d+$/.test(token) &&
      !/^--(radius|font)/.test(token),
  )
  expect(semantic.length).toBeGreaterThan(20)
  for (const token of semantic) {
    expect(dark, `${token} in .dark`).toContain(token)
  }
})

test('wait and error are different hues, whatever else changes', () => {
  // The single most expensive mistake a status colour can cause is painting
  // backpressure as failure. The two tones may never share a primitive.
  const value = (block: string, token: string): string =>
    new RegExp(`${token}:\\s*([^;]+);`).exec(CSS.slice(CSS.indexOf(`${block} {`)))?.[1] ?? ''
  expect(value(':root', '--tone-wait')).not.toBe(value(':root', '--tone-error'))
  expect(value('.dark', '--tone-wait')).not.toBe(value('.dark', '--tone-error'))
})

test('no colour is written as hex or rgb', () => {
  expect(CSS).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  expect(CSS).not.toMatch(/\brgba?\(/)
})
