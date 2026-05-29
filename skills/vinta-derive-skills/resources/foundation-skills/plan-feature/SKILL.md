---
name: plan-feature
description: Author a phased implementation plan for a new feature following the repo's `ai-plans/` conventions. Use when the user asks to "plan", "design", "scope", or "break down" a feature, write an implementation plan / IMPLEMENTATION_PLAN.md, or turn a spec/idea into a phased roadmap. Always interrogates the requester before drafting.
---

# Plan Feature

Plans live in `ai-plans/` as `YYYY-MM-DD-FEATURE_NAME_IMPLEMENTATION_PLAN.md` (uppercase + underscores). `..._SPEC.md` sibling exists → **read first**. Plan translates spec into phased delivery, doesn't re-derive requirements. No spec? Point at [create-spec](../create-spec/SKILL.md) first; plan without spec = plausible-sounding but unverified. Spec/plan pair share `YYYY-MM-DD-FEATURE_NAME` prefix.

## Step 0 — Interrogate before drafting (NON-NEGOTIABLE)

**Never assume requester want.** *"Plan bookmarks feature"* hide ≥dozen decisions cheaper to surface now than unwind in Phase 4.

Ask below in **batched, numbered groups**. Skip only when SPEC.md or prior conversation **explicitly** answers — never because guess. Can guess but not 100% sure → ask + state default ("default: per-user; confirm or override").

Drop irrelevant groups; don't drop questions inside relevant group:

### Use `AskUserQuestion` for finite-choice questions

Every question in groups B–J with discrete answer set — yes/no, named option, finite enum — **must** go through `AskUserQuestion` tool, not free-form prose. Why:

- User picks; no retyping context.
- Multiple related questions ride one `AskUserQuestion` call (tool accepts list of questions, each own option set). Batch per group: one call for the **Data model & storage** group, one for the **API surface** group, etc.
- Short option label per choice; rationale ("default: per-user — confirm or override") goes in question header, not option labels.

Plain prose (no tool) **only** when answer genuinely open-ended: "walk me through user journey", "what success look like in your words", "what deadline driver". Group A mostly prose; B–J mostly closed-choice.

### Iterative asking when no `AskUserQuestion` (or question open-ended)

Two cases force iterative single-question mode:

1. **`AskUserQuestion` genuinely unavailable** (harness errored on call, not deferred). Try once — confirm actually missing, not schema-deferred.
2. **Question genuinely open-ended** (no finite option set — narrative, journey, free-form motivation, deadline date).

Both cases: **ask one question at a time, wait for answer, then ask next.** Don't dump 5 open questions in one paragraph — user reads three, answers two, third gets lost. Iterate:

```
> Q1: Who is the primary actor for this flow?
[wait for answer]
> Q2: Walk me through what they do today when they hit this problem.
[wait for answer]
> Q3: …
```

Closed-choice questions in same group still ride single `AskUserQuestion` call — only open-ended ones split into one-per-message. Mixing in one group fine: send closed-choice batch via tool, then iterate open ones in plain prose after.

Never flatten ten questions into one prose paragraph just because tool unavailable. Iteration = fallback, not consolidation.

### A. Problem & users
1. Problem this solves, for whom (tenant admins, internal ops, external integrations, end-users via UI)?
2. Success looks like — what behavior or metric changes?
3. Workflows requester *thinks* in scope but actually belong to follow-up?
4. Who else cares about this landing? Anyone need looping in on contract?

### B. Scope & non-goals
1. **Explicitly out of scope** for v1? Force non-goals list — where most plans drift.
2. v1.x / v2 already implied? Name it so we don't bake assumptions into v1's data model.

### C. Data model & storage
1. New table, new column on existing, JSONB blob, side table, no persistence?
2. Touching an existing table on a hot path (high-volume, frequently joined, partitioned)? Adding a column there has very different costs than a side table.
3. Multi-tenancy: per-tenant, per-user-per-tenant, tenant-shared?
4. Partitioning: do related tables partition by `tenant_id`? Should this one (for partition-wise joins)?
5. Cardinality: rough upper bound rows per tenant?
6. Soft FK vs hard FK to partitioned tables — cleanup story on delete?
7. Indexing: which predicates need index-friendly?

