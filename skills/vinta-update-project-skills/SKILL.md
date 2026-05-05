---
name: vinta-update-project-skills
description: Refresh the user's project skills under `ai-tools/skills/` against the latest versions in this `vinta-ai-workflows` repo. Detects which project skills came from the bundled foundation set or stack templates, computes a per-file diff against the current source, presents the proposed changes, and only applies them after the user explicitly accepts each one. Skills the user authored themselves (no matching upstream source) are detected and left alone. Use after pulling a new version of `vinta-ai-workflows` to bring an existing project up to date without re-running the full bootstrap. Read-only by default — every write is gated on explicit user approval.
---

# Update project skills

[vinta-bootstrap-ai-tools](../vinta-bootstrap-ai-tools/SKILL.md) (specifically [vinta-derive-skills](../vinta-derive-skills/SKILL.md)) seeds a project's `ai-tools/skills/` directory from sources that live in this repo:

- **Verbatim foundation skills** — copied as-is from `vinta-derive-skills/resources/foundation-skills/<name>/SKILL.md`.
- **Templated skills** — `implement-plan/SKILL.md` is rendered from `vinta-derive-skills/resources/implement-plan-template.md` with project-specific values interpolated.
- **Stack-derived skills** — drafted from prompts under `vinta-bootstrap-ai-tools/resources/stacks/<stack>/notes.md`.
- **User-authored skills** — anything else the team added later. **Never overwritten.**

When this repo gains an updated foundation skill (new section, fixed wording, bumped checklist), existing projects sit on the old copy until someone refreshes them. This skill is the safe path to that refresh.

## Inputs

