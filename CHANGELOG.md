# Changelog

All notable changes to `@vinta/ai-workflows` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] — 2026-05-06

### Added

- **Schema-as-contract: `schemas/` directory** at the repo root. Four
  JSON Schema (Draft 2020-12) files now define every YAML format the
  toolchain produces or consumes. Every YAML payload carries a top-level
  `schema_version: <int>` matching the schema filename suffix.
  - [`vinta-ai-workflows-config.v1.schema.json`](schemas/vinta-ai-workflows-config.v1.schema.json)
    — for `.vinta-ai-workflows.yaml` (project config, see below).
  - [`sub-agent.v1.schema.json`](schemas/sub-agent.v1.schema.json) —
    for `ai-tools/agents/<name>.yaml` (vendor-agnostic sub-agent
    definitions consumed by `setup-ai-tools.mjs`). Documents the four
    vendor-override sub-objects (`overrides.{claude,cursor,copilot,codex}`).
  - [`prs-context-frontmatter.v1.schema.json`](schemas/prs-context-frontmatter.v1.schema.json)
    — for the YAML frontmatter at the top of every
    `prs-context/{feature-kebab}/phase-{phase.id}.md` file.
  - [`prs-context-comments.v1.schema.json`](schemas/prs-context-comments.v1.schema.json)
    — for the YAML list inside the `# Comments` ` ```yaml ` fence.
  - [`schemas/README.md`](schemas/README.md) documents versioning
    rules (when to bump major, how to ship `vN+1` alongside `vN`),
    IDE wiring via `# yaml-language-server: $schema=...` directives,
    and CI validation snippets (`ajv-cli`).

- **Project config file: `.vinta-ai-workflows.yaml`** (new — written by
  `vinta-bootstrap-ai-tools` Step 0.5, read + rewritten by
  `vinta-ai-workflows-sync`). Single source of truth for project-wide
  settings:
  - `vinta_ai_workflows_version` — last package version synced from.
  - `project.{name, default_branch, code_host, stack_summary, ai_plans_dir, pr_template_paths}`.
  - `commands.{lint, format, build, test_unit, test_unit_scoped, test_unit_new_pattern, e2e}`.
  - `policies.{pr_creation, ai_coauthor, commit_style, stage_pattern, anti_git_add_all_reason}`.
  - `vendors` — claude / cursor / copilot / codex selection.
  - `foundation_skills` + `foundation_agents` — per-artifact opt-in
    (`enabled` / `disabled`). `disabled` is sticky — `vinta-ai-workflows-sync`
    won't re-propose disabled artifacts.
  - `stacks` + `stack_specialist_agents` — applied stack templates.
  - `run_options.<skill>` — per-skill defaults
    (`implement-plan.{pause_between_phases, generate_inline_comments}`,
    `amend-plan.blast_radius_signal_threshold`).
  - `skills.<name>` — per-skill custom config (open shape per skill).
  Replaces today's pattern of inlining interview answers into rendered
  SKILL.md bodies; bodies will continue to inline values (Path B) but
  re-rendering is driven from the config so values can be edited and
  propagated by re-running sync.

- **New builder skill: `vinta-ai-workflows-sync`**
  ([SKILL.md](skills/vinta-ai-workflows-sync/SKILL.md)). Brings a
  project up to date with the latest package version. Workflow:
  1. Load `.vinta-ai-workflows.yaml`; validate against schema. If
     missing, run "Bootstrapping the config file" — reverse-extracts
     state from existing artifacts + interview-fills gaps.
  2. Diff the project's `vinta_ai_workflows_version` against the
     cloned package's current version; parse `CHANGELOG.md` to
     enumerate releases between.
  3. Per change, classify against the project's opt-in surface
     (`affects-project` / `opt-in-offer` / `config-schema-change` /
     `not-applicable` / `tooling`). Cross-validate via file diff;
     surface orphan diffs (no changelog entry) at the end.
  4. Build a per-bucket proposal with inline diffs; `AskUserQuestion`
     per change (`Apply` / `Skip` / `Show diff`); batch tooling
     changes under one prompt.
  5. Apply approved: migrate config schema, flip opt-ins to
     `enabled`, re-render templates, re-copy verbatim foundation
     skills (delegated to [vinta-update-project-skills](skills/vinta-update-project-skills/SKILL.md)),
     re-run setup-ai-tools.mjs in idempotent mode.
  6. Re-validate every YAML file against its schema.
  7. Bump `vinta_ai_workflows_version` + `last_synced_at`.
  Layers on top of `vinta-update-project-skills` (narrow tool stays;
  sync calls it for foundation-skill body diffs).

