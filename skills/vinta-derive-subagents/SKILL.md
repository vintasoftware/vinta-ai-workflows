---
name: vinta-derive-subagents
description: Author `ai-tools/agents/*.yaml` for the target project. Always emits the foundation trio (`implementer`, `reviewer`, `fixer`); adds stack-specific specialists (e.g. `deploy-author` for Medplum, `migration-author` for Django) when the inventory from [vinta-analyze-codebase](../vinta-analyze-codebase/SKILL.md) matches a stack template under [bootstrap-ai-tools/resources/stacks/](../vinta-bootstrap-ai-tools/resources/stacks/). Each YAML follows the schema documented in `ai-tools/agents/README.md` so the setup script can generate per-vendor copies.
---

# Derive sub-agents

Author the canonical YAML sources for the target project's sub-agents. Setup script reads these later and emits per-vendor variants (Claude `.md`, Cursor `.md`, Copilot `.agent.md`, Codex `.toml`).

## Output

`ai-tools/agents/<name>.yaml` — one per sub-agent. Plus `ai-tools/agents/README.md` (schema doc) if not already present (copy from the bootstrap-defining repo).

## Inputs

1. Inventory from [vinta-analyze-codebase](../vinta-analyze-codebase/SKILL.md), specifically `existing_ai_artifacts.agents` — every sub-agent file already in the repo with its name, description, classification (`foundation-shape` / `stack-specialist` / `project-custom`).
2. AGENTS.md content from [vinta-write-agents-md](../vinta-write-agents-md/SKILL.md) (so agent prompts can reference real conventions).
3. Step 0 interview decisions from [vinta-bootstrap-ai-tools](../vinta-bootstrap-ai-tools/SKILL.md) — including the [Existing AI artifacts](../vinta-bootstrap-ai-tools/SKILL.md#e-existing-ai-artifacts-per-artifact-disposition) **per-agent disposition** (migrate / keep / drop / replace).
4. Stack templates under [bootstrap-ai-tools/resources/stacks/<stack>/agents/](../vinta-bootstrap-ai-tools/resources/stacks/) for matched stacks.

## Reconcile against existing agents (do this FIRST)

Before drafting any new YAML, walk through every entry in `existing_ai_artifacts.agents` and apply the disposition the user picked in the bootstrap interview's [Existing AI artifacts](../vinta-bootstrap-ai-tools/SKILL.md#e-existing-ai-artifacts-per-artifact-disposition) group:

- **Migrate to `ai-tools/agents/<name>.yaml`** — convert vendor format → canonical YAML. Preserve `name` + `description` + body. Map vendor-specific fields:
  - Claude `tools:` (CSV string) → YAML `claude-tools:` or `overrides.claude.tools` (let `setup-ai-tools.mjs` derive defaults from `access`).
  - Cursor `readonly: true|false` → `access: read-only | read-write`.
  - Codex `sandbox_mode` → `access` mapping (`read-only` → `read-only`, `workspace-write` → `read-write`); preserve other Codex-only fields under `overrides.codex`.
  - Copilot `tools:` array → `overrides.copilot.tools`.
  - Move the body content into the canonical YAML `body:` literal block.
- **Keep in current vendor path, don't touch** — don't emit a canonical YAML for it. AGENTS.md may reference it; `setup-ai-tools.mjs` won't manage it.
- **Drop** — log the removal; don't emit anything.
- **Replace with Vinta foundation version** (foundation-shape only — `implementer` / `reviewer` / `fixer`) — discard the existing body, emit the canonical foundation trio body below.

For the foundation trio: only emit a fresh canonical version when none exists OR the user said `Replace`. If the user said `Migrate` or `Keep` for an existing `implementer.yaml`, **do not overwrite**.

After this reconciliation, continue with the foundation trio + stack specialists for any name still missing.

## Foundation trio (always emit)

Every project gets these three. Bodies are project-tailored; structure is stable.

### `implementer.yaml`

Default coder for one phase of an `ai-plans/` plan. Reads AGENTS.md + plan body, executes Changes/Tests/Acceptance, runs inner loop + outer gate, reports back. Never branches, pushes, or opens PRs (orchestrator owns git remotes). Never adds AI co-author trailers (when policy forbids).

YAML shape — full contract at [`schemas/sub-agent.v1.schema.json`](../../schemas/sub-agent.v1.schema.json). Required fields: `schema_version`, `name`, `description`, `access`, `body`. Authoring tip: prepend `# yaml-language-server: $schema=./node_modules/vinta-ai-workflows/schemas/sub-agent.v1.schema.json` for IDE validation.

```yaml
# yaml-language-server: $schema=./node_modules/vinta-ai-workflows/schemas/sub-agent.v1.schema.json
schema_version: 1
name: implementer
description: |
  One-line role. Followed by stack/conventions referenced (React + TS + Medplum, or Django + DRF, etc).
  Conditions for use, outputs, what it never does.
access: read-write
body: |
  # Implementer
  
  Sections (adapt to project):
  - Before writing (read AGENTS.md, plan body, neighbor code).
  - Conventions (pulled from AGENTS.md — code style, separation of concerns, tenancy, framework rules).
  - Loop (inner: lint → scoped tests → typecheck/build; outer: full build + full tests + e2e for UI).
  - When you need a human decision (see "Needs-input contract" below).
  - Report shape (status SUCCESS | FAILURE | NEEDS_INPUT).
  - Will not (branch, push, PR, co-author trailer, skip outer gate, ...).
```

The body **must reference real commands** for this project (`pnpm test:patient`, `make all-tests`, `pytest tests/integration/`, etc — pulled from `inventory.commands`). Don't generic-ify.

### `reviewer.yaml`

Adversarial reviewer for the reviews the team asks for by hand. Reads phase body + diff + AGENTS.md + relevant SKILL.md. Outputs BLOCKER / SHOULD-FIX / NIT findings with file:line. Read-only — `access: read-only`.

The plan-execution review does not spawn this type. `review-phase` runs the `thermo-nuclear-review-loop` skill, whose reviewer is a general-purpose sub-agent applying one standard (the project's `REVIEW.md`, or the loop's Review Standard); an agent body with review rules of its own would give it two. Keep the body's "Look for" sweeps project-specific all the same: they are what makes a hand-run review worth more than a generic one.

YAML shape:
```yaml
name: reviewer
description: |
  Adversarial code reviewer for one phase of an ai-plans/ implementation.
  Read-only by design. Outputs severity-tagged findings; the caller decides who fixes them.
access: read-only
body: |
  # Reviewer
  
  Sections:
  - Read in order (phase body, the plan's **Goals + Non-goals** + **Guiding Decisions** sections, AGENTS.md, reusable SKILL.md, full diff, tracking).
  - Look for (plan compliance, convention violations, bugs, test gaps, deploy risks, security, scope creep, commit hygiene).
  - Report shape (BLOCKER/SHOULD-FIX/NIT with file:line + suggested fix).
  - Severity guidance.
  - Will not (edit, re-run tests "to be sure", suggest architectural changes, be polite).
```

"Look for" sweeps must be **project-specific**. Pull violations classes from AGENTS.md + stack templates. Examples:
- Medplum project: missing `meta.account`, bare Subscription criteria, hard-coded env-prefixed bot names, AccessPolicy compartment gaps, writable PractitionerRole, missing notification `tenant` field.
- Django project: missing `tenant_id` filter, loop+save instead of bulk_create, lock-heavy migration on hot table, missing `db_default` on non-null new column.

### `fixer.yaml`

Resolves one merge conflict between phases (`implement-plan`'s wave integration, `amend-plan`'s rebase of a child phase), applies one review finding handed over cold when the phase's own implementer cannot be continued, or fixes one named test failure. Smallest correct change. Re-runs inner + outer gate. Reports.

YAML shape:
```yaml
name: fixer
description: |
  Applies a narrowly-scoped fix: one merge conflict, one review finding, or one named failure.
  Like the implementer: never branches, pushes, or opens PRs. Never adds AI co-author trailers.
access: read-write
body: |
  # Fixer
  
  Sections:
  - Task shapes (merge conflict with both phases' bodies, review finding verbatim, or test/gate failure).
  - Loop (read surrounding, narrowest change, inner loop, outer gate).
  - When you need a human decision (see "Needs-input contract" below).
  - Report (status SUCCESS | FAILURE | NEEDS_INPUT; changes, did NOT touch, out-of-scope spotted, notes).
  - Will not (silence tests, downgrade asserts, scope expansion, ...).
```

### Needs-input contract (every read-write agent body)

Sub-agents cannot call the harness's question tool — Claude Code and Codex block it outside the root session — and a question written into a report gets lost in the transcript. Every read-write agent body (implementer, fixer, every stack specialist) therefore carries a **When you need a human decision** section that says, in the project's words:

- Don't guess on decisions the plan or task doesn't settle (ambiguous requirement, license-blocked dependency, out-of-scope change, destructive step), and don't end with a prose question.
- Stop at a clean point and return `status: NEEDS_INPUT` with `blocked_on`, `done_so_far`, and a `questions:` block: 1–4 questions, each with a `header` of 12 characters or fewer, the full `question` carrying its evidence (`file:line`, package, error), `multi_select`, and 2–4 `options` (`label` of 1–5 words + `description` of the consequence; recommended first with ` (Recommended)`; no "Other" option).
- The orchestrator relays the block as a clickable prompt and resumes the agent with the answers.

Copy the shape from the **Asking the human** section of the project's `AGENTS.md` rather than paraphrasing it — the orchestrating skills (`implement-phase`, `review-phase`, `amend-plan`) parse that exact shape.

## Stack-specific specialists (user-supplied)

[bootstrap-ai-tools/resources/stacks/<stack>/notes.md](../vinta-bootstrap-ai-tools/resources/stacks/) describes **detection signals + agent categories typically needed** for each stack — NOT ready-made agent YAML. The team's specific agent library lives wherever they keep it.

For each stack the inventory matched, surface to the user:

> Detected stack `<X>`. Notes for this stack list these agent categories: A, B, C. Do you have existing agent templates for any of these? If yes, point me at the path / URL. If no, we'll record them as known gaps.

Ask via `AskUserQuestion` (your harness's structured question tool — see [asking-the-human](../vinta-write-agents-md/resources/asking-the-human.md)), batching up to 4 categories per call:
- *"Do you have an agent template for `<category>` (e.g. `deploy-author` for Medplum, `migration-author` for Django)?"* → `Yes — I'll give the path/URL` (the free-text field takes the path), `No — record as gap`, `Skip for now`.

When the user provides a path:
1. Read the source agent YAML (or `.md` if the user's library uses Claude-style markdown — convert to the YAML schema documented above before saving).
2. Replace placeholder paths / app names / command names with the target project's specifics, using the placeholder list from [resources/stacks/<stack>/notes.md](../vinta-bootstrap-ai-tools/resources/stacks/).
3. Drop sections that don't apply (e.g. if the Django project doesn't use `psqlextra`, strip partitioned-table guidance from a `migration-author` template).
4. Write to `ai-tools/agents/<name>.yaml`.

When the user has no template:
- Record the agent category in the run's TODO list. Output as part of the orchestrator's final summary.
- The user can run `vinta-derive-subagents` standalone later — pointing at the [resources/stacks/<stack>/notes.md](../vinta-bootstrap-ai-tools/resources/stacks/) for the agent's role description — and draft the YAML from scratch using the schema above.

If multiple stacks match, ask per-stack independently. The user may have templates for one stack but not another.

The orchestrator does **not** ship pre-baked Medplum / Django / etc agent content. Agent bodies are project- and team-specific; one shared template doesn't fit every team's conventions or chosen vendor (the same logical role looks different in Claude Code vs Cursor vs Codex frontmatter).

## Schema (recap from `ai-tools/agents/README.md`)

```yaml
name: <kebab-case>            # required, matches filename stem
description: <text>           # required; folded or literal block OK
access: read-only | read-write   # required; drives vendor defaults
claude-tools: <comma list>    # optional convenience; overrides claude default
overrides:                    # optional per-vendor
  claude:   { tools: ... }
  cursor:   { model, readonly, is_background }
  copilot:  { tools: [...], model, user-invocable, disable-model-invocation }
  codex:    { sandbox_mode, model, model_reasoning_effort }
body: |                       # required, markdown content as YAML literal block
  ...
```

The setup script ([vinta-install-ai-tools-setup](../vinta-install-ai-tools-setup/SKILL.md)) reads these and emits per-vendor copies. **Don't edit the per-vendor files** — edits get overwritten on the next setup run.

## Rules

- **Bodies cite real commands.** No `pnpm test:foo` if `package.json` has no `test:foo` script. No `make all-tests` if there's no Makefile. Pull from `inventory.commands`.
- **Bodies cite real conventions.** AGENTS.md is the source — repeat key load-bearing rules so the agent has them inline (don't expect agents to always re-fetch AGENTS.md mid-prompt).
- **`access` matches reality.** Reviewer is `read-only`. Implementer / fixer / deploy-author / migration-author are `read-write` (they need to edit code).
- **No PR creation by any agent.** Per Step 0 interview policy. The "Will not" section in every agent body must say so explicitly.
- **No AI co-author trailers in commits.** Per Step 0 interview policy. Repeat in every read-write agent body.
- **Every read-write agent body carries the needs-input contract.** See [Needs-input contract](#needs-input-contract-every-read-write-agent-body). An agent without it ends blocked runs with a prose question nobody sees.
- **Stack templates are starting points.** Customize aggressively to the target project; don't ship copy-pasted Vinta AI Workflow-specific paths.
- **No `§N` shorthand in any agent body, prompt, or "look for" list.** Reference plan or spec sections by their full name (`Goals + Non-goals`, `Guiding Decisions`, `Data Model Changes`, `Phased Rollout`, etc.). `§N` references are unreadable for humans and shift when section numbering changes.

## Adding a new agent later

1. Create `ai-tools/agents/<new-name>.yaml`.
2. Run `pnpm setup:ai-tools` (or `node ai-tools/scripts/setup-ai-tools.mjs`) to materialize per-vendor copies.
3. Commit YAML + generated vendor files.

If the new agent applies to a stack that other projects share, contribute it back to [bootstrap-ai-tools/resources/stacks/<stack>/agents/](../vinta-bootstrap-ai-tools/resources/stacks/) so the next bootstrap picks it up.

## Pitfalls

- **Generic agent bodies that say nothing project-specific.** A body that reads "follow conventions, run tests, report back" is useless. Bodies must name files, commands, conventions, and the "violations to look for" specific to this project.
- **Splitting work between implementer and a stack specialist when there's no real division.** A pure TypeScript monorepo doesn't need a `deploy-author` — Vercel handles deploys automatically. Don't add specialists for ceremony.
- **Forgetting to delete unused stack-template sections.** Templates are written for the maximal case (e.g. `migration-author` covers `psqlextra` partitioning + HStore + view migrations). Strip what your project doesn't use.
- **Duplicating AGENTS.md content verbatim into every agent body.** Repeat the load-bearing rules; don't replay the whole document.

## Verification

After writing all YAMLs:

1. `node -e "require('yaml').parse(require('fs').readFileSync('ai-tools/agents/<name>.yaml', 'utf8'))"` for each — confirms valid YAML.
2. `node ai-tools/scripts/setup-ai-tools.mjs` — runs cleanly, generates vendor copies.
3. Open each generated vendor file (Claude / Cursor / Copilot / Codex), spot-check that body content + frontmatter look right.
4. Read each YAML body end-to-end: does it tell the agent what to do in this project? Specific commands? Specific conventions? Specific violations to flag?
5. Every `access: read-write` YAML mentions `NEEDS_INPUT` in its body; read-only agents (e.g. `reviewer`) don't need to.
