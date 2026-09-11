#!/usr/bin/env node
/**
 * The published build: compile `src/` to `dist/`, build the UI into `dist/ui`,
 * then correct the shebang.
 *
 * The UI half is not optional. `serve` resolves its static root as
 * `dist/ui` and refuses to serve anything outside it, so a tarball built
 * without it starts a daemon that answers every page request with "build the
 * UI first" — which reads as a broken release rather than a missing step.
 *
 * Both halves are needed, and the second one is not cosmetic. `tsc` copies a
 * leading shebang through verbatim, so `dist/cli/bin.js` would ship asking for
 * `--experimental-transform-types` — a flag it cannot need, because there are no
 * types left in it to transform. That matters twice over: it prints an
 * experimental warning at every invocation, and it ties a shipped binary to a
 * flag Node is free to rename or retire.
 *
 * The source keeps its own shebang because running `src/cli/bin.ts` directly is
 * how the repo drives the CLI without building first. The two are allowed to
 * differ; what is not allowed is for them to differ *silently*, so the rewrite
 * asserts it found what it expected and fails the build if `bin.ts`'s first line
 * ever changes shape.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** What `bin.ts` starts with today. A mismatch fails rather than guesses. */
const SOURCE_SHEBANG_PREFIX = '#!/usr/bin/env -S node '
/** What a compiled entry point needs, which is nothing beyond node itself. */
const BUILT_SHEBANG = '#!/usr/bin/env node'

function run(command, args) {
  const result = spawnSync(command, args, { cwd: PACKAGE_ROOT, stdio: 'inherit', shell: false })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

// Both tools are run from the workspace's own install rather than through
// `npx`, which would happily fetch a different compiler from the registry, and
// by absolute path rather than through `node_modules/.bin`, whose entries are
// shell shims on POSIX and `.CMD` files on Windows.
const localBin = (...segments) => join(PACKAGE_ROOT, 'node_modules', ...segments)

run(process.execPath, [localBin('typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'])
run(process.execPath, [localBin('vite', 'bin', 'vite.js'), 'build', '--config', 'ui/vite.config.ts'])

const entry = join(PACKAGE_ROOT, 'dist', 'cli', 'bin.js')
const source = readFileSync(entry, 'utf8')
const firstNewline = source.indexOf('\n')
const shebang = firstNewline === -1 ? source : source.slice(0, firstNewline)

if (!shebang.startsWith(SOURCE_SHEBANG_PREFIX)) {
  // Either the emit stopped carrying the shebang, or `bin.ts` changed its first
  // line. Both want a human: shipping whatever is there would either lose the
  // `#!` a bin entry needs or keep flags it should not have.
  throw new Error(
    `dist/cli/bin.js does not start with the expected source shebang. Found: ${JSON.stringify(shebang)}`,
  )
}

writeFileSync(entry, `${BUILT_SHEBANG}${source.slice(shebang.length)}`)

// The one thing a green build can still get wrong: `vite` writes outside its
// own root here (`outDir: '../dist/ui'`), so a config change that moved it
// would leave `serve` with no UI and nothing would have failed.
if (!existsSync(join(PACKAGE_ROOT, 'dist', 'ui', 'index.html'))) {
  throw new Error('dist/ui/index.html is missing — `serve` would have no UI to hand out')
}

process.stdout.write(`built dist/ + dist/ui, and set ${BUILT_SHEBANG} on dist/cli/bin.js\n`)
