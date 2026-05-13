---
name: vinta-derive-skills
description: Author project-specific skills under `ai-tools/skills/`. Always copies the project-agnostic foundation set (`plan-feature`, `create-spec`, `create-qa-use-cases`) verbatim from this skill's bundled resources. Generates `implement-plan` from a parameterized template using project-specific commands + branch / commit / PR conventions captured in the bootstrap interview. Asks the user whether `add-e2e-test` and `add-env-var` are needed (optional foundation skills — only ship if applicable). Stack-specific skills (Medplum, Django, etc) come from user-supplied templates pointed at by the orchestrator — see [bootstrap-ai-tools/resources/stacks/<stack>/notes.md](../vinta-bootstrap-ai-tools/resources/stacks/) for the categories per stack.
---

# Derive skills

Author the project's `ai-tools/skills/<name>/SKILL.md` files. Skills are reusable instruction sets the agent invokes when a task matches their description.

## Output

`ai-tools/skills/<name>/SKILL.md` for each skill. Some skills bring resources (templates, scripts) — those go under `ai-tools/skills/<name>/resources/`.

## Inputs

1. Inventory from [vinta-analyze-codebase](../vinta-analyze-codebase/SKILL.md), specifically `existing_ai_artifacts.skills` — every skill file already in the repo with name, description, classification (`vinta-managed` / `foundation-shape` / `project-custom`).
2. AGENTS.md from [vinta-write-agents-md](../vinta-write-agents-md/SKILL.md).
3. Step 0 interview answers from [vinta-bootstrap-ai-tools](../vinta-bootstrap-ai-tools/SKILL.md), including the §E **per-skill disposition** (migrate / keep / drop / replace).
4. Stack matches from the inventory; for each, the skill categories listed in [bootstrap-ai-tools/resources/stacks/<stack>/notes.md](../vinta-bootstrap-ai-tools/resources/stacks/).
5. User-supplied stack templates for matched stacks (path / URL / package — asked at runtime).

## Reconcile against existing skills (do this FIRST)

Before drafting any new SKILL.md, walk through every entry in `existing_ai_artifacts.skills` and apply the disposition the user picked in Step 0 §E:

- **Migrate to `ai-tools/skills/<name>/`** — `git mv` the existing skill folder (with all its resources) into the canonical layout. After move, scan the body for hard-coded vendor paths that no longer apply (`.cursor/skills/...` self-references, etc.) and rewrite to the new path. `setup-ai-tools.mjs` will re-link to the chosen vendors.
- **Keep in current vendor path, don't touch** — leave it where it is; AGENTS.md may reference it; downstream skill setup won't manage it. **Don't ship a foundation duplicate that would shadow it.**
- **Drop** — log removal; don't emit anything.
- **Replace with Vinta foundation version** (foundation-shape only — `plan-feature`, `create-spec`, `create-qa-use-cases`, `implement-plan`, `add-e2e-test`, `add-env-var`, `add-one-off-script`) — proceed with the bucket A / B / C flow below for that name. The user has explicitly opted into overwriting their version.
- **`vinta-managed`** (any skill whose dir starts with `vinta-`) — leave alone. These come from the `@vinta/ai-workflows` CLI; `vinta-derive-skills` doesn't manage them.

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
| `create-qa-use-cases` | [resources/foundation-skills/create-qa-use-cases/SKILL.md](resources/foundation-skills/create-qa-use-cases/SKILL.md) | Bootstrap a project's `QA_USE_CASES.md` from the active spec/plan. |
| `open-pr-from-context` | [resources/foundation-skills/open-pr-from-context/](resources/foundation-skills/open-pr-from-context/) | Thin SKILL.md wrapper around [scripts/open-pr.sh](resources/foundation-skills/open-pr-from-context/scripts/open-pr.sh) — bash script that publishes one `.vinta-ai-workflows/prs-context/{feature}/{phase}.md` file as a real PR + inline comments via the project's PR CLI (`gh` / `glab`). Used by `implement-plan` (when CLI + `yq`/`jq` are available) and standalone (to publish a `pending` file later). |

These four reference each other:

- `plan-feature` reads spec; dispatches `create-qa-use-cases` when the doc is missing.
- `implement-plan` (bucket B below) writes per-phase PR-context files following [resources/prs-context-template.md](resources/prs-context-template.md), then invokes `open-pr-from-context` when a PR CLI is detected.

Copy all four or none — they form a unit.

After copying, scan each for project-specific path references that no longer match the target (the bundled copies may still carry source-repo paths such as `<source-repo>/ai-plans/` or `apps/<service>/`). Replace with the target's paths from the inventory.

### B. Generate — `implement-plan`, `amend-plan`, `systematic-debugging` from templates

Project-specific skills, generated from templates because their bodies cite real test commands, branch conventions, agent dispatch table, PR / co-author policy, or selected MCP tools:

