# PLAN — End-to-end testing & benchmarking harness

**Status:** Draft for review
**Owner:** _TBD_
**Related work in flight:** `feat/write-unit-tests`, `feat/make-e2e-tests-opt-in`, `feat/models-nightly-checks`, `feat/filesystem-sandbox-for-worktrees`

---

## 1. Objective

`vinta-ai-workflows` ships prompts, skills, sub-agents and per-vendor wiring that are executed by an *AI agent*, not by our code. Unit tests can prove the CLI copies files and that a `SKILL.md` is well-formed, but they can't prove the thing we actually sell: that a bootstrapped project lets an agent take a task from prompt to healthy, merged code — **across every supported vendor and model**.

This harness closes that gap. It:

1. Drives real agents through the canonical workflows against fixture projects.
2. Verifies the *outcome* (feature works, bug fixed, script runs) and the *shape of the work* (git tree healthy, artifacts schema-valid).
3. Runs the same scenarios across the **model × vendor matrix** (Claude Code + Codex for v1) so we can compare quality and catch a vendor-specific regression.
4. Records **token consumption + cost + wall-time** per run so we can benchmark between package versions and flag blow-ups.

**Execution model:** the L2 agentic tests are **manual, human-triggered** — run before a release or to investigate a specific change, never on an automatic cron. Cost is not the primary constraint; *human control over when they run* is. Two hard requirements follow: every scenario must be **runnable individually** (pick one scenario / vendor / model without running the whole matrix), and every skill invocation must be **fully pre-answered** so no run stalls waiting for interactive input (§6).

Non-goals: replacing unit/lint tests (they stay, cheaper and deterministic); testing the AI models themselves; guaranteeing bit-identical output (LLMs are non-deterministic — we assert on invariants and pass-rates, not exact diffs); automatic scheduled runs.

---

## 2. What we are testing (product surface)

| Surface | Entry point | Covered by scenario | Fixture state |
|---|---|---|---|
| Harness installation | `npx vinta-ai-workflows install` + `/vinta-bootstrap-ai-tools` | **S0 — Bootstrap** | clean (no `ai-tools/`) |
| Harness upgrade | `/vinta-sync-ai-tools` | **S1 — Sync** | stale harness (older version) |
| Feature delivery pipeline | `/create-spec` → `/plan-feature` → `/implement-plan` | **S2 — Feature** | current harness |
| Bug workflow | `/systematic-debugging` → fix | **S3 — Bug** | current harness |
| One-off script | `/add-one-off-script` | **S4 — Script** | current harness |
| Cross-cutting outcome checks | app runs / tests pass; git tree shape | **E2E graders** (applied to S2–S4) | — |

The three fixture states are all first-class coverage (§4): **S0** proves bootstrap works on a clean repo, **S1** proves sync correctly upgrades an already-configured repo, and **S2–S4** run the shipped skills against a repo that already has the current harness (so skill quality is tested without paying for bootstrap each time).

---

## 3. Test layers (cheap → expensive)

Run the cheap layers on every PR; gate the expensive, paid-API layers behind manual invocation (§11).

- **L0 — Package static tests** *(no model, milliseconds)*
  CLI unit tests (install/update/uninstall file placement + marker semantics + idempotency), JSON-Schema validation of every sample payload, `validate-skill-md` lint, `check-ai-models` freshness. Mostly the domain of `feat/write-unit-tests`; the harness only *depends* on this passing.

- **L1 — Install/bootstrap smoke** *(no model or one cheap model, seconds)*
  Run the CLI against a scratch project, assert vendor dirs + skills land, `uninstall` leaves the tree byte-clean (only touches marker-tagged artifacts). Optionally run `/vinta-bootstrap-ai-tools` with a small model and assert the generated layout is schema-valid — this is the deterministic half of S0.

- **L2 — Agentic scenario E2E** *(real models, minutes, paid)*
  The core of this plan: S0–S4 driven by live agents across the matrix, with outcome + git-shape grading and telemetry capture.

---

## 4. Fixture / template projects

Scenarios need realistic, **seeded** repos so runs are reproducible. The primary fixture is a real healthcare app on the stack Vinta actually ships, so the harness exercises the workflows on representative code — not a toy.

```
tests/e2e/fixtures/
  medplum-provider/    # PRIMARY — React + Vite + TypeScript on @medplum/core / @medplum/react,
                       #   React Router, Mantine; tests via Vitest + MockClient.
                       #   Vendored from medplum/examples/medplum-provider, pinned to a commit.
  node-ts-cli/         # (later) a small non-Medplum TS CLI — proves stack-agnosticism (Phase 3)
  (add stacks as coverage grows)
```

