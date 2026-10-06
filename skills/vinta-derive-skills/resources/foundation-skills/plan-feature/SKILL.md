---
name: plan-feature
description: Author a phased implementation plan for a new feature following the repo's `ai-plans/` conventions — including the dependency graph that lets independent phases be implemented in parallel. Use when the user asks to "plan", "design", "scope", or "break down" a feature, write an implementation plan / IMPLEMENTATION_PLAN.md, or turn a spec/idea into a phased roadmap. Always interrogates the requester before drafting. Validates the emitted workflow with `vinta-ai-maestro validate` when maestro is installed, then hands the plan to the human for review — on maestro's review page (graph, per-phase prompts and gates, comments, and a chat the agent answers through `vinta-ai-maestro review wait|reply`) or in chat.
---

# Plan Feature

Plans live in `ai-plans/` as `YYYY-MM-DD-FEATURE_NAME_IMPLEMENTATION_PLAN.md` (uppercase + underscores). `..._SPEC.md` sibling exists → **read first**. Plan translates spec into phased delivery, doesn't re-derive requirements. No spec? Point at [create-spec](../create-spec/SKILL.md) first; plan without spec = plausible-sounding but unverified. Spec/plan pair share `YYYY-MM-DD-FEATURE_NAME` prefix.

Every plan ships **two** files: the markdown above, and its executable sibling `ai-plans/{TODAY}-<feature-kebab>.workflow.json` — same date prefix, the same phase graph in the form an orchestrator runs. See "Emit the executable workflow". Written every time; never gated on a question.

Once both are written, the workflow is validated ("Validate the workflow with vinta-ai-maestro", when it is installed) and the plan goes to the human for review ("Review the plan with the human"). A review on maestro's page adds a third file, `ai-plans/{TODAY}-<feature-kebab>.review.json`, which holds the comments and the conversation.

## Step 0 — Interrogate before drafting (NON-NEGOTIABLE)

**Never assume requester want.** *"Plan bookmarks feature"* hide ≥dozen decisions cheaper to surface now than unwind in Phase 4.

Ask below in **batched, numbered groups**. Skip only when SPEC.md or prior conversation **explicitly** answers — never because guess. Can guess but not 100% sure → ask + state default ("default: per-user; confirm or override").

Drop irrelevant groups; don't drop questions inside relevant group:

### Use `AskUserQuestion` for finite-choice questions

Every question in groups B–J with discrete answer set — yes/no, named option, finite enum — **must** go through `AskUserQuestion` tool, not free-form prose. `AskUserQuestion` = Claude Code's name; on other harnesses use the equivalent structured question tool (OpenCode `question`, Codex `request_user_input`, Cursor `AskQuestion`, Copilot `askQuestions`, Gemini `ask_user` — see **Asking the human** in [AGENTS.md](../../../AGENTS.md)). Why:

- User picks; no retyping context.
- Multiple related questions ride one `AskUserQuestion` call (tool accepts list of questions, each own option set). Batch per group: one call for the **Data model & storage** group, one for the **API surface** group, etc.
- Short option label per choice; rationale ("default: per-user — confirm or override") goes in question text, not option labels. Default option first, label ends ` (Recommended)`.
- Max 4 questions per call (3 on Codex) — split bigger groups into consecutive calls.
- No "Other" option — tool always adds free-text field.

**Open-ended questions ride the tool too when you can propose candidates.** Spec, codebase, or earlier answers usually suggest 2–4 plausible answers ("Primary actor?" → roles found in code; "Success metric?" → metrics the spec names). Offer those; free-text field covers the rest. Plain prose (no tool) **only** when no candidate exists at all: "walk me through user journey", "what deadline driver". Group A often prose; B–J closed-choice.

### Iterative asking when no `AskUserQuestion` (or question open-ended)

Two cases force iterative single-question mode:

1. **No structured question tool** (harness errored on call, not deferred). Try once — confirm actually missing, not schema-deferred. Then each closed-choice question becomes numbered option list ending "Reply with option number, or type your own answer".
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
   Opens with the **Crew** table and the **Execution graph** table (see "Staff
   the plan" and "Phase dependencies and parallel execution"), then the phases.
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

Second thing under **Phased Rollout**, right after the **Crew** table (see "Staff the plan") and before the phases:

```markdown
### Execution graph

Wave = how deep a phase sits in the dependency graph. Phases in the same wave have no
dependency on each other and are implemented concurrently.

| Wave | Phases | Agent | Depends on |
|---|---|---|---|
| 1 | Phase 0, Phase 1b | `tier1`, `tier2-2` | — |
| 2 | Phase 1, Phase 2 | `tier2-1`, `tier2-2` | Phase 0 |
| 3 | Phase 3 | `tier4` | Phase 1, Phase 2 |
| 4 | Phase 4 — remove the `bookmarks-v2` flag | `tier1` | Phase 3 (deferred — soak-gated) |

**File overlap:** phases in the same wave touch disjoint files, with one exception —
Phase 1 and Phase 2 both export from `@app/bookmarks/__init__.py`. Trivial merge.

**Idle:** `tier4` has nothing until wave 3 and `tier2-1` nothing until wave 2 — the
foundation phase is the whole of wave 1 and only one agent can write it.
```

The table is **derived from the `**Depends on**:` lines, not authored independently.** Compute it: a phase with no dependencies is wave 1; otherwise its wave is one past the deepest phase it depends on. The executor recomputes this and will flag a table that disagrees.

**The Agent column is the staffing schedule, and it is the point of writing the table down.** Reading across a row tells you who is working that wave; reading down a column tells you who is not. The **Idle** note under the table says the second part out loud, because a wave nobody notices is a wave that silently doubles the plan's wall clock. It is a statement of fact, not an apology — a genuinely sequential foundation phase leaves everyone idle and that is correct. What it must never be is a surprise.

The `depends_on` edges in the workflow JSON come off the **same** lines — table and JSON are two renderings of one graph, never two graphs kept in sync by hand. See "Emit the executable workflow".

### Same-wave phases must not fight over the same files

Before publishing the plan, cross-check the **Touch List**: for every pair of phases in the same wave, look at their file sets. Overlap means two agents editing one file on two branches at once, and a merge conflict at the wave boundary.

- **Trivial overlap** (a shared `__init__.py`, a settings registry, a route table) — fine. Note it under the graph table so the reviewer isn't surprised.
- **Real overlap** (the same use case, the same serializer, the same view) — **add the dependency edge** and let one phase build on the other. A serialized pair that merges cleanly beats a parallel pair that needs a human to untangle.

### Design *for* parallelism when it's cheap

Two habits pay for themselves:

- **Front-load shared scaffolding into a wave-1 foundation phase.** Types, the migration, the empty module, the fixture. Every use-case phase then depends only on that one phase, and they all run at once, instead of forming a chain.
- **Pin every interface two parallel phases share with a contract test in that foundation phase.** A signal payload one phase sends and another receives, a protocol or ABC one implements and another calls, a DI provider one registers and another injects, an event schema, a serializer shape. Write the test that states the contract (the keyword arguments a receiver requires, the methods an implementation must have) into the foundation phase, so each parallel phase's own gates run it on its own branch. Without it, two phases can each be green alone and disagree with each other: one observed run had a sender omit an `organization_id` its sibling's receiver required, and the merged wave failed 22 tests that no phase's gate could have seen. The executor also runs the plan's gates once on the merged tree before the plan PR (`defaults.wave_gates`), but that catches the disagreement at the end, when it costs a rework of both phases.
- **Split by seam, not by layer, when the seams are independent.** Four use-cases on the same entity are four independent phases if they only share the model. Four layers of one use-case (repository → service → serializer → view) are a chain no matter how you number them.

Don't contort the plan for concurrency, though. A genuinely sequential feature is a chain of waves of one, and that is a correct plan.

### Read the previous runs' post-mortems before drawing the graph

Every plan you write is a guess about coupling. Every plan the orchestrator *ran* turned that guess into evidence, and it wrote the evidence down: one `postmortem.json` per finished run under `.vinta-ai-maestro/runs/<run-id>/`, plus any copy the team committed beside its plan as `ai-plans/{DATE}-<feature-kebab>.postmortem.json`. **Read them before the `**Depends on**:` lines, not after.** Newest first, and all of them — one run is an anecdote, three runs saying the same thing about the same layer is a rule about this codebase.

```bash
ls -t .vinta-ai-maestro/runs/*/postmortem.json ai-plans/*.postmortem.json 2>/dev/null | head -5
```

Each file carries `findings` and `gaps`. Use them like this:

- **`missing_dependencies`** — a phase failed, a phase it did *not* declare landed, and only then did it pass. The previous plan was missing that edge. If this feature couples the same two layers, **declare the edge here**, naming the artifact. Entry is ordering evidence, not proof (the file's own `gate_result_unrecorded` gap says so) — confirm the coupling exists in the code before you draw it.
- **`wave_conflicts`** — two phases that actually fought, with the contested `paths`: at a wave merge (`where: "wave"`), or while a phase's `integ-` base was built out of its dependencies (`where: "base"`), which is the same signal a wave earlier. Cross-check those paths against this plan's **Touch List**: two phases of yours touching one of them in the same wave is the same defect repeating. Add the edge, or split so only one phase owns the file.
- **`duration_divergences`** — `direction: "longer"` means that phase set its wave's wall clock alone, so every peer you parallelised it with bought nothing; keep comparable-size work together and let the long pole start in wave 1. `"shorter"` means a small phase sat behind a long one and could have been folded in or moved earlier. Sizing, never time estimates in the plan body.
- **`unused_dependencies`** — edges the run proved nobody needed. Drop the equivalent edge here. **Empty is not evidence of a tight graph**: check `gaps` first, because a `dependency_use_unrecorded` entry means dependency use was never measured on that run, not that every edge earned its place.
- **`gate_costs`** — what each gate actually cost, per gate rather than per phase: `runs`, `cached_runs`, `ran_ms`, `slowest_ms`, `cache_saved_ms`, and the failed and timed-out counts. This is what sizes the **gate pool capacities** you declare. The gate that dominates `ran_ms` is the one whose pool decides the run's wall clock — give that one the capacity and stop widening the others. A gate whose `runs` far exceeds the number of phases that declare it is a fix loop re-paying for the same suite: that is a signal about `max_fix_rounds` or about phases too large to get right in two rounds, not about the gate.
- **`critical_path`** — the dependency chain that decided how long the run took, each phase with the time it was running, plus `span_ms` and `share_of_elapsed`. **Re-draw the graph against this one.** Shortening any phase *not* on this list changes nothing at all, so a plan that parallelises harder without touching this chain buys nothing. A high `share_of_elapsed` means the graph is deep rather than wide: look for an edge on that chain that is convention rather than a real artifact dependency, and cut it. This is the finding most likely to change a plan's shape.
- **`idle_capacity`** — what the run paid for and did not use: `lane_capacity` against `peak_concurrency`, and `idle_share` of the provisioned lane time. A lane is a worktree, a forked database and a crew member's desk, so a plan that never got as wide as its lane count bought all three for nothing. `peak_concurrency` well under `lane_capacity` means **this graph cannot use that many lanes** — either declare fewer next time, or find the edges that are serialising work that did not need to be serial. It is a fact about the graph, not about the machine.
- **`interventions`** — changes the run's coordinator made to the run while it ran, because it found the run paying for something the plan could have stopped it paying for. A `gate:<id>` entry with `effect: "cheaper"` is the useful one: that gate's command or timeout was wrong in the workflow this project keeps emitting, and the run had to discover it at its own expense. **Carry the change forward** — the gate block you emit for this feature should already have it, so the next run does not pay again. The reasoning and the actual command are not in this file (it carries counts, not prose); they are in the coordinator's conversation its `record_ref` names, which is where to look before copying anything. An `effect: "dearer"` entry is the opposite signal and is worth saying out loud to the human: the run tuned itself in the wrong direction, and whatever it changed should probably not be in the next plan. `unmeasured` means exactly that — the change may have been right or wrong and the run could not tell, so treat it as no evidence rather than as weak evidence.

- **`cross_phase_failures`** — a gate every phase passed on its own branch that failed on a merged wave: two of that wave's `members` disagree about something they share (a signal's arguments, a protocol, a provider). This is a missing dependency or a missing contract test that `missing_dependencies` cannot see, because nothing *landed* in between — it only showed up merged. If this feature has phases on the same interface, put a contract test for it in the foundation phase (see "Design *for* parallelism").
- **`failure_causes`** — failed attempts grouped by reason, with `attempts` and the phases each one hit. An entry with `setup: true` failed before any agent ran — provisioning, a base merge, a checkout — and repeating it is the project configuration's fault, not the plan's: name it to the human (a missing `env_files` entry, a compose service that will not start) rather than reshaping the graph around it. A `setup: false` cause that hit many phases is a gate or a contract the plan should have settled first.
- **`crew_substitutions`** — phases run by somebody other than the member the plan named. Entries with `above_plan: true` ran dearer than budgeted; many of them on one member means the roster was too thin at that tier for the plan's width. Size the **Crew** table so each wave's phases are covered at their own tier, rather than relying on cover from above.
- **`operations`** — what people (and the coordinator) did to the run: amendments, steering, pauses, aborts, who answered the questions, commands run by hand. A plan whose runs needed many of these is telling you where it was underspecified: a phase steered or redirected repeatedly needed a sharper brief; the same question answered the same way every time belonged in the plan.

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

**Assigned to**: `{crew-id}` (Tier {N}) — {why this phase needs that tier, in the rubric's terms}. See "Staff the plan".

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

**Assigned to**: `{the roster's Tier 1 member}` (Tier 1) — mechanical deletion + inlining; exact precedent by construction, since every line it removes was added by a phase above it.

**Reusable skills**: none — pure cleanup.

Acceptance: `grep -r "{flag-key}" app/ tests/` returns nothing, feature behaves identically to flag-on state, full test suite green.
```

Place as separate, numbered, last-in-list entry inside **Phased Rollout**. Also in **Touch List** under its own phase. **Required**.

### Put the slowest-moving dependency in wave 1

Common mistake: leave cross-repo producer wiring for last, then discover the upstream repo's deploy cadence is two weeks. Give the slow path **no dependencies** so it starts in wave 1 (e.g. *"accept field, validate, drop on floor"*) + let fast in-repo work fill in behind it. Typical shape: `Phase 1` (API stub) and `Phase 1b` (cross-repo producer) both depend on nothing and run in wave 1; `Phase 2`+ (in-repo persistence) depends on `Phase 1` only — so it does **not** wait on the cross-repo lane.

Watch for the accidental version of this: making an in-repo phase `**Depends on**: Phase 1b` when it only needs the *contract*, not the producer's deploy. That one edge parks the whole in-repo plan behind another team's release train.

### Flag-removal phase depends on everything

The mandatory final flag-removal phase depends on **every** gated phase — it deletes the branches they added. Say so in its `**Depends on**:` line. It sits alone in the deepest wave, so this edge costs nothing and documents the real constraint. **The executor does not know it is soak-gated unless the workflow says so**: give that node `deferred` (see the mapping table) carrying the soak condition, or the scheduler starts it the moment its dependencies merge.

### Never give time estimates

**Don't** write "~2 days" / "1 sprint" / "ETA: …". Time estimates for AI-implemented work pointless + become targets LLM optimizes against. **LoC sizing (`~150 LoC`) fine** — reviewability signal, not time.

## Staff the plan

A plan does not pick a model per phase. It **staffs a team**, then assigns each phase to somebody on it.

The difference is not cosmetic. Choosing a tier phase by phase answers "what should run this one" ten times and never adds it up, so the two questions that actually decide what a feature costs go unasked: **how many agents does this need at once, and is any of them below the tier of what it was handed.** A roster asks both before a line is written, and it is falsifiable — you can look at it and say "nobody needs three Tier 4 members here".

### The Crew table

First thing under **Phased Rollout**, before the **Execution graph**:

```markdown
### Crew

| Agent | Tier | Takes | Why this tier |
|---|---|---|---|
| `tier1` | 1 | Phase 0, Phase 4 | An empty module and a flag deletion — exact precedent, both of them. |
| `tier2-1` | 2 | Phase 1 | A DRF viewset mirroring `@app/tags/api/views.py` almost line for line. |
| `tier2-2` | 2 | Phase 1b, Phase 2 | Serializer with cross-field validation; the producer stub is the same shape. |
| `tier4` | 4 | Phase 3 | Cycle detection over a user-mutable tree — no precedent in this repo. |
```

**Name members after their tier, never after a seniority.** A member is `tier<N>`, or `tier<N>-<k>` when the roster carries more than one at that tier. Ids are lowercase kebab-case — the schema rejects anything else.

The rule exists because the tier *is* the whole of what the orchestrator knows about a member: it is the floor on what they may be handed and the only thing compared when one covers for another. A roster that names members after seniority grades names people instead, and invites two mistakes — reading a capability ranking as a career one, and letting the label drift from the `tier` beside it, which is the number that actually decides anything.

**Every member implements; nobody on the roster reviews.** Each phase is reviewed by the `thermo-nuclear-review-loop` skill, which spawns a fresh reviewer sub-agent with no implementation context for that phase alone (see "Who reviews"). That reviewer is not a member, so it gets no row, no tier and no desk.

**Every implementer has to earn their place, and there are exactly two ways to do it:**

- **Concurrency.** A wave of three phases needs three pairs of hands, and they must be hands *at or above* each of those phases' tiers — two Tier 2 members and a Tier 1 cannot run three Tier 2 phases two-wide, because the Tier 1 member is not allowed to take one. So go wave by wave: sort the wave's phase tiers, sort the roster's tiers, and check the roster covers them one for one.
- **Cheapness.** A member below the roster's other tiers earns their place by taking work the dearer members would otherwise do. A Tier 1 member who runs the migration and the flag deletion is worth having even in a graph that is never two phases wide, because those two phases run at Tier 1 instead of Tier 2.

**A member who does neither should not be on the roster** — a second Tier 2 member in a graph that is never two wide adds no concurrency and saves nothing, and the executor refuses a member assigned no phase at all.

Note what this does *not* say: the roster is not capped at the widest wave. Concurrency is capped there, but a cheaper member is bought with money, not with parallelism, and adding one to a narrow graph is a perfectly good trade — it now costs a worktree, which is the honest price (see "Every member gets a desk").

Two more rules:

- **Prefer fewer tiers over more.** Two members at Tier 2 beat one at Tier 2 and one at Tier 3 when both phases are Tier 2 work: a tier is a floor on what a member may be handed, so a roster that draws fine distinctions only makes it harder to cover for a busy peer.
- **The `Takes` column is the assignment**, and it must agree with every phase's `**Assigned to**:` line. They are two renderings of one decision, so write the phases and let the table fall out — never the reverse.

### Assigning a phase

Two constraints, and they pull against each other. That is what makes this a judgement rather than a lookup.

**The rubric tier is a floor.** Never hand a Tier 3 phase to a Tier 1 member to save money. A cheap model on work above its tier does not fail cleanly — it produces plausible code that fails review two rounds later, and by then nothing points back at the staffing decision. Default to the cheapest tier that plausibly works; that is not the same as the cheapest tier available.

**Nobody should be idle while work they could do is queued.** If the Tier 4 member is busy from wave 1 to wave 4 and the two Tier 1 members are idle after wave 1, the plan is a Tier 4-shaped chain with decoration. Rebalance by splitting a phase or moving a dependency, not by handing Tier 4 work down to Tier 1.

When those two genuinely cannot both hold, **the floor wins and the plan says so** in the **Idle** note. A wave that serializes is a schedule; a phase run below its tier is a defect.

### The tier rubric

**Concrete model IDs per tier live in [resources/ai-models.yaml](resources/ai-models.yaml) — read that file when staffing the roster. Never recall model names from memory; they go stale as vendors ship.** The tiers below define *when* each applies (stable judgement); the IDs drift, and a nightly job keeps the resource current. Note the file's `last_verified` date — if it's far in the past, the IDs may be stale; flag that rather than trusting them blindly.

#### Tier 1 — cheapest/fastest (boilerplate, exact-precedent edits)
**Use for**: single migration adding column or index, exporting from `__init__.py`, registering admin, scaffolding empty Django app, thin serializer mirroring existing pattern verbatim.

#### Tier 2 — standard pattern application
**Use for**: repository methods, DRF serializer with non-trivial validation, ViewSet wiring with filterset, pytest unit/integration tests against established fixtures, simple HStore/ArrayField additions.

#### Tier 3 — multi-file orchestration, business logic, SQL views
**Use for**: use case coordinating across repositories with non-trivial branching, new `vw_*` view + non-managed model + migration, serializer with cross-field validation affecting use-case behavior, integration tests covering concurrency edges.

#### Tier 4 — architectural / novel / hard
**Use for**: cycle detection in user-mutable trees, transactional batch protocols with deferred constraints, partitioned-to-partitioned FK design, perf tuning slow query against partitioned hot table, debugging heisenbug.

### Who reviews

Nobody on the plan. Both executors review every phase with the same `thermo-nuclear-review-loop` skill, and each picks the loop's reviewer itself:

- **On the skills path**, `review-phase` spawns the reviewer **one tier above the tier the phase's implementer actually ran at** — a Tier 4 phase is reviewed at Tier 4, since nothing sits above it — and the phase's own implementer fixes what it finds.
- **Under `vinta-ai-maestro`**, the `review` chore runs the loop on the implementer's own session (see "The review chore"), and its reviewer runs at the harness's most capable tier.

So the review needs no staffing decision, and the plan carries no reviewer rows and no per-phase review-model line. On the skills path the phase's tier sizes its review too, which is one more reason never to hand a phase down a tier.

### Every implementer gets a desk

**An implementer keeps one worktree, and one session, for the whole run.** This is why the roster is worth writing down rather than being a way to pick models: the agent that takes Phase 4 is the agent that took Phase 1, and it still knows where things live, how the suite is run and what this codebase's conventions are. That rediscovery is most of what a cold agent's first turn of a phase is spent on.

It works because the *directory* stops moving. An agent whose worktree changed between phases would be reasoning about paths it is not standing in — that, not the reset, was what made cross-phase reuse unsafe. With the directory pinned, the only open question is which files changed while the member was away, and git answers that exactly: the executor hands the continued agent the list, plus whether the previous phase's own work is in this tree at all.

**The reviewer has no desk, and that is the point.** On both executors it is a sub-agent that reads the lane it reviews — the implementer's worktree — so the tree it reads is the tree the implementer fixes. A reviewer with a checkout of its own would be reading a snapshot: strictly less than what is there, and always one fix round behind.

What this costs, and what to weigh when sizing the roster:

- **A worktree and a set of forked databases per implementer.** Adding a cheaper implementer to save a tier on two phases is a real trade now — disk against money — rather than free.
- **Lane capacity is the number of implementers.** Not the widest wave: an implementer idle in wave 1 still has a desk waiting. The reviewer adds nothing to it.
- **A member whose phase failed starts their next one cold.** Their context is the context that failed, and a wrong conclusion costs more to inherit than a repository costs to re-read. Nothing to declare; the executor does it.

**The mechanical-step models are still not plan-owned.** Worktree prep and opening the PR stay under `agent_models` in `.vinta-ai-workflows.yaml`. Don't put them on the roster; they'd be ignored.

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

Alongside the markdown plan, write `ai-plans/{TODAY}-<feature-kebab>.workflow.json` — same directory, same date prefix as the plan and the spec, feature name lowercased with hyphens (`2026-03-04` + `BOOKMARK_FOLDERS` → `ai-plans/2026-03-04-bookmark-folders.workflow.json`). The markdown is what humans review; the JSON is the same phase graph in the form an orchestrator runs — one worktree lane per phase, branches cut from each phase's dependencies, gates queued behind capacity limits instead of stampeding.

**The date prefix is what keeps the three files together.** `ai-plans/` accumulates every feature this repo has ever planned, and a dateless `bookmark-folders.workflow.json` sorts into a different part of the directory from the `2026-03-04-BOOKMARK_FOLDERS_PLAN.md` it belongs to — so the one file you need when the plan is in front of you is the one you have to search for. With the prefix a feature's three files land adjacent:

```
ai-plans/2026-03-04-BOOKMARK_FOLDERS_PLAN.md
ai-plans/2026-03-04-BOOKMARK_FOLDERS_SPEC.md
ai-plans/2026-03-04-bookmark-folders.workflow.json
```

The case difference is not an inconsistency to fix: the markdown convention is `UPPERCASE_WITH_UNDERSCORES`, and the workflow's stem **is** its `id`, which the schema requires to be lowercase kebab-case. They cannot be spelled the same way, so they share the one part that can be shared.

**Unconditional.** Write it on every plan. Don't ask, don't gate it on a config field, don't skip it because the project has no orchestrator installed — a project without one carries a few KB it never reads, and a project that installs one later finds its plans already executable. The one thing that is *not* free is emitting it inconsistently: a half-populated `ai-plans/` teaches the team the file is optional.

**It is not a second source of truth.** Every value in it is read off the plan you just wrote. Write the plan first, then transcribe. If a field has no answer in the plan, the plan is missing something — go fix the plan, not the JSON.

First key in the file is `"$schema"`, pointing at `https://github.com/vintasoftware/vinta-ai-workflows/schemas/workflow.v1.schema.json`. Editors validate against it as you type, which is when a typo is cheap; without it the first thing that reads the file is the executor, an hour into a run.

### Mapping the plan onto the document

| Field | Comes from |
|---|---|
| `$schema` | The URL above, literally. |
| `schema_version` | `1`. |
| `id` | `{TODAY}-<feature-kebab>` — the filename's stem, exactly. Digits and hyphens only, no underscores and no uppercase: it is both the filename the daemon resolves and the slug in every branch name (`plan/2026-03-04-bookmark-folders/wave-2`), and the daemon refuses a workflow whose `id` and filename disagree. |
| `plan_ref` | Repo-relative path of the markdown plan, e.g. `ai-plans/2026-03-04-BOOKMARK_FOLDERS_IMPLEMENTATION_PLAN.md`. |
| `plan_context_refs` | The two plan sections that bound **every** phase, as anchors into the plan you just wrote: `<plan_ref>#1-goals` (which carries Non-goals with it) and `<plan_ref>#2-guiding-decisions`, in that order. Same file-and-anchor form as `prompt_ref`. See "Plan-level context". |
| `base_branch` | What `**Depends on**: nothing — starts from the base branch` means concretely: the repo's default branch, unless **Guiding Decisions** names a long-lived feature branch. |
| `project` | The databases a lane must **fork** to be a working checkout, the command that migrates the template they are forked from, and `env_files` — the gitignored files every lane needs its own copy of (`.env`, the local settings module). Omit the databases when lanes can share the main checkout's; never omit `env_files` the project needs — see "The `project` block". This is the one part of the document you *ask* about and *read off the project* rather than transcribe from the plan. Prefer declaring it once in `.vinta-ai-workflows.yaml` under `maestro.project` (see "What the project already says"). |
| `defaults.harness` | The agent CLI the team runs — `claude-code`, `codex`, or `opencode`. **Omit** when it is `claude-code` or `maestro.defaults.harness` already says it — see "What the project already says". |
| `crew` | The **Crew** table, transcribed: one entry per row keyed by the Agent id, carrying that row's `tier` and the model id that tier resolves to in [resources/ai-models.yaml](resources/ai-models.yaml), and no `role` field. Required whenever the plan has a roster, which is every plan. |
| `defaults.model` | The concrete model id for the tier **most** phases carry, pulled from [resources/ai-models.yaml](resources/ai-models.yaml). A staffed workflow never reads it for a phase — every node's model comes off its member — but it is still required, and it is what an amendment adding an unstaffed node would fall back to. |
| `defaults.model_fallbacks` | One `"<id>": "<fallback>"` entry for every model in `crew` whose [resources/ai-models.yaml](resources/ai-models.yaml) entry carries a `fallback:`. **Omit** when none does, or when `maestro.defaults.model_fallbacks` already says the same. It is what a spawn runs on once that model is out of quota or credits, instead of parking the harness until a reset that a credit allowance may never have. |
| `defaults.pipeline` | **Omit** — it defaults to `standard-phase`. See "The pipeline block". |
| `defaults.max_session_turns` | Omit (defaults to 12). It caps how many turns one reused agent session may take before the executor starts a fresh one; the executor reuses sessions across a phase's implement and fix turns, so this is a context-window guard rather than something a plan tunes. |
| `resources.lane` | `{"capacity": N, "kind": "worktree"}`. **Required** — a lane pool is where phases are dispatched, and a workflow without one has nowhere to run. `N` = the number of **implementers** on the roster, because each keeps one worktree for the whole run. The `review` chore adds nothing: its reviewer is a sub-agent working in the implementer's lane. How many run *at once* is still capped by the graph and by the project's parallel-lane budget (3 when unstated); an implementer idle in wave 1 still has a desk. |
| `resources.<pool>` | One `{"kind": "semaphore"}` pool per expensive shared thing a gate contends for — the test database, the e2e browser grid, a staging deploy slot. `capacity: 1` when only one can run at a time. |
| `gates.<id>` | The checks a phase must pass, as **shell commands run in the phase's lane** — the project's real typecheck / test / lint invocations, not an agent and not prose. **Declare only what the project does not already supply** (see "What the project already says"): a gate the project configures by type is available under the type's name without an entry here, and an entry with `"type"` overrides just the fields it sets. **An entry that overrides a project gate must carry `"type"`** — `{ "type": "test", "requires": ["test-suite"] }`. Without `type`, `{ "requires": [...] }` is a new gate with no `cmd`, and the schema rejects it. Give a slow plan-specific gate `requires` naming the pool it contends for, and a `timeout_s` that is generous rather than tight. |
| `chores.<id>` | Agent turns a phase runs once its gates are green. **Always emit the `review` and `deslop` chores below unless `maestro.chores.review` / `maestro.chores.deslop` already declare them** — `review` is the phase's code review (see "The review chore") and `deslop` the comment-hygiene pass, and without them a maestro run has neither. Add another only when the plan genuinely needs one (a changelog entry, a translation extraction); a chore is a model turn per phase, so each one has to earn it. |
| `chores.review-canvas` | **Emit only when `.vinta-ai-workflows.yaml` has `integrations.pr-review-canvas: enabled`.** An `after_pr` chore: maestro runs it once each phase's PR is open, and it posts a review canvas on that PR. Emit it exactly as shown under "The review-canvas chore" below. Never emit it when the integration is `disabled` or absent. The skill it names is installed only when the integration is enabled. |
| `defaults.chores` | `["review", "deslop"]`, plus `"review-canvas"` when that chore is emitted — or **omit the key** when `maestro.defaults.chores` already names the same list. The chores every phase runs unless it names its own. **Never write `"chores": []` to mean "the project's"**: an empty list *replaces* the project's list with nothing, and the run then runs no chore at all. |
| `defaults.substitution` | **Omit** — it defaults to `up_one_tier`: a busy member's phase may go to the next tier up the roster has, and a warm session never moves a phase up. Set `same_tier` when the top tier is a limited credit allowance that must not absorb other tiers' work. |
| `defaults.wave_gates` | **Omit** — it defaults to `final`: every gate of the plan runs once on the merged tree before the plan PR opens, plus a wave's gates on any wave whose merge needed a conflict resolution. Set `every` for a plan with many parallel phases on shared interfaces, where finding a cross-phase break at the wave that introduced it is worth one full suite per wave. Never `off` unless the project's suite cannot run in the integration worktree. |
| `defaults.gates` | The gate ids every phase runs. **Omit the key** when `maestro.defaults.gates` is already the list this plan wants; set it when most phases share a list the project does not name. A node with no `gates` key takes it. **Never `[]`**: that is a run with no gates. |
| `nodes[].chores` | **Omit the key** on almost every phase — absent means the run-wide default. Name a list only to give one phase a different set, and `[]` only to deliberately opt one phase out. A list *replaces* the default rather than adding to it; `[]` is "no chores", never "the default". |
| `nodes[]` | One per phase, in plan order. |
| `nodes[].id` | `p` + the phase number, lowercased: `Phase 1` → `p1`, `Phase 4a` → `p4a`, `Phase 1b` → `p1b`. |
| `nodes[].name` | The phase title without its `Phase N —` prefix. |
| `nodes[].prompt_ref` | `<plan_ref>#phase-<number>` — the anchor of that phase's heading. Anchor on the number, not the slugified full title: the number is the part that survives a title edit, and the phase brief the implementer reads is located by its `### Phase N` prefix. |
| `nodes[].depends_on[]` | **One entry per clause** of the phase's `**Depends on**:` line, each carrying both `node` (the upstream node id) and `artifact` (that clause's prose, minus the phase reference). |
| `nodes[].touches` | That phase's **Touch List** entries as plain repo-relative paths — strip the `@` prefix and any markdown link syntax, keep the trailing `/` on a directory. |
| `nodes[].gates` | The gate ids this phase must pass, in the order they should run. **Omit the key** when they are the run's `defaults.gates` (the plan's or the project's `maestro.defaults.gates`). **`[]` is an ungated phase** — its gate step passes without running anything — and is for a phase that genuinely has nothing to check, declared with `defaults.allow_ungated_phases: true`; `vinta-ai-maestro validate` refuses a phase that resolves to no gates otherwise. One observed run finished twelve phases without a single check because every node carried `"gates": []` where the author meant "the project's". |
| `nodes[].crew` | The id from this phase's `**Assigned to**:` line. **Required on every node of a staffed workflow** — a half-staffed document is refused, because the executor would be running two staffing rules at once. |
| `nodes[].model` / `nodes[].harness` | **Omit `model` entirely on a staffed workflow** — the member carries it, and a node setting both is refused. `harness` only when this one phase runs on a different CLI than `defaults`. |
| `nodes[].deferred` | The phase's soak or wait condition, as prose, on every phase the Execution graph marks **deferred** — the flag-removal phase above all. A deferred phase is not started when its dependencies merge: the executor parks it on a question naming this text, and a person answers `start` when the condition holds (or `stop`). Omit on every other phase. Without it the scheduler runs a soak-gated flag removal the moment the phases it depends on land. |
| `nodes[].max_fix_rounds` | Omit. Absent means no limit: the fixer works until the gates are green and the review loop until the reviewer approves. Set it to cap the fix rounds a phase may spend on red gates, and the review iterations each review turn may run, before the operator is asked. When a phase spends a set budget, the executor asks the operator whether to continue rather than failing the phase. Set one only on a phase you want a person to look at if it drags on — an expensive suite, a phase with a known risk of going in circles. |
| `nodes[].pipeline` | Omit. A per-phase pipeline is for a phase that genuinely runs a different lifecycle, which is rare enough that needing it is a signal to re-read the plan. |
| `pipelines` | **Omit.** The executor ships `standard-phase` — see "The pipeline block". |

Rules the mapping depends on:

- **`artifact` is required on every edge, and it is the clause's own prose.** It is what the implementer's prompt uses to explain what this phase builds on, so the value is what the clause says the phase needs — "the `BookmarkFolder` model and its migration" — never `p1`, never "depends on Phase 1". If the `**Depends on**:` line has no artifact to transcribe, the edge shouldn't exist; see "`**Depends on**:` — one line per phase, always present".
- **`touches` is what the same-wave overlap check reads.** Executors *warn* on two same-wave nodes declaring the same path rather than refusing, so an incomplete Touch List doesn't fail loudly — it fails at merge. Transcribe every file the phase creates or edits, including tests.
- **Never invent a model id.** Pick the tier from the rubric under "Staff the plan", then read the id out of [resources/ai-models.yaml](resources/ai-models.yaml). Ids drift; tiers don't.
- **The roster is the same decision as the Crew table.** `crew` transcribes it: one entry per row, `tier` from the Tier column, `model` from that tier in `ai-models.yaml`. A member the table does not list, or a row with no `crew` entry, means the two were edited separately.
- **A gate is a command; a chore is an agent.** Both run per phase and that is where the resemblance stops. A gate is a shell line that says pass or fail and decides whether the phase merges. A chore is a turn that *changes* the diff — the review loop's fixes, the comment pass, a changelog entry — and it runs only once the phase's gates are green. Only the `review` chore stands between a phase and its merge; any other chore that fails is recorded and the phase carries on to its final gate run. Anything you can express as a command belongs in `gates`, where it is cached and queued and costs no model time.
- **Gate commands must be commands the repo actually runs today.** Read them out of the project's task runner (`package.json` scripts, `Makefile`, `pyproject.toml`, CI config) rather than guessing a conventional one. A gate that doesn't exist fails every phase identically, and looks like a code problem. A command that goes through `docker compose run` or `exec` needs `-T`: a gate runs with no terminal, and without it compose fails with "the input device is not a TTY" before the command starts (`doctor` warns about it).
- **The graph must agree with the Execution graph table.** Same nodes, same edges, same waves — they are two renderings of one set of `**Depends on**:` lines, so derive both from the lines rather than transcribing one from the other. A disagreement means one was hand-edited, and the executor flags it.
- **`plan_context_refs` is anchors, never prose.** It names sections of the plan; it never restates them. A summary written into the JSON is a second copy that drifts the first time someone edits the plan, and the whole point of the field is that the implementer reads what the plan actually says.

### What the project already says

Read `.vinta-ai-workflows.yaml` before writing the document. Its `commands` and its `maestro:` section are laid **under** this file when maestro loads it: every value the project already supplies reaches this plan without being written here, and a value written here overrides it for this plan alone. So the document says what is particular to this plan and nothing else. A copy of a project value is not harmless — it freezes the value into the plan, and a later change to the project's file never reaches it.

- **Gates by type.** A gate typed `test`, `lint`, `typecheck` or `e2e` takes its command from the project — `maestro.gates.<type>`, else `commands.test_unit` / `lint` / `build` / `e2e`. Each type the project has a command for is available under the type's own name, so a node can list `"gates": ["typecheck", "test"]` with no `gates` table at all. Write an entry only to change something for this plan: `{ "type": "test", "timeout_s": 3600 }` keeps the project's command and extends its timeout; `{ "cmd": "…" }` (no type) replaces it outright.
- **`scoped_cmd`** is the same check narrowed to what a phase changed, with `{changed_files}` / `{touches}` in it. The project normally supplies it (`commands.test_unit_scoped`, `maestro.gates.<type>.scoped_cmd`). Phase gates run it, and the full command runs once on each merged wave. Set one here only for a plan whose phases need a different narrowing.
- **Pools, chores and the `project` block** merge per id: an entry here replaces the project's entry of the same id whole. Declare `resources.lane` (it is this plan's — one desk per implementer), and a pool, chore or database only when the project has none or this plan needs a different one.
- **`defaults`** merge field by field: omit what `maestro.defaults` already says.
- **Omitting a key inherits; writing `[]` replaces with nothing.** `nodes[].gates`, `defaults.gates`, `defaults.chores` and `nodes[].chores` are lists, and lists replace rather than merge. The only way to take the project's list is to leave the key out. `"gates": []` on a node is a phase with no gates, `"chores": []` in `defaults` is a run with no review and no comment pass — both silent at run time, and both exactly what the observed run did. When in doubt, omit the key and read what `validate --json` resolved.
- **`project.env_files` and `project.hooks`** are project facts, not plan facts: declare them once under `maestro.project` in `.vinta-ai-workflows.yaml` and every plan inherits them. Write them in the workflow only when the project file does not have them yet — and then tell the human they belong in the project file.

