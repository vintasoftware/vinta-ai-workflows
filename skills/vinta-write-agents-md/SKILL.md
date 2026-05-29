---
name: vinta-write-agents-md
description: Synthesize `ai-tools/AGENTS.md` from the inventory produced by [vinta-analyze-codebase](../vinta-analyze-codebase/SKILL.md) plus a focused interview for what the analysis can't see. Used by [vinta-bootstrap-ai-tools](../vinta-bootstrap-ai-tools/SKILL.md) as step 2; also runnable standalone to refresh AGENTS.md after a major refactor. Project-agnostic — sections are the same shape across stacks, content adapts. Symlinked into root `AGENTS.md` so Claude Code, Cursor, Codex, VS Code Copilot all read it natively.
---

# Write AGENTS.md

The canonical project-conventions document. Read by every AI tool. Single source of truth — every other agent / skill defers to it for "how this project does X".

## Output

`ai-tools/AGENTS.md`. The setup script symlinks `AGENTS.md` at root and `.github/copilot-instructions.md` to it.

## Inputs

1. The structured inventory from [vinta-analyze-codebase](../vinta-analyze-codebase/SKILL.md). Pay attention to `existing_ai_artifacts.instructions` — every found instruction doc must be folded in, replaced, or referenced per the [Existing AI artifacts (per-artifact disposition)](../vinta-bootstrap-ai-tools/SKILL.md#e-existing-ai-artifacts-per-artifact-disposition) decision captured in the bootstrap interview.
2. Any existing `AGENTS.md` / `CLAUDE.md` / `CONTRIBUTING.md` / `README.md` / `.cursorrules` / `.github/copilot-instructions.md` content — read in full. Behavior depends on the user's disposition:
   - **Merge into new AGENTS.md** — extract every still-accurate fact (commands, paths, naming rules, multi-tenancy notes, env vars, deploy steps) and weave into the canonical sections below. Don't lose content silently — if a paragraph doesn't fit any section, surface it for the user to place or drop.
   - **Keep as-is, link from AGENTS.md** — leave the file untouched; add a `## See also` reference to it from the new AGENTS.md and copy only the high-level pointer (one sentence + link).
   - **Replace from scratch** — discard the old content; draft fresh from inventory + interview. Note the discarded files in the run summary so the user can verify nothing important was lost.
3. Interview answers (Step 0 below).

## Step 0 — Interview before drafting

The analysis tells you the *shape* of the repo. The interview tells you *intent* — conventions humans hold but don't surface in code. Use `AskUserQuestion` for finite-choice; iterate plain prose for narrative.

### A. Project framing

1. **What does this project do?** One paragraph. Inferred from README is OK; confirm with user.
2. **Primary user(s)?** Internal team, external customers, both, integration partners.
3. **Maturity stage?** Greenfield, MVP, post-launch, mature.

### B. Conventions the analysis can't see

1. **Code-style nuances Biome / ruff / etc don't enforce** — naming, file layout, import order conventions. Free-form list.
2. **"Always do X" / "never do Y" rules** the team holds. e.g. "always inject deps with defaults", "never use `let` unless reassignment", "all FHIR resources stamp `meta.account`".
3. **Architecture patterns** — separation of concerns, where business logic lives, error-handling style.
4. **Testing philosophy** — unit vs integration ratio, mock vs real backends, test data conventions.
5. **Multi-tenancy details** if applicable — how is tenant scope enforced at every layer (DB / API / UI / background jobs).

### C. Deploy + env model

1. **Environments named.** `staging`, `production`, `preview-*`, `dev-<handle>`, etc. Confirm what `vinta-analyze-codebase` extracted.
2. **Deploy gates** — manual approval, soak window, automated promotion?
3. **Manual deploy steps** that aren't in CI — `npx medplum post`, `pnpm bots:deploy`, `kubectl apply`, etc.
4. **Per-env value mechanism** — `.env` files, secret managers, deploy-time injection, project-wide secrets vs per-env.

### D. PR + commit conventions

1. **Branch naming** — `feature/*`, `feat/*`, `<ticket>-<slug>`, free-form.
2. **PR who-creates-it** — agents create PRs, or only branches and humans open PRs?
3. **Commit message style** — Conventional Commits, short imperative, free-form.
4. **AI co-author trailers in commits** — allowed, forbidden, undefined. Most repos: forbidden.

### E. Out of scope (non-goals)

1. **Things AGENTS.md should explicitly NOT cover** — internal API tokens, customer data, security secrets that don't belong in a public-ish doc.
2. **Topics handled elsewhere** — if there's a `docs/ARCHITECTURE.md` or `docs/RBAC.md` already, reference it instead of duplicating.

After interview: read back load-bearing decisions in one paragraph; final `AskUserQuestion` `Looks good` / `Some corrections` / `More to clarify` / `Stop, rethink`. Loop until `Looks good`.

## Structure

The skeleton is fixed. Sections that don't apply: skip with a one-line "n/a — single-tenant" note rather than omitting silently.

```markdown
# {Project Name}

{One-paragraph what + why, from the **Project framing** interview group.}

## Project Overview

{Apps, libs, services list — one bullet per. Pulled from analyze-codebase monorepo.apps + .packages.}

{Key data backend / framework callout — e.g. "All data is stored as FHIR resources in Medplum — there is no traditional database." Or "Postgres 17 with psqlextra LIST partitioning by tenant_id". Or "stateless API; no persistent storage."}

## Tech Stack

- **{Framework}** {version} — {one-line role}
- **{Build tool}** ({purpose}), **{Test runner}** ({purpose}), **{Package manager}** ({version})
- **{Lint+format}** — {note any deviation from defaults}
- **{Deploy target}** — {note manual steps}
- ... etc

## Common Commands

```bash
{install}
{dev}
{build}
{test_unit}
{test_e2e}     # if applicable
{lint}
{format}
{typecheck}    # if separate from build
{deploy_*}     # if commands surface in package.json / Makefile
```

## Code Style

{Pulled from analysis + the **Conventions the analysis can't see** interview group. Bullet list of enforced + cultural rules.}

## Architecture

### {Subsystem 1, e.g. "FHIR Workflow Engine" / "Data Pipeline" / "Auth"}
{Describe at the level a new contributor needs. Reference files / dirs.}

### {Subsystem 2, e.g. "Access Control" / "Multi-tenancy"}
{...}

### Routing / Page structure / Service shape (whichever applies)
{...}

### Testing
{What runner, where tests live, mocking conventions, fixture patterns.}

## {Multi-tenancy / Tenant Model — only if applicable}

{How tenants are scoped at every layer. Pull from the **Conventions the analysis can't see → Multi-tenancy details** interview answer + analyze-codebase env_model.multi_tenancy.}

## Environment Variables

{Per-app or per-service code fence with var names — no values. Pull from analyze-codebase env_model.example_files.}

**{App 1}** (`.env`):
```
VAR_ONE
VAR_TWO
...
```

**{App 2}** (`.env`):
```
...
```

## Error / Exception Tracking

{If Sentry / Bugsnag / Datadog detected: one section with init pattern + tracing examples. Else: omit.}

## Deployment

| Environment | URL / target | Trigger |
|---|---|---|
| Staging | ... | ... |
| Production | ... | ... |

{Manual deploy steps if any: bullet list.}

## Key Documentation

{Bullets pointing at docs/<file>.md for deep dives the AGENTS.md doesn't replicate.}
```

## Rules

- **Don't replicate doc content already in `docs/`.** Reference it. AGENTS.md is the orientation map, not the encyclopedia.
- **Be specific.** "Use bulk_create" not "use efficient ORM patterns". "Stamp meta.account on every FHIR resource" not "respect tenancy".
- **Cite paths.** Every "X lives in Y" claim names the file or dir. Future readers grep for the filename.
- **Plain English.** Read by humans + agents + new hires. Acronyms expanded on first use.
- **No code beyond what's necessary.** If a 5-line snippet captures the convention, use it. Don't paste 50 lines of context.
- **No marketing language.** "Robust", "seamless", "delightful" — strike. State what it does.
- **No `§N` shorthand for cross-references.** When AGENTS.md points at other docs, name the section (`See the **Multi-tenancy** section in docs/ARCHITECTURE.md`). `§4.2` is unreadable for humans and breaks when section numbering shifts.

## What NOT to put in AGENTS.md

- Customer-specific business rules ("this clinic gets X discount") — too volatile.
- Secrets, tokens, real env values.
- Detailed RBAC matrices — link to `docs/RBAC.md` if it exists; if not, derive-skills creates `manage-access-policy/SKILL.md` to handle it.
- Architecture deep-dives — those live in `docs/ARCHITECTURE.md` or per-subsystem docs.
- Incident postmortems / change history — git log + a CHANGELOG handle that.

## Examples to study before writing

If the source repo (the one defining `vinta-bootstrap-ai-tools`) has a real `AGENTS.md`, read it first as a worked example. Vinta's lives at `ai-tools/AGENTS.md` in the bootstrap-defining repo. Note its sectioning + density before writing the target's.

## Verification

After writing:

1. Re-read the document end-to-end — does it answer "what is this codebase, how do I work in it, what conventions matter"?
2. Every claim cites a file or convention source.
3. Section headings match the skeleton above (or skipped sections are explicit).
4. Length: 200–400 lines for a typical project. Shorter = probably under-specified. Longer = probably duplicating docs/ content.
5. `pnpm setup:ai-tools` (or whichever vendors selected) re-runs cleanly after the file is in place — confirms the symlinks point at it.

## Pitfalls

- **Letting analyze-codebase output dictate the prose.** The inventory is structured data; AGENTS.md is human-readable narrative. Translate, don't paste.
- **Writing the convention "Use X library" when the project actually uses Y.** Re-read direct deps in `package.json` / `pyproject.toml` before each section.
- **Forgetting commit / PR conventions.** The **PR + commit conventions** interview group is short and easy to skip; don't. The implement-plan / fixer agents need this.
- **Assuming multi-tenant when single-tenant.** Re-read evidence from the **Conventions the analysis can't see → Multi-tenancy details** answer + analyze-codebase env_model.multi_tenancy. If absent, mark the section "n/a — single-tenant".
