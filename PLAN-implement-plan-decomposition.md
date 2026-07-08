# Plan — Decompose `implement-plan` into modular, deterministic skills

**Status:** design locked (decisions recorded in §10)
**Scope (confirmed):** `implement-plan` + `amend-plan` + `systematic-debugging` (adopts the shared `review-phase` in this pass); kill runtime `if` branches **and** restructure the generation-time templates into composable partials; moderate "pipeline sub-skills" granularity; each skill is its **own file** (source shell + shipped SKILL.md).
**Out of scope:** any change to the CLI (`vinta-ai-workflows.mjs`).

---

## 1. Why the current template is "big and full of branches"

The 436-line [implement-plan-template.md](skills/vinta-derive-skills/resources/implement-plan-template.md) is hard for two *independent* reasons. Keeping them separate is the key to the whole plan:

### Axis A — generation-time `{{...}}` placeholders (~40)
Resolved by [vinta-derive-skills](skills/vinta-derive-skills/SKILL.md) when it renders the template into a target project. Examples: `{{PR_POLICY_BLOCK}}`, `{{COAUTHOR_*}}`, `{{E2E_*}}`, `{{DEPENDENCY_LICENSE_*}}`, the entire `{{COMMIT_STRATEGY_*}}` family (which even needs a [sister file](skills/vinta-derive-skills/resources/implement-plan-template-modular-substitutions.md)).

These **collapse at derive time** — the SKILL.md a project actually receives has them substituted. So they do *not* hurt the runtime determinism of the shipped skill. They hurt **authoring**: one mega-template tries to render every project shape at once.

### Axis B — runtime `if run_options.*` branches
These **survive into the shipped skill**; the executing agent evaluates them live. They are the real determinism problem:

| Runtime branch | Where it's threaded today | Cost |
|---|---|---|
| `use_worktree` | Step 0.5, worktree-topology rule, sandbox wrapping in 1c, Layer-1 stray-write check (1d), `git -C` prefixes in 1e, resume logic, teardown in Step 2 | **Highest** — cross-cuts ~8 steps |
| `commit_strategy = ask` | Dual-renders *both* stacked and modular branch/commit/PR bodies into one file, gated by inline `If … Else …` markers | **High** — doubles several sections |
| `generate_inline_comments` | 1f matrix (× PR policy) | Medium — localized to 1f |
| `pause_between_phases` | 1i gate | Low — already localized |

> `commit_strategy = stacked-branches` / `modular-commits` are **project policies**, so for those projects the strategy is resolved at *derive time* (Axis A) and the shipped skill is single-path. Only `ask` pushes the choice to runtime.

**Determinism = mostly killing Axis B.** Maintainability = restructuring Axis A. We do both.

---

## 2. Target architecture

`implement-plan` becomes a **thin conductor** that orchestrates a fixed pipeline of single-purpose sub-skills. Each sub-skill receives its variability as *data* (a path, an agent type, a resolved strategy) rather than re-deriving it via control flow.

```
implement-plan  (conductor: parse → classify → resolve WORKROOT → loop → track → report)
├─ prepare-worktree        (EXISTS)  Step 0.5 — provision + probe sandbox, returns WORKROOT
├─ implement-phase         (NEW)     1a compose prompt + 1b pick model + 1c spawn implementer
├─ review-phase            (NEW)     1d Layer 1/2/3 + fix loop        ← shared with amend-plan
├─ integrate-phase         (NEW)     1e push (strategy-resolved) + 1f PR-context
│   └─ open-pr-from-context (EXISTS) publishes the context file
└─ (inline in conductor)   1g tracking · 1h update · 1i pause · cross-repo/flag-removal defer · Step 2 report

amend-plan  (conductor: history-rewriting topology — its own Steps 2–4)
├─ implement-phase  (reuses the shared implementer-prompt partial for 4b "amend-existing")
├─ review-phase     (reuses verbatim — amend-plan already says "same as implement-plan")
└─ (inline)         rewrite queue · force-push refusals · rebase · force-push · PR-context refresh
```

