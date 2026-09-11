import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

/**
 * Two suites, one command.
 *
 * The package's own tests are Node code — SQLite, worktrees, child processes —
 * and the UI's are DOM code. They cannot share an environment, so they are two
 * Vitest projects rather than one config with a per-file override: the node
 * project has no jsdom, no React plugin and no DOM globals to leak into a
 * scheduler test, and the ui project gets exactly the transform pipeline the
 * app is built with.
 *
 * `tests/fixtures/repo` is a synthetic project used AS test input, not a part
 * of this suite. Its own test file is meant to run inside a provisioned lane
 * worktree with a database attached, so collecting it here aborts at import.
 * Excluding it is not hiding a failure — nothing in this package should ever
 * run it directly.
 */
const IGNORED = ['**/node_modules/**', '**/dist/**', 'tests/fixtures/**']

/**
 * Windows runners get longer to do the same work.
 *
 * Not a claim that anything here is slow, and not a way to quiet a hang. The
 * suite spawns real processes, creates real git worktrees and opens real SQLite
 * files, and on a `windows-latest` runner — Defender scanning every write,
 * process creation an order of magnitude dearer than `fork` — the same tests
 * that finish in well under a second elsewhere sat on Vitest's 5s default.
 * They failed in four unrelated files at once, which is the signature of a slow
 * machine rather than of a bug in any one of them.
 *
 * Deliberately per-platform: raising these everywhere would let a genuine
 * deadlock on macOS or Linux take four times as long to report, and those are
 * the platforms where a hang is a bug rather than an environment.
 */
const SLOW_PLATFORM = process.platform === 'win32'
const TIMEOUTS = SLOW_PLATFORM ? { testTimeout: 30_000, hookTimeout: 60_000 } : {}

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: IGNORED,
          ...TIMEOUTS,
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'ui',
          include: ['ui/**/*.test.ts', 'ui/**/*.test.tsx'],
          exclude: IGNORED,
          environment: 'jsdom',
          setupFiles: ['ui/tests/setup.ts'],
          ...TIMEOUTS,
        },
      },
    ],
  },
})
