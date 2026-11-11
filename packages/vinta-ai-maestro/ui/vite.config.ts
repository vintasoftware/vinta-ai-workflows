import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
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
 *
 * Two pages, one bundle. `index.html` is the run monitor the daemon serves;
 * `interview.html` is the interview page `vinta-ai-maestro interview` serves
 * (§20). They share the stylesheet, the design system and the markdown
 * renderer, and the second never imports the first, so the interview page
 * does not carry the graph, the terminal or the editor.
 */
export default defineConfig({
  // The config lives beside the app, so the root is stated rather than
  // inherited from wherever `pnpm` was invoked.
  root: import.meta.dirname,
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../dist/ui',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        interview: resolve(import.meta.dirname, 'interview.html'),
      },
    },
    // Mermaid alone is past the default warning, and it is loaded on demand.
    chunkSizeWarningLimit: 1_500,
  },
})
