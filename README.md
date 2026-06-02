# vinta-ai-workflows

Bootstrap AI tooling — AGENTS.md, sub-agents, project skills, multi-vendor wiring — into any project, then get out of the way.

Distributed as a private npm package (`vinta-ai-workflows`) with a CLI that installs / updates / uninstalls a set of one-shot bootstrap skills into the project's vendor-specific skill directories (Claude Code, Codex, Cursor, VS Code + GitHub Copilot).

## Quick start

```bash
# 1. Add the package to the target project.
cd ~/code/my-project
npm install -D git+ssh://git@github.com:vintasoftware/vinta-ai-workflows.git#0.1.0

# 2. Install the bootstrap skills for your AI tool.
npx vinta-ai-workflows install --tool claude-code
#   or --tool agents (covers Codex + Cursor + Copilot in one go)
#   or --tool all

# 3. Open the project in the AI tool, run the orchestrator.
#   Claude Code → /vinta-bootstrap-ai-tools

# 4. Review and commit the generated layout.
git add ai-tools/ AGENTS.md .claude/ .codex/ .cursor/ .github/ .agents/
git commit -m "Bootstrap ai-tools layout"

# 5. Remove the builder skills — one-shot done.
npx vinta-ai-workflows uninstall --tool claude-code
npm uninstall vinta-ai-workflows
```

Prerequisites: Node ≥ 18, SSH access to the private repo (or a registry token if your team mirrors it).

## Why this is useful

After bootstrap, the project ships with **three foundation skills** that take a feature from raw prompt to merged code:

```
   raw prompt / ticket
            │
            ▼
   ┌─────────────────┐    ai-plans/YYYY-MM-DD-FEATURE_NAME_SPEC.md
   │   create-spec   │───►  what + why (Business Context, Hypothesis,
   └─────────────────┘      Use-cases, Acceptance, Negative scope,
            │               Open questions, Risks)
            ▼
   ┌─────────────────┐    ai-plans/YYYY-MM-DD-FEATURE_NAME_PLAN.md
   │  plan-feature   │───►  how + when (Goals, Decisions, Data Model,
   └─────────────────┘      Phased Rollout, Touch List, Risks)
            │
            ▼
   ┌─────────────────┐    one stacked branch per phase + tracking file
   │  implement-plan │───►  plan/<feature>/phase-1, phase-2, ...
   └─────────────────┘      pushed to GitHub / GitLab / etc.
```

You also get: an `AGENTS.md` tuned to the codebase, project-specific sub-agents and skills derived from the actual stack, and per-vendor wiring so Claude Code / Codex / Cursor / Copilot all see the same artifacts.

