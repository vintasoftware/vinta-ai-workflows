<!-- Partial: relay-questions — what the orchestrator does when a spawned sub-agent (implementer / fixer / amend implementer / integrate delegate) returns `status: NEEDS_INPUT` — including the implementer answering the review loop's findings. Included by implement-phase, review-phase, and amend-plan. Sub-agents cannot call the harness's structured question tool (Claude Code and Codex block it outside the root session), so the orchestrator is the only place a question can become a clickable prompt. -->

<!-- block-begin: RELAY -->
## Relay a sub-agent's questions (`NEEDS_INPUT`)

A spawned sub-agent cannot reach the human. When its report says `status: NEEDS_INPUT` (the contract every phase-work prompt carries), the orchestrator turns it into a clickable prompt:

1. **Don't answer for the human, and don't ask in prose.** Don't paste the report and end the turn with "how should I proceed?". Don't re-spawn the agent hoping the question goes away.
2. **Ask with `AskUserQuestion`** (the harness's structured question tool — see **Asking the human** in [AGENTS.md](../../../AGENTS.md)). Pass the report's `questions:` block through unchanged: header, question, options (label + description), multi-select. Above the call, write one line naming the blocked phase and agent, plus its `blocked_on` and `done_so_far`. When the block is malformed (no options, more than 4 questions, an "Other" option), fix the shape and keep the wording. Never fall back to prose.
3. **Record the answer** in the conductor's tracking file when one exists, under the phase's `decisions` list (question header, chosen option or free-text answer). A resumed run reads it and doesn't ask again.
4. **Resume the work.** When the runtime can continue the same sub-agent session (for example Claude Code's `SendMessage` to the agent id), send the answers there. Otherwise spawn a fresh agent of the same type and model with the original prompt plus an `## Answers from the human` section that quotes each question, the answer, and the previous agent's `done_so_far`.
5. **Escalate plan-level answers.** When an answer changes the plan itself (a **Guiding Decisions** row, a phase's scope or acceptance line), ask before resuming: `Amend the plan first (Recommended)` (stop and hand over to [amend-plan](../amend-plan/SKILL.md)), `Apply to this phase only` (record the deviation in tracking and resume).
<!-- block-end: RELAY -->
