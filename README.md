# vinta-ai-workflows

Private collection of **one-shot bootstrap skills** that scaffold AI tooling
inside any project: AGENTS.md, sub-agents, project-specific skills, and the
multi-vendor wiring that exposes them to Claude Code, Codex, Cursor, and
VS Code + GitHub Copilot.

Distributed as a private npm package (`@vinta/ai-workflows`). The bundled
CLI (`vinta-ai-workflows`) installs / updates / uninstalls the skills into
the target project's vendor-specific skill directories.

> "Skills" here = the [Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
> format: a folder containing a `SKILL.md` (with YAML frontmatter) plus
> referenced resources/scripts. Recognized natively by Claude Code, Codex,
> Cursor, and VS Code Copilot.

## What's in here

```
vinta-ai-workflows/
├── package.json             # @vinta/ai-workflows — exposes vinta-ai-workflows bin
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

`vinta-bootstrap-ai-tools` is the entry point — walks a fresh repo, runs the
others in order. The rest can also be invoked individually to refresh a
single artifact.

### Why the `vinta-` prefix?

Once installed, these skills sit alongside the user's own project skills in
the same `.<vendor>/skills/` directory. The prefix makes ownership obvious
in slash menus and on disk: anything under `vinta-*` is managed by this
package and gets removed by `uninstall`; anything else belongs to the
project.

## Why one-shot

The `vinta-` skills **bootstrap** a project's AI tooling. Once the project
has its own `ai-tools/` layout, AGENTS.md, sub-agents, and per-vendor
wiring, they have nothing left to do. Leaving them installed pollutes the
slash-command menu and risks a future re-run overwriting hand-tuned output.

→ Install, run once via `/vinta-bootstrap-ai-tools` (or whatever invocation
your tool uses), commit the generated `ai-tools/` layout, then `uninstall`.

When this package gains new versions later, `vinta-update-project-skills`
diffs the project's `ai-tools/skills/` against the latest source and only
applies changes the user explicitly accepts.

## Prerequisites

- **Node.js ≥ 18.** No runtime deps — CLI is dependency-free.
- **SSH access to the private repo** (for `git+ssh://` install) **or** a
  registry token if your team mirrors the package somewhere.

## Install (npm package)

The package is private. Two install paths:

### A. From git+ssh (no registry needed)

Each developer's GitHub SSH key needs read access to the repo. Then:

```bash
# inside the target project
npm  install -D git+ssh://git@github.com:vinta/vinta-ai-workflows.git
pnpm add  -D   git+ssh://git@github.com:vinta/vinta-ai-workflows.git
yarn add  -D   git+ssh://git@github.com:vinta/vinta-ai-workflows.git
bun  add  -d   git+ssh://git@github.com:vinta/vinta-ai-workflows.git
```

Pin a tag/commit when you want determinism:

```bash
npm install -D git+ssh://git@github.com:vinta/vinta-ai-workflows.git#v0.1.0
```

### B. From GitHub Packages (if/when published)

In the project root, add `.npmrc`:

```ini
@vinta:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Export `GITHUB_TOKEN` (a Personal Access Token with `read:packages` and the
`repo` scope for private repos), then:

```bash
npm install -D @vinta/ai-workflows
```

### One-shot via npx (no install)

If you don't want the dep tracked in `package.json`:

```bash
npx -y -p git+ssh://git@github.com:vinta/vinta-ai-workflows.git \
  vinta-ai-workflows install --tool all
```

## Run the CLI

After install, the bin is available at `node_modules/.bin/vinta-ai-workflows`:

```bash
# inside the target project
npx vinta-ai-workflows install --tool all
# pnpm:
pnpm vinta-ai-workflows install --tool all
# or directly:
./node_modules/.bin/vinta-ai-workflows install --tool all
```

Pick a single tool:

```bash
npx vinta-ai-workflows install --tool claude-code
```

`--tool` accepts: `claude-code`, `codex`, `cursor`, `copilot`, `agents`, `all`.

### Universal install (covers Codex + Cursor + Copilot)

`.agents/skills/` is recognized by Codex, Cursor, **and** Copilot. A single
`--tool agents` install covers them:

```bash
# One install, three tools.
npx vinta-ai-workflows install --tool agents

# Pair with Claude Code (which only reads .claude/skills/).
npx vinta-ai-workflows install --tool claude-code
```

### Copy instead of symlink

By default the CLI symlinks each skill into the vendor path back to the
package's installed location under `node_modules/`. Use `--copy` if your
build pipeline doesn't preserve symlinks, or if other contributors check
out the project without this dep installed (e.g. you commit `.claude/`):

```bash
npx vinta-ai-workflows install --tool all --copy
```

Each copied skill gets a `.installed-by-vinta-ai-workflows` marker file
used by `uninstall` and `update` to recognize what the script owns.

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

Refresh installed skills against the latest package version:

```bash
# 1. Pull the new package version.
npm  update @vinta/ai-workflows
pnpm update @vinta/ai-workflows
# Or for git+ssh, just re-install with the new ref:
npm install -D git+ssh://git@github.com:vinta/vinta-ai-workflows.git#v0.2.0

# 2. Re-link / re-copy skills.
npx vinta-ai-workflows update --tool all
```

`update` is sugar for `uninstall` followed by `install` with the same flags.
Symlink installs pick up package updates automatically without step 2 —
step 2 is only needed for `--copy` installs.

> **Note:** `update` refreshes the **builder skills themselves** (`vinta-*`)
> in `.<vendor>/skills/`. To refresh the **project's `ai-tools/skills/`**
> generated by a previous bootstrap run, use the
> [`vinta-update-project-skills`](skills/vinta-update-project-skills/SKILL.md)
> skill — invoke it via the AI tool, not the CLI. It diffs each project
> skill against current source and only applies changes the user accepts.

## Per-tool paths

Verified against official docs as of 2026-05.

| Tool | Project path | Source |
|---|---|---|
| Claude Code | `.claude/skills/` | native |
| OpenAI Codex | `.agents/skills/` | [docs](https://developers.openai.com/codex/skills) |
| Cursor | `.cursor/skills/` (also `.agents/skills/`) | [docs](https://cursor.com/docs/skills) |
| VS Code + Copilot | `.github/skills/` (also `.claude/skills/`, `.agents/skills/`) | [docs](https://code.visualstudio.com/docs/copilot/customization/agent-skills) |

Codex walks `.agents/skills/` from cwd up to the repo root, so an install
at the project root covers nested working directories too.

## Running the skills

Skills are discovered automatically by name + description. Trigger one in
plain language ("bootstrap ai-tools for this repo") or invoke explicitly
via slash command. The `vinta-` prefix is part of the slash name:

| Tool | Invocation |
|---|---|
| Claude Code | `/vinta-bootstrap-ai-tools` (in chat) |
| OpenAI Codex | `/skills` then pick, or `$vinta-bootstrap-ai-tools` mention |
| Cursor | `/vinta-bootstrap-ai-tools` in Agent chat |
| VS Code + Copilot | `/vinta-bootstrap-ai-tools` in Copilot Chat |

Start with `vinta-bootstrap-ai-tools` — it orchestrates the others.

To refresh project-generated skills after pulling a new package version:
invoke `vinta-update-project-skills`. It analyzes `ai-tools/skills/`,
proposes per-skill changes with diffs, and only applies what the user
accepts. See [its SKILL.md](skills/vinta-update-project-skills/SKILL.md)
for details.

## The AI workflow after bootstrap

Once `vinta-bootstrap-ai-tools` finishes and you commit the generated
`ai-tools/` layout, the project has three foundation skills wired up to
take a feature from raw prompt to merged code:

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

Each step writes to `ai-plans/YYYY-MM-DD-{FEATURE_NAME}_{SPEC|PLAN}.md`
(the canonical layout `vinta-migrate-plans-specs` migrates legacy docs to
during bootstrap).

### 1. Spec generation — `create-spec`

**Trigger:** `/create-spec`, "write a spec for X", "draft a spec for the
new <feature>". Runs as soon as you have a prompt or ticket and need
structure before planning.

**What it does:** interviews the requester before drafting — never turns a
vague prompt into a plausible-sounding spec by guessing. The interview
covers Business Context, Hypothesis, Objectives, Use-cases, State
transitions, Acceptance scenarios, Negative scope, Alternatives
considered, Open questions, and Risks assumed.

**Output:** `ai-plans/YYYY-MM-DD-FEATURE_NAME_SPEC.md` with the fixed
section structure above. `YYYY-MM-DD` = today; `FEATURE_NAME` =
`UPPERCASE_WITH_UNDERSCORES`.

**Hand-off:** confirm scope with the requester, then move to `plan-feature`.
The spec is the contract; the plan is the build pipeline. Plans without
specs produce plausible-sounding but unverified work.

### 2. Implementation plan generation — `plan-feature`

**Trigger:** `/plan-feature`, "plan the <feature>", "break this spec into
phases". Reads the matching `*_SPEC.md` (paired by date + feature name)
before drafting.

**What it does:** translates the spec into a phased delivery plan. Output
sections:

- **§1 Goals + Non-goals** — what's in / out of scope.
- **§2 Guiding Decisions** — feature flag (key, scope, default, flip-on
  criterion if any), storage shape, tenant scoping, API contract, schema
  rules. Load-bearing — every phase reaches back here.
- **§3 Data Model Changes** — migrations + rollout order.
- **§5 Phased Rollout** — each phase declares: `id`, `title`, `goal`,
  `Suggested AI model` (per vendor — implement-plan picks the cheapest
  available), `reusable_skills` (other project skills the implementer
  should invoke), `Changes`, `Tests`, `Acceptance`, plus flags for
  `is_cross_repo` and `is_flag_removal` (both deferred).
- **§6 Risk & Rollout Notes**, **§7 Open Questions**, **§8 Touch List**.

Phases are sized so the slowest path (e.g. cross-repo producer wiring,
external integration approval) starts in Phase 1 and fast in-repo work
fills in behind. Large mutation phases get split (`4a / 4b / 4c`) rather
than monolithic.

**Output:** `ai-plans/YYYY-MM-DD-FEATURE_NAME_PLAN.md`. Same `FEATURE_NAME`
prefix as the spec so `ls ai-plans/` groups pairs.

**Hand-off:** review the plan with the team — feature-flag decision,
phase boundaries, cross-repo dependencies, rollback story. Once approved,
move to `implement-plan`.

### 3. Phase-by-phase execution — `implement-plan`

**Trigger:** `/implement-plan`, "implement the <feature> plan", "execute
phase N of plan X". Asks which plan if ambiguous, then drives every
in-scope phase to completion without further prompts (unless a phase
fails after retries).

**Per-phase loop** (Step 1 of the skill):

1. **Compose a token-efficient prompt.** AGENTS.md + plan §1 + §2 +
   relevant §3 + this phase's §5 body + the running tracking summary
   (replaces full prior-phase content as context handoff). Don't dump
   the full plan into every prompt.
2. **Pick the model from the plan's per-phase suggestion.** Filter to
   what the runtime can actually run, choose the cheapest survivor.
   Capability gap on retry → escalate one tier; after Tier 4, stop and
   surface to the user.
3. **Spawn the right agent type.** `implementer` by default; switch to
   a stack-specialist (`migration-author`, `deploy-author`, etc.) when
   that role's risk dominates the phase.
4. **Implementer runs inner + outer loop.** Inner: lint → scoped tests
   → typecheck on touched files; iterate until green. Outer (only after
   inner is green): full build + full test suite + e2e where applicable.
   Never commits, pushes, or proceeds with a red gate.
5. **Three-layer review** before merging the phase branch:
   - **Layer 1 — mechanical**: read every diff, confirm outer gate ran
     green, scope-creep + secrets scan.
   - **Layer 2 — plan compliance**: walk every "Changes" item, every
     "Tests" entry, the Acceptance line, AGENTS.md conventions, any
     reusable-skill compliance, feature-flag wiring, cross-phase
     consistency.
   - **Layer 3 — independent reviewer**: spawn a fresh `reviewer` agent
     with no implementation context. Findings triaged BLOCKER /
     SHOULD-FIX / NIT.
6. **Fix loop**: each finding → spawn a `fixer` agent (separate session)
   that re-runs inner + outer loops; orchestrator never edits directly.
   Repeat until all three layers are clean.

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

Each phase's PR (or branch, depending on the project's PR policy
captured at bootstrap) targets the previous phase's branch, not `main`.
This keeps the diff per PR scoped to a single phase, makes review
manageable, and lets the team merge phases sequentially as approvals
land — earlier phases ship to production while later ones are still in
review.

**Tracking file** — `ai-plans/TRACKING_<feature-kebab>.md`. The
orchestrator writes it from `git diff` + the agent's report (not the
agent's narration). Records: completed phases (status, model used,
branch, base, e2e+screenshots when applicable, 5–15 line summary),
current phase, remaining phases, deferred phases. Acts as the durable
context handoff between phase prompts. Deleted on plan completion.

**Phases the orchestrator never auto-executes:**

- **Cross-repo phases** (`is_cross_repo: true`) — work in another
  repository. Marked deferred in tracking; orchestrator continues to
  the next in-repo phase. Don't block on cross-repo work.
- **Flag-removal phase** (always the last phase when a feature flag
  exists). Gated on real-world soak signal — handled by a dedicated
  flag-removal skill, not `implement-plan`. Marked deferred; orchestrator
  ends the run with a hand-off note.

**Failure handling:** if a phase fails Layer 1 / 2 / 3 + fixer escalation,
orchestrator stops, posts the agent's report, and asks how to proceed.
It does not silently rerun, skip, or escalate models without the user.

#### PR creation: single flow via `prs-context` + `open-pr.sh`

`implement-plan` has **one** path for opening PRs: write a
`.vinta-ai-workflows/prs-context/{feature-name}/{phase-name}.md` file, then run the bundled
[open-pr.sh](skills/vinta-derive-skills/resources/foundation-skills/open-pr-from-context/scripts/open-pr.sh)
script. No raw `gh pr create` / `glab mr create` calls live elsewhere
in the flow. The file is the durable record; the script is the
publisher. The `.vinta-ai-workflows/prs-context/` directory is auto-added to `.gitignore`
by `setup-ai-tools.mjs`.

What actually happens depends on two signals:

1. **Project PR creation policy** — captured at bootstrap. Either
   "agents create PRs" or "branches only, humans open PRs".
2. **`generate_inline_comments` opt-in** — Step 0 per-run question, off
   by default. Yes → agent picks 3–10 non-obvious diff spots and writes
   them to the file's `# Comments` block. No → file's `# Comments` block
   is empty; only `# Title` + `# Description` populate.

| PR policy | inline comments | What §1f does |
|---|---|---|
| agents create | off | Write file (empty `# Comments`); run `open-pr.sh` → PR opened, no inline comments. |
| agents create | on  | Write file (full); run `open-pr.sh` → PR opened, all comments posted. |
| branches only | off | Skip §1f. Human opens PR manually. |
| branches only | on  | Write file (durable record); **don't** run script. Publish later via `open-pr-from-context` from a CLI-equipped session. |

`open-pr.sh` exit codes propagate: `0` = PR up + comments OK, `1` = PR
up but ≥1 comment failed (failures listed by `(file:line)`), `2` = hard
failure (file stays `status: pending` so re-running after fixing the
gap is safe).

**Required tools** for `open-pr.sh` (install before any policy =
"agents create" run, and on any session that will publish a `pending`
file later):

- **`bash` 4+** — already present on macOS (3.2 ships by default; install
  4+ via `brew install bash`) and Linux.
- **`git`**.
- **[`yq`](https://github.com/mikefarah/yq)** (Mike Farah's Go binary —
  not the Python `yq` wrapper). Used to read/write the file's YAML
  frontmatter and parse the comments list.
- **[`jq`](https://stedolan.github.io/jq/)** — used to iterate the
  comment list and parse `gh` / `glab` JSON output.
- **One of [`gh`](https://cli.github.com)** (for GitHub) **or
  [`glab`](https://gitlab.com/gitlab-org/cli)** (for GitLab), authenticated.

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

The script bails early with `missing dependency: <name>` if any are
absent. If a runner can't install them (e.g. minimal CI image), the
project's PR policy must be set to "branches only" at bootstrap so §1f
skips the script — humans open PRs from the pushed branch.

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

Standalone re-invocation works at every step — kick `create-spec` again
when the requirements shift mid-plan, re-run `plan-feature` after
contract changes, restart `implement-plan` mid-feature (it picks up
from the tracking file, never re-runs completed phases).

## Uninstall

After the bootstrap is committed, remove the skills:

```bash
npx vinta-ai-workflows uninstall --tool all
```

Then drop the package itself:

```bash
npm  uninstall @vinta/ai-workflows
pnpm remove    @vinta/ai-workflows
```

### What `uninstall` removes

The uninstaller is conservative on purpose:

- **Symlinks** are removed only if their target points back into the
  package's `skills/` directory (or the link is dangling).
- **Copied directories** are removed only if they contain the
  `.installed-by-vinta-ai-workflows` marker file.
- **Anything else** (hand-authored skills, third-party skills, files
  lacking the marker) is left in place with a warning.

Empty `.<vendor>/skills/` directories are removed after the last managed
entry leaves; the parent `.claude/`, `.agents/`, etc. are left alone since
they likely hold other content.

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

## Workflow recap

```bash
# 1. Add the package to the target project.
cd ~/code/my-new-project
npm install -D git+ssh://git@github.com:vinta/vinta-ai-workflows.git

# 2. Install the skills your tool reads.
npx vinta-ai-workflows install --tool claude-code

# 3. Open the project in the AI tool. Run the bootstrap.
#    Claude Code → /vinta-bootstrap-ai-tools

# 4. Review and commit the generated ai-tools/ layout.
git add ai-tools/ AGENTS.md .claude/ .codex/ .cursor/ .github/ .agents/
git commit -m "Bootstrap ai-tools layout"

# 5. Uninstall the builder skills (one-shot done).
npx vinta-ai-workflows uninstall --tool claude-code
npm uninstall @vinta/ai-workflows

# Later, when this package gains new versions:
# 6. (optional) Re-install + run vinta-update-project-skills to refresh
#    the project's generated skills against the latest source.
npm install -D git+ssh://git@github.com:vinta/vinta-ai-workflows.git
npx vinta-ai-workflows install --tool claude-code \
  --skills vinta-update-project-skills
# Then in Claude Code: /vinta-update-project-skills
```

## Updating skills in this repo

If you modify a `vinta-*` skill source under `skills/`:

- **Symlink installs** (default): consumers get updates as soon as their
  `node_modules/@vinta/ai-workflows/` refreshes (next `npm install` /
  `git+ssh` re-pull).
- **Copy installs** (`--copy`): consumers must re-run `vinta-ai-workflows update`
  with the same flags. The CLI removes the previous copy and writes fresh
  content + marker.

To refresh **project-generated** skills (the ones under the project's
`ai-tools/skills/` produced by `vinta-derive-skills`), use
`vinta-update-project-skills` from the AI tool.

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

Project scope only — there is no user-scope mode. The `vinta-` skills are
intended to bootstrap a single project at a time and then come back out.
