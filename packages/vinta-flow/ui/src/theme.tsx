/**
 * The app's theme: one preference, resolved once, shared with the views.
 *
 * The design system's `useTheme` owns the mechanics — the `dark` class on the
 * root, the OS query, the storage key. What the app adds is a place to *read*
 * the resolved theme from deep in the tree, because the pipeline editor is a
 * Web Component with a `theme` attribute of its own and has to be told.
 */
import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import { createContext, type ReactNode, useContext } from 'react'
import { type ResolvedTheme, type ThemePreference, useTheme } from 'vinta-design-system/lib/theme'
import { Button } from 'vinta-design-system/ui/button'

/** Remembered per browser. Named for the app, so two Vinta tools do not share a setting. */
export const THEME_STORAGE_KEY = 'vinta-flow-theme'

interface ThemeState {
  readonly preference: ThemePreference
  readonly resolved: ResolvedTheme
  readonly setPreference: (next: ThemePreference) => void
}

const ThemeContext = createContext<ThemeState>({
  preference: 'system',
  resolved: 'light',
  setPreference: () => {},
})

export function ThemeProvider({ children }: { readonly children: ReactNode }) {
  const state = useTheme(THEME_STORAGE_KEY)
  return <ThemeContext.Provider value={state}>{children}</ThemeContext.Provider>
}

export function useResolvedTheme(): ResolvedTheme {
  return useContext(ThemeContext).resolved
}

/** system → light → dark → system. Three states, one button, no menu. */
const NEXT: Readonly<Record<ThemePreference, ThemePreference>> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
}

const LABEL: Readonly<Record<ThemePreference, string>> = {
  system: 'Theme: follows the system',
  light: 'Theme: light',
  dark: 'Theme: dark',
}

export function ThemeToggle() {
  const { preference, setPreference } = useContext(ThemeContext)
  const Icon = preference === 'system' ? MonitorIcon : preference === 'light' ? SunIcon : MoonIcon
  return (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      aria-label={LABEL[preference]}
      title={LABEL[preference]}
      data-theme-preference={preference}
      onClick={() => setPreference(NEXT[preference])}
    >
      <Icon />
    </Button>
  )
}
