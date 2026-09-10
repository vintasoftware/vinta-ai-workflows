/**
 * The entry point. The daemon serves this bundle from the same origin it
 * serves the API from, and prints the URL with the token in its query string
 * (§10) — so the origin is the page's own and the token is read once, here,
 * and handed to the client. It is not stored, not logged, and not rendered.
 */
import { createRoot } from 'react-dom/client'
import './app.css'
import { App } from './App.tsx'
import { createClient } from './client.ts'

const root = document.getElementById('root')
if (root === null) throw new Error('vinta-flow: #root is missing from the page')

const token = new URLSearchParams(location.search).get('token') ?? ''
createRoot(root).render(<App client={createClient(location.origin, token)} />)