When the project has no `maestro:` section and no `commands`, everything stays in this file, as before.

Maestro runs the plan from its own branch, `plan/<workflow-id>/base`, cut from `base_branch`. A commit to that branch that edits this file or `.vinta-ai-workflows.yaml` is applied to the run while it is going — that is how a team retunes a gate mid-plan — and ships to `base_branch` with the plan's PR.

### Plan-level context

`prompt_ref` gives a phase its own body. It gives it nothing else — and a phase body alone is how an implementer ends up building something the plan explicitly ruled out, or re-deciding a question **Guiding Decisions** already closed. `plan_context_refs` is where the plan hands every phase the two sections that bound all of them:

```json
"plan_context_refs": [
  "ai-plans/2026-03-04-BOOKMARK_FOLDERS_IMPLEMENTATION_PLAN.md#1-goals",
  "ai-plans/2026-03-04-BOOKMARK_FOLDERS_IMPLEMENTATION_PLAN.md#2-guiding-decisions"
]
```

The executor resolves each reference the same way it resolves a `prompt_ref` — file, then the named heading's section down to the next heading of the same depth — and hands the text to the implementer **verbatim**, under a heading that says it is the plan's and not the phase's. The `review` chore runs on that same session, so the review loop has it too.

Rules:

- **Anchor on the heading as you wrote it.** The **Plan structure** section numbers those headings — `## 1. Goals`, `## 2. Guiding Decisions` — so their anchors are `#1-goals` and `#2-guiding-decisions`. Write the anchor of the heading that is actually in your plan: an anchor that resolves to nothing fails the phase loudly at spawn time, before any code is written.
- **Goals carries Non-goals.** Non-goals is a bulleted list *inside* the **Goals** section, so one anchor delivers both. That is why `#1-goals` is not optional here — the non-goals are the half that stops scope creep.
- **Two entries, both of them.** Not **Data Model Changes** (large, and the phase body names the models it touches), not **Risk & Rollout Notes**, not the whole plan file. Every extra section is paid for in every phase's implementer prompt.
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
| `postgres` | `delivery`, `name`, `server_url`, `connection_url_var` | `delivery: "external"` forks a new database on a server that is already running — the cheap mode, and the one to prefer, because N lanes cost N cheap clones against one server. `delivery: "compose"` boots the lane its own server on its own forked volume: there is no template to clone from, so such a lane is single-use and gets re-provisioned rather than reset. `name` is the **main checkout's** database name; lane names are derived from it. `server_url` is the server *without* the database path segment — `postgres://localhost:5432`. For `external`, write the host, port and user the `createdb` / `dropdb` tools must reach — a Docker-published server is `postgres://app@localhost:5433`, not the compose service name — and no password (the tools read `PGPASSWORD` or `~/.pgpass`). For `compose`, `server_url` names the server as the compose network sees it (`postgres://db:5432`); the executor tells agents that URL resolves only inside the stack and to run the suite through the project's commands, so make sure `commands.test_unit` is the in-stack line (`docker compose run --rm api python -m pytest`). |
| `sqlite` | `path`, `connection_url_var` | `path` is the repo-relative path of the database file, e.g. `db.sqlite3`. The lane gets its own copy of it. |

