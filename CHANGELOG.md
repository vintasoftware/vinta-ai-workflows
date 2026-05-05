# Changelog

All notable changes to `@vinta/ai-workflows` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
