---
name: thermo-nuclear-review-loop
description: Iteratively review and fix a commit, branch, ref, range, current change set, or historical feature until an independent reviewer explicitly approves it under a strict code-quality standard. Use for a thermo-nuclear review loop, strict review/fix cycles, or when a change must survive an adversarial reviewer without growing defensive code.
metadata:
  version: "3"
---

# Thermo-Nuclear Review Loop v3

You are the **fixer**: the agent running this skill in the host session (Claude Code or Codex). You spawn one **reviewer**, independently verify its findings, fix the justified ones, and repeat until it explicitly approves. There is no separate fixer agent.

Remedies are your call. Scope is the human's. When a finding needs the human to decide whether a scenario matters at all, the **gate** sends that question to them instead of letting either agent assume the answer.

## Establish the scope

1. Read the repository instructions (`AGENTS.md`, `CLAUDE.md`, rules, README).
2. Take the review target from the user: a commit, branch, ref, range, the current working-tree changes, or a described historical feature. Without a target, ask one question and wait. Ask for the original request, ticket, or prompt that produced the change when one exists; it is the **stated requirement**, and the reviewer receives it verbatim.
3. Resolve the baseline: a commit's parent, a branch's merge base, the explicit range, the repository baseline for current changes, or the commits that introduced a historical feature. Trace a historical feature into the current tree and edit the current tree.
4. Inspect status before editing. Preserve unrelated user changes and generated artifacts. If the tree already holds unrelated uncommitted changes, the loop runs uncommitted (see Commit).
5. Record `git diff --shortstat <baseline>` for the scope. The final report compares against it.

If the ref cannot be resolved or the scope is ambiguous, stop and ask.

## Spawn the reviewer

**Model**: an Opus-like model, meaning the highest or second-highest model on the default plan for that agent (Claude: Opus; Codex: the top or second reasoning model). Name the tier, never a specific model id.

**Reasoning effort**: a Claude reviewer runs at its highest effort. A Codex reviewer runs at `high` or lower throughout the loop; configure that explicitly when spawning a subagent or starting a cross-host session, including when the host uses a higher effort setting.

**Host**: when the reviewer runs on the same agent as the host, spawn a subagent with a stable name (`tnr-reviewer`) and keep it for the whole loop so later passes reuse its context. When the reviewer runs on a different agent, use `acpx` with a named persistent session (see Host notes). The user chooses; default to the same host.

**Brief**: before spawning, check for a project-root `REVIEW.md`. If it exists, the reviewer reads only that file as its standard. Otherwise the reviewer reads the Review Standard section of this skill: point at this file's path, or paste the section when the reviewer is a different agent that cannot see this skill.

**Access**: the reviewer may read and run commands (tests, `git blame`, greps, scratch repos outside the tree) but makes no edits. Record `git rev-parse HEAD` and `git status --porcelain` before each pass and compare after. Any change made by the reviewer stops the loop: report it and ask the user what to do with those changes.

Prompt template:

> Read `<REVIEW.md or Review Standard path/paste>` and apply it to `<resolved scope>` in the current working tree, compared against `<baseline>`. The stated requirement is: `<original request verbatim, or "none recorded">`. Be ambitious about structural simplification and code-judo opportunities. Verify every claim against code, history, tests, and repository instructions; behavior claims need a file:line citation, not an inference from naming. Do not edit. Return concrete blockers with evidence and remedies, or explicitly approve if the implementation meets the standard. Open your reply with a line naming the standard you applied (`REVIEW.md` or `Review Standard`) and quoting its first and last lines verbatim.

Check that the verdict's opening line names the right standard and quotes lines that exist in it. A verdict without that line means the reviewer did not read the standard: ask it to read the standard and resend before acting on any finding.

Wait for the verdict; the loop cannot proceed without it. If the verdict does not arrive as a message, check your inbox and ask the reviewer to resend before doing anything else.

## Verify before fixing

Reviewer output is a list of leads, not orders. For each finding:

1. Reproduce or prove the claimed behavior or design problem from code and tests. A scratch repository outside the tree is fine for git behavior.
2. Check repository invariants, intended behavior, historical rationale, and current callers.
3. Decide: correct, partially correct, or unsupported. Unsupported findings, pre-existing issues outside the scope, and findings that fail the evidence bar in the Review Standard are rejected; keep the concrete counter-evidence for the next reviewer prompt and the final report.

**Choosing a remedy is your job.** When a verified defect or structural problem has several remedies, choose the one that makes the bad state unreachable for every consumer of the data (a type, an exact comparison, a key derived by construction) and then the simplest. Ask what downstream code assumes about the data and pick the rule that guarantees exactly that. Do not ask the human to pick a mechanism.

