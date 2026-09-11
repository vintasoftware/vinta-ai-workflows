<!-- Partial: agent-models — resolves the `.vinta-ai-workflows.yaml` `agent_models` section (tier per role/task) to a concrete spawn model, the reviewer's tier-above-the-author derivation, and the mechanical-step delegation pattern. Blocks: TIER_RESOLVE (review-phase reviewer/fixer + implement-plan mechanical steps), MECHANICAL_DELEGATION (implement-plan worktree/integrate steps). The implementer model is NOT here — that stays plan-owned via model-pick. -->

<!-- block-begin: TIER_RESOLVE -->
## Resolve an `agent_models` tier to a spawn model

`.vinta-ai-workflows.yaml` may carry an `agent_models` section mapping a role/task (`reviewer`, `fixer`, `worktree_prep`, `integrate`) to a **tier** (1–4) into the same table the per-phase implementer suggestion uses — [`ai-tools/skills/plan-feature/resources/ai-models.yaml`](../plan-feature/resources/ai-models.yaml). `agent_models` is the **project default** for these roles; for `reviewer` / `fixer`, a plan phase's optional `**Review models**:` line may override the tier for that one phase (the caller resolves that precedence and hands this block the effective tier). The mechanical steps (`worktree_prep`, `integrate`) are never plan-named. To turn a tier into the model a spawn actually uses:

1. Determine the **effective tier** for the role. For the mechanical steps it is simply `agent_models.<role>`. For `reviewer` / `fixer` there are now three sources, in this order:
   1. a per-phase `**Review models**:` override the conductor passed;
   2. **the cheapest reviewer on the plan's Crew table at or above the phase's tier** (see [Who reviews](#who-reviews-a-member-not-a-tier) below);
   3. `agent_models.<role>`.
2. **No effective tier (override absent AND key unset, or the whole `agent_models` section absent) → do not force a model.** Spawn with the runtime's default model (today's behavior). Skip the rest.
3. Open [`ai-tools/skills/plan-feature/resources/ai-models.yaml`](../plan-feature/resources/ai-models.yaml), take that tier's `models`, **filter to the vendors the runtime actually exposes**, pick the cheapest/fastest survivor, and translate it to the runner's spawn form — the same resolution [implement-phase](../implement-phase/SKILL.md) runs for the implementer, only keyed by a config tier instead of a plan line.
4. `ai-models.yaml` missing, or the tier has no runtime-available vendor → fall back to the runtime default and surface the fallback once. Never hard-fail a phase over a model-selection miss.

### Who reviews: a member, not a tier

**Reviewers are their own members on the plan's Crew table**, with `role: reviewer`, and they never take phases. That is what makes an agent reviewing its own work impossible rather than merely unlikely — and it replaces an earlier rule that resolved a reviewer *model* one tier above the author, which was a proxy for independence and failed in both directions: a phase covered by the top-tier implementer had nobody above it and fell back to being read at its own tier, and a tier says nothing about *who* once a member is a durable agent rather than a model id.

Resolve it from the roster: the **cheapest reviewer at or above the phase's tier**. A reviewer's tier is a floor in the same way an implementer's is — it reads work at or below its own capability, never above it.

Three consequences worth knowing:

- **A reviewer is claimed, not borrowed.** It owns one worktree and one session and cannot read two diffs at once, so a phase whose reviewer is busy waits. That cannot deadlock: reviewers never take phases, so the wait is always on a review already running.
- **A reviewer keeps its session across phases**, like every other member. By phase three it knows this codebase, which is most of what a cold reviewer spends its first turn on.
- **No reviewer on the roster → fall through to `agent_models.reviewer`**, cold, one session per phase. That is what every plan did before, and the one thing a roster-less plan leaves on the table.

A plan with no **Crew** table skips this step entirely and resolves `agent_models.<role>` as it always did.

### What `fixer` still governs

`fixer` governs fewer rounds than it used to. A finding goes back to the phase's
own implementer — the same agent, in the same session — which fixes at the tier
of the crew member that took the phase
because it *is* that member; `agent_models.fixer` applies to the cold cases
only — a runtime that cannot continue a sub-agent, and the last round before
giving up, which is deliberately handed to an agent that has not seen the work.
See the fix loop in [review-phase](../review-phase/SKILL.md).

Record the **model actually used** in tracking, **and which of the three sources it came from** — a review that quietly fell through to the project default because the roster had nobody above the author is a fact worth being able to read later. For `reviewer` / `fixer`, alongside the review note; for the mechanical steps, in the phase's tracking row next to the branch/PR fields.
<!-- block-end: TIER_RESOLVE -->

<!-- block-begin: MECHANICAL_DELEGATION -->
## Delegate a mechanical step to a configured model

Two steps the conductor would otherwise run **inline in its own (usually pricier) session** — provisioning the worktree ([prepare-worktree](../prepare-worktree/SKILL.md)) and integrating a phase ([integrate-phase](../integrate-phase/SKILL.md): push the branch + open/update the PR through the bundled `open-pr.sh`) — are mechanical, precedent-driven work that a cheap model handles fine. The `agent_models.worktree_prep` / `agent_models.integrate` tiers let a project push that work down.

- **Tier set** (`worktree_prep` / `integrate`) → **spawn exactly one subagent** at the [resolved model](#resolve-an-agent_models-tier-to-a-spawn-model), hand it the step's SKILL.md plus the same inputs the conductor would use, and consume its returned report exactly as if the conductor had done the work inline. This subagent is a **labor delegate, not a decision-maker**: the conductor still owns git topology (which branch stacks on which base) and still holds every value the step returns (`WORKROOT` / `BASE_BRANCH` / worktree summary for `worktree_prep`; branch + PR-context path + `status` for `integrate`). The delegate executes and reports those back.
- **Tier unset** → run the step inline in the conductor's own session — today's behavior, no subagent.

Rules that hold **regardless of who runs the step**:

- The **PR-context file + `open-pr.sh` is still the only PR-creation path.** An `integrate` delegate uses the bundled script; it never calls raw `gh pr create` / `glab mr create`.
- The delegate is `read-write` (worktree provisioning writes dirs/DBs; integrate pushes + writes the PR-context file) but **makes no plan or code decisions** — a malformed or failed delegate report is surfaced to the user, never worked around.
- This delegation is **separate from the phase-work sub-agents** (implementer / reviewer / fixer). Those still never branch, push, or open PRs — that prohibition is about code-authoring agents, not the dedicated mechanical delegate the conductor spawns to run the integrate step itself.
<!-- block-end: MECHANICAL_DELEGATION -->
