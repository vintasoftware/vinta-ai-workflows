<!-- Partial: model-pick — the plan-owns-model-selection rules. Included by implement-phase; referenced (linked, not included) by amend-plan's Tier-4 rule. -->
<!-- block-begin: MODEL_PICK -->
## Pick the model from the phase's crew assignment

**The plan owns the *implementer* model — this skill does not re-derive tiers and doesn't assume a vendor.** It owns it as a **roster**: the plan's **Crew** table names the agents it is staffed with and the tier each is staffed at, and every phase carries an `**Assigned to**:` line naming one of them.

Pick:

1. Read the phase's `**Assigned to**:` line for the crew id, then that id's row in the plan's **Crew** table for the tier.
2. Open the tier in [`ai-tools/skills/plan-feature/resources/ai-models.yaml`](../plan-feature/resources/ai-models.yaml) and take its models.
3. **Filter to what's actually available in the runtime.** Different harnesses expose different sets.
4. From the survivors, **pick the cheapest / fastest** the runner can use, and translate it to whatever form the runner's spawning tool expects.
5. Tier with no runtime-available vendor → step one tier up and say so once — but never from Tier 3 into Tier 4, which the plan keeps for exploratory work and new complex UI. A Tier 3 phase with no runtime-available Tier 3 vendor steps down to Tier 2 instead and says so. Never hard-fail a phase over a model-selection miss.
6. `**Assigned to**:` missing or naming an agent the **Crew** table does not list → **ask the user** via `AskUserQuestion` (header `Crew`), quoting the line as found, one option per **Crew** member (id + tier), the likeliest fit first with ` (Recommended)`. Don't silently re-derive a tier from the phase body; the roster is the plan's arithmetic about how many agents this feature needs, and inventing a member changes it.

**A legacy plan carries `**Suggested AI model**:` and no Crew table.** Read the tier straight off that line and continue — same resolution, one less indirection. Don't invent a roster for it.

### Apply the phase's effort

**The plan owns the implementer's effort as well, and per phase rather than per member.** It sits on the phase's `**Effort**:` line: `low`, `medium`, `high`, `xhigh` or `max`. The vendor names it `effort`, `reasoning.effort` or `thinking_level`. Pass it on every turn of the phase (the implement turn, each fix round and the review fixes) through whatever setting the spawning tool or the runner offers for it. A continued member gets the new phase's level, because effort is per turn and the session carries over unaffected.

- **The model lacks the level** → use the nearest level it supports below the one asked for, or the nearest above when nothing is below. Say so once. Never fail a phase over it.
- **The runtime has no effort setting at all** → run at its default and say so once. Effort is a tuning, not a precondition.
- **No `**Effort**:` line** (a plan written before effort was planned) → leave the runtime's default in place. Don't derive a level from the tier: the plan never made that decision, and the default is what that plan was written against.
- **Retry escalation stays a tier move.** A capability gap is not fixed by thinking longer at the same tier (see below). Don't raise a phase's effort on your own. A higher level is the human's call, through [amend-plan](../amend-plan/SKILL.md).

Record the **effort actually used** next to the model, so a phase that was clamped reads that way later.

### Reuse the agent the plan staffed

**A crew member is an agent, and it is still alive.** If this member has already taken a phase on this run, continue that sub-agent rather than spawning a new one: it is standing in the same worktree — a member keeps one for the whole run — and it already knows where this codebase keeps things, how its suite is run and what its conventions are. Rediscovering that is most of what a cold agent's first turn costs.

Because it is new work, the continuation gets the phase's **full brief**, not a delta. Precede it with the re-orientation described in [Re-orienting a member after the reset](../implement-plan/SKILL.md#re-orienting-a-member-after-the-reset): the previous phase is finished and this one is its objective now, same agent and same directory, whether the previous phase's work is in this tree, and which files differ from what it last saw.

Start cold instead when any of these hold:

- the member has taken no phase yet on this run;
- **their previous phase failed** — that session is the context that failed with it;
- the runtime cannot continue a finished sub-agent at all.

Record which of those applied, so a phase that was unexpectedly slow can be read later without guessing.

**A continuation that fails or comes back empty.** A continue that errors because the session is gone, or returns no text and no tool call, is retried once **cold, with the full brief** — the decisions block included — never with the delta the continuation carried. A delta only makes sense to the session that read what came before it. Two empty turns in a row are an infrastructure fault (below), not the phase's.

**Out of quota (no user prompt):** the spawn is refused, or the turn cut off, because the picked model's quota or credits are spent — a usage-limit, credit-balance or insufficient-quota error, not a capability gap — and its entry in `ai-models.yaml` carries a `fallback:`. Re-spawn on the fallback at once instead of waiting, and keep using the fallback in place of that model for the rest of the run; say so once. If the fallback is refused the same way, the account is out rather than the model: wait for the reset as you would with no fallback. A plan's workflow JSON may carry the same map as `defaults.model_fallbacks`; when it does, it wins over `ai-models.yaml`.

**An infrastructure failure is not the phase's failure.** The API is overloaded or returns a 5xx, the network fails, the harness's login expired, the harness will not start: none of these says anything about the model's capability. Don't step up a tier, and don't count the attempt as the phase's retry. Stop dispatching new phases — the others in flight are about to hit the same wall — and ask with `AskUserQuestion` (header `Outage`), quoting the error: `Wait and retry (Recommended)` (when the human says so, retry each phase that hit it at the step it reached), `Switch model` (re-spawn on another model of the same tier from `ai-models.yaml`), `Stop the run`. Running out of quota is the case above, not this one.

**Retry escalation (no user prompt):** the picked model fails on a clear capability gap → step **one tier up** and retry once. **Tier 4 is the plan's to give, never the run's**: a phase planned below it climbs no higher than Tier 3. A failure at Tier 3 therefore has no step left, the same as a failure at Tier 4. After either, STOP. Update tracking with `❌` and hand the failure back to the conductor, which asks the user how to proceed with a structured question (see its **Model escalation** rule).

Record the **model actually used**, the **crew member** it came from, and **whether that member is the one the plan assigned** — a phase run by a covering peer is the difference between a run that cost what the plan said and one that did not.
<!-- block-end: MODEL_PICK -->
