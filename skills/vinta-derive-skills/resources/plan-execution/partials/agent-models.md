<!-- Partial: agent-models — turns a tier into a concrete spawn model, for the `.vinta-ai-workflows.yaml` `agent_models` roles and for the reviewer review-phase derives one tier above the implementer; plus the mechanical-step delegation pattern. Blocks: TIER_RESOLVE (review-phase reviewer + implement-plan conflict fixer and mechanical steps), MECHANICAL_DELEGATION (implement-plan worktree/integrate steps). The implementer model is NOT here — that stays plan-owned via model-pick. -->

<!-- block-begin: TIER_RESOLVE -->
## Resolve a tier to a spawn model

Every model choice below is a **tier** (1–4) into the same table the per-phase implementer uses — [`ai-tools/skills/plan-feature/resources/ai-models.yaml`](../plan-feature/resources/ai-models.yaml). Where the tier comes from depends on the role:

- **`reviewer`** — one tier above the phase's implementer, derived by [review-phase](../review-phase/SKILL.md). Never configured and never plan-named. (`agent_models.reviewer` in older configs, and a plan's `**Review models**:` line or reviewer rows on its **Crew** table, are ignored.)
- **`fixer`** — `agent_models.fixer`, for the merge-conflict fixer. A review finding is not this role's: the phase's own implementer fixes it, at its own tier.
- **`worktree_prep`, `integrate`** — `agent_models.<role>`, for the mechanical steps below. Never plan-named.

To turn the tier into the model a spawn actually uses:

1. **No tier** (an `agent_models` key unset, or the whole section absent) → do not force a model. Spawn with the runtime's default model (today's behavior). Skip the rest.
2. Open [`ai-tools/skills/plan-feature/resources/ai-models.yaml`](../plan-feature/resources/ai-models.yaml), take that tier's `models`, **filter to the vendors the runtime actually exposes**, pick the cheapest/fastest survivor, and translate it to the runner's spawn form — the same resolution [implement-phase](../implement-phase/SKILL.md) runs for the implementer.
3. `ai-models.yaml` missing, or the tier has no runtime-available vendor → fall back to the runtime default and surface the fallback once. Never hard-fail a phase over a model-selection miss.
4. The resolved model is out of quota or credits and its `ai-models.yaml` entry carries a `fallback:` → spawn on the fallback instead, by the same **Out of quota** rule the implementer follows in [implement-phase](../implement-phase/SKILL.md).

Record the **model actually used** in tracking: for the reviewer, alongside the review note in the phase's record; for the mechanical steps, in the phase's tracking row next to the branch/PR fields.
<!-- block-end: TIER_RESOLVE -->

<!-- block-begin: MECHANICAL_DELEGATION -->
## Delegate a mechanical step to a configured model

Two steps the conductor would otherwise run **inline in its own (usually pricier) session** — provisioning the worktree with the [prepare-worktree](../prepare-worktree/SKILL.md) skill (a project's `commands.worktree_prepare` always runs inline instead, since a shell command needs no model) and integrating a phase ([integrate-phase](../integrate-phase/SKILL.md): push the branch + open/update the PR through the bundled `open-pr.sh`) — are mechanical, precedent-driven work that a cheap model handles fine. The `agent_models.worktree_prep` / `agent_models.integrate` tiers let a project push that work down.

- **Tier set** (`worktree_prep` / `integrate`) → **spawn exactly one subagent** at the [resolved model](#resolve-an-agent_models-tier-to-a-spawn-model), hand it the step's SKILL.md plus the same inputs the conductor would use, and consume its returned report exactly as if the conductor had done the work inline. This subagent is a **labor delegate, not a decision-maker**: the conductor still owns git topology (which branch stacks on which base) and still holds every value the step returns (`WORKROOT` / `BASE_BRANCH` / worktree summary for `worktree_prep`; branch + PR-context path + `status` for `integrate`). The delegate executes and reports those back.
- **Tier unset** → run the step inline in the conductor's own session — today's behavior, no subagent.

Rules that hold **regardless of who runs the step**:

- The **PR-context file + `open-pr.sh` is still the only PR-creation path.** An `integrate` delegate uses the bundled script; it never calls raw `gh pr create` / `glab mr create`.
- The delegate is `read-write` (worktree provisioning writes dirs/DBs; integrate pushes + writes the PR-context file) but **makes no plan or code decisions** — a malformed or failed delegate report is surfaced to the user, never worked around.
- This delegation is **separate from the phase-work sub-agents** (implementer / reviewer / conflict fixer). Those still never branch, push, or open PRs — that prohibition is about code-authoring agents, not the dedicated mechanical delegate the conductor spawns to run the integrate step itself.
<!-- block-end: MECHANICAL_DELEGATION -->