### D. API surface
1. REST (internal versioned API), Public GraphQL, internal-only, or several?
2. Auth: internal session/JWT, public API token (`Authorization: Bearer ...`), service-to-service?
3. Bulk-upsert? Endpoints fed by integrations should be bulk-upsert.
4. Client SDKs or external consumers locking in contract?

### E. Producers & consumers (cross-repo)
1. Data flowing in from an upstream producer / integration repo? Which third-party providers feed it?
2. Downstream system reading new data — warehouse / lake, analytics, exports?
3. Deploy ordering between repos — what gets deployed first; what breaks if order flips?

### F. Backwards compatibility & semantics
1. Existing clients/integrations — does omitting new field mean "don't change" vs "clear"? (omit-vs-empty-list = recurring bug source)
2. Existing rules / records expected to keep behaving same when new field defaults to null/empty? Confirm explicitly.
3. Replace vs merge semantics on writes?
4. Case-sensitivity, normalization (trim, lowercase), dedupe — at which layer?

### G. Concurrency, transactions, idempotency
1. Race conditions (concurrent batch edits, parallel workers / serverless invocations on the same row)?
2. Atomic-batch semantics: all-or-nothing, best-effort?
3. Upsert needs `last_updated_at` guard so we don't overwrite newer state?

### H. Rollout & risk
1. **Feature flag** — declared in the project's feature-flag module (substitute the actual path during planning). **Default YES** when feature touches existing flows (changes shape of existing endpoint, alters query path on hot table, modifies routing/matching, mutates data on existing rows, adds branching to use case with callers). Confirm flag key + scope (per-tenant vs per-request, by whatever names the project's flag API uses). Skip only when **purely additive new surface** (brand-new endpoint, table, admin page no existing code reads/writes) — even then, ask before dropping.
2. Backfill needed? Idempotent? Resumable?
3. Migration safety: locks, rewrites, query-plan regressions on hot tables?
4. Rollback plan: revert migration, flag-off, hot-patch?

### I. Observability & validation
1. Metric / log / dashboard tells us it's working in prod?
2. Audit logging requirements (whatever audit-trail app/module the project uses)?
3. How measure producer adoption before downstream phases ship?

### J. Edge cases & failure modes
1. Behavior when new field partially populated, malformed, oversized? Reject whole batch, drop offending entry?
2. Cycle / depth / cardinality limits — where (serializer vs use case vs DB constraint)?
3. Acceptable to silently truncate vs reject loudly?

### Clarity loop — keep asking until done

Don't treat Step 0 as one-pass. After each round of answers, **scan for new gaps**: contradictions, follow-ups the answer surfaces, decisions that depend on something earlier left vague. Open another batch of questions for those. Repeat.

Loop exit conditions (all required):
- Every group A–J either fully answered or explicitly waived.
- Every answer's downstream questions also asked + answered.
- No "we'll figure that out later" — that's **Open Questions** material; either it has a recommended default + owner, or it gets resolved now.
- You can write each Phase's Goal + Acceptance line right now without inventing.

If any condition fails → another `AskUserQuestion` round. Don't shortcut to drafting.

After answers stabilize: **read back decisions** as one-paragraph summary. Then issue one final `AskUserQuestion` with single question — *"Anything I got wrong before I draft?"* — options `Looks good`, `Some corrections (I'll list)`, `More to clarify`, `Stop, rethink`. `More to clarify` → another loop iteration. Only draft when user picks `Looks good`.

Pushback *"just write the plan"*: write it but **mark every assumption explicitly** in "Guiding Decisions" table.

## Plan structure

```markdown
# {Feature Name} — Implementation Plan

## 1. Goals
- 2-5 numbered concrete goals (the contract).
- Then "Non-goals:" bulleted list. **Always include non-goals.**

## 2. Guiding Decisions
| Decision | Resolution |
|---|---|
| **Storage shape** | … with the *why*, not just the what. |
| **Match semantics** | … |
| ... | ... |

## 3. Data Model Changes
### 3.1 New {Model}
   Code block with model. Reference @app/path/to/file.py for files
   that need editing. Note exports in __init__.py.

### 3.2 {Existing model}.{new_field}
   ...

### 3.3 Type plumbing
   TypedDicts, dataclasses, NewType updates.

## 4. API Design  (omit if no API surface)
### 4.1 {Endpoint group}
   Method / path / payload / response shape / errors.

## 5. Phased Rollout
   See "Phase structure" below.

## 6. Risk & Rollout Notes
   Feature flag (key, scope, default, flip-on criterion, removal path),
   locks, query-plan regressions, partition setup, view recreation,
   backfill story, rollback story.

## 7. Open Questions
   Decisions left to product/eng leadership, with recommended default.

## 8. Touch List
   Files to be created / edited / cross-repo, grouped by phase.
```

