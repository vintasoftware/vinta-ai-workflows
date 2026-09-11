<!-- Partial: model-pick — the plan-owns-model-selection rules. Included by implement-phase; referenced (linked, not included) by amend-plan's Tier-4 rule. -->
<!-- block-begin: MODEL_PICK -->
## Pick the model from the phase's crew assignment

**The plan owns the *implementer* model — this skill does not re-derive tiers and doesn't assume a vendor.** It owns it as a **roster**: the plan's **Crew** table names the agents it is staffed with and the tier each is staffed at, and every phase carries an `**Assigned to**:` line naming one of them.

Pick:

1. Read the phase's `**Assigned to**:` line for the crew id, then that id's row in the plan's **Crew** table for the tier.
2. Open the tier in [`ai-tools/skills/plan-feature/resources/ai-models.yaml`](../plan-feature/resources/ai-models.yaml) and take its models.
3. **Filter to what's actually available in the runtime.** Different harnesses expose different sets.
4. From the survivors, **pick the cheapest / fastest** the runner can use, and translate it to whatever form the runner's spawning tool expects.
5. Tier with no runtime-available vendor → step one tier up and say so once. Never hard-fail a phase over a model-selection miss.
6. `**Assigned to**:` missing or naming an agent the **Crew** table does not list → **ask the user**. Don't silently re-derive a tier from the phase body; the roster is the plan's arithmetic about how many agents this feature needs, and inventing a member changes it.

**A legacy plan carries `**Suggested AI model**:` and no Crew table.** Read the tier straight off that line and continue — same resolution, one less indirection. Don't invent a roster for it.

### Reuse the agent the plan staffed

A crew member is a **staffing decision**, not a live session. The phase before this one that the same member took ran in a lane that has since been reset to a different base, so there is no context to continue and nothing to warm: this phase's implementer starts cold whatever the roster says. Session reuse happens **within** a phase, between its implement and fix turns — see the fix loop in [review-phase](../review-phase/SKILL.md).

What the assignment *does* carry between phases is the tier, and therefore the bill.

**Retry escalation (no user prompt):** the picked model fails on a clear capability gap → step **one tier up** and retry once. After Tier 4 fails, STOP. Update tracking with `❌`, post the agent's report to the user, ask how to proceed.

Record the **model actually used**, the **crew member** it came from, and **whether that member is the one the plan assigned** — a phase run by a covering peer is the difference between a run that cost what the plan said and one that did not.
<!-- block-end: MODEL_PICK -->