**Keep the code's promises.** When docs, names, or UI copy promise more than the code does, the default fix is to make the code keep the promise. Weaken the text instead only when the human has settled that the scenario is out of scope (gate trigger 3).

**Assumptions belong to the project or the human.** Before adding machinery for a rare case, look for the project's existing pattern in README, `AGENTS.md`, `CLAUDE.md`, rules, and neighboring code. The existing pattern is the default answer. No pattern means gate, not assume. Typical assumptions (examples; non-functional requirements and rare functional edge cases produce more): backward compatibility with in-flight data or old clients, zero-downtime or online migration, concurrent writers, retries and idempotency, partial-failure recovery, multi-tenant isolation, scale beyond current volume, offline or network-loss handling, locale and timezone, permission tiers beyond those in the code.

## Run the gate

A finding goes to the human, not to the fix, when it depends on a decision that is theirs:

1. handling for a scenario no current caller, type, or data can reach;
2. a defensive check on data already typed or validated upstream;
3. a product or requirements ambiguity: the docs, tests, and code disagree about what is wanted, and none of them is clearly the bug; or the stated requirement names a mechanism that does not achieve its own goal, so keeping the code correct means departing from the requirement's words;
4. a destructive or irreversible operation in scope (deletes, migrations, production-touching scripts).

Fix every other justified finding first. Then, once per iteration, put the gate items to the user in one batch: each with the finding, the evidence, the reviewer's recommendation in its own words, and yours. The default recommendation for triggers 1 and 2 is "reject the finding". Use the host's structured question tool when it has one; otherwise end the turn with the questions in plain text. Wait for the answers.

Record each answer as a **settled decision**: what was asked, what was decided, and the date. Settled decisions go into every later reviewer prompt. The reviewer may re-raise one only with new evidence; you decide whether the evidence changes the answer.

Gate interviews do not count as iterations.

## Implement and verify

Address all verified findings as one coherent design change per iteration. Prefer changes that delete concepts, branches, duplicated state, and boundary leaks. Preserve externally intended behavior unless the finding proves that behavior is incorrect; when a fix changes documented behavior, change the documentation, config names, and UI copy in the same commit so they say exactly what the code checks.

**Poka-yoke over defense.** When a fix needs a guarantee, choose the highest rung available:

1. make the illegal state unrepresentable in types (exhaustive unions, enums over strings, non-optional fields, keys derived by construction);
2. a static check (type strictness, a lint rule, a schema);
3. a scripted check (a test, a CI script, a git hook);
4. one assertion at the trust boundary where untrusted data enters (user input, network, files, environment);
5. a runtime check inside the flow, the last resort.

Adding a lint rule, tightening typing, or adding a script counts as a fix and needs no gate. Internal callers are trusted: code past the boundary works on typed data without re-validating it.

**Cohesion over extraction.** Judge every split by the cognitive load it removes, not by line count. A new file or module is justified when a reader would otherwise hold unrelated concerns at once. Splitting code that changes together is a regression. A file passing 1000 lines is a smell to weigh against cohesion, not an automatic blocker. Name the reason for each new file in the iteration report.

**Tests.** Add a test only when a fix changes behavior or a verified bug was found. Strengthen an existing test before adding a file. Delete tests a simplification made redundant. Tests for hypothetical scenarios are gate items, not fixes. A test must run the rule on the same inputs the real system feeds it, entering through the real routes or commands rather than seeding state directly; a fake that carries the rule's answer in a separate table tests wiring, not the rule. A rule that migrates, re-keys, or carries persisted state forward is tested through two consecutive transitions, since the first move is where every such rule works and the second is where it breaks.

**Verify.** Run the repository's build and test commands, plus focused checks the affected code warrants (sanitizers, concurrency checks, format and lint). Separate environment-only failures from regressions; report both.

**Commit.** One commit per iteration on the current branch, message naming the iteration and the findings it addresses, so each cycle stays reviewable. Run uncommitted only if the user asked for that or the tree held unrelated changes at the start. Never push or publish unless the user asks.

**Iteration report** (to the user, every iteration): findings fixed, gated, rejected with counter-evidence; the reason for each new file; verification results.

## Re-review

Send the same reviewer the iteration commit hash (or the diff when uncommitted), the settled decisions, and the rejected findings with counter-evidence. Summarize what you did, but require it to inspect the actual diff rather than trust the summary, and to reapply the full standard with the pass-two rules from the Review Standard.

Count each pass that returns blockers as one unsuccessful iteration. After four, pause before the fifth and tell the user:

- what changed across the four cycles;
- which blockers remain, and which of them you verified, disputed, or consider diminishing returns;
- your own view of whether more work is worth it;
- the risks that remain.

