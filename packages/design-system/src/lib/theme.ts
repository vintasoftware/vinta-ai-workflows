/**
 * Light, dark, or whatever the operating system says.
 *
 * The tokens switch on a `dark` class on the root element (`tokens.css`'s
 * `@custom-variant dark`), and the two canvas Web Components an app may host
 * never read `prefers-color-scheme` on their own — the app shell owns the
 * theme and tells them. So there is exactly one place that decides, and this
 * is it: a preference the operator picks, resolved against the OS when they
 * pick `system`, written to the root element, and remembered in
 * `localStorage` under a key the app names.
 *
 * Nothing here is a provider. A hook and two functions are enough for a page
 * with one root, and a page with one root is every page in this workspace.
 */
import { useCallback, useEffect, useState } from 'react'

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_PREFERENCES: readonly ThemePreference[] = ['light', 'dark', 'system']

const DARK_QUERY = '(prefers-color-scheme: dark)'

function isPreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system'
}

/** What the OS asks for; `light` where the page cannot ask (jsdom, an old browser). */
export function systemTheme(): ResolvedTheme {
  if (typeof matchMedia !== 'function') return 'light'
  return matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? systemTheme() : preference
}

/** Writes the resolved theme onto the root element: the class the tokens key off. */
export function applyTheme(
  preference: ThemePreference,
  root: HTMLElement = document.documentElement,
): ResolvedTheme {
  const resolved = resolveTheme(preference)
  root.classList.toggle('dark', resolved === 'dark')
  return resolved
}

/** The remembered preference, or `system` when nothing (or nonsense) is stored. */
export function readThemePreference(storageKey: string): ThemePreference {
  try {
    const stored = localStorage.getItem(storageKey)
    return isPreference(stored) ? stored : 'system'
  } catch {
    // Storage can be refused (a hardened browser, a sandboxed frame). The
    // preference then lives for the page's lifetime only.
    return 'system'
  }
}

export function writeThemePreference(storageKey: string, preference: ThemePreference): void {
  try {
    localStorage.setItem(storageKey, preference)
  } catch {
    // Same refusal as above; the class on the root still changed.
  }
}

/**
 * The preference, the theme it resolves to right now, and a setter. The class
 * on the root element follows both the setter and — when the preference is
 * `system` — the OS, live.
 */
export function useTheme(storageKey: string): {
  readonly preference: ThemePreference
  readonly resolved: ResolvedTheme
  readonly setPreference: (next: ThemePreference) => void
} {
  const [preference, setStored] = useState<ThemePreference>(() => readThemePreference(storageKey))
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(preference))

  useEffect(() => {
    setResolved(applyTheme(preference))
    if (preference !== 'system' || typeof matchMedia !== 'function') return
    const query = matchMedia(DARK_QUERY)
    const follow = (): void => setResolved(applyTheme('system'))
    query.addEventListener('change', follow)
    return () => query.removeEventListener('change', follow)
  }, [preference])

  const setPreference = useCallback(
    (next: ThemePreference): void => {
      writeThemePreference(storageKey, next)
      setStored(next)
    },
    [storageKey],
  )

  return { preference, resolved, setPreference }
}
