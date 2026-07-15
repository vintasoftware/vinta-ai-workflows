<!-- Partial: model-pick — the plan-owns-model-selection rules. Included by implement-phase; referenced (linked, not included) by amend-plan's Tier-4 rule. -->
<!-- block-begin: MODEL_PICK -->
## Pick the model from the plan's per-phase suggestion

**The plan owns the *implementer* model — this skill does not re-derive tiers and doesn't assume a vendor.** Each phase carries a `**Suggested AI model**:` line listing one model per vendor. (The reviewer / fixer models default to `.vinta-ai-workflows.yaml`'s `agent_models` section, though a phase's optional `**Review models**:` line can override them for that phase; the mechanical-step models are `agent_models`-only. All of that is handled by `review-phase` / the conductor, not this implementer step.)

Pick:

1. Read the line, parse out **all** vendor suggestions.
2. **Filter to what's actually available in the runtime.** Different harnesses expose different sets.
3. From the surviving suggestions, **pick the cheapest / fastest** the runner can use.
4. Translate the chosen model to whatever form the runner's spawning tool expects.
5. Phase suggestion straddles tiers → pick the higher-tier suggestion.
6. Line missing / malformed → **ask the user**. Don't silently re-derive tier.

**Retry escalation (no user prompt):** the picked model fails on a clear capability gap → step **one tier up** and retry once. After Tier 4 fails, STOP. Update tracking with `❌`, post the agent's report to the user, ask how to proceed.

Record the **model actually used** + the **plan's suggested tier** in tracking.
<!-- block-end: MODEL_PICK -->