**The project keeps getting better without re-bootstrapping.** `vinta-ai-workflows` ships new foundation skills, sharper templates, schema additions, and best-practice updates lifted from real projects. A bootstrapped repo pulls those in via [`vinta-sync-ai-tools`](#staying-in-sync-with-upstream) — one command from the AI tool, per-change `Apply` / `Skip` / `Show diff` gating, opt-outs sticky across runs, schema migrations automatic. No manual re-scaffolding, no clobbered hand-tuning, no drift between projects on the same package version. This is treated as a first-class capability of the package, not an afterthought.

The bootstrap skills are **one-shot**. They scaffold the project once and are removed — they don't pollute the slash menu, and they can't accidentally overwrite hand-tuned output on a future run. Sync handles every later upgrade.

## The AI workflow after bootstrap

### 1. Spec generation — `create-spec`

**Trigger:** `/create-spec`, "write a spec for X", "draft a spec for the new <feature>". Runs as soon as you have a prompt or ticket and need structure before planning.

**What it does:** interviews the requester before drafting — never turns a vague prompt into a plausible-sounding spec by guessing. The interview covers Business Context, Hypothesis, Objectives, Use-cases, State transitions, Acceptance scenarios, Negative scope, Alternatives considered, Open questions, and Risks assumed.

**Output:** `ai-plans/YYYY-MM-DD-FEATURE_NAME_SPEC.md` with the fixed section structure above. `YYYY-MM-DD` = today; `FEATURE_NAME` = `UPPERCASE_WITH_UNDERSCORES`.

**Hand-off:** confirm scope with the requester, then move to `plan-feature`. The spec is the contract; the plan is the build pipeline. Plans without specs produce plausible-sounding but unverified work.

### 2. Implementation plan generation — `plan-feature`

**Trigger:** `/plan-feature`, "plan the <feature>", "break this spec into phases". Reads the matching `*_SPEC.md` (paired by date + feature name) before drafting.

**What it does:** translates the spec into a phased delivery plan. Output sections:

- **Goals + Non-goals** — what's in / out of scope.
- **Guiding Decisions** — feature flag (key, scope, default, flip-on criterion if any), storage shape, tenant scoping, API contract, schema rules. Load-bearing — every phase reaches back here.
- **Data Model Changes** — migrations + rollout order.
- **Phased Rollout** — each phase declares: `id`, `title`, `goal`, `Suggested AI model` (per vendor — implement-plan picks the cheapest available), `reusable_skills` (other project skills the implementer should invoke), `Changes`, `Tests`, `Acceptance`, plus flags for `is_cross_repo` and `is_flag_removal` (both deferred).
- **Risk & Rollout Notes**, **Open Questions**, **Touch List**.

Phases are sized so the slowest path (e.g. cross-repo producer wiring, external integration approval) starts in Phase 1 and fast in-repo work fills in behind. Large mutation phases get split (`4a / 4b / 4c`) rather than monolithic.

**Output:** `ai-plans/YYYY-MM-DD-FEATURE_NAME_PLAN.md`. Same `FEATURE_NAME` prefix as the spec so `ls ai-plans/` groups pairs.

**Hand-off:** review the plan with the team — feature-flag decision, phase boundaries, cross-repo dependencies, rollback story. Once approved, move to `implement-plan`.

### 3. Phase-by-phase execution — `implement-plan`

**Trigger:** `/implement-plan`, "implement the <feature> plan", "execute phase N of plan X". Asks which plan if ambiguous, then drives every in-scope phase to completion without further prompts (unless a phase fails after retries).

**Per-phase loop** (Step 1 of the skill):

1. **Compose a token-efficient prompt.** AGENTS.md + the plan's **Goals + Non-goals**, **Guiding Decisions**, relevant **Data Model Changes** subsection, this phase's body under **Phased Rollout**, plus the running tracking summary (replaces full prior-phase content as context handoff). Don't dump the full plan into every prompt.
2. **Pick the model from the plan's per-phase suggestion.** Filter to what the runtime can actually run, choose the cheapest survivor. Capability gap on retry → escalate one tier; after Tier 4, stop and surface to the user.
3. **Spawn the right agent type.** `implementer` by default; switch to a stack-specialist (`migration-author`, `deploy-author`, etc.) when that role's risk dominates the phase.
4. **Implementer runs inner + outer loop.** Inner: lint → scoped tests → typecheck on touched files; iterate until green. Outer (only after inner is green): full build + full test suite + e2e where applicable. Never commits, pushes, or proceeds with a red gate.
5. **Three-layer review** before merging the phase branch:
   - **Layer 1 — mechanical**: read every diff, confirm outer gate ran green, scope-creep + secrets scan.
   - **Layer 2 — plan compliance**: walk every "Changes" item, every "Tests" entry, the Acceptance line, AGENTS.md conventions, any reusable-skill compliance, feature-flag wiring, cross-phase consistency.
   - **Layer 3 — independent reviewer**: spawn a fresh `reviewer` agent with no implementation context. Findings triaged BLOCKER / SHOULD-FIX / NIT.
6. **Fix loop**: each finding → spawn a `fixer` agent (separate session) that re-runs inner + outer loops; orchestrator never edits directly. Repeat until all three layers are clean.

**Branch model — one branch per phase, stacked:**

```bash
# First executed phase — branches from the default branch.
git checkout main && git pull --ff-only
git checkout -b plan/<feature-kebab>/phase-1
# implementer's commits land here
git push -u origin plan/<feature-kebab>/phase-1

# Phase 2 stacks on phase 1 — never branches back to main.
git checkout plan/<feature-kebab>/phase-1
git checkout -b plan/<feature-kebab>/phase-2
git push -u origin plan/<feature-kebab>/phase-2

# Phase 3 stacks on phase 2, etc.
```

Each phase's PR (or branch, depending on the project's PR policy captured at bootstrap) targets the previous phase's branch, not `main`. This keeps the diff per PR scoped to a single phase, makes review manageable, and lets the team merge phases sequentially as approvals land — earlier phases ship to production while later ones are still in review.

