---
name: vinta-bootstrap-ai-tools
description: Bootstrap a project's AI-tooling layout (`ai-tools/AGENTS.md`, `ai-tools/skills/`, `ai-tools/agents/*.yaml`) plus the multi-vendor setup script that wires the canonical sources into Claude Code, Cursor, Codex, and VS Code Copilot. Project-agnostic — adapts to whatever stack it finds. Detects langs, frameworks, build tools, deploy paths, multi-tenancy patterns, and CI conventions, interviews the user for the gaps, then drafts AGENTS.md, the foundation sub-agents (implementer / reviewer / fixer), and a starter set of project-specific skills. Stack-specific skill + agent templates (Medplum, Django, …) live as resources and get copied when the detected stack matches. Use when invoked in a fresh repo that doesn't yet have an `ai-tools/` directory, or to refresh an existing one. Orchestrates several sub-skills — see "Sub-skill flow" below.
---

# Bootstrap AI tools

This skill produces, in the target repo:

- `ai-tools/AGENTS.md` — universal project conventions read by Claude Code, Cursor, Codex, Copilot.
- `ai-tools/skills/<name>/SKILL.md` — domain-specific skills (always: foundation set + stack-matched copies).
- `ai-tools/agents/<name>.yaml` — vendor-agnostic sub-agent definitions; the setup script materializes per-vendor copies.
- `ai-tools/scripts/setup-ai-tools.mjs` + a `pnpm setup:ai-tools` (or equivalent) script alias.
- All vendor symlinks + generated agent files (Claude markdown, Cursor markdown, Copilot `.agent.md`, Codex TOML).

Project-agnostic. Adapts to whatever the analysis finds. Stack-specific skill + agent templates (Medplum, Django, ...) live under [`resources/stacks/`](resources/stacks/) and get copied when the detected stack signals match.

## Sub-skill flow

This orchestrator runs six sub-skills in order. Each is its own SKILL.md so it can be invoked standalone (e.g. to refresh just AGENTS.md without redoing analysis from scratch).

1. [vinta-analyze-codebase](../vinta-analyze-codebase/SKILL.md) — walk the repo, build a structured inventory: languages, frameworks, build tools, test frameworks, deploy targets, monorepo shape, env model, multi-tenancy patterns, CI providers. Outputs an in-memory inventory the rest of the flow consumes.
2. [vinta-write-agents-md](../vinta-write-agents-md/SKILL.md) — synthesize `ai-tools/AGENTS.md` from the inventory + a focused interview for what the analysis can't see.
3. [vinta-derive-subagents](../vinta-derive-subagents/SKILL.md) — author `ai-tools/agents/*.yaml`. Always emits the foundation trio (`implementer`, `reviewer`, `fixer`); adds stack-specific specialists when the user supplies a template for a matched stack.
4. [vinta-derive-skills](../vinta-derive-skills/SKILL.md) — author `ai-tools/skills/*/SKILL.md`. Always copies the project-agnostic foundation set (`plan-feature`, `create-spec`, `create-qa-use-cases`) verbatim from its bundled resources. Generates `implement-plan` from a parameterized template using project specifics. Asks the user whether the optional `add-e2e-test` and `add-env-var` skills are needed. Asks for stack-specific templates per matched stack.
5. [vinta-install-ai-tools-setup](../vinta-install-ai-tools-setup/SKILL.md) — copy the canonical `setup-ai-tools.mjs` into `ai-tools/scripts/`, wire the package script alias, run setup, verify all vendor paths resolve.
6. [vinta-migrate-plans-specs](../vinta-migrate-plans-specs/SKILL.md) — find any pre-existing implementation plans / feature specs scattered across the repo (`docs/`, `specs/`, `plans/`, root markdown, etc.) and propose moving them to the canonical layout `ai-plans/YYYY-MM-DD-{FEATURE_NAME}_{PLAN|SPEC}.md`. Read-only by default; every rename is gated on per-file user approval. Skipped automatically when the analysis finds no candidates.

Each sub-skill returns a short status report. Don't run the next sub-skill until the previous finished cleanly. If a sub-skill fails or surfaces ambiguity, surface that to the user and resolve before continuing.

### Sibling skill — `create-qa-use-cases`

[create-qa-use-cases](../create-qa-use-cases/SKILL.md) lives alongside the five sub-skills above but is **not** dispatched by the orchestrator at bootstrap time. It serves two distinct purposes:

- **Foundation skill that ships to the target**. [vinta-derive-skills](../vinta-derive-skills/SKILL.md) copies the same SKILL.md (bundled at `derive-skills/resources/foundation-skills/create-qa-use-cases/SKILL.md`) into the target's `ai-tools/skills/create-qa-use-cases/`.
- **Sub-skill of `plan-feature` at runtime in the target**. When `plan-feature` runs in the target project and detects no `QA_USE_CASES.md`, it invokes `create-qa-use-cases` to bootstrap the doc from the active feature's spec + plan.

The bootstrap orchestrator doesn't need to invoke it directly. It just needs to make sure derive-skills ships it as part of the foundation set.

## When to use