- Path to the project being updated (default: cwd).
- Path to the `vinta-ai-workflows` clone (auto-detected from this skill's installed location — see "Locating the source").
- The project's `ai-tools/skills/` directory.

## Output

- A diff report listing each project skill with status: `up-to-date`, `outdated`, `templated (regenerate)`, or `user-authored (skip)`.
- For each `outdated` skill the user accepts: the project file is overwritten with the source content. Nothing else changes.
- A summary of what was updated, what was left alone, and any follow-ups (e.g. "re-run [vinta-derive-skills](../vinta-derive-skills/SKILL.md) to refresh `implement-plan`").

## Locating the source

The skill must know where this `vinta-ai-workflows` repo lives. Resolution order:

1. **Symlink installs** (default): the project's installed copy of this skill is a symlink. Use `realpath` of `<project>/.claude/skills/vinta-update-project-skills/SKILL.md` (or whichever vendor path) to walk back to `<clone>/ai-tools-builder/skills/vinta-update-project-skills/SKILL.md`. From there, `<clone>` is three directories up.
2. **Copy installs**: the installed copy contains `.installed-by-vinta-ai-workflows` whose body records the original `source:` path. Read that path and walk up.
3. **Both fail** (e.g. the clone moved): ask the user for the path with `AskUserQuestion`. Don't proceed without it.

Once located:

- Foundation source root: `<clone>/ai-tools-builder/skills/vinta-derive-skills/resources/foundation-skills/`.
- Template source root: `<clone>/ai-tools-builder/skills/vinta-derive-skills/resources/`.
- Stack source root: `<clone>/ai-tools-builder/skills/vinta-bootstrap-ai-tools/resources/stacks/`.

## Steps

### 1. Prerequisite check

`<project>/ai-tools/skills/` exists and is non-empty. If not → stop and tell the user to run [vinta-bootstrap-ai-tools](../vinta-bootstrap-ai-tools/SKILL.md) first.

The clone is locatable (per "Locating the source"). If not → ask, then continue.

### 2. Inventory the project skills

For each subdirectory under `<project>/ai-tools/skills/`, record:

- Skill name (= directory name).
- The file paths inside (`SKILL.md` always; sometimes `resources/`, `scripts/`, etc.).
- The current contents of `SKILL.md`.

### 3. Classify each skill

For each project skill, decide its bucket:

| Bucket | Detection | Action |
|---|---|---|
| `verbatim` | The skill name matches a directory under `vinta-derive-skills/resources/foundation-skills/` (e.g. `plan-feature`, `create-spec`, `create-qa-use-cases`). | Diff against source. |
| `templated` | The skill name is `implement-plan` (or any other future templated skill listed under `vinta-derive-skills/resources/*-template.md`). | **Don't diff.** Surface as "regenerate via [vinta-derive-skills](../vinta-derive-skills/SKILL.md)". |
| `stack-derived` | The skill maps to a stack-template prompt under `vinta-bootstrap-ai-tools/resources/stacks/<stack>/notes.md`. | Same as `templated` — surface, don't diff. |
| `user-authored` | None of the above. | Skip silently. |

For `templated` and `stack-derived`, in-place diffing is misleading because the project version contains interpolated values (commands, branch names, etc.) that won't appear in the template. The right refresh path for those is to re-run [vinta-derive-skills](../vinta-derive-skills/SKILL.md) so the user can re-supply the inputs.

### 4. Diff verbatim skills

For each `verbatim` skill:

- Read the source `SKILL.md` from the clone.
- Read the project's `SKILL.md`.
- If byte-identical → mark `up-to-date`.
- Else → mark `outdated`, compute a unified diff (use `git diff --no-index` if available, otherwise produce a text diff yourself).

Also compare the rest of the directory tree (`resources/`, `scripts/`, etc.). Any source files not present in the project version → mark as "new files to add". Any project files not present in source → leave alone (could be local additions).

### 5. Build the proposal

Produce a human-readable report grouped by status. Example:

```
Project skills under ai-tools/skills/ — refresh proposal
========================================================

UP-TO-DATE (no action needed)
  - plan-feature

OUTDATED (proposed: overwrite SKILL.md from source)
  - create-spec        (12 lines added, 3 removed)
  - create-qa-use-cases (2 lines changed)

REGENERATE NEEDED (proposed: re-run vinta-derive-skills)
  - implement-plan     (templated — values would be lost on overwrite)

USER-AUTHORED (no action — left alone)
  - my-team-thing
  - update-tenant-fields
```

For each `outdated` entry, include the diff inline (collapsed if long). Don't truncate — the user needs to see what's changing.

### 6. Per-skill confirmation

**Critical: never apply changes silently.**

For each `outdated` skill, ask the user explicitly. Use `AskUserQuestion` (or the equivalent for the vendor) with options:

- `Apply` — overwrite the project file with source.
- `Skip` — leave the project version alone for now.
- `Diff again` — re-display the diff in full.

Do NOT batch these under a single "apply all?" prompt. Each skill is a separate decision so the user can keep their hand-tuned wording where it matters.

For `templated` / `stack-derived` skills, the question is different — they can't be applied directly:

- `Re-run vinta-derive-skills now` (orchestrator decides if that's in-scope for this session) — exits this skill, hands off.
- `Skip` — leave alone, surface as a TODO at the end.

### 7. Apply approved changes

For each `outdated` skill where the user said `Apply`:

- Overwrite `<project>/ai-tools/skills/<name>/SKILL.md` with source content.
- For any "new files to add" inside that skill's source tree, copy them into the project (preserving subdir structure).
- Do not touch project-only files inside that skill's directory.

After each write, log: `[updated] ai-tools/skills/<name>/SKILL.md`.

### 8. Re-run the per-vendor setup script

The project's `ai-tools/scripts/setup-ai-tools.mjs` (installed by [vinta-install-ai-tools-setup](../vinta-install-ai-tools-setup/SKILL.md)) materializes vendor-specific copies. After updating canonical skills, run it so each vendor's `<vendor>/skills/` symlink/copy resolves to the new content:

```bash
pnpm setup:ai-tools
# or: node ai-tools/scripts/setup-ai-tools.mjs
```

If the project's setup script is symlinked-style, this is a no-op; for copy-style it refreshes the per-vendor copies.

### 9. Final report

Echo back, in this order:

1. **Updated** — skills that got overwritten (with file paths).
2. **Skipped by user** — skills the user kept their version of (with reason if given).
3. **Needs regeneration** — `templated` / `stack-derived` skills the user should refresh by re-running [vinta-derive-skills](../vinta-derive-skills/SKILL.md).
4. **User-authored (untouched)** — for transparency.

If anything was updated, suggest the next steps the user should take: review the changes (`git diff ai-tools/`), commit, optionally re-run vendor setup.

## Read-only mode

If the user asks for a "preview" / "what would change" / "dry-run" — perform steps 1–5 only. Stop before step 6. Print the proposal and exit. The user can re-invoke without `--dry-run` semantics when ready.

When invoked without an explicit dry-run intent, still default to **showing all diffs first, then asking**. Never start with destructive actions.

## Pitfalls

- **Overwriting hand-edited foundation skills.** Some teams tweak the foundation `SKILL.md` after bootstrap (project-specific examples). The byte-diff will flag those as `outdated` even though the upstream hasn't moved. The per-skill confirmation gate is what protects them — but make sure the diff is *visible* before asking, so the user notices their edit is about to be lost.
- **Skipping the explicit confirmation.** Bulk "apply all" prompts feel efficient but defeat the safety property. One question per outdated skill.
- **Trying to diff templated skills.** `implement-plan` and stack-derived skills contain interpolated values. A byte-diff vs the template will be huge and useless. Classify them first; never diff.
- **Forgetting the per-vendor refresh.** The user runs this skill, sees "updated 3 files", opens Cursor, and Cursor still shows the old content because its `.cursor/skills/` is a copy that wasn't refreshed. Step 8 fixes this — don't skip it.
- **Hard-coded clone path.** Don't assume `~/code/vinta-ai-workflows`. Resolve the clone via the symlink / marker / explicit ask path described in "Locating the source".
- **Touching skills not under `ai-tools/skills/`.** This skill operates only on the canonical skill source directory. The vendor-specific copies under `.claude/skills/`, `.cursor/skills/`, etc. are derived — they get refreshed by step 8, not by direct writes here.

## Verification

1. **Up-to-date project**: run the skill; expected outcome — every project skill in `up-to-date` bucket, no questions asked, exit cleanly.
2. **Drift case**: edit one foundation skill in this repo, run the skill on a project that has the old version; expected — that skill flagged `outdated`, diff displayed, user prompted, accept → file updated, decline → file unchanged.
3. **User-authored skill present**: project has `ai-tools/skills/my-thing/SKILL.md` with no upstream source; expected — bucket = `user-authored`, no prompt, no write.
4. **Templated skill drift**: `implement-plan` differs from template; expected — bucket = `templated`, prompt offers re-run hand-off, never auto-overwrites.
5. **No `ai-tools/skills/`**: expected — stop early, route to [vinta-bootstrap-ai-tools](../vinta-bootstrap-ai-tools/SKILL.md).
