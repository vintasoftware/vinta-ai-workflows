# Next.js App Router stack

## Detection signals

- `package.json` lists `next` (any version with App Router support — 13.4+).
- `app/` directory at repo root or app-package root.
- `next.config.{js,ts,mjs}` exists.

If the project uses Pages Router only (`pages/` directory, no `app/`) → either skip this stack or add a separate `nextjs-pages` stack.

## Skill categories typically needed

- **Add-route** — Server Component vs Client Component decision, layout/page/loading/error file conventions, route group conventions, server-action wiring.
- **Add-server-action** — `'use server'` directive placement, form submission patterns, revalidation strategy, error handling.
- **Manage-caching** — `unstable_cache`, `revalidatePath`, `revalidateTag`, `cache: 'force-cache' | 'no-store'`, dynamic vs static segments. Cache Components if Next.js 16+.
- **Add-middleware-rule** — `middleware.ts` (or `proxy.ts` in Next.js 16+), matcher patterns, response rewrites/redirects, header/cookie manipulation.
- **Add-route-handler** (API endpoint) — `app/api/<route>/route.ts`, method exports, request validation, response shaping.

## Agent categories typically needed

None specific — foundation trio covers most Next.js work. A `cache-author` specialist could be useful if the project has complex caching invariants.

## Placeholders the orchestrator should ask about

- Next.js version (drives Cache Components / `proxy.ts` vs `middleware.ts` / Server Actions stability decisions)
- Deploy target (Vercel, self-hosted, container, edge)
- Auth library (Clerk, NextAuth, Auth0, Descope, custom)
- Data layer (Prisma, Drizzle, raw SQL, REST/GraphQL client to external API)
- Component library (shadcn/ui, Mantine, Chakra, custom)
- Styling (Tailwind, CSS Modules, styled-components, vanilla-extract)

## When this stack doesn't apply

- Next.js Pages Router only → use a separate stack template.
- Next.js used purely as a static-site generator (`output: 'export'`) → most server-side skills don't apply.
