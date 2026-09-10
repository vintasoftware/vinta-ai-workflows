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

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: IGNORED,
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
        },
      },
    ],
  },
})