Don't invent new top-level sections. Skip non-applicable (e.g. omit "API Design" for pure data-pipeline) but keep numbering consecutive.

## Phase structure

### Naming: numbers + letters, consistently

- **Top-level**: `Phase 1`, `Phase 2`, …
- **Sub-phases (concern too big for one MR)**: `Phase 2a`, `Phase 2b`, `Phase 2c`. Use when one logical phase produces >300 LoC PR.
- **Parallel-track (different repo, different team, runs alongside)**: `Phase 1b`. Letter signals "different lane, same time", not "comes after".
- **Foundation phase**: `Phase 0` for pure scaffolding (new app skeleton, no behavior change). Optional.
- Consistent inside one plan: don't mix `Phase 2.1` with `Phase 3a`.

### Each phase MR-sized

Reviewer reads diff in 30 minutes:

- **Target**: ~100–300 LoC (tests included).
- **One concern per phase.** "Add field + write migration + wire into 4 use cases + update 3 SQL views" = four phases.
- **Independently mergeable.** Phase N merged + Phase N+1 stalled → system still working. No half-finished features behind flag with no flag-on path.
- **Own tests.** Every phase ships unit/integration tests. No "tests come in Phase 8."
- **Acceptance criterion.** Each phase ends with one-line "Acceptance:" — literally testable.

### One use-case per phase (mandatory)

Every spec use-case (entries under **Decisions → Use-cases** in the SPEC) gets **its own phase**. Never bundle two use-cases in one phase even when the diff is tiny. Bundling = larger PR + reviewer needs context for both flows + rollback drags both. Cost of an extra phase = one PR header. Cost of a bundled regression = hotfix + split-after-the-fact.

Apply even when:
- Two use-cases share the same endpoint — split anyway, the second phase is "wire use-case 2 into the existing endpoint." Reviewer reads ≤50 LoC.
- Use-cases are CRUD on same entity — Create / Read / Update / Delete are four phases, not one.
- "It's just one extra branch" — that branch hides edge cases. Separate phase forces explicit acceptance + tests for that branch.

Cross-cutting infra (shared types, migration, scaffolding) lands in a foundation phase before the use-case phases. Each subsequent use-case phase consumes that scaffolding.

### Phases creating new UI flow need happy-path E2E

Every phase that introduces or substantially changes a user-facing flow (new page, new modal, new wizard step, new gated action) **must** ship a Playwright e2e test covering at least the happy path in the same MR. Follow the [add-e2e-test](../add-e2e-test/SKILL.md) skill: pick the next free `PA###` / `PR###` id, update [QA_USE_CASES.md](QA_USE_CASES.md), add the page object + spec. **No `QA_USE_CASES.md` in the project yet?** Run [create-qa-use-cases](../create-qa-use-cases/SKILL.md) first to bootstrap the doc from this plan + spec — add-e2e-test appends, it doesn't create.

In the phase body, name the spec file path under **Tests → E2E**. If the phase is purely backend (API-only, bot, migration), skip — happy-path E2E only required when the phase reaches the browser.

**Capture screenshots on every affected UI**: the e2e spec takes one screenshot per distinct rendered state (landing page, each modal/wizard step, success toast, final state) — not just the final state. Spec writes to Playwright's **default per-test output dir** via `testInfo.outputPath('<id>-<NN>-<view-slug>.png')` (zero-padded step number, kebab-case slug describing what's on screen). Never hard-code `pr-screenshots/` in the spec. After the suite runs, a copy step moves matching files from `test-results/**/` into `pr-screenshots/`. The `pr-screenshots/` directory is gitignored — author drags the files into the PR description in numeric order so reviewers see the journey, not just the destination. See [add-e2e-test](../add-e2e-test/SKILL.md) for the strict filename convention + spec example + copy command.

Doesn't fit → split: `Phase 4a — Static validation`, `Phase 4b — Resolution engine`, `Phase 4c — Apply engine`, `Phase 4d — View wiring`.

### Phase template

