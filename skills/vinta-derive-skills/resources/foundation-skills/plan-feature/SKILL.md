---
name: plan-feature
description: Author a phased implementation plan for a new feature following the repo's `ai-plans/` conventions — including the dependency graph that lets independent phases be implemented in parallel. Use when the user asks to "plan", "design", "scope", or "break down" a feature, write an implementation plan / IMPLEMENTATION_PLAN.md, or turn a spec/idea into a phased roadmap. Always interrogates the requester before drafting.
---

# Plan Feature

Plans live in `ai-plans/` as `YYYY-MM-DD-FEATURE_NAME_IMPLEMENTATION_PLAN.md` (uppercase + underscores). `..._SPEC.md` sibling exists → **read first**. Plan translates spec into phased delivery, doesn't re-derive requirements. No spec? Point at [create-spec](../create-spec/SKILL.md) first; plan without spec = plausible-sounding but unverified. Spec/plan pair share `YYYY-MM-DD-FEATURE_NAME` prefix.

Every plan ships **two** files: the markdown above, and its executable sibling `ai-plans/<feature-kebab>.workflow.json` — the same phase graph in the form an orchestrator runs. See "Emit the executable workflow". Written every time; never gated on a question.

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
3. **Phase granularity:** one phase per spec use-case (more, smaller PRs) or allow bundling closely-related use-cases (fewer, larger phases)? **Default: one use-case per phase** — confirm or override. Drives the "One use-case per phase" rule under **Phase structure**.
4. **Hard sequencing constraints:** anything that *must* land before something else for a reason the code doesn't show — a deploy window, a data backfill that has to finish first, an external team's review, a contract another repo is already coding against? Name them. Everything else gets its dependency edge from the code itself (see **Phase dependencies and parallel execution**), and the executor runs whatever is independent at the same time.
5. **Parallelism appetite:** is the team fine with several phases being implemented concurrently — several open PRs at once, several branches in flight, reviewers seeing a fan of PRs instead of a chain? **Default: yes.** Say no when review capacity is the bottleneck rather than implementation, or when the repo has a merge queue that serializes anyway.

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
<!-- e2e:start -->
4. **E2E coverage (opt-in)** — should this plan include happy-path Playwright e2e specs for its new UI flows? **Default: NO.** E2E specs make the *implementation* run take a lot longer (browser boot, seeded data, screenshot capture on every affected view, per phase). Opt in only when the flow is high-risk or explicitly QA-gated. When off, phases ship unit + integration tests only and carry no e2e requirement — e2e can still be added later, per-flow, via [add-e2e-test](../add-e2e-test/SKILL.md).
<!-- e2e:end -->

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
   Opens with the **Execution graph** table (see "Phase dependencies and
   parallel execution"), then the phases. See "Phase structure" below.

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

**Numbering is a reading aid, not an execution order.** What actually orders the build is each phase's `**Depends on**:` line — see below. Number the phases so a human reads them top to bottom in a sensible narrative; let the dependency graph decide what runs when.

## Phase dependencies and parallel execution

[implement-plan](../implement-plan/SKILL.md) implements phases **concurrently** — one worktree lane per phase in flight — whenever the graph says two phases don't need each other. That only works if the plan says what needs what. So every phase carries a `**Depends on**:` line, and **Phased Rollout** opens with the graph those lines imply.

### `**Depends on**:` — one line per phase, always present

```markdown
**Depends on**: Phase 1 (the `BookmarkFolder` model and its migration), Phase 2 (the `bookmark_repository.list_for_user` method this endpoint calls).
```

or, for a phase that needs nothing:

```markdown
**Depends on**: nothing — starts from the base branch.
```

Rules:

- **Name a phase only when this phase's code would not compile, import, or pass its tests without it.** The dependency is a *code* fact: a model, a column, a symbol, a migration, an endpoint, a fixture. If you can't name the artifact, there is no edge.
- **One clause per edge, naming the artifact.** The prose after the em dash is what the reviewer (and the implementer's prompt) reads to understand the coupling. `**Depends on**: Phase 1` with no reason is a smell — usually it means "Phase 1 comes first in the list", which is not a dependency.
- **Don't chain by habit.** The most common planning mistake here is writing `Phase 4` depends on `Phase 3` depends on `Phase 2` when in truth all three only need the Phase 1 migration. That single reflex turns a 3-lane plan into a 4-week queue.
- **Do declare the edges that exist.** The opposite failure is worse: two phases that both rewrite the same use case, declared independent, get implemented simultaneously against divergent bases and collide at merge.
- **No cycles.** Two phases that need each other are one phase, or the boundary is drawn in the wrong place.
- **Cross-repo phases (`Phase Nb`) can be depended on**, but everything downstream of one inherits its deploy cadence — and the executor defers the whole subtree. Prefer designing so in-repo work depends on a *contract* (accept and drop the field) rather than on the producer actually shipping.

### The Execution graph table

First thing under **Phased Rollout**, before the phases:

```markdown
### Execution graph

Wave = how deep a phase sits in the dependency graph. Phases in the same wave have no
dependency on each other and are implemented concurrently.

| Wave | Phases | Depends on |
|---|---|---|
| 1 | Phase 0, Phase 1b | — |
| 2 | Phase 1, Phase 2 | Phase 0 |
| 3 | Phase 3 | Phase 1, Phase 2 |
| 4 | Phase 4 — remove the `bookmarks-v2` flag | Phase 3 (deferred — soak-gated) |

**File overlap:** phases in the same wave touch disjoint files, with one exception —
Phase 1 and Phase 2 both export from `@app/bookmarks/__init__.py`. Trivial merge.
```

The table is **derived from the `**Depends on**:` lines, not authored independently.** Compute it: a phase with no dependencies is wave 1; otherwise its wave is one past the deepest phase it depends on. The executor recomputes this and will flag a table that disagrees.

The `depends_on` edges in the workflow JSON come off the **same** lines — table and JSON are two renderings of one graph, never two graphs kept in sync by hand. See "Emit the executable workflow".

### Same-wave phases must not fight over the same files

Before publishing the plan, cross-check the **Touch List**: for every pair of phases in the same wave, look at their file sets. Overlap means two agents editing one file on two branches at once, and a merge conflict at the wave boundary.

- **Trivial overlap** (a shared `__init__.py`, a settings registry, a route table) — fine. Note it under the graph table so the reviewer isn't surprised.
- **Real overlap** (the same use case, the same serializer, the same view) — **add the dependency edge** and let one phase build on the other. A serialized pair that merges cleanly beats a parallel pair that needs a human to untangle.

### Design *for* parallelism when it's cheap

Two habits pay for themselves:

- **Front-load shared scaffolding into a wave-1 foundation phase.** Types, the migration, the empty module, the fixture. Every use-case phase then depends only on that one phase, and they all run at once, instead of forming a chain.
- **Split by seam, not by layer, when the seams are independent.** Four use-cases on the same entity are four independent phases if they only share the model. Four layers of one use-case (repository → service → serializer → view) are a chain no matter how you number them.

Don't contort the plan for concurrency, though. A genuinely sequential feature is a chain of waves of one, and that is a correct plan.

### Read the previous runs' post-mortems before drawing the graph

Every plan you write is a guess about coupling. Every plan the orchestrator *ran* turned that guess into evidence, and it wrote the evidence down: one `postmortem.json` per finished run under `.vinta-flow/runs/<run-id>/`, plus any copy the team committed beside its plan as `ai-plans/<feature-kebab>.postmortem.json`. **Read them before the `**Depends on**:` lines, not after.** Newest first, and all of them — one run is an anecdote, three runs saying the same thing about the same layer is a rule about this codebase.

```bash
ls -t .vinta-flow/runs/*/postmortem.json ai-plans/*.postmortem.json 2>/dev/null | head -5
```

Each file carries `findings` and `gaps`. Use them like this:

- **`missing_dependencies`** — a phase failed, a phase it did *not* declare landed, and only then did it pass. The previous plan was missing that edge. If this feature couples the same two layers, **declare the edge here**, naming the artifact. Entry is ordering evidence, not proof (the file's own `gate_result_unrecorded` gap says so) — confirm the coupling exists in the code before you draw it.
- **`wave_conflicts`** — two same-wave phases that actually fought, with the contested `paths`. Cross-check those paths against this plan's **Touch List**: two phases of yours touching one of them in the same wave is the same defect repeating. Add the edge, or split so only one phase owns the file.
- **`duration_divergences`** — `direction: "longer"` means that phase set its wave's wall clock alone, so every peer you parallelised it with bought nothing; keep comparable-size work together and let the long pole start in wave 1. `"shorter"` means a small phase sat behind a long one and could have been folded in or moved earlier. Sizing, never time estimates in the plan body.
- **`unused_dependencies`** — edges the run proved nobody needed. Drop the equivalent edge here. **Empty is not evidence of a tight graph**: check `gaps` first, because a `dependency_use_unrecorded` entry means dependency use was never measured on that run, not that every edge earned its place.

Rules for using them:

- **Match by artifact and path, never by phase id.** `p3` in an old run is not `Phase 3` here. The transferable fact is "the serializer phase needed the migration phase's column", not the id.
- **A finding is an input, not plan content.** Don't quote post-mortems in the plan body, don't cite run ids, don't add a section about them. They change edges, waves and splits — that's all the reader should ever see.
- **No post-mortems in the repo?** Nothing to do, and nothing to say about it. Draw the graph from the code.

### Each phase MR-sized

Reviewer should read ≤1500 LoC + understand in isolation. Guidelines:

- **Target**: Up to 1500 LoC (tests included).
- **One concern per phase.** "Add field + write migration + wire into 4 use cases + update 3 SQL views" = four phases.
- **Independently mergeable.** Phase N merged + Phase N+1 stalled → system still working. No half-finished features behind flag with no flag-on path.
- **Own tests.** Every phase ships unit/integration tests. No "tests come in Phase 8."
- **Acceptance criterion.** Each phase ends with one-line "Acceptance:" — literally testable.

### One use-case per phase (default — confirm in Step 0)

**Default ON.** Skip only when the Step 0 **Phase granularity** answer opted into bundling. When on: every spec use-case (entries under **Decisions → Use-cases** in the SPEC) gets **its own phase**. Never bundle two use-cases in one phase even when the diff is tiny. Bundling = larger PR + reviewer needs context for both flows + rollback drags both. Cost of an extra phase = one PR header. Cost of a bundled regression = hotfix + split-after-the-fact.

When on, apply even when:
- Two use-cases share the same endpoint — split anyway, the second phase is "wire use-case 2 into the existing endpoint." Reviewer reads ≤50 LoC.
- Use-cases are CRUD on same entity — Create / Read / Update / Delete are four phases, not one.
- "It's just one extra branch" — that branch hides edge cases. Separate phase forces explicit acceptance + tests for that branch.

**If the user opted into bundling** (Step 0): group closely-related use-cases into one phase where it reduces churn, but each phase still stays MR-sized (≤1500 LoC), one concern, independently mergeable, with its own tests + acceptance. Bundling is a granularity dial, not a license for kitchen-sink phases.

Cross-cutting infra (shared types, migration, scaffolding) lands in a foundation phase before the use-case phases. Each subsequent use-case phase consumes that scaffolding.

<!-- e2e:start -->
### Phases creating a new UI flow ship happy-path E2E — only when e2e coverage was opted into

**Gated on the Step 0 group I "E2E coverage" answer, which defaults to NO.** When e2e coverage was **not** opted in (the default), skip this section entirely: phases ship unit + integration tests only, name no e2e spec, and add no `QA_USE_CASES.md` / `pr-screenshots/` machinery. E2E specs make the implementation run take a lot longer, so they are opt-in per plan, not automatic.

**When e2e coverage was opted in:** every phase that introduces or substantially changes a user-facing flow (new page, new modal, new wizard step, new gated action) ships a Playwright e2e test covering at least the happy path in the same MR. Follow the [add-e2e-test](../add-e2e-test/SKILL.md) skill: pick the next free `PA###` / `PR###` id, update [QA_USE_CASES.md](QA_USE_CASES.md), add the page object + spec. **No `QA_USE_CASES.md` in the project yet?** Run [create-qa-use-cases](../create-qa-use-cases/SKILL.md) first to bootstrap the doc from this plan + spec — add-e2e-test appends, it doesn't create.

In the phase body, name the spec file path under **Tests → E2E**. If the phase is purely backend (API-only, bot, migration), skip — happy-path E2E only applies when the phase reaches the browser.

**Capture screenshots on every affected UI**: the e2e spec takes one screenshot per distinct rendered state (landing page, each modal/wizard step, success toast, final state) — not just the final state. Spec writes to Playwright's **default per-test output dir** via `testInfo.outputPath('<id>-<NN>-<view-slug>.png')` (zero-padded step number, kebab-case slug describing what's on screen). Never hard-code `pr-screenshots/` in the spec. After the suite runs, a copy step moves matching files from `test-results/**/` into `pr-screenshots/`. The `pr-screenshots/` directory is gitignored — author drags the files into the PR description in numeric order so reviewers see the journey, not just the destination. See [add-e2e-test](../add-e2e-test/SKILL.md) for the strict filename convention + spec example + copy command.
<!-- e2e:end -->

Doesn't fit → split: `Phase 4a — Static validation`, `Phase 4b — Resolution engine`, `Phase 4c — Apply engine`, `Phase 4d — View wiring`.

### Phase template

```markdown
### Phase N{a} — {Crisp imperative title, ≤8 words}

**Goal**: one sentence on user-visible (or producer-visible) outcome.
   "Ship value: none on its own" → say so explicitly + justify why scaffolding needed.

**Depends on**: {phase ids, each with the artifact this phase needs from it — or `nothing — starts from the base branch`}. See "Phase dependencies and parallel execution". **Required on every phase**; the executor refuses to guess.

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
<!-- e2e:start -->
- **E2E** (only when e2e coverage was opted into at Step 0 AND this phase reaches the browser): {e2e/tests/<app>/<id>-<slug>.spec.ts} — happy path covering the new flow. Spec writes screenshots to the Playwright default output dir via `testInfo.outputPath(...)`; post-run copy step moves them into `pr-screenshots/<id>-<step>.png`. Follow [add-e2e-test](../add-e2e-test/SKILL.md).
<!-- e2e:end -->

**Suggested AI model**: {tier choice + why}. See "AI model selection".

**Review models** (optional — omit for the project defaults): reviewer Tier {N}, fixer Tier {N} — {why this phase warrants a non-default review model}. See "AI model selection".

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

**Depends on**: every gated phase — {list them} — since this phase deletes the branches they added.

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

**Suggested AI model**: Tier 1 (IDs in `resources/ai-models.yaml`). Mechanical deletion + inlining; cheap models excel.

**Reusable skills**: none — pure cleanup.

Acceptance: `grep -r "{flag-key}" app/ tests/` returns nothing, feature behaves identically to flag-on state, full test suite green.
```

Place as separate, numbered, last-in-list entry inside **Phased Rollout**. Also in **Touch List** under its own phase. **Required**.

### Put the slowest-moving dependency in wave 1

Common mistake: leave cross-repo producer wiring for last, then discover the upstream repo's deploy cadence is two weeks. Give the slow path **no dependencies** so it starts in wave 1 (e.g. *"accept field, validate, drop on floor"*) + let fast in-repo work fill in behind it. Typical shape: `Phase 1` (API stub) and `Phase 1b` (cross-repo producer) both depend on nothing and run in wave 1; `Phase 2`+ (in-repo persistence) depends on `Phase 1` only — so it does **not** wait on the cross-repo lane.

Watch for the accidental version of this: making an in-repo phase `**Depends on**: Phase 1b` when it only needs the *contract*, not the producer's deploy. That one edge parks the whole in-repo plan behind another team's release train.

### Flag-removal phase depends on everything

The mandatory final flag-removal phase depends on **every** gated phase — it deletes the branches they added. Say so in its `**Depends on**:` line. It sits alone in the deepest wave and is deferred by the executor anyway (soak-gated), so this edge costs nothing and documents the real constraint.

### Never give time estimates

**Don't** write "~2 days" / "1 sprint" / "ETA: …". Time estimates for AI-implemented work pointless + become targets LLM optimizes against. **LoC sizing (`~150 LoC`) fine** — reviewability signal, not time.

## AI model selection per phase

For each phase, suggest **cheapest/fastest model likely to one-shot work**. Iterating with cheap model usually beats burning Opus tokens on CRUD scaffold.

**Scope: the plan always picks the *implementer* model, and MAY override the reviewer / fixer models per phase.**

- `**Suggested AI model**:` drives the implementer subagent that writes the phase — **required on every phase**.
- `**Review models**:` (optional) overrides the reviewer and/or fixer tier **for this phase only**. Use it when a phase is riskier than average — high blast-radius change, subtle concurrency / transaction logic, security-sensitive surface, a migration that's hard to undo — and you want a more capable reviewer or fixer than the project default. Name a tier for reviewer, fixer, or both; omit either to leave that role on the default.
- **Precedence** (resolved by `implement-plan` / `review-phase`): a phase's `**Review models**:` override wins → else the project-wide `agent_models.reviewer` / `agent_models.fixer` tier in `.vinta-ai-workflows.yaml` → else the runtime default. So the project keeps sane defaults and the plan only speaks up for the phases that need a different review model.
- The mechanical-step models (worktree prep, opening the PR / integrate) are **not** plan-owned — they stay under `agent_models` in `.vinta-ai-workflows.yaml`. Don't add worktree/PR model hints to a phase; they'd be ignored.

**Most phases carry only the implementer line.** Add `**Review models**:` deliberately, for the few phases that earn it — not by default on every phase.

**Concrete model IDs per tier live in [resources/ai-models.yaml](resources/ai-models.yaml) — read that file when writing each suggestion. Never recall model names from memory; they go stale as vendors ship.** The tiers below define *when* each applies (stable judgement); the IDs drift, and a nightly job keeps the resource current. Note the file's `last_verified` date — if it's far in the past, the IDs may be stale; flag that rather than trusting them blindly.

### Tier 1 — cheapest/fastest (boilerplate, exact-precedent edits)
**Use for**: single migration adding column or index, exporting from `__init__.py`, registering admin, scaffolding empty Django app, thin serializer mirroring existing pattern verbatim.

### Tier 2 — standard pattern application
**Use for**: repository methods, DRF serializer with non-trivial validation, ViewSet wiring with filterset, pytest unit/integration tests against established fixtures, simple HStore/ArrayField additions.

### Tier 3 — multi-file orchestration, business logic, SQL views
**Use for**: use case coordinating across repositories with non-trivial branching, new `vw_*` view + non-managed model + migration, serializer with cross-field validation affecting use-case behavior, integration tests covering concurrency edges.

### Tier 4 — architectural / novel / hard
**Use for**: cycle detection in user-mutable trees, transactional batch protocols with deferred constraints, partitioned-to-partitioned FK design, perf tuning slow query against partitioned hot table, debugging heisenbug.

### Writing the suggestion

Pick the tier from the rubric above, then pull the matching vendor IDs out of [resources/ai-models.yaml](resources/ai-models.yaml):

> **Suggested AI model**: Tier 1 (IDs in [resources/ai-models.yaml](resources/ai-models.yaml)). Single-field migration + model export, exact precedent in `@<app>/<module>/models/<file>.py`.

When one tier doesn't fit, name both:

> **Suggested AI model**: Tier 2 for repository + serializer; step up to Tier 3 for the integration test spanning upsert → routing → reprocess. IDs per tier in [resources/ai-models.yaml](resources/ai-models.yaml).

### Overriding the review models on a critical phase (optional)

Add a `**Review models**:` line **only** when the phase justifies a non-default reviewer / fixer. Pick the tier from the same rubric — a higher tier for the *review* of a delicate change, not for its authoring:

> **Review models**: reviewer Tier 4 — this phase rewrites the transactional batch-apply protocol with deferred constraints; a subtle ordering bug here corrupts data, so the independent review runs on the most capable model. Fixer left on the project default.

Name only the role you're changing (`reviewer`, `fixer`, or both). Omitting the line entirely — the common case — leaves both roles on the project's `agent_models` defaults.

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

## Emit the executable workflow

Alongside the markdown plan, write `ai-plans/<feature-kebab>.workflow.json` — same directory, feature name lowercased with hyphens (`BOOKMARK_FOLDERS` → `ai-plans/bookmark-folders.workflow.json`), no date prefix. The markdown is what humans review; the JSON is the same phase graph in the form an orchestrator runs — one worktree lane per phase, branches cut from each phase's dependencies, gates queued behind capacity limits instead of stampeding.

**Unconditional.** Write it on every plan. Don't ask, don't gate it on a config field, don't skip it because the project has no orchestrator installed — a project without one carries a few KB it never reads, and a project that installs one later finds its plans already executable. The one thing that is *not* free is emitting it inconsistently: a half-populated `ai-plans/` teaches the team the file is optional.

**It is not a second source of truth.** Every value in it is read off the plan you just wrote. Write the plan first, then transcribe. If a field has no answer in the plan, the plan is missing something — go fix the plan, not the JSON.

First key in the file is `"$schema"`, pointing at `https://github.com/vintasoftware/vinta-ai-workflows/schemas/workflow.v1.schema.json`. Editors validate against it as you type, which is when a typo is cheap; without it the first thing that reads the file is the executor, an hour into a run.

### Mapping the plan onto the document

| Field | Comes from |
|---|---|
| `$schema` | The URL above, literally. |
| `schema_version` | `1`. |
| `id` | The feature kebab — same slug as the filename. It lands in branch names (`plan/{id}/wave-2`), so kebab-case only, no dates, no underscores. |
| `plan_ref` | Repo-relative path of the markdown plan, e.g. `ai-plans/2026-03-04-BOOKMARK_FOLDERS_IMPLEMENTATION_PLAN.md`. |
| `plan_context_refs` | The two plan sections that bound **every** phase, as anchors into the plan you just wrote: `<plan_ref>#1-goals` (which carries Non-goals with it) and `<plan_ref>#2-guiding-decisions`, in that order. Same file-and-anchor form as `prompt_ref`. See "Plan-level context". |
| `base_branch` | What `**Depends on**: nothing — starts from the base branch` means concretely: the repo's default branch, unless **Guiding Decisions** names a long-lived feature branch. |
| `project` | The databases a lane must **fork** to be a working checkout, plus the command that migrates the template they are forked from. Omit entirely when lanes can share the main checkout's database — see "The `project` block". This is the one part of the document you *ask* about rather than transcribe. |
| `defaults.harness` | The agent CLI the team runs — `claude-code`, `codex`, or `opencode`. `claude-code` unless the project says otherwise. |
| `defaults.model` | The concrete model id for the tier **most** phases carry, pulled from [resources/ai-models.yaml](resources/ai-models.yaml). |
| `defaults.pipeline` | `standard-phase` — see "The pipeline block". |
| `defaults.max_session_turns` | Omit (defaults to 12). It caps how many turns one reused agent session may take before the executor starts a fresh one; the executor reuses sessions across a phase's implement and fix turns, so this is a context-window guard rather than something a plan tunes. |
| `resources.lane` | `{"capacity": N, "kind": "worktree"}`. **Required** — a lane pool is where phases are dispatched, and a workflow without one has nowhere to run. `N` = the project's parallel-lane budget (3 when unstated); it is a hint, not a cap the plan enforces. |
| `resources.<pool>` | One `{"kind": "semaphore"}` pool per expensive shared thing a gate contends for — the test database, the e2e browser grid, a staging deploy slot. `capacity: 1` when only one can run at a time. |
| `gates.<id>` | The checks a phase must pass, as **shell commands run in the phase's lane** — the project's real typecheck / test / lint invocations, not an agent and not prose. Give the slow ones `requires` naming the pool they contend for, and a `timeout_s` that is generous rather than tight. |
| `nodes[]` | One per phase, in plan order. |
| `nodes[].id` | `p` + the phase number, lowercased: `Phase 1` → `p1`, `Phase 4a` → `p4a`, `Phase 1b` → `p1b`. |
| `nodes[].name` | The phase title without its `Phase N —` prefix. |
| `nodes[].prompt_ref` | `<plan_ref>#phase-<number>` — the anchor of that phase's heading. Anchor on the number, not the slugified full title: the number is the part that survives a title edit, and the phase brief the implementer reads is located by its `### Phase N` prefix. |
| `nodes[].depends_on[]` | **One entry per clause** of the phase's `**Depends on**:` line, each carrying both `node` (the upstream node id) and `artifact` (that clause's prose, minus the phase reference). |
| `nodes[].touches` | That phase's **Touch List** entries as plain repo-relative paths — strip the `@` prefix and any markdown link syntax, keep the trailing `/` on a directory. |
| `nodes[].gates` | The gate ids this phase must pass, in the order they should run. |
| `nodes[].model` / `nodes[].harness` | **Only** when this phase differs from `defaults` — the id for its `**Suggested AI model**:` tier when that tier isn't the default one. Every phase repeating the default is noise that goes stale on the next model bump. |
| `nodes[].max_fix_rounds` | Omit (defaults to 2). Set it higher only on a phase whose review you expect to iterate — a delicate migration, a concurrency protocol. |
| `nodes[].pipeline` | Omit. A per-phase pipeline is for a phase that genuinely runs a different lifecycle, which is rare enough that needing it is a signal to re-read the plan. |
| `pipelines` | **Omit.** The executor ships `standard-phase` — see "The pipeline block". |

Rules the mapping depends on:

- **`artifact` is required on every edge, and it is the clause's own prose.** It is what the implementer's prompt uses to explain what this phase builds on, so the value is what the clause says the phase needs — "the `BookmarkFolder` model and its migration" — never `p1`, never "depends on Phase 1". If the `**Depends on**:` line has no artifact to transcribe, the edge shouldn't exist; see "`**Depends on**:` — one line per phase, always present".
- **`touches` is what the same-wave overlap check reads.** Executors *warn* on two same-wave nodes declaring the same path rather than refusing, so an incomplete Touch List doesn't fail loudly — it fails at merge. Transcribe every file the phase creates or edits, including tests.
- **Never invent a model id.** Pick the tier from the rubric under "AI model selection per phase", then read the id out of [resources/ai-models.yaml](resources/ai-models.yaml). Ids drift; tiers don't.
- **Gate commands must be commands the repo actually runs today.** Read them out of the project's task runner (`package.json` scripts, `Makefile`, `pyproject.toml`, CI config) rather than guessing a conventional one. A gate that doesn't exist fails every phase identically, and looks like a code problem.
- **The graph must agree with the Execution graph table.** Same nodes, same edges, same waves — they are two renderings of one set of `**Depends on**:` lines, so derive both from the lines rather than transcribing one from the other. A disagreement means one was hand-edited, and the executor flags it.
- **`plan_context_refs` is anchors, never prose.** It names sections of the plan; it never restates them. A summary written into the JSON is a second copy that drifts the first time someone edits the plan, and the whole point of the field is that the implementer reads what the plan actually says.

### Plan-level context

`prompt_ref` gives a phase its own body. It gives it nothing else — and a phase body alone is how an implementer ends up building something the plan explicitly ruled out, or re-deciding a question **Guiding Decisions** already closed. `plan_context_refs` is where the plan hands every phase the two sections that bound all of them:

```json
"plan_context_refs": [
  "ai-plans/2026-03-04-BOOKMARK_FOLDERS_IMPLEMENTATION_PLAN.md#1-goals",
  "ai-plans/2026-03-04-BOOKMARK_FOLDERS_IMPLEMENTATION_PLAN.md#2-guiding-decisions"
]
```

The executor resolves each reference the same way it resolves a `prompt_ref` — file, then the named heading's section down to the next heading of the same depth — and hands the text to the implementer and the reviewer **verbatim**, under a heading that says it is the plan's and not the phase's.

Rules:

- **Anchor on the heading as you wrote it.** The **Plan structure** section numbers those headings — `## 1. Goals`, `## 2. Guiding Decisions` — so their anchors are `#1-goals` and `#2-guiding-decisions`. Write the anchor of the heading that is actually in your plan: an anchor that resolves to nothing fails the phase loudly at spawn time, before any code is written.
- **Goals carries Non-goals.** Non-goals is a bulleted list *inside* the **Goals** section, so one anchor delivers both. That is why `#1-goals` is not optional here — the non-goals are the half that stops scope creep.
- **Two entries, both of them.** Not **Data Model Changes** (large, and the phase body names the models it touches), not **Risk & Rollout Notes**, not the whole plan file. Every extra section is paid for in every phase's prompt, twice — once for the implementer, once for the reviewer.
- **Emit it on every plan**, exactly like the file itself. A workflow without it still runs; its phases just each rediscover the boundaries the plan already drew.

### The `project` block

Every other field in the document is transcribed from the plan. This one is not: nothing in a feature plan says how the project's databases are delivered, and without the block an executor gives each phase a git worktree and nothing else. Every phase's gate then runs against the same database — so a phase that adds a migration changes the schema every other lane is tested against, and a suite that leaves rows behind changes what the next lane sees. A `test-suite` pool does not fix that: a semaphore orders the suites, it does not give them separate data.

`project` says what a lane must **fork** to be a working checkout of this repo. It is optional, and omitting it is a real answer: a repo whose tests need no database at all, or whose suite builds an in-memory one per process, has nothing to declare.

**Sharing is the absence of a declaration.** There is no `"share"` value and no `"none"` value, for either role. A lane that reads the main checkout's database has no database of its own to describe, so it says nothing — and a declared database is always forked.

Two roles, each optional and each declared separately:

- **`dev`** — the database the app runs against inside the lane.
- **`test`** — the database the gate commands run against. This is the one that matters most: declare it whenever a gate touches a database.

`migrate_cmd` is the project's own migrate command. It runs **once per template database**, never per lane — that is what makes the Nth lane cost a copy instead of a provision. Read it out of the project's task runner, the same way gate commands are read, rather than guessing a conventional one.

Fields per database, by engine:

| `engine` | Fields | What they mean |
|---|---|---|
| `postgres` | `delivery`, `name`, `server_url`, `connection_url_var` | `delivery: "external"` forks a new database on a server that is already running — the cheap mode, and the one to prefer, because N lanes cost N cheap clones against one server. `delivery: "compose"` boots the lane its own server on its own forked volume: there is no template to clone from, so such a lane is single-use and gets re-provisioned rather than reset. `name` is the **main checkout's** database name; lane names are derived from it. `server_url` is the server *without* the database path segment — `postgres://localhost:5432`. |
| `sqlite` | `path`, `connection_url_var` | `path` is the repo-relative path of the database file, e.g. `db.sqlite3`. The lane gets its own copy of it. |

**Each role names its own database.** A lane's copy is named from `name` (or `path`) and the lane — the role is not part of it — so declaring `dev` and `test` with the same `name` makes both roles resolve to one forked database and one template. Give them the names the project already uses for them: `bookmarks` and `bookmarks_test`, `db.sqlite3` and `db.test.sqlite3`.

`connection_url_var` is the **name** of the env var the project already reads its connection string from — `DATABASE_URL`, `TEST_DATABASE_URL`, whatever the settings module names. The executor sets it per lane. Never write a connection string with credentials in it here: this file is committed beside the plan, and `server_url` is a host and port, not a login.

**What does not belong in this block.** Everything a worktree's own provisioning discovers and records per worktree: dependency install-or-link strategy, env file copying, `COMPOSE_PROJECT_NAME` and network naming, volume forks, sandbox tier, redis database indices, S3 prefixes, seed commands, and the `reset_cmd` for each forked database. Those are the `prepare-worktree` skill's, are decided when a lane is created, and are read back off the summary it writes per worktree. `project` records only what has to be known *before* any worktree exists.

#### Asking for it

Read the project first so the questions carry real defaults — the settings module, `.env.example`, `compose.yaml` / `docker-compose.yml`, the migrations directory, and the task runner. If none of that exists, the repo has no database: omit `project` and ask nothing.

Otherwise issue **one `AskUserQuestion` call** carrying both questions:

1. *"What does a phase lane need its own copy of?"* — options: `Nothing — lanes share the main database`, `Test database only`, `Dev and test databases`, `Dev database only`. Put the default you found in the question header ("this repo's suite reads `TEST_DATABASE_URL` — default: test only").
2. *"How is that database delivered?"* — options: `Postgres on a server that is already running`, `Postgres started by Docker Compose`, `SQLite file in the repo`. Both questions ride the same call; if the answer to the first is `Nothing`, this answer is discarded rather than asked again.

The remaining values — `migrate_cmd`, the database names, the server URL, the env var names — are **read out of the project, not asked**. They already exist in its settings, its compose file and its task runner, and a question whose answer is on disk wastes a turn. Echo what you found in the read-back summary so a wrong guess gets corrected before the file is written, and fall back to a plain-prose question only where the repo genuinely does not say.

### The pipeline block

`pipelines` describes what happens *within* one phase — implement → review → fix → gate → integrate — as opposed to `nodes`, which describes what happens *between* phases. It is fixed machinery, not a planning decision.

**Omit `pipelines` entirely.** Naming `standard-phase` in `defaults.pipeline` is enough: the executor ships that pipeline and supplies it. Do not paste a copy into the plan — a pasted pipeline is a copy that cannot be fixed centrally, so an executor-side correction would never reach a plan already written, and a hand-edited one is how a plan silently stops running its reviewer.

Author a `pipelines` block only when a project genuinely needs a *different* lifecycle. That is an executor-configuration decision made once per project, not a per-plan choice, and a declared id shadows the shipped pipeline of the same name.

### Worked example

A five-phase plan whose `**Depends on**:` lines are:

```markdown
### Phase 1 — BookmarkFolder model + migration
**Depends on**: nothing — starts from the base branch.

### Phase 2 — Folder CRUD endpoints
**Depends on**: Phase 1 (the `BookmarkFolder` model and its migration).

### Phase 3 — Folder tree serializer
**Depends on**: Phase 1 (the `BookmarkFolder.parent` self-FK the tree is walked over).

### Phase 4 — Nested folder listing endpoint
**Depends on**: Phase 2 (the `/api/folders` viewset this list action is added to), Phase 3 (the `FolderTreeSerializer` payload shape).

### Phase 5 — Remove the `bookmark-folders` feature flag
**Depends on**: Phase 2 (the flag branches the CRUD endpoints added), Phase 3 (the flag branch in the tree serializer), Phase 4 (the flag branch in the nested listing action).
```

which give this **Execution graph** table:

```markdown
| Wave | Phases | Depends on |
|---|---|---|
| 1 | Phase 1 | — |
| 2 | Phase 2, Phase 3 | Phase 1 |
| 3 | Phase 4 | Phase 2, Phase 3 |
| 4 | Phase 5 — remove the `bookmark-folders` flag | Phase 2, Phase 3, Phase 4 (deferred — soak-gated) |
```

and this `ai-plans/bookmark-folders.workflow.json`:

```json
{
  "$schema": "https://github.com/vintasoftware/vinta-ai-workflows/schemas/workflow.v1.schema.json",
  "schema_version": 1,
  "id": "bookmark-folders",
  "plan_ref": "ai-plans/2026-03-04-BOOKMARK_FOLDERS_IMPLEMENTATION_PLAN.md",
  "plan_context_refs": [
    "ai-plans/2026-03-04-BOOKMARK_FOLDERS_IMPLEMENTATION_PLAN.md#1-goals",
    "ai-plans/2026-03-04-BOOKMARK_FOLDERS_IMPLEMENTATION_PLAN.md#2-guiding-decisions"
  ],
  "base_branch": "main",
  "project": {
    "migrate_cmd": "uv run python manage.py migrate",
    "databases": {
      "dev": {
        "engine": "postgres",
        "delivery": "external",
        "name": "bookmarks",
        "server_url": "postgres://localhost:5432",
        "connection_url_var": "DATABASE_URL"
      },
      "test": {
        "engine": "postgres",
        "delivery": "external",
        "name": "bookmarks_test",
        "server_url": "postgres://localhost:5432",
        "connection_url_var": "TEST_DATABASE_URL"
      }
    }
  },
  "defaults": {
    "harness": "claude-code",
    "model": "claude-sonnet-5",
    "pipeline": "standard-phase"
  },
  "resources": {
    "lane": {
      "capacity": 3,
      "kind": "worktree",
      "description": "Concurrent phase worktrees. Matches the project's max_parallel_lanes."
    },
    "test-suite": {
      "capacity": 1,
      "kind": "semaphore",
      "description": "The suite runs against a forked database; two at once race on the same fixtures."
    }
  },
  "gates": {
    "types": {
      "cmd": "uv run mypy apps/",
      "timeout_s": 300
    },
    "unit": {
      "cmd": "uv run pytest",
      "requires": [
        "test-suite"
      ],
      "timeout_s": 1800
    }
  },
  "nodes": [
    {
      "id": "p1",
      "name": "BookmarkFolder model + migration",
      "depends_on": [],
      "prompt_ref": "ai-plans/2026-03-04-BOOKMARK_FOLDERS_IMPLEMENTATION_PLAN.md#phase-1",
      "touches": [
        "apps/bookmarks/models.py",
        "apps/bookmarks/migrations/",
        "tests/bookmarks/test_models.py"
      ],
      "gates": [
        "types",
        "unit"
      ],
      "model": "claude-haiku-4-5"
    },
    {
      "id": "p2",
      "name": "Folder CRUD endpoints",
      "depends_on": [
        {
          "node": "p1",
          "artifact": "the `BookmarkFolder` model and its migration"
        }
      ],
      "prompt_ref": "ai-plans/2026-03-04-BOOKMARK_FOLDERS_IMPLEMENTATION_PLAN.md#phase-2",
      "touches": [
        "apps/bookmarks/api/views.py",
        "apps/bookmarks/api/urls.py",
        "tests/bookmarks/test_api_crud.py"
      ],
      "gates": [
        "types",
        "unit"
      ]
    },
    {
      "id": "p3",
      "name": "Folder tree serializer",
      "depends_on": [
        {
          "node": "p1",
          "artifact": "the `BookmarkFolder.parent` self-FK the tree is walked over"
        }
      ],
      "prompt_ref": "ai-plans/2026-03-04-BOOKMARK_FOLDERS_IMPLEMENTATION_PLAN.md#phase-3",
      "touches": [
        "apps/bookmarks/api/serializers.py",
        "tests/bookmarks/test_serializers.py"
      ],
      "gates": [
        "types",
        "unit"
      ]
    },
    {
      "id": "p4",
      "name": "Nested folder listing endpoint",
      "depends_on": [
        {
          "node": "p2",
          "artifact": "the `/api/folders` viewset this list action is added to"
        },
        {
          "node": "p3",
          "artifact": "the `FolderTreeSerializer` payload shape"
        }
      ],
      "prompt_ref": "ai-plans/2026-03-04-BOOKMARK_FOLDERS_IMPLEMENTATION_PLAN.md#phase-4",
      "touches": [
        "apps/bookmarks/api/views.py",
        "apps/bookmarks/use_cases/list_folder_tree.py",
        "tests/bookmarks/test_api_tree.py"
      ],
      "gates": [
        "types",
        "unit"
      ]
    },
    {
      "id": "p5",
      "name": "Remove the bookmark-folders feature flag",
      "depends_on": [
        {
          "node": "p2",
          "artifact": "the flag branches the CRUD endpoints added"
        },
        {
          "node": "p3",
          "artifact": "the flag branch in the tree serializer"
        },
        {
          "node": "p4",
          "artifact": "the flag branch in the nested listing action"
        }
      ],
      "prompt_ref": "ai-plans/2026-03-04-BOOKMARK_FOLDERS_IMPLEMENTATION_PLAN.md#phase-5",
      "touches": [
        "apps/core/feature_flags.py",
        "apps/bookmarks/api/views.py",
        "apps/bookmarks/api/serializers.py",
        "tests/bookmarks/test_api_crud.py",
        "tests/bookmarks/test_api_tree.py"
      ],
      "gates": [
        "types",
        "unit"
      ],
      "model": "claude-haiku-4-5"
    }
  ]
}
```

Read the two renderings against each other: `p2` and `p3` both name only `p1`, so they sit in wave 2 and run at once; `p4` names both, so it is wave 3; `p5` names every gated phase, so it is wave 4 and alone there. `p1` and `p5` are the Tier 1 phases (a migration, a deletion) and carry a `model` override; the other three sit on `defaults.model`. `p2` and `p4` both touch `apps/bookmarks/api/views.py` — allowed, because the edge between them puts them in different waves; had they been same-wave, that overlap is what "Same-wave phases must not fight over the same files" is about.

`plan_context_refs` points at the same plan file the `prompt_ref`s do, at its **Goals** and **Guiding Decisions** headings. Each of the five phases is handed those two sections whole, so the implementer of `p3` knows that the tree serializer is deliberately not paginated if the plan's Non-goals said so, and the reviewer of `p3` can call a paginated one scope creep instead of a bonus.

The `project` block is what lets those three lanes exist at once. `bookmarks_test` is forked per lane from a template that `uv run python manage.py migrate` builds once, so `p2` and `p3` run `uv run pytest` against separate rows instead of the same ones; `test-suite` stays at capacity 1 because three suites at once melt the machine, not because they would corrupt each other. `dev` and `test` name two different databases, which is what keeps their forks from being the same database under two roles.

## What to avoid

- **No `§N` shorthand for section references — anywhere in the plan body.** Use section names: `Goals + Non-goals`, `Guiding Decisions`, `Data Model Changes`, `API Design`, `Phased Rollout`, `Risk & Rollout Notes`, `Open Questions`, `Touch List`. Readers shouldn't have to count headings to follow a cross-reference, and section numbering shifts when the spec/plan evolves. Same rule applies to citing SPEC sections (`Use-cases`, `Acceptance scenarios`, etc.) — name them.
- **No time estimates.** Use LoC sizing.
- **No vibes-based guarantees** ("should be straightforward", "trivial", "easy lift").
- **No skipped non-goals section.**
- **No phase that breaks build if merged alone.** Each independently mergeable AND independently reversible.
- **No `**Depends on**:` edge you can't justify with an artifact.** "It's later in the list" is not a dependency; it's a chain that costs the team a week of wall-clock for nothing.
- **No two same-wave phases rewriting the same file.** Either add the edge or split differently.
- **No repeating a defect a post-mortem already recorded.** A `wave_conflicts` entry on those paths, or a `missing_dependencies` entry between those layers, means the last run already paid for the lesson; drawing the same graph again wastes it.
- **No plan without its `.workflow.json` sibling, and no sibling that disagrees with the plan.** Different nodes, different edges, different waves, a `prompt_ref` pointing at a phase that was renumbered — all of them mean the two files were edited separately instead of derived from the same `**Depends on**:` lines.
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
- [ ] Phases MR-sized (≤1500 LoC) + independently mergeable.
- [ ] Phase numbering uses numbers + letters consistently.
- [ ] **Phase granularity matches the Step 0 answer.** Default (one-use-case-per-phase): at least one phase per spec use-case, no phase implements two use-cases. If bundling was chosen: grouped phases stay MR-sized, one concern, independently mergeable. Cross-cutting scaffolding is its own foundation phase either way.
- [ ] Each phase has Goal / **Depends on** / Spec use-case / Feature flag (or explicit waiver) / Changes / Tests / Suggested AI model / Reusable skills / Acceptance.
- [ ] Every `**Depends on**:` entry names the artifact it needs (model, symbol, migration, endpoint) — no bare phase ids, no "comes first" edges.
- [ ] **Execution graph** table is the first thing under **Phased Rollout**, and its waves match what the `**Depends on**:` lines imply.
- [ ] Graph is acyclic; the flag-removal phase depends on every gated phase.
- [ ] Same-wave phases checked against the **Touch List** for file overlap; real overlaps either serialized with an edge or called out explicitly under the graph table.
- [ ] Post-mortems from previous runs (`.vinta-flow/runs/*/postmortem.json`, plus any committed beside a plan) read **before** the graph was drawn; every finding either changed an edge, a wave or a split, or was consciously dismissed as not applying to this feature.
- [ ] Slow-moving / cross-repo work sits in wave 1, and no in-repo phase depends on a cross-repo phase when it only needs the contract.
- [ ] `**Review models**:` appears **only** on phases that justify a non-default reviewer / fixer (not on every phase); each such line names a tier + why. Phases without it inherit the project's `agent_models` defaults.
<!-- e2e:start -->
- [ ] **If e2e coverage was opted into at Step 0:** every phase introducing a new UI flow has an **E2E happy-path test** in its Tests block, with screenshot output to `pr-screenshots/`. If it was not opted into (default), **no phase carries an e2e spec** and there is no `QA_USE_CASES.md` / `pr-screenshots/` reference.
<!-- e2e:end -->
- [ ] Feature flag declared in **Guiding Decisions** (key, scope, default, flip-on criterion) **unless** **Guiding Decisions** explicitly justifies "no flag — purely additive surface".
- [ ] ≥1 test per gated phase asserts flag-off behavior unchanged.
- [ ] If flag declared, **final entry under Phased Rollout is dedicated flag-removal phase** with prerequisite (soak window), full deletion touch list, `grep` acceptance check.
- [ ] No time estimates anywhere.
- [ ] Cross-repo phases labeled `Phase Nb`, deploy ordering called out.
- [ ] Risk & Rollout Notes covers locks, partitions, backfills, rollback.
- [ ] Open Questions lists what couldn't resolve, with recommended default.
- [ ] Touch List groups files by phase.
- [ ] All file references use `@path/to/file.py` or `[name](relative-path#Lline)`.
- [ ] **`ai-plans/<feature-kebab>.workflow.json` written** — every plan, no exceptions — with `$schema` set to the canonical URL and `schema_version: 1`.
- [ ] Workflow graph matches the **Execution graph** table: one node per phase, one `depends_on` entry per `**Depends on**:` clause carrying both the node id and the artifact, same waves.
- [ ] Every node has `prompt_ref` (`<plan_ref>#phase-<number>`), `touches` from its **Touch List** block, and the `gates` it must pass.
- [ ] **`plan_context_refs` names the Goals and Guiding Decisions anchors** (`<plan_ref>#1-goals`, `<plan_ref>#2-guiding-decisions`), matching the headings as written — references, never a summary of them. Every phase's implementer and reviewer read them; a phase that doesn't know the non-goals is a phase that scope-creeps.
- [ ] `resources` declares a `lane` pool; every gate that contends for something shared names its pool in `requires`.
- [ ] **`project` decided, not defaulted** — asked via `AskUserQuestion`, then either written (roles `dev` / `test`, each naming its own database, engine fields filled from the project, `migrate_cmd` read out of its task runner) or deliberately omitted because lanes share the main checkout's database. No `reset_cmd`, no compose project name, no seed command, no env-file strategy — those are the worktree's, not the plan's.
- [ ] No credential anywhere in the workflow file: `connection_url_var` is a variable name, and `server_url` is a host and port.
- [ ] Model ids come from [resources/ai-models.yaml](resources/ai-models.yaml), and only phases off the default tier carry a `model` override.
- [ ] `pipelines` is omitted — `defaults.pipeline: standard-phase` is enough, and the executor supplies it.