- **`vinta-bootstrap-ai-tools` Step 0.5 — Write `.vinta-ai-workflows.yaml`**.
  New step inserted between Step 0 (interview) and the sub-skill flow.
  Captures all interview state into the canonical config file before
  any sub-skill runs. Validates against the schema; partial configs
  route back to the relevant interview question. Re-bootstrap of an
  existing-config project asks `Keep existing / Re-interview / Stop`.
  Outputs tree updated to show `.vinta-ai-workflows.yaml` at the repo
  root.

- **Schema directives** added to the templates that emit YAML files —
  `# yaml-language-server: $schema=...` lines at the top of each
  authored payload so IDEs auto-validate. Wired into:
  - [skills/vinta-derive-skills/resources/prs-context-template.md](skills/vinta-derive-skills/resources/prs-context-template.md)
    (frontmatter + `# Comments` fence).
  - [skills/vinta-derive-subagents/SKILL.md](skills/vinta-derive-subagents/SKILL.md)
    (sub-agent YAML shape examples now show `schema_version: 1` +
    schema directive).

- **New project-skill template: `amend-plan`** (renders to
  `ai-tools/skills/amend-plan/SKILL.md` per project, alongside
  `implement-plan`). Source:
  [skills/vinta-derive-skills/resources/amend-plan-template.md](skills/vinta-derive-skills/resources/amend-plan-template.md).
  Companion to `implement-plan` — same agents, same review gates, same
  prs-context flow; opposite git topology direction (history rewriting
  instead of forward execution). Use cases: spec change forces a phase
  body rewrite, a phase needs to slot in between existing ones, or a §2
  guiding decision changes and cascades through later phases.

  Flow:
  1. Edit the plan file (rewrite affected phase bodies, insert / append
     new phases, log the amendment in `## Amendments`).
  2. Build a per-phase state map (`not-started` / `in-progress` /
     `implemented-not-merged` / `merged-to-default`).
  3. **Blast-radius evaluation.** Compute signals (rewrite share ≥ 50%,
     §2 cascade ≥ 50%, ≥2 immutable phases combined with earlier
     rewrites, data-model contract change in >2 phases, ≥70% rewritten
     LoC, multi-author branches, ≥2 approved PRs). ≥2 signals tripping
     → surface a `Restart` option to the user before any force-push
     plan is shown. On `Restart`: hand off to `plan-feature` for a
     fresh `YYYY-MM-DD-FEATURE_NAME_PLAN.md`; annotate the old plan
     `Superseded`; leave old phase branches in place for audit; exit.
  4. Refuse force-pushes that can't work — phases merged to the default
     branch are immutable; amendment must be a new appended phase.
     Branch protection, multi-author branches, and approved PRs all
     prompt for explicit confirmation.
  5. Per affected phase, in stack order: spawn an implementer subagent
     to bring the diff into compliance with the new body, run inner +
     outer test loops, run all three review layers, rebase onto the
     (possibly-rewritten) parent, then `git push --force-with-lease`.
     Conflicts resolved by a fixer subagent.
  6. Refresh the `prs-context/{feature}/phase-{id}.md` file: pending
     ones get rewritten in place; published ones may flip back to
     pending and re-publish via `open-pr.sh` so new comments post.
  7. Update `TRACKING_{plan-id}.md` with amendment notes; final report
     lists every branch state, pending PR-contexts, blocked rewrites
     with forward-phase suggestions, and a reviewer re-request reminder.

  Hard rules:
  - Never `--force`. Always `--force-with-lease`.
  - Per-branch confirmation; never batch.
  - Subagents commit but never push — orchestrator owns force-push.
  - Phases merged to default branch are converted to `append-new` and
    handed off to `implement-plan`, not rewritten here.
  - `not-started` phases never executed by this skill — also handed off
    to `implement-plan`.
- **`vinta-bootstrap-ai-tools` Outputs tree** updated to list
  `ai-tools/skills/amend-plan/SKILL.md` alongside `implement-plan`.
- **`vinta-derive-skills` bucket B** now generates two skills from
  templates instead of one. Both templates share the same placeholder
  set (`{{LINT_CMD}}`, `{{BUILD_CMD}}`, `{{TEST_CMD}}`, `{{DEFAULT_BRANCH}}`,
  `{{PR_*}}` family, `{{COAUTHOR_*}}` family, `{{COMMIT_STYLE_LINE}}`,
  etc.) — substitute once, render twice.