Ask whether to continue. Yes resets the counter for four more. No ends the loop with the reviewer unapproved. Silence is not permission.

The loop ends successfully only when the reviewer explicitly approves. Passing tests are not approval. If progress requires the user's authority, missing dependencies, or a scope expansion, report the blocker and ask rather than lowering the bar.

## Report the outcome

- structural improvements made;
- findings rejected and why, and settled decisions taken;
- size: the scope's `--shortstat` at the start and at the end, and the reason for any new file;
- verification performed and environment-only failures;
- the final reviewer verdict;
- iteration commits created (or why the tree stayed uncommitted), and that nothing was pushed.

## Review Standard

The reviewer's brief when the project has no `REVIEW.md`. Self-contained: a reviewer may read only this section.

### Stance

Perform a deep code quality audit of the scope in the current working tree against its baseline. Rethink how to structure the change to meaningfully improve code quality without changing intended behavior. Work to improve abstractions and modularity, reduce spaghetti, and improve succinctness and legibility. Be ambitious: assume there is often a **code judo** move, a reframing that uses the existing architecture so that whole branches, helpers, modes, or layers disappear. Prefer the solution that makes the code feel inevitable in hindsight. If you see a path to delete complexity rather than rearrange it, push hard for that path. Verify every claim against code, history, tests, and repository instructions. You make no edits. Be direct and demanding; state major problems as major problems.

### Evidence bar

No evidence, no finding. Every finding answers four questions: Can I cite the exact file and line? Can I describe the failure mode or the maintainability cost concretely? Have I read the surrounding context and callers? Is the severity defensible to a senior engineer? Attach a confidence from 0 to 100 and drop anything under 80.

These are not findings: pre-existing issues outside the scope, issues a linter or type checker already catches, nits a senior engineer would skip, generic input validation without a proven impact, paths no current caller or data can reach, denial-of-service or rate-limiting concerns without a threat model, and handling for scenarios the project's own patterns do not handle elsewhere. If a scenario is genuinely undecided, report it as a **question for the human** with your recommendation, separate from blockers.

### What to review, in priority order

1. **Correctness and security.** Logic errors, broken edge cases that current inputs can reach, injection, missing or weakened authorization, unscoped queries in multi-tenant code, secrets or PII in logs and error messages, unsafe deserialization, race conditions with a concrete interleaving. Treat any logic alteration as high risk until shown otherwise, refactors included. Count callers to size the blast radius; flag unchanged callers that depend on changed behavior; `git blame` removed checks before accepting their removal.
2. **Consumer invariants.** For every rule, comparison, or key the change introduces, name what downstream code assumes about the data (positions, identity, ordering, presence) and check that the rule guarantees exactly that. A rule that is weaker than its consumers' assumption is a blocker, not a question for the human, even when every listed case passes; state the consumer, the assumption, and the input that violates it. When the change widens what a status, flag, or enum value means (a "ready" that now also covers an older commit), list every reader of that value with file:line in the verdict and say for each whether it still holds; a reader written for the old meaning is a blocker, and a reader you did not list is a gap in your review.
3. **Destructive or irreversible operations.** Hard deletes where the project uses soft deletes, migrations without a rollback step, scripts that touch production without a dry run, non-atomic multi-step updates that can leave state half-applied, persisted fields whose meaning changes without a migration or a note. For any rule that migrates, re-keys, or carries persisted state forward, walk two consecutive transitions and state what the second one reads; a rule verified on one move only is unverified.
4. **Drift from project conventions and duplicated judgment.** Bespoke helpers where a canonical one exists, re-implemented framework primitives, a decision (parse, validate, classify) answered in two places, domain-language drift from the project's own terms (`CONTEXT.md` or its equivalent), logic in the wrong layer or package, hand-edited generated artifacts.
5. **Structural regressions and missed simplifications.** Ad-hoc conditionals bolted onto unrelated flows, one-off booleans and nullable modes, feature logic leaking into shared paths, thin wrappers and pass-through helpers, magic generic mechanisms hiding simple data shapes, contract fields repeating data already exposed, refactors that move complexity without deleting it. Also the reverse: splits that separate code which changes together, trading cohesion for file count.
6. **Hot-path cost.** List every path that reaches the changed code with file:line: page load, poll, each write and per-item action (a click, a toggle, a row), each command. For each, say what subprocess, network or full-recomputation work it does per call now and what it did before. A path you did not list is a gap in your review. Work added where the previous code used cached or in-memory data is a finding; name the path and the multiplier.
7. **Text that outruns the code.** Docs, config names, changelog lines, comments, and UI copy must claim exactly what the code checks. A setting named for merges guarding a rule that ignores merges, or a page note asserting something the rule never verifies, is a finding. The remedy to propose is the code keeping the promise; propose weakening the text only when the promise is out of scope, and say so.
8. **Brittle or flaky tests.** Timing sleeps, order dependence, real network or clock, assertions rewritten to match new behavior instead of the requirement, tests deleted or skipped, coverage or lint thresholds lowered, tests that restate the implementation or pass vacuously. A fake must derive the rule's answer from the same inputs the real system uses; a fake with a second table that the test sets to the desired answer, or a fixture describing a state the real system cannot produce, is a finding. A test of persisted state that seeds the state directly instead of entering through the real route or command hides the bugs that live in the writer.
9. **Boundary and type contracts.** Unnecessary optionality, `any`, `unknown`, casts, silent fallbacks that degrade to a simpler behavior without logging, validation duplicated past the trust boundary, ad-hoc object shapes where a typed model would remove branches.
10. **Legibility.** Only after the above, and only when a senior engineer would stop on it.

