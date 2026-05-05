---
name: vinta-migrate-plans-specs
description: Find existing implementation plans and feature specs scattered across a project (`docs/`, `specs/`, `plans/`, root markdown, branch-named files, etc.) and migrate them to the canonical layout `ai-plans/YYYY-MM-DD-{FEATURE_NAME}_{PLAN|SPEC}.md`. Reads each candidate, proposes a target path (date + feature name + classification PLAN vs SPEC), shows the rename diff, and only renames after the user explicitly accepts each one. Run as step 6 of [vinta-bootstrap-ai-tools](../vinta-bootstrap-ai-tools/SKILL.md), or standalone any time afterwards. Read-only by default — every move is gated on per-file approval.
---

# Migrate plans + specs

The Vinta convention: every implementation plan and every feature spec lives under `ai-plans/` at the repo root, named:

```
ai-plans/YYYY-MM-DD-{FEATURE_NAME}_{PLAN|SPEC}.md
```

- `YYYY-MM-DD` — date the doc was authored (use git log first-commit date when migrating, fall back to file mtime, fall back to ask).
- `FEATURE_NAME` — `UPPERCASE_WITH_UNDERSCORES`. Same prefix shared by a spec and its plan so `ls ai-plans/` groups pairs.
- `_PLAN` or `_SPEC` — classification. Spec describes *what + why*; plan describes *how + when*.

Real-world repos accumulate these docs in many other shapes:

| Shape | Examples |
|---|---|
| Per-feature folders | `docs/features/<name>/spec.md`, `docs/features/<name>/plan.md` |
| Flat docs/ | `docs/SPEC-checkout.md`, `docs/PLAN-2025-checkout.md` |
| Project root | `IMPLEMENTATION_PLAN.md`, `SPEC.md`, `ROADMAP.md` |
| Branch-named | `feature/checkout/spec.md`, `feat-checkout-plan.md` |
| Date-prefixed but off-format | `2025-11-checkout-plan.md`, `2025_11_checkout_spec.md` |
| ADR-style | `docs/adr/0007-checkout.md` (sometimes spec-shaped, sometimes not) |
| Already in `ai-plans/` but off-format | `ai-plans/checkout-plan.md` (no date), `ai-plans/2025-11-CHECKOUT_IMPLEMENTATION_PLAN.md` (legacy `_IMPLEMENTATION_PLAN`) |

This skill normalizes them. Read-only until the user accepts a move.

## Inputs

- Path to the project being migrated (default: cwd).
- Optional: list of additional dirs/glob patterns to scan (the user may keep specs somewhere unconventional).

## Output

- A migration proposal listing each candidate doc with: current path, classification (`PLAN` / `SPEC` / `unclear — ask`), proposed target path, source of date.
- For each candidate the user accepts: `git mv <old> ai-plans/<new>`. Inbound references inside the repo's markdown updated where possible (best-effort grep + rewrite, with diff shown).
- A summary report at the end: moved, skipped, ambiguous (user deferred), and a list of follow-ups.

## Steps

### 1. Prerequisite check

`<project>` is a git repo. If not → fall back to plain `mv`, but warn the user that history won't follow the rename. `AskUserQuestion`: `Continue without git mv`, `Stop and init git first`.

If `ai-plans/` already exists with files, that's fine — the skill normalizes those too if they're off-format.

### 2. Discover candidates

Search the repo for plan/spec-shaped markdown. Prioritize signal over recall — false positives waste user time.

**Strong signals** (always include):

- Filename matches `*spec*.md`, `*plan*.md`, `*roadmap*.md` (case-insensitive).
- Filename matches `IMPLEMENTATION_PLAN.md`, `SPEC.md`, `RFC.md`, `DESIGN_DOC.md`.
- Path contains `/specs/`, `/plans/`, `/ai-plans/`, `/rfcs/`, `/design-docs/`.
- File header (first H1) contains "Spec", "Specification", "Implementation Plan", "RFC", "Design Doc", "Roadmap".

**Weak signals** (consider but interview):

- Files under `docs/features/<name>/` or `docs/proposals/`.
- ADR files (`docs/adr/NNNN-*.md`) — usually decision records, not specs, but sometimes a team mixes them.

**Always exclude**:

- `node_modules/`, `vendor/`, `dist/`, `build/`, `.git/`, `.next/`, build outputs.
- Generated docs (`docs/api/`, `docs/generated/`).
- Files already at the canonical path *and* canonical format — they're done.

Output a candidate list. If empty → report "no plan/spec docs found" and stop. If the user expected something to be there, ask them where to look.

### 3. Classify each candidate (PLAN vs SPEC)

For each candidate, decide its bucket. Heuristics:

| Signal | Likely class |
|---|---|
| Filename / heading contains "spec" / "specification" / "RFC" / "design doc" | `SPEC` |
| Filename / heading contains "plan" / "implementation plan" / "roadmap" / "phases" | `PLAN` |
| Body has phased structure (Phase 1, Phase 2, sequential todos) | `PLAN` |
| Body has acceptance criteria / use cases / hypotheses | `SPEC` |
| Both signals strongly present | `unclear — ask` |
| Neither | `unclear — ask` |

Don't guess on `unclear — ask`. Surface it to the user with a snippet of the file and let them pick.

### 4. Derive the date prefix

For each candidate, prefer in this order:

1. **Date already in the filename** that obviously corresponds to the doc (e.g. `2025-11-15-checkout-plan.md` → `2025-11-15`). Normalize to `YYYY-MM-DD`.
2. **Date in the doc body** (e.g. `Date: 2025-11-15`, `Authored: ...` block).
3. **Git log first-commit date for the file** (`git log --diff-filter=A --follow --format=%aI -- <path> | tail -1`).
4. **File mtime** as a last resort.
5. **Ask the user** if the result still looks wrong (e.g. mtime is today because the file got touched by a `find -exec` last week).

Always show the chosen date + its source in the proposal so the user can override before accepting the move.

### 5. Derive the feature name

Strip dates, classification words, and extensions from the filename, then convert to `UPPERCASE_WITH_UNDERSCORES`.

| Input | After strip | Final |
|---|---|---|
| `2025-11-15-checkout-plan.md` | `checkout` | `CHECKOUT` |
| `docs/features/checkout-flow/spec.md` | `checkout-flow` (from parent dir) | `CHECKOUT_FLOW` |
| `IMPLEMENTATION_PLAN.md` | (filename has no feature) → ask user | `<asked>` |
| `feat-shipment-attributes-spec.md` | `shipment-attributes` | `SHIPMENT_ATTRIBUTES` |
| `2026-04-23-BOOKMARKS_IMPLEMENTATION_PLAN.md` | `BOOKMARKS` | `BOOKMARKS` |

If the source is a folder like `docs/features/checkout/spec.md` and a sibling `plan.md` exists, **lock both files to the same `FEATURE_NAME`** so the renamed pair groups in `ls`.

### 6. Build the proposal

Produce a per-candidate report. Group by status. Example:

```
ai-plans migration proposal — 7 candidates
==========================================

CLEAR (proposed: git mv to ai-plans/)
  docs/features/checkout/spec.md
    → ai-plans/2025-11-15-CHECKOUT_SPEC.md
    date: 2025-11-15 (from git log first-commit)

  docs/features/checkout/plan.md
    → ai-plans/2025-11-15-CHECKOUT_PLAN.md
    date: 2025-11-15 (paired with spec)

  IMPLEMENTATION_PLAN.md
    → ai-plans/2026-02-04-WAREHOUSE_AUDIT_PLAN.md
    date: 2026-02-04 (from doc body "Date: 2026-02-04")
    feature name: asked user (filename had none)

ALREADY CANONICAL — only filename normalization
  ai-plans/2026-04-23-BOOKMARKS_IMPLEMENTATION_PLAN.md
    → ai-plans/2026-04-23-BOOKMARKS_PLAN.md
    note: legacy `_IMPLEMENTATION_PLAN` suffix → `_PLAN`

UNCLEAR — need user input
  docs/adr/0007-checkout.md
    body has hypothesis + acceptance criteria but is in adr/ folder.
    classify as SPEC, PLAN, or skip?

UNTOUCHED (no move proposed)
  docs/api/openapi.md (api docs, excluded)
```

For each "CLEAR" entry, also list any inbound references discovered by `grep -r "<old-path>" .` so the user knows what else will need to be updated when the file moves.

### 7. Per-candidate confirmation

**Critical: never move silently.**

For each `CLEAR` candidate, ask the user explicitly. Use `AskUserQuestion` with options:

- `Apply` — `git mv <old> <new>`; rewrite inbound references.
- `Skip` — leave the file in place.
- `Edit proposal` — let the user override the proposed date / feature name / classification, then re-ask.

For each `UNCLEAR` candidate, the question is upstream:

- `Classify as SPEC, then propose target` — flips to `CLEAR` flow.
- `Classify as PLAN, then propose target` — same.
- `Skip — neither` — leave alone.
- `Show full file body` — re-display before deciding.

Do **not** batch under a single "apply all?" prompt. Each move is a separate decision so the user can keep edge cases unchanged. After all decisions, optionally offer a `Apply remaining clear ones` sweep — but only after every candidate has been individually classified and previewed.

### 8. Apply approved moves

For each accepted candidate:

