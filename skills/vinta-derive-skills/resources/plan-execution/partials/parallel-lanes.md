<!-- Partial: parallel-lanes — the DAG scheduler seam. The plan declares `**Depends on**:` per phase; the conductor builds the graph, assigns each ready phase to a lane (one worktree per lane, pooled), and dispatches lanes concurrently. Blocks: DAG_PARSE (conductor Step 0), LANE_WORKTREE_POOL (conductor Step 0.5), LANE_TOPOLOGY (conductor + integrate-phase), LANE_SCHEDULER (conductor Step 1 — dispatch + the crew claim), TRACKING_DIR (conductor), SIBLING_LANE_ISOLATION (implement-phase prompt + review-phase). Sequential runs use the SAME code paths with `max_parallel_lanes = 1` — there is no separate sequential topology. -->

<!-- block-begin: DAG_PARSE -->
## Build the phase dependency graph

The plan's **Phased Rollout** section opens with an **Execution graph** table and gives every phase a `**Depends on**:` line ([plan-feature](../plan-feature/SKILL.md) authors both). Parse them into a DAG once, alongside the rest of the plan:

1. **Read each phase's `**Depends on**:` line** into `phase.depends_on` — a list of phase ids, or `[]` for `nothing`. Ignore the prose after the em dash; it explains *why* the edge exists and is passed through to the implementer prompt, not to the scheduler.
2. **Compute `phase.wave`** — longest path from a root: `wave(P) = 1` when `depends_on` is empty, else `1 + max(wave(d) for d in P.depends_on)`. Waves are **derived, never read from the plan**; a plan whose **Execution graph** table disagrees with the computed waves is a plan bug — surface the mismatch to the user before starting and go with the computed values.
3. **Validate the graph.** Each failure below stops the run before any phase is dispatched:
   - **Unknown id** in a `**Depends on**:` line → name the phase and the bad id; ask the user to fix the plan.
   - **Cycle** → print the cycle (`Phase 3 → Phase 5 → Phase 3`); ask the user to fix the plan.
   - **Missing line** on any executable phase → do **not** guess. Ask the user whether that phase depends on everything before it (safe, serializing) or nothing (parallel) — then write the answer back into the plan file before starting, so a resume reads the same graph.
   - **Dependency on a deferred phase** (cross-repo or flag-removal, which this skill never executes) → that dependent is also deferred, transitively. Report both.
4. **Warn on file overlap.** For every pair of phases in the same wave, intersect their **Touch List** entries. A non-empty intersection means two lanes will edit the same file concurrently and the wave merge will conflict. Surface the pairs and the shared paths, then ask: `Serialize them (add a dependency edge and re-derive waves)`, `Run anyway — I'll take the merge conflict`, `Stop — let me fix the plan`. Default to serializing. This is a warning, not a hard stop: two phases legitimately touching one `__init__.py` merge fine, two rewriting the same use case do not.
5. **Read the plan's staffing, and check it against the graph you just computed.** The **Crew** table and the phases' `**Assigned to**:` lines are one decision in two places, and the arithmetic they claim is checkable before anything is dispatched:
   - **An `**Assigned to**:` naming an agent the table does not list** → stop and ask. Don't invent a member: the roster is the plan's answer to "how many agents does this feature need", and adding one changes it.
   - **A phase with no `**Assigned to**:` line in a plan that has a Crew table** → stop and ask, for the same reason. Half a roster means two staffing rules running at once.
   - **A declared member assigned no phase** → stop and ask. That is an agent the plan budgeted for and never uses.
   - **A phase assigned to a reviewer, or a reviewer that also takes phases** → stop and ask. The two roles are disjoint precisely so that an agent reviewing its own work is unrepresentable.
   - **A reviewer below every phase on the plan** → stop and ask. A reviewer's tier is a floor too, so one below the cheapest phase would never be picked.
   - **No reviewer at all** → not an error. Reviews fall back to `agent_models.reviewer`, cold, one session per phase. Say so once in the pool report so nobody reads the roster and assumes otherwise.
   - **A wave the roster cannot staff** → warn. Sort the wave's assigned tiers and the roster's tiers, compare one for one: a wave of two Tier 3 phases needs two members at Tier 3 or above, and a Tier 1 member on the roster does not help because the floor forbids handing them one. Such a wave still runs — it serializes — so say so now rather than letting it look like a slow machine later.
   - **A plan with no Crew table at all** is a legacy plan. Read each phase's `**Suggested AI model**:` tier instead and skip every check above.
