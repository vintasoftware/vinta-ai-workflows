/**
 * The tokeniser, directly: the hook is off in tests (`highlight.ts` says why),
 * so this is where the grammar loading and the dual-theme tokens are proved.
 */
import { expect, test } from 'vitest'
import { highlight, languageFor, supported } from '../src/highlight.ts'

test('a known language yields one token list per line, carrying both themes', async () => {
  const tokens = await highlight('const a = 1\nfoo()\n', 'typescript')

  expect(tokens).not.toBeNull()
  // Two lines of code, and the empty line the trailing newline makes.
  expect(tokens).toHaveLength(3)
  const first = tokens?.[0]?.[0]
  expect(first?.content).toBe('const')
  expect(first?.style).toHaveProperty('--shiki-light')
  expect(first?.style).toHaveProperty('--shiki-dark')
  // The text survives intact: the tokens concatenate back to the line.
  expect(tokens?.[0]?.map((token) => token.content).join('')).toBe('const a = 1')
})

test('an unknown language is null, not an error', async () => {
  expect(await highlight('whatever', 'no-such-language')).toBeNull()
  expect(supported('no-such-language')).toBe(false)
  expect(supported('typescript')).toBe(true)
})

test('a line too long to be code is left plain', async () => {
  expect(await highlight('x'.repeat(5_000), 'typescript')).toBeNull()
})

test('a path maps to a grammar by extension, alias or filename', () => {
  expect(languageFor('src/app.ts')).toBe('ts')
  expect(languageFor('src/App.tsx')).toBe('tsx')
  expect(languageFor('scripts/build.mjs')).toBe('javascript')
  expect(languageFor('Dockerfile')).toBe('dockerfile')
  expect(languageFor('config/app.yml')).toBe('yaml')
  expect(languageFor('deploy.sh')).toBe('bash')
  expect(languageFor('README.md')).toBe('markdown')
  expect(languageFor('lib/thing.py')).toBe('python')
  expect(languageFor('notes')).toBeNull()
  expect(languageFor('weird.zzz')).toBeNull()
})
