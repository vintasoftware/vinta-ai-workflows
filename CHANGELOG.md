# Changelog

All notable changes to `vinta-ai-workflows` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — YYYY-MM-DD

<!-- pre-release: 0.2.0-alpha3 on 2026-06-23 -->

### Added

- **`plan-feature` AI model tier table extracted to a data resource +
  nightly freshness job.** The per-tier model recommendations that used to
  be hard-coded in `plan-feature/SKILL.md` now live in
  `plan-feature/resources/ai-models.yaml` (ships verbatim with the skill;
  schema: `schemas/ai-models.v1.schema.json`). The SKILL.md body keeps the
  *tier-selection rubric* (stable judgement) and points at the resource for
  concrete model IDs, so the prose no longer goes stale. A source-side
  nightly GitHub Action (`.github/workflows/check-ai-models.yml`, runner
  `scripts/check-ai-models.mjs`) checks the cited IDs against a **free,
  no-key model aggregator** (models.dev, LiteLLM JSON as fallback) — no
  vendor API keys required — flags IDs that disappear or that a newer
  same-family model has superseded, and on drift has an LLM propose an
  updated table that it opens as a reviewable PR (the optional LLM step is
  the only one that uses a key). **Consumers**: re-sync the
  `plan-feature` skill to pick up a refreshed table; the resource's
  `last_verified` date signals how current it is.

- **`prepare-worktree` — OS-level filesystem sandbox that *prevents*
  stray main-checkout writes (harness-agnostic).** The prompt instruction
  "stay in the worktree" is cooperative only; a smaller phase subagent can
  resolve a path back to the main checkout and silently write there. A new
  bundled script `prepare-worktree/scripts/sandbox-run.sh` confines the
  *process* (not the agent tool) at the kernel layer — `sandbox-exec` on
  macOS, `bwrap` (bubblewrap) on Linux — using a **deny-main, allow-rest**
  model: the whole filesystem stays writable except the main checkout, with
  the worktree (nested under it) and `.vinta-ai-workflows` punched back to
  writable, so package managers / caches / `$HOME` behave normally and no
  per-stack allowlist tuning is needed. A stray main-checkout write fails
  with `Operation not permitted` / `EROFS` regardless of which harness
  (claude-code, Codex, …) issued it. `prepare-worktree` adds a capability
  probe + a `sandbox` block in its summary YAML recording the achieved tier
  (`enforced` / `none`); `implement-plan` wraps each subprocess subagent
  spawn in the script when `sandbox_tier = enforced`, threads the tier
  through tracking + the re-running-mid-plan resume path, and downgrades its
  existing Layer 1 stray-write check from sole defense to a backstop. On
  machines without a sandbox tool (`tier = none`) the script runs the
  command unsandboxed with a loud warning and the Layer 1 check remains the
  guard. Escape hatch: `VINTA_SANDBOX=off`. **Consumers**: re-sync
  `prepare-worktree` + `implement-plan` to pick up the guard; the whole
  `prepare-worktree/` dir now ships (SKILL.md + `scripts/sandbox-run.sh`),
  so re-run the foundation-skill copy, not just the SKILL.md.

### Changed

- **`plan-feature` — per-phase PR-size target raised from ~100–300 LoC to
  up to 1500 LoC** (tests included). The old "reviewer reads the diff in
  30 minutes / ~100–300 LoC" guidance forced excessive phase splitting:
  trivial use-cases became standalone PRs and the phase count ballooned
  past what a reviewer wants to track. The new ceiling — "reviewer reads
  ≤1500 LoC and understands the phase in isolation" — keeps phases
  MR-sized and single-concern while letting a coherent unit of work land
  in one PR. Pairs with the new **Phase granularity** Step 0 choice
  below: bundled phases also cap at 1500 LoC. Plan-shape checklist
  updated to match.

- **`plan-feature` — "one use-case per phase" is now a Step 0 choice, not
  a hard mandate.** Added a **Phase granularity** question to the Scope
  group (default: one use-case per phase). The rule, its apply-even-when
  list, and the checklist item now branch on the answer — opting into
  bundling lets closely-related use-cases share a phase as long as each
  phase stays MR-sized, single-concern, and independently mergeable.

- **E2E content is stripped from no-e2e projects.** `create-qa-use-cases`
  now ships **only when `add-e2e-test` is enabled** (it seeds e2e specs),
  and `plan-feature`'s Playwright / `QA_USE_CASES.md` / `pr-screenshots/`
  sections are wrapped in `<!-- e2e:start/end -->` markers that
  `vinta-derive-skills` strips when `add-e2e-test` is disabled. The
  bootstrap `add-e2e-test` answer now also sets
  `foundation_skills.create-qa-use-cases`. Result: projects marked as
  having no e2e tests get foundation skills with zero e2e references.
  
<!-- pre-release: 0.2.0-alpha2 on 2026-06-13 -->

### Changed

- **Fixed bug on setup-ai-tools.mjs**: Sub agents were being generated 
with an invalid description and were not being loaded by claude-code and 
possibly other AI tools.

- **`implement-plan` template — stray main-checkout-write guard (only
  when `run_options.use_worktree = true`).** A subagent told to work
  inside the worktree can resolve an absolute path back to the **main
  checkout** and silently edit files there; because worktrees have
  independent working trees those edits never reach the phase commit —
  they sit as uncommitted thrash in the main checkout and read as a
  silent implementer/fixer failure. Layer 1 mechanical checks gain a new
  item: after **every** implementer **and** fixer subagent returns, run
  `git -C <main-checkout-path> status --short | grep -vE '^\?\?'`
  (tracked modifications only); any output is a BLOCKER — recover intent
  via `git -C <main-checkout-path> diff`, re-dispatch the agent with an
  explicit worktree-path instruction if the change belongs there, then
  `git -C <main-checkout-path> restore` so the main checkout returns
  clean between phases. `<main-checkout-path>` is the repo root the skill
  was invoked from, never `run_options.worktree_path`. Skipped entirely
  when `use_worktree = false`. Mirrored in the per-phase Quick checklist
  Layer 1 line and a new **Important rules** bullet.

<!-- pre-release: 0.2.0-alpha1 on 2026-06-12 -->

### Added

- **Third-party dependency license policy captured at bootstrap, surfaced
  to AI agents at implementation time.** `vinta-bootstrap-ai-tools` Step 0
  group **C. Project conventions** gains question 7 — enforcement
  (`block` (default) / `warn` / `off`), a confirm-and-edit prompt for the
  forbidden SPDX list (seed: `GPL-2.0-only`, `GPL-3.0-only`,
  `AGPL-3.0-only`, `SSPL-1.0`), per-package overrides, and free-form
  notes. Captured in a new `policies.dependency_licenses` block of
  `vinta-ai-workflows-config.v1.schema.json`. Consumers:
  - `vinta-write-agents-md` renders a new **Dependency licenses** section
    in `ai-tools/AGENTS.md` (enforcement mode + forbidden list + approved
    overrides table + notes + pre-install check pointers like
    `npm view <pkg> license`, PyPI metadata, etc.).
  - `vinta-derive-skills` substitutes three new placeholders into the
    `implement-plan` + `amend-plan` templates: `{{DEPENDENCY_LICENSE_BLOCK}}`
    (top-level "Adding new third-party dependencies" section directly
    before Working instructions — canonical body at
    [vinta-derive-skills/resources/dependency-license-block.md](skills/vinta-derive-skills/resources/dependency-license-block.md)),
    `{{DEPENDENCY_LICENSE_LAYER1_CHECK}}` (reviewer Layer 1 mechanical
    check that greps the manifest diff for forbidden licenses), and
    `{{DEPENDENCY_LICENSE_RULE_LINE}}` (an Important-rules bullet).
  All three placeholders render the empty string when
  `enforcement: off` or the config block is absent — projects that opt
  out get no extra prose in their rendered skills. `enforcement: block`
  refuses the install + asks the user to acknowledge before recording an
  `allowed_overrides[]` entry and re-running; `warn` proceeds but flags
  in the phase report. **Missing / `UNKNOWN` / undeclared license is
  always handled as a stop-and-ask, regardless of enforcement mode** —
  unknown ≠ permissive, so the subagent surfaces the gap (registry
  lookup output, upstream URL) and asks the user to pick `skip the dep`
  / `treat as forbidden` / `record an `allowed_overrides` entry with an
  off-channel-confirmed SPDX`. Same behaviour reinforced in the Layer 1
  reviewer check: undeclared license = BLOCKER, no enforcement-mode
  downgrade.
  