```markdown
### Phase N{a} — {Crisp imperative title, ≤8 words}

**Goal**: one sentence on user-visible (or producer-visible) outcome.
   "Ship value: none on its own" → say so explicitly + justify why scaffolding needed.

**Feature flag**: `{flag-key}` — {gated path; what runs when off vs on}.
   Omit only if phase is purely scaffolding (no reachable behavior) or **Guiding Decisions** explicitly marks "no flag — purely additive surface".

Changes:
1. {File or module}: {what changes, what stays}.
2. {Next thing}.
3. ...

Spec use-case: {SPEC **Decisions → Use-cases** id/name this phase implements, or "shared scaffolding — no use-case yet"}.

Tests:
- **Unit**: {file path} — {what it covers}.
- **Integration**: {file path} — {what it covers, including edge cases user flagged in Step 0, AND flag-off test proving existing callers see no behavior change}.
- **E2E** (only when this phase reaches the browser): {e2e/tests/<app>/<id>-<slug>.spec.ts} — happy path covering the new flow. Spec writes screenshots to the Playwright default output dir via `testInfo.outputPath(...)`; post-run copy step moves them into `pr-screenshots/<id>-<step>.png`. Follow [add-e2e-test](../add-e2e-test/SKILL.md).

**Suggested AI model**: {tier choice + why}. See "AI model selection".

**Reusable skills**: {invoke `Skill(name)` — see "Project skills"}.

Acceptance: {one literal statement true after merge + deploy of this phase, only this phase}.
```

### Gate behavior changes behind feature flag by default

Feature touches **any existing flow** — existing callers hit new branches, new fields, new constraints, new query plans, differently-shaped responses → **plan for flag from Phase 1**. Default *flag on*, not off; ask in the Step 0 **Rollout & risk** group to confirm but don't silently drop.

In plan:

1. Declare flag in **Guiding Decisions**: key, scope (per-request vs per-tenant, using the project's flag API names), default (`false`), flip-on criterion ("after Phase 5 ships + reprocess job runs clean for 48h on staging").
2. Show flag definition site (the project's feature-flag module) in **Touch List**.
3. Every phase reachable from existing caller: name flag, describe what executes when **off** (must be pre-feature behavior, byte-for-byte where possible) vs **on**.
4. Data model change unconditional (column existing can't be gated)? Make sure *reads + writes* of column gated; off-flag tenant has zero observable change. Test asserts.
5. Phase N+1 (or **Risk & Rollout Notes** entry) for **flag rollout**: enable for one internal tenant → soak → staging → cohort → globally.
6. **Always end with dedicated final phase to remove flag.** Name `Phase N — Remove the {flag-key} feature flag`. **Mandatory** when flag declared — flag debt = real debt.

Legitimate skips:

- **Purely additive new surface**: brand-new endpoint at new path, brand-new table, brand-new admin page no existing code reads/writes. Borderline-additive (new app + new endpoints alongside existing surfaces): err on the side of adding the flag — would have needed one if it had touched an existing shared table.
- **Pure refactor with no behavior change**, provable via tests + diff review. Refactors don't need flags; features do.

Unsure? Treat as not additive + add flag. Cost of unused flag = one PR. Cost of non-flagged regression = hotfix + postmortem.

### Mandatory final phase: remove flag

Flag declared → **last phase must be dedicated removal phase**. Don't roll into Phase N's "and also clean up flag"; give own number so survives scope cuts + shows up in tracking.

Gated on real-world signal, not phase number — can't merge until flag on 100% long enough. Mark clearly so doesn't get rushed.

```markdown
### Phase N — Remove the `{flag-key}` feature flag

**Goal**: delete flag + dead off-branch so feature becomes unconditional. **Prerequisite**: flag has been on for 100% of tenants in production for at least {soak window — typically 2 weeks, or one full end-of-month/quarter cycle if feature touches reporting}, with no rollback or incident attributed.

**Feature flag**: removed in this phase.

Changes:
1. Delete flag declaration in the project's feature-flag module.
2. Every site calling the flag's check methods (`is_enabled(...)` / per-tenant variant, by whatever names the project uses): inline on-branch + delete off-branch. Touch list:
   - {file 1}
   - {file 2}
   - …
3. Delete tests exercising flag-off path (added in earlier phases for backwards compatibility).
4. Flag controlled gated paths in tests via fixtures or parametrization → simplify to single (formerly on-flag) branch.
5. Search for stale references: `grep -r "{flag-key}"` + `grep -r "{FLAG_CONSTANT}"` should return zero.

Tests:
- Existing test suite passes unchanged on on-branch.
- Remove flag-parametrized tests no longer make sense.

**Suggested AI model**: Tier 1 — `claude-haiku-4-5` / `gpt-5-nano` / `gemini-2.5-flash-lite`. Mechanical deletion + inlining; cheap models excel.

**Reusable skills**: none — pure cleanup.

Acceptance: `grep -r "{flag-key}" app/ tests/` returns nothing, feature behaves identically to flag-on state, full test suite green.
```

Place as separate, numbered, last-in-list entry inside **Phased Rollout**. Also in **Touch List** under its own phase. **Required**.

### Order phases for slowest-moving dependency first

Common mistake: leave cross-repo producer wiring for last, then discover the upstream repo's deploy cadence is two weeks. Order so slowest path starts in Phase 1 (e.g. *"accept field, validate, drop on floor"*) + fast in-repo work fills in behind. Typical sequencing: `Phase 1` (API stub) → `Phase 1b` (cross-repo producer, parallel) → `Phase 2`+ (in-repo persistence).

### Never give time estimates

**Don't** write "~2 days" / "1 sprint" / "ETA: …". Time estimates for AI-implemented work pointless + become targets LLM optimizes against. **LoC sizing (`~150 LoC`) fine** — reviewability signal, not time.

## AI model selection per phase

For each phase, suggest **cheapest/fastest model likely to one-shot work**. Iterating with cheap model usually beats burning Opus tokens on CRUD scaffold.

### Tier 1 — cheapest/fastest (boilerplate, exact-precedent edits)
**Use for**: single migration adding column or index, exporting from `__init__.py`, registering admin, scaffolding empty Django app, thin serializer mirroring existing pattern verbatim.

- Anthropic: `claude-haiku-4-5`
- OpenAI: `gpt-5-nano` (fall back to `gpt-5-mini` if file has any branching logic)
- Google: `gemini-2.5-flash-lite`

### Tier 2 — standard pattern application
**Use for**: repository methods, DRF serializer with non-trivial validation, ViewSet wiring with filterset, pytest unit/integration tests against established fixtures, simple HStore/ArrayField additions.

- Anthropic: `claude-haiku-4-5` (with iteration), step up to `claude-sonnet-4-6` if phase touches >3 files
- OpenAI: `gpt-5-mini`
- Google: `gemini-2.5-flash`

### Tier 3 — multi-file orchestration, business logic, SQL views
**Use for**: use case coordinating across repositories with non-trivial branching, new `vw_*` view + non-managed model + migration, serializer with cross-field validation affecting use-case behavior, integration tests covering concurrency edges.

- Anthropic: `claude-sonnet-4-6`
- OpenAI: `gpt-5`
- Google: `gemini-2.5-pro` (or `gemini-3-pro` for stronger code recall)

### Tier 4 — architectural / novel / hard
**Use for**: cycle detection in user-mutable trees, transactional batch protocols with deferred constraints, partitioned-to-partitioned FK design, perf tuning slow query against partitioned hot table, debugging heisenbug.

- Anthropic: `claude-opus-4-7` (`[1m]` 1M-context for large codebases)
- OpenAI: `gpt-5` with extended thinking, or `o3` / `o4` for pure reasoning
- Google: `gemini-3-pro` with thinking

### Writing the suggestion

> **Suggested AI model**: Tier 1 — `claude-haiku-4-5` / `gpt-5-nano` / `gemini-2.5-flash-lite`. Single-field migration + model export, exact precedent in `@<app>/<module>/models/<file>.py`.

When one tier doesn't fit:

> **Suggested AI model**: Tier 2 for repository + serializer (Haiku 4.5 / GPT-5 mini / Gemini Flash); step up to Tier 3 (`claude-sonnet-4-6`) for integration test spanning upsert → routing → reprocess.

**Default to cheapest tier that plausibly works, not safest.** Cheap models failing fast beats expensive succeeding slowly.

## Project skills to leverage

Skills under the project's `ai-tools/skills/` directory encode hard-won conventions. **Reference by name in each relevant phase** so implementer invokes via `Skill(name)` instead of re-deriving.

| Skill | Invoke when phase… |
|---|---|
| `create-model` | adds new Django model / database table |
| `create-postgres-view` | adds or modifies `vw_*` (or MV, function, type) |
| `create-postgres-function` | adds or modifies `CREATE FUNCTION` / `upsert_ct_*` / `ft_*` / aggregate |
| `create-cloud-function` | scaffolds new serverless function |
| `create-data-export` | adds async CSV/Excel export |
| `create-data-import` | adds CSV import |
| `graphql-public-query` | adds a query/mutation under the project's public GraphQL module |
| `write-tests` | writes pytest unit/integration tests following fixture catalog + snapshot conventions |

In phase:

> **Reusable skills**: `create-postgres-view` (for the relevant `vw_*.sql` change); `write-tests` (for the integration test under the project's integration-tests dir).

No clean skill match? Omit line — don't fabricate.

## File references

`@path/to/file.py` for files relative to repo root when *naming* file inside plan body or discovery questions. Project convention; agent harness resolves.

For inline links in narrative prose, GitHub-flavored markdown links work + preferred for line-range deep-links:

```markdown
See `upsert_records` in [records.py:92-96](../<app>/<module>/models/records.py#L92-L96).
```

Don't mix styles within one sentence. In **Touch List**, use `@path` for new files + `[name](relative-path)` for edited files when want line numbers.

## What to avoid

- **No `§N` shorthand for section references — anywhere in the plan body.** Use section names: `Goals + Non-goals`, `Guiding Decisions`, `Data Model Changes`, `API Design`, `Phased Rollout`, `Risk & Rollout Notes`, `Open Questions`, `Touch List`. Readers shouldn't have to count headings to follow a cross-reference, and section numbering shifts when the spec/plan evolves. Same rule applies to citing SPEC sections (`Use-cases`, `Acceptance scenarios`, etc.) — name them.
- **No time estimates.** Use LoC sizing.
- **No vibes-based guarantees** ("should be straightforward", "trivial", "easy lift").
- **No skipped non-goals section.**
- **No phase that breaks build if merged alone.** Each independently mergeable AND independently reversible.
- **No phase requiring manual `kubectl` / SSH / "remember to run X"** without Risk & Rollout Notes checklist.
- **No assuming user wants what they asked for.** Watch for "wait, also…" + update plan.

## Worked references

When in doubt, model the plan after a recent example in `ai-plans/` — look for ones that:

- wire a cross-repo producer (`Phase 1b` parallel to in-repo phases) with an "API contract first, persist later" rollout;
- split a large mutation phase into `4a/4b/4c/4d` sub-phases;
- stay small + sharply scoped by following an existing precedent on the same entity;
- use a feature-flagged staged rollout across many small phases.

## Checklist

- [ ] Step 0 questions answered (or explicitly waived); decisions echoed back.
- [ ] Filename: `ai-plans/{TODAY}-{FEATURE_NAME}_IMPLEMENTATION_PLAN.md`.
- [ ] **Goals + Non-goals** section present.
- [ ] **Guiding Decisions** table — each row has *why*.
- [ ] Phases MR-sized (~100–300 LoC) + independently mergeable.
- [ ] Phase numbering uses numbers + letters consistently.
- [ ] **At least one phase per spec use-case** (entries under SPEC **Decisions → Use-cases**). No phase implements two use-cases. Cross-cutting scaffolding is its own foundation phase.
- [ ] Each phase has Goal / Spec use-case / Feature flag (or explicit waiver) / Changes / Tests / Suggested AI model / Reusable skills / Acceptance.
- [ ] Every phase introducing a new UI flow has an **E2E happy-path test** in its Tests block, with screenshot output to `pr-screenshots/`.
- [ ] Feature flag declared in **Guiding Decisions** (key, scope, default, flip-on criterion) **unless** **Guiding Decisions** explicitly justifies "no flag — purely additive surface".
- [ ] ≥1 test per gated phase asserts flag-off behavior unchanged.
- [ ] If flag declared, **final entry under Phased Rollout is dedicated flag-removal phase** with prerequisite (soak window), full deletion touch list, `grep` acceptance check.
- [ ] No time estimates anywhere.
- [ ] Cross-repo phases labeled `Phase Nb`, deploy ordering called out.
- [ ] Risk & Rollout Notes covers locks, partitions, backfills, rollback.
- [ ] Open Questions lists what couldn't resolve, with recommended default.
- [ ] Touch List groups files by phase.
- [ ] All file references use `@path/to/file.py` or `[name](relative-path#Lline)`.