**Tracking file** — `ai-plans/TRACKING_<feature-kebab>.md`. The orchestrator writes it from `git diff` + the agent's report (not the agent's narration). Records: completed phases (status, model used, branch, base, e2e+screenshots when applicable, 5–15 line summary), current phase, remaining phases, deferred phases. Acts as the durable context handoff between phase prompts. Deleted on plan completion.

**Phases the orchestrator never auto-executes:**

- **Cross-repo phases** (`is_cross_repo: true`) — work in another repository. Marked deferred in tracking; orchestrator continues to the next in-repo phase. Don't block on cross-repo work.
- **Flag-removal phase** (always the last phase when a feature flag exists). Gated on real-world soak signal — handled by a dedicated flag-removal skill, not `implement-plan`. Marked deferred; orchestrator ends the run with a hand-off note.

**Failure handling:** if a phase fails Layer 1 / 2 / 3 + fixer escalation, orchestrator stops, posts the agent's report, and asks how to proceed. It does not silently rerun, skip, or escalate models without the user.

#### PR creation: single flow via `prs-context` + `open-pr.sh`

`implement-plan` has **one** path for opening PRs: write a `.vinta-ai-workflows/prs-context/{feature-name}/{phase-name}.md` file, then run the bundled [open-pr.sh](skills/vinta-derive-skills/resources/foundation-skills/open-pr-from-context/scripts/open-pr.sh) script. No raw `gh pr create` / `glab mr create` calls live elsewhere in the flow. The file is the durable record; the script is the publisher. The `.vinta-ai-workflows/prs-context/` directory is auto-added to `.gitignore` by `setup-ai-tools.mjs`.

What actually happens depends on two signals:

1. **Project PR creation policy** — captured at bootstrap. Either "agents create PRs" or "branches only, humans open PRs".
2. **`generate_inline_comments` opt-in** — Step 0 per-run question, off by default. Yes → agent picks 3–10 non-obvious diff spots and writes them to the file's `# Comments` block. No → file's `# Comments` block is empty; only `# Title` + `# Description` populate.

| PR policy | inline comments | What the **Open PR via context file** step does |
|---|---|---|
| agents create | off | Write file (empty `# Comments`); run `open-pr.sh` → PR opened, no inline comments. |
| agents create | on  | Write file (full); run `open-pr.sh` → PR opened, all comments posted. |
| branches only | off | Skip the step. Human opens PR manually. |
| branches only | on  | Write file (durable record); **don't** run script. Publish later via `open-pr-from-context` from a CLI-equipped session. |

`open-pr.sh` exit codes propagate: `0` = PR up + comments OK, `1` = PR up but ≥1 comment failed (failures listed by `(file:line)`), `2` = hard failure (file stays `status: pending` so re-running after fixing the gap is safe).

**Required tools** for `open-pr.sh` (install before any policy = "agents create" run, and on any session that will publish a `pending` file later):

