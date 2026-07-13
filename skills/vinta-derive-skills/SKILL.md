---
name: vinta-derive-skills
description: Author project-specific skills under `ai-tools/skills/`. Always copies the project-agnostic foundation set (`plan-feature`, `create-spec`, `open-pr-from-context`) verbatim from this skill's bundled resources; ships `create-qa-use-cases` and keeps `plan-feature`'s e2e sections only when `add-e2e-test` is enabled. Generates `implement-plan` from a parameterized template using project-specific commands + branch / commit / PR conventions captured in the bootstrap interview. Asks the user whether `add-e2e-test` and `add-env-var` are needed (optional foundation skills — only ship if applicable). Stack-specific skills (Medplum, Django, etc) come from user-supplied templates pointed at by the orchestrator — see [bootstrap-ai-tools/resources/stacks/<stack>/notes.md](../vinta-bootstrap-ai-tools/resources/stacks/) for the categories per stack.
---

# Derive skills

Author the project's `ai-tools/skills/<name>/SKILL.md` files. Skills are reusable instruction sets the agent invokes when a task matches their description.

## Output

`ai-tools/skills/<name>/SKILL.md` for each skill. Some skills bring resources (templates, scripts) — those go under `ai-tools/skills/<name>/resources/`.

## Inputs

1. Inventory from [vinta-analyze-codebase](../vinta-analyze-codebase/SKILL.md), specifically `existing_ai_artifacts.skills` — every skill file already in the repo with name, description, classification (`vinta-managed` / `foundation-shape` / `project-custom`).
2. AGENTS.md from [vinta-write-agents-md](../vinta-write-agents-md/SKILL.md).
3. Step 0 interview answers from [vinta-bootstrap-ai-tools](../vinta-bootstrap-ai-tools/SKILL.md), including the [Existing AI artifacts](../vinta-bootstrap-ai-tools/SKILL.md#e-existing-ai-artifacts-per-artifact-disposition) group's **per-skill disposition** (migrate / keep / drop / replace).
4. Stack matches from the inventory; for each, the skill categories listed in [bootstrap-ai-tools/resources/stacks/<stack>/notes.md](../vinta-bootstrap-ai-tools/resources/stacks/).
5. User-supplied stack templates for matched stacks (path / URL / package — asked at runtime).

## Reconcile against existing skills (do this FIRST)

Before drafting any new SKILL.md, walk through every entry in `existing_ai_artifacts.skills` and apply the disposition the user picked in the bootstrap interview's [Existing AI artifacts](../vinta-bootstrap-ai-tools/SKILL.md#e-existing-ai-artifacts-per-artifact-disposition) group:

- **Migrate to `ai-tools/skills/<name>/`** — `git mv` the existing skill folder (with all its resources) into the canonical layout. After move, scan the body for hard-coded vendor paths that no longer apply (`.cursor/skills/...` self-references, etc.) and rewrite to the new path. `setup-ai-tools.mjs` will re-link to the chosen vendors.
- **Keep in current vendor path, don't touch** — leave it where it is; AGENTS.md may reference it; downstream skill setup won't manage it. **Don't ship a foundation duplicate that would shadow it.**
- **Drop** — log removal; don't emit anything.
- **Replace with Vinta foundation version** (foundation-shape only — `plan-feature`, `create-spec`, `create-qa-use-cases`, `implement-plan`, `add-e2e-test`, `add-env-var`, `add-one-off-script`, `prepare-worktree`, `thermo-nuclear-code-quality-review`, `deslop-comments`, `handoff`, `handoff-to-client`) — proceed with the bucket A / B / C flow below for that name. The user has explicitly opted into overwriting their version.
- **`vinta-managed`** (any skill whose dir starts with `vinta-`) — leave alone. These come from the `vinta-ai-workflows` CLI; `vinta-derive-skills` doesn't manage them.

For each name in the foundation set: only emit it (verbatim copy / generate from template / interview-draft) when no existing skill of that name is being migrated or kept. If the user said `Migrate` or `Keep` for an existing `plan-feature/SKILL.md`, **do not overwrite**.

For project-custom skills: never auto-generate something the user already has under a different name. If the user has `<their-name>/SKILL.md` covering ground a stack template would also cover, ask before adding the stack-template version.

## Foundation set

Three buckets:

### A. Always copy — verbatim from bundled resources

These are project-agnostic enough to ship as-is. Copy from this skill's [resources/foundation-skills/](resources/foundation-skills/) into the target's `ai-tools/skills/<name>/SKILL.md`.

| Skill | Source | What it does |
|---|---|---|
| `plan-feature` | [resources/foundation-skills/plan-feature/SKILL.md](resources/foundation-skills/plan-feature/SKILL.md) | Author phased implementation plans for a new feature, with interview-driven scoping. |
| `create-spec` | [resources/foundation-skills/create-spec/SKILL.md](resources/foundation-skills/create-spec/SKILL.md) | Turn a raw feature prompt into a structured spec doc. |
| `create-qa-use-cases` | [resources/foundation-skills/create-qa-use-cases/SKILL.md](resources/foundation-skills/create-qa-use-cases/SKILL.md) | Bootstrap a project's `QA_USE_CASES.md` from the active spec/plan. **E2E-gated** — ship only when `foundation_skills.add-e2e-test` is `enabled`; QA use-cases exist to seed e2e specs, so a no-e2e project has no use for it. |
| `open-pr-from-context` | [resources/foundation-skills/open-pr-from-context/](resources/foundation-skills/open-pr-from-context/) | Thin SKILL.md wrapper around [scripts/open-pr.sh](resources/foundation-skills/open-pr-from-context/scripts/open-pr.sh) — bash script that publishes one `.vinta-ai-workflows/prs-context/{feature}/{phase}.md` file as a real PR + inline comments via the project's PR CLI (`gh` / `glab`). Used by `implement-plan` (when CLI + `yq`/`jq` are available) and standalone (to publish a `pending` file later). |
| `deslop-comments` | [resources/foundation-skills/deslop-comments/SKILL.md](resources/foundation-skills/deslop-comments/SKILL.md) | Rewrite comments + doc blocks touched during a task into Simple English — strip AI-slop vocabulary and negative framing; comment-only, no renames or behavior change. **Always ships** — the `review-phase` Layer 2 comment-hygiene check + fix loop dispatch it, so it must exist in the target. Also user-invokable standalone ("deslop these comments"). |
| `handoff` | [resources/foundation-skills/handoff/SKILL.md](resources/foundation-skills/handoff/SKILL.md) | Write or consume a session-continuation handoff doc under `.vinta-ai-workflows/handoffs/` — goal, current state, decisions + rationale, landmines, next step — so a fresh agent session (or a teammate) resumes in-flight work without re-deriving context. **Always ships** — fully project-agnostic; standalone (no cross-links into the always-on trio). |
| `prepare-worktree` | [resources/foundation-skills/prepare-worktree/](resources/foundation-skills/prepare-worktree/) | Provision a runnable, isolated git worktree for parallel feature work — symlink dep dirs (or copy / reinstall when the plan churns deps), copy + mutate env files, fork dev + test DBs when migrations are in scope, namespace docker-compose project + network, OS-sandbox the worktree so main-checkout writes are blocked (bundled [scripts/sandbox-run.sh](resources/foundation-skills/prepare-worktree/scripts/sandbox-run.sh) — `sandbox-exec` / `bwrap`), write a teardown-ready summary YAML. Used by `implement-plan` when Step 0 question (c) opts in; standalone for ad-hoc isolation. Opt-in (bucket A + ask-first via the bootstrap's **Optional foundation skills** interview). |
| `thermo-nuclear-code-quality-review` | [resources/foundation-skills/thermo-nuclear-code-quality-review/SKILL.md](resources/foundation-skills/thermo-nuclear-code-quality-review/SKILL.md) | Opt-in deep structural-maintainability audit of a diff — abstraction quality, giant files, spaghetti-condition growth — harsher than the standard per-phase review; hunts for "code-judo" reframes that collapse branches / helpers / layers rather than polishing them. Read-only; hands each fix to the `fixer` agent. Invoked deliberately by the user, or escalated from the `review-phase` Layer 3 structural-simplification lens. Opt-in (bucket A + ask-first via the bootstrap's **Optional foundation skills** interview). |

These reference each other:

- `plan-feature` reads spec; dispatches `create-qa-use-cases` when the doc is missing (e2e-enabled projects only — see below).
- `implement-plan` (bucket B below) writes per-phase PR-context files following [resources/prs-context-template.md](resources/prs-context-template.md), then invokes `open-pr-from-context` when a PR CLI is detected.

The **always-on unit** is `plan-feature` + `create-spec` + `open-pr-from-context` — copy all three or none. `deslop-comments` also always ships (independently — it doesn't cross-reference the trio), because the `review-phase` Layer 2 comment-hygiene check + fix loop dispatch it; a target missing it would leave that review step dangling. `handoff` also always ships independently — its body is fully project-agnostic and nothing else depends on it. `create-qa-use-cases` joins the unit **only when `foundation_skills.add-e2e-test` is `enabled`**; when add-e2e-test is disabled (or absent), don't ship it and set `foundation_skills.create-qa-use-cases: disabled` in `.vinta-ai-workflows.yaml` to match.

**E2E stripping in `plan-feature`.** `plan-feature` ships verbatim but carries e2e-only regions delimited by `<!-- e2e:start -->` / `<!-- e2e:end -->` lines. When copying it, run an e2e pass:

- **Always delete the marker lines themselves** (`<!-- e2e:start -->` / `<!-- e2e:end -->`) so they never reach the shipped file.
- **When `foundation_skills.add-e2e-test` is `disabled` or absent**, also delete everything *between* each marker pair. Result: a no-e2e project gets a `plan-feature` with zero Playwright / `QA_USE_CASES.md` / `pr-screenshots/` / `add-e2e-test` references — no noise in the plans it authors.
- **When `add-e2e-test` is `enabled`**, keep the enclosed content (strip only the markers).

After copying, scan each for project-specific path references that no longer match the target (the bundled copies may still carry source-repo paths such as `<source-repo>/ai-plans/` or `apps/<service>/`). Replace with the target's paths from the inventory.

### B. Generate — the **plan-execution unit** + `systematic-debugging` from templates

Project-specific skills, generated from templates because their bodies cite real test commands, branch conventions, agent dispatch table, PR / co-author policy, or selected MCP tools.

The forward-execution + amend flow is decomposed into a **plan-execution unit** — two thin conductors that dispatch to three shared single-purpose sub-skills. All five render from [resources/plan-execution/shell/](resources/plan-execution/shell/), which pulls shared bodies from [resources/plan-execution/partials/](resources/plan-execution/partials/) (see [Rendering the plan-execution unit](#rendering-the-plan-execution-unit) below):

- **`implement-plan`** — thin conductor: parse plan → classify phases → resolve one `WORKROOT` → per-phase loop (dispatch to the three sub-skills) → track → report. From `shell/implement-plan-template.md`.
- **`amend-plan`** — thin conductor: history rewriting (revise plan, amend commits, force-push, rebase stacked downstreams, refresh PR-context). From `shell/amend-plan-template.md`. Reuses `implement-phase` (for `amend-existing` rewrites) + `review-phase` (verbatim), keeps its own git topology.
- **`implement-phase`** — compose implementer prompt + pick model + spawn one implementer subagent. From `shell/implement-phase-template.md`.
- **`review-phase`** — three-layer review + fix loop. From `shell/review-phase-template.md`. **Shared by all three conductors** (implement-plan, amend-plan, systematic-debugging).
- **`integrate-phase`** — push the reviewed phase + open PR via context file. From `shell/integrate-phase-template.md`, rendered **commit-strategy-resolved** (see the [commit-strategy substitution table](#commit_strategy_-substitution-table)).

The five are a **co-shipped unit**: `implement-plan` is always generated, so `implement-phase` / `review-phase` / `integrate-phase` are always generated alongside it (they are its decomposition, not independently opt-in — there is no `foundation_skills` enum entry for them, and the bootstrap interview never asks about them). `amend-plan` is likewise always generated. They are separate `ai-tools/skills/<name>/SKILL.md` files so each can be reviewed and evolved on its own.

- **`systematic-debugging`** — root-cause-first debugging flow with project-specific reproduction commands and enforced observability MCP evidence-gathering. From [resources/systematic-debugging-template.md](resources/systematic-debugging-template.md) plus the **MCP-agnostic** evidence-categories block at [resources/systematic-debugging-mcp-tools.md](resources/systematic-debugging-mcp-tools.md) — the rendered SKILL.md instructs the agent to list available MCP tools at runtime and map them to evidence categories (error tracking, traces, logs, metrics, alerts, deploys, dashboards), instead of hardcoding tool names that go stale. **Opt-in** — only generated when `foundation_skills.systematic-debugging` is `enabled` in `.vinta-ai-workflows.yaml`. The free-form list of MCP server identifiers rendered into the body comes from `skills.systematic-debugging.observability_mcp_servers` in the same config. It reuses `review-phase` for its Phase 4 review gate (an `invoke [review-phase]` reference — always resolvable because the plan-execution unit is always shipped).

- **`handoff-to-client`** — generate a markdown API-change handoff document for the client teams consuming an API-only repo: endpoints/operations added / changed / deprecated / removed on the current branch vs the default branch, with request/response shapes, breaking-change flags, and per-platform migration notes. From [resources/handoff-to-client-template.md](resources/handoff-to-client-template.md). **Opt-in** — only generated when `foundation_skills.handoff-to-client` is `enabled` in `.vinta-ai-workflows.yaml` (the bootstrap interview asks only when the repo looks API-only with separate client codebases). The rendered body bakes in `skills.handoff-to-client.*` config: client platforms, API style, optional API spec path, output dir. Standalone — no cross-links into the plan-execution unit.

Every plan-execution shell + `systematic-debugging` consumes the placeholder set below — render each by substituting from the inventory + Step 0 interview answers. `systematic-debugging` reuses the same set plus two extra placeholders (`{{OBSERVABILITY_MCP_BLOCK}}`, `{{OBSERVABILITY_MCP_LIST}}`) rendered from the catalogue.

#### Rendering the plan-execution unit

Shells under `plan-execution/shell/` are thin — most content lives in `plan-execution/partials/` and is spliced in at render time. Per shell, in order:

1. **Expand includes.** Replace every include directive with the referenced partial content:
   - `<!-- include: partials/<file>.md -->` — the whole partial body.
   - `<!-- include: partials/<file>.md#BLOCK -->` — only the block between `<!-- block-begin: BLOCK -->` / `<!-- block-end: BLOCK -->` (markers excluded). Includes may nest (e.g. `implementer-prompt.md#FULL` itself includes `#INNER_OUTER_LOOP`) — expand recursively.
   - `<!-- include: partials/commit-strategy/<RESOLVED>.md#BLOCK -->` — bind `<RESOLVED>` to the project's `policies.commit_strategy` (`stacked` → `stacked.md`, `modular` → `modular.md`). For `ask`, see the split below.
   - Ignore the `rendering-guidance` appendix at the bottom of `commit-strategy/modular.md` — it is derive-time reference for the `{{MODULAR_*}}` placeholders, not shippable content.
2. **Substitute `{{PLACEHOLDER}}`** using the table below (+ the commit-strategy table).
3. **Write** the fully-expanded, fully-substituted body to `ai-tools/skills/<name>/SKILL.md`. No `<!-- include -->` marker and no `{{...}}` may survive in the shipped file.

**The `WORKROOT` seam.** The conductor resolves `WORKROOT` / `BASE_BRANCH` / `SANDBOX_TIER` once (`partials/worktree-seam.md#WORKROOT_RESOLUTION`) and every sub-skill uses them as data — this is why the rendered skills carry no scattered `if use_worktree` branches. `<WORKROOT>` / `<BASE_BRANCH>` / `<main_checkout>` / `<RESOLVED>` are **angle-bracket runtime slots the agent fills at execution time**, not `{{...}}` derive-time placeholders — leave them verbatim in the shipped file.

**`ask` → two `integrate-phase` variants, no dual-render.** When `policies.commit_strategy = ask`, render `integrate-phase-template.md` **twice**:
- `ai-tools/skills/integrate-phase-stacked/SKILL.md` — `<RESOLVED>` = `stacked`, `{{INTEGRATE_PHASE_NAME}}` = `integrate-phase-stacked`.
- `ai-tools/skills/integrate-phase-modular/SKILL.md` — `<RESOLVED>` = `modular`, `{{INTEGRATE_PHASE_NAME}}` = `integrate-phase-modular`.

The conductor's `{{INTEGRATE_PHASE_DISPATCH}}` then renders as a one-line runtime dispatch on `run_options.commit_strategy_resolved` (see the commit-strategy table). For `stacked` / `modular` projects, `integrate-phase-template.md` renders **once** to `ai-tools/skills/integrate-phase/` with a single topology body and no runtime branch.

The remaining per-shell placeholders:

| Placeholder | Source | Example |
|---|---|---|
| `{{PROJECT_NAME}}` | inventory.repo.name | `ACME Sleep` |
| `{{STACK_SUMMARY}}` | inventory.frameworks one-liner | `pnpm + Turbo + Vite + React + Medplum + Playwright` |
| `{{PLAN_DIR}}` | derived from where `*_IMPLEMENTATION_PLAN.md` lives | `ai-plans` or `apps/<service>/ai-plans` |
| `{{LINT_CMD}}` | inventory.commands.lint | `pnpm lint:fix` or `pre-commit run --files <changed>` or `ruff check` |
| `{{FORMAT_CMD}}` | inventory.commands.format | `pnpm format` or `ruff format` |
| `{{BUILD_CMD}}` | inventory.commands.build | `pnpm build` or `make all-tests` (when build is the type gate) |
| `{{TYPECHECK_NOTE}}` | derived | empty, or ` plus full mypy via 'mypy app/'` |
| `{{TEST_CMD}}` | inventory.commands.test_unit | `pnpm test`, `make all-tests`, `pytest` |
| `{{SCOPED_TEST_NOTE}}` | derived | empty, or `; per-app via 'pnpm test:patient' / 'pnpm test:provider'` |
| `{{NEW_TEST_CMD_PATTERN}}` | derived | `pnpm --filter <pkg> test -- <new-test-path>` or `pytest path/to/new_test.py -x` |
| `{{SCOPED_TEST_PATTERN}}` | derived | `pnpm test:patient`, `pytest tests/{unit,integration}/{app}/` |
| `{{E2E_BLOCK}}` | populated only if e2e selected — see C below | block describing e2e command + screenshot copy |
| `{{E2E_OUTER_GATE_LINE}}` | depends on e2e selected | The outer-gate e2e step, **wrapped in a `run_options.run_e2e` runtime gate** so e2e is opt-in per run. Render as `   c. **E2E** (opt-in): {If \`run_options.run_e2e = true\`:} when this phase has an e2e spec, run the project's e2e suite for the touched app + copy screenshots into \`pr-screenshots/\`. {Else:} skip e2e this run (default — e2e makes the phase take a lot longer).` Empty when e2e not selected. |
| `{{E2E_LAYER1_NOTE}}`, `{{E2E_LAYER2_CHECK}}`, `{{E2E_REPORT_FIELD}}` | depends on e2e selected | Verification/report hooks for e2e, each **guarded by `{If run_options.run_e2e = true:}`** so they only apply when the run opted into e2e. `E2E_LAYER1_NOTE`: ` + the e2e suite when \`run_options.run_e2e = true\``. `E2E_LAYER2_CHECK`: a Layer-2 walkthrough item that checks the phase's named e2e spec exists + screenshots landed **only when `run_options.run_e2e = true`** (else it's a no-op). `E2E_REPORT_FIELD`: `- E2E: specs run + screenshot paths, or "skipped (run_options.run_e2e = false)".` Empty when e2e not selected. |
| `{{E2E_OUTER_GATE_CHECKLIST}}`, `{{UI_E2E_RULE_LINE}}` | depends on e2e selected | populated or empty. `E2E_OUTER_GATE_CHECKLIST`: a trailing checklist clause ` + the e2e suite when \`run_options.run_e2e = true\`` (leading ` + `) so the gate checklist only demands e2e on opted-in runs. `UI_E2E_RULE_LINE`: an important-rules bullet stating e2e is opt-in via `run_options.run_e2e` (default off, makes runs a lot slower) and only runs for phases carrying an e2e spec. |
| `{{E2E_RUN_OPTION_QUESTION}}` | depends on e2e selected | The Step 0 opt-in question **(e)** for `implement-plan`, e2e projects only (empty otherwise). Render as ``\n\n   e. **Run E2E tests this run?** *"Some phases carry Playwright e2e specs. Running them each phase makes the implementation take a LOT longer (browser boot, seeded data, screenshot capture). Run them this time, or skip and rely on unit + integration coverage?"* Options: `Skip e2e (default) — faster`, `Run e2e — slower but exercises the browser flows`. Default = `Skip`. Records `run_options.run_e2e` (`true` only for the `Run e2e` answer).`` (starts with `\n\n`; vanishes cleanly for no-e2e projects) |
| `{{E2E_RUN_OPTION_CONFIRM}}` | depends on e2e selected | e2e projects: `` + `run_options.run_e2e` `` (leading ` + `). Empty otherwise. |
| `{{E2E_RUN_OPTION_TRAILER}}` | depends on e2e selected | e2e projects: ` E2E execution follows `run_options.run_e2e` (opt-in; off by default).` (leading space). Empty otherwise. |
| `{{E2E_RUN_OPTION_TRACKING}}` | depends on e2e selected | e2e projects: `` , `run_e2e` `` (leading `, `) — appends `run_e2e` to a run-options list (the tracking schema line + the implement-phase / review-phase pass-through lists). Empty otherwise. |
| `{{E2E_RUN_OPTION_RULE}}` | depends on e2e selected | e2e projects: ` `run_options.run_e2e` controls whether the e2e suites run in the outer gate + review layers ([Implement](#1a-implement) + [Review](#1b-review)) — off by default because e2e makes each phase a lot slower; on only when the user opts in at Step 0.` (leading space). Empty otherwise. |
| `{{STACK_SPECIFIC_DEPLOY_BLOCK}}` | from matched stacks | `- Bots: \`pnpm bots:build\`, \`pnpm bots:deploy --env=dev-<handle>\`...` for Medplum, or empty |
| `{{CODE_HOST}}` | Step 0 interview | `GitHub`, `GitLab`, `Bitbucket` |
| `{{DEFAULT_BRANCH}}` | inventory.repo.default_branch | `main` or `master` |
| `{{PR_*}}` family (`{{PR_POLICY_DESCRIPTION}}`, `{{PR_POLICY_BLOCK}}`, `{{PR_REMINDER_LINE}}`, `{{BRANCH_PUSH_HEADING}}`, `{{PR_LINK_NOTE}}`, `{{FINAL_REPORT_PR_NOTE}}`, `{{PR_RULE_TAIL}}`, `{{PR_CHECKLIST_NOTE}}`, `{{FINAL_CHECKLIST_PR_NOTE}}`, `{{PUSH_INSTRUCTION_LINE}}`) | Step 0 (PR creation policy) | Describes whether agents create PRs vs only push branches. **Note:** PR creation itself goes through the rendered skill's **Open PR via context file** step (`prs-context` file + bundled `open-pr.sh`), not raw `gh pr create` lines. These placeholders cover the framing (description, push instructions, checklist + summary phrasing) — the **Open PR via context file** matrix consumes the policy directly. |
| `{{COAUTHOR_*}}` family (`{{COAUTHOR_POLICY_BLOCK}}`, `{{COAUTHOR_INSTRUCTION_LINE}}`, `{{COAUTHOR_LAYER1_CHECK}}`, `{{COAUTHOR_RULE_LINE}}`, `{{COAUTHOR_CHECKLIST_NOTE}}`) | Step 0 (AI co-author policy) | If "forbidden": "Do NOT add `Co-Authored-By: Claude` ..." everywhere. If "allowed": empty / softer language. |
| `{{COMMIT_STYLE_LINE}}` | Step 0 (commit style) + repo log | `Default subject: short imperative, ≤72 chars` or `Conventional Commits format: type(scope): subject` |
| `{{ANTI_GIT_ADD_ALL_REASON}}` | derived from common artifacts in target | `secrets, .env files, build artifacts, .auth/ live in the tree` |
| `{{STAGE_PATTERN}}` | derived from monorepo shape | `apps/... lib/... e2e/... ai-plans/...` or `<app>/... tests/... ai-plans/...` |
| `{{PROJECT_SKILLS_LIST}}` | computed from skills emitted | comma-separated names of the skills the project actually has |
| `{{AGENT_DISPATCH_TABLE}}` | from [vinta-derive-subagents](../vinta-derive-subagents/SKILL.md) output | markdown table mapping phase shapes → agent type. Rendered into `implement-phase`. |
| `{{INTEGRATE_PHASE_NAME}}` | derived from `policies.commit_strategy` | The integrate-phase skill's own `name:` + dir. `integrate-phase` for `stacked` / `modular`; `integrate-phase-stacked` / `integrate-phase-modular` for the two `ask` renders. |
| `{{INTEGRATE_PHASE_DISPATCH}}` | derived from `policies.commit_strategy` | How the `implement-plan` conductor names the integrate step. `stacked` / `modular`: `` [integrate-phase](../integrate-phase/SKILL.md) ``. `ask`: `` the resolved integrate-phase variant — [integrate-phase-stacked](../integrate-phase-stacked/SKILL.md) when `run_options.commit_strategy_resolved = stacked-branches`, else [integrate-phase-modular](../integrate-phase-modular/SKILL.md) ``. |
| `{{INTEGRATE_PHASE_LINK}}` | derived from `policies.commit_strategy` | Path used by `amend-plan`'s PR-template cross-reference. `../integrate-phase/SKILL.md` for `stacked` / `modular`; `../integrate-phase-stacked/SKILL.md` for `ask` (amend-plan only runs under the stacked topology). |
| `{{OBSERVABILITY_MCP_BLOCK}}` | rendered from [resources/systematic-debugging-mcp-tools.md](resources/systematic-debugging-mcp-tools.md) | the verbatim "Phase 0 evidence categories" block — same content for every project. When `skills.systematic-debugging.observability_mcp_servers` is empty, renders the no-tools fallback paragraph instead. The block is MCP-agnostic on purpose: tool names are discovered at runtime, not baked at generation time. |
| `{{OBSERVABILITY_MCP_LIST}}` | derived from `skills.systematic-debugging.observability_mcp_servers` | comma-separated MCP server identifiers as the user named them at bootstrap (e.g. `sentry, datadog, our-internal-traces`). Renders `none configured` when empty. |
| `{{API_STYLE}}` | `skills.handoff-to-client.api_style` (handoff-to-client only) | `REST`, `GraphQL`, `gRPC`, `REST + webhooks` |
| `{{CLIENT_PLATFORMS_LIST}}` | `skills.handoff-to-client.client_platforms` (handoff-to-client only) | comma-separated, e.g. `iOS (Swift), Android (Kotlin), web SPA (React)` |
| `{{CLIENT_HANDOFF_DIR}}` | `skills.handoff-to-client.output_dir` (handoff-to-client only) | `.vinta-ai-workflows/client-handoffs` (default) |
| `{{API_SPEC_BLOCK}}` | derived from `skills.handoff-to-client.api_spec_path` (handoff-to-client only) | when set: a paragraph instructing the agent to regenerate/read the spec at that path on both base and branch and diff the two as the primary change-enumeration source (cross-checking against the code diff). When absent: a one-line note that no machine-readable spec exists, so shapes come from route/serializer code alone. |
| `{{DEPENDENCY_LICENSE_BLOCK}}` | derived from `policies.dependency_licenses` | Top-level `## Adding new third-party dependencies` section. Empty string when `enforcement: off` or the block is absent. When `block` / `warn`: short paragraph naming the enforcement mode + the forbidden SPDX list + the pre-install check (`npm view <pkg> license`, PyPI metadata, etc.) + a one-line pointer to the **Dependency licenses** section in [AGENTS.md](AGENTS.md) for the full table including `allowed_overrides` and `notes`. See [resources/dependency-license-block.md](resources/dependency-license-block.md) for the canonical body. |
| `{{DEPENDENCY_LICENSE_LAYER1_CHECK}}` | derived from `policies.dependency_licenses` | Layer 1 review checklist item. Empty string when `enforcement: off`. When `block` / `warn`: `6. **Dependency license scan**: \`git diff package.json pyproject.toml ...\` (project-relevant manifests) — for every added dep look up its SPDX license (\`npm view <pkg> license\`, PyPI metadata, repo \`LICENSE\`). A license in \`policies.dependency_licenses.forbidden_spdx\` and not in \`allowed_overrides\` is a BLOCKER (when \`block\`) or a SHOULD-FIX (when \`warn\`). A missing / \`UNKNOWN\` / undeclared license is **always a BLOCKER** regardless of enforcement mode — there is no override to silently bless undisclosed terms.` |
| `{{DEPENDENCY_LICENSE_RULE_LINE}}` | derived from `policies.dependency_licenses` | Important-rules bullet. Empty string when `enforcement: off`. When `block`: `- **License check before any new dep.** Refuse \`npm add\` / \`pnpm add\` / \`pip install\` / \`poetry add\` / \`uv add\` / \`cargo add\` / \`go get\` when the package's SPDX license is in the forbidden list — see AGENTS.md **Dependency licenses**. User can grant a one-off override after acknowledging the violation; record the override in \`policies.dependency_licenses.allowed_overrides\` before re-running.` When `warn`: same line but `Proceed but record the violation in the phase report` instead of `Refuse`. |
| `{{COMMIT_STRATEGY_*}}` family (`{{COMMIT_STRATEGY_STEP0_QUESTION}}`, `{{COMMIT_STRATEGY_STEP0_TRAILER}}`, `{{COMMIT_STRATEGY_CONFIRM_NOTE}}`, `{{BRANCH_NAMING_PATTERN_SUMMARY}}`, `{{BRANCH_NAMING_BLOCK}}`, `{{PER_PHASE_COMMIT_BLOCK}}`, `{{PR_OPEN_TIMING_BLOCK}}`, `{{PRS_CONTEXT_FILE_PATH}}`, `{{TRACKING_BRANCH_FIELD}}`, `{{TRACKING_PHASE_BRANCH_FIELD}}`, `{{FINAL_REPORT_BRANCH_SUMMARY}}`, `{{BRANCH_CHECKLIST_LINE}}`, `{{COMMIT_STRATEGY_CHECKLIST_BLOCK}}`, `{{BRANCH_PUSH_HEADING}}`) | Step 0 (`policies.commit_strategy`) | Render based on the project's commit strategy (`stacked-branches` / `modular-commits` / `ask`). Multi-line blocks now come from the commit-strategy partials; see the substitution table immediately after this row. |

### `{{COMMIT_STRATEGY_*}}` substitution table

The multi-line blocks now live in the partials `plan-execution/partials/commit-strategy/{stacked,modular}.md` (marker-delimited blocks). The single-line values are documented in each partial's footer comment. Bind the block/value from the partial matching `policies.commit_strategy`. The `{{MODULAR_EXAMPLE_*}}` + `{{MODULAR_COMMIT_MESSAGE_FORMAT_BLOCK}}` placeholders inside `modular.md`'s `PER_PHASE_COMMIT` block are resolved from that partial's own **rendering-guidance appendix** (driven by `policies.commit_style` — conventional / imperative / other); that appendix is derive-time reference only and is never shipped.

**Where each block lands, and how `ask` is handled:**
- `BRANCH_NAMING` + `PR_OPEN_TIMING` land in **`integrate-phase`**. Under `ask`, `integrate-phase` is rendered **twice** (once per strategy — see [Rendering the plan-execution unit](#rendering-the-plan-execution-unit)); each variant bakes in one strategy's blocks with **no runtime marker**. The conductor dispatches by name via `{{INTEGRATE_PHASE_DISPATCH}}`.
- `PER_PHASE_COMMIT` lands in **`implement-phase`** (the implementer prompt's working instructions). `implement-phase` is not split, so under `ask` it embeds **both** strategy blocks gated by inline runtime markers (`If \`run_options.commit_strategy_resolved = "modular-commits"\`: … Else (\`stacked-branches\`): …`) — same pattern as `pause_between_phases` / `generate_inline_comments`.
- `CHECKLIST` + all single-line values land in the single **`implement-plan`** conductor; under `ask` they render dynamically on `run_options.commit_strategy_resolved` (runtime markers for the block, inline `If … Else …` for single-line values).

| Placeholder | Lands in | `stacked-branches` | `modular-commits` | `ask` |
|---|---|---|---|---|
| `{{COMMIT_STRATEGY_STEP0_QUESTION}}` | implement-plan | empty string | empty string | a third opt-in block analogous to 4a/4b: `\n\n   c. **Commit strategy?** *"This project's commit_strategy is set to ask. Pick one for this run: one branch + one PR per phase (stacked), or one branch + one PR for the whole plan with one atomic commit per logical unit (modular)?"* Options: \`Stacked branches — one branch + PR per phase\`, \`Modular commits — atomic commits, one PR for whole plan\`. Cache answer in tracking under \`run_options.commit_strategy_resolved\`.` (starts with `\n\n`; under stacked / modular the placeholder vanishes without a stray blank line) |
| `{{COMMIT_STRATEGY_STEP0_TRAILER}}` | implement-plan | empty string | empty string | ` Commit-strategy behavior follows \`run_options.commit_strategy_resolved\`.` (leading space) |
| `{{COMMIT_STRATEGY_CONFIRM_NOTE}}` | implement-plan | empty string | empty string | ` + \`run_options.commit_strategy_resolved\`` (leading ` + `) |
| `{{BRANCH_NAMING_PATTERN_SUMMARY}}` | implement-plan | `stacked.md` footer value | `modular.md` footer value | ``branch naming pattern (depends on `run_options.commit_strategy_resolved` — resolved at Step 0)`` |
| `{{BRANCH_NAMING_BLOCK}}` | integrate-phase | `stacked.md#BRANCH_NAMING` | `modular.md#BRANCH_NAMING` | baked per-variant (no runtime marker) |
| `{{PER_PHASE_COMMIT_BLOCK}}` | implement-phase | `stacked.md#PER_PHASE_COMMIT` | `modular.md#PER_PHASE_COMMIT` | both blocks gated by runtime markers |
| `{{PR_OPEN_TIMING_BLOCK}}` | integrate-phase | `stacked.md#PR_OPEN_TIMING` | `modular.md#PR_OPEN_TIMING` | baked per-variant (no runtime marker) |
| `{{PRS_CONTEXT_FILE_PATH}}` | implement-plan + integrate-phase | `stacked.md` footer value | `modular.md` footer value | ``either `.../phase-{phase.id}.md` or `.../plan.md` depending on `run_options.commit_strategy_resolved` `` |
| `{{TRACKING_BRANCH_FIELD}}` | implement-plan | `stacked.md` footer value (empty) | `modular.md` footer value | both gated by runtime markers |
| `{{TRACKING_PHASE_BRANCH_FIELD}}` | implement-plan | `stacked.md` footer value (`, branch, base`) | `modular.md` footer value (empty) | both gated by runtime markers |
| `{{FINAL_REPORT_BRANCH_SUMMARY}}` | implement-plan | `stacked.md` footer value | `modular.md` footer value | dynamic per resolved strategy |
| `{{BRANCH_CHECKLIST_LINE}}` | implement-plan | `stacked.md` footer value | `modular.md` footer value | dynamic per resolved strategy |
| `{{COMMIT_STRATEGY_CHECKLIST_BLOCK}}` | implement-plan | `stacked.md#CHECKLIST` (empty) | `modular.md#CHECKLIST` (3 items) | both variants gated by runtime markers |
| `{{BRANCH_PUSH_HEADING}}` | integrate-phase | `Push stacked branch` | `Push to plan branch` | baked per-variant (`Push stacked branch` / `Push to plan branch`) |

### `{{COMMIT_STRATEGY_REFUSAL_BLOCK}}` (amend-plan only)

`amend-plan-template.md` carries one additional placeholder not used by `implement-plan-template.md`. It renders the "this skill doesn't support this strategy yet" refusal block immediately after the description in the rendered SKILL.md.

| `commit_strategy` | Substitution |
|---|---|
| `stacked-branches` | empty string (current behavior — full amend flow runs) |
| `modular-commits` | a refusal section — see the [refusal-block body](#commit_strategy_refusal_block-body) below |
| `ask` | the same refusal section, but its preamble reads tracking's `run_options.commit_strategy_resolved` first and only refuses when that value resolves to `modular-commits`; when it resolves to `stacked-branches` the section renders an empty string (full amend flow runs) |

#### `{{COMMIT_STRATEGY_REFUSAL_BLOCK}}` body

```markdown

## Unsupported commit strategy

**This skill does not yet support `commit_strategy = modular-commits`.** Detected from `.vinta-ai-workflows.yaml` `policies.commit_strategy` (or `TRACKING_{plan-id}.md` `run_options.commit_strategy_resolved` when the project policy is `ask` and a run is already in flight).

Amending under modular commits requires rewriting an arbitrary number of inline atomic commits across a shared `plan/{plan-id-kebab}` branch. The git topology is fundamentally different from the per-phase stacked branches this skill is designed around — the rewrite plan, force-push targets, and downstream rebase fan-out all differ. Full support is tracked as a follow-up.

**Resolve the amendment one of three ways:**

1. **Append a new phase** — extend the plan with the change as a new `Phase N+1`, then run [implement-plan](../implement-plan/SKILL.md). Cleanest path; preserves the existing commit log.
2. **Hand-craft the amendment** — `git rebase -i plan/{plan-id-kebab}` (or `git commit --fixup` + `git rebase --autosquash`) on the plan branch, force-push, and re-run review manually. Skip this skill entirely.
3. **Re-run the plan from scratch on a new branch** — abandon the in-flight commits (leave them for audit), regenerate the plan with [plan-feature](../plan-feature/SKILL.md), implement forward.

Refuse with this guidance; do not proceed.
```

The commit-strategy block bodies (branch naming, per-phase commit, PR-open timing, checklist) for both strategies live in [resources/plan-execution/partials/commit-strategy/](resources/plan-execution/partials/commit-strategy/) — `stacked.md` + `modular.md`. derive-skills reads the one matching `policies.commit_strategy` (both, under `ask`).

Render each template (expand includes → substitute placeholders → write), producing:

- `ai-tools/skills/implement-plan/SKILL.md` (from `plan-execution/shell/implement-plan-template.md`)
- `ai-tools/skills/implement-phase/SKILL.md` (from `plan-execution/shell/implement-phase-template.md`)
- `ai-tools/skills/review-phase/SKILL.md` (from `plan-execution/shell/review-phase-template.md`)
- `ai-tools/skills/integrate-phase/SKILL.md` (from `plan-execution/shell/integrate-phase-template.md`) — **or**, under `ask`, `ai-tools/skills/integrate-phase-stacked/SKILL.md` + `ai-tools/skills/integrate-phase-modular/SKILL.md` (same template rendered twice)
- `ai-tools/skills/amend-plan/SKILL.md` (from `plan-execution/shell/amend-plan-template.md`)
- `ai-tools/skills/systematic-debugging/SKILL.md` (from `systematic-debugging-template.md`) — only when `foundation_skills.systematic-debugging: enabled`
- `ai-tools/skills/handoff-to-client/SKILL.md` (from `handoff-to-client-template.md`) — only when `foundation_skills.handoff-to-client: enabled`

The first five are the **plan-execution unit** — render them together (they share partials + placeholders + cross-links); a change to one partial ripples to every shell that includes it.

Validate each output before saving: **no `<!-- include: … -->` marker and no `{{PLACEHOLDER}}` may survive** (angle-bracket runtime slots like `<WORKROOT>` / `<BASE_BRANCH>` / `<RESOLVED-already-bound>` are expected to remain — they are execution-time, not derive-time). If a placeholder survives, the shell/partial needs a substitution rule. Cross-link check: the conductor's links to `implement-phase` / `review-phase` / the integrate variant resolve, and `amend-plan` / `systematic-debugging` → `review-phase` resolve. `systematic-debugging` adds the two MCP-related placeholders; if a project picks an observability tool the catalogue doesn't list, ask the user for a free-form snippet (heading, required calls, fields to extract) and inline it before saving — and consider upstreaming the snippet to [resources/systematic-debugging-mcp-tools.md](resources/systematic-debugging-mcp-tools.md).

### C. Optional — ask the user

Two skills depend on whether the project actually does the thing. Ask via `AskUserQuestion`:

| Skill | Question | If yes |
|---|---|---|
| `add-e2e-test` | "Does this project have e2e tests, or plan to add them?" Options: `Yes — already has them`, `Yes — planning to add`, `No — skip` | Ask if user has an existing template (path / URL). If yes → copy + adapt. If no → draft from scratch using the canonical structure (see "Skill SKILL.md structure" below) interviewing user about: e2e framework, page-object pattern, auth/storage-state pattern, seed-helpers location, tenant scoping in seeds, screenshot conventions for PRs. |
| `add-env-var` | "Does this project have a non-trivial env-var propagation flow (multiple files / build configs / CI to update for one new var)?" Options: `Yes`, `No — single .env file is enough` | Ask if user has an existing template. If yes → copy + adapt. If no → draft from scratch interviewing user about every layer the new var must touch (`.env.example`, build tool envPrefix allowlist, build cache hash inputs, app config module, AGENTS.md env section, CI workflows, deploy-time injection). |
| `add-one-off-script` | "Does this project ever need one-off operational scripts — backfills, cleanups, ad-hoc data fixes?" Options: `Yes — enable`, `No — skip`. Recommend `Yes` for any project with a relational DB; the skill bundles a `BaseOneOffScript` class enforcing dry-run-by-default, idempotent re-runs, batched DB ops, streamed reads, segmented CSV backups (1M cells/file, never nested across tables), interruption-safe signal handlers, and console + filesystem + S3 logging. | Copy [resources/foundation-skills/add-one-off-script/](resources/foundation-skills/add-one-off-script/) into `ai-tools/skills/add-one-off-script/` (SKILL.md + the bundled `resources/one_off_script_base.{py,ts}` templates). Then ask the user whether they want the base class file pre-staged at `<scripts_dir>/one_off/_base.{py,ts}` — default `Yes` for projects whose primary lang is Python or TS. The skill itself prompts to copy the base class on first use if the user said `No` here. |
| `prepare-worktree` | "Do you ever want to run plans / experiments inside an isolated git worktree (separate runnable copy of the app with its own DB, env, compose stack) instead of swapping branches in the main checkout?" Options: `Yes — enable`, `No — skip`. Recommend `Yes` for projects with long migrations, multi-day plans, or where the user is likely to want parallel concurrent work. | Copy the whole [resources/foundation-skills/prepare-worktree/](resources/foundation-skills/prepare-worktree/) dir into `ai-tools/skills/prepare-worktree/` — both `SKILL.md` and `scripts/sandbox-run.sh` (mark the script executable: `chmod +x ai-tools/skills/prepare-worktree/scripts/sandbox-run.sh`). Then ask three short follow-ups landing in `skills.prepare-worktree.*`: worktree root (default `.claude/worktrees` for claude-code projects, `../<repo>-wt-` sibling dirs otherwise), default deps strategy (`symlink` / `copy` / `reinstall`), default test-DB strategy (`always-fork` / `fork-on-schema-change` / `share`). Also ask whether `implement-plan` should default its Step 0 question (c) to `yes` — lands in `run_options.implement-plan.use_worktree`. |

If user answers "No" to any: don't ship that skill. Record nothing — the foundation set is just smaller.

If user answers "Yes" but has no template: draft from scratch via interview. The orchestrator can defer this to a separate `vinta-derive-skills` standalone run if the user wants to ship the rest first.

## Stack-specific skills (user-supplied)

[bootstrap-ai-tools/resources/stacks/<stack>/notes.md](../vinta-bootstrap-ai-tools/resources/stacks/) describes **detection signals + skill categories typically needed** for each stack — NOT ready-made content. The team's specific skill library lives wherever they keep it.

For each stack the inventory matched, surface to the user:

> Detected stack `<X>`. The notes for this stack list these skill categories: A, B, C. Do you have existing skill templates for any of these?

`AskUserQuestion`-style prompts:
- *"Do you have a skill template for `<category>`?"* → `Yes — at this path/URL`, `No — record as gap`, `Skip this category for now`.

When the user provides a path:
1. Read the source SKILL.md (or YAML — both formats supported).
2. Replace placeholder paths / dep names / command names with the target's specifics, using the placeholder list from [resources/stacks/<stack>/notes.md](../vinta-bootstrap-ai-tools/resources/stacks/).
3. Drop sections that don't apply.
4. Save to `ai-tools/skills/<name>/SKILL.md`.

When the user has no template: record the category as a gap. Output as part of the orchestrator's final summary.

## Skill SKILL.md structure (for any skill drafted from scratch)

```markdown
---
name: <kebab-case>          # required, matches dir name
description: <text>         # required, dense one-liner of what + when
---

# {Skill name}

Short framing: what this is, why it exists.

## Decision questions (when applicable)
The questions to answer before doing the thing.

## Checklist
Step-by-step, numbered. Each step names files + commands.

## Pitfalls
The "we got burned by this" list.

## Verification
How to confirm the work is done correctly.
```

Length: 100–300 lines. Shorter = under-specified. Longer = should probably split.

## Naming

- Lowercase, kebab-case.
- Verb-led for skills that DO something: `add-bot`, `create-spec`, `manage-access-policy`, `plan-feature`.
- Match the dir name to the `name` field exactly (Cursor + VS Code Copilot constraint).

## Rules

- **Don't ship copy-pasted source-project SKILL.md files unchanged.** Run search-and-replace for source project names / paths / commands before saving.
- **Foundation set is a unit.** Always copy `plan-feature` + `create-spec` + `open-pr-from-context` together — they reference each other. `create-qa-use-cases` joins only when `add-e2e-test` is enabled; when it's not, strip `plan-feature`'s e2e regions (the `<!-- e2e:start/end -->` pass) so no cross-link dangles.
- **The plan-execution unit is generated, not copied.** `implement-plan` + `implement-phase` + `review-phase` + `integrate-phase` + `amend-plan` all have too much project-specific content for verbatim shipping. They are separate files but a **co-shipped unit** — never emit the conductors without the three sub-skills; a conductor whose `[implement-phase]` / `[review-phase]` / integrate link dangles is a broken skill.
- **Optional skills (`add-e2e-test`, `add-env-var`, `add-one-off-script`, `prepare-worktree`, `thermo-nuclear-code-quality-review`, `handoff-to-client`) are gated by user answer.** Don't ship them by default. `handoff-to-client` is additionally template-rendered (bucket B) — its config lives under `skills.handoff-to-client.*`.
- **Each skill solves one job.** Two unrelated checklists → split.
- **Reference real files in the target.** Skill links must point to existing paths.
- **Skills auto-load by description.** Specific triggers, specific outcomes.
- **Never use `§N` shorthand to point at sections in any drafted SKILL.md body, agent prompt, or rendered template.** Use the section's full name (and a markdown anchor link when the link target is reachable). `§N` shorthand makes cross-references hard for humans to follow and breaks when section numbering shifts. This rule applies to both the foundation skills shipped verbatim and the template-rendered ones.

## Pitfalls

- **Forgetting to substitute placeholders (or expand includes) in the plan-execution skills.** A surviving `{{TEST_CMD}}` or `<!-- include: … -->` is a runtime confusion. Expand every include, substitute every `{{…}}`, and validate before saving. (Angle-bracket runtime slots like `<WORKROOT>` are meant to stay.)
- **Copying foundation skills and forgetting to scrub source-project paths.** Bundled copies may still carry source-repo paths (e.g. `<source-repo>/ai-plans/`, `apps/<service>/`). Replace with the target's paths.
- **Asking too many questions for optional skills.** If `vinta-analyze-codebase` shows no e2e dir and the user clearly has no e2e setup, it's OK to skip the question and not ship `add-e2e-test`. Use judgment.
- **Skipping the foundation copy because "the user already has them".** They probably don't. Confirm by reading the target's `ai-tools/skills/` (if it exists at all). If it does have these, ask the user "refresh from bundled copies, or keep what you have?".

## Verification

After all skills written:

1. Each `ai-tools/skills/<name>/SKILL.md` has frontmatter `name` + `description`, plus markdown body.
2. `name` field matches dir name.
3. No `{{PLACEHOLDER}}` strings survive in any output skill.
4. Foundation skills (plan-feature, create-spec, open-pr-from-context — plus create-qa-use-cases when e2e is enabled) reference each other correctly via `[name](../<name>/SKILL.md)` links. When e2e is disabled, confirm `plan-feature` has **no** surviving `<!-- e2e:start/end -->` markers and no dangling link to `create-qa-use-cases` / `add-e2e-test`.
5. **Plan-execution unit intact.** All five files exist; no surviving `<!-- include -->` markers; the conductor's `[implement-phase]` / `[review-phase]` / integrate-phase links resolve, and `amend-plan` + `systematic-debugging` (when shipped) → `[review-phase]` resolve. Under `ask`: both `integrate-phase-stacked` + `integrate-phase-modular` exist and the conductor's dispatch line names both.
6. `implement-plan` (+ the plan-execution sub-skills) cite real commands + the project's actual code host + branch / PR / co-author policy.
7. Setup script ([vinta-install-ai-tools-setup](../vinta-install-ai-tools-setup/SKILL.md)) runs cleanly with the new skills in place.