- **New `policies.commit_strategy` field in `.vinta-ai-workflows.yaml`**
  (`stacked-branches` | `modular-commits` | `ask`, default
  `stacked-branches`). Drives how the rendered `implement-plan` skill
  structures branches and commits across phases:
  - `stacked-branches` — current behavior. One branch + one PR per
    phase, stacked on top of each other.
  - `modular-commits` — one branch + one PR for the whole plan; each
    phase contributes multiple atomic commits (one per logical unit:
    service, use-case wire-up, init/exports, serializer field,
    refactor, fix). Tests travel in the same commit as the code they
    test. The commit list becomes a table of contents for reviewers.
  - `ask` — `implement-plan` prompts the user at Step 0 (alongside
    `pause_between_phases` / `generate_inline_comments`) and caches the
    resolved value in `TRACKING_{plan-id}.md` under
    `run_options.commit_strategy_resolved`.
  Additive on schema v1 — existing configs without the field default
  to `stacked-branches` at read time (backward-compatible). Bootstrap
  interview captures the answer in **C. Project conventions**.

- **New optional foundation skill: `prepare-worktree`** (copied verbatim
  to `ai-tools/skills/prepare-worktree/SKILL.md` per project, opt-in via
  the bootstrap **Optional foundation skills** interview, new
  `prepare-worktree` question). Source:
  [skills/vinta-derive-skills/resources/foundation-skills/prepare-worktree/SKILL.md](skills/vinta-derive-skills/resources/foundation-skills/prepare-worktree/SKILL.md).
  Provisions a fully-runnable git worktree for parallel feature work so a
  long-running plan (or experiment) can build, test, lint, migrate, and
  hit databases without disturbing the main checkout — or other parallel
  worktrees on the same machine. Walks the project's `.gitignore` +
  package manifests + env templates + docker config and decides per
  ignored path whether to **symlink** (read-only-ish reuse), **copy**
  (defensive, when the feature mutates the path), or **fork** (state
  that would corrupt main if shared — dev DB, test DB, docker-compose
  project name). Reads the active plan to bias decisions: dep churn
  flips dep dirs to copy/reinstall; migrations flip the dev DB to fork
  and run them once; new env vars flip `.env` from symlink to copy +
  mutate; compose changes flip the network strategy. Drops a per-worktree
  summary YAML at `.vinta-ai-workflows/worktrees/<name>.yaml` + a
  `WORKTREE.md` at the worktree root so teardown is mechanical (no
  decision lives only in conversation memory). Bucket A (copy verbatim) —
  body is project-agnostic; per-project variability lives in
  `skills.prepare-worktree.*` config (worktree root, deps strategy,
  compose-network strategy, test-DB strategy, summary dir).

- **`implement-plan` Step 0 question (c) — "Run phases in a worktree?"**.
  New opt-in: when the user picks `Yes`, the orchestrator runs
  `prepare-worktree` **once** at the start of the plan (new
  **Provision worktree** step between Step 0 and Step 1), records
  `worktree_path` / `worktree_branch` / `worktree_summary` in the
  tracking file, and threads them into every phase's subagent prompt +
  every `git` call in the **Branch + push** step. **One worktree per
  plan run** — every phase branch stacks inside the same worktree; the
  skill never provisions a second one mid-plan. Mid-plan resumes detect
  the worktree from tracking and reuse it (asking only when the worktree
  is missing). When `foundation_skills.prepare-worktree` is `disabled`,
  the question is skipped and `run_options.use_worktree` is forced to
  `false` with a one-line note pointing at `vinta-sync-ai-tools` to
  enable later. Failure modes are explicit — prepare-worktree errors
  never fall back silently to the main checkout; the user picks `Retry`
  / `Run in main` / `Stop`.

- **`.vinta-ai-workflows.yaml` config additions for `prepare-worktree`**:
  - `foundation_skills.prepare-worktree: enabled | disabled` — sticky
    opt-in like every other foundation skill.
  - `skills.prepare-worktree.worktree_root: string` (default
    `.claude/worktrees` for claude-code-primary projects;
    `../<repo>-wt-` sibling-dir layout otherwise) — where new worktrees
    land. The skill resolves `<root>/<name>` per provisioning call.
  - `skills.prepare-worktree.deps_strategy: symlink | copy | reinstall`
    (default `symlink`) — default for dep dirs (`node_modules/`,
    `vendor/`, `venv/`) when the active plan does NOT install new deps.
    The skill auto-flips to `reinstall` when it detects dep churn in the
    plan body.
  - `skills.prepare-worktree.compose_network: per-worktree | shared-external | host`
    (default `per-worktree`) — docker-compose networking strategy.
    `shared-external` joins an externally-declared network so the
    worktree can reach main's compose services (queues, caches, search
    indexes that are expensive to spin twice).
  - `skills.prepare-worktree.test_db_strategy: fork-on-schema-change | always-fork | share`
    (default `fork-on-schema-change`) — when to fork the test DB per
    worktree. `share` is only safe for solo work (parallel runs flake).
  - `skills.prepare-worktree.summary_dir: string` (default
    `.vinta-ai-workflows/worktrees`) — where per-worktree summary YAMLs
    land. Covered by the umbrella `.vinta-ai-workflows/` gitignore.
  - `run_options.implement-plan.use_worktree: boolean` (default
    `false`) — suggested default shown for the Step 0 question (c)
    above; per-run prompt always asks. Flipped to `true` at bootstrap
    when the user opts in via the `prepare-worktree` follow-up.

- **Bootstrap interview — new `prepare-worktree` question** under
  **Optional foundation skills**, plus four short follow-ups (worktree
  root, default deps strategy, default test-DB strategy, and the
  `implement-plan` default for question (c)). The **Optional foundation
  skills** opener switched from "four skills" to "five skills"
  accordingly. Outputs tree updated to list
  `ai-tools/skills/prepare-worktree/SKILL.md` as an opt-in foundation
  skill. The **Existing AI artifacts** disposition flow's
  `foundation-shape` name list (which gates the
  `Replace with Vinta foundation version` option) gained
  `prepare-worktree`.

- **`vinta-derive-skills` — Always copy bucket** gains a row for
  `prepare-worktree` (verbatim copy). The **Optional — ask the user**
  bucket also gets a row covering the opt-in interview + the four
  follow-ups; this is the same compose pattern as `add-one-off-script`
  (verbatim copy, gated by ask-first). Foundation-shape lists in both
  "Reconcile against existing skills" + Rules sections extended with
  `prepare-worktree`.

### Changed

- **`implement-plan` template**: the Step 0 opt-in questions block grew
  from two questions to three (added (c) for worktree opt-in); a new
  **Provision worktree** step sits between Step 0 and Step 1; the
  per-phase prompt (`Prepare agent prompt` step) carries a worktree
  block when `use_worktree = true`; the `Branch + push` step's branch
  and push commands now prefix with `git -C <worktree_path>` when
  applicable; tracking schema (`Update tracking file` step) gains
  `run_options.worktree_path` / `worktree_branch` / `worktree_summary`;
  Re-running mid-plan flow learned to detect + reuse the worktree;
  Step 2 final report surfaces the teardown command (never auto-runs
  it). Three new entries in the **Important rules** section codify the
  one-worktree-per-plan-run invariant + the no-silent-fallback rule.

## [0.1.7] — 2026-06-01

### Added