- Repo has no `ai-tools/` directory and the user wants to introduce Vinta's setup.
- Repo has a partial setup and the user wants to refresh / extend it. (This orchestrator is idempotent in spirit — sub-skills read what's there before writing.)
- Forking the Vinta conventions into a new project.

If the repo already has `ai-tools/AGENTS.md`, **do not overwrite** without explicit confirmation. The orchestrator's first interview question covers this.

## Interview (Step 0 — before any sub-skill runs)

Use `AskUserQuestion` for finite-choice questions; iterate plain prose for open-ended ones. Same convention as [plan-feature](../plan-feature/SKILL.md) and [create-spec](../create-spec/SKILL.md).

### A. Scope

1. **Existing setup?** `ai-tools/` already present → confirm: refresh in place, or stop and route to specific sub-skill (e.g. just re-run install-ai-tools-setup). `AskUserQuestion` options: `Fresh bootstrap`, `Refresh in place`, `Stop, run a specific sub-skill instead`.
2. **Which sub-skills to run?** Default = all six in order. `AskUserQuestion` options: `All six`, `Skip analyze-codebase (use prior inventory)`, `Skip derive-skills (foundation only)`, `Skip migrate-plans-specs (no prior planning docs)`, `Custom selection (ask me)`.
3. **Vendor coverage.** Which AI tools does the team use? `AskUserQuestion` multi-select: `Claude Code`, `Cursor`, `VS Code Copilot`, `Codex`. Maps to the setup script's `--only` flag at the install step.

### B. Stack detection

Don't ask yet — let `vinta-analyze-codebase` do its scan first, then echo back what it found and ask "anything I missed?". The interview for stack details lives inside each sub-skill where the question is most relevant.

### C. Project conventions worth surfacing early

These bleed across sub-skills, so capture once now:

1. **Source of truth for code style** — Biome, Prettier, ruff, black, gofmt, etc. (`AskUserQuestion` with the common options + `Other (I'll list)`).
2. **Test framework(s)** — Vitest, Jest, pytest, Go test, etc. Multi-select.
3. **Code host** — GitHub, GitLab, Bitbucket, other. Drives the `implement-plan` template's PR-creation block.
4. **PR creation policy** — agents open PRs, or only push branches and humans open PRs?
5. **Co-author trailer policy** — repo allows AI co-author trailers in commits, or strictly human-only?
6. **Deploy targets** — Vercel, AWS, Kubernetes, Heroku, custom, none.
7. **Third-party dependency license policy.** Should agents check the SPDX license of any new dep against a forbidden list before running `npm add` / `pnpm add` / `pip install` / `poetry add` / `uv add` / `cargo add` / `go get` (etc.)?
   - **Enforcement.** `AskUserQuestion` options: `Block (recommended)` — refuse install + surface violation, ask user to confirm override before proceeding; `Warn` — proceed but flag in the phase report; `Off` — skip the check entirely.
   - **Forbidden SPDX list.** Show the default seed (`GPL-2.0-only`, `GPL-3.0-only`, `AGPL-3.0-only`, `SSPL-1.0`) targeting viral copyleft licenses, then ask via open prose: *"Add or remove entries? Common additions: `LGPL-2.1-only`, `LGPL-3.0-only`, `BSL-1.1`, `EUPL-1.2`, `CC-BY-NC-*` (non-commercial)."* Skip when enforcement = `Off`.
   - **Existing overrides (optional).** Open prose: *"Any packages already in the manifest with a forbidden license the team has accepted? Format: `<package> <SPDX-id> <one-line reason>`. Leave blank if none."* Each entry lands in `policies.dependency_licenses.allowed_overrides[]`. Skip when enforcement = `Off`.
   - **Notes (optional).** Open prose: *"Any nuance the structured fields can't capture? (e.g. 'LGPL fine for dynamic linking only', 'viral-license deps go through @counsel before merge'.)"* Lands in `policies.dependency_licenses.notes`.
8. **Commit strategy** — how `implement-plan` should structure branches + commits across phases. `AskUserQuestion` options:
   - `Stacked branches (default) — one branch + one PR per phase, stacked on top of each other` — current behavior. Each phase ships one commit on its own branch; reviewers see one PR per phase.
   - `Modular commits — one branch + one PR for the whole plan, atomic commit per logical unit` — each phase produces multiple commits (one per service / use-case wire-up / init / serializer field / refactor / fix). Tests travel in the same commit as the code they test. Reviewers read the commit list as a TOC.
   - `Ask me each run` — `implement-plan` prompts at Step 0 (alongside `pause_between_phases` / `generate_inline_comments`) and caches the answer in `TRACKING_{plan-id}.md`.

   Lands in `.vinta-ai-workflows.yaml` `policies.commit_strategy`. Drives the `implement-plan` template's branch / commit / PR-opening flow + the `amend-plan` skill's supported-strategies check.

### D. Optional foundation skills

Seven skills are part of the foundation set but aren't always needed. Ask explicitly:

1. **`add-e2e-test`** — does the project have e2e tests (Playwright / Cypress / similar) or plan to add them? `AskUserQuestion` options: `Yes — already has them`, `Yes — planning to add`, `No — skip`. If yes, [vinta-derive-skills](../vinta-derive-skills/SKILL.md)'s **Optional — ask the user** bucket follows up to ask whether the user has a template or wants to draft from scratch. **This answer also governs `create-qa-use-cases` and the e2e content inside `plan-feature`**: on `No — skip`, set `foundation_skills.create-qa-use-cases: disabled` too — derive-skills won't ship `create-qa-use-cases` and strips `plan-feature`'s `<!-- e2e:start/end -->` regions so no-e2e projects carry zero Playwright / `QA_USE_CASES.md` / `pr-screenshots/` references. On either `Yes`, set both `add-e2e-test` and `create-qa-use-cases` to `enabled`.
2. **`add-env-var`** — does the project have a non-trivial env-var propagation flow (multiple files / build configs / CI updates per new var) or a single `.env` file is enough? `AskUserQuestion` options: `Yes — non-trivial flow`, `No — single .env is enough`. Skip if `No`.
3. **`systematic-debugging`** — should agents follow a root-cause-first debugging flow that mandates pulling evidence from the project's observability MCP servers before proposing any fix? `AskUserQuestion` options: `Yes — enable`, `No — skip`. Recommend enabling whenever any observability MCP server is wired up — the skill bakes the project's real test / lint / build commands into the rendered checklist and instructs the agent to discover available calls on those servers at runtime (so it stays correct even as MCP servers add or rename tools).
4. **`add-one-off-script`** — does the project ever need one-off operational scripts (backfills, cleanups, ad-hoc data fixes) that mutate production data outside the regular migration / ETL / cron path? `AskUserQuestion` options: `Yes — enable`, `No — skip`. Recommend `Yes` for any project with a relational DB or large user dataset; the bundled `BaseOneOffScript` template enforces the safety contract (dry-run by default, idempotent re-runs, batched DB ops, streamed reads, segmented CSV backups capped at 1M cells per file with one set of files per affected table, interruption-safe signal handlers, console + filesystem + S3 logs that survive an interruption). Skip for read-only projects or projects whose only writes go through a migration tool.

   **Follow-up only when `add-one-off-script` = Yes.** Three short questions land in `skills.add-one-off-script` of `.vinta-ai-workflows.yaml`:
   - **Scripts dir.** Default `scripts/one_off`. Override for monorepos that nest scripts under a service / package dir. Free-form string.
   - **Primary language.** `AskUserQuestion`: `Python`, `TypeScript`. Auto-pick from `inventory.frameworks` when one language clearly dominates; ask only when polyglot. Drives which `BaseOneOffScript` template gets staged at `<scripts_dir>/_base.{py,ts}`.
   - **S3 bucket + prefix.** Open prose. Empty bucket disables S3 upload (filesystem copy stays authoritative). The skill also reads the `ONE_OFF_S3_BUCKET` / `ONE_OFF_S3_PREFIX` env vars at runtime, so leaving the config blank is fine if the team prefers env-only.

5. **`prepare-worktree`** — does the team want to run long-running plans / experiments inside an isolated git worktree (its own runnable copy of the app, with its own dev + test DB, env files, docker-compose project name) instead of swapping branches in the main checkout? `AskUserQuestion` options: `Yes — enable`, `No — skip`. Recommend `Yes` for any project with long migrations, multi-day plans, or teams where parallel concurrent work in the same checkout is common (one dev shipping a feature while another runs a migration; an agent driving `implement-plan` for hours while the human keeps coding on `main`). Skip for solo projects where branch-switching in place is unproblematic.

   **Follow-up only when `prepare-worktree` = Yes — worktree defaults.** Three short questions land under `skills.prepare-worktree.*`:
   - **Worktree root.** `AskUserQuestion`: `.claude/worktrees` (claude-code convention; the runtime's `EnterWorktree` puts them there), `../<repo-name>-wt-` (sibling dirs of the main checkout — survives across runtimes; relative-path tooling that walks up still works). Auto-pick the first when claude-code is the only selected vendor; ask when multiple vendors are in the **Scope** group's vendor coverage answer.
   - **Default deps strategy when the plan does NOT install new deps.** `AskUserQuestion`: `symlink` (fastest, reuses main's `node_modules` / `vendor/` / `venv/`), `copy` (defensive; safe for pnpm + npm + cargo + go; risky for yarn PnP + venv), `reinstall` (slowest, always correct). Recommend `symlink` for pnpm / npm / cargo / go projects; `reinstall` for poetry / yarn PnP.
   - **Default test-DB strategy.** `AskUserQuestion`: `fork-on-schema-change` (default — only forks when the plan body shows migrations), `always-fork` (defensive — every worktree gets its own test DB regardless), `share` (only safe for solo work; flaky cross-worktree test runs are the cost).

   **Follow-up — `implement-plan` default for worktree opt-in.** `AskUserQuestion`: should the `implement-plan` Step 0 question (c) — "run phases in a worktree?" — default to `Yes` or `No`? Lands in `run_options.implement-plan.use_worktree`. Recommend `No` for solo projects + short plans; `Yes` for teams that already use worktrees as part of their workflow.

   **Follow-up only when `systematic-debugging` = Yes — observability MCP server inventory.** Open prose, not multi-select. Ask the user to name every MCP server already wired up that exposes observability data, in whatever shorthand the team uses (`sentry`, `datadog`, `our-internal-traces`, `grafana-prod`, etc.). The intent is not to pick from a fixed catalogue — that goes stale fast — but to give the systematic-debugging agent a starter list of servers to introspect at Phase 0. Cross-check the answers against any MCP servers actually configured in the project's AI tooling (`.mcp.json`, `~/.claude/mcp_servers.json`, `.codex/mcp.json`, etc.) — if a server is configured but the user didn't mention it, ask whether it carries observability data. The selection lands in `skills.systematic-debugging.observability_mcp_servers` of `.vinta-ai-workflows.yaml` (free-form string array). Empty array is allowed but warn the user that Phase 0 collapses to "local logs only" and production-only bugs without telemetry become a guess factory. The agent will discover specific tool names + categories (error tracking, traces, logs, metrics, alerts, deploys, dashboards) from the live MCP tool list at runtime — see [vinta-derive-skills/resources/systematic-debugging-mcp-tools.md](../vinta-derive-skills/resources/systematic-debugging-mcp-tools.md) for the evidence categories baked into the rendered SKILL.md.

   **Cache scaffolding.** Preflight state lives at `.vinta-ai-workflows/cache.yaml` ([`mcp-preflight-cache.v1`](../../schemas/mcp-preflight-cache.v1.schema.json)). The bootstrap orchestrator must:

   - Add `.vinta-ai-workflows/` to `.gitignore` if not already present (the cache is per-developer-machine state — never committed). [vinta-install-ai-tools-setup](../vinta-install-ai-tools-setup/SKILL.md) handles the gitignore patch alongside the existing `.vinta-ai-workflows/prs-context/` entry.
   - Do **not** seed the cache file at bootstrap. The first debug run preflights all configured servers and writes the file then. An empty / missing `.vinta-ai-workflows/cache.yaml` is a valid initial state.
   - Mention to the user how to refresh: delete the file to re-preflight everything, or edit one entry's `status` to `dirty` to refresh that one server. Token rotated → cache will catch the auth error on the next call and flip the entry to `dirty` automatically.

6. **`thermo-nuclear-code-quality-review`** — does the team want an opt-in, deliberately harsh structural-maintainability audit available on demand (abstraction quality, giant files, spaghetti-condition growth), separate from the standard per-phase review? `AskUserQuestion` options: `Yes — enable`, `No — skip`. Recommend `Yes` for long-lived codebases where structural drift is a real cost, or teams that already run deep quality passes before merging large work. It ships as a user-invoked skill and is also the escalation target for the `review-phase` Layer 3 structural-simplification lens; it is never auto-run on every diff. No follow-up config — the body is project-agnostic.

7. **`handoff-to-client`** — is this an API-only repo whose consumers live in separate client codebases (mobile apps, SPAs, partner integrations) that need API changes documented for them? Ask **only when the inventory suggests an API-only shape** — backend framework with no co-located frontend app (no SPA package, no templates-rendered UI beyond an admin). `AskUserQuestion` options: `Yes — enable`, `No — skip`. Skip the question entirely (set `disabled`) for full-stack repos and monorepos that contain their own clients — there the API diff is visible to the client code in the same PR. When enabled, agents can generate a markdown API-change handoff document (endpoints added / changed / deprecated / removed vs the default branch, request/response shapes, breaking-change flags, per-platform migration notes) for client implementers who cannot read this repo.

   **Follow-up only when `handoff-to-client` = Yes — client-handoff config.** Four short questions land under `skills.handoff-to-client.*`:
   - **Client platforms.** Open prose → free-form string array, e.g. `iOS (Swift)`, `Android (Kotlin)`, `web SPA (React)`, `partner integrations`. Required, non-empty — this is the document's audience and drives the per-operation migration-notes sections.
   - **API style.** `AskUserQuestion`: `REST`, `GraphQL`, `gRPC`, other (free-form). Auto-pick from the inventory when unambiguous (e.g. DRF routers → REST, graphene/strawberry → GraphQL); ask only when mixed.
   - **API spec path.** Open prose. Repo-relative path to a machine-readable spec (OpenAPI file, GraphQL schema, proto dir) plus the command that regenerates it, if one exists (e.g. `docs/openapi.yaml (regenerate: make openapi)`). Cross-check the inventory for spec files the user forgot. Empty is fine — the rendered skill then enumerates changes from route/serializer code alone.
   - **Output dir.** Default `.vinta-ai-workflows/client-handoffs`. Override if the team wants handoffs committed (e.g. `docs/api-changes/`) — note that the default lives under the gitignored `.vinta-ai-workflows/`, so docs there must be shared manually.

If the user answers "No" to any of the seven, that skill won't ship. If the user answers "Yes" to `add-e2e-test` / `add-env-var` but doesn't have a template, derive-skills drafts one via interview. `systematic-debugging` is always template-rendered — no per-project drafting interview, just the MCP-server inventory above. `add-one-off-script` is copied verbatim from [vinta-derive-skills/resources/foundation-skills/add-one-off-script/](../vinta-derive-skills/resources/foundation-skills/add-one-off-script/) — its body is project-agnostic; the per-project variability lives in the `skills.add-one-off-script.*` config block above and in env vars consumed at runtime. `prepare-worktree` is also copied verbatim from [vinta-derive-skills/resources/foundation-skills/prepare-worktree/](../vinta-derive-skills/resources/foundation-skills/prepare-worktree/) — same pattern: project-agnostic body, per-project defaults under `skills.prepare-worktree.*`. `thermo-nuclear-code-quality-review` is copied verbatim from [vinta-derive-skills/resources/foundation-skills/thermo-nuclear-code-quality-review/](../vinta-derive-skills/resources/foundation-skills/thermo-nuclear-code-quality-review/) with no follow-up config — its body is fully project-agnostic. `handoff-to-client` is always template-rendered from [vinta-derive-skills/resources/handoff-to-client-template.md](../vinta-derive-skills/resources/handoff-to-client-template.md) — no per-project drafting interview, just the client-handoff config follow-up above.

### E. Existing AI artifacts (per-artifact disposition)

[vinta-analyze-codebase](../vinta-analyze-codebase/SKILL.md#11-existing-ai-tooling-artifacts)'s **Existing AI-tooling artifacts** scan produces an inventory of **every** AI-tooling artifact already in the repo: instruction docs (AGENTS.md / CLAUDE.md / .cursorrules / .github/copilot-instructions.md / ...), skills under `.claude/skills/`, `.cursor/skills/`, `.codex/skills/`, `.github/skills/`, `.agents/skills/`, `ai-tools/skills/`, and sub-agent files under `.claude/agents/`, `.cursor/agents/`, `.codex/agents/`, `.github/agents/`, `ai-tools/agents/`.

**Don't skip this step even when the inventory is short.** Three skill files in `.cursor/skills/` from a teammate's experiment are exactly the artifacts that get clobbered if the orchestrator forgets they exist.

For each artifact, read it (frontmatter + body), then ask the user via `AskUserQuestion`:

- **Instruction docs** (`AGENTS.md`, `CLAUDE.md`, etc.):
  - `Merge into new ai-tools/AGENTS.md` — `vinta-write-agents-md` folds existing content into the canonical sections, preserving anything still accurate.
  - `Keep as-is, link from ai-tools/AGENTS.md` — leave the file in place, reference it.
  - `Replace from scratch` — discard existing, draft fresh from inventory + interview.

- **Skills** (each under any vendor `skills/` dir):
  - `Migrate to ai-tools/skills/<name>/` — move into the canonical layout; `setup-ai-tools.mjs` will re-link to the chosen vendors. Vendor-prefixed dir (`vinta-*`) is left alone — installed by the `vinta-ai-workflows` CLI.
  - `Keep in current vendor path, don't touch` — leaves it where it is. AGENTS.md may reference it; downstream skill setup won't manage it.
  - `Drop` — delete (rare; usually the user wants to migrate).

  Foundation-shape skills (name matches `plan-feature`, `create-spec`, `create-qa-use-cases`, `implement-plan`, `implement-phase`, `review-phase`, `integrate-phase`, `amend-plan`, `add-e2e-test`, `add-env-var`, `add-one-off-script`, `prepare-worktree`, `thermo-nuclear-code-quality-review`, `deslop-comments`, `handoff`, `handoff-to-client`) get an extra option: `Replace with Vinta foundation version` — overwrites with the canonical foundation content, preserving the user's name. Useful when the existing version is stale. (`implement-phase` / `review-phase` / `integrate-phase` are the plan-execution sub-skills co-shipped with `implement-plan`; replace them as a unit.)

- **Sub-agents** (each under any vendor `agents/` dir):
  - `Migrate to ai-tools/agents/<name>.yaml` — converts vendor-specific format → canonical YAML; `setup-ai-tools.mjs` re-emits per-vendor copies.
  - `Keep in current vendor path, don't touch` — leaves it where it is.
  - `Drop`.

  Foundation-shape (`implementer`, `reviewer`, `fixer`) gets the `Replace with Vinta foundation version` option as well.

Surface decisions per artifact, **not** as a single batch. The user might want to migrate one custom skill but keep two others where they are.

### F. Design system doc (`DESIGN.md`)

Scan the repo root for `DESIGN.md` (case-insensitive). Per [Design.md with Cursor](https://designmd.app/blog/design-md-with-cursor/), this file holds the project's design system (colors, typography, spacing, components) in a Markdown format AI agents can consume before generating UI. **Never overwrite or rewrite an existing `DESIGN.md`** — the team owns its contents.

If present, ask via `AskUserQuestion`:

- `Keep and wire into AI tooling` (recommended) — leave file untouched at repo root; reference it from `ai-tools/AGENTS.md`; when `cursor` is in **Scope → Vendor coverage**, write `.cursor/rules/design.mdc` (Cursor Project Rules, Option A from the linked blog post) so Cursor auto-loads it before generating UI files.
- `Keep as-is, don't reference` — leave the file alone; no AGENTS.md mention, no Cursor rule.
- `Drop` — delete (rare; confirm twice before removing).

If absent, no prompt — don't fabricate a `DESIGN.md`. Record the gap so [vinta-write-agents-md](../vinta-write-agents-md/SKILL.md) can mention it as a TODO if the user wants design-system guidance.

The disposition lands in `project.design_md` of `.vinta-ai-workflows.yaml` (free-form string: `wired | kept-unreferenced | absent`). [vinta-write-agents-md](../vinta-write-agents-md/SKILL.md) reads it when `wired` and inserts a "Design system" section pointing at `DESIGN.md`. [vinta-install-ai-tools-setup](../vinta-install-ai-tools-setup/SKILL.md) reads it when `wired` + `cursor` ∈ `vendors` and writes `.cursor/rules/design.mdc` with this exact body:

```markdown
---
description: Design system rules — read DESIGN.md before generating UI
globs: ["**/*.tsx", "**/*.jsx", "**/*.vue", "**/*.svelte", "**/*.astro", "**/*.css"]
---

Before generating any visual component, read the DESIGN.md file at the project root.

Rules:
- Use ONLY the colors defined in DESIGN.md
- Follow the typographic scale exactly
- Apply spacing values from the Spacing section
- Follow component patterns from the Components section
- Never violate the Do's and Don'ts section
- When in doubt, reference DESIGN.md — do not invent new values
```

Globs may need tuning for the project's actual UI file extensions (Svelte-only projects, RN `.tsx`, etc.). Ask the user once if the analysis surfaced a UI framework not covered by the default glob list; otherwise ship the defaults.

After Step 0: read back the captured decisions (including every per-artifact disposition), confirm via `AskUserQuestion` (`Looks good`, `Some corrections (I'll list)`, `Stop, rethink`).

The dispositions become inputs to:

- `vinta-write-agents-md` — knows whether to merge / link / replace.
- `vinta-derive-subagents` — knows which agents to migrate vs leave; doesn't redrop a foundation file the user said `Replace`.
- `vinta-derive-skills` — same logic for skills. Doesn't ship a foundation version the user said `Keep` for.

## Step 0.5 — Write `.vinta-ai-workflows.yaml` (single source of truth)

Captured interview state lands in **one** YAML file at the repo root: `.vinta-ai-workflows.yaml`. Schema: [`schemas/vinta-ai-workflows-config.v1.schema.json`](../../schemas/vinta-ai-workflows-config.v1.schema.json) (`schema_version: 1`).

This file is the **only** source of truth for project-wide settings. Every downstream sub-skill (4 → 6 below) reads from it instead of receiving values via in-conversation state. Every meta-skill ([vinta-sync-ai-tools](../vinta-sync-ai-tools/SKILL.md), [vinta-update-project-skills](../vinta-update-project-skills/SKILL.md)) reads + rewrites it.

Write the file now (before any sub-skill runs). Populate from the interview groups **Scope**, **Stack detection**, **Project conventions**, **Optional foundation skills**, and **Existing AI artifacts**:

```yaml
# yaml-language-server: $schema=./node_modules/vinta-ai-workflows/schemas/vinta-ai-workflows-config.v1.schema.json

schema_version: 1
vinta_ai_workflows_version: <pkg version detected at install time>
last_synced_at: <ISO 8601 now>

project:
  name: <from inventory>
  default_branch: <from inventory>
  code_host: <github | gitlab | bitbucket | self-hosted>
  stack_summary: <inventory.frameworks one-liner>
  ai_plans_dir: <ai-plans | apps/<service>/ai-plans | ...>
  pr_template_paths: <inventory.existing_ai_artifacts.pr_templates[].path>  # empty array if none found
  design_md: <Step 0.F → wired | kept-unreferenced | absent>

commands:
  lint: <Project conventions → Source of truth for code style>
  format: <derived>
  build: <derived>
  test_unit: <Project conventions → Test framework(s)>
  test_unit_scoped: <derived from monorepo shape>
  test_unit_new_pattern: <derived>
  e2e: <only when foundation_skills.add-e2e-test = enabled>

policies:
  pr_creation: <Project conventions → PR creation policy>
  commit_strategy: <Project conventions → Commit strategy>  # stacked-branches | modular-commits | ask
  ai_coauthor: <Project conventions → Co-author trailer policy>
  commit_style: <conventional | imperative | other>
  stage_pattern: <derived>
  anti_git_add_all_reason: <derived>
  # Only emit `dependency_licenses` when enforcement != Off (the `off` value is
  # supported by the schema but the agent never needs the rest of the block
  # when there is no check to run — keep the config slim).
  dependency_licenses:
    enforcement: <Project conventions → license policy enforcement → block | warn | off>
    forbidden_spdx: <license policy forbidden list — array of SPDX IDs the user confirmed at bootstrap>
    allowed_overrides:                       # empty array when the user listed no exceptions
      - package: <name>
        license: <SPDX ID — must appear in forbidden_spdx>
        reason: <one-line justification>
    notes: <free-form prose, omit when blank>

vendors: <Scope → Vendor coverage list>

foundation_skills:
  plan-feature: enabled
  create-spec: enabled
  create-qa-use-cases: enabled
  implement-plan: enabled
  amend-plan: enabled
  open-pr-from-context: enabled
  add-e2e-test: <Optional foundation skills → add-e2e-test answer → enabled | disabled>
  add-env-var: <Optional foundation skills → add-env-var answer → enabled | disabled>
  systematic-debugging: <Optional foundation skills → systematic-debugging answer → enabled | disabled>
  add-one-off-script: <Optional foundation skills → add-one-off-script answer → enabled | disabled>
  prepare-worktree: <Optional foundation skills → prepare-worktree answer → enabled | disabled>
  thermo-nuclear-code-quality-review: <Optional foundation skills → thermo-nuclear-code-quality-review answer → enabled | disabled>
  deslop-comments: enabled  # always ships — review-phase Layer 2 comment-hygiene + fix loop depend on it
  handoff: enabled  # always ships — project-agnostic session-continuation handoff docs
  handoff-to-client: <Optional foundation skills → handoff-to-client answer → enabled | disabled; only asked for API-only repos>

foundation_agents:
  implementer: enabled
  reviewer: enabled
  fixer: enabled

stacks: <Stack detection → matched stacks>
stack_specialist_agents: <empty unless user supplied templates>

run_options:
  implement-plan:
    pause_between_phases: false
    generate_inline_comments: false
    full_test_suite: false  # default: each phase's outer gate runs scoped tests only; set true to run the full suite every phase
    use_worktree: <Optional foundation skills → prepare-worktree follow-up → default for Step 0 question (c); false unless team opted in>
  amend-plan:
    blast_radius_signal_threshold: 2

skills:
  # Only emit this block when foundation_skills.systematic-debugging = enabled.
  systematic-debugging:
    observability_mcp_servers: <systematic-debugging follow-up — free-form array of MCP server identifiers, e.g. [sentry, datadog, our-internal-traces]>

  # Only emit this block when foundation_skills.handoff-to-client = enabled.
  handoff-to-client:
    client_platforms: <handoff-to-client follow-up — free-form array, e.g. [iOS (Swift), Android (Kotlin), web SPA (React)]>
    api_style: <handoff-to-client follow-up — REST | GraphQL | gRPC | free-form>
    api_spec_path: <handoff-to-client follow-up — repo-relative spec path + regen command; omit when none>
    output_dir: .vinta-ai-workflows/client-handoffs

  # Only emit this block when foundation_skills.prepare-worktree = enabled.
  prepare-worktree:
    worktree_root: <prepare-worktree follow-up — `.claude/worktrees` | `../<repo>-wt-`>
    deps_strategy: <prepare-worktree follow-up — symlink | copy | reinstall>
    compose_network: per-worktree
    test_db_strategy: <prepare-worktree follow-up — fork-on-schema-change | always-fork | share>
    summary_dir: .vinta-ai-workflows/worktrees

  # Only emit this block when foundation_skills.add-one-off-script = enabled.
  add-one-off-script:
    scripts_dir: <add-one-off-script follow-up — default `scripts/one_off`>
    language: <add-one-off-script follow-up — `python` | `typescript`>
    log_dir: .vinta-ai-workflows/one-off-runs
    default_batch_size: 500
    csv_max_cells: 1000000
    s3_bucket: <add-one-off-script follow-up — empty disables S3 upload>
    s3_prefix: one-off-runs/
```

Validate the file against the schema before writing — if any required field is unresolved, route back to the relevant interview question. Don't write a partial config.

Existing-project case: `.vinta-ai-workflows.yaml` already present → that's a re-bootstrap. Show the existing config, ask via `AskUserQuestion`: `Keep existing config and refresh sub-skills only`, `Re-interview and overwrite`, `Stop`. The `Refresh sub-skills only` path is the common case for older projects whose config was written by an earlier `vinta-bootstrap-ai-tools`.

## Stack templates — detection only, content is user-supplied

[`resources/stacks/<stack>/notes.md`](resources/stacks/) defines **detection signals** + lists the **categories of skills + sub-agents that typically belong** to each stack. **It does NOT ship ready-made skill / agent content.** The team's specific skill library lives wherever the team keeps it (a shared repo, a personal `~/skills/` dir, a published package, a private gist) — the bootstrap orchestrator asks the user to point at it when a stack matches.

| Stack | Detected by | What the notes.md describes |
|---|---|---|
| Medplum | `@medplum/*` deps + `bots/` dir + tenant compartmenting signals | bot skills, AccessPolicy skill, deploy-author agent |
| Django + Postgres | `manage.py` + Django dep + `migrations/` dirs (multi-tenant signals optional) | model + migration skills, migration-author agent |
| TypeScript monorepo | `turbo.json` / `pnpm-workspace.yaml` + `apps/`+`lib/` layout | env-var + shared-package skills (foundation only) |
| Python package | `pyproject.toml` without Django; `src/<pkg>/` layout | module + CLI + release skills as applicable |
| Next.js App Router | `next.config.*` + `app/` dir | route, server-action, caching, middleware, route-handler skills |

For each matched stack, the orchestrator (via [vinta-derive-skills](../vinta-derive-skills/SKILL.md) and [vinta-derive-subagents](../vinta-derive-subagents/SKILL.md)):

1. Reads `<stack>/notes.md`.
2. Surfaces the match: *"Detected stack X. Notes say teams typically maintain skills for: A, B, C. Do you have existing templates for any?"*
3. If the user has templates → ask for paths (filesystem path, Git URL, package name on disk, etc) and copy + adapt them into the target's `ai-tools/`.
4. If not → record as a known gap. The user can run `vinta-derive-skills` standalone later to draft them from scratch using the canonical structure.

If multiple stacks match (common — TypeScript monorepo + Medplum, or Django + Python-package), the orchestrator handles each; the user can supply templates for any subset.

### Adding a new stack

1. `mkdir resources/stacks/<stack-name>`.
2. Write `notes.md` with detection signals + skill / agent categories + placeholders to ask about.
3. Update the **Frameworks (from dependencies)** scan in [vinta-analyze-codebase](../vinta-analyze-codebase/SKILL.md#3-frameworks-from-dependencies) if a new dep / signal needs to be detected.
4. Update the table above.

No skill / agent content lives in `resources/stacks/<stack>/`. That's by design — those are project- and team-specific.

## Outputs

After Step 0.5 + all six sub-skills run, the target repo has:

```
.vinta-ai-workflows.yaml                    ← single source of truth (Step 0.5)
                                              schema: schemas/vinta-ai-workflows-config.v1.schema.json
.vinta-ai-workflows/                        ← gitignored local state (only when systematic-debugging enabled)
└── cache.yaml                              ← MCP preflight cache, schema: mcp-preflight-cache.v1.schema.json
ai-tools/
├── AGENTS.md
├── skills/
│   ├── plan-feature/SKILL.md            ← always (copied verbatim from derive-skills resources)
│   ├── create-spec/SKILL.md             ← always (copied verbatim)
│   ├── create-qa-use-cases/SKILL.md     ← always (copied verbatim)
│   ├── deslop-comments/SKILL.md         ← always (copied verbatim; review-phase Layer 2 comment-hygiene + fix loop depend on it)
│   ├── handoff/SKILL.md                 ← always (copied verbatim; session-continuation handoff docs under .vinta-ai-workflows/handoffs/)
│   ├── implement-plan/SKILL.md          ← always (conductor; generated from template, project-specific)
│   ├── implement-phase/SKILL.md         ← always (plan-execution unit; co-shipped with implement-plan)
│   ├── review-phase/SKILL.md            ← always (plan-execution unit; shared by implement-plan / amend-plan / systematic-debugging)
│   ├── integrate-phase/SKILL.md         ← always (plan-execution unit; push + PR. Under commit_strategy=ask: integrate-phase-stacked/ + integrate-phase-modular/ instead)
│   ├── amend-plan/SKILL.md              ← always (conductor; generated from template, project-specific)
│   ├── add-e2e-test/SKILL.md            ← optional — only if user opts in
│   ├── add-env-var/SKILL.md             ← optional — only if user opts in
│   ├── systematic-debugging/SKILL.md    ← optional — only if user opts in (template-rendered)
│   ├── handoff-to-client/SKILL.md       ← optional — only for API-only repos, if user opts in (template-rendered; config under skills.handoff-to-client.*)
│   ├── add-one-off-script/              ← optional — only if user opts in (verbatim copy + bundled BaseOneOffScript + LocalRuntime templates)
│   │   ├── SKILL.md
│   │   └── resources/
│   │       ├── one_off_script_base.py
│   │       └── one_off_script_base.ts
│   ├── prepare-worktree/SKILL.md       ← optional — only if user opts in (verbatim copy; project-agnostic body, defaults under skills.prepare-worktree.*)
│   ├── thermo-nuclear-code-quality-review/SKILL.md ← optional — only if user opts in (verbatim copy; deep structural-maintainability audit, escalation target for review-phase Layer 3)
│   ├── run-one-off-script-django/       ← optional sister skill — only when stack matches + user supplies template (authors Jupyter notebook / mgmt command runner + JupyterRuntime / DjangoMgmtRuntime adapter in the per-script folder)
│   ├── run-one-off-script-medplum/      ← optional sister skill — only when stack matches + user supplies template (authors Medplum bot + MedplumBotRuntime adapter in the per-script folder)
│   └── <stack-specific skills>/SKILL.md ← only if user supplied templates
├── agents/
│   ├── implementer.yaml                 ← always (foundation)
│   ├── reviewer.yaml                    ← always (foundation)
│   ├── fixer.yaml                       ← always (foundation)
│   ├── README.md                        ← schema doc
│   └── <stack-specific>.yaml            ← only if user supplied templates
└── scripts/
    └── setup-ai-tools.mjs               ← copied from install-ai-tools-setup resources

DESIGN.md                                 ← preserved at repo root if pre-existing (never overwritten)
.cursor/rules/design.mdc                  ← only when DESIGN.md exists, user opted Wire it in,
                                              and `cursor` ∈ vendors (Cursor Project Rules, Option A
                                              from https://designmd.app/blog/design-md-with-cursor/)

ai-plans/                                 ← created by migrate-plans-specs (step 6)
├── YYYY-MM-DD-FEATURE_NAME_SPEC.md      ← migrated from docs/, specs/, root, etc.
└── YYYY-MM-DD-FEATURE_NAME_PLAN.md      ← future docs land here too (foundation
                                            skills `create-spec` + `plan-feature`
                                            write to this layout)
```

Plus the symlinks + per-vendor generated files, set up by the install step.

Foundation skills break into three buckets — see [vinta-derive-skills](../vinta-derive-skills/SKILL.md) for the full mechanics:

- **Always copy verbatim**: `plan-feature`, `create-spec`, `create-qa-use-cases`, `deslop-comments`, `handoff`. Bundled with the bootstrap skill set; project-agnostic enough to ship as-is (with light path scrubs). `deslop-comments` always ships because `review-phase`'s Layer 2 comment-hygiene check + fix loop dispatch it. `handoff` always ships because its session-continuation body is fully project-agnostic.
- **Always generate**: the plan-execution unit — `implement-plan` (conductor) + its co-shipped sub-skills `implement-phase` / `review-phase` / `integrate-phase`, plus `amend-plan` (conductor). Bodies have too much project-specific content (test commands, branch convention, PR + co-author policy, agent dispatch) — generated from parameterized templates + shared partials using interview answers + inventory. The sub-skills are not independently opt-in; they always ship with the conductors.
- **Optional, ask first**: `add-e2e-test`, `add-env-var`, `systematic-debugging`, `add-one-off-script`, `prepare-worktree`, `thermo-nuclear-code-quality-review`, `handoff-to-client`. Skipped by default; orchestrator asks via `AskUserQuestion` whether the project has the relevant flow at all. `add-e2e-test` / `add-env-var`: if yes + user has a template → copy + adapt; if yes + no template → draft from scratch via interview; if no → don't ship. `systematic-debugging`: if yes → render the bundled template plus the per-tool MCP catalogue blocks for the observability tools selected in its follow-up; if no → don't ship. `add-one-off-script`: if yes → copy the bundled SKILL.md verbatim plus the language-specific `BaseOneOffScript` template (`one_off_script_base.py` / `one_off_script_base.ts`) chosen via its follow-up; if no → don't ship. `prepare-worktree`: if yes → copy the bundled SKILL.md verbatim, populate `skills.prepare-worktree.*` defaults from its follow-ups, and (when the user opted in via the worktree-default follow-up) flip `run_options.implement-plan.use_worktree` to `true` so `implement-plan`'s Step 0 question (c) defaults to yes; if no → don't ship. `thermo-nuclear-code-quality-review`: if yes → copy the bundled SKILL.md verbatim (no follow-up config); if no → don't ship. `handoff-to-client`: asked only for API-only repos; if yes → render the bundled template using `skills.handoff-to-client.*` (client platforms, API style, spec path, output dir) from its follow-ups; if no → don't ship.

Stack-specific skills + agents land in the target only when the user provides templates for them. If they don't have templates yet, the orchestrator records the detected stacks + skill categories as a TODO list the user can address later via [vinta-derive-skills](../vinta-derive-skills/SKILL.md) / [vinta-derive-subagents](../vinta-derive-subagents/SKILL.md) standalone runs.

## Rules

- **Read before write.** Always check what's in the target repo first. Don't clobber existing AGENTS.md / skills / agents without an explicit confirmation in Step 0.
- **Stack templates are starting points, not finals.** Each copied skill / agent must be reviewed against the actual project (interview the user about specifics) and edited where the template's assumptions don't fit.
- **Don't fabricate conventions.** If `vinta-analyze-codebase` doesn't find a thing, ask the user. Don't write "Use bulk_create instead of loop+save" into AGENTS.md just because Django was detected — confirm the team actually follows it.
- **Foundation skills are universal.** Every project gets `add-env-var`, `add-e2e-test`, `plan-feature`, `implement-plan`, `create-spec`, `create-qa-use-cases`. The bodies need light per-project edits (test commands, branch conventions) — `vinta-derive-skills` handles that.
- **Foundation agents are universal.** `implementer` / `reviewer` / `fixer` always. Stack specialists (`deploy-author` for Medplum, `migration-author` for Django) only when the stack matches.
- **Don't run install-ai-tools-setup until AGENTS.md + agents YAMLs + skills exist.** The setup script reads these files; running it on an empty `ai-tools/` produces nothing useful.
- **Multi-vendor coverage matches the user's selection.** The install step's `--only` flag is set from the Step 0 **Scope → Vendor coverage** answer.
- **`DESIGN.md` is sacrosanct.** If the repo already has one, never overwrite, rewrite, or "clean up" its contents. Only ever read it to verify shape, and only ever write the sibling `.cursor/rules/design.mdc` pointer when the user opts in + `cursor` is a selected vendor.

## Pitfalls

- **Bootstrapping a project that already has its own conventions.** The user's existing AGENTS.md / CONTRIBUTING.md / `.cursorrules` is gospel. Treat as input to `vinta-write-agents-md`, not noise to overwrite.
- **Detecting Django without verifying multi-tenancy.** Many Django projects are single-tenant; emitting `tenant_id` rules into AGENTS.md is wrong for them. Stack templates are starting points — interview before assuming.
- **Stack templates pulling source-repo-specific paths.** Templates are written to be project-agnostic (no `apps/<service>` hard-coding) but they may slip. Review each copied SKILL.md / agent.yaml for hard-coded paths from the source repo.
- **Skipping the interview because "the analysis is enough".** It isn't. Conventions humans hold but don't commit (PR review tone, deploy approvals, who-owns-what) only surface in conversation.
- **Forgetting to commit the canonical sources.** Generated vendor files are noisy in PRs. `vinta-derive-subagents` writes YAML; `vinta-install-ai-tools-setup` runs the script that produces vendor copies. Commit both — don't gitignore the vendor outputs unless the team agrees.

## Verification

After all sub-skills finish:

1. `ls -la ai-tools/` — confirm AGENTS.md, skills/, agents/, scripts/ all exist.
2. `node ai-tools/scripts/setup-ai-tools.mjs` — runs cleanly, no errors.
3. Each selected vendor's directory has the expected files: `.claude/agents/*.md`, `.cursor/agents/*.md`, `.github/agents/*.agent.md`, `.codex/agents/*.toml`.
4. Spot-check one skill, one agent: open SKILL.md / `<agent>.yaml` and confirm content describes THIS project (not a copy-pasted template with `<placeholder>` strings).
5. If the project uses Claude Code: in a new session, ask Claude to invoke one of the project-specific skills. Confirm it loads + the body looks right.
6. If [vinta-migrate-plans-specs](../vinta-migrate-plans-specs/SKILL.md) ran: `ls ai-plans/` lists the migrated docs in canonical `YYYY-MM-DD-{FEATURE_NAME}_{PLAN|SPEC}.md` form. `git status` shows the renames staged (or already committed). No plan/spec markdown left orphaned in `docs/`, `specs/`, or repo root unless the user explicitly skipped them.

End the run with a one-paragraph summary: what was created, what was skipped (per `--only`), what manual edits the user should review.
