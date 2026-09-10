/**
 * Makes node-pty's prebuilt `spawn-helper` executable.
 *
 * node-pty 1.1.0 ships the helper with mode 0644 inside its prebuilds, and its
 * own postinstall never chmods it — so on macOS every `pty.fork` fails with
 * `posix_spawnp failed` on a fresh install. PTY takeover (§9) is unusable until
 * this runs, and the failure names the helper rather than the cause, so it is
 * worth a script rather than a line in a README nobody reads at the moment they
 * hit it.
 *
 * Idempotent, and never fails an install: a platform whose helper is missing or
 * already executable is not a problem, and neither is a package layout that has
 * moved on. Reported upstream-shaped: if node-pty starts shipping the right
 * mode, this becomes a no-op rather than a conflict.
 */
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

let prebuilds
try {
  // Resolve through node-pty itself so the pnpm store layout is not assumed.
  prebuilds = join(dirname(require.resolve('node-pty/package.json')), 'prebuilds')
} catch {
  process.exit(0)
}

if (!existsSync(prebuilds)) process.exit(0)

const fixed = []
for (const platform of readdirSync(prebuilds)) {
  const helper = join(prebuilds, platform, 'spawn-helper')
  if (!existsSync(helper)) continue
  // 0o111 is the executable bits; anything already carrying them is left alone.
  if ((statSync(helper).mode & 0o111) !== 0) continue
  try {
    chmodSync(helper, 0o755)
    fixed.push(platform)
  } catch {
    // A read-only store is the package manager's business, not ours.
  }
}

if (fixed.length > 0) console.log(`node-pty: made spawn-helper executable for ${fixed.join(', ')}`)
