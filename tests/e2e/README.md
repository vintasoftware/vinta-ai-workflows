# E2E testing & benchmarking harness

Drives **real agents** through the canonical vinta-ai-workflows skills against
seeded fixture projects, then grades the *outcome* (feature works, bug fixed,
script runs) and the *shape of the work* (git tree healthy, artifacts
schema-valid) across the **vendor × model matrix**, capturing token / cost /
wall-time telemetry per run.

See [`../../PLAN-e2e-testing-harness.md`](../../PLAN-e2e-testing-harness.md) for
the full design. This README is the operator's guide.

> **L2 is manual, human-triggered — never on a cron.** You run it before a
> release or to investigate a change. Every scenario is runnable individually,
> and every skill invocation is pre-answered so no run stalls on an interview.

## Layers

| Layer | What | Cost | When |
|---|---|---|---|
| **L0** | Package static tests (CLI unit, schema validation, `validate-skill-md`) | free | every PR |
| **L1** | Install/uninstall smoke (`l1/smoke.test.mjs`) | free | every PR |
| **L2** | Agentic scenario E2E (S0–S4, real models) | paid | manual |

## Quick start

```bash
# free — no models:
node tests/e2e/l1/smoke.test.mjs                 # L1 install/uninstall smoke
node tests/e2e/runner/run-e2e.mjs --list         # what's available
node tests/e2e/runner/run-e2e.mjs -s S2-feature -v mock --dry-run   # preview matrix
node tests/e2e/runner/run-e2e.mjs -s S2-feature -v mock             # self-test plumbing (mock adapter)

# paid — real agent (needs the fixture vendored + a vendor CLI/key):
node tests/e2e/fixtures/medplum-provider/vendor.mjs                 # one-time: build fixture states
node tests/e2e/runner/run-e2e.mjs -s S3-bug -v claude-code -m claude-opus-4-8 -n 1
```

No `--scenario`/`--vendor` filter ⇒ the **full matrix** (a deliberate pre-release
sweep). Individual runnability is the default operating mode.

## Runner CLI

```
run-e2e [filters] [options]

Filters:
  -s, --scenario <ids>   S0-bootstrap | S1-sync | S2-feature | S3-bug | S4-script
  -v, --vendor <names>   claude-code | codex | mock
  -m, --model <ids>      pin model(s); default per-vendor if omitted
  -f, --fixture <name>   restrict to scenarios using this fixture

Options:
  -n, --runs <N>         repeat each cell N times for a pass-rate signal (default 1)
      --judge <dims>     advisory LLM-judge dims (spec-fidelity, plan-quality, ...)
      --results-dir <d>  output root (default <repo>/results, gitignored)
      --keep             keep isolated fixture copies for debugging
      --dry-run          print the matrix; run nothing
      --list             list scenarios / vendors / graders
      --save-baseline    write this run's aggregate as the version baseline
      --no-fail-on-regression
```

A vendor whose CLI/key is missing is reported **skipped**, never passed.

## Scenarios (`scenarios/`)

| Id | State | Skills | Deterministic graders |
|---|---|---|---|
| **S0-bootstrap** | `clean` | `/vinta-bootstrap-ai-tools` | artifacts-bootstrap, git-tree-healthy |
| **S1-sync** | `stale` | `/vinta-sync-ai-tools` | sync-convergence, git-tree-healthy |
| **S2-feature** | `current` | create-spec → plan-feature → implement-plan | artifacts-spec/plan, app-tests-pass, git-tree-healthy |
| **S3-bug** | `current` | `/systematic-debugging` | bug-fixed, git-tree-healthy |
| **S4-script** | `current` | `/add-one-off-script` | script-output, git-tree-healthy |

`answers-lint` is applied implicitly to every scenario (flags a run where the
agent asked an unanswered question — i.e. the canned answers drifted).

## Graders (`graders/`)

Deterministic graders are **authoritative** (they gate pass/fail). The LLM-judge
(`--judge`) is **strictly advisory** — a quality/trend signal in the report,
never a gate. See `graders/index.mjs` for the registry.

## Telemetry & baselines

Each run writes `results/<version>/<vendor>/<model>/<scenario>/run-N.json`
(gitignored). Aggregates roll up into `results/<version>/summary.json` +
`REPORT.md`. `--save-baseline` freezes the aggregate under `baselines/<version>.json`
(committed); subsequent runs diff against the previous baseline and flag
pass-rate drops or >20% token/cost increases.

## Fixtures (`fixtures/`)

`medplum-provider` is the primary fixture — a real React + Vite + TS Medplum app
whose tests run **offline against `MockClient`**, so `app-tests-pass` needs no
live server. The app itself is **not committed** (it's large + external); build
its `clean` / `stale` / `current` states on demand:

```bash
node tests/e2e/fixtures/medplum-provider/vendor.mjs        # all three states
node tests/e2e/fixtures/medplum-provider/vendor.mjs --state clean
```

⚠ Before first vendoring, set `upstream.pinnedCommit` in
`fixtures/medplum-provider/fixture.json` to a real SHA.

Task inputs and their **canned answers** live in
`fixtures/medplum-provider/tasks/` and are part of the fixture ground truth.

## Status / roadmap

This is the deterministic **foundation + runner** (PLAN Phase 1 + the Phase 2
Claude Code adapter). Still open, per the PLAN:

- **Phase 0 spike** — confirm Codex headless parity + usage reporting (§12/§14).
  The Codex adapter is wired but usage is best-effort until the spike resolves.
- **Fixture app content** — the planted bug test, the feature scaffolding, and
  the seeded MockClient bundles are materialized by `vendor.mjs` + a first real
  bootstrap; the harness reports clearly when a state isn't vendored yet.
- **Second fixture** (`node-ts-cli`) and **multi-model matrix** — Phase 3.
- **Baseline capture per release** — Phase 4.