- **`DESIGN.md` detection + Cursor Project Rules wiring during bootstrap.**
  `vinta-bootstrap-ai-tools` Step 0 gains group **F. Design system doc
  (`DESIGN.md`)**: if a `DESIGN.md` exists at the repo root, the
  orchestrator asks via `AskUserQuestion` whether to wire it into AI
  tooling (`Keep and wire into AI tooling` (recommended) /
  `Keep as-is, don't reference` / `Drop`). The file itself is never
  overwritten — the team owns its contents. When `wired`:
  - `vinta-write-agents-md` inserts a "Design system" section in
    `ai-tools/AGENTS.md` pointing at `DESIGN.md`.
  - `vinta-install-ai-tools-setup` writes `.cursor/rules/design.mdc`
    with the frontmatter + body from
    [Design.md with Cursor — Option A: Project Rules (recommended)](https://designmd.app/blog/design-md-with-cursor/)
    so Cursor auto-loads the design system before generating UI files.
    Only emitted when `cursor` ∈ `vendors`. Globs default to
    `**/*.tsx`, `**/*.jsx`, `**/*.vue`, `**/*.svelte`, `**/*.astro`,
    `**/*.css`; the orchestrator asks once before shipping defaults
    when the analysis surfaced a UI framework not covered.
  Disposition lands in a new `project.design_md: wired |
  kept-unreferenced | absent` field of `.vinta-ai-workflows.yaml`.
  Outputs tree updated to show `DESIGN.md` preserved at repo root and
  `.cursor/rules/design.mdc` (conditional). New top-level rule added
  to the orchestrator: **`DESIGN.md` is sacrosanct** — read-only at
  all times; only the sibling Cursor pointer is ever written.

### Changed

- **`implement-plan` template rendered with new
  `{{COMMIT_STRATEGY_*}}` placeholder family.** Branch naming, per-phase
  push, subagent commit instructions, PR-open timing, tracking-file
  branch field, and final-report branch summary now swap based on
  `policies.commit_strategy`. Under `ask`, both code paths render in
  the same body gated by `run_options.commit_strategy_resolved` —
  mirrors the existing `pause_between_phases` /
  `generate_inline_comments` opt-in pattern.
- **`amend-plan` refuses to run when
  `policies.commit_strategy != stacked-branches`** and points users at
  appending a new phase via `implement-plan` (or hand-crafting the
  rebase). Modular-commits amendment support is tracked as a follow-up
  — rewriting an arbitrary number of inline commits on a shared branch
  is out of scope for this release.

- **Replaced all `§N` shorthand cross-references with named section
  links across the repo.** `§1`, `§4.3`, `§1f`, `§A.3`, etc. were
  unreadable for humans (forced readers to flip back to the source doc
  and count headings) and brittle (broke as soon as section numbering
  shifted). Every reference now uses the section's full name — and a
  markdown anchor link when the link target is reachable — in:
  - README.md (plan structure, `Open PR via context file` matrix).
  - Bundled foundation skills under
    `skills/vinta-derive-skills/resources/foundation-skills/`
    (`plan-feature/SKILL.md`, `create-spec/SKILL.md`,
    `create-qa-use-cases/SKILL.md`, `add-one-off-script/SKILL.md`).
  - Template-rendered foundation skills
    (`implement-plan-template.md`, `amend-plan-template.md`,
    `prs-context-template.md`). The
    `amend-plan` `section-2-decision-change` change classification was
    renamed to `guiding-decisions-change` to follow suit.
  - Builder skills (`vinta-bootstrap-ai-tools`, `vinta-analyze-codebase`,
    `vinta-write-agents-md`, `vinta-derive-skills`,
    `vinta-derive-subagents`, `vinta-install-ai-tools-setup`,
    `vinta-sync-ai-tools`, `vinta-bootstrap-ai-tools/resources/stacks/README.md`).
  - JSON schemas (`vinta-ai-workflows-config.v1.schema.json`,
    `prs-context-comments.v1.schema.json`,
    `prs-context-frontmatter.v1.schema.json`).
  - Dev-skills (`add-foundation-skill`, `add-stack`).
  - Historical CHANGELOG entries (descriptions only — wording
    cleaned, no semantic change).

- **Added explicit "no `§N` shorthand" rules to every skill that drafts
  or renders documentation.** Each generator now refuses the pattern in
  the bodies it produces, so the fix sticks instead of drifting back in
  the next regeneration. Touched skills: `vinta-derive-skills` (Rules
  list), `vinta-analyze-codebase` (Rules list), `vinta-write-agents-md`
  (Style rules), `vinta-derive-subagents` (Rules list),
  `implement-plan-template.md` + `amend-plan-template.md` (Important
  rules sections), `prs-context-template.md` (new "Never use `§N`
  shorthand" section), `plan-feature/SKILL.md` (What to avoid),
  `create-spec/SKILL.md` (Style rules + Checklist).

## [0.1.6] — 2026-05-13

### Changed

- **Scrubbed source-repo path leaks from foundation skill bodies and
  illustrative examples across the repo.** The bundled foundation skills
  under `skills/vinta-derive-skills/resources/foundation-skills/`
  (`plan-feature/SKILL.md`, `create-spec/SKILL.md`) referenced paths,
  module names, table names, and worked-example plan filenames carried
  over from the project this content was originally extracted from
  (`core-service/ai-plans/`, `@core-service/app/core/common/feature_flags/feature_flags.py`,
  `lbd-integrations-data`, `sales_order` / `catalog_product`, `core.public_api`,
  `data_auditing`, `ProductSellingAccount.attributes`, `vw_sales_order_*`,
  `@app/core/sales/models/order.py`, `@tests/integration/sales/use_cases/`,
  and `BOOKMARKS` / `ORDER_TAGS` / `SHIPMENT_ATTRIBUTES` / `SELLTHROUGH`
  worked-reference plan filenames). All replaced with project-agnostic
  descriptions or generic placeholders (`ai-plans/`, `<source-repo>/`,
  `apps/<service>/`, `<app>/<module>/`, `WIDGETS`). The bundled skill
  bodies now read cleanly when pasted into an unrelated repo — no
  `vinta-derive-skills` scrub pass required for these particular leaks.
  Same scrub applied to meta-files that mentioned `core-service/` or
  `apps/provider-app/` as illustrative examples of "what gets leaked"
  (`AGENTS.md` + symlinked `.github/copilot-instructions.md`,
  `CHANGELOG.md` historical note, `dev-skills/add-foundation-skill/SKILL.md`
  + its four hardlinked installed copies under
  `.agents/.claude/.cursor/.github/skills/`,
  `skills/vinta-derive-skills/SKILL.md`,
  `skills/vinta-bootstrap-ai-tools/SKILL.md`,
  `skills/vinta-bootstrap-ai-tools/resources/stacks/django/notes.md`,
  `skills/vinta-bootstrap-ai-tools/resources/stacks/medplum/notes.md`,
  `skills/vinta-sync-ai-tools/SKILL.md`,
  `skills/vinta-migrate-plans-specs/SKILL.md`, and
  `schemas/vinta-ai-workflows-config.v1.schema.json` description). No
  schema change; no skill behavior change.

- **Second pass: genericized AWS / Strawberry / Shopify / FHIR examples
  in foundation skill bodies.** Five remaining stack-specific examples
  in foundation skills replaced with framework-neutral language:
  `plan-feature/SKILL.md`'s **Concurrency, transactions, idempotency**
  group, question 1 ("parallel Lambda on same row" → "parallel workers
  / serverless invocations on the same row"); the reusable-skills
  table's `create-lambda` row renamed to `create-cloud-function |
  scaffolds new serverless function`, and the `graphql-public-query`
  row dropped the Strawberry mention. `create-spec/SKILL.md`'s **Use
  cases** group, question 2 swapped "Webhook from Shopify, scheduled
  Lambda" for "Webhook from upstream SaaS, scheduled function".
  `create-qa-use-cases/SKILL.md` dropped the FHIR mention from the
  "no implementation details" rule. Reader still reads cleanly; no
  presumed stack. Other concrete platform mentions in the foundation
  set (Medplum / Vercel / K8s / Jupyter / Django in
  `add-one-off-script/SKILL.md`, Django/DRF/HStore/pytest in
  `plan-feature/SKILL.md` Tier 2) were reviewed and kept as
  illustrative examples per maintainer call.

- **README cheat sheet for foundation skills + sub-agents.** New
  "Cheat sheet — what lands in your project" section inserted between
  "The AI workflow after bootstrap" and "Staying in sync with upstream"
  in `README.md`. Two tables cover what `vinta-bootstrap-ai-tools`
  writes into a target repo's `ai-tools/` layout: the foundation skill
  set (`create-spec`, `plan-feature`, `create-qa-use-cases`,
  `open-pr-from-context`, `implement-plan`, `amend-plan`, plus the
  opt-in skills `systematic-debugging`, `add-e2e-test`, `add-env-var`,
  `add-one-off-script`) with a status column flagging always-on vs
  opt-in, and the foundation sub-agent trio (`implementer`, `reviewer`,
  `fixer`) with access mode + role. Two upfront disclaimers: optional
  foundation skills are gated by the bootstrap interview (recorded in
  `.vinta-ai-workflows.yaml` under `foundation_skills.*.enabled`,
  sticky across syncs); stack-specific skills and sub-agents are
  user-supplied — the package ships only detection signals + category
  lists per stack under
  `skills/vinta-bootstrap-ai-tools/resources/stacks/`, not the bodies.
  No content change; orients new readers before they read the workflow
  sections.

## [0.1.5] — 2026-05-08

### Added

- **README: prominent "Staying in sync with upstream" section** + sync
  pitch in `## Why this is useful`. The new top-level section lands
  between "The AI workflow after bootstrap" and "Running the bootstrap
  skills" and documents the two-step flow (`npm update` →
  `/vinta-sync-ai-tools` from the AI tool), the five classification
  buckets (`affects-project`, `opt-in-offer`, `config-schema-change`,
  `tooling`, `not-applicable`), the role of `.vinta-ai-workflows.yaml`
  as the opt-in source of truth, the per-change `Apply` / `Skip` /
  `Show diff` gating, and when to reach for `vinta-update-project-skills`
  vs the CLI `update` command instead. `## Why this is useful` gains a
  paragraph framing sync as a first-class capability of the package
  (project keeps getting better without re-bootstrapping; opt-outs
  sticky; schema migrations automatic). The `## Update` section gets a
  callout pointing at the new section + a step 3 in its workflow that
  invokes `vinta-sync-ai-tools`. Stale references in the intro
  paragraph and the "Repo internals" section that framed
  `vinta-update-project-skills` as the primary upstream-refresh path
  now point to `vinta-sync-ai-tools`. No skill behavior change.

### Changed

- **Renamed builder skill `vinta-ai-workflows-sync` → `vinta-sync-ai-tools`.**
  Directory moved from `skills/vinta-ai-workflows-sync/` to
  `skills/vinta-sync-ai-tools/`; SKILL.md frontmatter `name:` updated;
  every prose + link reference across the repo (other skill bodies under
  `skills/`, dev-skills, schemas/README.md inventory row, schema
  descriptions in `vinta-ai-workflows-config.v1.schema.json`) repointed
  to the new name. New name reads as a verb-object pair matching its
  sibling `vinta-bootstrap-ai-tools` and avoids embedding the package
  name twice. No behavior change.

## [0.1.4] — 2026-05-06

### Fixed

- **Repository URL typo** across README, `package.json`, and every
  `schemas/*.schema.json` `$id` + the schema directive examples in
  `schemas/README.md`: `git@github.com:vinta/vinta-ai-workflows.git` →
  `git@github.com:vintasoftware/vinta-ai-workflows.git`. The `vinta`
  GitHub org doesn't exist; the package lives under `vintasoftware`.
  Install commands (`npm install -D git+ssh://...`), the `npx -y -p
  git+ssh://...` one-shot, the update-flow examples, and the canonical
  `$schema` URLs IDEs resolve via `# yaml-language-server:` directives
  all pointed at the wrong host. Schema `$id` change is metadata only —
  no validation behavior change, no major bump warranted.

## [0.1.3] — 2026-05-06

### Added

- **`dev-skills/` — maintenance skills for this repo.** New top-level
  directory holding skills agents load when editing `vinta-ai-workflows`
  itself. Excluded from the npm package via the `files` whitelist and
  from the CLI's `SKILLS_SRC` discovery (which only walks `skills/`), so
  these skills never ship to consumer projects.
  - [add-foundation-skill](dev-skills/add-foundation-skill/SKILL.md) —
    walks the full schema-ripple checklist for adding a new foundation
    skill (schema enum, bootstrap interview, derive-skills bucket,
    foundation-shape lists, outputs tree, CHANGELOG). Catches the
    "orphaned schema field" / "schema-but-no-bucket-entry" footguns the
    `AGENTS.md` pitfall list calls out.
  - [add-stack](dev-skills/add-stack/SKILL.md) — adds a new stack under
    `skills/vinta-bootstrap-ai-tools/resources/stacks/<stack>/notes.md`
    + the orchestrator's stack table + `vinta-analyze-codebase`
    detection signals. Enforces the notes-only rule (no SKILL.md / agent
    YAML inside stack dirs).
  - [release](dev-skills/release/SKILL.md) — release flow: pre-flight
    checks (clean tree, on `main`, fetched, CHANGELOG section
    non-empty + matches bump kind, schema enums match every shipped
    foundation skill), version bump, CHANGELOG close, commit + tag +
    push. Surfaces `npm publish` for the user; never auto-publishes.
  - [validate-skill-md](dev-skills/validate-skill-md/SKILL.md) —
    read-only repo-wide lint of every `SKILL.md` (frontmatter shape,
    `name:` = dir name, surviving `{{PLACEHOLDER}}` outside declared
    template files, broken relative links, missing `resources/` paths).
    Exits 1 on errors; CI-friendly.
  - [bump-schema-major](dev-skills/bump-schema-major/SKILL.md) — cuts a
    `v<N>` → `v<N+1>` of a JSON Schema for breaking changes. Copies
    file, applies breaking diff to v<N+1> (leaves v<N> intact during
    deprecation window), walks every consumer for dual-read
    translation, updates `schemas/README.md` inventory + CHANGELOG +
    triggers a major package bump via `release`.
  `AGENTS.md` gains a `dev-skills/` reference table pointing at each.

- **Committed vendor symlinks for `dev-skills/`.** Five repo-root
  symlinks let Claude Code, Cursor, Codex, and VS Code + Copilot
  auto-discover the maintenance skills under `dev-skills/` without any
  per-developer setup step:
  - `.claude/skills` → `../dev-skills`
  - `.cursor/skills` → `../dev-skills`
  - `.github/skills` → `../dev-skills`
  - `.agents/skills` → `../dev-skills` (universal — also picked up by
    Cursor + Copilot)
  - `.github/copilot-instructions.md` → `../AGENTS.md` (Copilot's path)

  `.gitignore` reshaped to un-ignore exactly these paths: `.claude/`,
  `.cursor/`, `.agents/` are now `.<vendor>/*` with explicit
  `!.<vendor>/skills` negations. Every other file under those vendor
  dirs (the per-vendor generated sub-agent files, settings, etc.)
  remains gitignored as before. New committers don't run anything;
  `git clone` + open editor is enough.

  No `dev-skills/setup.mjs` — symlinks are committed once. To add a new
  dev skill: drop the dir under `dev-skills/<name>/` and commit. The
  symlinks expose it automatically.

- **Per-script folder layout for `add-one-off-script`.** Each script
  generated by the skill now lives in its own directory
  `<scripts_dir>/<YYYY-MM-DD>-<name>/` containing `script.{py,ts}`,
  `test_script.{py,ts}`, and `README.md`. Sister
  `run-one-off-script-<stack>` skills (see below) drop the runner
  artefact (Jupyter notebook, Medplum bot, Vercel Function, Django
  management command) into the same folder. Run logs + CSV backups
  land separately under `<log_dir>/<name>/` (default
  `.vinta-ai-workflows/one-off-runs/<name>/`) so an interrupted run
  never pollutes the source folder.

- **Pluggable `Runtime` interface in `BaseOneOffScript`.** Engine
  delegates every runtime-specific concern (single-instance lease,
  stop signal source, log sink, processed-items log, artifact paths,
  final upload) to a `Runtime` instance. Default `LocalRuntime` ships
  alongside the base class — covers a plain CLI invocation with
  filesystem state, PID-file lease, SIGINT/SIGTERM handlers, and
  optional S3 upload. Stack-specific runners ship their own adapters
  (`JupyterRuntime`, `DjangoMgmtRuntime`, `MedplumBotRuntime`,
  `VercelFunctionRuntime`, `K8sJobRuntime`) without needing to fork
  the engine. The contract — "stop must finish current item then
  flush + upload" — is enforced regardless of surface.

- **Sister skill family: `run-one-off-script-<stack>`.** Stack-specific
  skills opted into via the per-stack notes file under
  [resources/stacks/<stack>/notes.md](skills/vinta-bootstrap-ai-tools/resources/stacks/).
  Two stacks shipped notes for this release:
  - `run-one-off-script-django` — authors a Jupyter notebook at
    `notebooks/<name>/runner.ipynb` (Vinta default) or a `BaseCommand`
    subclass under `<app>/management/commands/<name>.py`, plus the
    matching `JupyterRuntime` / `DjangoMgmtRuntime` adapter at
    `<scripts_dir>/_runtime_django.py`. New placeholders in the Django
    notes: invocation surface (Jupyter / mgmt command / both),
    notebook directory path.
  - `run-one-off-script-medplum` — authors a Medplum bot under
    `<bots_dir>/one_off_<YYYY_MM_DD>_<name>/handler.ts` plus
    `MedplumBotRuntime` at `<scripts_dir>/_runtime_medplum.ts`.
    Backups + run log upload to Medplum `Binary` resources (no FS in
    a bot) — restore reads them back via the FHIR API. Tenant
    scoping (`meta.account`) follows the project's standard pattern.
  Skill content itself is user-supplied per the existing convention
  (`resources/stacks/<stack>/notes.md` describes the category, not
  ready-made content).

- **New optional foundation skill: `add-one-off-script`** (copied verbatim
  to `ai-tools/skills/add-one-off-script/` per project, opt-in via the
  Step 0 **Optional foundation skills → add-one-off-script** question).
  Source:
  [skills/vinta-derive-skills/resources/foundation-skills/add-one-off-script/](skills/vinta-derive-skills/resources/foundation-skills/add-one-off-script/).
  Authors safe one-off operational scripts (data backfills, ad-hoc
  cleanups, tenant fixes outside the regular migration / ETL / cron
  path) following a strict contract: `execute(dry_run=True)` by default,
  idempotent on re-run via state-based filters or a fsync'd resume log,
  batched DB ops (no full-table locks), streamed reads via generators
  (no `.all()` / `fetchall()`), segmented CSV backups before destructive
  writes (max 1M cells per file, never nested across tables, one set of
  files per affected table) with a built-in `restore_from_backup()`
  path, interruption-safe SIGINT/SIGTERM handlers that flush + upload
  before exit, console + filesystem + S3 logging that survives the
  interruption, and a PID file + `--status` mode for monitoring from a
  second shell. Filenames must start with the authoring date
  (`YYYY-MM-DD-<descriptive-kebab>.{py,ts}`) and live under
  `<scripts_dir>/one_off/` (default `scripts/one_off/`).

  Bundled `BaseOneOffScript` templates ship in two languages — pick one
  per project at bootstrap (or per-script if polyglot):
  - [resources/one_off_script_base.py](skills/vinta-derive-skills/resources/foundation-skills/add-one-off-script/resources/one_off_script_base.py)
    — Python (Django, plain SQLAlchemy, raw psycopg).
  - [resources/one_off_script_base.ts](skills/vinta-derive-skills/resources/foundation-skills/add-one-off-script/resources/one_off_script_base.ts)
    — TypeScript (Node 20+, works with Prisma, Drizzle, Knex, raw `pg`).

  Subclasses override only the per-script hooks (`describe`,
  `iter_targets`, `process`, `item_id`, `tables_touched`, `snapshot`,
  `apply_restore_row`); the engine methods (`run`, `_safe_process`,
  `_write_backup`, signal handlers, S3 upload, PID lifecycle) are part
  of the contract and not overridable in practice.

- **`.vinta-ai-workflows.yaml` config additions for `add-one-off-script`**:
  - `foundation_skills.add-one-off-script: enabled | disabled` —
    sticky opt-in like every other foundation skill.
  - `skills.add-one-off-script.scripts_dir: string` (default
    `scripts/one_off`) — where the new scripts land in the repo.
  - `skills.add-one-off-script.language: python | typescript` — selects
    which `BaseOneOffScript` template gets staged at
    `<scripts_dir>/_base.{py,ts}`.
  - `skills.add-one-off-script.log_dir: string` (default
    `.vinta-ai-workflows/one-off-runs`) — where logs, PID files,
    processed-items logs, and CSV backup chunks land. Already covered
    by the umbrella `.vinta-ai-workflows/` gitignore entry added in
    0.1.3.
  - `skills.add-one-off-script.default_batch_size: integer` (default
    `500`) — passed into `BaseOneOffScript.config.batch_size` when the
    script doesn't override.
  - `skills.add-one-off-script.csv_max_cells: integer` (default
    `1000000`) — per-CSV-chunk cell cap before the writer rolls over to
    the next file. Encodes the contract's "max 1M cells per file" rule.
  - `skills.add-one-off-script.s3_bucket: string` (optional; falls back
    to `ONE_OFF_S3_BUCKET` env at runtime) — destination for log + CSV
    uploads on clean or signal-driven exit. Empty disables S3 upload;
    the filesystem copy stays authoritative.
  - `skills.add-one-off-script.s3_prefix: string` (default
    `one-off-runs/`; falls back to `ONE_OFF_S3_PREFIX` env).

- **Bootstrap interview Step 0 — Optional foundation skills → `add-one-off-script` question**:
  new question for the `add-one-off-script` skill plus three short
  follow-ups (scripts dir, primary language, S3 bucket + prefix). The
  **Optional foundation skills** header wording at the top switched from
  "three skills" to "four skills" accordingly. Outputs tree updated to
  list `ai-tools/skills/add-one-off-script/` plus its `resources/`
  directory carrying the language-specific `BaseOneOffScript` templates.
  The **Existing AI artifacts** group's foundation-shape name list
  (which gates the `Replace with Vinta foundation version` option)
  gained `add-one-off-script`.

- **`vinta-derive-skills` bucket C** gains a third optional skill —
  `add-one-off-script` — alongside `add-e2e-test` and `add-env-var`.
  Unlike the other two, this one is copy-verbatim (no per-project
  drafting interview); the project-specific variability lives entirely
  in the `skills.add-one-off-script.*` config block and in env vars
  consumed at runtime.

- **New optional foundation skill: `systematic-debugging`** (renders to
  `ai-tools/skills/systematic-debugging/SKILL.md` per project, opt-in
  via the Step 0 **Optional foundation skills → systematic-debugging**
  question). Source:
  [skills/vinta-derive-skills/resources/systematic-debugging-template.md](skills/vinta-derive-skills/resources/systematic-debugging-template.md).
  Root-cause-first debugging flow with project-specific reproduction
  commands ({{TEST_CMD}}, {{LINT_CMD}}, {{BUILD_CMD}},
  {{NEW_TEST_CMD_PATTERN}}, etc) and an enforced **Phase 0 observability
  sweep** that requires pulling evidence from the project's MCP servers
  before any hypothesis. Skill enforces an "iron law" — no code change
  until the cause is named — plus a three-strikes architectural-question
  rule, a red-flag self-talk list, and a verification checklist.
  Generated only when `foundation_skills.systematic-debugging: enabled`
  in `.vinta-ai-workflows.yaml`.

- **MCP-agnostic evidence categories doc**:
  [skills/vinta-derive-skills/resources/systematic-debugging-mcp-tools.md](skills/vinta-derive-skills/resources/systematic-debugging-mcp-tools.md).
  Replaces a per-vendor catalogue (Sentry / Datadog / etc.) with seven
  evidence categories (error tracking, distributed tracing, logs,
  metrics, alerts / SLO burn, deploys / releases, dashboards). The
  rendered SKILL.md tells the agent to list available MCP tools at
  runtime and match them to categories by description + parameter
  names — so the skill stays correct as MCP servers add or rename
  tools. The block is rendered verbatim into `{{OBSERVABILITY_MCP_BLOCK}}`;
  no per-server templating happens at generation time.

- **New schema: `mcp-preflight-cache.v1`**
  ([schemas/mcp-preflight-cache.v1.schema.json](schemas/mcp-preflight-cache.v1.schema.json)).
  Defines `.vinta-ai-workflows/cache.yaml` — the per-developer-machine
  preflight state for the systematic-debugging skill. No TTL: `ok`
  entries stay valid until something fails. A failed MCP call mid-debug
  flips the offending server to `dirty`, forcing a re-preflight on the
  next debug run. Statuses: `ok | dirty | missing | auth-error |
  unreachable`. Inventory row added to
  [schemas/README.md](schemas/README.md).

- **`.vinta-ai-workflows.yaml` config additions**:
  - `foundation_skills.systematic-debugging: enabled | disabled`.
  - `skills.systematic-debugging.observability_mcp_servers: string[]`
    — free-form list of MCP server identifiers (no enum — the user
    names whatever shorthand the team uses). Empty array allowed but
    degrades the skill (Phase 0 collapses to "local logs only").
  - `run_options.systematic-debugging.allow_local_only_debug: boolean`
    (default `true`) — controls whether developers may opt out of
    Phase 0 per run with a `local-only` keyword.

- **Bootstrap interview Step 0 — Optional foundation skills → `systematic-debugging` question**:
  new question for the systematic-debugging skill, plus a free-form follow-up that asks the
  user to name observability MCP servers already wired up. The
  orchestrator cross-checks the answer against the project's actual MCP
  config files (`.mcp.json`, `~/.claude/mcp_servers.json`,
  `.codex/mcp.json`, etc.) and surfaces servers the user did not
  mention. Selection lands in
  `skills.systematic-debugging.observability_mcp_servers`.

### Changed

- **`prs-context/` moved to `.vinta-ai-workflows/prs-context/`.**
  Brings PR-context drafts under the same per-developer-machine
  umbrella as the new MCP preflight cache. All path references updated
  across schemas, templates, foundation skills, README, sync skill,
  bootstrap skill, and `setup-ai-tools.mjs`. Migration for projects
  bootstrapped against earlier versions is the natural job of
  [vinta-sync-ai-tools](skills/vinta-sync-ai-tools/SKILL.md);
  the existing `prs-context/` dir + stale `.gitignore` entry stay
  harmless until sync runs.

- **`setup-ai-tools.mjs` gitignore management**: entries collapsed
  from `['prs-context/']` to `['.vinta-ai-workflows/']`. Single umbrella
  entry now covers `prs-context/`, `cache.yaml`, and any future
  per-machine state added under `.vinta-ai-workflows/`. Comment block
  rewritten to document the directory's contents.

- **`vinta-derive-skills` bucket B**: `systematic-debugging` joins
  `implement-plan` and `amend-plan` as a template-rendered foundation
  skill. Placeholder table extended with `{{OBSERVABILITY_MCP_BLOCK}}`
  and `{{OBSERVABILITY_MCP_LIST}}`. Render rules call out the runtime
  tool-discovery contract.

- **`schemas/vinta-ai-workflows-config.v1.schema.json`** —
  `foundation_skills` properties block gains the
  `systematic-debugging` enum entry; `skills.systematic-debugging`
  added under the (already open) per-skill `skills` map;
  `run_options.systematic-debugging.allow_local_only_debug` added.
  All additions are optional fields → no schema major bump.

## [0.1.2] — 2026-05-06

### Added

- **Schema-as-contract: `schemas/` directory** at the repo root. Four
  JSON Schema (Draft 2020-12) files now define every YAML format the
  toolchain produces or consumes. Every YAML payload carries a top-level
  `schema_version: <int>` matching the schema filename suffix.
  - [`vinta-ai-workflows-config.v1.schema.json`](schemas/vinta-ai-workflows-config.v1.schema.json)
    — for `.vinta-ai-workflows.yaml` (project config, see below).
  - [`sub-agent.v1.schema.json`](schemas/sub-agent.v1.schema.json) —
    for `ai-tools/agents/<name>.yaml` (vendor-agnostic sub-agent
    definitions consumed by `setup-ai-tools.mjs`). Documents the four
    vendor-override sub-objects (`overrides.{claude,cursor,copilot,codex}`).
  - [`prs-context-frontmatter.v1.schema.json`](schemas/prs-context-frontmatter.v1.schema.json)
    — for the YAML frontmatter at the top of every
    `prs-context/{feature-kebab}/phase-{phase.id}.md` file.
  - [`prs-context-comments.v1.schema.json`](schemas/prs-context-comments.v1.schema.json)
    — for the YAML list inside the `# Comments` ` ```yaml ` fence.
  - [`schemas/README.md`](schemas/README.md) documents versioning
    rules (when to bump major, how to ship `vN+1` alongside `vN`),
    IDE wiring via `# yaml-language-server: $schema=...` directives,
    and CI validation snippets (`ajv-cli`).

- **Project config file: `.vinta-ai-workflows.yaml`** (new — written by
  `vinta-bootstrap-ai-tools` Step 0.5, read + rewritten by
  `vinta-ai-workflows-sync`). Single source of truth for project-wide
  settings:
  - `vinta_ai_workflows_version` — last package version synced from.
  - `project.{name, default_branch, code_host, stack_summary, ai_plans_dir, pr_template_paths}`.
  - `commands.{lint, format, build, test_unit, test_unit_scoped, test_unit_new_pattern, e2e}`.
  - `policies.{pr_creation, ai_coauthor, commit_style, stage_pattern, anti_git_add_all_reason}`.
  - `vendors` — claude / cursor / copilot / codex selection.
  - `foundation_skills` + `foundation_agents` — per-artifact opt-in
    (`enabled` / `disabled`). `disabled` is sticky — `vinta-ai-workflows-sync`
    won't re-propose disabled artifacts.
  - `stacks` + `stack_specialist_agents` — applied stack templates.
  - `run_options.<skill>` — per-skill defaults
    (`implement-plan.{pause_between_phases, generate_inline_comments}`,
    `amend-plan.blast_radius_signal_threshold`).
  - `skills.<name>` — per-skill custom config (open shape per skill).
  Replaces today's pattern of inlining interview answers into rendered
  SKILL.md bodies; bodies will continue to inline values (Path B) but
  re-rendering is driven from the config so values can be edited and
  propagated by re-running sync.

- **New builder skill: `vinta-ai-workflows-sync`**
  ([SKILL.md](skills/vinta-ai-workflows-sync/SKILL.md)). Brings a
  project up to date with the latest package version. Workflow:
  1. Load `.vinta-ai-workflows.yaml`; validate against schema. If
     missing, run "Bootstrapping the config file" — reverse-extracts
     state from existing artifacts + interview-fills gaps.
  2. Diff the project's `vinta_ai_workflows_version` against the
     cloned package's current version; parse `CHANGELOG.md` to
     enumerate releases between.
  3. Per change, classify against the project's opt-in surface
     (`affects-project` / `opt-in-offer` / `config-schema-change` /
     `not-applicable` / `tooling`). Cross-validate via file diff;
     surface orphan diffs (no changelog entry) at the end.
  4. Build a per-bucket proposal with inline diffs; `AskUserQuestion`
     per change (`Apply` / `Skip` / `Show diff`); batch tooling
     changes under one prompt.
  5. Apply approved: migrate config schema, flip opt-ins to
     `enabled`, re-render templates, re-copy verbatim foundation
     skills (delegated to [vinta-update-project-skills](skills/vinta-update-project-skills/SKILL.md)),
     re-run setup-ai-tools.mjs in idempotent mode.
  6. Re-validate every YAML file against its schema.
  7. Bump `vinta_ai_workflows_version` + `last_synced_at`.
  Layers on top of `vinta-update-project-skills` (narrow tool stays;
  sync calls it for foundation-skill body diffs).

- **`vinta-bootstrap-ai-tools` Step 0.5 — Write `.vinta-ai-workflows.yaml`**.
  New step inserted between Step 0 (interview) and the sub-skill flow.
  Captures all interview state into the canonical config file before
  any sub-skill runs. Validates against the schema; partial configs
  route back to the relevant interview question. Re-bootstrap of an
  existing-config project asks `Keep existing / Re-interview / Stop`.
  Outputs tree updated to show `.vinta-ai-workflows.yaml` at the repo
  root.

- **Schema directives** added to the templates that emit YAML files —
  `# yaml-language-server: $schema=...` lines at the top of each
  authored payload so IDEs auto-validate. Wired into:
  - [skills/vinta-derive-skills/resources/prs-context-template.md](skills/vinta-derive-skills/resources/prs-context-template.md)
    (frontmatter + `# Comments` fence).
  - [skills/vinta-derive-subagents/SKILL.md](skills/vinta-derive-subagents/SKILL.md)
    (sub-agent YAML shape examples now show `schema_version: 1` +
    schema directive).

- **New project-skill template: `amend-plan`** (renders to
  `ai-tools/skills/amend-plan/SKILL.md` per project, alongside
  `implement-plan`). Source:
  [skills/vinta-derive-skills/resources/amend-plan-template.md](skills/vinta-derive-skills/resources/amend-plan-template.md).
  Companion to `implement-plan` — same agents, same review gates, same
  prs-context flow; opposite git topology direction (history rewriting
  instead of forward execution). Use cases: spec change forces a phase
  body rewrite, a phase needs to slot in between existing ones, or a
  **Guiding Decisions** row changes and cascades through later phases.

  Flow:
  1. Edit the plan file (rewrite affected phase bodies, insert / append
     new phases, log the amendment in `## Amendments`).
  2. Build a per-phase state map (`not-started` / `in-progress` /
     `implemented-not-merged` / `merged-to-default`).
  3. **Blast-radius evaluation.** Compute signals (rewrite share ≥ 50%,
     **Guiding Decisions** cascade ≥ 50%, ≥2 immutable phases combined with earlier
     rewrites, data-model contract change in >2 phases, ≥70% rewritten
     LoC, multi-author branches, ≥2 approved PRs). ≥2 signals tripping
     → surface a `Restart` option to the user before any force-push
     plan is shown. On `Restart`: hand off to `plan-feature` for a
     fresh `YYYY-MM-DD-FEATURE_NAME_PLAN.md`; annotate the old plan
     `Superseded`; leave old phase branches in place for audit; exit.
  4. Refuse force-pushes that can't work — phases merged to the default
     branch are immutable; amendment must be a new appended phase.
     Branch protection, multi-author branches, and approved PRs all
     prompt for explicit confirmation.
  5. Per affected phase, in stack order: spawn an implementer subagent
     to bring the diff into compliance with the new body, run inner +
     outer test loops, run all three review layers, rebase onto the
     (possibly-rewritten) parent, then `git push --force-with-lease`.
     Conflicts resolved by a fixer subagent.
  6. Refresh the `prs-context/{feature}/phase-{id}.md` file: pending
     ones get rewritten in place; published ones may flip back to
     pending and re-publish via `open-pr.sh` so new comments post.
  7. Update `TRACKING_{plan-id}.md` with amendment notes; final report
     lists every branch state, pending PR-contexts, blocked rewrites
     with forward-phase suggestions, and a reviewer re-request reminder.

  Hard rules:
  - Never `--force`. Always `--force-with-lease`.
  - Per-branch confirmation; never batch.
  - Subagents commit but never push — orchestrator owns force-push.
  - Phases merged to default branch are converted to `append-new` and
    handed off to `implement-plan`, not rewritten here.
  - `not-started` phases never executed by this skill — also handed off
    to `implement-plan`.
- **`vinta-bootstrap-ai-tools` Outputs tree** updated to list
  `ai-tools/skills/amend-plan/SKILL.md` alongside `implement-plan`.
- **`vinta-derive-skills` bucket B** now generates two skills from
  templates instead of one. Both templates share the same placeholder
  set (`{{LINT_CMD}}`, `{{BUILD_CMD}}`, `{{TEST_CMD}}`, `{{DEFAULT_BRANCH}}`,
  `{{PR_*}}` family, `{{COAUTHOR_*}}` family, `{{COMMIT_STYLE_LINE}}`,
  etc.) — substitute once, render twice.

- **New foundation skill + bundled script: `open-pr-from-context`**
  ([SKILL.md](skills/vinta-derive-skills/resources/foundation-skills/open-pr-from-context/SKILL.md),
  [scripts/open-pr.sh](skills/vinta-derive-skills/resources/foundation-skills/open-pr-from-context/scripts/open-pr.sh)).
  The mechanical work — parse frontmatter + sections, detect CLI, open
  PR, post each inline comment, rewrite frontmatter, append publish log —
  lives in the bash script; the SKILL.md is a thin wrapper that picks
  the file, runs the script, and reports the result. Script deps:
  `bash 4+`, `git`, `yq` (Mike Farah), `jq`, plus one of `gh` / `glab`.
  Per-comment failure tolerated — bad ones reported, run continues.
  On success rewrites the file's frontmatter to `status: published` +
  `pr_url`, appends a timestamped publish log. Strictly scoped: no push,
  no test re-runs, no diff editing, no draft generation. Bundled with
  the `vinta-derive-skills` foundation set so it ships with every new
  bootstrap. Exit codes: 0 (full success), 1 (PR up, comment failures),
  2 (hard failure / missing deps).
- **PR-context template** at
  [skills/vinta-derive-skills/resources/prs-context-template.md](skills/vinta-derive-skills/resources/prs-context-template.md)
  defining the reproducible file shape: frontmatter (plan_id, feature_name,
  phase_id, phase_title, branch, base, created_at, status, pr_url) +
  `# Title`, `# Description`, `# Comments` sections (single fenced YAML
  list of `{file, start_line, end_line?, side, body}` entries).
- **`implement-plan` Step 0 opt-in questions** (template-level —
  `vinta-derive-skills` renders these into the project's `implement-plan`
  skill body):
  - **Pause between phases?** Default off (auto-flow). When on, a new
    **Per-phase pause gate** step fires after each phase's user update
    with `Continue` / `Pause` / `Stop` options; orchestrator exits
    cleanly on Pause and resumes on next invocation per the existing
    "Re-running mid-plan" flow.
  - **Generate PR descriptions + inline comments?** Default off. When on,
    a new **Open PR via context file** draft step fires after every
    phase: agent picks 3–10
    non-obvious comment targets from the diff (subtle invariants,
    feature-flag short-circuits, cross-phase coupling, upstream-contract
    naming), writes `prs-context/{feature-kebab}/phase-{phase.id}.md`
    following the template, and — if a PR CLI is detected — invokes
    `open-pr-from-context` to publish.
- **`prs-context/` auto-added to `.gitignore`** by
  [skills/vinta-install-ai-tools-setup/resources/setup-ai-tools.mjs](skills/vinta-install-ai-tools-setup/resources/setup-ai-tools.mjs)
  on first invocation. Idempotent (re-runs don't duplicate the entry);
  preserves any existing `.gitignore` content; appends a labeled block.
- **Run-options state** (`run_options.pause_between_phases`,
  `run_options.generate_pr_context`) recorded in the per-plan tracking
  file so re-running mid-plan honors the original choices.
- **Quick checklist + Important rules** in the implement-plan template
  updated with bullets for opt-in honoring and PR-context durability.

### Changed

- **`setup-ai-tools.mjs` validates `schema_version`** on every loaded
  `ai-tools/agents/<name>.yaml`. Files lacking `schema_version: 1`
  fail fast with a clear error pointing at
  `schemas/sub-agent.v1.schema.json`.

- **PR-context generation honors existing project PR / MR templates.**
  New `project.pr_template_paths: string[]` field in
  [`vinta-ai-workflows-config.v1.schema.json`](schemas/vinta-ai-workflows-config.v1.schema.json)
  lists templates detected at bootstrap. Detection in
  [`vinta-analyze-codebase`'s **Existing AI-tooling artifacts** scan](skills/vinta-analyze-codebase/SKILL.md#11-existing-ai-tooling-artifacts)
  now scans (case-insensitive):
  - GitHub: `.github/pull_request_template.md`,
    `.github/PULL_REQUEST_TEMPLATE.md`,
    `.github/PULL_REQUEST_TEMPLATE/*.md`,
    repo-root + `docs/` variants.
  - GitLab: `.gitlab/merge_request_templates/*.md`.
  Inventory output adds `existing_ai_artifacts.pr_templates[]` with
  `path` + section summary per template.

  The `implement-plan` skill's **Open PR via context file** step (step 2) now reads `project.pr_template_paths`
  and uses the chosen template's section structure verbatim for the
  prs-context `# Description`. Sections are filled with phase-specific
  content; `<!-- HTML comments -->` placeholders are preserved;
  checklists are ticked only for items the diff actually satisfies.
  Multi-template directories prompt the user once; the choice is
  cached under `run_options.pr_template_used` for subsequent phases.
  Empty array → free-form description with default sections
  (`## Summary`, `## Plan reference`, `## Test plan`).

  The `amend-plan` skill's **Refresh the PR-context file** step follows the same rule when refreshing prs-context
  bodies, picking up the current `pr_template_paths` even when the
  template was added or swapped after the original `implement-plan`
  run.

  [`prs-context-template.md`](skills/vinta-derive-skills/resources/prs-context-template.md)
  `# Description` guidance updated with the three branches (one
  template / multiple templates / empty).

- **PR creation consolidated to a single flow.** Earlier drafts had two
  parallel paths in `implement-plan`: the legacy `{{PR_CREATION_INSTRUCTION_BLOCK}}`
  inside the **Branch push** step (raw `gh pr create` / `glab mr create`)
  and the new `prs-context` + `open-pr.sh` flow inside the **Open PR via
  context file** step. Removed the legacy block. PRs now always go through
  a `prs-context/{feature-kebab}/phase-{phase.id}.md` file + the bundled
  script, even when inline comments are off. Behavior matrix in the
  [implement-plan template's **Open PR via context file** step](skills/vinta-derive-skills/resources/implement-plan-template.md):

  | PR policy | inline comments | What the **Open PR via context file** step does |
  |---|---|---|
  | agents create | off | write file (empty comments) + run `open-pr.sh` |
  | agents create | on  | write file (full) + run `open-pr.sh` |
  | branches only | off | skip the step |
  | branches only | on  | write file (durable record); skip script |

- **Renamed run-option:** `run_options.generate_pr_context` →
  `run_options.generate_inline_comments`. The opt-in is now strictly
  about inline comments — PR opening itself is governed by the project's
  PR creation policy captured at bootstrap, not by this per-run flag.
- **Removed placeholder** `{{PR_CREATION_INSTRUCTION_BLOCK}}` from the
  implement-plan template + `vinta-derive-skills` SKILL.md substitution
  table. The remaining `{{PR_*}}` placeholders cover framing only
  (description, push, checklist, summary phrasing); they no longer
  carry raw `gh pr create` lines.
- **Important rule + Quick checklist** updated to describe the unified
  **Open PR via context file** matrix instead of the previous two-flag gate.

## [0.1.1] — 2026-05-05

### Added

- **New sub-skill: `vinta-migrate-plans-specs`** — finds existing implementation
  plans and feature specs scattered across a project (`docs/`, `specs/`,
  `plans/`, root markdown, branch-named files, ADRs, legacy `_IMPLEMENTATION_PLAN`
  variants) and migrates them to the canonical `ai-plans/YYYY-MM-DD-{FEATURE_NAME}_{PLAN|SPEC}.md`
  layout. Read-only by default; every rename gated on per-file user approval
  via `AskUserQuestion`. Classifies PLAN vs SPEC by filename + body shape;
  derives date from filename, doc body, `git log --diff-filter=A --follow`,
  or asks. Locks paired spec+plan to the same `FEATURE_NAME`. Rewrites
  inbound markdown references in the same batch as each move.
- **`vinta-bootstrap-ai-tools` Step 0 — Existing AI artifacts disposition.**
  Per-artifact `AskUserQuestion` over every instruction doc, skill, and
  sub-agent found in the repo. Options: `Migrate to ai-tools/<…>`,
  `Keep in current vendor path, don't touch`, `Drop`, plus
  `Replace with Vinta foundation version` for foundation-shape names
  (`plan-feature`, `create-spec`, `create-qa-use-cases`, `implement-plan`,
  `add-e2e-test`, `add-env-var`, `implementer`, `reviewer`, `fixer`).
  Decisions never batched — one prompt per artifact.
- **`vinta-bootstrap-ai-tools` sub-skill flow extended to six steps.**
  Step 6 dispatches `vinta-migrate-plans-specs`. The Step 0 **Scope →
  Which sub-skills to run** question updated to offer a `Skip
  migrate-plans-specs` option in the custom selection.
- **`vinta-bootstrap-ai-tools` Outputs section** now documents the
  `ai-plans/` tree alongside the `ai-tools/` tree.
- **`vinta-bootstrap-ai-tools` Verification** check #6 — confirms migrated
  docs land in canonical `YYYY-MM-DD-{FEATURE_NAME}_{PLAN|SPEC}.md` form
  and no orphaned plan/spec markdown remains in `docs/`, `specs/`, or
  repo root.
- **`vinta-analyze-codebase` — Existing AI-tooling artifacts scan.** Full
  enumeration of instruction docs, skills (across `.claude/skills/`,
  `.cursor/skills/`, `.codex/skills/`, `.github/skills/`, `.agents/skills/`,
  `ai-tools/skills/`), and sub-agents (across the parallel `agents/`
  paths). Each entry classified `vinta-managed` / `foundation-shape` /
  `project-custom` / `stack-specialist`. Setup-script presence + symlinks
  recorded. Plans-dir presence flagged.
- **Inventory schema** (`existing_ai_artifacts.{instructions,skills,agents,setup,plans_dir_present}`)
  added to `vinta-analyze-codebase` output, consumed by the four
  downstream sub-skills.
- **`vinta-write-agents-md` Inputs — existing instruction docs** — three explicit branches per
  existing instruction doc: `Merge into new ai-tools/AGENTS.md`,
  `Keep as-is, link from ai-tools/AGENTS.md`, `Replace from scratch`.
  Discarded files surfaced in the run summary.
- **`vinta-derive-subagents` "Reconcile against existing agents (do this FIRST)"
  section.** Vendor-format → canonical YAML conversion table (Claude
  `tools:` CSV, Cursor `readonly`, Codex `sandbox_mode`, Copilot
  `tools[]`). Foundation trio only emitted when missing or explicitly
  replaced.
- **`vinta-derive-skills` "Reconcile against existing skills (do this FIRST)"
  section.** Migrate uses `git mv`, body scrubbed for hard-coded vendor
  paths after move. `vinta-*` directories left alone (managed by the
  CLI). Foundation duplicates suppressed when the user has `Migrate` /
  `Keep` on the matching name.

### Changed

- **`vinta-bootstrap-ai-tools` sub-skill flow** updated from "five sub-skills"
  to "six sub-skills" wording across the orchestrator. The Step 0 **Scope
  → Which sub-skills to run** default changed from `All five` to `All six`.
- **`vinta-analyze-codebase`** documentation split: the **Documentation
  already present** scan is now READMEs / ADRs only; existing AI tooling
  moved to its own **Existing AI-tooling artifacts** scan with deeper
  coverage.

### Notes

- The new disposition flow makes bootstrap **non-destructive by default**
  for any repo that already has AI tooling — nothing gets overwritten
  without an explicit per-artifact `Replace` answer.
- Foundation skills (`plan-feature`, `create-spec`, `create-qa-use-cases`)
  still hard-code source-repo paths (e.g. `<source-repo>/ai-plans/`) in their
  bundled bodies; `vinta-derive-skills` already scrubs these after copy.
  `vinta-migrate-plans-specs` flags the legacy `_IMPLEMENTATION_PLAN`
  suffix during migration so projects can align their foundation-skill
  bodies to the new `_PLAN` standard. A follow-up release will update
  the bundled foundation-skill resources to use the project's canonical
  paths from the start.

## [0.1.0] — 2026-05-05

### Added

- Initial release of `vinta-ai-workflows` as a private npm package
  exposing the `vinta-ai-workflows` CLI bin.
- Seven `vinta-`-prefixed bootstrap skills under `skills/`:
  `vinta-analyze-codebase`, `vinta-bootstrap-ai-tools`, `vinta-derive-skills`,
  `vinta-derive-subagents`, `vinta-install-ai-tools-setup`,
  `vinta-update-project-skills`, `vinta-write-agents-md`.
- `vinta-ai-workflows` CLI commands: `install`, `update`, `uninstall`, `list`.
- Multi-vendor install support: Claude Code (`.claude/skills/`), Codex
  (`.agents/skills/`), Cursor (`.cursor/skills/`), VS Code + Copilot
  (`.github/skills/`), plus virtual `agents` tool that writes to
  `.agents/skills/` to cover Codex + Cursor + Copilot in one shot.
- Symlink-by-default install (auto-tracks `npm install` / `git pull`
  refreshes); `--copy` mode for projects that don't preserve symlinks.
- Marker-based uninstall safety: removes only symlinks pointing back
  into the package's `skills/` tree or directories containing
  `.installed-by-vinta-ai-workflows`. Hand-installed skills survive.
- `vinta-update-project-skills` skill: refresh project's
  `ai-tools/skills/` against latest source, per-skill diff + explicit
  accept gate.
- README documenting `git+ssh://` install (no registry needed),
  optional GitHub Packages flow, `npx` one-shot, and full workflow recap.
