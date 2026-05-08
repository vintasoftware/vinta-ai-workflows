---
name: vinta-sync-ai-tools
description: Bring a project up to date with the latest `@vinta/ai-workflows` package version. Reads the project's `.vinta-ai-workflows.yaml` (the single source of truth for which surface area is enabled), reads the cloned package's `CHANGELOG.md` to enumerate releases since the project's recorded version, classifies each change against the project's opt-in surface (affects-project / opt-in-offer / config-schema-change / not-applicable), shows per-change diffs, asks the user one `AskUserQuestion` per change (`Apply` / `Skip` / `Show diff`), applies approved changes (re-render templates, add new foundation skills, patch setup script, migrate config schema), and bumps `vinta_ai_workflows_version` + `last_synced_at` at the end. Layers on top of [vinta-update-project-skills](../vinta-update-project-skills/SKILL.md), which it invokes for foundation-skill body diffs. Use after `npm update @vinta/ai-workflows` or pulling a newer git+ssh ref.
---

# vinta-sync-ai-tools

The version-upgrade path. Companion to the rest of the builder skills:

- [vinta-bootstrap-ai-tools](../vinta-bootstrap-ai-tools/SKILL.md) — writes the project for the first time.
- **vinta-sync-ai-tools** — this skill. Updates the project against a newer package version.
- [vinta-update-project-skills](../vinta-update-project-skills/SKILL.md) — narrow tool for refreshing only the foundation-skill bodies. This skill calls it as a sub-step.

## Source of truth

`.vinta-ai-workflows.yaml` at the repo root. Defined by [`schemas/vinta-ai-workflows-config.v1.schema.json`](../../schemas/vinta-ai-workflows-config.v1.schema.json). Every consumer (this skill, every other builder skill, every template render) reads from this file. Modifying values there is the only supported way to change project-wide settings — never hand-edit values inlined into rendered SKILL.md bodies, those will be overwritten on the next sync.

If `.vinta-ai-workflows.yaml` is missing (older bootstrap or hand-built project), the sync skill's first step builds one by reverse-extracting state from the project's existing artifacts and interview-filling gaps. See "Bootstrapping the config file" below.

## Inputs

1. The project root (default: cwd).
2. The cloned `@vinta/ai-workflows` source. Auto-detected via the same paths as [vinta-update-project-skills](../vinta-update-project-skills/SKILL.md) — symlink realpath, copy-mode marker, or asked.
3. The project's `.vinta-ai-workflows.yaml` (read; rewritten at the end).

## Steps

### 1. Locate + load the config

`<project>/.vinta-ai-workflows.yaml` is required. If absent, run "Bootstrapping the config file" below to seed it before continuing.

Validate the config against the schema matching its `schema_version`. Any validation error → stop, surface the error path. Don't proceed against a malformed config.

Read:

- `vinta_ai_workflows_version` (call it `OLD_VERSION`).
- The current `version` field of the cloned package's `package.json` (call it `NEW_VERSION`).
- `foundation_skills`, `foundation_agents`, `vendors`, `stacks`, `policies` — used to decide what's `affects-project` vs `not-applicable` per change.

`OLD_VERSION === NEW_VERSION` → nothing to sync. Print "already up to date" and exit.

### 2. Enumerate releases

Read the cloned package's `CHANGELOG.md`. Parse each `## [X.Y.Z]` heading. Build the ordered list of releases between `OLD_VERSION` (exclusive) and `NEW_VERSION` (inclusive).

For each release, parse the `### Added`, `### Changed`, `### Removed`, `### Deprecated`, `### Notes` sub-sections into a list of change records: `{ release, kind, summary, body }`.

If the changelog is missing entries that file diffs reveal exist (orphan diffs), surface them at the end as "undocumented changes — please cross-check with maintainers". Don't try to apply orphans automatically.

### 3. Classify each change

For each change record, decide its bucket:

