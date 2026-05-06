# Medplum stack

## Detection signals

The target project matches this stack when **all** of these are true:

- `package.json` (any workspace) lists `@medplum/core`, `@medplum/fhirtypes`, or `@medplum/react` in dependencies.
- A `bots/` directory exists somewhere (typically `apps/<app>/bots/` or `packages/bots/`).
- Per-env tenant-Organization signals (any of):
  - `meta.account` references in code that creates FHIR resources.
  - `withTenantScope(...)` helper calls (if project is multi-tenants)
  - `_compartment=Organization/<id>` in Subscription criteria (if project is multi-tenants).

If only the SDK is in dependencies but no `bots/` directory and no tenant compartmenting → **don't apply** this stack. The project is consuming the Medplum API, not running on Medplum the way an opinionated bot-driven setup does.

## Skill categories typically needed

Names are conventional — the team's existing templates may use different naming. Surface these to the user as "do you have something like this?" prompts.

- **Add-bot** — handler/service split, BOTS registry entry, Subscription criteria + interaction extension, tenant scoping (`meta.account`), tests with `MockClient`.
- **Manage-access-policy** — AccessPolicy bundle JSON anatomy, tenant compartment pattern, `npx medplum post` reseed, RBAC two-layer relationship (server-side AccessPolicy + client-side permission gates).
- **Add-notification** (if vintasend or similar): registry entry, per-channel templates, context-generator/resolver map, dispatch helpers, tenant field on every create.
- **Run-one-off-script-medplum** — sister to the universal `add-one-off-script` foundation skill. Authors a Medplum bot at `<bots_dir>/one_off_<YYYY_MM_DD>_<name>/handler.ts` that imports the `BaseOneOffScript` subclass from the per-script folder and invokes `script.execute()` from inside the bot, plus the matching `MedplumBotRuntime` adapter at `<scripts_dir>/_runtime_medplum.ts`. Adapter responsibilities: lease becomes a no-op (Medplum guarantees single bot instance); `install_stop_handler` listens for the bot's cancellation token; `log` writes to `bot.log()`; CSV backup chunks + `run.log` upload to Medplum `Binary` resources (no FS in a bot) — restore reads them back via the FHIR API. Subscription criteria + BOTS registry entry are added by the same skill; tenant scoping (`meta.account`) on every created Binary follows the project's standard pattern.

## Agent categories typically needed

- **Deploy-author** — specialist for deploy-affecting changes: AccessPolicy reseed via `npx medplum post`, bot deploy with Subscriptions, notification template compile-and-seed, env-var propagation across Vite / Turbo / CI.

## Placeholders the orchestrator should ask about

When the user provides their existing templates, the orchestrator should substitute these per the target project:

- Bot directory path (e.g. `apps/provider-app/bots/`)
- AccessPolicy JSON directory (e.g. `apps/provider-app/data/`)
- Bot deploy command (e.g. `pnpm bots:deploy`)
- Tenant helper module path (e.g. `apps/provider-app/bots/utils/tenant.ts`)
- Project naming (`Organization` vs `Project`, `org` vs `team`, etc)
- One-off script invocation surface — bot vs Medplum CLI script — drives the `run-one-off-script-medplum` skill's runner artefact + `Runtime` adapter shape

If the team's template library uses different terminology, follow theirs.

## When this stack doesn't apply cleanly

- Project uses Medplum SDK only (no bots, no AccessPolicy bundles, no tenant compartmenting) → skip.
- Project has bots but uses a different deploy model (e.g. Lambda-based instead of Medplum-managed) → likely a different stack template; consider adding one.
