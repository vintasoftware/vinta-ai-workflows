/**
 * The interview page's entry point (`interview.html`).
 *
 * Served by `vinta-ai-maestro interview` from the same origin as its API, with
 * the token in the query string (§20, as §10 does for the run monitor) — so
 * the token is read once, here, and handed to the client. It is not stored,
 * not logged, and not rendered.
 */
import { createRoot } from 'react-dom/client'
import { applyTheme, readThemePreference } from 'vinta-design-system/lib/theme'
import './app.css'
import { InterviewApp } from './Interview.tsx'
import { createInterviewClient } from './interview-client.ts'
import { THEME_STORAGE_KEY } from './theme.tsx'

const root = document.getElementById('root')
if (root === null) throw new Error('vinta-ai-maestro: #root is missing from the page')

// Before the first render, so a remembered dark theme never flashes light.
applyTheme(readThemePreference(THEME_STORAGE_KEY))

const token = new URLSearchParams(location.search).get('token') ?? ''
createRoot(root).render(<InterviewApp client={createInterviewClient(location.origin, token)} />)
