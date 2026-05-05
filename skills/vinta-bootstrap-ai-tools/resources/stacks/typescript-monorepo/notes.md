# TypeScript monorepo stack

## Detection signals

- `turbo.json` at repo root, OR `pnpm-workspace.yaml` / `package.json:workspaces`, OR `nx.json`.
- Multi-app layout: `apps/` + (`lib/` | `packages/`).
- Per-app `package.json` with framework deps.

## Skill categories typically needed

This stack is **foundation-level** — no domain-specific skills are mandatory. The patterns it influences are mostly cross-cutting:

- **Add-env-var** (always) — propagation across `.env.example`, Vite/Next/whatever envPrefix allowlist, `turbo.json` per-task `env` lists, app config modules, AGENTS.md env section, CI workflows.
- **Add-shared-package / add-shared-lib** (sometimes) — when the team has a convention for new `lib/<name>` or `packages/<name>` subprojects (workspace name, exports map, build/test wiring).

## Agent categories typically needed

None specific — the foundation trio (`implementer`, `reviewer`, `fixer`) covers TS monorepo work.

## Placeholders the orchestrator should ask about

- Package manager (`pnpm`, `npm`, `yarn`)
- Build orchestrator (`turbo`, `nx`, `lerna`, plain workspaces)
- App directories pattern (`apps/`, `services/`, `examples/`)
- Shared lib directories pattern (`lib/`, `packages/`, `shared/`)
- Lint+format tool (`biome`, `eslint+prettier`, `dprint`)
- Test runner (`vitest`, `jest`)
- Type check command (`tsc --noEmit`, `pnpm build`, none)

## When this stack doesn't apply

- Single-package TS repo → don't add monorepo-specific skills; foundation is enough.