- **`bash` 4+** — already present on macOS (3.2 ships by default; install 4+ via `brew install bash`) and Linux.
- **`git`**.
- **[`yq`](https://github.com/mikefarah/yq)** (Mike Farah's Go binary — not the Python `yq` wrapper). Used to read/write the file's YAML frontmatter and parse the comments list.
- **[`jq`](https://stedolan.github.io/jq/)** — used to iterate the comment list and parse `gh` / `glab` JSON output.
- **One of [`gh`](https://cli.github.com)** (for GitHub) **or [`glab`](https://gitlab.com/gitlab-org/cli)** (for GitLab), authenticated.

Install commands:

```bash
# macOS
brew install yq jq gh                    # GitHub
brew install yq jq glab                  # GitLab

# Debian / Ubuntu
sudo apt install yq jq                   # check yq version — some distros ship the Python wrapper;
                                          # if so, install Mike Farah's binary from the GitHub releases.
# gh: see cli.github.com#installation
# glab: see gitlab.com/gitlab-org/cli#installation

# Auth (once per machine)
gh auth login                            # GitHub
glab auth login                          # GitLab
```

The script bails early with `missing dependency: <name>` if any are absent. If a runner can't install them (e.g. minimal CI image), the project's PR policy must be set to "branches only" at bootstrap so the **Open PR via context file** step skips the script — humans open PRs from the pushed branch.

### Putting it together

```
# Day 1 — discovery + scoping
/create-spec           # interview → ai-plans/2026-05-12-CHECKOUT_FLOW_SPEC.md
# review with team, iterate

# Day 2 — planning
/plan-feature          # reads spec → ai-plans/2026-05-12-CHECKOUT_FLOW_PLAN.md
# review feature flag, phase boundaries, rollback story

# Day 3+ — execution
/implement-plan        # orchestrator runs phase 1 → phase 2 → ... → phase N-1
                       # each phase: implementer + reviewer + fixer agents,
                       # one stacked branch + PR per phase
# merge phase branches sequentially as approvals land
# soak phase 1 in prod → soak phase 2 → ...
# once feature flag's flip-on criterion is met:
#   invoke the flag-removal skill on the deferred phase N
```

Standalone re-invocation works at every step — kick `create-spec` again when the requirements shift mid-plan, re-run `plan-feature` after contract changes, restart `implement-plan` mid-feature (it picks up from the tracking file, never re-runs completed phases).

## Cheat sheet — what lands in your project

Quick inventory of what `vinta-bootstrap-ai-tools` writes into your repo's `ai-tools/` layout (and exposes via per-vendor wiring at `.claude/skills/`, `.agents/skills/`, etc.). Two disclaimers up front:

> **Optional foundation skills are gated by the bootstrap interview.** `systematic-debugging`, `add-e2e-test`, `add-env-var`, and `add-one-off-script` ship **only** if the user says yes during `vinta-bootstrap-ai-tools` Step 0 (or later opts in via `vinta-sync-ai-tools`). They are not in every bootstrapped project. The opt-in is recorded in `.vinta-ai-workflows.yaml` under `foundation_skills.*.enabled` and is sticky across syncs.
>
> **Stack-specific skills and sub-agents are user-supplied.** This package ships **detection signals + category lists** per stack ([resources/stacks/](skills/vinta-bootstrap-ai-tools/resources/stacks/) — Django, Medplum, Next.js App Router, Python package, TypeScript monorepo), not the bodies. When a stack is detected, the orchestrator asks the user for a path / URL to their team's existing template. If no template exists, the category is recorded as a gap in the final summary, not auto-drafted. Bodies are project- and team-specific; one shared template doesn't fit every team's conventions.

### Foundation skills (project-agnostic)

Land at `ai-tools/skills/<name>/SKILL.md`. Always-on unless flagged optional.

| Skill | Status | What it does |
|---|---|---|
| [`create-spec`](skills/vinta-derive-skills/resources/foundation-skills/create-spec/SKILL.md) | always | Interview-driven spec doc from a raw prompt / ticket → `ai-plans/YYYY-MM-DD-FEATURE_NAME_SPEC.md`. |
| [`plan-feature`](skills/vinta-derive-skills/resources/foundation-skills/plan-feature/SKILL.md) | always | Phased delivery plan from the matching spec → `ai-plans/YYYY-MM-DD-FEATURE_NAME_PLAN.md`. |
| [`create-qa-use-cases`](skills/vinta-derive-skills/resources/foundation-skills/create-qa-use-cases/SKILL.md) | always | Bootstrap `QA_USE_CASES.md` from the active spec / plan. Called by `plan-feature` when missing. |
| [`open-pr-from-context`](skills/vinta-derive-skills/resources/foundation-skills/open-pr-from-context/SKILL.md) | always | Publish a `.vinta-ai-workflows/prs-context/<feature>/<phase>.md` file as a real PR + inline comments via `gh` / `glab`. Bundles [`open-pr.sh`](skills/vinta-derive-skills/resources/foundation-skills/open-pr-from-context/scripts/open-pr.sh). |
| `implement-plan` | always (generated) | Phase-by-phase plan execution. Generated from a template with project commands + branch / PR / co-author policy. |
| `amend-plan` | always (generated) | History-rewriting companion to `implement-plan` — revises in-flight plans, amends prior-phase commits, force-pushes, rebases stacked downstream branches. |
| `systematic-debugging` | **opt-in** | Root-cause-first debugging with project-specific repro commands + MCP evidence-gathering (error tracking, traces, logs, metrics, alerts). Renders from a catalogue of observability MCP servers the user declares. |
| `add-e2e-test` | **opt-in** | Add an e2e test. Body covers e2e framework, page-object pattern, auth/storage-state, seed helpers, tenant scoping, screenshot conventions. |
| `add-env-var` | **opt-in** | Propagate a new env var through every layer (`.env.example`, build tool envPrefix, build cache hash, app config, AGENTS.md, CI, deploy injection). |
| [`add-one-off-script`](skills/vinta-derive-skills/resources/foundation-skills/add-one-off-script/SKILL.md) | **opt-in** | Author one-off operational scripts (backfills, cleanups, ad-hoc fixes). Ships a `BaseOneOffScript` class (Python + TS) enforcing dry-run default, idempotency, batched DB ops, segmented CSV backups, signal-safe interruption, multi-sink logging. |

### Foundation sub-agents (project-agnostic)

Land at `ai-tools/agents/<name>.yaml` (canonical YAML; `setup-ai-tools.mjs` emits per-vendor copies into `.claude/agents/`, `.cursor/`, `.codex/`, `.github/`). Always-on trio.

| Agent | Access | Role |
|---|---|---|
| `implementer` | read-write | Default coder for one plan phase. Reads AGENTS.md + plan + phase body, runs inner + outer test gates, reports back. Never branches, pushes, opens PRs, or adds AI co-author trailers. |
| `reviewer` | read-only | Adversarial reviewer. Reads phase + diff + AGENTS.md, outputs `BLOCKER` / `SHOULD-FIX` / `NIT` findings with `file:line`. Does not edit. |
| `fixer` | read-write | Applies one reviewer finding (or one named test failure). Smallest correct change, re-runs gates, reports. |

Stack templates may add specialists like `migration-author` (Django) or `deploy-author` (Medplum) — see disclaimer above.

## Staying in sync with upstream

Bootstrap is a snapshot. `vinta-ai-workflows` keeps shipping — new foundation skills, refined templates, sharper agent prompts, schema additions, stack support, best-practice updates lifted from real projects. Pulling those into a previously-bootstrapped repo is a first-class flow, not an afterthought. **This is one of the most important capabilities of the package.**

### The flow at a glance

```bash
# 1. Pull the new package version (or update the git+ssh ref).
npm update vinta-ai-workflows

# 2. Run the sync skill from your AI tool.
#    Claude Code → /vinta-sync-ai-tools
```

That's it. The sync skill walks every release between the project's recorded version and the new one, proposes per-change updates, and bumps the project's version stamp at the end.

### How it stays safe

The single source of truth is `.vinta-ai-workflows.yaml` at the repo root (written at bootstrap, schema: [`schemas/vinta-ai-workflows-config.v1.schema.json`](schemas/vinta-ai-workflows-config.v1.schema.json)). It records every opt-in the project made — which foundation skills are `enabled`, which stacks are applied, which vendors are wired, which policies (PR creation, AI co-author, commit style) hold. `vinta-sync-ai-tools` reads this file and uses it to classify every upstream change into one of:

| Bucket | Meaning | Default |
|---|---|---|
| `affects-project` | Touches enabled surface area (e.g. an enabled foundation skill's body changed). | One prompt per change: `Apply` / `Skip` / `Show diff`. |
| `opt-in-offer` | New optional surface area the project doesn't have. | Description shown; offer to enable. `Skip` is sticky — recorded in the config so future syncs don't re-propose it. |
| `config-schema-change` | New field, schema migration, or major-bump. | Migrated automatically; required new fields prompt for a value. |
| `tooling` | Setup-script / gitignore / packaging tweaks. | Batched under one prompt. |
| `not-applicable` | Project opted out, or change targets an unused stack. | Listed for transparency, not applied. |

Every per-change decision is explicit — nothing is silently overwritten. Each `affects-project` change is a separate prompt, so hand-tuned wording in one skill body can stay while another is refreshed. Hand-edits to a rendered skill body that would be clobbered surface a warning before re-render.

At the end of a run:

- Approved changes apply (templates re-rendered from the config, new foundation skills copied, config schema migrated, setup script re-run idempotently).
- Every YAML file in the project re-validates against its schema.
- `vinta_ai_workflows_version` + `last_synced_at` get bumped in `.vinta-ai-workflows.yaml`.
- A final report lists Applied / Skipped / Newly disabled / Orphan diffs (changes without changelog entries — flagged, never auto-applied).

### Two related but narrower flows

- [`vinta-update-project-skills`](skills/vinta-update-project-skills/SKILL.md) — refresh **only** the foundation-skill bodies under `ai-tools/skills/` against the latest source. Per-skill diff with explicit accept gate. `vinta-sync-ai-tools` calls this internally for foundation-skill body diffs; invoke it standalone when that's the only thing you want refreshed.
- `vinta-ai-workflows update` (CLI, see [Update](#update) below) — refreshes the **builder skills themselves** (the `vinta-*` set in `.<vendor>/skills/`) when running with `--copy`. Symlink installs already track package updates automatically.

### When to sync

After any of these, schedule a sync run:

- `npm update vinta-ai-workflows` or pulling a newer git+ssh ref.
- A teammate bumped the version pin in `package.json`.
- The package shipped a new foundation skill, stack, or schema field you want to opt into.
- The project's `.vinta-ai-workflows.yaml` is missing — the sync skill's first step is a "Bootstrap the config file" path that reverse-extracts state from existing artifacts and interview-fills gaps before continuing.

If `OLD_VERSION === NEW_VERSION`, the skill prints "already up to date" and exits without touching anything.

## Running the bootstrap skills

Skills are discovered automatically by name + description. Trigger one in plain language ("bootstrap ai-tools for this repo") or invoke explicitly via slash command. The `vinta-` prefix is part of the slash name:

| Tool | Invocation |
|---|---|
| Claude Code | `/vinta-bootstrap-ai-tools` (in chat) |
| OpenAI Codex | `/skills` then pick, or `$vinta-bootstrap-ai-tools` mention |
| Cursor | `/vinta-bootstrap-ai-tools` in Agent chat |
| VS Code + Copilot | `/vinta-bootstrap-ai-tools` in Copilot Chat |

Start with `vinta-bootstrap-ai-tools` — it orchestrates the others.

To bring a previously-bootstrapped project up to date with a newer package version, invoke `vinta-sync-ai-tools` — see [Staying in sync with upstream](#staying-in-sync-with-upstream) above. To refresh **only** the foundation-skill bodies under `ai-tools/skills/` (a narrower flow), invoke [`vinta-update-project-skills`](skills/vinta-update-project-skills/SKILL.md).

## Install variants

The package is private. Two install paths.

### A. From git+ssh (no registry needed)

Each developer's GitHub SSH key needs read access to the repo. Then:

```bash
# inside the target project
npm  install -D git+ssh://git@github.com:vintasoftware/vinta-ai-workflows.git
pnpm add  -D   git+ssh://git@github.com:vintasoftware/vinta-ai-workflows.git
yarn add  -D   git+ssh://git@github.com:vintasoftware/vinta-ai-workflows.git
bun  add  -d   git+ssh://git@github.com:vintasoftware/vinta-ai-workflows.git
```

Pin a tag/commit when you want determinism:

```bash
npm install -D git+ssh://git@github.com:vintasoftware/vinta-ai-workflows.git#0.1.0
```

### B. From GitHub Packages (if/when published)

In the project root, add `.npmrc`:

```ini
@vinta:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Export `GITHUB_TOKEN` (a Personal Access Token with `read:packages` and the `repo` scope for private repos), then:

```bash
npm install -D vinta-ai-workflows
```

### One-shot via npx (no install)

If you don't want the dep tracked in `package.json`:

```bash
npx -y -p git+ssh://git@github.com:vintasoftware/vinta-ai-workflows.git \
  vinta-ai-workflows install --tool all
```

### Picking a tool

After install, the bin is available at `node_modules/.bin/vinta-ai-workflows`:

```bash
npx vinta-ai-workflows install --tool claude-code
# or:
pnpm vinta-ai-workflows install --tool claude-code
./node_modules/.bin/vinta-ai-workflows install --tool claude-code
```

`--tool` accepts: `claude-code`, `codex`, `cursor`, `copilot`, `agents`, `all`.

**Universal install (Codex + Cursor + Copilot)** — `.agents/skills/` is recognized by all three. A single `--tool agents` install covers them:

```bash
# One install, three tools.
npx vinta-ai-workflows install --tool agents

# Pair with Claude Code (which only reads .claude/skills/).
npx vinta-ai-workflows install --tool claude-code
```

### Copy instead of symlink

By default the CLI symlinks each skill into the vendor path back to the package's installed location under `node_modules/`. Use `--copy` if your build pipeline doesn't preserve symlinks, or if other contributors check out the project without this dep installed (e.g. you commit `.claude/`):

```bash
npx vinta-ai-workflows install --tool all --copy
```

Each copied skill gets a `.installed-by-vinta-ai-workflows` marker file used by `uninstall` and `update` to recognize what the script owns.

### Subset of skills

```bash
npx vinta-ai-workflows install --tool claude-code \
  --skills vinta-bootstrap-ai-tools,vinta-write-agents-md
```

`npx vinta-ai-workflows list` prints all available skills.

### Dry run

```bash
npx vinta-ai-workflows install --tool all --dry-run
```

Prints planned actions, touches nothing.

## Update

> **Looking to bring a bootstrapped project up to date with the latest skills, templates, and best practices?** That's [Staying in sync with upstream](#staying-in-sync-with-upstream) — `vinta-sync-ai-tools`, invoked from the AI tool. The CLI `update` command described here is narrower: it only refreshes the builder skills (the `vinta-*` set under `.<vendor>/skills/`) and is mostly only relevant for `--copy` installs.

Refresh installed builder skills against the latest package version:

```bash
# 1. Pull the new package version.
npm  update vinta-ai-workflows
pnpm update vinta-ai-workflows
# Or for git+ssh, just re-install with the new ref:
npm install -D git+ssh://git@github.com:vintasoftware/vinta-ai-workflows.git#v0.2.0

# 2. Re-link / re-copy builder skills (only needed for --copy installs).
npx vinta-ai-workflows update --tool all

# 3. From your AI tool, sync the project against the new package version.
#    Claude Code → /vinta-sync-ai-tools
```

Step 2's `update` command is sugar for `uninstall` followed by `install` with the same flags. Symlink installs (the default) pick up package updates automatically without step 2.

Step 3 is the important one: it re-renders foundation skill templates from the project's `.vinta-ai-workflows.yaml`, offers any new opt-in surface area, migrates the config schema if needed, and bumps the project's recorded version. See [Staying in sync with upstream](#staying-in-sync-with-upstream) for the full flow.

## Uninstall

After the bootstrap is committed, remove the skills:

```bash
npx vinta-ai-workflows uninstall --tool all
```

Then drop the package itself:

```bash
npm  uninstall vinta-ai-workflows
pnpm remove    vinta-ai-workflows
```

### What `uninstall` removes

The uninstaller is conservative on purpose:

- **Symlinks** are removed only if their target points back into the package's `skills/` directory (or the link is dangling).
- **Copied directories** are removed only if they contain the `.installed-by-vinta-ai-workflows` marker file.
- **Anything else** (hand-authored skills, third-party skills, files lacking the marker) is left in place with a warning.

Empty `.<vendor>/skills/` directories are removed after the last managed entry leaves; the parent `.claude/`, `.agents/`, etc. are left alone since they likely hold other content.

### Manual uninstall (no Node available)

```bash
SKILLS="vinta-analyze-codebase vinta-bootstrap-ai-tools vinta-derive-skills \
        vinta-derive-subagents vinta-install-ai-tools-setup \
        vinta-update-project-skills vinta-write-agents-md"

for vendor in .claude/skills .agents/skills .cursor/skills .github/skills; do
  for skill in $SKILLS; do
    rm -rf "$vendor/$skill"
  done
  rmdir "$vendor" 2>/dev/null
done
```

## Per-tool paths

Verified against official docs as of 2026-05.

| Tool | Project path | Source |
|---|---|---|
| Claude Code | `.claude/skills/` | native |
| OpenAI Codex | `.agents/skills/` | [docs](https://developers.openai.com/codex/skills) |
| Cursor | `.cursor/skills/` (also `.agents/skills/`) | [docs](https://cursor.com/docs/skills) |
| VS Code + Copilot | `.github/skills/` (also `.claude/skills/`, `.agents/skills/`) | [docs](https://code.visualstudio.com/docs/copilot/customization/agent-skills) |

Codex walks `.agents/skills/` from cwd up to the repo root, so an install at the project root covers nested working directories too.

## CLI reference

```
vinta-ai-workflows <command> [options]

Commands:
  install     Place skills under <target>/.<vendor>/skills/
  update      Re-install (uninstall + install) so latest source content lands
  uninstall   Remove skills (only artifacts created by this CLI)
  list        List available skills

Options:
  --tool <name>       claude-code | codex | cursor | copilot | agents | all
                      Aliases: claude, openai-codex, vscode, vscode-copilot,
                               github-copilot, universal
  --target <dir>      Project root (default: cwd)
  --skills <a,b,c>    Subset of skills (default: all)
  --copy              Copy instead of symlink
  --dry-run, -n       Plan only
  --help, -h          Help
```

Project scope only — there is no user-scope mode. The `vinta-` skills are intended to bootstrap a single project at a time and then come back out.

## Repo internals

> "Skills" here = the [Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) format: a folder containing a `SKILL.md` (with YAML frontmatter) plus referenced resources/scripts. Recognized natively by Claude Code, Codex, Cursor, and VS Code Copilot.

```
vinta-ai-workflows/
├── package.json             # vinta-ai-workflows — exposes vinta-ai-workflows bin
├── vinta-ai-workflows.mjs    # CLI: install / update / uninstall / list
├── README.md
└── skills/
    ├── vinta-analyze-codebase/
    ├── vinta-bootstrap-ai-tools/   # orchestrator — calls the others
    ├── vinta-derive-skills/
    ├── vinta-derive-subagents/
    ├── vinta-install-ai-tools-setup/
    ├── vinta-update-project-skills/
    └── vinta-write-agents-md/
```

`vinta-bootstrap-ai-tools` is the entry point — walks a fresh repo, runs the others in order. The rest can also be invoked individually to refresh a single artifact.

### Why the `vinta-` prefix?

Once installed, these skills sit alongside the user's own project skills in the same `.<vendor>/skills/` directory. The prefix makes ownership obvious in slash menus and on disk: anything under `vinta-*` is managed by this package and gets removed by `uninstall`; anything else belongs to the project.

### Why one-shot

The `vinta-` skills **bootstrap** a project's AI tooling. Once the project has its own `ai-tools/` layout, AGENTS.md, sub-agents, and per-vendor wiring, they have nothing left to do. Leaving them installed pollutes the slash-command menu and risks a future re-run overwriting hand-tuned output.

→ Install, run once via `/vinta-bootstrap-ai-tools` (or whatever invocation your tool uses), commit the generated `ai-tools/` layout, then `uninstall`.

When this package gains new versions later, [`vinta-sync-ai-tools`](#staying-in-sync-with-upstream) walks the changelog, proposes per-change updates against the project's opt-in surface (recorded in `.vinta-ai-workflows.yaml`), and only applies what the user explicitly accepts.

### Updating skills in this repo

If you modify a `vinta-*` skill source under `skills/`:

- **Symlink installs** (default): consumers get updates as soon as their `node_modules/vinta-ai-workflows/` refreshes (next `npm install` / `git+ssh` re-pull).
- **Copy installs** (`--copy`): consumers must re-run `vinta-ai-workflows update` with the same flags. The CLI removes the previous copy and writes fresh content + marker.

To bring a bootstrapped project up to date with newer builder-skill source, run [`vinta-sync-ai-tools`](#staying-in-sync-with-upstream) from the AI tool — it re-renders templates, offers new opt-ins, migrates the config schema, and delegates foundation-skill body diffs to `vinta-update-project-skills`.