### Responsibilities & contracts

| Skill | Absorbs | Inputs (passed as data) | Output |
|---|---|---|---|
| **`implement-plan`** (conductor) | Step 0, 0.5 dispatch, per-phase loop, 1g/1h/1i, cross-repo & flag-removal deferral, Step 2 | plan file | branches/PRs + tracking + final report |
| **`implement-phase`** | 1a + 1b + 1c | phase record, plan-level decisions (Goals/Decisions/Data-Model), prior-phase summaries, `WORKROOT`, `base_branch`, `sandbox_tier`, agent-dispatch table, project commands | implementer report |
| **`review-phase`** | 1d (all three layers + fix loop) | phase diff, phase body, `WORKROOT`, `main_checkout`, reviewer/fixer agent types, outer-gate commands | pass verdict / applied fixes |
| **`integrate-phase`** | 1e + 1f | `WORKROOT`, `base_branch`, resolved commit strategy, PR policy, `generate_inline_comments`, prs-context path | pushed branch + (maybe) PR |

### The determinism moves (Axis B)

1. **`use_worktree` → a single `WORKROOT` seam.** The conductor resolves *once* at Step 0.5:
   - `use_worktree = false` → `WORKROOT = <main_checkout>`, `base_branch = {{DEFAULT_BRANCH}}`, `sandbox_tier = none`.
   - `use_worktree = true` → `WORKROOT = <worktree_path>`, `base_branch = <worktree_branch>`, `sandbox_tier` = probed by [prepare-worktree](skills/vinta-derive-skills/resources/foundation-skills/prepare-worktree/SKILL.md).

   Every sub-skill then uses `git -C <WORKROOT>` **uniformly** — no `if use_worktree` inside them. The ~8 scattered conditionals collapse to:
   - one resolution point (conductor),
   - one `sandbox_tier`-gated spawn-wrap inside `implement-phase` (local, 2-way),
   - one `WORKROOT != main_checkout`-gated stray-write check inside `review-phase` (local, 2-way).

   Net: individual sub-skills are effectively single-path; "worktree-ness" is data, not duplicated control flow.

2. **`commit_strategy = ask` → dispatch by name, no dual-render.** `integrate-phase` is rendered **once per resolved strategy**:
   - `stacked` / `modular` projects → `integrate-phase` ships with exactly one topology body. Zero runtime branch.
   - `ask` projects → ship **two** rendered variants (`integrate-phase-stacked`, `integrate-phase-modular`); the conductor emits one dispatch line keyed on `run_options.commit_strategy_resolved`. This replaces the current inline `If modular … Else stacked …` dual-render (the whole reason the [sister file](skills/vinta-derive-skills/resources/implement-plan-template-modular-substitutions.md) exists) with a single `invoke integrate-phase-<resolved>` call.

3. **`generate_inline_comments` → localized to `integrate-phase`.** The flag only toggles whether the `# Comments` section of the prs-context file is populated. It stops being a cross-cutting concern; it's one branch inside one skill.

4. **`pause_between_phases`** stays inline in the conductor loop (already a single localized gate). No change needed.

---

## 3. Restructure the generation-time templates (Axis A)

`vinta-derive-skills` is **agent-executed**, not a build script — so "partials" means *shared source-of-truth fragments the derive-skills agent concatenates*, delimited exactly like today's sister file (`<!-- substitution-begin: NAME -->` … `-end`).

Create `skills/vinta-derive-skills/resources/plan-execution/` holding:

```
plan-execution/
├─ shell/
│  ├─ implement-plan-template.md      (thin conductor shell)
│  ├─ implement-phase-template.md
│  ├─ review-phase-template.md
│  ├─ integrate-phase-template.md
│  └─ amend-plan-template.md          (moved from resources/, now includes shared partials)
└─ partials/
   ├─ implementer-prompt.md           (was 1a — shared by implement-phase + amend-plan 4b)
   ├─ model-pick.md                   (was 1b — shared)
   ├─ review-layers.md                (was 1d — shared by review-phase; amend-plan reuses)
   ├─ worktree-seam.md                (WORKROOT rule + sandbox-wrap + stray-write check)
   ├─ commit-strategy/stacked.md      (branch/commit/PR body — folds in today's sister file)
   ├─ commit-strategy/modular.md
   └─ pr-context.md                   (was 1f matrix, minus commit-strategy coupling)
```

