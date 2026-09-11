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

**A crew member is an agent, and it is still alive.** If this member has already taken a phase on this run, continue that sub-agent rather than spawning a new one: it is standing in the same worktree — a member keeps one for the whole run — and it already knows where this codebase keeps things, how its suite is run and what its conventions are. Rediscovering that is most of what a cold agent's first turn costs.

Because it is new work, the continuation gets the phase's **full brief**, not a delta. Precede it with the re-orientation described in [Re-orienting a member after the reset](../implement-plan/SKILL.md#re-orienting-a-member-after-the-reset): same agent and same directory, whether the previous phase's work is in this tree, and which files differ from what it last saw.

Start cold instead when any of these hold:

- the member has taken no phase yet on this run;
- **their previous phase failed** — that session is the context that failed with it;
- the runtime cannot continue a finished sub-agent at all.

Record which of those applied, so a phase that was unexpectedly slow can be read later without guessing.

**Retry escalation (no user prompt):** the picked model fails on a clear capability gap → step **one tier up** and retry once. After Tier 4 fails, STOP. Update tracking with `❌`, post the agent's report to the user, ask how to proceed.

Record the **model actually used**, the **crew member** it came from, and **whether that member is the one the plan assigned** — a phase run by a covering peer is the difference between a run that cost what the plan said and one that did not.
<!-- block-end: MODEL_PICK -->