- **New foundation skill + bundled script: `open-pr-from-context`**
  ([SKILL.md](skills/vinta-derive-skills/resources/foundation-skills/open-pr-from-context/SKILL.md),
  [scripts/open-pr.sh](skills/vinta-derive-skills/resources/foundation-skills/open-pr-from-context/scripts/open-pr.sh)).
  The mechanical work — parse frontmatter + sections, detect CLI, open
  PR, post each inline comment, rewrite frontmatter, append publish log —
  lives in the bash script; the SKILL.md is a thin wrapper that picks
  the file, runs the script, and reports the result. Script deps:
  `bash 4+`, `git`, `yq` (Mike Farah), `jq`, plus one of `gh` / `glab`.
  Per-comment failure tolerated — bad ones reported, run continues.
  On success rewrites the file's frontmatter to `status: published` +
  `pr_url`, appends a timestamped publish log. Strictly scoped: no push,
  no test re-runs, no diff editing, no draft generation. Bundled with
  the `vinta-derive-skills` foundation set so it ships with every new
  bootstrap. Exit codes: 0 (full success), 1 (PR up, comment failures),
  2 (hard failure / missing deps).
- **PR-context template** at
  [skills/vinta-derive-skills/resources/prs-context-template.md](skills/vinta-derive-skills/resources/prs-context-template.md)
  defining the reproducible file shape: frontmatter (plan_id, feature_name,
  phase_id, phase_title, branch, base, created_at, status, pr_url) +
  `# Title`, `# Description`, `# Comments` sections (single fenced YAML
  list of `{file, start_line, end_line?, side, body}` entries).
- **`implement-plan` Step 0 opt-in questions** (template-level —
  `vinta-derive-skills` renders these into the project's `implement-plan`
  skill body):
  - **Pause between phases?** Default off (auto-flow). When on, a new §1i
    gate fires after each phase's user update with `Continue` / `Pause` /
    `Stop` options; orchestrator exits cleanly on Pause and resumes on
    next invocation per the existing "Re-running mid-plan" flow.
  - **Generate PR descriptions + inline comments?** Default off. When on,
    new §1f draft step fires after every phase: agent picks 3–10
    non-obvious comment targets from the diff (subtle invariants,
    feature-flag short-circuits, cross-phase coupling, upstream-contract
    naming), writes `prs-context/{feature-kebab}/phase-{phase.id}.md`
    following the template, and — if a PR CLI is detected — invokes
    `open-pr-from-context` to publish.
