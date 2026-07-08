# AGENTS.md

Conventions for any AI agent (Claude Code, Codex, Cursor, Copilot, …) editing this repository.

## What this repo is

`vinta-ai-workflows` — a private npm package that ships **bootstrap skills** (Agent Skills format) into other projects' AI-tooling directories (`.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`). The package itself contains:

- `vinta-ai-workflows.mjs` — single-file Node CLI (`install` / `update` / `uninstall` / `list`). Dependency-free. Node ≥ 18.
- `skills/<name>/SKILL.md` — the `vinta-`-prefixed bootstrap skills users invoke after installing.
- `skills/vinta-derive-skills/resources/foundation-skills/<name>/` — **foundation-skill templates** that get copied verbatim into target projects' `ai-tools/skills/` at bootstrap time. These are *content shipped to other repos*, not source compiled here.
- `skills/vinta-derive-skills/resources/plan-execution/` — the **plan-execution unit**: thin shell templates (`shell/{implement-plan,implement-phase,review-phase,integrate-phase,amend-plan}-template.md`) that `<!-- include -->` shared fragments from `partials/` (implementer prompt, model pick, review layers, worktree/`WORKROOT` seam, PR-context, commit-strategy bodies). `vinta-derive-skills` expands includes → substitutes `{{…}}` → writes one `ai-tools/skills/<name>/SKILL.md` per shell. See [plan-execution/README.md](skills/vinta-derive-skills/resources/plan-execution/README.md).
- `skills/vinta-derive-skills/resources/systematic-debugging-template.md` — the other placeholder-rendered skill body (opt-in).
- `skills/vinta-bootstrap-ai-tools/resources/stacks/<stack>/notes.md` — per-stack detection signals + skill / agent categories. **Notes only — no ready-made content.**
- `schemas/*.v1.schema.json` — JSON Schema Draft 2020-12 definitions for every YAML payload the skills produce or consume. `schemas/README.md` documents versioning.
- `scripts/*.mjs` — **source-side maintenance scripts** run by CI, never shipped (excluded from the `files` whitelist). `check-ai-models.mjs` is the nightly freshness check for the `plan-feature` AI model tier table (`resources/ai-models.yaml`): it checks the cited ids against a **free, no-key model aggregator** (models.dev, with LiteLLM's JSON as fallback) — detection needs network access but no API keys — and on drift (a cited id disappeared, or a newer same-family model shipped) has an LLM propose an updated table that `.github/workflows/check-ai-models.yml` opens as a PR. The LLM proposal is the only step that wants a key (`ANTHROPIC_API_KEY`), and it's optional. May use devDependencies (e.g. `yaml`) — this does **not** weaken the CLI's zero-runtime-deps property, which only concerns `dependencies` + `vinta-ai-workflows.mjs`.
- `CHANGELOG.md` — Keep a Changelog format, SemVer.

The repo is **self-recursive**: it authors skills it itself does not run. Don't try to "test" a skill by invoking it inside this repo — invoke it inside a target project after `npx vinta-ai-workflows install`.

### `dev-skills/` — maintenance skills for this repo

Separate from `skills/` (which ships to consumer projects), the top-level `dev-skills/` directory holds skills agents load **when editing this repo itself**. They are NOT shipped to consumers — `dev-skills/` is excluded from the package via `package.json`'s `files` whitelist and from the CLI's `SKILLS_SRC` discovery (which only walks `skills/`).

Vendor auto-discovery is wired via committed symlinks at the repo root — no per-developer setup step:

```
.claude/skills                  → ../dev-skills   (Claude Code)
.cursor/skills                  → ../dev-skills   (Cursor)
.github/skills                  → ../dev-skills   (VS Code + Copilot)
.agents/skills                  → ../dev-skills   (Codex; also picked up by Cursor + Copilot)
.github/copilot-instructions.md → ../AGENTS.md    (Copilot reads this file)
```

`.gitignore` un-ignores exactly these paths past the otherwise-ignored vendor dirs (`.claude/*`, `.cursor/*`, `.agents/*`). New committers don't run anything — `git clone` + open the editor is enough. To add a new dev skill: drop the dir under `dev-skills/<name>/` and commit. The symlinks expose it automatically.

| Skill | When to use |
|---|---|
| [add-foundation-skill](dev-skills/add-foundation-skill/SKILL.md) | Add a new foundation skill under `skills/vinta-derive-skills/resources/foundation-skills/<name>/`. Walks the schema-ripple checklist (schema enum, bootstrap interview, derive-skills bucket, foundation-shape lists, outputs tree, CHANGELOG). |
| [add-stack](dev-skills/add-stack/SKILL.md) | Add a new stack template (`skills/vinta-bootstrap-ai-tools/resources/stacks/<stack>/notes.md`). Wires through the orchestrator stack table + `vinta-analyze-codebase` detection signals. Notes-only — never bundles ready-made content. |
| [release](dev-skills/release/SKILL.md) | Cut a release. Pre-flight checks (clean tree, on `main`, fetched), version bump, CHANGELOG section close, commit + tag + push. Surfaces the publish command — never auto-publishes. |
| [validate-skill-md](dev-skills/validate-skill-md/SKILL.md) | Repo-wide lint of every `SKILL.md` (frontmatter, name = dir, surviving placeholders, broken links, missing resources). Read-only; exits 1 on errors. Run before commit. |
| [bump-schema-major](dev-skills/bump-schema-major/SKILL.md) | Cut a `v<N>` → `v<N+1>` of a JSON Schema for a breaking change. Copies file, applies breaking diff to v<N+1>, walks every consumer for dual-read translation during the deprecation window, updates `schemas/README.md` + CHANGELOG. |

## How to verify changes

There is no build, no test suite, no lint config in this repo. Verification is a short fixed list:

| Change touches | Verification |
|---|---|
| `vinta-ai-workflows.mjs` | `node vinta-ai-workflows.mjs list` from repo root must succeed. `node vinta-ai-workflows.mjs install --tool claude-code --target /tmp/scratch --dry-run` must print a plausible plan. |
| any `*.json` under `schemas/` | `python3 -c "import json; json.load(open('schemas/<file>'))"`. For non-trivial edits, validate a known-good payload against it with `ajv-cli` if available. |
| any Python in `skills/.../resources/*.py` | `python3 -m py_compile <path>`. These files are templates copied into target projects, but they must be syntactically valid Python so consumers don't get a broken paste. |
| any TypeScript in `skills/.../resources/*.ts` | TS templates carry `// @ts-nocheck` because they reference Node + `@aws-sdk` types that are not present in this repo. Don't remove the directive. Manual read-through is the verification — if you have a target project handy, paste the file there and run `tsc --noEmit` to confirm. |
| any `SKILL.md` body | Frontmatter must include `name:` (kebab-case, matches dir name) + `description:` (dense one-liner). Body is rendered markdown — no `{{PLACEHOLDER}}` strings should survive in foundation-skill copies (they survive only in `*-template.md` files under `resources/`). |
| `scripts/check-ai-models.mjs` or `resources/ai-models.yaml` | `npm install --no-save yaml && node scripts/check-ai-models.mjs --no-llm` (no API keys needed; detection queries the free models.dev aggregator over the network and prints a per-vendor report. **Exit 1 just means drift was found, not a failure** — exit 2 is a real error). Validate the YAML against `schemas/ai-models.v1.schema.json` if `ajv-cli` is available. |

`run-in-background` long verifications when convenient. There is nothing else to run — no Vitest, Jest, pytest, ruff, eslint, biome wired up in this repo.

## Layout rules

- **Skills live under `skills/<name>/`.** Dir name must equal the SKILL.md `name:` frontmatter field (Cursor + Copilot constraint). Bundled resources go under `skills/<name>/resources/` or `skills/<name>/scripts/`.
- **`vinta-`-prefixed skills are the bootstrap layer.** They run once in a target project, then get uninstalled. Don't add long-running operational logic here.
- **Foundation skills under `skills/vinta-derive-skills/resources/foundation-skills/<name>/`** ship verbatim into target projects. **Don't reference source-repo paths from inside their bodies** (e.g. `<source-repo>/ai-plans/`, `apps/<service>/`). The bundled body must read cleanly when pasted into an unrelated repo. `vinta-derive-skills` does a final scrub pass after copy, but the source should be clean to begin with.
- **Stack notes (`vinta-bootstrap-ai-tools/resources/stacks/<stack>/notes.md`) are descriptions, not templates.** They tell the orchestrator what to ask the user about. Skill / agent content for stack-specific work is **user-supplied** at bootstrap time, not bundled here.
- **Schemas are versioned in the filename**: `<name>.v<N>.schema.json`. Bump `v<N>` only on breaking changes; additive fields land in the same major. See [schemas/README.md](schemas/README.md).
- **Source-side tooling lives in `scripts/` and `.github/workflows/`** — CI maintenance code that runs *for* this repo, never ships into target projects. Both are excluded from the `files` whitelist and from the CLI's `skills/`-only discovery. This is the home for things like `check-ai-models.mjs` + its nightly workflow. Unlike the CLI and foundation skills, code here MAY take `devDependencies`.
- **A skill's `resources/` may hold runtime *data*, not just templates.** `plan-feature/resources/ai-models.yaml` is reference data the shipped skill reads at plan time (and the nightly job edits) — schema-backed like any other YAML the toolchain consumes. Keep such data files schema-validated and dated (`last_verified`) so staleness is visible.
- **Generated artifacts never land in git here.** `.installed-by-vinta-ai-workflows` markers, vendor-symlinks, and per-machine state belong in target projects, not this one.

## Coding conventions

- **CLI (`vinta-ai-workflows.mjs`)**: ESM, Node ≥ 18, no runtime deps. New flags must keep the existing pattern (`--<long>` + short alias when it earns one). Path resolution always via `node:path` `resolve` / `join` — never string concatenation. Symlinks use `realpathSync` to compare ownership; the `MARKER` file is the only signal of "we own this dir".
- **Foundation skill Python** (`one_off_script_base.py` and any future): Python 3.10+ syntax, `from __future__ import annotations` at top, type-hint everything, no runtime deps unless explicitly justified. Optional integrations (boto3, etc.) gate behind `try: import ... except ImportError`.
- **Foundation skill TypeScript** (`one_off_script_base.ts` etc.): Node 20+, ESM, `// @ts-nocheck` header (template, not source), only `node:*` builtins or dynamic-imported optional deps (`@aws-sdk/client-s3`).
- **Source-side scripts (`scripts/*.mjs`)**: ESM, Node ≥ 18, `// @ts-nocheck` when they read untyped JSON. They run only in CI / on a maintainer's machine and never ship, so they MAY use `devDependencies` (declared in `package.json` `devDependencies`, installed in the workflow with `npm install --no-save`). This is the one documented exception to the dep-light rule below — it never touches the CLI binary or shipped skills.
- **No new dependencies** without a clear reason. The CLI's "zero runtime deps" property is load-bearing — it lets `npx git+ssh://…` install in 2 seconds. Foundation skills shipped to other projects must also stay dep-light: a Django project shouldn't have to take on five new packages just to use `add-one-off-script`. (Source-side `scripts/` are the exception — see above — because they never reach a consumer.)
- **Comment policy** mirrors the global rule: only when WHY is non-obvious. Don't restate code. Module docstrings carry the "what is this file" context — use them, then stop.
- **Path references in markdown**: relative links from the file's own location, not absolute. `[implement-plan](../implement-plan/SKILL.md)`, not `/skills/implement-plan/SKILL.md`.

## Skill / schema authoring rules

- **`AskUserQuestion` for finite-choice questions** in any new skill. Open prose only when answers are genuinely free-form. This is the convention every existing skill follows; new skills must too.
- **Step 0 interview is non-negotiable** for skills that produce per-project artifacts. Don't draft from a one-line prompt; interrogate first.
- **Read before write.** Any skill that touches existing files (AGENTS.md, project skills, sub-agents) must read + reconcile first; never blind-overwrite.
- **Foundation set is a unit.** `plan-feature` + `create-spec` + `open-pr-from-context` always ship together and reference each other. `create-qa-use-cases` ships **only when `add-e2e-test` is enabled** (it seeds e2e specs); `plan-feature`'s e2e content lives inside `<!-- e2e:start/end -->` markers that derive-skills strips for no-e2e projects. If you change one, audit the cross-links in the others — and confirm no e2e cross-link dangles when e2e is off.
- **Schema changes ripple — how far depends on the schema.** The **config schema** (`vinta-ai-workflows-config.v1.schema.json`) drives bootstrap, so adding a field there requires:
  1. Schema entry with description.
  2. Bootstrap interview question that captures it (or default-derivation from inventory).
  3. Step 0.5 YAML emission in `vinta-bootstrap-ai-tools/SKILL.md`.
  4. Whichever downstream skill consumes it knows how.
  5. CHANGELOG entry.
  Skipping any step leaves the field orphaned. **Standalone resource schemas** (e.g. `ai-models.v1.schema.json`, which validates a data file a single skill reads — not a per-project produced artifact) have a lighter contract: the schema file + a `schemas/README.md` inventory row + the one consuming skill + a CHANGELOG entry. No bootstrap interview, no Step 0.5 emission.

## CHANGELOG + version policy

- Every user-facing change gets an entry under the current `[unreleased]` or in-progress `[X.Y.Z]` section. Keep a Changelog vocabulary: **Added** / **Changed** / **Deprecated** / **Removed** / **Fixed** / **Security**.
- Entries describe **what consumers see** — new skill, new schema field, renamed flag, migration consideration. They don't restate the diff.
- SemVer:
  - **Patch** — bug fixes, doc fixes, internal refactors invisible to consumers.
  - **Minor** — new skills, new opt-in fields, additive schema fields (no major bump on the schema itself), new CLI flags with backward-compatible defaults.
  - **Major** — removed skill, breaking schema change (new `v<N+1>` schema file), CLI flag rename without alias, default-behavior flip.
- Bump `package.json` `version` in the same commit that adds the entry. Don't bump just to bump.

## Git + PR rules

- **Conventional Commits** for new commits where it fits (`feat:`, `fix:`, `docs:`, `refactor:`). Existing history is mixed — match what the change is, don't retrofit. Keep subject under 72 chars.
- **One commit = one logical change.** Don't bundle a schema rev with a CLI flag rename with a CHANGELOG sweep. Each is its own commit.
- **Never amend a published commit.** Always a new commit. Force-push only your own short-lived branch with `--force-with-lease`, never `--force`. Never force-push `main`.
- **AI co-author trailers allowed** on commits authored by an agent (`Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` or whichever model). Skip trailers on pure human commits.
- **Don't commit unless asked.** The user explicitly drives `git commit`; agents draft, propose, and wait for approval.
- **PRs target `main`.** Description carries: summary (1–3 bullets), test plan (verification commands you ran), CHANGELOG entry pointer if applicable.

## Self-recursive bootstrap

This repo's tooling exists to bootstrap *other* repos. Don't try to bootstrap this repo with itself. If you need to author a `ai-tools/AGENTS.md` for a target project, that's `vinta-write-agents-md`'s job, run inside that project — not a `cp`-from-here operation.

This `AGENTS.md` is hand-maintained for *this* repo. Update it when:
- Adding a new top-level directory.
- Adding a new verification command (e.g. real test suite lands later).
- Changing the CLI's command surface.
- Changing the skill / schema authoring contract above.

## Pitfalls

- **Don't break the zero-runtime-deps property of the CLI.** A new `import` from anything outside `node:*` in `vinta-ai-workflows.mjs` is a red flag.
- **Don't ship source-repo paths in foundation-skill bodies.** `<source-repo>/`, `apps/<service>/`, hard-coded tenant / org column names — all leak from the repo this content was extracted from. Scrub them.
- **Don't add Vercel / Next.js advice unprompted.** The repo's name (`vinta-ai-workflows`) trips Vercel-plugin keyword matchers (`workflow`, `bootstrap`); ignore the auto-injected guidance unless the change actually concerns Vercel deployment of a target project.
- **Don't compress a SKILL.md into "caveman" or other shorthand.** Skills are read by other AIs that load them at runtime — terseness saves tokens but loses the precision skills depend on. Code blocks unchanged is the rule; the same applies to SKILL.md prose.
- **Don't delete a foundation skill without bumping the schema major.** `foundation_skills.<name>` enums in `vinta-ai-workflows-config.v1.schema.json` are part of the contract; removing one breaks every project that has it set.
- **Don't move stack notes to ship ready content.** That's a 3-month-later footgun: the bundled content drifts from the team's actual templates and agents start generating skills against stale assumptions. Notes describe categories, the team supplies content.