- **`implement-plan`** — forward execution: drives a fresh plan phase-by-phase. From [resources/implement-plan-template.md](resources/implement-plan-template.md).
- **`amend-plan`** — history rewriting: revises an in-flight plan, amends already-implemented phase commits, force-pushes, rebases stacked downstream branches. From [resources/amend-plan-template.md](resources/amend-plan-template.md). Companion to `implement-plan` — same agents, same review gates, same PR-context flow, opposite git topology direction.
- **`systematic-debugging`** — root-cause-first debugging flow with project-specific reproduction commands and enforced observability MCP evidence-gathering. From [resources/systematic-debugging-template.md](resources/systematic-debugging-template.md) plus the **MCP-agnostic** evidence-categories block at [resources/systematic-debugging-mcp-tools.md](resources/systematic-debugging-mcp-tools.md) — the rendered SKILL.md instructs the agent to list available MCP tools at runtime and map them to evidence categories (error tracking, traces, logs, metrics, alerts, deploys, dashboards), instead of hardcoding tool names that go stale. **Opt-in** — only generated when `foundation_skills.systematic-debugging` is `enabled` in `.vinta-ai-workflows.yaml`. The free-form list of MCP server identifiers rendered into the body comes from `skills.systematic-debugging.observability_mcp_servers` in the same config.

`implement-plan` and `amend-plan` consume the same placeholder set below — render each by substituting from the inventory + Step 0 interview answers. `systematic-debugging` reuses the same set plus two extra placeholders (`{{OBSERVABILITY_MCP_BLOCK}}`, `{{OBSERVABILITY_MCP_LIST}}`) rendered from the catalogue.

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
| `{{E2E_OUTER_GATE_LINE}}` | depends on e2e selected | `   c. **E2E:** ...` or empty |
| `{{E2E_LAYER1_NOTE}}`, `{{E2E_LAYER2_CHECK}}`, `{{E2E_REPORT_FIELD}}`, `{{E2E_OUTER_GATE_CHECKLIST}}`, `{{UI_E2E_RULE_LINE}}` | depends on e2e selected | populated or empty strings |
| `{{STACK_SPECIFIC_DEPLOY_BLOCK}}` | from matched stacks | `- Bots: \`pnpm bots:build\`, \`pnpm bots:deploy --env=dev-<handle>\`...` for Medplum, or empty |
| `{{CODE_HOST}}` | Step 0 interview | `GitHub`, `GitLab`, `Bitbucket` |
| `{{DEFAULT_BRANCH}}` | inventory.repo.default_branch | `main` or `master` |
| `{{PR_*}}` family (`{{PR_POLICY_DESCRIPTION}}`, `{{PR_POLICY_BLOCK}}`, `{{PR_REMINDER_LINE}}`, `{{BRANCH_PUSH_HEADING}}`, `{{PR_LINK_NOTE}}`, `{{FINAL_REPORT_PR_NOTE}}`, `{{PR_RULE_TAIL}}`, `{{PR_CHECKLIST_NOTE}}`, `{{FINAL_CHECKLIST_PR_NOTE}}`, `{{PUSH_INSTRUCTION_LINE}}`) | Step 0 (PR creation policy) | Describes whether agents create PRs vs only push branches. **Note:** PR creation itself goes through §1f (`prs-context` file + bundled `open-pr.sh`), not raw `gh pr create` lines. These placeholders cover the framing (description, push instructions, checklist + summary phrasing) — the §1f matrix consumes the policy directly. |
| `{{COAUTHOR_*}}` family (`{{COAUTHOR_POLICY_BLOCK}}`, `{{COAUTHOR_INSTRUCTION_LINE}}`, `{{COAUTHOR_LAYER1_CHECK}}`, `{{COAUTHOR_RULE_LINE}}`, `{{COAUTHOR_CHECKLIST_NOTE}}`) | Step 0 (AI co-author policy) | If "forbidden": "Do NOT add `Co-Authored-By: Claude` ..." everywhere. If "allowed": empty / softer language. |
| `{{COMMIT_STYLE_LINE}}` | Step 0 (commit style) + repo log | `Default subject: short imperative, ≤72 chars` or `Conventional Commits format: type(scope): subject` |
| `{{ANTI_GIT_ADD_ALL_REASON}}` | derived from common artifacts in target | `secrets, .env files, build artifacts, .auth/ live in the tree` |
| `{{STAGE_PATTERN}}` | derived from monorepo shape | `apps/... lib/... e2e/... ai-plans/...` or `<app>/... tests/... ai-plans/...` |
| `{{PROJECT_SKILLS_LIST}}` | computed from skills emitted | comma-separated names of the skills the project actually has |
| `{{AGENT_DISPATCH_TABLE}}` | from [vinta-derive-subagents](../vinta-derive-subagents/SKILL.md) output | markdown table mapping phase shapes → agent type |
| `{{OBSERVABILITY_MCP_BLOCK}}` | rendered from [resources/systematic-debugging-mcp-tools.md](resources/systematic-debugging-mcp-tools.md) | the verbatim "Phase 0 evidence categories" block — same content for every project. When `skills.systematic-debugging.observability_mcp_servers` is empty, renders the no-tools fallback paragraph instead. The block is MCP-agnostic on purpose: tool names are discovered at runtime, not baked at generation time. |
| `{{OBSERVABILITY_MCP_LIST}}` | derived from `skills.systematic-debugging.observability_mcp_servers` | comma-separated MCP server identifiers as the user named them at bootstrap (e.g. `sentry, datadog, our-internal-traces`). Renders `none configured` when empty. |

