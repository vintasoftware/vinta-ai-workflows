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
 * Every platform gets long enough to do this work.
 *
 * Not a claim that anything here is slow, and not a way to quiet a hang. The
 * suite spawns real processes, creates real git worktrees and opens real SQLite
 * files, and on a `windows-latest` runner — Defender scanning every write,
 * process creation an order of magnitude dearer than `fork` — the same tests
 * that finish in well under a second elsewhere sat on Vitest's 5s default.
 * They failed in four unrelated files at once, which is the signature of a slow
 * machine rather than of a bug in any one of them.
 *
 * **This used to be Windows only**, on the reasoning that raising it everywhere
 * would let a genuine deadlock on macOS or Linux take four times as long to
 * report, and that a hang on those platforms is a bug rather than an
 * environment. That was sound, and it stopped being true. The same signature —
 * a handful of failures, a *different* handful on each run, spread across
 * `amend`, `integration`, `lanes`, `contract`, `replay-view`, `resume`,
 * `terminal` and `run-view`, every one a `waitFor` or a 5s timeout on a test
 * that does real IO — now appears on a developer laptop running the other
 * fifty-odd files beside them. Eight consecutive runs of an *untouched* tree
 * failed between two and eleven tests and never the same two.
 *
 * A budget that has to be argued about on every red run is not protecting
 * anyone from a deadlock; it is training people to re-run the suite. A real
 * hang still fails, thirty seconds later, and the difference between five
 * seconds and thirty is one nobody debugging a deadlock has ever cared about.
 *
 * This supersedes the per-file constants three suites grew while it was
 * Windows-only. `executor.test.ts` keeps its own, because 60s there is more
 * than this gives and it means it.
 */
const TIMEOUTS = { testTimeout: 30_000, hookTimeout: 60_000 }

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
