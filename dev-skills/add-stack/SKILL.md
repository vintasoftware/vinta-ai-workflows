---
name: add-stack
description: Author a new stack template under `skills/vinta-bootstrap-ai-tools/resources/stacks/<stack>/notes.md` and wire it through the orchestrator's stack table + `vinta-analyze-codebase` detection signals + (when needed) the schema's `stacks` examples + CHANGELOG. Stack notes describe **categories** (skill + agent), **detection signals**, and **placeholders** the orchestrator asks the user about — they do NOT ship ready-made content. Use when adding support for a new framework / runtime that the bootstrap flow should recognize (e.g. SvelteKit, Phoenix, Rails, tRPC monorepo).
---

# Add a stack

`vinta-analyze-codebase` detects stacks via signals (deps, files, layout). When a stack matches, `vinta-bootstrap-ai-tools` echoes "we detected stack X — do you have skill / agent templates for these categories?". The team supplies content; this repo ships the *catalogue* of categories, not the content.

Adding a new stack = author one notes file + update three places that read it.

## Step 0 — Confirm scope (NON-NEGOTIABLE)

Use `AskUserQuestion`:

- **Is this a real stack the team encounters?** Pick `Yes — adding`, `Maybe — explore first`, `No — abort`.
  *Don't seed speculative stacks. Notes that no project ever matches are dead weight.*
- **Multi-tenancy variant?** `Yes — has a multi-tenant flavour`, `No — single-tenant only`.
  *Drives whether the notes call out tenant scoping signals + tenant-column placeholders.*

If `Maybe — explore first`: surface a 5-line summary of what would be in the notes file based on what's known, then re-ask.

## Step 1 — Interview the user

Open prose:

1. **Detection signals.** What deps / files / dir layout uniquely identify this stack? Be specific — `package.json` containing `next` is detection; "uses React" is not.
2. **Skill categories typically maintained by teams using this stack.** What recurring authoring tasks need a skill — model creation, route handler, deployment, data import, etc. List 3–10. **Don't include skill bodies — just category names + one-line "what's in it".**
3. **Agent categories.** What specialist sub-agents make sense — `migration-author`, `deploy-author`, `test-fixer`. Usually 0–2.
4. **Placeholders the orchestrator should ask about** when the user supplies templates — apps directory, test command, lint command, hot tables, deploy command, framework-specific paths.
5. **When this stack doesn't apply cleanly.** Edge cases where signals match but the team's workflow is different enough that the categories don't fit (read-only API, no DB, async-first variant).

## Step 2 — Author `notes.md`

Path: `skills/vinta-bootstrap-ai-tools/resources/stacks/<stack-name>/notes.md`.

Use the existing notes files as shape references:

- [django/notes.md](../../skills/vinta-bootstrap-ai-tools/resources/stacks/django/notes.md)
- [medplum/notes.md](../../skills/vinta-bootstrap-ai-tools/resources/stacks/medplum/notes.md)
- [nextjs-app-router/notes.md](../../skills/vinta-bootstrap-ai-tools/resources/stacks/nextjs-app-router/notes.md)
- [python-package/notes.md](../../skills/vinta-bootstrap-ai-tools/resources/stacks/python-package/notes.md)
- [typescript-monorepo/notes.md](../../skills/vinta-bootstrap-ai-tools/resources/stacks/typescript-monorepo/notes.md)

Required sections:

```markdown
# <Stack name>

## Detection signals

Repo matches when:
- <signal 1 — concrete dep / file / layout>
- <signal 2>
- ...

<Multi-tenancy variant signals if applicable.>

## Skill categories typically needed
- **<Category-name>** — one-line description of what the skill covers.
- ...

## Agent categories typically needed
- **<Agent-name>** — one-line description of what the agent specializes in.
- (Empty if no specialists needed for this stack.)

## Placeholders the orchestrator should ask about
- <Placeholder name + example values>
- ...

## When this stack doesn't apply cleanly
- <Edge case 1>
- <Edge case 2>
```

**Rule: no skill bodies, no agent bodies, no SKILL.md files inside the stack dir.** Content is user-supplied at bootstrap time. The notes describe categories — not content. Violating this is a 3-month-later footgun (notes drift from what teams actually need; agents generate skills against stale assumptions). The AGENTS.md pitfall list calls this out specifically.

## Step 3 — Wire `vinta-bootstrap-ai-tools`

Edit [skills/vinta-bootstrap-ai-tools/SKILL.md](../../skills/vinta-bootstrap-ai-tools/SKILL.md), section "Stack templates — detection only, content is user-supplied":

Add a row to the table:

```markdown
| <stack> | <detection signals one-liner> | <one-liner of categories> |
```

Don't bloat the table — one row, ~120 chars max. Detail lives in `notes.md`.

## Step 4 — Wire `vinta-analyze-codebase`

Edit [skills/vinta-analyze-codebase/SKILL.md](../../skills/vinta-analyze-codebase/SKILL.md)'s **Frameworks (from dependencies)** scan (or wherever stack detection lives — grep for the existing stack names to find the right block).

Add detection logic that flips the inventory's `stacks: [<stack>]` array when the signals match. If the new stack reuses an existing dep / signal, link the existing detection rather than duplicating.

If the stack is multi-tenant-flavoured, follow the existing convention: a single stack name in `stacks` plus a separate boolean / sub-field in inventory.

## Step 5 — Schema (rare)

The schema's `stacks: array<string>` field is open — no enum is enforced ([schemas/vinta-ai-workflows-config.v1.schema.json](../../schemas/vinta-ai-workflows-config.v1.schema.json)). New stack name lands in `stacks: [<stack>]` without a schema bump.

If the new stack introduces a new per-stack config block (rare — only `systematic-debugging` does this today, and it's per-skill not per-stack), add it under `skills.<config-key>` with `additionalProperties: false`. Otherwise: skip this step.

## Step 6 — CHANGELOG entry

Under `### Added`. Use the existing entries for `medplum`, `django`, `nextjs-app-router` as shape reference (none exist yet for stacks specifically — match the systematic-debugging entry pattern). Mention:

- New `notes.md` path.
- New row in the bootstrap stack table.
- `vinta-analyze-codebase` detection signals added.
- Multi-tenancy variant included or not.

## Verification

1. `notes.md` exists at the new path; sections match the required shape.
2. No SKILL.md, no `*.yaml` agent file under the stack dir. (`find skills/vinta-bootstrap-ai-tools/resources/stacks/<stack> -name '*.md' | wc -l` = 1.)
3. Detection signals listed in `notes.md` match what `vinta-analyze-codebase` looks for.
4. Stack table in bootstrap SKILL.md has the new row.
5. `grep -rn "<stack>" skills CHANGELOG.md` finds: notes file, bootstrap table row, analyze-codebase block, CHANGELOG entry. Minimum 4 hits.

## Pitfalls

- **Bundling skill / agent content under the stack dir.** Forbidden. Notes only. The team's content lives in their template library, not in this repo.
- **Detection signals that match too broadly.** "Has React" matches half the JS world. Use specific deps + layout signals.
- **Forgetting to update `vinta-analyze-codebase`.** The orchestrator never sees the new stack because the inventory never lists it. Catch via Step 4.
- **Listing skill categories with bodies "for inspiration".** Tempting; don't. The category name + one-liner is the contract.
- **Multi-tenancy assumed.** Many stacks have single-tenant variants. Surface multi-tenancy as a *signal*, not as a required property.
