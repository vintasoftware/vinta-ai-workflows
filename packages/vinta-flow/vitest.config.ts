import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // `tests/fixtures/repo` is a synthetic project used AS test input, not a
    // part of this suite. Its own test file is meant to run inside a
    // provisioned lane worktree with a database attached, so collecting it here
    // aborts at import. Excluding it is not hiding a failure — nothing in this
    // package should ever run it directly.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/fixtures/**'],
  },
})
