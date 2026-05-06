---
name: systematic-debugging
description: Use when debugging any defect, test failure, regression, performance issue, or unexpected behavior in {{PROJECT_NAME}} ({{STACK_SUMMARY}}). Enforces a root-cause-first investigation flow before any code change is proposed. Pulls evidence from the project's observability MCP tools ({{OBSERVABILITY_MCP_LIST}}) before forming a hypothesis. Cites the project's real test, lint, and type-check commands so reproduction steps are concrete.
---

# Systematic debugging

Random fixes mask root causes and grow new bugs on top of old ones. This skill drives debugging through four ordered phases. Each phase has an exit gate; you may not advance until the gate is satisfied.

## Iron law

> **No code change until the root cause is identified and named.**

A change that makes the symptom go away without an explanation of *why the symptom existed* is a guess, not a fix. Guesses do not ship.

## When to invoke

- Test failure (red unit, scoped, or e2e suite).
- Production incident or alert page.
- Unexpected behaviour reported by a user, QA, or another engineer.
- Performance regression (latency / throughput / memory).
- Build, type-check, lint, or deploy failure that is not obviously a typo.
- A previous fix did not work and you are tempted to "try one more thing".

The pressure to skip this skill is highest exactly when it is most needed. Treat "we don't have time for the process" as a signal to slow down, not speed up.

## Phase 0 — Observability sweep (MCP servers)

Before reading code, pull the evidence the platform already has. The project lists these observability MCP servers as available: **{{OBSERVABILITY_MCP_LIST}}**.

### Local-only escape hatch (per-run opt-out)

If the user passes `local-only` to this skill (e.g. `/systematic-debugging local-only — flaky test in test_foo.py`), or if the bug is obviously local — a unit test that has never run in CI, a build error on an unpushed branch, a typo — skip the entire MCP preflight + categories block. Open the Phase 0 evidence note with the line *"local-only debug at user request — no platform evidence consulted"* and continue to Phase 1. This bypass does **not** touch the cache.

If the user did not opt out, run the cached preflight below.

### Preflight — cached, with hard-stop on failure

State lives at `.vinta-ai-workflows/cache.yaml` (gitignored, schema [`mcp-preflight-cache.v1`](../../../../schemas/mcp-preflight-cache.v1.schema.json)). The cache has no TTL — `ok` entries stay valid until something proves them wrong. A failed MCP call later in this session flips the offending server to `dirty`, forcing a fresh preflight on the next debug run.

For every server in `{{OBSERVABILITY_MCP_LIST}}`:

1. **Read** the cache entry for the server.
2. **Cache hit (`status: ok`)** → log one line `cache hit: <server> (<tools_count> tools, verified <relative-time> ago)` and skip to "Discover the right calls" below for this server. No tool listing, no extra calls.
3. **Cache miss / `dirty` / `missing` / `auth-error` / `unreachable`** → run a fresh preflight:
   - Check that an MCP server with that identifier is connected. If not, **stop and tell the user verbatim**: *"systematic-debugging requires the `<name>` MCP server, but it is not connected in this session. Connect it, run with `local-only`, or remove it from `skills.systematic-debugging.observability_mcp_servers` in `.vinta-ai-workflows.yaml`."* Write `status: missing`, `error_message: "not connected"` to the cache and stop.
   - Confirm at least one tool from that server can be invoked. Auth error / expired token / missing API key → same hard-stop, with the upstream error message quoted verbatim. Cache as `status: auth-error`, `error_message: "<verbatim>"`.
   - On success: write `status: ok`, `verified_at: <now>`, `tools_count: <n>` to the cache.
4. Do **not** silently fall back to a different server, to local logs, or to "investigate without observability". A configured-but-broken server is a configuration bug; surface it. The user can choose to re-run with `local-only` once they see the failure.

If `{{OBSERVABILITY_MCP_LIST}}` is `none configured`, the cache is irrelevant — skip the preflight and use the no-tools fallback rendered below. Warn once if the bug appears production-only: *"This bug looks production-only and no observability MCP server is configured. Re-run with `local-only` to silence this warning, or wire up an observability MCP server first."*

