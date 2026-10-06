<!-- Partial: review-loop — the thermo-nuclear review loop as a plan-execution conductor runs it over one phase. Included by review-phase. amend-plan and systematic-debugging reuse it by INVOKING review-phase (not by including this partial). The conductor running review-phase never edits code: the reviewer is one sub-agent, and the fixes are the phase's own implementer's. -->

<!-- block-begin: LOOP -->
Run the [thermo-nuclear-review-loop](ai-tools/skills/thermo-nuclear-review-loop/SKILL.md) skill over the phase diff. Read it before the first phase you review: it holds the loop's procedure, the gate for questions only a person can settle, and the Review Standard the reviewer applies.

The skill is written for one host session that both fixes the code and talks to the reviewer. A conductor cannot be that host as written: it never edits code, and a sub-agent cannot spawn sub-agents of its own, so the phase's implementer cannot run the loop either. The roles split three ways instead:

| The skill's role | Played by |
|---|---|
| **Host**: spawns the reviewer, relays between reviewer and fixer, runs the gate, counts iterations, asks the human | this skill, in the conductor's session |
| **Reviewer**: reads, runs commands, never edits, and approves or returns blockers | one sub-agent, spawned here at the [resolved model](#resolve-the-reviewer-model) and kept for the whole loop |
| **Fixer**: verifies each finding, chooses the remedy, fixes, rejects with counter-evidence, verifies, commits | the phase's own implementer sub-agent, continued |

Where the skill and this section disagree, this section wins.

### 1. Establish the scope

- **Scope**: the phase's diff, `git -C <WORKROOT> diff <base_branch>...HEAD`, plus anything still uncommitted in `<WORKROOT>`.
- **Baseline**: the phase's `base_branch`.
- **Stated requirement**: the phase body, verbatim. Add the plan's **Goals + Non-goals** and **Guiding Decisions** when the conductor passed them, under a heading that says they bound the whole plan rather than describe this phase.
- Record `git -C <WORKROOT> diff --shortstat <base_branch>` for the final report.

### 2. Spawn the reviewer

Spawn **one** sub-agent at the [resolved model](#resolve-the-reviewer-model), with no implementation context, and give it the skill's reviewer prompt filled in with the scope, the baseline and the stated requirement. It works in `<WORKROOT>`, the lane under review, and reads nothing outside it.

- **Use a general-purpose agent, not the project's `reviewer` agent type.** The reviewer applies one standard: the project's `REVIEW.md` when it has one, otherwise the skill's Review Standard. An agent type that carries review rules of its own would hand it two.
- **Check that it read the standard**, as the skill says: the verdict opens with a line naming the standard and quoting its first and last lines. Without that line, ask it to read the standard and resend before acting on any finding.
- **Keep it for the whole loop**, and continue it on every later pass (for example Claude Code's `SendMessage` to the agent id), so it keeps what it already checked. Where the runtime cannot continue a finished sub-agent, spawn a fresh one each pass and hand it the previous findings, the rejected findings with their counter-evidence, and the settled decisions.
- **It never edits.** Record `git -C <WORKROOT> rev-parse HEAD` and `git -C <WORKROOT> status --porcelain` before each pass and compare them after. A change the reviewer made stops the loop. Ask with `AskUserQuestion` (header `Review`), naming the files it touched: `Stop the review (Recommended)` (leave its changes in place for you to look at, and return `STOPPED`), `Keep the changes and continue` (the implementer verifies them like any other finding).

### 3. Hand the findings to the implementer

Continue the phase's implementer sub-agent with a **delta**: the reviewer's findings verbatim, the settled decisions so far, and the skill's fixer instructions — its **Verify before fixing** and **Implement and verify** sections, quoted or pointed at by path. Do not re-send the phase body, the plan sections or the dependency summaries: the implementer was given all of that when it started, and repeating it invites a re-implementation rather than a fix.

The implementer must:

1. Verify every finding before acting on it, and reject the unsupported ones with concrete counter-evidence.
2. Fix the justified ones as one coherent change, re-run the inner loop and the outer gate in `<WORKROOT>`.
3. Commit the round the way the phase commits its work (the project's commit strategy), with a message naming the findings it addresses.
4. Report each finding as fixed (and how), rejected (and the counter-evidence), or gated — a decision that is not the implementer's to make, with the skill's trigger, the evidence, the reviewer's recommendation and its own.

It never asks the human itself: a question comes back as `status: NEEDS_INPUT`, which this skill relays (see [Relay a sub-agent's questions](#relay-a-sub-agents-questions-needs_input)), then continues the implementer with the answers.

After it returns, run the stray-write check from [implement-phase](../implement-phase/SKILL.md) (main checkout and sibling lanes) before the next pass: a fix written into the wrong tree is missing from the commit the reviewer reads.

**When the change was written in the conductor's own session** — [systematic-debugging](../systematic-debugging/SKILL.md) run outside a plan — there is no implementer to continue. The conductor is the fixer itself, exactly as the skill is written, and follows the fixer instructions directly.

**Where the runtime cannot continue a finished sub-agent**, spawn a fresh agent of the project's `fixer` type at the implementer's own tier, and give it the phase body, the plan-level sections and the findings, because it has none of them. Note in the phase's tracking record that the fix was a cold hand-off.

### 4. Run the gate

A gated item goes to the human, never into the code and never decided by the conductor. Once per iteration, after the implementer has fixed everything else, ask with `AskUserQuestion` (header `Review`), one question per gated item: the finding with `file:line`, the evidence, the reviewer's recommendation in its own words, and the implementer's. Offer 2–4 options drawn from the item, the implementer's recommendation first with ` (Recommended)`. For a scenario nothing reaches, or a check on data already validated upstream, that is normally `Reject the finding (Recommended)` next to `Handle it in this phase`. A destructive option is never the recommended one.

Record each answer as a **settled decision** with the date, in the phase's tracking record. Every later reviewer and implementer message carries the settled decisions. The reviewer may re-raise one only with new evidence, which it names. Gate interviews do not count as iterations.

An answer that changes the plan itself (a **Guiding Decisions** row, the phase's scope or acceptance line) is escalated the way the relay escalates one: `Amend the plan first (Recommended)` or `Apply to this phase only`.

### 5. Re-review

Send the same reviewer the round's commits, the implementer's report (a summary to check against the diff, not one to trust), the rejected findings with their counter-evidence, and the settled decisions. Tell it to re-read the whole diff and reapply the full standard under the Review Standard's **Pass two and later** rules.

### 6. The budget: 20 iterations

Count each pass that returns blockers as one unsuccessful iteration. After **20**, pause before the 21st. Give the human, in a few lines: what changed across the iterations; which blockers remain and whether the implementer verified, disputed or considers each one diminishing returns; its view of whether more work is worth it; and the risks that remain. Then ask with `AskUserQuestion` (header `Review`): `Continue for 20 more`, `Stop — hand the phase back unapproved`, `Amend the plan` (stop and hand over to [amend-plan](../amend-plan/SKILL.md)). Put first, as recommended, the option the report supports. Silence is not permission to continue.

### 7. When the loop ends

It ends successfully **only when the reviewer explicitly approves**. Passing gates are not approval, and neither is a reviewer that ran out of things to say. Return `PASS` with the reviewer's approval line, the iteration commits, the `--shortstat` at the start and the end, the rejected findings and the settled decisions, so the conductor can record them in tracking.

If the human stopped the loop, return `STOPPED` with the blockers that remain. The conductor does not integrate a phase that did not pass.
<!-- block-end: LOOP -->
