/**
 * The app shell, served off disk (§10: "React + Vite, served by the daemon").
 *
 * `vinta-ai-maestro serve` prints one URL and the entire product is behind it. Until
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
import { posix, win32, type PlatformPath } from 'node:path'

/** The host's own path rules. Injectable, so both flavours are testable from either. */
const HOST_PATH: PlatformPath = process.platform === 'win32' ? win32 : posix

/** Where `ui/vite.config.ts` writes the bundle, relative to this file. */
export const DEFAULT_UI_DIR = HOST_PATH.resolve(import.meta.dirname, '..', '..', 'dist', 'ui')

const NOT_BUILT =
  'vinta-ai-maestro: the UI bundle is missing. Build it with `pnpm run ui:build` in ' +
  'packages/vinta-ai-maestro, which writes dist/ui, then reload this page.'

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

/**
 * Characters and shapes a request path may not contain, refused before it is
 * ever resolved. Every one of them is a character whose *meaning* differs
 * between POSIX and Windows, and refusing them is what makes this handler's
 * verdict a property of the request rather than of the host it runs on:
 *
 * - **`\`** is a filename character on POSIX and a path separator on Windows.
 *   `%5c..%5c..%5cetc` resolves to a traversal on one and to a strange
 *   filename on the other. The prefix check below catches it on both, but a
 *   guard whose *reason* for refusing changes by platform is a guard nobody
 *   can reason about.
 * - **`:`** opens an NTFS alternate data stream (`index.html::$DATA`) and
 *   names a drive (`C:`). Both let one file be requested under two spellings,
 *   which defeats the extension the content type is read from.
 * - **A segment ending in `.` or a space** is silently trimmed by the Windows
 *   filesystem, so `index.html.` is another second spelling of one file.
 *
 * No URL a Vite bundle emits contains any of them, so nothing legitimate is
 * lost. (Windows device names — `nul`, `con`, `com1` — need no rule: they
 * resolve to character devices, and `read` below serves regular files only.)
 *
 * `.` and `..` are deliberately *not* refused here. They are the traversal this
 * module's prefix check exists to answer, and answering them with 400 would
 * hide the one refusal worth being able to see in a log as 403.
 */
const HOSTILE_CHARS = /[\\:\0]/

const hasHostileSegment = (decoded: string): boolean =>
  HOSTILE_CHARS.test(decoded) ||
  decoded
    .split('/')
    // Trimmed by the Windows filesystem, so `index.html.` and `index.html ` are
    // second spellings of one file — and the content type is read from the
    // spelling. A segment of nothing but dots is `.`/`..`, left to the resolver.
    .some((segment) => segment.endsWith(' ') || (segment.endsWith('.') && /[^.]/.test(segment)))

export interface StaticOptions {
  /**
   * Path rules to resolve under. Defaults to the host's. Injected by the tests
   * so the Windows branch of this guard is decidable from a POSIX machine —
   * traversal is the one thing here that must not be verified only in CI.
   */
  readonly path?: PlatformPath
}

export function createStaticHandler(dir: string, options: StaticOptions = {}): StaticHandler {
  const path = options.path ?? HOST_PATH
  const root = path.resolve(dir)
  const indexPath = path.join(root, 'index.html')

  return (pathname, method) => {
    if (method !== 'GET' && method !== 'HEAD') return plain(405, 'Method Not Allowed', method)

    let decoded: string
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      return plain(400, 'Bad Request', method)
    }
    // Checked after decoding: `%5c` and `%00` are not separators or NULs until
    // they are decoded, and the syscall sees the decoded form.
    if (hasHostileSegment(decoded)) return plain(400, 'Bad Request', method)

    // Resolved from the decoded path, so `%2e%2e%2f` is normalised here and
    // then refused — `new URL` collapses a literal `../` but not an encoded one.
    const target = path.resolve(root, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`)
    if (target !== root && !target.startsWith(root + path.sep)) {
      return plain(403, 'Forbidden', method)
    }

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