**Why `medplum-provider`.** Vinta's current focus is Medplum-based healthcare apps, so the initial fixture should be the [medplum-provider example](https://github.com/medplum/medplum/tree/main/examples/medplum-provider). It's a real app, and — crucially for this harness — its test suite runs **fully offline against `MockClient`** (an in-memory FHIR store), so the outcome grader ("app-tests-pass") needs **no live Medplum server**. This repo already ships a Medplum test pack (`write-unit-test-packs/stacks/medplum.md` + the `test.globalSetup.ts` / `test.setup.ts` pair), so the fixture should adopt those exact conventions — the harness then also implicitly validates that the shipped Medplum pack produces passing tests.

Medplum-specific fixture requirements (from the pack):

- Wire the two Vitest setup files (`test.globalSetup.ts` indexing FHIR bundles once, `test.setup.ts` sharing the schema to workers) so `searchResources` filters work — otherwise filtered searches silently return nothing.
- Keep `@medplum/core`, `@medplum/definitions`, `@medplum/mock`, `@medplum/fhirtypes` on **matching versions** (a skew causes confusing index/search failures) — pin them in the vendored copy.
- Node ≥ 22.4 (or a `ws` dev dep) for the WebSocket polyfill `@medplum/core` v5 needs at module load.
- **Outcome verification is the Vitest suite, not a booted app.** The default app-tests-pass grader runs `vitest` against `MockClient` **offline** — no server, fast, deterministic — which is right for the common case and everything `MockClient` can assert.
  - **Optional live-stack path.** When a scenario genuinely needs server-only behavior (access policies, subscriptions, `$everything`, bot execution, GraphQL/transaction edge cases), the full Medplum stack can be brought up locally via Docker ([self-hosting guide](https://www.medplum.com/docs/self-hosting/running-full-medplum-stack-in-docker)) and the grader run as an **integration** check against it. Keep this **opt-in and off by default** — it's slower, needs Docker + seeding + auth, and adds nondeterminism. Reserve it for the few tasks whose contract the mock can't prove; unit-level scenarios stay on `MockClient`.

Each fixture ships **three committed states** (branches or sibling dirs) so the same base app drives all scenario families:

1. **`clean/`** — the app with *no* `ai-tools/`, `AGENTS.md`, or vendor dirs. Drives **S0 — Bootstrap**.
2. **`stale/`** — the app bootstrapped against an **older** `vinta-ai-workflows` version (deliberately behind current, so a real diff exists to apply). Drives **S1 — Sync**.
3. **`current/`** — the app bootstrapped against the **current** version, harness fully in place. Drives **S2–S4**.

Plus:

- A working app + green test suite at baseline (all three states).
- `fixture.json` — metadata: stack, run/test commands, per-state git refs, the version `stale/` was bootstrapped from.
- **Seeded task inputs** per scenario, each carrying its **canned answers** (§6). For `medplum-provider` these are healthcare/FHIR-flavored and unit-testable via `MockClient` (no server-only behavior — access policies, subscriptions, `$everything` — since those can't be asserted offline):
  - `tasks/feature.md` — a feature request + pre-answered interview responses (drives S2). E.g. "add a patient allergy panel that reads/writes `AllergyIntolerance` resources."
  - `tasks/bug.md` — a reproducible bug: a planted defect + a *failing* `MockClient` test that currently fails (drives S3). The planted bug is the ground truth the grader checks against. E.g. a resource written with the wrong field so an assertion on `patient.name[0].family` fails.
  - `tasks/script.md` — a one-off script request with a checkable side effect (drives S4). E.g. "emit a CSV of all `Observation` values for a patient," runnable against a seeded `MockClient` or fixture bundle.

Design rules: fixture states are frozen (tags/SHAs), each run operates on an **isolated copy** (git worktree or tmp clone — never mutate the fixture in place), and every task has a *machine-checkable* success signal so grading isn't purely subjective.

> **Maintenance note:** `stale/` must be periodically re-based to "current minus one meaningful change" so the sync scenario keeps exercising a real upgrade rather than a no-op. Cheapest to regenerate it from `clean/` by bootstrapping with a pinned older package version.

---

## 5. Scenario catalog

Each scenario is a declarative spec consumed by the runner. Every step carries **canned answers** so the agent never blocks on an interview question (§6):

```jsonc
// tests/e2e/scenarios/S2-feature.jsonc
{
  "id": "S2-feature",
  "fixture": "medplum-provider",
  "state": "current",           // clean | stale | current
  "steps": [
    { "invoke": "/create-spec",    "input": "tasks/feature.md", "answers": "tasks/feature.answers.md" },
    { "invoke": "/plan-feature",   "answers": "tasks/feature.answers.md" },
    { "invoke": "/implement-plan", "autonomous": true }
  ],
  "graders": ["artifacts-spec", "artifacts-plan", "app-tests-pass", "git-tree-healthy"],
  "budget": { "maxWallSec": 1800 }        // safety timeout, not a cost gate
}
```

**S0 — Bootstrap** *(state: clean)*. `install --tool <t>` → assert placement; `/vinta-bootstrap-ai-tools` (with canned answers to the bootstrap interview) → assert `AGENTS.md` + derived skills + sub-agents + per-vendor wiring exist and are schema-valid; `uninstall` → assert clean. Graders: deterministic file/schema checks + advisory LLM-judge on `AGENTS.md` relevance to the fixture's stack.

**S1 — Sync** *(state: stale)*. Run `/vinta-sync-ai-tools` against the older-version fixture. Graders: the harness files converge on what a current bootstrap produces (schema versions bumped, new foundation skills present, per-change apply gating honored), hand-tuned regions are **not** clobbered, and opt-outs stay sticky. This is the "sync actually upgrades correctly" check.

**S2 — Feature** *(state: current)*. create-spec → plan-feature → implement-plan. Graders: `*_SPEC.md` and `*_PLAN.md` exist with required sections (schema/section-presence check), the app's test suite passes with the new behavior, and the git tree is healthy (§7).

**S3 — Bug** *(state: current)*. `/systematic-debugging` pointed at the failing test/repro. Graders: the previously-failing test now passes, no other tests regress, the fix touches the region of the planted bug (sanity guard against "deleted the test"), git tree healthy.

**S4 — One-off script** *(state: current)*. `/add-one-off-script` for a task with a checkable effect (e.g. "emit a CSV of X"). Graders: script exists in the expected location, executes non-interactively, produces the expected artifact/output, lands as its own commit (not mixed into app code).

---

## 6. Runner architecture

```
scenario.jsonc ──► Runner ──► VendorAdapter(vendor, model) ──► isolated fixture copy
                     │                                              │
                     │◄──────────── result envelope ────────────────┘
                     ▼
              Graders  +  Telemetry  ──►  results/<version>/<vendor>/<model>/<scenario>/run-N.json
```

**Isolation.** Each run gets a fresh worktree or tmp clone of the fixture; agents run with permissions pre-granted in a sandbox (headless can't answer prompts) — reuse the sandboxing already explored in `feat/filesystem-sandbox-for-worktrees`. Never run against a network-writable or shared checkout.

**VendorAdapter** normalizes the differences between CLIs behind one interface. **v1 targets Claude Code + Codex only**; Cursor/Copilot are deferred.

| Vendor | Headless invocation | Model flag | Usage output |
|---|---|---|---|
| Claude Code | `claude -p "<prompt>" --output-format json` | `--model` | `usage` (input/output/cache tokens, cost) in JSON |
| Codex | `codex exec "<prompt>"` (non-interactive) | config/flag | parse CLI/log usage |
| _Cursor / Copilot_ | _deferred_ | — | — |

Adapter contract: `run(scenarioStep, {model, cwd}) → { transcript, filesTouched, usage: {inTok, outTok, cacheTok, costUsd}, wallSec, exitCode }`. Skills are invoked by putting `/skill-name` (or the natural-language trigger) in the prompt. Autonomous multi-phase steps (implement-plan) run to completion unattended; the adapter enforces the per-scenario timeout and hard-stops runaways.

**Canned answers (mandatory for headless).** Our skills *interview* the user (create-spec, plan-feature, bootstrap all ask questions), and a headless agent that hits an unanswered question stalls or, worse, invents answers. So each scenario step supplies an `answers` file whose contents are injected into the prompt as *"here are the answers to every question you would ask; do not ask for anything else — if something is genuinely missing, state the assumption and proceed."* Two practical implications:

- Answer files must be **kept in sync** with the interview each skill actually runs — a lint/grader can flag a run where the agent still asked a question (detectable in the transcript), so drift surfaces instead of silently degrading the run.
- The answer file *is* part of the fixture ground truth: graders can check the produced spec/plan against what the answers stipulated.

**Individual runnability.** The runner is a CLI with filters so any subset runs on its own — e.g. `run-e2e --scenario S3-bug --vendor claude-code --model claude-opus-4-8 --fixture medplum-provider --runs 1`. No filter runs the full matrix. This is a first-class requirement, not an afterthought: the common case is running *one* scenario against *one* model to check a specific change.

**Determinism strategy.** LLM output varies, so: run each (scenario × model × vendor) **N times** (start N=3), report **pass-rate + token variance** rather than a single boolean; pin model IDs; freeze fixtures; keep graders tolerant of surface variation.

---

## 7. Graders

Two tiers, combined per scenario:

**Deterministic (authoritative).**
- *Artifact presence & schema*: spec/plan files exist with required sections; generated config/sub-agents validate against `schemas/*.schema.json`.
- *Outcome*: run the fixture's `test` command → all pass; run S4's script → expected artifact appears; S3's target test flips red→green with no new failures.
- *Git-tree-healthy* (the "commit tree looks healthy" check): assert against invariants —
  - stacked phase branches exist where expected (`plan/<feature>/phase-N`) and descend from the right base (guard the bug fixed in `fix/stack-branches-base-resolution`);
  - commit messages match the conventional-commit regex; commits are logically scoped (no 2000-line "WIP", no mixing script + feature);
  - working tree clean, no conflict markers, no committed secrets/fixture noise;
  - tracking file updated per phase.
  Implement as a `git log`/`git rev-list`/porcelain-parsing library so it's fast and CI-friendly.

**LLM-judge (advisory, for fuzzy quality).** A rubric-scored grader for things regex can't judge: does `AGENTS.md` reflect *this* stack? Is the spec faithful to the request? Is the fix a real fix vs. a hack? Use a fixed judge model, structured rubric output, and treat scores as **advisory/trend signal**, not gate — to avoid non-determinism in the judge masking real regressions. Deterministic graders decide pass/fail; the judge adds a quality dimension to the report.

A scenario **passes** when all its deterministic graders pass. The report additionally carries judge scores and telemetry.

---

## 8. Telemetry & token benchmarking

Every run emits a normalized record:

```jsonc
{
  "pkgVersion": "0.3.0",
  "gitSha": "<harness commit>",
  "vendor": "claude-code",
  "model": "claude-opus-4-8",
  "scenario": "S2-feature",
  "run": 1,
  "pass": true,
  "graders": { "app-tests-pass": true, "git-tree-healthy": true },
  "judge": { "spec-fidelity": 4.5 },
  "usage": { "inTok": 812000, "outTok": 41000, "cacheTok": 600000, "costUsd": 3.21 },
  "wallSec": 742,
  "steps": [ /* per-skill usage breakdown */ ]
}
```

- **Per-step breakdown** (usage attributed to create-spec vs plan-feature vs implement-plan) so we see *where* tokens go, not just a total.
- **Baselines**: keep the aggregated results for each released version under `tests/e2e/baselines/<version>.json`. A run compares current vs. the previous baseline and **flags regressions**: pass-rate drop, or token/cost increase beyond a threshold (e.g. >20% on a scenario) — the "benchmarking between versions" goal.
- **Aggregation**: mean/median/p95 tokens per scenario across the N runs, plus variance, so a noisy model is visible.

---

## 9. Reporting

- **Machine**: `results/<version>/…/run-N.json` (raw) + a rolled-up `summary.json`.
- **Human**: a generated `REPORT.md` (or an Artifact) with the comparison matrix —

  | Scenario | Vendor/Model | Pass-rate | Median tokens | Cost | Δ vs baseline |
  |---|---|---|---|---|---|

  plus a per-scenario drill-down and links to failing transcripts.
- **Regression signal**: non-zero exit / annotation when pass-rate or cost crosses thresholds vs. baseline.

---

## 10. Proposed layout

```
tests/e2e/
  fixtures/            # frozen seed projects (clean/stale/current states + task inputs)
  scenarios/           # S0–S4 declarative specs
  runner/              # runner CLI + VendorAdapters + isolation
  graders/             # deterministic graders (git-tree, schema, outcome, sync-convergence) + judge
  telemetry/           # usage normalization, baseline diff
  baselines/           # per-version aggregated results (committed)
  report/              # REPORT.md generator
  README.md
results/                # gitignored raw run output
```

---

## 11. Execution & cost control

L2 is **manual and human-triggered** — there is **no automatic cron/nightly** run. It executes when a human decides to: typically before a release, or to investigate a specific change. Aligns with `feat/make-e2e-tests-opt-in`.

- **How it runs**: locally via the runner CLI (§6), or a `workflow_dispatch`-only CI job where the operator picks the scenario / vendor / model subset. Never on push, PR-open, schedule, or label — a human always initiates.
- **Individual runnability first**: the default operation is one scenario × one model (see the CLI in §6), *not* the full matrix. The full matrix is an explicit, deliberate invocation (e.g. a pre-release sweep).
- **Cost**: not the primary constraint. Keep only a per-scenario `maxWallSec` **safety timeout** (kill runaways) — not a cost gate. `--runs` defaults to 1; bump it when you want a pass-rate signal.
- **Secrets**: per-vendor API keys supplied by the operator (local env) or as CI secrets for the dispatch job; a vendor without a key is reported **skipped**, never passed.
- L0/L1 (free, deterministic) stay on every PR; only L2 is gated behind manual invocation.

---

## 12. Phased implementation roadmap

- **Phase 0 — Codex usage spike (de-risk before building the Codex adapter).**
  A small, throwaway investigation — not wired into the harness — to answer whether Codex can be driven the way the runner needs, and how its telemetry is exposed. Deliverable: a short findings note that either unblocks the Phase 3 Codex adapter or scopes a workaround. Check:
  - **Skill invocation** — does `codex exec "/skill-name …"` (or the natural-language trigger) reliably fire a shipped `/skill`, or does Codex need the skill body inlined into the prompt?
  - **Unattended multi-phase run** — can `implement-plan` run to completion non-interactively (no mid-run prompts), respecting the canned-answers convention (§6)?
  - **Token/cost reporting** — where does `codex exec` surface per-run usage (input/output/cache tokens, cost)? stdout JSON, a log file, an API, or not at all? This decides whether the telemetry record (§8) can be populated for Codex or needs estimation.
  - **Model selection + permissions** — how to pin the model and pre-grant filesystem permissions in the sandbox (§6 isolation).
  Do the same quick check for Claude Code first (its JSON `usage` is known-good) as the reference, then compare. If Codex can't report usage, decide: token-count estimation, a proxy that meters the API, or mark Codex telemetry as best-effort.

- **Phase 1 — Foundation (deterministic, no paid calls).**
  The `medplum-provider` fixture (vendored + pinned) with all three states (`clean`/`stale`/`current`) + task inputs and **canned-answer files**, wired to the Medplum test pack (`MockClient` + the two Vitest setup files). Deterministic graders (schema, app-tests via offline Vitest, **git-tree-healthy**, sync-convergence). Runner CLI skeleton with `--scenario/--vendor/--model` filtering. L1 install/uninstall smoke. Proves grading + isolation + individual-runnability without spending on models.

- **Phase 2 — Single-vendor agentic loop.**
  Claude Code adapter (headless JSON, richest usage data). Wire S0–S4 end-to-end for one model, including canned-answer injection + a transcript check that the agent never asked an unanswered question. Telemetry capture + per-step breakdown. First real REPORT.md.

- **Phase 3 — Second vendor + matrix.**
  Add the Codex adapter and 2–3 models per vendor. `--runs N` for pass-rate + variance. Second fixture (`node-ts-cli`) to prove stack-agnosticism.

- **Phase 4 — Benchmarking.**
  Baseline capture per release, version-diff regression flags, advisory LLM-judge quality dimension, `workflow_dispatch`-only CI job for pre-release sweeps.

---

## 13. Resolved decisions

Locked in from review:

1. **Vendors** — Claude Code + Codex for v1. Cursor/Copilot deferred.
2. **Headless invocation** — every skill call ships **canned answers** injected into the prompt so the agent never asks anything mid-run (§6); a transcript grader flags any run where it did.
3. **Bug workflow** — S3 uses `/systematic-debugging`.
4. **Fixture states** — all three families are covered as distinct scenarios: **S0** bootstrap on a clean repo, **S1** sync on a stale/pre-configured repo, **S2–S4** skills on a current-harness repo (§4/§5).
5. **Judge gating** — LLM-judge stays **strictly advisory**; deterministic graders alone decide pass/fail.
6. **Execution** — **manual, human-triggered only**, no cron. Cost is secondary; human control over *when* is the requirement. Every scenario is **runnable individually** via runner-CLI filters (§6, §11).

## 14. Remaining open questions

1. **Codex headless parity + usage reporting** — confirm `codex exec` can trigger a `/skill`, run an unattended multi-phase `implement-plan`, and where/whether it reports per-run token usage. Resolved by the **Phase 0 spike** (§12) before the Codex adapter is built.
2. **Sync-convergence oracle** — what exactly does "sync upgraded correctly" assert against? Proposed: diff the synced `stale/` fixture against a freshly-bootstrapped `current/` and require the harness-managed files to match (ignoring intentionally hand-tuned/opt-out regions). Needs a precise ignore-list.
3. **`stale/` maintenance cadence** — how far behind current should `stale/` sit, and who regenerates it each release so S1 keeps testing a real upgrade (§4 maintenance note).