- **`prs-context/` auto-added to `.gitignore`** by
  [skills/vinta-install-ai-tools-setup/resources/setup-ai-tools.mjs](skills/vinta-install-ai-tools-setup/resources/setup-ai-tools.mjs)
  on first invocation. Idempotent (re-runs don't duplicate the entry);
  preserves any existing `.gitignore` content; appends a labeled block.
- **Run-options state** (`run_options.pause_between_phases`,
  `run_options.generate_pr_context`) recorded in the per-plan tracking
  file so re-running mid-plan honors the original choices.
- **Quick checklist + Important rules** in the implement-plan template
  updated with bullets for opt-in honoring and PR-context durability.

### Changed

- **`setup-ai-tools.mjs` validates `schema_version`** on every loaded
  `ai-tools/agents/<name>.yaml`. Files lacking `schema_version: 1`
  fail fast with a clear error pointing at
  `schemas/sub-agent.v1.schema.json`.

- **PR-context generation honors existing project PR / MR templates.**
  New `project.pr_template_paths: string[]` field in
  [`vinta-ai-workflows-config.v1.schema.json`](schemas/vinta-ai-workflows-config.v1.schema.json)
  lists templates detected at bootstrap. Detection in
  [`vinta-analyze-codebase` §11](skills/vinta-analyze-codebase/SKILL.md)
  now scans (case-insensitive):
  - GitHub: `.github/pull_request_template.md`,
    `.github/PULL_REQUEST_TEMPLATE.md`,
    `.github/PULL_REQUEST_TEMPLATE/*.md`,
    repo-root + `docs/` variants.
  - GitLab: `.gitlab/merge_request_templates/*.md`.
  Inventory output adds `existing_ai_artifacts.pr_templates[]` with
  `path` + section summary per template.

  `implement-plan` §1f step 2 now reads `project.pr_template_paths`
  and uses the chosen template's section structure verbatim for the
  prs-context `# Description`. Sections are filled with phase-specific
  content; `<!-- HTML comments -->` placeholders are preserved;
  checklists are ticked only for items the diff actually satisfies.
  Multi-template directories prompt the user once; the choice is
  cached under `run_options.pr_template_used` for subsequent phases.
  Empty array → free-form description with default sections
  (`## Summary`, `## Plan reference`, `## Test plan`).

  `amend-plan` §4f follows the same rule when refreshing prs-context
  bodies, picking up the current `pr_template_paths` even when the
  template was added or swapped after the original `implement-plan`
  run.

  [`prs-context-template.md`](skills/vinta-derive-skills/resources/prs-context-template.md)
  `# Description` guidance updated with the three branches (one
  template / multiple templates / empty).

- **PR creation consolidated to a single flow.** Earlier drafts had two
  parallel paths in `implement-plan`: the legacy `{{PR_CREATION_INSTRUCTION_BLOCK}}`
  in §1e (raw `gh pr create` / `glab mr create`) and the new
  `prs-context` + `open-pr.sh` flow in §1f. Removed the legacy block.
  PRs now always go through a `prs-context/{feature-kebab}/phase-{phase.id}.md`
  file + the bundled script, even when inline comments are off.
  Behavior matrix in the [implement-plan template §1f](skills/vinta-derive-skills/resources/implement-plan-template.md):

  | PR policy | inline comments | §1f does |
  |---|---|---|
  | agents create | off | write file (empty comments) + run `open-pr.sh` |
  | agents create | on  | write file (full) + run `open-pr.sh` |
  | branches only | off | skip §1f |
  | branches only | on  | write file (durable record); skip script |

- **Renamed run-option:** `run_options.generate_pr_context` →
  `run_options.generate_inline_comments`. The opt-in is now strictly
  about inline comments — PR opening itself is governed by the project's
  PR creation policy captured at bootstrap, not by this per-run flag.
- **Removed placeholder** `{{PR_CREATION_INSTRUCTION_BLOCK}}` from the
  implement-plan template + `vinta-derive-skills` SKILL.md substitution
  table. The remaining `{{PR_*}}` placeholders cover framing only
  (description, push, checklist, summary phrasing); they no longer
  carry raw `gh pr create` lines.
- **Important rule + Quick checklist** updated to describe the unified
  §1f matrix instead of the previous two-flag gate.

## [0.1.1] — 2026-05-05

### Added

- **New sub-skill: `vinta-migrate-plans-specs`** — finds existing implementation
  plans and feature specs scattered across a project (`docs/`, `specs/`,
  `plans/`, root markdown, branch-named files, ADRs, legacy `_IMPLEMENTATION_PLAN`
  variants) and migrates them to the canonical `ai-plans/YYYY-MM-DD-{FEATURE_NAME}_{PLAN|SPEC}.md`
  layout. Read-only by default; every rename gated on per-file user approval
  via `AskUserQuestion`. Classifies PLAN vs SPEC by filename + body shape;
  derives date from filename, doc body, `git log --diff-filter=A --follow`,
  or asks. Locks paired spec+plan to the same `FEATURE_NAME`. Rewrites
  inbound markdown references in the same batch as each move.
- **`vinta-bootstrap-ai-tools` Step 0 §E — Existing AI artifacts disposition.**
  Per-artifact `AskUserQuestion` over every instruction doc, skill, and
  sub-agent found in the repo. Options: `Migrate to ai-tools/<…>`,
  `Keep in current vendor path, don't touch`, `Drop`, plus
  `Replace with Vinta foundation version` for foundation-shape names
  (`plan-feature`, `create-spec`, `create-qa-use-cases`, `implement-plan`,
  `add-e2e-test`, `add-env-var`, `implementer`, `reviewer`, `fixer`).
  Decisions never batched — one prompt per artifact.
- **`vinta-bootstrap-ai-tools` sub-skill flow extended to six steps.**
  Step 6 dispatches `vinta-migrate-plans-specs`. Step 0 §A.2 question
  updated to offer a `Skip migrate-plans-specs` option in the custom
  selection.
- **`vinta-bootstrap-ai-tools` Outputs section** now documents the
  `ai-plans/` tree alongside the `ai-tools/` tree.
- **`vinta-bootstrap-ai-tools` Verification** check #6 — confirms migrated
  docs land in canonical `YYYY-MM-DD-{FEATURE_NAME}_{PLAN|SPEC}.md` form
  and no orphaned plan/spec markdown remains in `docs/`, `specs/`, or
  repo root.
- **`vinta-analyze-codebase` §11 — Existing AI-tooling artifacts.** Full
  enumeration of instruction docs, skills (across `.claude/skills/`,
  `.cursor/skills/`, `.codex/skills/`, `.github/skills/`, `.agents/skills/`,
  `ai-tools/skills/`), and sub-agents (across the parallel `agents/`
  paths). Each entry classified `vinta-managed` / `foundation-shape` /
  `project-custom` / `stack-specialist`. Setup-script presence + symlinks
  recorded. Plans-dir presence flagged.
- **Inventory schema** (`existing_ai_artifacts.{instructions,skills,agents,setup,plans_dir_present}`)
  added to `vinta-analyze-codebase` output, consumed by the four
  downstream sub-skills.
- **`vinta-write-agents-md` Inputs §2** — three explicit branches per
  existing instruction doc: `Merge into new ai-tools/AGENTS.md`,
  `Keep as-is, link from ai-tools/AGENTS.md`, `Replace from scratch`.
  Discarded files surfaced in the run summary.
- **`vinta-derive-subagents` "Reconcile against existing agents (do this FIRST)"
  section.** Vendor-format → canonical YAML conversion table (Claude
  `tools:` CSV, Cursor `readonly`, Codex `sandbox_mode`, Copilot
  `tools[]`). Foundation trio only emitted when missing or explicitly
  replaced.
- **`vinta-derive-skills` "Reconcile against existing skills (do this FIRST)"
  section.** Migrate uses `git mv`, body scrubbed for hard-coded vendor
  paths after move. `vinta-*` directories left alone (managed by the
  CLI). Foundation duplicates suppressed when the user has `Migrate` /
  `Keep` on the matching name.

### Changed

- **`vinta-bootstrap-ai-tools` sub-skill flow** updated from "five sub-skills"
  to "six sub-skills" wording across the orchestrator. Step 0 §A.2 default
  changed from `All five` to `All six`.
- **`vinta-analyze-codebase`** documentation split: §10 Documentation
  already present is now READMEs / ADRs only; existing AI tooling moved
  to its own §11 with deeper coverage.

### Notes

- The new disposition flow makes bootstrap **non-destructive by default**
  for any repo that already has AI tooling — nothing gets overwritten
  without an explicit per-artifact `Replace` answer.
- Foundation skills (`plan-feature`, `create-spec`, `create-qa-use-cases`)
  still hard-code Vinta-internal `core-service/ai-plans/` paths in their
  bundled bodies; `vinta-derive-skills` already scrubs these after copy.
  `vinta-migrate-plans-specs` flags the legacy `_IMPLEMENTATION_PLAN`
  suffix during migration so projects can align their foundation-skill
  bodies to the new `_PLAN` standard. A follow-up release will update
  the bundled foundation-skill resources to use the project's canonical
  paths from the start.

## [0.1.0] — 2026-05-05

### Added

- Initial release of `@vinta/ai-workflows` as a private npm package
  exposing the `vinta-ai-workflow` CLI bin.
- Seven `vinta-`-prefixed bootstrap skills under `skills/`:
  `vinta-analyze-codebase`, `vinta-bootstrap-ai-tools`, `vinta-derive-skills`,
  `vinta-derive-subagents`, `vinta-install-ai-tools-setup`,
  `vinta-update-project-skills`, `vinta-write-agents-md`.
- `vinta-ai-workflow` CLI commands: `install`, `update`, `uninstall`, `list`.
- Multi-vendor install support: Claude Code (`.claude/skills/`), Codex
  (`.agents/skills/`), Cursor (`.cursor/skills/`), VS Code + Copilot
  (`.github/skills/`), plus virtual `agents` tool that writes to
  `.agents/skills/` to cover Codex + Cursor + Copilot in one shot.
- Symlink-by-default install (auto-tracks `npm install` / `git pull`
  refreshes); `--copy` mode for projects that don't preserve symlinks.
- Marker-based uninstall safety: removes only symlinks pointing back
  into the package's `skills/` tree or directories containing
  `.installed-by-vinta-ai-workflows`. Hand-installed skills survive.
- `vinta-update-project-skills` skill: refresh project's
  `ai-tools/skills/` against latest source, per-skill diff + explicit
  accept gate.
- README documenting `git+ssh://` install (no registry needed),
  optional GitHub Packages flow, `npx` one-shot, and full workflow recap.