Each shell template carries `<!-- include: partials/<name> -->` markers. The derive-skills agent expands includes, **then** runs `{{...}}` substitution over the assembled body, **then** writes each `ai-tools/skills/<name>/SKILL.md`. Every concern is authored **once**; a fix to the review layers touches one file and flows to both `review-phase` and `amend-plan`.

> This keeps the substitution model identical to today (marker-delimited blocks the agent already knows how to extract) — we are extending the pattern, not inventing a templating engine.

---

## 4. New skills — authoring notes

All three new skills are **Bucket B (template-rendered)** — they cite `{{TEST_CMD}}`, `{{BUILD_CMD}}`, agent-dispatch table, branch conventions, so they cannot ship verbatim.

- **Naming:** `implement-phase`, `review-phase`, `integrate-phase` (kebab, verb-led, per [naming rules](AGENTS.md)). For `ask` projects, `integrate-phase-stacked` / `integrate-phase-modular`.
- **Description hygiene (important):** these are *internal to the conductor*, invoked explicitly by `implement-plan` / `amend-plan`. Their `description:` must be scoped so they do **not** auto-trigger on unrelated user prompts (e.g. "Invoked by implement-plan / amend-plan to run one phase's review gates; not a standalone entry point"). Otherwise a target project's skill-trigger space gets polluted. This is a first-class design constraint, tracked as a risk below.
- **Cross-links:** conductor → sub-skills via `[implement-phase](../implement-phase/SKILL.md)` etc.; sub-skills back-reference the conductor only in prose, not as triggers.

---

## 5. Schema-ripple / orphan-prevention wiring

Per [AGENTS.md "Schema changes ripple"](AGENTS.md) and the [add-foundation-skill](dev-skills/add-foundation-skill/SKILL.md) contract, new shipped skills must be wired everywhere or they orphan.

**Locked treatment: each sub-skill is its own file, co-shipped as the "plan-execution unit."** They are separate `ai-tools/skills/<name>/SKILL.md` files (separate source shells + partials) so they can be reviewed and evolved independently — but they are **not** individually install-toggleable, because disabling e.g. `review-phase` would break `implement-plan`. "Separate files" and "a `foundation_skills` enum entry" are orthogonal: we get the former without the latter.

> `review-phase` is shared by **all three** conductors (`implement-plan`, `amend-plan`, `systematic-debugging`). Since `implement-plan` is always generated, `review-phase` is always present — so `systematic-debugging` (opt-in) can rely on it with no orphaning.

| Consumer | Change |
|---|---|
| `schemas/vinta-ai-workflows-config.v1.schema.json` `foundation_skills` enum | **No new enum entries** — the plan-execution skills are internal to the conductors, not independently opt-in. |
| Bootstrap interview ([vinta-bootstrap-ai-tools](skills/vinta-bootstrap-ai-tools/SKILL.md)) | No new question. |
| Step 0.5 YAML emission | No new keys. |
| [vinta-derive-skills](skills/vinta-derive-skills/SKILL.md) **Bucket B** | **Add** the new templates to the render list (`implement-phase`, `review-phase`, `integrate-phase` — plus the `integrate-phase-{stacked,modular}` split for `ask` projects); describe the partials/include mechanism; update the "render each template… validate every placeholder replaced" step to cover all of them together. |
| Foundation-shape recognition ([vinta-analyze-codebase](skills/vinta-analyze-codebase/SKILL.md)) | **Add** the new names so a re-bootstrap classifies an existing copy as `foundation-shape` (not `project-custom`). |
| Outputs tree / expected files (bootstrap + derive-skills verification) | **Add** `ai-tools/skills/{implement-phase,review-phase,integrate-phase}/SKILL.md`. |
| [validate-skill-md](dev-skills/validate-skill-md/SKILL.md) | Lint the new SKILL.md files + the `plan-execution/partials/*` (partials legitimately keep `{{...}}` and `<!-- include -->`, like the existing sister file — add them to the allowlist). |
| [systematic-debugging template](skills/vinta-derive-skills/SKILL.md) | Replace its inline review prose with an `invoke [review-phase]` reference (§6a). |
| CHANGELOG | One "Changed" entry (implement-plan/amend-plan restructured into conductors + shared plan-execution skills) + version bump (**minor**). |

