# vinta-design-system

Vinta's design system for the browser UIs in this workspace — today, `vinta-ai-maestro`'s run monitor and workflow editor. Tokens in oklch, [shadcn/ui](https://ui.shadcn.com) components (new-york style) on Tailwind CSS v4, and a small layout kit. It mirrors the architecture of `vinta-schedule-design-system`, so a developer moving between Vinta products meets one vocabulary: the same three token layers, the same `.dark` class, the same DM Sans + Geist Mono pairing, the same component files.

Private, TypeScript source only — consumers transpile it with their own bundler; there is no `dist/`.

## Using it from an app

```jsonc
// package.json
"dependencies": { "vinta-design-system": "workspace:*", "@tailwindcss/vite": "^4.3.3" }
```

```ts
// vite.config.ts
import tailwindcss from '@tailwindcss/vite'
export default defineConfig({ plugins: [react(), tailwindcss()] })
```

```css
/* app.css — the app owns the Tailwind entry */
@import 'tailwindcss';
@import 'tw-animate-css';
@import 'vinta-design-system/styles/fonts.css';
@import 'vinta-design-system/styles/tokens.css';
/* Tailwind only sees the classes it scans; point it at this package's sources. */
@source '../../../design-system/src';
```

```tsx
import { Badge } from 'vinta-design-system/ui/badge'
import { Button } from 'vinta-design-system/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from 'vinta-design-system/ui/card'
import { AppMain, AppShell, AppTopbar, HStack } from 'vinta-design-system/layout'
import { useTheme } from 'vinta-design-system/lib/theme'
```

Subpath exports only — there is no barrel over `ui/`, so a page pays for the components it renders.

## Tokens

`src/styles/tokens.css` has three layers:

1. **Primitives** — `--vinta-*` (the brand blue, hue 264), `--slate-*` (cool neutrals), and five-step status ramps `--green-*`, `--amber-*`, `--red-*`, `--violet-*`. Raw and theme-agnostic.
2. **Semantic** — the shadcn contract (`--background`, `--card`, `--primary`, `--muted-foreground`, `--border`, `--ring`, …), one addition — `--line`, a stroke that has to be seen (a graph edge, a divider inside a canvas), because `--border` is a hairline that goes to a 10% white at night — **and the tones** below. Light values on `:root`, dark on `.dark`.
3. **Shape and type** — `--radius` (10px base; `sm` 6, `md` 8, `lg` 10, `xl` 14, `2xl` 20), `--shadow-xs…xl` (cool-tinted), `--font-sans` (DM Sans), `--font-mono` (Geist Mono).

Every token is exposed as a Tailwind utility through `@theme inline`: `bg-card`, `text-muted-foreground`, `border-border`, `rounded-lg`, `shadow-sm`, `font-mono`, `bg-vinta-600`.

### Tones

A tone is what a run, node, gate or session is *doing*. Six of them, fixed:

| Tone | Meaning | Hue |
|---|---|---|
| `idle` | nothing happening, nothing wrong (pending, blocked, a cold turn) | slate |
| `active` | work in progress | Vinta blue |
| `wait` | parked on capacity or a queue — patience, never failure | amber |
| `attention` | a human has to act | violet |
| `ok` | finished well | green |
| `error` | the work did not happen; someone has to do something | red |

Each tone is three tokens: `--tone-<t>` (a strong colour for a dot, a meter, a graph node's edge), `--tone-<t>-soft` (a badge's tint) and `--tone-<t>-foreground` (text on that tint). `Badge` has a variant per tone. **`wait` and `error` must never share a hue** — a throttled run and a broken run ask the operator for opposite things, and `tests/tokens.test.ts` holds the file to it.

An app hosting a canvas Web Component binds the component's own custom properties to these tokens (`--vdag-status-running: var(--tone-active)`), so the graph and the badges beside it cannot disagree.

### Theme

Dark mode is a `dark` class on `<html>`. `lib/theme.ts` owns it: `useTheme(storageKey)` returns the operator's preference (`light | dark | system`), what it resolves to, and a setter; the class follows the setter and, under `system`, the OS. Nothing here reads `prefers-color-scheme` on its own — components take the class, and Web Components are told by the app.

## Components

`src/ui/` — shadcn/ui, installed with the CLI (`components.json` in this directory, aliases `@/ui` and `@/lib/utils`) and then made relative-import. Stock unless noted:

`alert` · `badge` (**+ six tone variants, `BadgeDot`, `TONE_VARIANTS`**) · `button` · `card` · `checkbox` · `dialog` · `empty` · `field` · `input` · `kbd` · `label` · `native-select` · `progress` · `scroll-area` · `separator` · `sheet` · `skeleton` · `slider` · `table` · `tabs` · `textarea` · `tooltip`

`native-select` is deliberate: a real `<select>` keeps keyboard and form semantics and stays drivable by a test's `change` event; the Radix popover `select` is not shipped.

To add one: `pnpm dlx shadcn@latest add <name>` from this directory, then replace `@/lib/utils` with `../lib/utils.ts` and `@/ui/<x>` with `./<x>.tsx`, and run `pnpm run format`.

`src/layout/` — the layout kit, prop-driven and `gap`-spaced:

- `Stack`, `HStack`, `VStack` — flex with `gap` on the 4px scale (`gap={3}`), `align`, `justify`, `wrap`.
- `AppShell`, `AppTopbar`, `AppBrand`, `AppNav`, `AppNavLink`, `AppTopbarActions`, `AppMain` — one sticky bar and one bounded column (`--app-width`, default 1280px).
- `PageHeader`, `PageHeaderHeading`, `PageHeaderTitle`, `PageHeaderMeta`, `PageHeaderActions` — title, mono identifiers, status and actions.
- `DescriptionList`, `DescriptionTerm`, `DescriptionDetails` — labelled facts as a two-column `<dl>`.

## Conventions

- **Tokens, not magic values.** No hex or rgb in a component or a stylesheet; use a utility or `var(--token)`. The test suite rejects a hex in `tokens.css`.
- **Compose with primitives, not raw `div`s with classes.** `<HStack gap={2}>` over `<div className="flex items-center gap-2">`; `className` is the escape hatch.
- **Gap, not margins**, between siblings. Direct-manipulation editors and reorders survive `gap`; per-child margins do not.
- **Meaning on the element, colour on the class.** A status badge carries `data-tone` (or the consumer's own attribute) for tests and assistive tech; the class is only the paint.
- **Icons are `lucide-react`**, 16px in controls, with `aria-label` on icon-only buttons. No emoji.
- **Only literal class strings are generated.** `bg-tone-${tone}-soft` emits nothing; write a lookup table.

## Verifying changes

From this directory: `pnpm run typecheck`, `pnpm test`, `pnpm run lint` (Biome, the same `biome.jsonc` as `vinta-dag-editor`). A change to `tokens.css` also wants a look at `vinta-ai-maestro`'s `ui/src/app.css`, which binds the canvas components to the tones.