| Bucket | Trigger |
|---|---|
| `affects-project` | Touches surface area enabled in the config. Examples: foundation-skill body changed and the skill is `enabled`; template gained a section and the project has the rendered skill. |
| `opt-in-offer` | New optional surface area. Project doesn't have it enabled. Show the description; offer to enable. |
| `config-schema-change` | Adds a field to the config schema or bumps its major. Migrate the config; ask user to fill new required fields. |
| `not-applicable` | Project opted out (`disabled` in config) or never applicable (e.g. stack-specific change for a stack the project doesn't use). |
| `tooling` | Setup-script / gitignore / packaging changes that propagate transparently — no per-change question; apply if approved as a batch. |

Cross-check via file diff: every `affects-project` change should correspond to a real file delta between `OLD_VERSION`'s source (reachable via git tag in the clone) and `NEW_VERSION`'s source. Diffs without changelog entries → flag as orphan (see step 2).

### 4. Build the proposal

Group by bucket. Print as a structured report. Example:

```
vinta-ai-workflows sync: 0.1.0 → 0.1.2 (2 releases)
====================================================

AFFECTS PROJECT — your enabled surface gained changes
  [0.1.1] implement-plan template: §1f PR-context flow added
    file: ai-tools/skills/implement-plan/SKILL.md (will re-render)
    diff: +88 lines, -6 lines

  [0.1.2] amend-plan template: blast-radius gate added
    file: ai-tools/skills/amend-plan/SKILL.md (will re-render)
    diff: +52 lines, -0 lines

OPT-IN OFFER — new optional surface area
  [0.1.2] foundation skill: open-pr-from-context
    your config has: foundation_skills.open-pr-from-context: <missing>
    enabling will: copy SKILL.md + scripts/open-pr.sh into ai-tools/skills/

CONFIG SCHEMA CHANGE
  [0.1.2] new field: run_options.amend-plan.blast_radius_signal_threshold (int, default 2)

TOOLING (batch-apply if approved)
  [0.1.2] setup-ai-tools.mjs: appends `.vinta-ai-workflows/prs-context/` to .gitignore on first run

NOT APPLICABLE (skipped — opted out / unused stack)
  [0.1.1] add-env-var optional skill update — your config has add-env-var: disabled
  [0.1.1] medplum stack notes update — project doesn't use medplum stack
```

For each `affects-project` and `opt-in-offer` entry, expand a unified diff inline on user request.

### 5. Per-change confirmation

**Critical: never apply silently.**

For each `affects-project` and `opt-in-offer` and `config-schema-change` entry, ask the user via `AskUserQuestion`:

- `Apply`
- `Skip` (records as opted-out for this version; next sync won't re-propose; user can later flip the foundation skill back to `enabled` to re-offer)
- `Show diff` (re-displays in full, then re-asks)

`tooling` changes batch under one prompt: `Apply all tooling changes?` — they're typically idempotent and small.

`opt-in-offer` `Skip` writes the corresponding entry to `foundation_skills` (or wherever it lives) as `disabled` so the next sync respects the choice.

Don't batch `affects-project` decisions. Each is a separate decision so the user can keep their hand-tuned wording for one skill while accepting another.

### 6. Apply approved changes

In order:

1. **`config-schema-change`** first. Migrate `.vinta-ai-workflows.yaml`:
   - Add new optional fields with defaults from the schema.
   - For new required fields: prompt the user for a value with `AskUserQuestion`.
   - On schema major bump: apply the documented migration from the bumped schema's release notes.
   - Bump `schema_version` if the major changed.

2. **`opt-in-offer` accepts** — flip the corresponding entry to `enabled` in the config; copy / render the artifact (foundation skill, agent, etc.).

3. **`affects-project` accepts** — re-render the relevant template (for `implement-plan` / `amend-plan`) or re-copy the foundation skill body (for verbatim ones — delegated to [vinta-update-project-skills](../vinta-update-project-skills/SKILL.md)). Use the values in `.vinta-ai-workflows.yaml` as the substitution source. Validate every `{{PLACEHOLDER}}` is resolved.

4. **`tooling` accepts** — run setup-ai-tools.mjs from the new package version in idempotent mode. The script handles gitignore append, vendor symlinks, vendor agent file regeneration.

5. Re-validate every YAML file under the project against its schema (`.vinta-ai-workflows.yaml`, `ai-tools/agents/*.yaml`, any `.vinta-ai-workflows/prs-context/**/*.md` frontmatter blocks). Surface validation failures; don't silently proceed.

### 7. Bump version + final report

After all approved changes apply:

1. Update `.vinta-ai-workflows.yaml`:
   - `vinta_ai_workflows_version: <NEW_VERSION>`.
   - `last_synced_at: <ISO timestamp>`.
2. Print the final summary:
   - Applied (per-change list).
   - Skipped — and where the user can re-evaluate later (config file path).
   - New `foundation_skills` / `foundation_agents` entries set to `disabled`.
   - Orphan diffs (undocumented changes from step 2) for the user's review.
   - If the package version was a major bump (e.g. `0.x.y` → `1.0.0`): warn the user to read the full changelog, especially the `### Removed` / `### Deprecated` sections.

## Bootstrapping the config file

Run on first sync against a project without `.vinta-ai-workflows.yaml`:

1. Detect the installed package version: read `node_modules/@vinta/ai-workflows/package.json` (or the clone's). Use as `vinta_ai_workflows_version`.
2. Detect project facts:
   - `project.name` → `package.json#name` or `Cargo.toml#package.name` or repo dir name; confirm.
   - `project.default_branch` → `git remote show origin | grep 'HEAD branch'` or `git rev-parse --abbrev-ref origin/HEAD`.
   - `project.code_host` → parse `git remote get-url origin`.
   - `project.stack_summary` → run [vinta-analyze-codebase](../vinta-analyze-codebase/SKILL.md) inventory, take the one-liner.
   - `project.ai_plans_dir` → look for `ai-plans/`, `core-service/ai-plans/`, etc.
3. Detect commands by scanning `package.json#scripts`, `Makefile`, etc. Confirm each via `AskUserQuestion`.
4. Detect policies by reading the existing `ai-tools/skills/implement-plan/SKILL.md` (if present) — reverse-extract `pr_creation`, `ai_coauthor`, `commit_style` from the rendered body. Interview-fill gaps.
5. Detect vendor coverage from existing vendor symlinks/dirs (`.claude/`, `.cursor/`, `.codex/`, `.github/agents/`).
6. Detect foundation-skill opt-ins by scanning `ai-tools/skills/`.
7. Detect stacks via `vinta-analyze-codebase` matched-stacks list.
8. Write `.vinta-ai-workflows.yaml` with the inferred state. Add the schema-language-server directive at the top.
9. Print the final config to the user; ask `AskUserQuestion`: `Looks right — proceed with sync` / `Edit values first` / `Stop`.

Then re-enter step 1 of the main flow.

## Pitfalls

- **Hand-edited rendered skill bodies.** `vinta-sync-ai-tools` re-renders templates from the config — any inline edits the user made to the rendered `ai-tools/skills/<name>/SKILL.md` will be overwritten on `Apply`. Surface a warning when re-rendering would clobber a body the user touched (heuristic: file modified after the bootstrap commit). Default action: ask before overwriting.
- **`OLD_VERSION` lower than the oldest changelog entry.** Some projects predate the changelog. Treat anything before the earliest documented version as "best-effort sync" and rely on file diff entirely.
- **Multiple package versions in the clone.** If the user has both `node_modules/@vinta/ai-workflows/` and a separate `git clone`, they may diverge. Pick one source and pin to it for the run; surface the choice up front.
- **Orphan diffs.** Surfaced, never auto-applied. Ask the maintainer to add a changelog entry; don't try to interpret an undocumented change.
- **Breaking schema bump (`schema_version: N → N+1`).** Migration code must come from the package's release notes. If migration data is missing, stop — don't guess.
- **Sticky opt-outs.** A user who accepted `add-env-var: disabled` once stays disabled across sync runs. To re-offer, manually flip to `enabled` in `.vinta-ai-workflows.yaml` and re-run sync.

## Verification

1. **Up-to-date project**: `OLD_VERSION === NEW_VERSION` → "already up to date", no changes.
2. **Single template change accepted**: re-renders one skill body, all `{{PLACEHOLDER}}` resolved, `vinta_ai_workflows_version` bumped, no other files touched.
3. **Opt-in declined**: `foundation_skills.<name>: disabled` written to config; nothing else added.
4. **Schema bump**: new field added with default; `schema_version` bumped if major changed; payload still validates.
5. **Bootstrap from missing config**: `.vinta-ai-workflows.yaml` written with reverse-extracted values; user confirms before main flow runs.
6. **Orphan diff**: changelog has no entry for a real file change; sync surfaces it at the end without applying.