### Mid-session invalidation (mark dirty)

Any later MCP call that fails with auth, connection, or transport error → patch the cache entry: `status: dirty`, `verified_at: <now>`, `error_message: "<verbatim>"`, optionally `marked_dirty_during: "<phase / plan / session id>"`. Continue the debug session using whatever evidence is already collected; do not re-preflight inside the same session. The next debug run will see `dirty` and re-preflight just that server.

A successful tool call against a server that's currently marked anything other than `ok` is allowed to flip it back to `ok` — the server clearly recovered.

### Refresh the cache manually

- Force re-preflight everywhere: delete `.vinta-ai-workflows/cache.yaml`.
- Force re-preflight one server: edit the entry's `status` to `dirty` (or any non-ok value).
- Forget a server entirely: remove it from `skills.systematic-debugging.observability_mcp_servers` in `.vinta-ai-workflows.yaml` — the cache entry then becomes inert (no preflight, no warnings).

### Discover the right calls at runtime

**Do not assume tool names from training data — they go stale.** For each cache-hit server (and each server that just passed a fresh preflight), list the tools it exposes, then map them to the evidence categories below by reading their descriptions and parameter names. If a server claims to cover a category but no listed tool matches, ask the user before falling back to "no evidence available".

{{OBSERVABILITY_MCP_BLOCK}}

**Do not skip this phase because the bug "looks local".** A failing unit test on your machine and a 500 in production at the same hour is one incident, not two. The observability sweep is what reveals that.

## Phase 1 — Root cause investigation

Goal: state the cause in one sentence with a citation (file:line, log line, or trace span).

1. **Read the error completely.** Stack trace from bottom to top. Note every frame in our code — skip framework noise on the first pass, return to it only if our frames don't explain it.
2. **Reproduce locally.**
   - Unit / integration: `{{TEST_CMD}}`{{SCOPED_TEST_NOTE}}
   - Single failing test in isolation: `{{NEW_TEST_CMD_PATTERN}}`
   - Type / build gate: `{{BUILD_CMD}}`{{TYPECHECK_NOTE}}
   - Lint: `{{LINT_CMD}}`
   {{E2E_BLOCK}}
   If you cannot reproduce, gather more evidence (Phase 0 logs, traces, user repro steps). Do not propose a fix against a bug you cannot trigger.
3. **Bisect recent changes.** `git log --oneline {{DEFAULT_BRANCH}}..HEAD` plus `git log -p` on the suspect file. Check the deploy timeline from Phase 0 against commits.
4. **Trace data flow at component boundaries.** For every layer the bad value crosses (request → handler → service → store → response), log the value entering and the value leaving. Find the layer where the value changes shape unexpectedly. That layer holds the bug.
5. **Trace backward from the failure.** If the error is "got `undefined`", the question is not "why did this consumer crash" but "who produced `undefined` and why was that allowed to propagate".

Exit gate: write the cause as a single sentence — *"`OrderService.applyDiscount` returns `null` when the cart has zero items because the early-return at orders.ts:142 predates the empty-cart feature, and the caller at checkout.ts:88 forgot to handle null."* Vague causes ("something with discounts") fail this gate.

## Phase 2 — Pattern analysis

Goal: confirm the root cause by comparing against working code.

1. Find a sibling code path that does the *same kind of thing* and works. (Another service method, another handler, another reducer.)
2. Diff the working path against the broken one. Note every difference, even ones that "couldn't matter".
3. If the bug is in a library / framework integration, read the upstream reference implementation or docs end-to-end before continuing. Skim is not allowed.
4. List dependencies the broken path silently relies on (env var, feature flag, migration, cache warm-up). Verify each one is present in the failing environment.

Exit gate: you can name what the broken path is missing or doing differently, and show the working path as proof.

## Phase 3 — Hypothesis & test

Goal: a single hypothesis, a single failing test, no speculative changes.

