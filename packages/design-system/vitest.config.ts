import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

/**
 * DOM tests only. There is no Node side to this package, so one project is
 * enough — jsdom, the React transform the consumers build with, and nothing
 * that could leak into a scheduler test somewhere else in the workspace.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'jsdom',
  },
})
