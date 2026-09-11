import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * Built into `../dist/ui`, which is what the daemon serves (§10).
 *
 * `base: './'` because the daemon hands out a URL carrying the run token in
 * its query string. Absolute asset paths would work too, but relative ones
 * keep the page mountable under any prefix the daemon later chooses, and cost
 * nothing.
 *
 * Tailwind runs as a Vite plugin: `src/app.css` is the entry, and it names the
 * design-system package as a source so the utilities its components use are
 * generated into this bundle. There is no PostCSS config and no Tailwind
 * config file — v4 is configured in that stylesheet.
 */
export default defineConfig({
  // The config lives beside the app, so the root is stated rather than
  // inherited from wherever `pnpm` was invoked.
  root: import.meta.dirname,
  base: './',
  plugins: [react(), tailwindcss()],
  build: { outDir: '../dist/ui', emptyOutDir: true },
})