1. State the hypothesis: *"If I change X to Y, the bug stops because Z."*
2. Write the failing test FIRST.
   - New test file: `{{NEW_TEST_CMD_PATTERN}}`
   - Scoped suite: `{{SCOPED_TEST_PATTERN}}`
   - The test must fail today for the same reason production fails. A test that fails for a different reason is a different bug.
3. Make the smallest possible change. One variable. No drive-by refactors. No "while I'm here".
4. Re-run the failing test. Did it go green? Re-run the scoped suite — did anything else go red?
5. If the test stays red, do **not** stack a second change on top. Return to Phase 1 with the new evidence (the test plus what it shows) and re-state the cause.

Exit gate: one new test, red before the change, green after, no other test newly red.

## Phase 4 — Implementation & verification

Goal: ship the fix at the right level of abstraction with the right safety net.

1. **Fix at the source, not the symptom.** If null leaks from a producer, fix the producer. Defensive null-checks at the consumer are an additional layer (see "defense in depth" below), not a replacement for the source fix.
2. **Defense in depth where the cost is low.** Validation at the boundary, an assertion in the producer, a typed return that forbids the bad shape — pick the layer the codebase already invests in. Don't sprinkle.
3. **Run the full local gate before pushing.**
   - `{{LINT_CMD}}`
   - `{{BUILD_CMD}}`
   - `{{TEST_CMD}}`{{SCOPED_TEST_NOTE}}
   {{E2E_OUTER_GATE_LINE}}
4. **Verify on the observability side after deploy.** The error fingerprint from Phase 0 should stop firing. If the platform supports it, mark the issue resolved in the source MCP tool so a regression re-opens it instead of creating a duplicate.
5. **Document if the fix is non-obvious.** A comment is justified only when the *why* would surprise the next reader — a hidden invariant, a workaround for a known upstream bug, a constraint not visible from the call site. Don't narrate the change.

## Stop conditions — count your attempts

If you reach **three failed fix attempts** on the same bug, the architecture is suspect, not the next line you were about to change. Stop and escalate:

- Re-read the original report. Has the symptom drifted as you patched things?
- Are the three attempts each fixing a different file? That is a sign the contract between layers is wrong, not any single layer.
- Bring a second engineer (human or another agent) to walk Phase 1 from scratch. Don't hand them your hypothesis — hand them the symptom.

A fourth attempt without architectural review is how week-long debugging sessions start.

## Red flags — return to Phase 1 immediately

You catch yourself thinking or typing any of:

- "Quick fix now, investigate later."
- "Let me try changing X and see if it works."
- "It's probably the cache / the build / a flaky test."
- "I don't fully understand this but this might work."
- "I'll add a try/catch around it."
- "I'll skip writing the test, the manual repro is enough."
- "Let me bundle this fix with the cleanup I was going to do anyway."

These are not debugging — they are guessing with extra steps. Stop and re-enter Phase 1.

## Reusable skills the orchestrator should chain

When this skill runs inside [implement-plan](../implement-plan/SKILL.md) (the inner / outer test loop), the implementer agent invokes systematic-debugging on every red gate and reports the Phase-1 cause in its report. The orchestrator never overrides the Iron Law — a phase that can't name the cause is not allowed to land.

For new test scaffolding, defer to the project's test conventions captured in [AGENTS.md](../../AGENTS.md). For env / config issues uncovered in Phase 0, route to the project's `add-env-var` skill if shipped (`{{PROJECT_SKILLS_LIST}}`).

## Verification checklist (apply before claiming a bug fixed)

1. Phase 0 evidence stored or linked in the PR description (trace id / issue link / dashboard URL).
2. Root cause stated in one sentence in the PR description.
3. New failing-then-passing test cited by file:line.
4. Full local gate green: `{{LINT_CMD}}` + `{{BUILD_CMD}}` + `{{TEST_CMD}}`{{E2E_OUTER_GATE_CHECKLIST}}.
5. Observability source updated post-deploy (issue resolved / alert acknowledged) so a recurrence pages instead of silently re-opening.