**Each role names its own database.** A lane's copy is named from `name` (or `path`) and the lane — the role is not part of it — so declaring `dev` and `test` with the same `name` makes both roles resolve to one forked database and one template. Give them the names the project already uses for them: `bookmarks` and `bookmarks_test`, `db.sqlite3` and `db.test.sqlite3`.

`connection_url_var` is the **name** of the env var the project already reads its connection string from — `DATABASE_URL`, `TEST_DATABASE_URL`, whatever the settings module names. The executor sets it per lane. Never write a connection string with credentials in it here: this file is committed beside the plan, and `server_url` is a host and port, not a login.

**`env_files` — the files git does not carry.** A lane is a git worktree, and a worktree has only what git tracks. Every gitignored file the project needs in order to run — `.env`, `.env.docker`, `settings/local.py`, an `.envrc` — is absent from every lane unless `project.env_files` names it, and then each lane gets its own *copy*. Every hook, every `manage.py` call and every compose stack in the lane reads those files, so a run without them fails in ways that look like code problems: a pre-commit hook that cannot import the settings module, a gate that cannot find `DATABASE_URL`. **Find them by reading the project, never by guessing:**

- `.gitignore` entries that have a tracked `*.example` / `*.sample` / `*.template` / `*.dist` sibling (`.env.example` → `.env`, `local.py.example` → `local.py`);
- `env_file:` lines in `compose.yaml` / `docker-compose.yml`;
- the module `DJANGO_SETTINGS_MODULE` (or the framework's equivalent) imports, when that module is gitignored — a local settings file is the one authors forget;
- anything the pre-commit config or the task runner sources that git does not track.

List them as repo-relative paths: `"env_files": [".env", ".env.docker", "app/settings/local.py"]`. **Prefer declaring them once in `.vinta-ai-workflows.yaml`** under `maestro.project.env_files`, where every plan inherits them; write them in the workflow only when the project file lacks them, and say so to the human. `vinta-ai-maestro doctor` warns when gitignored files have tracked examples and nothing declares them, and fails when a declared file is missing from the checkout.

**`hooks`** — `run` (the default) runs the repository's git hooks on commits inside a lane *and* on the merge commits maestro makes in the integration worktree; `skip` runs neither. A hook that needs a gitignored file needs that file in `env_files`. Set `skip` only for a hook chain that is unaffordable per lane (a `language: system` pre-commit that builds a virtualenv per worktree); the gates still run.

**What does not belong in this block.** Everything a worktree's own provisioning discovers and records per worktree: dependency install-or-link strategy, `COMPOSE_PROJECT_NAME` and network naming, volume forks, sandbox tier, redis database indices, S3 prefixes, seed commands, and the `reset_cmd` for each forked database. Those are the `prepare-worktree` skill's, are decided when a lane is created, and are read back off the summary it writes per worktree. `project` records only what has to be known *before* any worktree exists — which `env_files` is.

#### Asking for it

Read the project first so the questions carry real defaults — the settings module, `.env.example`, `compose.yaml` / `docker-compose.yml`, the migrations directory, and the task runner. If none of that exists, the repo has no database: omit `project` and ask nothing.

Otherwise issue **one `AskUserQuestion` call** carrying both questions:

1. *"What does a phase lane need its own copy of?"* — options: `Nothing — lanes share the main database`, `Test database only`, `Dev and test databases`, `Dev database only`. Put the default you found in the question header ("this repo's suite reads `TEST_DATABASE_URL` — default: test only").
2. *"How is that database delivered?"* — options: `Postgres on a server that is already running`, `Postgres started by Docker Compose`, `SQLite file in the repo`. Both questions ride the same call; if the answer to the first is `Nothing`, this answer is discarded rather than asked again.

The remaining values — `migrate_cmd`, the database names, the server URL, the env var names, and `env_files` — are **read out of the project, not asked**. They already exist in its settings, its compose file and its task runner, and a question whose answer is on disk wastes a turn. Echo what you found in the read-back summary so a wrong guess gets corrected before the file is written, and fall back to a plain-prose question only where the repo genuinely does not say.

### The pipeline block

`pipelines` describes what happens *within* one phase — implement → gate → review → polish → verify → integrate — as opposed to `nodes`, which describes what happens *between* phases. It is fixed machinery, not a planning decision.

**Omit `pipelines` entirely.** Naming `standard-phase` in `defaults.pipeline` is enough: the executor ships that pipeline and supplies it. Do not paste a copy into the plan — a pasted pipeline is a copy that cannot be fixed centrally, so an executor-side correction would never reach a plan already written, and a hand-edited one is how a plan silently stops running its review.

Author a `pipelines` block only when a project genuinely needs a *different* lifecycle. That is an executor-configuration decision made once per project, not a per-plan choice, and a declared id shadows the shipped pipeline of the same name.

### The review chore

Emit this chore on every plan unless `maestro.chores.review` already declares it, and name it first in `defaults.chores`, before `"deslop"`:

```json
"review": {
  "skill": "thermo-nuclear-review-loop",
  "when": "review",
  "prompt": "Run the thermo-nuclear-review-loop skill over this phase's diff until its reviewer approves it.",
  "description": "The phase's code review: one reviewer sub-agent, the implementer fixing and answering it."
}
```

`"when": "review"` is what makes it the phase's review. Maestro runs it only once the phase's gates are green, on the implementer's own session. The implementer spawns one reviewer sub-agent, fixes the findings it verifies, answers the ones it rejects, and repeats until the reviewer approves; the turn then ends with a `VERDICT:` line. On a pass, the `after_review` chores run — `deslop` is one, because `after_review` is the default `when` — and then the gates run once more on the final tree. By default the loop runs until the reviewer approves; a phase with `max_fix_rounds` set stops after that many unsuccessful iterations and asks the operator whether to continue or stop. Leave out `on_failure`: it does not apply to a review chore, since a review turn that errors counts as unapproved.

### The review-canvas chore

Emit this chore only when `.vinta-ai-workflows.yaml` has `integrations.pr-review-canvas: enabled`. Then add `"review-canvas"` to `defaults.chores` after `"deslop"`:

```json
"review-canvas": {
  "skill": "pr-review-canvas",
  "when": "after_pr",
  "prompt": "Generate the review canvas for this phase's pull request: run `/pr-review-canvas` with the PR number named above. Report the local review URL and the PR comment link it returns. Do not change any file in the repository.",
  "description": "A topic-grouped review canvas on each phase PR, for the human reviewer."
}
```

`"when": "after_pr"` is what makes this work. Maestro runs the chore at the end of `integrate`, once the PR is open, and tells the agent the PR's URL and number. When no PR opened, it skips the chore. Do not give it `on_failure: "fail"`; maestro refuses that for an `after_pr` chore, because the phase is already merged. The integration never changes how the plan's phases are written, so the worked example below leaves this chore out.

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

staffed by this **Crew** table:

```markdown
| Agent | Tier | Takes | Why this tier |
|---|---|---|---|
| `tier1` | 1 | Phase 1, Phase 5 | A model plus its migration, and a flag deletion. Exact precedent, both. |
| `tier2-1` | 2 | Phase 2 | A DRF viewset mirroring the tags viewset almost line for line. |
| `tier2-2` | 2 | Phase 3, Phase 4 | Tree serializer and the list action that returns it — same shape twice. |
```

Three implementers for a graph that is never more than **two** phases wide,
which is the case worth reading closely. The two Tier 2 members are there for
concurrency: wave 2 is two Tier 2 phases, and two hands at Tier 2 is the only
way to run it two-wide — `tier1` cannot take one of them. `tier1` is there for
cheapness: without them, Phase 1 and Phase 5 would run on a Tier 2 model for
work that has exact precedent. `tier1` is idle in waves 2 and 3 and that is not a defect; a
fourth implementer would be, because there would be nothing left for them to
make cheaper and no third phase for them to run alongside.

and this **Execution graph** table:

```markdown
| Wave | Phases | Agent | Depends on |
|---|---|---|---|
| 1 | Phase 1 | `tier1` | — |
| 2 | Phase 2, Phase 3 | `tier2-1`, `tier2-2` | Phase 1 |
| 3 | Phase 4 | `tier2-2` | Phase 2, Phase 3 |
| 4 | Phase 5 — remove the `bookmark-folders` flag | `tier1` | Phase 2, Phase 3, Phase 4 (deferred — soak-gated) |

**Idle:** both Tier 2 members in wave 1 — the model has to exist before anything
reads it. `tier2-1` in wave 3, `tier1` in waves 2 and 3.
```

and this `ai-plans/2026-03-04-bookmark-folders.workflow.json`:

```json
{
  "$schema": "https://github.com/vintasoftware/vinta-ai-workflows/schemas/workflow.v1.schema.json",
  "schema_version": 1,
  "id": "2026-03-04-bookmark-folders",
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
  "crew": {
    "tier1": {
      "tier": 1,
      "model": "claude-haiku-4-5",
      "description": "A model plus its migration, and a flag deletion."
    },
    "tier2-1": {
      "tier": 2,
      "model": "claude-sonnet-5",
      "description": "A DRF viewset mirroring the tags viewset."
    },
    "tier2-2": {
      "tier": 2,
      "model": "claude-sonnet-5",
      "description": "Tree serializer and the list action that returns it."
    }
  },
  "defaults": {
    "harness": "claude-code",
    "model": "claude-sonnet-5",
    "pipeline": "standard-phase",
    "chores": [
      "review",
      "deslop"
    ]
  },
  "resources": {
    "lane": {
      "capacity": 3,
      "kind": "worktree",
      "description": "One desk per implementer, kept for the whole run."
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
  "chores": {
    "review": {
      "skill": "thermo-nuclear-review-loop",
      "when": "review",
      "prompt": "Run the thermo-nuclear-review-loop skill over this phase's diff until its reviewer approves it.",
      "description": "The phase's code review: one reviewer sub-agent, the implementer fixing and answering it."
    },
    "deslop": {
      "skill": "deslop-comments",
      "prompt": "Rewrite the comments and doc blocks this phase wrote into Simple English, and delete the ones that should not be there. Comment-only: no renames, no logic changes.",
      "description": "The comment-hygiene pass, on the diff that is about to merge."
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
      "crew": "tier1"
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
      ],
      "crew": "tier2-1"
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
      ],
      "crew": "tier2-2"
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
      ],
      "crew": "tier2-2"
    },
    {
      "id": "p5",
      "name": "Remove the bookmark-folders feature flag",
      "deferred": "until the bookmark-folders flag has soaked two weeks at 100% in production with no rollback or incident attributed.",
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
      "crew": "tier1"
    }
  ]
}
```

Read the three renderings against each other: `p2` and `p3` both name only `p1`, so they sit in wave 2 and run at once; `p4` names both, so it is wave 3; `p5` names every gated phase, so it is wave 4 and alone there — and carries `deferred`, so once `p4` merges the executor asks rather than starts it. `p2` and `p4` both touch `apps/bookmarks/api/views.py` — allowed, because the edge between them puts them in different waves; had they been same-wave, that overlap is what "Same-wave phases must not fight over the same files" is about.

No node carries a `model`. `p1` and `p5` are the Tier 1 phases and run on `tier1`'s model because that is who took them — the roster says it once instead of two nodes repeating an id that goes stale on the next model bump.

`tier2-2` takes `p3` and then `p4`, which is the pairing worth seeing: the same agent writes the tree serializer and the action that returns it, in the same worktree, **continuing the same session**. Its second phase does not pay to work out where the serializers live or how the suite is run — it did that in `p3`. What it *is* told, because the tree moved underneath it, is that it is now on `p4`'s branch, that `p3`'s work is in this tree (`p4` depends on it), and exactly which files differ from what it last saw.

No node names a reviewer, and `crew` has none. Every phase's review is the `review` chore: once the phase's gates are green, its implementer runs `thermo-nuclear-review-loop`, spawns one reviewer sub-agent, and fixes or answers its findings until it approves. `deslop` follows, and the gates run once more on the final tree. Run through `implement-plan` instead, `review-phase` runs the same loop, with the reviewer one tier above each phase's implementer: Tier 2 for `p1` and `p5`, Tier 3 for the rest.

`plan_context_refs` points at the same plan file the `prompt_ref`s do, at its **Goals** and **Guiding Decisions** headings. Each of the five phases is handed those two sections whole, so the implementer of `p3` knows that the tree serializer is deliberately not paginated if the plan's Non-goals said so, and the review of `p3` can call a paginated one scope creep instead of a bonus.

The lane pool is **three**: one desk per implementer, kept for the whole run so each one's session has a directory to come back to. Only two are ever busy at once — the graph is never wider than that — and the third idle desk is the price of `tier1`'s session. The review needs no desk of its own: its reviewer is a sub-agent working in the implementer's lane. The `project` block is what lets those worktrees exist at once. `bookmarks_test` is forked per lane from a template that `uv run python manage.py migrate` builds once, so `p2` and `p3` run `uv run pytest` against separate rows instead of the same ones; `test-suite` stays at capacity 1 because three suites at once melt the machine, not because they would corrupt each other. `dev` and `test` name two different databases, which is what keeps their forks from being the same database under two roles.

## Validate the workflow with vinta-ai-maestro

The `$schema` line catches a typo in an editor. It cannot catch a `prompt_ref` anchor that names a heading the plan does not have, a dependency cycle, a gate that requires a pool nobody declared, or a phase that resolves to no gates. `vinta-ai-maestro validate` catches all four, plus everything a run checks when it loads the file. It spawns nothing and writes nothing. **When maestro is installed, run it on every workflow you write — before you tell the human the plan is ready — and again after every edit to the plan or the workflow.** The installed maestro's `validate` is the authority on the document's shape; the schema at the `$schema` URL is what the editor sees and may lag the installed version, so a file an editor accepts can still be refused, and the other way round. Write the file, run `validate --json`, fix every issue, and only then hand over.

**Find it, never install it.** Try these in order and use the first that works:

```bash
command -v vinta-ai-maestro                      # on PATH
test -x node_modules/.bin/vinta-ai-maestro       # a project devDependency → run it by that path
npx --no-install vinta-ai-maestro --help         # installed or cached, without downloading
```

None works: maestro is not installed. Skip validation, and say so once in your final message ("the workflow was checked against its `$schema` only — `vinta-ai-maestro` is not installed"). Do not install it, and do not run `npx vinta-ai-maestro@…` without `--no-install`: that downloads a package the team did not choose. If the human asks how to get it, give them the install command and let them run it.

**Run it from the repository root:**

```bash
vinta-ai-maestro validate ai-plans/{TODAY}-<feature-kebab>.workflow.json --json
```

| Exit | Meaning | What to do |
|---|---|---|
| `0` | Valid. The JSON says how many phases and waves. | Check the wave count against the **Execution graph** table, then move on. |
| `1` | Not valid. `issues` lists each problem as `{source, path, message}`. | Fix every issue (see below) and run it again. Do not hand the plan over while it exits `1`. |
| `2` | Bad command line. An older maestro without `validate` also answers `2` with `unknown command`. | For the older maestro, treat it as not installed and say which version would add the check. |

Fix each issue by its `source`:

- **`reference`**: a `plan_ref`, `prompt_ref` or `plan_context_refs` anchor names no heading in the plan. The plan is the source of truth. Usually a phase heading was renamed or renumbered and the workflow was not updated. Fix whichever side is wrong, then check that the two still agree.
- **`workflow`**: the document's shape or graph, such as an unknown node, a cycle, an undeclared pool, a crew member that cannot take its phase, a gate entry with neither `cmd` nor `type`, a phase with no gates, or an id that does not match the filename. Re-derive the field from the plan. A gate `"has no cmd"` is an override that forgot its `"type"`. A phase that `"has no gates"` is a node carrying `"gates": []` — remove the key so it takes `defaults.gates`, name its gates, or, for a plan whose phases genuinely have nothing to run, set `defaults.allow_ungated_phases: true`. If the plan itself is wrong (a cycle in its `**Depends on**:` lines), fix the plan first.
- **`config`**: `.vinta-ai-workflows.yaml` does not parse. That file is the project's, not the plan's. Do not edit it to make the plan pass. Tell the human what is wrong and where.

## Review the plan with the human

A plan is cheapest to change before anything runs. Once both files are written and the workflow validates, hand the plan over for review. Ask with `AskUserQuestion`: header `Review`, question "The plan and its workflow are written — `<plan path>` and `<workflow path>`. How do you want to review it?"

| Option | Offer it when | Description |
|---|---|---|
| `Review page (Recommended)` | maestro is installed | "Open a page with the phase graph, each phase's real prompts and gates, the plan, and its projected schedule. Comment on anything, and chat with me while I revise it." |
| `Review here in chat` | always (`(Recommended)` when maestro is not installed) | "I read the plan back here, and you tell me what to change." |
| `Done for now` | always | "Stop here. The plan can be reviewed later." |

When maestro is not installed, add one line before the question: a visual review page with comments and a chat comes with `vinta-ai-maestro`. Do not install it.

### The review page

The page is maestro's UI, opened on this plan. The person reads the graph, each phase's brief, prompts and gates, and the plan itself. They comment on any of it and send the comments to you as a batch, and they can message you directly. You answer from here, with two commands, and they see your edits to the plan as you make them.

1. **Serve the page** in the background. It is a long-running server, so use your harness's background mode, or `nohup … &`:

   ```bash
   vinta-ai-maestro review open ai-plans/{TODAY}-<feature-kebab>.workflow.json
   ```

   Read its output for the line starting `http://`. That URL opens on this plan's page. **It carries the page's access token**, so give it to the human in your reply and nowhere else: not in the plan, a commit, a PR or a log.

2. **Open the conversation.** Post one short message as the opening of the review. Say what the plan does, how many phases and waves it has, and the two or three decisions you are least sure of. Those are where the review should look first.

   ```bash
   vinta-ai-maestro review reply ai-plans/{TODAY}-<feature-kebab>.workflow.json --as <your harness> -m "…"
   ```

3. **Wait for the person.** This blocks until they send something, then prints it as one JSON object:

   ```bash
   vinta-ai-maestro review wait ai-plans/{TODAY}-<feature-kebab>.workflow.json --timeout 110
   ```

   Keep `--timeout` under your harness's limit for one command (110 seconds fits a two-minute limit). Act on `kind`:

   - **`timeout`**: nothing arrived. Run `wait` again, and post nothing. After about 30 minutes of timeouts in a row, stop waiting. Leave the page running, and tell the human in the terminal how to bring you back: "say *check the review* and I'll pick up what you sent". Their comments are kept until then.
   - **`messages`**: one entry per message they sent. Each entry has a `body` and the `comments` it sent. A comment carries `where` (what it is about, in words), its `anchor`, the `quote` the person selected, its `body`, and the replies so far. Handle each one (see below), then run `wait` again.
   - **`approved`**: the person approved the plan. The loop is over. Stop the page's server, then tell the human in the terminal what was approved and what comes next (`implement-plan`, or a maestro run).

4. **Handle each comment.** Read it against the thing it is about. Then:

   - **It asks for a change you agree with:** edit the **markdown plan first**, re-derive the workflow from it, and run `validate` again. The two files are one graph, so never edit just one. Then answer on the thread with what changed and where. Add `--resolve` only when your edit fully does what the comment asked:

     ```bash
     vinta-ai-maestro review reply <workflow.json> --comment c3 --resolve --as <your harness> -m "Split into Phase 2a (endpoint) and 2b (tests) …"
     ```

   - **It asks a question, or you disagree:** answer on the thread without `--resolve`. Give your reasoning and what it would cost to do it their way. The person resolves it.
   - **It needs a decision only the person can make:** ask it in the conversation, with the options and your recommendation. While the review page is open, the page is where the person is, and its chat is the structured channel for the loop. A question asked through `AskUserQuestion` in the terminal would wait unseen.

   Finish each round with one message in the conversation that sums up what changed. Every edit you make shows on the page within seconds. The page tells the person the plan changed, so they can re-read it before replying.

5. **The review is a file**: `ai-plans/{TODAY}-<feature-kebab>.review.json`, beside the plan, validated by `plan-review.v1.schema.json`. Never edit it by hand. Comments, replies, delivery and approval all go through `review wait` / `review reply` and the page, which share a lock. It is committed with the plan, so the next reader can see what was questioned and what changed.

If the human answers in the terminal instead of on the page, that is fine. Handle it the same way, and post a line in the conversation so the page's history stays whole.

### Review in chat

Read the plan back in one message:

- the phases, by wave, each with its agent tier and model;
- the gates each phase must pass;
- the feature flag and how it is removed;
- the open questions;
- the decisions you are least sure of.

Then ask with `AskUserQuestion`: header `Plan`, question "Anything to change before the plan is final?", options `Looks good (Recommended)`, `Some corrections`, `Stop, rethink`. On `Some corrections`, edit the plan, re-derive the workflow, validate, and ask again. On `Looks good`, finish.

## What to avoid

- **No `§N` shorthand for section references — anywhere in the plan body.** Use section names: `Goals + Non-goals`, `Guiding Decisions`, `Data Model Changes`, `API Design`, `Phased Rollout`, `Risk & Rollout Notes`, `Open Questions`, `Touch List`. Readers shouldn't have to count headings to follow a cross-reference, and section numbering shifts when the spec/plan evolves. Same rule applies to citing SPEC sections (`Use-cases`, `Acceptance scenarios`, etc.) — name them.
- **No time estimates.** Use LoC sizing.
- **No vibes-based guarantees** ("should be straightforward", "trivial", "easy lift").
- **No skipped non-goals section.**
- **No phase that breaks build if merged alone.** Each independently mergeable AND independently reversible.
- **No `**Depends on**:` edge you can't justify with an artifact.** "It's later in the list" is not a dependency; it's a chain that costs the team a week of wall-clock for nothing.
- **No two same-wave phases rewriting the same file.** Either add the edge or split differently.
- **No phase assigned below the tier its work implies.** A cheap model on work above its tier does not fail cleanly; it fails review two rounds later, and by then nothing points at the staffing.
- **No member who takes no phase.** It is an agent budgeted for that can never be picked, and the executor refuses it.
- **No reviewer rows and no per-phase review-model line.** Reviews are not staffed (see "Who reviews"); executors ignore both.
- **No `model` on a node of a staffed workflow.** The member carries it; a node with both is refused rather than one quietly outranking the other.
- **No repeating a defect a post-mortem already recorded.** A `wave_conflicts` entry on those paths, or a `missing_dependencies` entry between those layers, means the last run already paid for the lesson; drawing the same graph again wastes it.
- **No handing over a workflow `vinta-ai-maestro validate` rejects**, when maestro is installed. Run it before announcing the plan, not after. And never install it yourself to run the check.
- **No `[]` where "the project's" was meant.** `"gates": []` on a node, `"chores": []` in `defaults`: both replace the project's list with nothing. Omit the key.
- **No `project` block that leaves out a gitignored file the lanes need.** Every `.gitignore` entry with a tracked example, every compose `env_file:`, the local settings module — in `env_files`, or in the project file's `maestro.project.env_files`.
- **No editing the plan or the workflow alone during a review.** A comment that changes one changes both, then `validate` runs again.
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
- [ ] Each phase has Goal / **Depends on** / Spec use-case / Feature flag (or explicit waiver) / Changes / Tests / **Assigned to** / Reusable skills / Acceptance.
- [ ] Every `**Depends on**:` entry names the artifact it needs (model, symbol, migration, endpoint) — no bare phase ids, no "comes first" edges.
- [ ] **Execution graph** table is the first thing under **Phased Rollout**, and its waves match what the `**Depends on**:` lines imply.
- [ ] Graph is acyclic; the flag-removal phase depends on every gated phase.
- [ ] Same-wave phases checked against the **Touch List** for file overlap; real overlaps either serialized with an edge or called out explicitly under the graph table.
- [ ] Post-mortems from previous runs (`.vinta-ai-maestro/runs/*/postmortem.json`, plus any committed beside a plan) read **before** the graph was drawn; every finding either changed an edge, a wave or a split, or was consciously dismissed as not applying to this feature.
- [ ] Slow-moving / cross-repo work sits in wave 1, and no in-repo phase depends on a cross-repo phase when it only needs the contract.
- [ ] Every interface two same-wave phases share (a signal payload, a protocol, a DI provider, an event schema) has a contract test in the foundation phase they both depend on.
- [ ] **Crew** table is the first thing under **Phased Rollout**: one row per implementer and no reviewer rows, every member taking at least one phase, every `Takes` cell agreeing with that phase's `**Assigned to**:` line.
- [ ] **Every member earns their place** — by concurrency (a wave genuinely needs that many hands *at or above* those phases' tiers) or by cheapness (they take work a dearer member would otherwise do). Check it wave by wave: sort the wave's phase tiers against the roster's and confirm the roster covers them one for one.
- [ ] Every phase is assigned to a member whose tier is **at or above** the rubric tier its work implies — no phase handed down a tier to save money.
- [ ] **Execution graph** carries the Agent column, and an **Idle** note naming who has nothing to do in which wave. A wave that serializes because the roster is smaller than it is called out rather than left to be discovered at run time.
<!-- e2e:start -->
- [ ] **If e2e coverage was opted into at Step 0:** every phase introducing a new UI flow has an **E2E happy-path test** in its Tests block, with screenshot output to `pr-screenshots/`. If it was not opted into (default), **no phase carries an e2e spec** and there is no `QA_USE_CASES.md` / `pr-screenshots/` reference.
<!-- e2e:end -->
- [ ] Feature flag declared in **Guiding Decisions** (key, scope, default, flip-on criterion) **unless** **Guiding Decisions** explicitly justifies "no flag — purely additive surface".
- [ ] ≥1 test per gated phase asserts flag-off behavior unchanged.
- [ ] If flag declared, **final entry under Phased Rollout is dedicated flag-removal phase** with prerequisite (soak window), full deletion touch list, `grep` acceptance check — and its workflow node carries `deferred` with that prerequisite.
- [ ] No time estimates anywhere.
- [ ] Cross-repo phases labeled `Phase Nb`, deploy ordering called out.
- [ ] Risk & Rollout Notes covers locks, partitions, backfills, rollback.
- [ ] Open Questions lists what couldn't resolve, with recommended default.
- [ ] Touch List groups files by phase.
- [ ] All file references use `@path/to/file.py` or `[name](relative-path#Lline)`.
- [ ] **`ai-plans/{TODAY}-<feature-kebab>.workflow.json` written** — every plan, no exceptions — with `$schema` set to the canonical URL and `schema_version: 1`.
- [ ] Workflow graph matches the **Execution graph** table: one node per phase, one `depends_on` entry per `**Depends on**:` clause carrying both the node id and the artifact, same waves.
- [ ] Every node has `prompt_ref` (`<plan_ref>#phase-<number>`), `touches` from its **Touch List** block, and either no `gates` key (inheriting `defaults.gates`, the plan's or the project's) or the list it must pass. No node carries `"gates": []` unless `defaults.allow_ungated_phases` says the plan means it.
- [ ] `project.env_files` — here or in `.vinta-ai-workflows.yaml`'s `maestro.project` — names every gitignored file the project's hooks, gates and settings read, found by reading `.gitignore`'s `*.example` siblings, the compose `env_file:` lines and the settings module.
- [ ] **`plan_context_refs` names the Goals and Guiding Decisions anchors** (`<plan_ref>#1-goals`, `<plan_ref>#2-guiding-decisions`), matching the headings as written — references, never a summary of them. Every phase's implementer reads them; a phase that doesn't know the non-goals is a phase that scope-creeps.
- [ ] `resources` declares a `lane` pool at the **number of implementers** — one worktree each, kept for the whole run. Every gate that contends for something shared names its pool in `requires`.
- [ ] **`project` decided, not defaulted** — asked via `AskUserQuestion`, then either written (roles `dev` / `test`, each naming its own database, engine fields filled from the project, `migrate_cmd` read out of its task runner) or deliberately omitted because lanes share the main checkout's database. No `reset_cmd`, no compose project name, no seed command, no env-file strategy — those are the worktree's, not the plan's.
- [ ] No credential anywhere in the workflow file: `connection_url_var` is a variable name, and `server_url` is a host and port.
- [ ] Model ids come from [resources/ai-models.yaml](resources/ai-models.yaml) and appear **only** in the `crew` block — no node carries a `model`, and `crew` transcribes the Crew table's rows one for one, with no `role` field.
- [ ] Every `crew` model with a `fallback:` in [resources/ai-models.yaml](resources/ai-models.yaml) has its `defaults.model_fallbacks` entry, unless the project's `maestro.defaults.model_fallbacks` already carries it.
- [ ] **Nothing copied from `.vinta-ai-workflows.yaml`.** Gates the project supplies are referenced by type name or declared with `"type"` and only the overriding fields (never a `requires`-only entry without `"type"`); pools, chores, `project` and `defaults` the project already declares are not repeated — and not replaced with `[]`.
- [ ] `review` (with `"when": "review"`) and `deslop` are declared and named in `defaults.chores`, in that order — here, or by the project's `maestro:` section — so every phase is reviewed once its gates are green and gets the comment pass after the review approves. No node carries its own `chores` unless that phase genuinely needs a different set.
- [ ] `chores.review-canvas` (with `"when": "after_pr"`) is declared and in `defaults.chores` **if and only if** `.vinta-ai-workflows.yaml` has `integrations.pr-review-canvas: enabled`.
- [ ] `pipelines` is omitted — `defaults.pipeline: standard-phase` is enough, and the executor supplies it.
- [ ] **Validated with `vinta-ai-maestro validate --json`, exit `0`**, when maestro is installed, and again after every edit made during review. When it is not installed, the final message says the workflow was checked against its `$schema` only, and nothing was installed.
- [ ] **Review offered** with `AskUserQuestion` (review page / in chat / done for now). On the review page: the URL went to the human and nowhere else, every sent comment got an answer on its own thread, and the loop ended on `approved` or on the human stopping it, with the page's server stopped. The `.review.json` beside the plan was written only by `review reply` and the page.