6. **Record the resolved graph and the roster** in `run.md` (see [Update tracking](#1d-update-tracking)) so a resume rebuilds the identical schedule and the identical staffing without re-asking anything.

**The graph decides ordering — plan order does not.** Phase numbering is a reading aid for humans. A phase with no dependencies runs in wave 1 no matter how high its number is.
<!-- block-end: DAG_PARSE -->

<!-- block-begin: LANE_WORKTREE_POOL -->
## Provision the lane worktree pool

Parallel execution **requires** [prepare-worktree](../prepare-worktree/SKILL.md). Two agents cannot write two branches in one working tree, and two concurrent test runs cannot share one dev / test database or one compose project name.

**Hard gate — refuse rather than degrade.** When `run_options.parallel_phases = true` but worktrees are unavailable — `foundation_skills.prepare-worktree` is `disabled`, or the user answered `No` to the worktree question, or provisioning fails — **stop and tell the user why**. Do not silently fall back to sequential; the plan's whole schedule was built around concurrency. Offer: `Enable worktrees and continue in parallel`, `Run this plan sequentially instead (max_parallel_lanes = 1)`, `Stop`. The user picks; the conductor never picks for them.

**Pool, don't provision per phase.** Provisioning a runnable worktree costs a dep install plus a DB fork. A plan with 14 phases must not pay that 14 times. Provision **`max_parallel_lanes` worktrees once** and reuse each one across the phases assigned to it:

1. **Size the pool by the roster: one worktree per *implementer***, named for the member rather than numbered. Reviewers get none — see below. A plan with no **Crew** table falls back to `lanes = min(run_options.max_parallel_lanes, widest_wave)`.

   **An implementer keeps their worktree for the whole run**, and that is the point rather than a detail. A sub-agent can only be continued into a directory it is already standing in, so a member that moved between phases would have to start cold every time — which is most of a phase's first turn spent rediscovering a codebase the same agent read an hour ago. Pinning the directory is what makes "reuse the agent" possible at all.

   It costs a checkout and a set of forked databases per implementer, including for members idle in most waves. That is the trade, and it is worth stating to the user in the pool report rather than discovering on a full disk.

   **Reviewers work in the lane they are reviewing.** A reviewer reads the phase's `WORKROOT` directly — the implementer's own worktree, with that phase's changes still uncommitted in it. That is deliberate and is the whole reason review sits where it does in the phase: findings are fixed **before the commit**, in the working tree, rather than recorded as a mistake and then a correction on top of it. A reviewer with a checkout of its own would be reading a committed snapshot, which is strictly less than what is there and too late to act on.

   The cost is that a reviewer's directory moves from phase to phase, so its session carries only when two consecutive reviews happen to land in the same lane. Nothing to configure: the runtime decides per turn, the same way it decides for anyone whose lane changed.
2. **Provision each lane.** Run [prepare-worktree](../prepare-worktree/SKILL.md) once per lane, plan-driven, with worktree name `plan-{plan-id-kebab}-crew-{implementer-id}` (or `plan-{plan-id-kebab}-lane-{i}` on a plan with no roster). This is the mechanical `worktree_prep` step — delegate all of them per the [Delegate a mechanical step to a configured model](#delegate-a-mechanical-step-to-a-configured-model) pattern when `agent_models.worktree_prep` is set, and **dispatch the provisioning calls concurrently** — they are independent.
3. **Provision the integration worktree.** One more, named `plan-{plan-id-kebab}-integ`. The conductor merges lane branches into wave integration branches here (see [Lane branch topology](#lane-branch-topology)) so a merge never disturbs a lane that is still working.
4. **Record the pool** in `run.md`: for each lane, `workroot`, `branch`, `worktree_summary`, `sandbox_tier`, plus `current_phase` (null when idle). `SANDBOX_TIER` is probed **per lane** — a mixed result is possible in principle and each lane's spawn wrapping follows its own tier.
5. **Report once, then hold.** Show the user the pool (paths, DB names, compose project names, teardown commands) and the computed wave schedule together. `AskUserQuestion`: `Looks good — start`, `Fewer lanes`, `Stop — let me adjust`.

### Re-orienting a member after the reset

A lane worktree carries state from the phase it just ran — most dangerously **applied migrations** in its forked dev / test DB. The next phase assigned to that lane branches from a different base, which may not contain those migrations, and a leftover schema silently invalidates its test run.

**And the agent standing in it has a memory of the old tree.** Continuing a member across phases is only safe if it is told what moved, so the message that starts its next phase is the phase's **full brief** — it is new work, not a delta — preceded by three facts:

1. **It is the same agent in the same directory**, and everything it knows about the repository's layout, conventions and tooling still holds. Say so: an agent told only that things changed will re-read work it does not need to.
2. **Whether the previous phase's own work is in this tree** — true exactly when this phase depends on it. This is the sentence that matters most. An agent that remembers writing a model and does not know it is absent will code against something that is not there.
3. **Which files differ from what it last saw**, as a list:

   ```bash
   git -C <lane.workroot> diff --name-only plan/{plan-id-kebab}/phase-{prior.id} HEAD
   ```

   A list is checkable; "things may have changed" invites the agent to decide for itself what to trust. If the diff cannot be computed, say the set is **unknown** and to re-read before editing — never that nothing changed, which is the one wording that would stop it re-reading.

**Start a member cold when their previous phase failed.** Their session is the context that failed with it, and whatever wrong turn it took is exactly what a continuation preserves. Re-reading a repository is cheaper than inheriting a wrong conclusion about it.

Before handing a lane to its next phase:

```bash
git -C <lane.workroot> checkout <phase.base_branch>
git -C <lane.workroot> checkout -b plan/{plan-id-kebab}/phase-{phase.id}
```

then **reset that lane's databases to the new base** using the `db_reset_cmd` recorded in the lane's `worktree_summary` (prepare-worktree writes it — drop + recreate from the template, or re-run migrations from zero, per engine). A lane whose summary carries no `db_reset_cmd`, and whose outgoing or incoming phase touches the **Data Model Changes** section, is not safe to reuse: re-provision that lane instead. Never reuse a lane across a migration boundary without the reset.

Dep churn matters less but is real: when the incoming phase's plan body installs dependencies, re-run the project's install command in that lane before dispatching.

### Teardown

The pool is torn down **only at the end of the run, and only by the user**. [Step 2](#step-2--final-report) prints every lane's teardown command plus the integration worktree's. Do not auto-run them — a failed lane's worktree is the only place its state survives.
<!-- block-end: LANE_WORKTREE_POOL -->

<!-- block-begin: LANE_TOPOLOGY -->
## Lane branch topology

Every phase still gets its own branch. What changes under a DAG is **what that branch is based on** — no longer "the previous phase in plan order", but the phase's own declared dependencies.

**Base branch of phase `P`:**

| `P.depends_on` | `P.base_branch` |
|---|---|
| empty | `<BASE_BRANCH>` |
| exactly one phase `Q` | `plan/{plan-id-kebab}/phase-{Q.id}` |
| two or more phases | `plan/{plan-id-kebab}/integ-{P.id}` — built by merging every dependency's branch (see below) |

**Multi-dependency base.** Built in the **integration worktree**, before the phase is dispatched:

```bash
git -C <integ.workroot> checkout -B plan/{plan-id-kebab}/integ-{P.id} plan/{plan-id-kebab}/phase-{first-dep.id}
git -C <integ.workroot> merge --no-ff plan/{plan-id-kebab}/phase-{next-dep.id}   # once per remaining dep, in plan order
git -C <integ.workroot> push -u origin plan/{plan-id-kebab}/integ-{P.id}
```

**Wave integration branches** are the durable spine. `plan/{plan-id-kebab}/wave-0` is `<BASE_BRANCH>`. When every phase at wave `N` has passed review, the conductor builds `plan/{plan-id-kebab}/wave-{N}` in the integration worktree by merging each wave-`N` lane branch into `wave-{N-1}` with `--no-ff`, in plan order. Wave branches are what a resume anchors on, what the final report points at, and what a phase whose dependency set covers an entire earlier wave may use directly as its base.

**A phase does not wait for its wave — it waits for its dependencies.** Wave branches are built behind the scheduler, not in front of it: a wave-3 phase whose two dependencies are both green starts immediately, even while other wave-2 phases are still running. The wave branch is bookkeeping and integration; the `depends_on` set is the gate.

### Merge conflicts during integration

The orchestrator **never edits code**, including merge conflicts. On a conflicted `merge`:

1. Capture `git -C <integ.workroot> diff --name-only --diff-filter=U`.
2. Spawn a **fixer** subagent (the project's `fixer` agent type, at the `agent_models.fixer` model) inside the integration worktree. Its prompt carries: the conflicted paths, both phases' bodies from the plan, both phases' `phase-{id}.md` summaries, and the instruction to resolve for **both** intents — never to `--ours` / `--theirs` a conflict away.
3. After the fixer returns, re-run the **outer gate** (`{{BUILD_CMD}}` plus the test scope `run_options.full_test_suite` selects) in the integration worktree. Red → loop back to step 2 with the failure.
4. Green → commit the merge, push the branch, and record the conflict + resolution in `waves/wave-{N}.md`.

A conflict that survives its fixer-round budget (default **two**) is a **plan defect**, not a code problem: two phases in the same wave own the same code. Stop, report both phases and the paths, and ask whether to serialize them (add the edge, re-derive waves, re-run the loser) or continue by hand.

The budget is an **integration-level** setting, not either phase's `max_fix_rounds`. A conflict belongs to a *pair* of phases, so deriving it from one of them would make the answer depend on which phase happened to merge second.

**Confirming a fix requires reading the files, not asking git.** `git add` clears a path's unmerged flag whether or not `<<<<<<<` is still sitting in it, so git cannot tell you whether the fixer actually resolved anything. Scan the conflicted paths for conflict markers before committing the merge. Skip this and a fixer that did nothing produces a merge commit full of markers that passes straight into the wave branch.

### One PR per phase, based on the phase's base

The PR `base` written into the prs-context frontmatter is the phase's **computed `base_branch`** — `<BASE_BRANCH>`, a single dependency's branch, or the `integ-{P.id}` branch. Never `<BASE_BRANCH>` for a phase that has dependencies; a wrong base makes the PR diff include every upstream phase and the review is unusable.
<!-- block-end: LANE_TOPOLOGY -->

<!-- block-begin: LANE_SCHEDULER -->
### Dispatch loop

Continuous, dependency-driven. A phase starts the moment its dependencies are green and a lane is free — it does **not** wait for its wave to fill or drain.

```
DONE = {}            # phase ids that passed review + integrate
RUNNING = {}         # lane -> phase currently in flight
BLOCKED = {}         # phase ids whose upstream failed
PENDING = every executable phase (not cross-repo, not flag-removal)

while PENDING or RUNNING:
    ready = [p for p in PENDING
             if set(p.depends_on) <= DONE
             and p.id not in BLOCKED]

    while ready and some lane is idle:
        p = ready.pop(0)                      # plan order breaks ties
        agent = claim_agent(p)                # the plan's member, a qualified peer, or None
        if agent is None: continue            # every hand at or above p's tier is busy
        lane = claim_idle_lane()
        reset_lane(lane, p)                   # checkout base + branch + DB reset
        dispatch(lane, p, agent)              # 1a → 1b → 1c, concurrently with other lanes
        RUNNING[lane] = p ; PENDING.remove(p)

    if not RUNNING:                           # nothing running, nothing ready
        break                                 # deadlock or done — checked below

    wait for ANY lane to return
    on success: DONE.add(p.id) ; free the lane ; write phase tracking ; maybe build a wave branch
    on failure: mark p failed ; BLOCKED |= transitive_dependents(p) ; free the lane
```

**Tie-breaking is plan order.** When more phases are ready than lanes are free, dispatch in the order they appear in **Phased Rollout**. Prefer a ready phase that unblocks the most dependents when the user has asked for throughput — but do not invent a scoring function; plan order is the default and is what the user can predict.

### Claiming an agent

`claim_agent(p)` is the staffing half of a dispatch, and it runs **before** the lane is taken. A lane is disk; who is holding it is what the phase costs and whether the result is any good.

1. **The member the plan assigned, if they are free.** The common case, and the one the plan's cost estimate is written against.
2. **Otherwise the cheapest free member at or above that member's tier.** A wave should not serialize behind one agent when a qualified peer is idle. Reach for the *cheapest* qualified one, not the best available — covering for a peer must not quietly promote the phase to the top tier, or a busy wave silently runs every Tier 2 phase on the Tier 4 member's model.
3. **Otherwise nobody, and the phase waits** — even with a lane free. This is the one place staffing costs throughput, and it is deliberate: a phase run below its tier does not fail cleanly. It produces plausible code that fails review two rounds later, by which point nothing points back at the staffing decision.

An implementer is held for the **whole phase**, not one turn of it: the fixer answering a review finding is the implementer continuing its own session, so handing the phase to someone else mid-flight would hand it to an agent with no session to continue. Release it when the phase settles.

**A reviewer is claimed per review turn, not per phase.** It has one session ledger, so two reviews running as the same reviewer would either resume one session twice or overwrite each other's record of it. Claim it when the review starts, release it when the verdict is in — holding it for a whole phase would make a plan with one reviewer and three implementers run three phases strictly in series. A phase whose reviewer is busy waits, and that wait cannot deadlock: reviewers never take phases, so it is always waiting on a review already in flight. A plan that finds one reviewer too serialising staffs a second.

Pick the reviewer the same way: the **cheapest reviewer on the roster at or above the phase's tier**. Never the phase's own implementer — the roles are disjoint, so that is not a rule to remember but a state the plan cannot describe.

**The wait cannot deadlock.** The floor is the assigned member's own tier, so a waiting phase is always waiting on somebody who is *holding another phase* — never on a qualification nobody on the roster has. If you find yourself with every agent idle and a phase that cannot be staffed, the plan assigned it to a member the **Crew** table does not list; stop and ask.

**Record every claim**, and record whether it was the plan's own assignment or a peer covering. A run where half the phases were covered by a dearer peer is a run that cost more than the plan said while every phase came back green — and that is invisible in the phase statuses.

**Deadlock check.** Loop exits with `PENDING` non-empty and nothing running → every remaining phase is blocked. Report each blocked phase with the failed upstream that blocks it.

**Failure containment.** A failed phase does **not** abort the run. Let every already-dispatched lane finish (killing a lane mid-implementation leaves a half-written worktree nobody can resume). Mark the failure's transitive dependents `BLOCKED`, keep dispatching everything still reachable, and report the whole picture at the end. The exception is the [Tier-4 escalation stop](#1a-implement) — after Tier 4 fails on a phase, that phase stops, but sibling lanes still run to completion.

**Per-lane pause gate.** `run_options.pause_between_phases = true` under parallel execution means: **stop dispatching new phases** once every in-flight lane has returned, then ask. It does not mean pausing lanes individually — a per-lane prompt with three lanes running is unreadable. Options stay `Continue`, `Pause`, `Stop`.

**Concurrency is a cap, not a target.** A graph that is a straight chain runs one lane at a time and that is correct — do not reorder or bundle phases to fill idle lanes. The same goes for the roster: an agent idle for three waves is not a reason to hand them work above their tier.
<!-- block-end: LANE_SCHEDULER -->

<!-- block-begin: TRACKING_DIR -->
Tracking lives in a **directory**, not a single file: `{{PLAN_DIR}}/TRACKING_{plan-id}/`.

```
{{PLAN_DIR}}/TRACKING_{plan-id}/
├─ run.md                 # conductor-owned run state
├─ phase-{phase.id}.md    # one per executed phase
└─ waves/wave-{N}.md      # one per completed wave integration
```

**Why a directory.** Concurrent lanes commit on different branches that later merge. A single shared tracking file would conflict on **every** wave merge, for no reason — the lanes are appending unrelated records. Splitting by owner makes the merges trivially clean, because no two branches ever touch the same path.

**Ownership rules — these are what make the merges clean. Do not relax them:**

| Path | Written by | Committed on |
|---|---|---|
| `run.md` | the conductor only | the integration worktree, on the current wave branch |
| `phase-{id}.md` | the lane that ran phase `{id}`, once, after it passes review | that phase's own lane branch, in the phase's final commit |
| `waves/wave-{N}.md` | the conductor only | `plan/{plan-id-kebab}/wave-{N}`, as part of the merge commit |

**No lane ever writes, edits, or deletes another lane's file.** A lane that needs a sibling's summary *reads* it — the conductor passes prior-phase summaries into the prompt as data (see [Implement](#1a-implement)); the lane does not go looking in the tracking dir itself.

**`run.md`** carries: feature name, plan path, started / last-updated dates, optional feature-flag info, **run options** (`pause_between_phases`, `generate_inline_comments`, `full_test_suite`{{E2E_RUN_OPTION_TRACKING}}, `use_worktree`, `parallel_phases`, `max_parallel_lanes`), the **resolved dependency graph** (phase id → `depends_on` + computed wave), the **lane pool** (per lane: `workroot`, `branch`, `worktree_summary`, `sandbox_tier`, `current_phase`), the **crew roster** (per member: id, role, tier, resolved model, its worktree for an implementer, the phases the plan assigned them, and the phases they actually took), the integration worktree, {{TRACKING_BRANCH_FIELD}}, and per-phase status (`done` / `running` / `blocked` / `failed` / `deferred`) with the lane each ran on.

**`phase-{id}.md`** carries: status, the crew member that took it + the model actually used + whether that member is the one the plan assigned + whether its session was continued from an earlier phase or started cold (and why, when cold) + the reviewer that read it{{TRACKING_PHASE_BRANCH_FIELD}}, base branch, wave, `depends_on`, e2e + screenshots if any, and the 5–15 line summary the conductor writes **from the git diff plus the agent's report** — not from the agent's narration.

**`waves/wave-{N}.md`** carries: which lane branches were merged, in what order, any conflicts and how they were resolved, and the outer-gate result on the merged tree.

**Migrating a legacy single-file tracking.** A plan started before this layout has `{{PLAN_DIR}}/TRACKING_{plan-id}.md`. On resume: create the directory, split the existing content (run options + graph → `run.md`; each completed-phase entry → its own `phase-{id}.md`), `git rm` the old file, and continue. Say so in the resume report.

**Deletion.** [Step 2](#step-2--final-report) deletes the whole directory (`git rm -r`) on the final integration branch, in one commit. The plan file stays.
<!-- block-end: TRACKING_DIR -->

<!-- block-begin: SIBLING_LANE_ISOLATION -->
**Sibling-lane writes — only when the pool has more than one lane.** A reviewer is bound by this too, and is the likeliest agent to trip it: it works in somebody else's `WORKROOT` by design, so "your own lane" for a review turn means *the lane under review*, not one it read last phase. The main checkout is not the only tree an agent can wander into: with a pool provisioned, `<lane-2>/app/models.py` is as reachable from lane 1 as the main checkout is, and a write there is worse than a stray main-checkout write — it lands in a tree another agent is actively editing and testing. The same guard covers both: everything outside the lane's own `WORKROOT` is off-limits.

- **Sandbox** (`SANDBOX_TIER = enforced`): the `--deny` / `--allow` set for a lane denies the **worktree root that holds the pool**, not just the main checkout, and allows only that lane's `WORKROOT` (plus `<main_checkout>/.git` and `<main_checkout>/.vinta-ai-workflows`). One `--deny <pool-root>` covers every sibling.
- **Backstop check** (`SANDBOX_TIER = none`, or as the cheap confirmation when enforced): after every implementer and fixer returns, run the stray-write check against the main checkout **and every sibling lane's workroot**:

  ```bash
  for tree in <main_checkout> <every lane workroot except this lane's>; do
    git -C "$tree" status --short | grep -vE '^\?\?'
  done
  ```

  Output from a sibling lane is a BLOCKER, handled exactly like a stray main-checkout write: diff it, recover the intent into the correct lane, then `git -C <tree> restore --` it away. Do this **before** the sibling's own review reads its diff — otherwise the sibling reviews foreign changes as its own.
<!-- block-end: SIBLING_LANE_ISOLATION -->
