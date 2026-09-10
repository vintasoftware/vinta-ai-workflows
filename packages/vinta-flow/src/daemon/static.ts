/**
 * The app shell, served off disk (§10: "React + Vite, served by the daemon").
 *
 * `vinta-flow serve` prints one URL and the entire product is behind it. Until
 * this module existed that URL served an API and nothing else, so the answer
 * to "open this in a browser" was a 404.
 *
 * **The token gates the API and the WebSocket; it does not gate these bytes.**
 * That is a decision, not an oversight, and the reasoning is:
 *
 * - **A browser cannot present it for a subresource.** The token reaches the
 *   page in the URL's query string (§10) — `index.html` could carry it, but
 *   `<script src="./assets/index-…js">` cannot, and neither can a font or a
 *   source map. Gating the assets would mean putting the token in a cookie:
 *   that is credential storage and a login flow, which §11 forbids in as many
 *   words, and an ambient cookie would then be sent on every `/api` request
 *   too, turning a header-authenticated API into a CSRF-shaped one.
 * - **The shell holds no run data.** It is the compiled, open-source app: no
 *   run ids, no transcripts, no repository contents, no token. Every fact
 *   about a run still arrives over `/api` or `/ws`, and both still refuse
 *   without the token — including on a `--host` bind, where an unauthenticated
 *   peer can now fetch a JavaScript bundle it could equally have got from npm,
 *   and still cannot learn that any run exists.
 * - **The blast radius is what this module can read**, which is `dist/ui` and
 *   nothing else. That is enforced below rather than asserted: the request
 *   path is decoded *before* it is resolved — `%2e%2e%2f` is a traversal that
 *   `new URL` does not normalise away — and a resolved path outside the root
 *   is refused rather than fallen back on.
 *
 * The fallback is SPA-shaped: a deep link like `/runs/<id>` is a route the
 * client owns, so a document request that names no file gets `index.html`. A
 * request that names a file gets a 404 rather than HTML, because a missing
 * asset served as a document is a syntax error three layers away from its
 * cause. And a missing bundle answers with the command that builds it: the
 * failure mode that costs the most time is a 404 that looks like a bug in the
 * daemon when nobody has run `ui:build`.
 */
import { readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/** Where `ui/vite.config.ts` writes the bundle, relative to this file. */
export const DEFAULT_UI_DIR = resolve(import.meta.dirname, '..', '..', 'dist', 'ui')

const NOT_BUILT =
  'vinta-flow: the UI bundle is missing. Build it with `pnpm run ui:build` in ' +
  'packages/vinta-flow, which writes dist/ui, then reload this page.'

const TYPES: Readonly<Record<string, string>> = {
  css: 'text/css; charset=utf-8',
  gif: 'image/gif',
  html: 'text/html; charset=utf-8',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  png: 'image/png',
  svg: 'image/svg+xml',
  ttf: 'font/ttf',
  txt: 'text/plain; charset=utf-8',
  webmanifest: 'application/manifest+json',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
}

/** Serves one request path out of `dir`. `pathname` is still percent-encoded. */
export type StaticHandler = (pathname: string, method: string) => Response

export function createStaticHandler(dir: string): StaticHandler {
  const root = resolve(dir)
  const indexPath = join(root, 'index.html')

  return (pathname, method) => {
    if (method !== 'GET' && method !== 'HEAD') return plain(405, 'Method Not Allowed', method)

    let decoded: string
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      return plain(400, 'Bad Request', method)
    }
    // A NUL truncates the path for the syscall but not for the check above it.
    if (decoded.includes('\0')) return plain(400, 'Bad Request', method)

    // Resolved from the decoded path, so `%2e%2e%2f` is normalised here and
    // then refused — `new URL` collapses a literal `../` but not an encoded one.
    const target = resolve(root, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`)
    if (target !== root && !target.startsWith(root + sep)) return plain(403, 'Forbidden', method)

    const file = read(target)
    if (file !== null) return asset(target, file, method)

    // Nothing was found. Say why before saying what: an unbuilt bundle is a
    // different problem from a bad URL, and only one of them is the user's.
    const index = read(indexPath)
    if (index === null) return plain(503, NOT_BUILT, method)
    // A document request — no file extension in the last segment — is a client
    // route. A request that named a file and missed it is a 404, not HTML.
    if (isDocumentPath(decoded)) return asset(indexPath, index, method)
    return plain(404, 'Not Found', method)
  }
}

function isDocumentPath(decoded: string): boolean {
  const last = decoded.split('/').pop() ?? ''
  return !last.includes('.')
}

/** The file's bytes, or null when it is absent or is not a regular file. */
function read(path: string): Buffer | null {
  try {
    if (!statSync(path).isFile()) return null
    return readFileSync(path)
  } catch {
    return null
  }
}

function asset(path: string, body: Buffer, method: string): Response {
  const extension = (path.split('.').pop() ?? '').toLowerCase()
  return new Response(method === 'HEAD' ? null : new Uint8Array(body), {
    status: 200,
    headers: {
      'content-type': TYPES[extension] ?? 'application/octet-stream',
      'content-length': String(body.byteLength),
      // The bundle is trusted; the declared type is not to be second-guessed.
      'x-content-type-options': 'nosniff',
    },
  })
}

/** Text, never the requested path: an echoed path is a reflection sink. */
function plain(status: number, message: string, method: string): Response {
  return new Response(method === 'HEAD' ? null : `${message}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' },
  })
}
