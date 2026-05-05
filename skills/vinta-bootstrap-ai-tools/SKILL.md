---
name: vinta-bootstrap-ai-tools
description: Bootstrap a project's AI-tooling layout (`ai-tools/AGENTS.md`, `ai-tools/skills/`, `ai-tools/agents/*.yaml`) plus the multi-vendor setup script that wires the canonical sources into Claude Code, Cursor, Codex, and VS Code Copilot. Project-agnostic — adapts to whatever stack it finds. Detects langs, frameworks, build tools, deploy paths, multi-tenancy patterns, and CI conventions, interviews the user for the gaps, then drafts AGENTS.md, the foundation sub-agents (implementer / reviewer / fixer), and a starter set of project-specific skills. Stack-specific skill + agent templates (Medplum, Django, …) live as resources and get copied when the detected stack matches. Use when invoked in a fresh repo that doesn't yet have an `ai-tools/` directory, or to refresh an existing one. Orchestrates several sub-skills — see "Sub-skill flow" below.
---

# Bootstrap AI tools

This skill produces, in the target repo:

- `ai-tools/AGENTS.md` — universal project conventions read by Claude Code, Cursor, Codex, Copilot.
- `ai-tools/skills/<name>/SKILL.md` — domain-specific skills (always: foundation set + stack-matched copies).
- `ai-tools/agents/<name>.yaml` — vendor-agnostic sub-agent definitions; the setup script materializes per-vendor copies.
- `ai-tools/scripts/setup-ai-tools.mjs` + a `pnpm setup:ai-tools` (or equivalent) script alias.
- All vendor symlinks + generated agent files (Claude markdown, Cursor markdown, Copilot `.agent.md`, Codex TOML).

Project-agnostic. Adapts to whatever the analysis finds. Stack-specific skill + agent templates (Medplum, Django, ...) live under [`resources/stacks/`](resources/stacks/) and get copied when the detected stack signals match.

## Sub-skill flow

This orchestrator runs five sub-skills in order. Each is its own SKILL.md so it can be invoked standalone (e.g. to refresh just AGENTS.md without redoing analysis from scratch).

1. [vinta-analyze-codebase](../vinta-analyze-codebase/SKILL.md) — walk the repo, build a structured inventory: languages, frameworks, build tools, test frameworks, deploy targets, monorepo shape, env model, multi-tenancy patterns, CI providers. Outputs an in-memory inventory the rest of the flow consumes.
2. [vinta-write-agents-md](../vinta-write-agents-md/SKILL.md) — synthesize `ai-tools/AGENTS.md` from the inventory + a focused interview for what the analysis can't see.
3. [vinta-derive-subagents](../vinta-derive-subagents/SKILL.md) — author `ai-tools/agents/*.yaml`. Always emits the foundation trio (`implementer`, `reviewer`, `fixer`); adds stack-specific specialists when the user supplies a template for a matched stack.
4. [vinta-derive-skills](../vinta-derive-skills/SKILL.md) — author `ai-tools/skills/*/SKILL.md`. Always copies the project-agnostic foundation set (`plan-feature`, `create-spec`, `create-qa-use-cases`) verbatim from its bundled resources. Generates `implement-plan` from a parameterized template using project specifics. Asks the user whether the optional `add-e2e-test` and `add-env-var` skills are needed. Asks for stack-specific templates per matched stack.
5. [vinta-install-ai-tools-setup](../vinta-install-ai-tools-setup/SKILL.md) — copy the canonical `setup-ai-tools.mjs` into `ai-tools/scripts/`, wire the package script alias, run setup, verify all vendor paths resolve.

Each sub-skill returns a short status report. Don't run the next sub-skill until the previous finished cleanly. If a sub-skill fails or surfaces ambiguity, surface that to the user and resolve before continuing.

### Sibling skill — `create-qa-use-cases`

[create-qa-use-cases](../create-qa-use-cases/SKILL.md) lives alongside the five sub-skills above but is **not** dispatched by the orchestrator at bootstrap time. It serves two distinct purposes:

- **Foundation skill that ships to the target**. [vinta-derive-skills](../vinta-derive-skills/SKILL.md) copies the same SKILL.md (bundled at `derive-skills/resources/foundation-skills/create-qa-use-cases/SKILL.md`) into the target's `ai-tools/skills/create-qa-use-cases/`.
- **Sub-skill of `plan-feature` at runtime in the target**. When `plan-feature` runs in the target project and detects no `QA_USE_CASES.md`, it invokes `create-qa-use-cases` to bootstrap the doc from the active feature's spec + plan.

The bootstrap orchestrator doesn't need to invoke it directly. It just needs to make sure derive-skills ships it as part of the foundation set.

## When to use

- Repo has no `ai-tools/` directory and the user wants to introduce Vinta's setup.
- Repo has a partial setup and the user wants to refresh / extend it. (This orchestrator is idempotent in spirit — sub-skills read what's there before writing.)
- Forking the Vinta conventions into a new project.

If the repo already has `ai-tools/AGENTS.md`, **do not overwrite** without explicit confirmation. The orchestrator's first interview question covers this.

## Interview (Step 0 — before any sub-skill runs)

Use `AskUserQuestion` for finite-choice questions; iterate plain prose for open-ended ones. Same convention as [plan-feature](../plan-feature/SKILL.md) and [create-spec](../create-spec/SKILL.md).

### A. Scope

1. **Existing setup?** `ai-tools/` already present → confirm: refresh in place, or stop and route to specific sub-skill (e.g. just re-run install-ai-tools-setup). `AskUserQuestion` options: `Fresh bootstrap`, `Refresh in place`, `Stop, run a specific sub-skill instead`.
2. **Which sub-skills to run?** Default = all five in order. `AskUserQuestion` options: `All five`, `Skip analyze-codebase (use prior inventory)`, `Skip derive-skills (foundation only)`, `Custom selection (ask me)`.
3. **Vendor coverage.** Which AI tools does the team use? `AskUserQuestion` multi-select: `Claude Code`, `Cursor`, `VS Code Copilot`, `Codex`. Maps to the setup script's `--only` flag at the install step.

### B. Stack detection

Don't ask yet — let `vinta-analyze-codebase` do its scan first, then echo back what it found and ask "anything I missed?". The interview for stack details lives inside each sub-skill where the question is most relevant.

### C. Project conventions worth surfacing early

These bleed across sub-skills, so capture once now:

1. **Source of truth for code style** — Biome, Prettier, ruff, black, gofmt, etc. (`AskUserQuestion` with the common options + `Other (I'll list)`).
2. **Test framework(s)** — Vitest, Jest, pytest, Go test, etc. Multi-select.
3. **Code host** — GitHub, GitLab, Bitbucket, other. Drives the `implement-plan` template's PR-creation block.
4. **PR creation policy** — agents open PRs, or only push branches and humans open PRs?
5. **Co-author trailer policy** — repo allows AI co-author trailers in commits, or strictly human-only?
6. **Deploy targets** — Vercel, AWS, Kubernetes, Heroku, custom, none.

### D. Optional foundation skills

Two skills are part of the foundation set but aren't always needed. Ask explicitly:

1. **`add-e2e-test`** — does the project have e2e tests (Playwright / Cypress / similar) or plan to add them? `AskUserQuestion` options: `Yes — already has them`, `Yes — planning to add`, `No — skip`. If yes, [vinta-derive-skills](../vinta-derive-skills/SKILL.md) §C will follow up to ask whether the user has a template or wants to draft from scratch.
2. **`add-env-var`** — does the project have a non-trivial env-var propagation flow (multiple files / build configs / CI updates per new var) or a single `.env` file is enough? `AskUserQuestion` options: `Yes — non-trivial flow`, `No — single .env is enough`. Skip if `No`.

If the user answers "No" to either, that skill won't ship. If the user answers "Yes" but doesn't have a template, derive-skills drafts one via interview.

After Step 0: read back the captured decisions, confirm via `AskUserQuestion` (`Looks good`, `Some corrections (I'll list)`, `Stop, rethink`).

## Stack templates — detection only, content is user-supplied

[`resources/stacks/<stack>/notes.md`](resources/stacks/) defines **detection signals** + lists the **categories of skills + sub-agents that typically belong** to each stack. **It does NOT ship ready-made skill / agent content.** The team's specific skill library lives wherever the team keeps it (a shared repo, a personal `~/skills/` dir, a published package, a private gist) — the bootstrap orchestrator asks the user to point at it when a stack matches.

| Stack | Detected by | What the notes.md describes |
|---|---|---|
| Medplum | `@medplum/*` deps + `bots/` dir + tenant compartmenting signals | bot skills, AccessPolicy skill, deploy-author agent |
| Django + Postgres | `manage.py` + Django dep + `migrations/` dirs (multi-tenant signals optional) | model + migration skills, migration-author agent |
| TypeScript monorepo | `turbo.json` / `pnpm-workspace.yaml` + `apps/`+`lib/` layout | env-var + shared-package skills (foundation only) |
| Python package | `pyproject.toml` without Django; `src/<pkg>/` layout | module + CLI + release skills as applicable |
| Next.js App Router | `next.config.*` + `app/` dir | route, server-action, caching, middleware, route-handler skills |

For each matched stack, the orchestrator (via [vinta-derive-skills](../vinta-derive-skills/SKILL.md) and [vinta-derive-subagents](../vinta-derive-subagents/SKILL.md)):

1. Reads `<stack>/notes.md`.
2. Surfaces the match: *"Detected stack X. Notes say teams typically maintain skills for: A, B, C. Do you have existing templates for any?"*
3. If the user has templates → ask for paths (filesystem path, Git URL, package name on disk, etc) and copy + adapt them into the target's `ai-tools/`.
4. If not → record as a known gap. The user can run `vinta-derive-skills` standalone later to draft them from scratch using the canonical structure.

If multiple stacks match (common — TypeScript monorepo + Medplum, or Django + Python-package), the orchestrator handles each; the user can supply templates for any subset.

### Adding a new stack

1. `mkdir resources/stacks/<stack-name>`.
2. Write `notes.md` with detection signals + skill / agent categories + placeholders to ask about.
3. Update [vinta-analyze-codebase](../vinta-analyze-codebase/SKILL.md) §3 if a new dep / signal needs to be detected.
4. Update the table above.

No skill / agent content lives in `resources/stacks/<stack>/`. That's by design — those are project- and team-specific.

## Outputs

After all five sub-skills run, the target repo has:

```
ai-tools/
├── AGENTS.md
├── skills/
│   ├── plan-feature/SKILL.md            ← always (copied verbatim from derive-skills resources)
│   ├── create-spec/SKILL.md             ← always (copied verbatim)
│   ├── create-qa-use-cases/SKILL.md     ← always (copied verbatim)
│   ├── implement-plan/SKILL.md          ← always (generated from template, project-specific)
│   ├── add-e2e-test/SKILL.md            ← optional — only if user opts in
│   ├── add-env-var/SKILL.md             ← optional — only if user opts in
│   └── <stack-specific skills>/SKILL.md ← only if user supplied templates
├── agents/
│   ├── implementer.yaml                 ← always (foundation)
│   ├── reviewer.yaml                    ← always (foundation)
│   ├── fixer.yaml                       ← always (foundation)
│   ├── README.md                        ← schema doc
│   └── <stack-specific>.yaml            ← only if user supplied templates
└── scripts/
    └── setup-ai-tools.mjs               ← copied from install-ai-tools-setup resources
```

Plus the symlinks + per-vendor generated files, set up by the install step.

Foundation skills break into three buckets — see [vinta-derive-skills](../vinta-derive-skills/SKILL.md) for the full mechanics:

- **Always copy verbatim**: `plan-feature`, `create-spec`, `create-qa-use-cases`. Bundled with the bootstrap skill set; project-agnostic enough to ship as-is (with light path scrubs).
- **Always generate**: `implement-plan`. Body has too much project-specific content (test commands, branch convention, PR + co-author policy, agent dispatch) — generated from a parameterized template using interview answers + inventory.
- **Optional, ask first**: `add-e2e-test`, `add-env-var`. Skipped by default; orchestrator asks via `AskUserQuestion` whether the project has the relevant flow at all. If yes + user has a template → copy + adapt. If yes + no template → draft from scratch via interview. If no → don't ship.

Stack-specific skills + agents land in the target only when the user provides templates for them. If they don't have templates yet, the orchestrator records the detected stacks + skill categories as a TODO list the user can address later via [vinta-derive-skills](../vinta-derive-skills/SKILL.md) / [vinta-derive-subagents](../vinta-derive-subagents/SKILL.md) standalone runs.

## Rules

- **Read before write.** Always check what's in the target repo first. Don't clobber existing AGENTS.md / skills / agents without an explicit confirmation in Step 0.
- **Stack templates are starting points, not finals.** Each copied skill / agent must be reviewed against the actual project (interview the user about specifics) and edited where the template's assumptions don't fit.
- **Don't fabricate conventions.** If `vinta-analyze-codebase` doesn't find a thing, ask the user. Don't write "Use bulk_create instead of loop+save" into AGENTS.md just because Django was detected — confirm the team actually follows it.
- **Foundation skills are universal.** Every project gets `add-env-var`, `add-e2e-test`, `plan-feature`, `implement-plan`, `create-spec`, `create-qa-use-cases`. The bodies need light per-project edits (test commands, branch conventions) — `vinta-derive-skills` handles that.
- **Foundation agents are universal.** `implementer` / `reviewer` / `fixer` always. Stack specialists (`deploy-author` for Medplum, `migration-author` for Django) only when the stack matches.
- **Don't run install-ai-tools-setup until AGENTS.md + agents YAMLs + skills exist.** The setup script reads these files; running it on an empty `ai-tools/` produces nothing useful.
- **Multi-vendor coverage matches the user's selection.** The install step's `--only` flag is set from Step 0 §A.3.

## Pitfalls

- **Bootstrapping a project that already has its own conventions.** The user's existing AGENTS.md / CONTRIBUTING.md / `.cursorrules` is gospel. Treat as input to `vinta-write-agents-md`, not noise to overwrite.
- **Detecting Django without verifying multi-tenancy.** Many Django projects are single-tenant; emitting `tenant_id` rules into AGENTS.md is wrong for them. Stack templates are starting points — interview before assuming.
- **Stack templates pulling Vinta AI Workflow-specific paths.** Templates are written to be project-agnostic (no `apps/provider-app` hard-coding) but they may slip. Review each copied SKILL.md / agent.yaml for hard-coded paths from the source repo.
- **Skipping the interview because "the analysis is enough".** It isn't. Conventions humans hold but don't commit (PR review tone, deploy approvals, who-owns-what) only surface in conversation.
- **Forgetting to commit the canonical sources.** Generated vendor files are noisy in PRs. `vinta-derive-subagents` writes YAML; `vinta-install-ai-tools-setup` runs the script that produces vendor copies. Commit both — don't gitignore the vendor outputs unless the team agrees.

## Verification

After all sub-skills finish:

1. `ls -la ai-tools/` — confirm AGENTS.md, skills/, agents/, scripts/ all exist.
2. `node ai-tools/scripts/setup-ai-tools.mjs` — runs cleanly, no errors.
3. Each selected vendor's directory has the expected files: `.claude/agents/*.md`, `.cursor/agents/*.md`, `.github/agents/*.agent.md`, `.codex/agents/*.toml`.
4. Spot-check one skill, one agent: open SKILL.md / `<agent>.yaml` and confirm content describes THIS project (not a copy-pasted template with `<placeholder>` strings).
5. If the project uses Claude Code: in a new session, ask Claude to invoke one of the project-specific skills. Confirm it loads + the body looks right.

End the run with a one-paragraph summary: what was created, what was skipped (per `--only`), what manual edits the user should review.
