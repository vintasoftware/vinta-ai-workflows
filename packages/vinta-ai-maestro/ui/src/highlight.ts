/**
 * Syntax highlighting, for the diff view and the code an agent writes.
 *
 * shiki, loaded in pieces: the core, the JavaScript regex engine (no WASM to
 * ship or to fetch), the two GitHub themes, and each grammar the first time a
 * file in that language is on screen. Vite splits every grammar into its own
 * chunk, so a run that only ever touched TypeScript pays for one.
 *
 * **Both themes at once.** Tokens are produced with `defaultColor: false` and
 * carry `--shiki-light` and `--shiki-dark`; `app.css` picks one by the `dark`
 * class the design system already sets on the root. The alternative — one
 * theme, re-tokenised when the operator toggles — would re-run every grammar
 * on the page for a colour change.
 *
 * **Nothing is highlighted in tests.** jsdom runs the suite and the hook would
 * resolve a grammar asynchronously under every row, which is a React state
 * update outside `act` on every test that renders code. The tokeniser itself
 * is tested directly; the hook returns plain text where Vite says the mode is
 * `test`, which is exactly what the view falls back to anyway while a grammar
 * is still loading.
 */
import { useEffect, useState } from 'react'
import type { HighlighterCore } from 'shiki/core'
import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { bundledLanguages } from 'shiki/langs'
import { bundledThemes } from 'shiki/themes'

export interface Token {
  readonly content: string
  /** `--shiki-light` and `--shiki-dark`, for an inline `style`. */
  readonly style?: Readonly<Record<string, string>>
}

/** One entry per line of the input, in order. An empty line is an empty array. */
export type Tokens = readonly (readonly Token[])[]

const THEMES = { light: 'github-light', dark: 'github-dark' } as const

/** A line longer than this is not code anyone reads highlighted; it stays plain. */
const LINE_LIMIT = 1_000
/** And a block longer than this costs more to tokenise than it saves to read. */
const LINES_LIMIT = 3_000

let core: Promise<HighlighterCore> | null = null
const loaded = new Set<string>()
const loading = new Map<string, Promise<void>>()

/** The highlighter, built once with the themes and no grammars. */
function highlighter(): Promise<HighlighterCore> {
  core ??= createHighlighterCore({
    themes: [bundledThemes[THEMES.light], bundledThemes[THEMES.dark]],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  })
  return core
}

/** Whether shiki ships a grammar under this id or alias. */
export function supported(lang: string): boolean {
  return Object.hasOwn(bundledLanguages, lang)
}

/**
 * The highlighter with `lang` loaded, or null for a language shiki does not
 * ship — the caller renders plain text and stops asking.
 */
export async function ready(lang: string): Promise<HighlighterCore | null> {
  if (!supported(lang)) return null
  const hl = await highlighter()
  if (!loaded.has(lang)) {
    let pending = loading.get(lang)
    if (pending === undefined) {
      pending = hl
        .loadLanguage(bundledLanguages[lang as keyof typeof bundledLanguages])
        .then(() => {
          loaded.add(lang)
        })
        .finally(() => {
          loading.delete(lang)
        })
      loading.set(lang, pending)
    }
    await pending
  }
  return hl
}

/** Tokens for `code`, one list per line. Synchronous: `ready` has already run. */
export function tokenise(hl: HighlighterCore, code: string, lang: string): Tokens {
  const { tokens } = hl.codeToTokens(code, { lang, themes: THEMES, defaultColor: false })
  return tokens.map((line) =>
    line.map((token) => ({
      content: token.content,
      ...(token.htmlStyle === undefined ? {} : { style: token.htmlStyle }),
    })),
  )
}

/** `code` highlighted as `lang`, or null when the language is unknown or the text too big. */
export async function highlight(code: string, lang: string): Promise<Tokens | null> {
  if (!worthHighlighting(code)) return null
  const hl = await ready(lang)
  return hl === null ? null : tokenise(hl, code, lang)
}

function worthHighlighting(code: string): boolean {
  if (code.length > LINE_LIMIT * LINES_LIMIT) return false
  let lines = 1
  let start = 0
  for (let index = code.indexOf('\n'); index !== -1; index = code.indexOf('\n', start)) {
    if (index - start > LINE_LIMIT) return false
    lines += 1
    if (lines > LINES_LIMIT) return false
    start = index + 1
  }
  return code.length - start <= LINE_LIMIT
}

/**
 * Highlighted tokens for `code`, or null while they load, when `lang` is null
 * or unknown, or in tests. A view renders the plain text on null, so the
 * fallback is never a blank.
 */
export function useTokens(code: string, lang: string | null): Tokens | null {
  const [tokens, setTokens] = useState<{ code: string; lang: string; tokens: Tokens } | null>(null)

  useEffect(() => {
    if (lang === null || !ENABLED) return
    let stale = false
    void highlight(code, lang).then((result) => {
      if (!stale && result !== null) setTokens({ code, lang, tokens: result })
    })
    return () => {
      stale = true
    }
  }, [code, lang])

  // The state may be a previous input's: a row whose text changed renders
  // plain until its own tokens arrive, rather than the old text's colours.
  return tokens !== null && tokens.code === code && tokens.lang === lang ? tokens.tokens : null
}

const ENABLED = import.meta.env.MODE !== 'test'

/**
 * shiki's language id for a path, by extension or by a well-known filename;
 * null for anything it does not ship a grammar for.
 *
 * Extensions shiki does not know as aliases are mapped here; the rest fall
 * through to the alias table shiki maintains (`ts`, `py`, `rb`, `yml` …).
 */
export function languageFor(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const byName = FILENAMES[name]
  if (byName !== undefined) return byName
  const dot = name.lastIndexOf('.')
  if (dot === -1) return null
  const ext = name.slice(dot + 1)
  const lang = EXTENSIONS[ext] ?? ext
  return supported(lang) ? lang : null
}

const FILENAMES: Readonly<Record<string, string>> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  '.gitignore': 'gitignore',
  '.gitattributes': 'gitignore',
  '.env': 'dotenv',
  '.bashrc': 'bash',
  '.zshrc': 'zsh',
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  mjs: 'javascript',
  cjs: 'javascript',
  mts: 'typescript',
  cts: 'typescript',
  htm: 'html',
  yml: 'yaml',
  sh: 'bash',
  bash: 'bash',
  zsh: 'zsh',
  env: 'dotenv',
  md: 'markdown',
  markdown: 'markdown',
  txt: 'text',
  log: 'text',
  lock: 'yaml',
  conf: 'ini',
  cfg: 'ini',
  toml: 'toml',
  tf: 'terraform',
  gql: 'graphql',
  jsonc: 'jsonc',
  jsonl: 'json',
  svg: 'xml',
  plist: 'xml',
  h: 'c',
  hpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  kts: 'kotlin',
  rs: 'rust',
  rb: 'ruby',
  py: 'python',
  pyi: 'python',
  ps1: 'powershell',
  bat: 'bat',
  cmd: 'bat',
}

/**
 * The language of a shell command: `bash` everywhere, which is the grammar
 * that reads a `pnpm test && pnpm lint` line correctly whatever shell ran it.
 */
export const SHELL = 'bash'