Render each template with substitutions, write to:

- `ai-tools/skills/implement-plan/SKILL.md` (from `implement-plan-template.md`)
- `ai-tools/skills/amend-plan/SKILL.md` (from `amend-plan-template.md`)
- `ai-tools/skills/systematic-debugging/SKILL.md` (from `systematic-debugging-template.md`) — only when `foundation_skills.systematic-debugging: enabled`

Validate each output: every `{{PLACEHOLDER}}` should be replaced; if any survive, the template needs a new substitution rule. `implement-plan` and `amend-plan` share the same placeholder set — fix substitutions for both at the same time. `systematic-debugging` adds the two MCP-related placeholders; if a project picks an observability tool the catalogue doesn't list, ask the user for a free-form snippet (heading, required calls, fields to extract) and inline it before saving — and consider upstreaming the snippet to [resources/systematic-debugging-mcp-tools.md](resources/systematic-debugging-mcp-tools.md).

### C. Optional — ask the user

Two skills depend on whether the project actually does the thing. Ask via `AskUserQuestion`:

| Skill | Question | If yes |
|---|---|---|
| `add-e2e-test` | "Does this project have e2e tests, or plan to add them?" Options: `Yes — already has them`, `Yes — planning to add`, `No — skip` | Ask if user has an existing template (path / URL). If yes → copy + adapt. If no → draft from scratch using the canonical structure (see "Skill SKILL.md structure" below) interviewing user about: e2e framework, page-object pattern, auth/storage-state pattern, seed-helpers location, tenant scoping in seeds, screenshot conventions for PRs. |
| `add-env-var` | "Does this project have a non-trivial env-var propagation flow (multiple files / build configs / CI to update for one new var)?" Options: `Yes`, `No — single .env file is enough` | Ask if user has an existing template. If yes → copy + adapt. If no → draft from scratch interviewing user about every layer the new var must touch (`.env.example`, build tool envPrefix allowlist, build cache hash inputs, app config module, AGENTS.md env section, CI workflows, deploy-time injection). |
| `add-one-off-script` | "Does this project ever need one-off operational scripts — backfills, cleanups, ad-hoc data fixes?" Options: `Yes — enable`, `No — skip`. Recommend `Yes` for any project with a relational DB; the skill bundles a `BaseOneOffScript` class enforcing dry-run-by-default, idempotent re-runs, batched DB ops, streamed reads, segmented CSV backups (1M cells/file, never nested across tables), interruption-safe signal handlers, and console + filesystem + S3 logging. | Copy [resources/foundation-skills/add-one-off-script/](resources/foundation-skills/add-one-off-script/) into `ai-tools/skills/add-one-off-script/` (SKILL.md + the bundled `resources/one_off_script_base.{py,ts}` templates). Then ask the user whether they want the base class file pre-staged at `<scripts_dir>/one_off/_base.{py,ts}` — default `Yes` for projects whose primary lang is Python or TS. The skill itself prompts to copy the base class on first use if the user said `No` here. |

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
- **Foundation set is a unit.** Always copy `plan-feature` + `create-spec` + `create-qa-use-cases` together — they reference each other.
- **`implement-plan` is generated, not copied.** Its body has too much project-specific content for verbatim shipping.
- **Optional skills (`add-e2e-test`, `add-env-var`, `add-one-off-script`) are gated by user answer.** Don't ship them by default.
- **Each skill solves one job.** Two unrelated checklists → split.
- **Reference real files in the target.** Skill links must point to existing paths.
- **Skills auto-load by description.** Specific triggers, specific outcomes.

## Pitfalls

- **Forgetting to substitute placeholders in `implement-plan`.** A surviving `{{TEST_CMD}}` is a runtime confusion. Validate before saving.
- **Copying foundation skills and forgetting to scrub source-project paths.** Bundled copies may still carry source-repo paths (e.g. `<source-repo>/ai-plans/`, `apps/<service>/`). Replace with the target's paths.
- **Asking too many questions for optional skills.** If `vinta-analyze-codebase` shows no e2e dir and the user clearly has no e2e setup, it's OK to skip the question and not ship `add-e2e-test`. Use judgment.
- **Skipping the foundation copy because "the user already has them".** They probably don't. Confirm by reading the target's `ai-tools/skills/` (if it exists at all). If it does have these, ask the user "refresh from bundled copies, or keep what you have?".

## Verification

After all skills written:

1. Each `ai-tools/skills/<name>/SKILL.md` has frontmatter `name` + `description`, plus markdown body.
2. `name` field matches dir name.
3. No `{{PLACEHOLDER}}` strings survive in any output skill.
4. Foundation skills (plan-feature, create-spec, create-qa-use-cases) reference each other correctly via `[name](../<name>/SKILL.md)` links.
5. `implement-plan` body cites real commands + the project's actual code host + branch / PR / co-author policy.
6. Setup script ([vinta-install-ai-tools-setup](../vinta-install-ai-tools-setup/SKILL.md)) runs cleanly with the new skills in place.