1. `mkdir -p ai-plans` (idempotent).
2. `git mv <old> ai-plans/<new>` (or plain `mv` if not in a git repo).
3. Search the repo for inbound references (`grep -rln "<old-relative-path>" --exclude-dir={node_modules,.git,dist,build}`). For each hit:
   - Rewrite the path text to the new path.
   - Show the rewrite diff inline; ask once whether to apply (default `yes`, `no`, `edit`).
4. Log: `[moved] <old> → ai-plans/<new>`.

If the source file had a sidecar (e.g. `docs/features/checkout/diagram.png` next to the spec): ask the user whether to move it alongside (sub-folder `ai-plans/2025-11-15-CHECKOUT/`) or leave in place. Default: leave in place — the canonical layout is flat markdown.

### 9. Final report

Echo back, in this order:

1. **Moved** — `<old> → ai-plans/<new>` per file. Note inbound-reference rewrites count.
2. **Skipped by user** — files left in place (with reason if the user gave one).
3. **Unclear, deferred** — files the user said `Show body / Skip — neither` on. Surface them as TODO so they don't get lost.
4. **Already canonical** — listed for transparency.

If `git status` shows the rename, suggest the next steps:

```bash
git diff --stat
git commit -m "Migrate plans/specs to ai-plans/ canonical layout"
```

After moves are committed, point the user at the foundation skills (`create-spec`, `plan-feature`) so future docs land in the canonical layout from the start. If the project's foundation skill bodies still reference a non-`ai-plans/` path or the legacy `_IMPLEMENTATION_PLAN` suffix, flag it as a follow-up to align them.

## Read-only mode

If the user asks for a "preview" / "dry-run" / "what would change" — perform steps 1–6 only. Stop before step 7. Print the proposal and exit. Re-invoke without dry-run when ready.

When invoked without explicit dry-run intent, still default to **showing all proposals first, then asking per file**. Never start with destructive actions.

## Pitfalls

- **Mass-renaming based on filename heuristics alone.** A file called `auth-spec.md` might be auto-generated API spec (OpenAPI export). Read the body header before classifying. Strong signals + body shape together — never one alone.
- **Wrong date prefix.** mtime is the worst source — anything that touched the file (a sweep, a format-on-save) clobbers it. Prefer git log first-commit date. Always show the source so the user can override.
- **Breaking inbound references.** Wikis, READMEs, prior PRs, and CHANGELOG entries reference plan/spec paths. Run grep for inbound refs *before* moving, show the user what else will change. Apply rewrites in the same batch as the move.
- **Splitting a paired spec + plan.** When a folder has both, lock the `FEATURE_NAME` so they share the prefix. Don't let the user accidentally rename `spec.md` → `CHECKOUT_FLOW_SPEC.md` and `plan.md` → `CHECKOUT_PLAN.md` (different names break grouping).
- **Touching ADRs that are decision records, not specs.** `docs/adr/` is its own genre. Default to skip; ask the user before reclassifying.
- **Renaming inside a feature branch.** Concurrent branches that haven't rebased will hit messy conflicts on next merge. Surface this risk to the user before applying — they may want to coordinate or do migration on `main` first.
- **Generated docs.** OpenAPI, Storybook MDX, Typedoc output, etc. — exclude by path, don't classify.
- **Stale `_IMPLEMENTATION_PLAN` suffix.** Some Vinta projects historically used `_IMPLEMENTATION_PLAN.md`. The new standard is `_PLAN.md`. Migrate during this run; flag the foundation skill bodies (project's `ai-tools/skills/plan-feature/SKILL.md`) for alignment if they still mention the old suffix.

## Verification

1. **Empty project**: no candidates found; skill exits cleanly with "no plan/spec docs found". `ai-plans/` not created.
2. **Single clear plan**: one `IMPLEMENTATION_PLAN.md` at root → proposal shows 1 candidate, classification = PLAN, date from git log; user accepts → file moved with `git mv`, inbound refs (if any) rewritten.
3. **Paired spec + plan in folder**: `docs/features/checkout/{spec,plan}.md` → both proposed under same `FEATURE_NAME=CHECKOUT`, dates synced where one's date is missing.
4. **Already canonical**: no diffs proposed; report lists them as `Already canonical`.
5. **Legacy suffix**: `ai-plans/2026-04-23-BOOKMARKS_IMPLEMENTATION_PLAN.md` → proposed rename to `_PLAN.md`; user accepts → renamed; inbound refs rewritten.
6. **Unclear file**: ADR-style file flagged `unclear`; user picks `Skip`; file left untouched and surfaced in final report.
7. **Dry-run**: user asks for preview → proposal printed, no `git mv` calls executed, exit clean.
