import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * Built into `../dist/ui`, which is what the daemon serves (§10).
 *
 * `base: './'` because the daemon hands out a URL carrying the run token in
 * its query string. Absolute asset paths would work too, but relative ones
 * keep the page mountable under any prefix the daemon later chooses, and cost
 * nothing.
 */
export default defineConfig({
  // The config lives beside the app, so the root is stated rather than
  // inherited from wherever `pnpm` was invoked.
  root: import.meta.dirname,
  base: './',
  plugins: [react()],
  build: { outDir: '../dist/ui', emptyOutDir: true },
})