---

## 6. amend-plan integration

[amend-plan](skills/vinta-derive-skills/resources/amend-plan-template.md) already declares "same agents, same review gates, same PR-context flow" as implement-plan. Concretely:

- **Reuses `review-phase` verbatim** — its Step 4c ("Run the three-layer review — same as implement-plan") becomes `invoke [review-phase] against the rewritten branch`. Deletes the duplicated prose.
- **Reuses the `implementer-prompt` partial** — Step 4b's inline prompt becomes an include of `partials/implementer-prompt.md` with the amend-specific "how to record the change" preamble layered on top.
- **Keeps its own topology** (Steps 2–4: rewrite queue, force-push refusals, rebase, `--force-with-lease`, PR-context *refresh*). This is genuinely different from forward push, so it is **not** folded into `integrate-phase`. amend-plan stays a distinct conductor.
- **`WORKROOT` seam applied now (in this pass).** Every `git` call in amend-plan's Steps 2–4 (`checkout`, `reset --hard`, `rebase`, `push --force-with-lease`) takes `git -C <WORKROOT>`, resolved once the same way the conductor does. This keeps the two conductors consistent and lets an amend run inside the same isolated worktree a plan was implemented in.

Net for amend-plan: it *shrinks* (two big duplicated sections become includes) and picks up the same `WORKROOT` uniformity, without a topology rewrite.

### 6a. systematic-debugging

[systematic-debugging](skills/vinta-derive-skills/SKILL.md) (opt-in, Bucket B) currently carries its own review prose. In this pass it replaces that with `invoke [review-phase]` against the fix diff, so all three conductors share one review implementation. No other systematic-debugging change — its Phase 0 evidence-gathering and MCP-catalogue blocks are untouched.

---

## 7. File-by-file change list

**New:**
- `skills/vinta-derive-skills/resources/plan-execution/shell/{implement-plan,implement-phase,review-phase,integrate-phase,amend-plan}-template.md`
- `skills/vinta-derive-skills/resources/plan-execution/partials/{implementer-prompt,model-pick,review-layers,worktree-seam,pr-context}.md`
- `skills/vinta-derive-skills/resources/plan-execution/partials/commit-strategy/{stacked,modular}.md`

**Modified:**
- `skills/vinta-derive-skills/SKILL.md` — Bucket B render list; partials/include mechanism; combined placeholder-validation step; cross-link verification list.
- `skills/vinta-derive-skills/resources/systematic-debugging-template.md` — swap inline review prose for an `invoke [review-phase]` reference (include `partials/review-layers.md` if any body text is still needed inline).
- `skills/vinta-analyze-codebase/SKILL.md` — foundation-shape name list.
- `skills/vinta-bootstrap-ai-tools/SKILL.md` — outputs tree (new files); no new interview (skills are co-shipped, not toggleable).
- `dev-skills/validate-skill-md/SKILL.md` — lint targets + partials `{{...}}`/include allowlist.
- `CHANGELOG.md` + `package.json` (minor bump).
- `AGENTS.md` — the `resources/<*>-template.md` bullet + repo layout note, to mention `plan-execution/`.