Also check **requirement fidelity**: the code does what was asked, not something adjacent, and dependency changes are intentional.

### Preferred remedies

Delete a layer of indirection rather than polishing it. Reframe the state model so conditionals disappear instead of getting centralized. Change the ownership boundary so the feature becomes a natural extension of an existing abstraction. Make the bad state unrepresentable (an exact comparison, a key derived by construction, a typed model) rather than detected. Reuse the canonical helper. Move logic to the layer that owns the concept. Do not be satisfied with "maybe rename this" when the real issue is structural, nor with a cleaner version of the same messy idea when a much simpler idea is visible.

### Output

Prioritized findings, each with file:line evidence, failure mode or cost, remedy, confidence. Then questions for the human. Then, if nothing blocks, explicit approval in one sentence. Fewer high-conviction findings beat a long list.

### Pass two and later

Report blockers only. Every new blocker states why the previous pass did not raise it: a regression from the fix, or a concrete miss. Findings equivalent to ones already approved or settled by the human are dropped unless you bring new evidence, which you name. When a fix changed a rule, re-read the fakes and fixtures that feed its tests and the text that describes it: fakes must derive answers from real inputs, fixtures must describe states the real system produces, and docs, names, and UI copy must match the new rule. Approve when the bar is met; the loop has no other exit.

### Approval bar

Approve when the scope has: no verified correctness or security defect, no rule weaker than its consumers assume, no unguarded destructive path, no duplicated judgment or drift the project's patterns forbid, no structural regression or plausible code-judo move left on the table, no hot-path regression, no text claiming more than the code checks, no brittle test or answer-carrying fake, and no boundary churn obscuring the contract. Behavior that merely works is not enough.

## Under an orchestrator

An orchestrator such as vinta-ai-maestro can run this skill as a phase's review step, on the implementer's own session. Its prompt then states the scope and baseline, the stated requirement, the iteration budget (which replaces the pause after four unsuccessful iterations), how gate questions reach the human (a `NEEDS_INPUT` report that ends the turn, rather than the host's question tool), and the `VERDICT:` line the turn closes with. Where the orchestrator's prompt differs from this skill, the prompt wins.

## Host notes

- **Claude Code host, same-host reviewer**: `Agent` tool with `model` set to the Opus-like tier, `name: tnr-reviewer`, `run_in_background: false`; continue it with `SendMessage` on later passes. Ask gate questions with `AskUserQuestion`.
- **Codex host, same-host reviewer**: Codex has built-in subagents; spawn one, keep its handle, and message it on later passes. Its structured question tool works only in Plan mode, so ask gate questions by ending the turn in plain text. Under the default workspace-write sandbox a commit may trigger an approval prompt because `.git` can be protected; accept it, the commit is part of the loop.
- **Cross-host reviewer via acpx**: create one named session and reuse it every pass so context persists; deny ACP writes while keeping reads and terminal:

    ```bash
    acpx --approve-reads --non-interactive-permissions deny <agent> sessions ensure --name tnr-reviewer
    acpx --approve-reads --non-interactive-permissions deny <agent> -s tnr-reviewer -f review-prompt.md
    ```

    `<agent>` is `claude` or `codex`. Use `--model` to request the Opus-like tier when the adapter advertises models (Codex also takes `--config-option reasoning_effort=high`). From a Codex host, acpx needs network, which the default sandbox blocks: expect one approval prompt. Paste the Review Standard (or `REVIEW.md`) into the prompt file when the reviewer agent cannot read this skill. The tree-integrity check in Spawn the reviewer is the real guard; the flags reduce the chance of needing it.