**Retired (content moved, not deleted blindly):**
- `skills/vinta-derive-skills/resources/implement-plan-template.md` → split into shell + partials.
- `skills/vinta-derive-skills/resources/implement-plan-template-modular-substitutions.md` → folded into `partials/commit-strategy/*` + `partials/pr-context.md`.
- `skills/vinta-derive-skills/resources/amend-plan-template.md` → moved under `plan-execution/shell/`, references updated.

---

## 8. Work phasing (behavior-preserving until the last step)

Each phase is independently reviewable; behavior is held constant until Phase 3.

- **Phase 0 — Design lock.** This doc (decisions recorded in §10).
- **Phase 1 — Extract partials, no behavior change.** Factor today's `implement-plan-template.md` into `shell/implement-plan-template.md` + partials so the *re-assembled render is byte-identical* to today's output. Verify by rendering against one real project (or a fixture) and diffing.
- **Phase 2 — `WORKROOT` seam.** Collapse scattered `use_worktree` conditionals into one resolution + uniform use, in **both** implement-plan and amend-plan. Still behavior-preserving. Diff-verify.
- **Phase 3 — Split into sub-skills.** Introduce `implement-phase` / `review-phase` / `integrate-phase` shells (separate files); rewrite the conductor to dispatch. First behavior-visible change (multiple SKILL.md files in target).
- **Phase 4 — Wire amend-plan** to reuse `review-phase` + `implementer-prompt` partial.
- **Phase 5 — Wire systematic-debugging** to reuse `review-phase` (§6a).
- **Phase 6 — Schema-ripple wiring** (§5 table).
- **Phase 7 — Validation** (§9).

---

## 9. Verification (no build/test suite in this repo — per [AGENTS.md](AGENTS.md))

1. `dev-skills/validate-skill-md` clean across `skills/` — no surviving `{{...}}` in rendered outputs, all cross-links resolve, `name` = dir.
2. **Render smoke test:** run `vinta-derive-skills` mentally/against a scratch target for three matrix cells — `stacked` + no-worktree, `modular` + worktree, `ask` + worktree — and confirm each produced `ai-tools/skills/*/SKILL.md` is single-path (no stray `If run_options …` markers except the one intended `ask` dispatch line).
3. **Diff gate for Phases 1–2:** assembled render must equal the pre-refactor render for at least one representative project config.
4. `node vinta-ai-workflows.mjs list` still succeeds (we touched no CLI code, but confirm).
5. Cross-link audit: `implement-plan ↔ implement-phase ↔ review-phase ↔ integrate-phase ↔ open-pr-from-context` and `amend-plan → review-phase` all resolve.

---

## 10. Risks & open questions

| Risk | Mitigation |
|---|---|
| **Sub-skill descriptions auto-trigger** on unrelated prompts in target projects | Scope descriptions as "invoked by implement-plan/amend-plan; not a standalone entry point" (§4). Verify none read as general-purpose triggers. |
| **More files to keep in sync** across the schema-ripple surface | Bundle approach (§5) minimizes it; validate-skill-md + the derive-skills combined-validation step are the backstop. |
| **Behavior drift during the split** | Phases 1–2 are byte-diff-verified before any behavior change (Phase 3). |
| **`ask` projects ship an extra skill** (two integrate variants) | Acceptable — it replaces a worse dual-render; only `ask` projects pay it. |
| **partials + includes is agent-executed, not compiled** | Same trust model as today's sister file; validate-skill-md checks for unexpanded `<!-- include -->` in shipped output. |

**Resolved decisions:**
1. **Separate files, co-shipped as a unit.** Each sub-skill is its own source shell + shipped `SKILL.md` (so it's reviewable and evolvable on its own); no `foundation_skills` enum entries (not individually install-toggleable). See §5.
2. **Names accepted:** `implement-phase` / `review-phase` / `integrate-phase` (+ `integrate-phase-{stacked,modular}` for `ask` projects).
3. **amend-plan `WORKROOT` folded in now** (Phase 2), not deferred.
4. **`systematic-debugging` adopts shared `review-phase` in this pass** (Phase 5, §6a).
