<!-- Partial: parallel-lanes — the DAG scheduler seam. The plan declares `**Depends on**:` per phase; the conductor builds the graph, assigns each ready phase to a lane (one worktree per lane, pooled), and dispatches lanes concurrently. Blocks: DAG_PARSE (conductor Step 0), LANE_WORKTREE_POOL (conductor Step 0.5), LANE_TOPOLOGY (conductor + integrate-phase), LANE_SCHEDULER (conductor Step 1 — dispatch + the crew claim), TRACKING_DIR (conductor), SIBLING_LANE_ISOLATION (implement-phase prompt + review-phase). Sequential runs use the SAME code paths with `max_parallel_lanes = 1` — there is no separate sequential topology. -->

<!-- block-begin: DAG_PARSE -->
## Build the phase dependency graph

The plan's **Phased Rollout** section opens with an **Execution graph** table and gives every phase a `**Depends on**:` line ([plan-feature](../plan-feature/SKILL.md) authors both). Parse them into a DAG once, alongside the rest of the plan:

1. **Read each phase's `**Depends on**:` line** into `phase.depends_on` — a list of phase ids, or `[]` for `nothing`. Ignore the prose after the em dash; it explains *why* the edge exists and is passed through to the implementer prompt, not to the scheduler.
2. **Compute `phase.wave`** — longest path from a root: `wave(P) = 1` when `depends_on` is empty, else `1 + max(wave(d) for d in P.depends_on)`. Waves are **derived, never read from the plan**; a plan whose **Execution graph** table disagrees with the computed waves is a plan bug — show the mismatch in the start-run summary and go with the computed values.
3. **Validate the graph.** Each failure below stops the run before any phase is dispatched. Every "ask" in this step and the next two is an `AskUserQuestion` call, batched up to 4 problems per call, each question naming the phase and quoting the offending line:
   - **Unknown id** in a `**Depends on**:` line → `Stop — I'll fix the plan (Recommended)`, `Drop the unknown edge` (write the corrected line back into the plan).
   - **Cycle** → print the cycle (`Phase 3 → Phase 5 → Phase 3`) in the question; `Stop — I'll fix the plan (Recommended)`, plus one `Drop edge <a> → <b>` option per edge in the cycle (up to 3).
   - **Missing line** on any executable phase → do **not** guess. Ask: `Depends on everything before it (Recommended)` (safe, serializing), `Depends on nothing` (parallel). The free-text field takes an explicit id list. Write the answer back into the plan file before starting, so a resume reads the same graph.
   - **Dependency on a deferred phase** (cross-repo or flag-removal, which this skill never executes) → that dependent is also deferred, transitively. Report both.
4. **Warn on file overlap.** For every pair of phases in the same wave, intersect their **Touch List** entries. A non-empty intersection means two lanes will edit the same file concurrently and the wave merge will conflict. Put the pairs and the shared paths in the question, then ask: `Serialize them (Recommended)` (add a dependency edge and re-derive waves), `Run anyway — I'll take the merge conflict`, `Stop — let me fix the plan`. This is a warning, not a hard stop: two phases legitimately touching one `__init__.py` merge fine, two rewriting the same use case do not.

   **Migrations in one app count as overlap even when the files differ.** Two phases neither of which depends on the other, whose Touch Lists both reach into the same migrations directory (Django's `<app>/migrations/`, Alembic's `versions/`, Rails' `db/migrate/`, Prisma's `prisma/migrations/`), each start from the same latest migration. The merged tree then has two heads and fails its gates, and no same-path check sees it. Ask, naming the pair and the directory: `Serialize them (Recommended)`, `Keep them parallel — the merge fixer writes the merge migration`.
5. **Read the plan's staffing, and check it against the graph you just computed.** The **Crew** table and the phases' `**Assigned to**:` lines are one decision in two places, and the arithmetic they claim is checkable before anything is dispatched:
   Each "stop and ask" below offers `Stop — I'll fix the plan (Recommended)` plus the concrete repair when one exists (`Assign to <member>`, `Drop <member> from the roster`), and writes an accepted repair back into the plan.
   - **An `**Assigned to**:` naming an agent the table does not list** → stop and ask. Don't invent a member: the roster is the plan's answer to "how many agents does this feature need", and adding one changes it.
   - **A phase with no `**Assigned to**:` line in a plan that has a Crew table** → stop and ask, for the same reason. Half a roster means two staffing rules running at once.
   - **A declared member assigned no phase** → stop and ask. That is an agent the plan budgeted for and never uses.
   - **Reviewer rows on the table** (a plan written for the older review) → not an error. Reviews now run one tier above each phase's implementer, so those rows staff nothing: leave them out of the roster, and say so once in the pool report.
   - **A wave the roster cannot staff** → warn. Sort the wave's assigned tiers and the roster's tiers, compare one for one: a wave of two Tier 3 phases needs two members at Tier 3 or above, and a Tier 1 member on the roster does not help because the floor forbids handing them one. Such a wave still runs — it serializes — so say so now rather than letting it look like a slow machine later.
   - **A plan with no Crew table at all** is a legacy plan. Read each phase's `**Suggested AI model**:` tier instead and skip every check above.
6. **Record the resolved graph and the roster** in `run.md` (see [Update tracking](#1d-update-tracking)) so a resume rebuilds the identical schedule and the identical staffing without re-asking anything.

**The graph decides ordering — plan order does not.** Phase numbering is a reading aid for humans. A phase with no dependencies runs in wave 1 no matter how high its number is.
<!-- block-end: DAG_PARSE -->

<!-- block-begin: LANE_WORKTREE_POOL -->
## Provision the lane worktree pool

Parallel execution **requires** a worktree provisioner: the project's `commands.worktree_prepare`, or the [prepare-worktree](../prepare-worktree/SKILL.md) skill (see [Pick the provisioner once](#step-05--resolve-workroot)). Two agents cannot write two branches in one working tree, and two concurrent test runs cannot share one dev / test database or one compose project name.

**Hard gate — refuse rather than degrade.** When `run_options.parallel_phases = true` but worktrees are unavailable — `foundation_skills.prepare-worktree` is `disabled` and `commands.worktree_prepare` is unset, or the user answered `No` to the worktree question, or provisioning fails — **stop and tell the user why**. Do not silently fall back to sequential; the plan's whole schedule was built around concurrency. Offer: `Enable worktrees and continue in parallel`, `Run this plan sequentially instead (max_parallel_lanes = 1)`, `Stop`. The user picks; the conductor never picks for them.

**Pool, don't provision per phase.** Provisioning a runnable worktree costs a dep install plus a DB fork. A plan with 14 phases must not pay that 14 times. Provision **`max_parallel_lanes` worktrees once** and reuse each one across the phases assigned to it:

1. **Size the pool by the roster: one worktree per *implementer***, named for the member rather than numbered. A plan with no **Crew** table falls back to `lanes = min(run_options.max_parallel_lanes, widest_wave)`.

   **An implementer keeps their worktree for the whole run**, and that is the point rather than a detail. A sub-agent can only be continued into a directory it is already standing in, so a member that moved between phases would have to start cold every time — which is most of a phase's first turn spent rediscovering a codebase the same agent read an hour ago. Pinning the directory is what makes "reuse the agent" possible at all.

   It costs a checkout and a set of forked databases per implementer, including for members idle in most waves. That is the trade, and it is worth stating to the user in the pool report rather than discovering on a full disk.

   **The reviewer works in the lane it is reviewing.** [review-phase](../review-phase/SKILL.md) spawns it per phase, in that phase's `WORKROOT`, and it gets no worktree of its own.
2. **Provision each lane.** Run the provisioner once per lane, plan-driven, with worktree name `plan-{plan-id-kebab}-crew-{implementer-id}` (or `plan-{plan-id-kebab}-lane-{i}` on a plan with no roster).
   - **Skill:** this is the mechanical `worktree_prep` step. Delegate all of them per the [Delegate a mechanical step to a configured model](#delegate-a-mechanical-step-to-a-configured-model) pattern when `agent_models.worktree_prep` is set, and **dispatch the provisioning calls one at a time**. Each one starts with `git worktree add`, and concurrent adds against one repository clobber each other's entries under `.git/worktrees/`, which leaves a lane that looks provisioned and is not.
   - **Command:** run `commands.worktree_prepare` inline with `VINTA_WORKTREE_KIND=lane`, **one lane at a time**, and post-check each one per [Provisioning with the project's command](#provisioning-with-the-projects-command).
3. **Provision the integration worktree.** One more, named `plan-{plan-id-kebab}-integ` (`VINTA_WORKTREE_KIND=integration` for the command). The conductor merges lane branches into wave integration branches here (see [Lane branch topology](#lane-branch-topology)) so a merge never disturbs a lane that is still working.
4. **Record the pool** in `run.md`: for each lane, `workroot`, `branch`, `worktree_summary`, `sandbox_tier`, plus `current_phase` (null when idle). `SANDBOX_TIER` is probed **per lane** — a mixed result is possible in principle and each lane's spawn wrapping follows its own tier.
5. **Report once, then hold.** Show the user the pool (paths, DB names, compose project names, teardown commands) and the computed wave schedule together. `AskUserQuestion`: `Looks good — start (Recommended)`, `Fewer lanes`, `Stop — let me adjust`.

### Re-orienting a member after the reset

A lane worktree carries state from the phase it just ran — most dangerously **applied migrations** in its forked dev / test DB. The next phase assigned to that lane branches from a different base, which may not contain those migrations, and a leftover schema silently invalidates its test run.

**And the agent standing in it has a memory of the old tree.** Continuing a member across phases is only safe if it is told what moved, so the message that starts its next phase is the phase's **full brief** — it is new work, not a delta — preceded by four facts:

1. **Its objective changed.** Open with it, in these words: *"Phase `<prior.id>` is finished. Do not continue it, report on it or re-verify it, and drop anything still in flight for it — a running command, a todo list, findings, a verdict. Your objective from here on is phase `<phase.id>`."* An agent that is not told this keeps working on the phase it remembers, and reports on it under the new phase's name.
2. **It is the same agent in the same directory**, and everything it knows about the repository's layout, conventions and tooling still holds. Say so: an agent told only that things changed will re-read work it does not need to.
3. **Whether the previous phase's own work is in this tree** — true exactly when this phase depends on it. This is the sentence that matters most. An agent that remembers writing a model and does not know it is absent will code against something that is not there.
4. **Which files differ from what it last saw**, as a list:

   ```bash
   git -C <lane.workroot> diff --name-only plan/{plan-id-kebab}/phase-{prior.id} HEAD
   ```

   A list is checkable; "things may have changed" invites the agent to decide for itself what to trust. If the diff cannot be computed, say the set is **unknown** and to re-read before editing — never that nothing changed, which is the one wording that would stop it re-reading.

**Start a member cold when their previous phase failed.** Their session is the context that failed with it, and whatever wrong turn it took is exactly what a continuation preserves. Re-reading a repository is cheaper than inheriting a wrong conclusion about it.

### Recycling a lane for its next phase

A bare `checkout` of the next base is not a reset. It refuses a dirty tree, and when it succeeds it keeps every ignored file the last phase left: a type-checker cache from a different tree fails the next phase's typecheck on code it never wrote. Before handing a lane to its next phase, in this order:

1. **Save what is left.** When `git -C <lane.workroot> status --porcelain` shows anything, keep it where nobody has to look for it: `git -C <lane.workroot> stash create` prints a commit holding the tracked changes; store it with `git -C <lane.workroot> update-ref refs/wip/{plan-id-kebab}/{prior.id} <sha>`. Name the ref, and list any untracked paths, in `phase-{prior.id}.md`.
2. **Return the tree to a commit.** Discard tracked changes (`git -C <lane.workroot> reset` with `--hard`; step 1 saved them), then remove untracked and ignored files with `git -C <lane.workroot> clean -fdx`, passing an `-e <path>` for every path the lane's `worktree_summary` records as copied or linked in (dependency directories, env files, the virtualenv). The clean runs before the database reset, never after: it would delete a SQLite file the reset just restored.
3. **Cut the phase branch** from the new base:

   ```bash
   git -C <lane.workroot> checkout -b plan/{plan-id-kebab}/phase-{phase.id} <phase.base_branch>
   ```
4. **Reset the lane's databases to the new base** using the `reset_cmd`s recorded under `state.dev_db` / `state.test_db` in the lane's `worktree_summary` (prepare-worktree writes them, and so may the project's command — drop + recreate from the template, or re-run migrations from zero, per engine). A lane with no `reset_cmd` (or no summary at all), and whose outgoing or incoming phase touches the **Data Model Changes** section, is not safe to reuse: re-provision that lane instead (with the command: [teardown, then prepare again](#teardown-with-the-projects-command)). Never reuse a lane across a migration boundary without the reset.
5. **Install** with the project's install command when the incoming phase's plan body adds dependencies, or the base's lockfile differs from the one the lane last installed.

**A lane that will not recycle is the lane's failure, not the phase's.** When any step above fails (a root-owned file `clean` cannot remove, a database that will not drop), don't retry the phase there and don't count it against the phase. Provision a replacement lane named `<lane name>-r<N>`, move the member and the phase to it (the member starts cold there: its session belongs to the old directory), record the move in `run.md`, and leave the old lane on disk for the user. Its teardown command goes in the final report with the others.

**A gate that was killed leaves containers behind.** A test command that timed out or was cancelled — the harness's own command timeout included — can leave its compose project's one-off containers running, holding the test database. After any such run, remove that project's `*-run-*` containers before the next command in the lane. A `docker` call that itself times out means "unknown", not "none": treat the lane's test database as stale and recreate it before its next test run.

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
git -C <integ.workroot> checkout -b plan/{plan-id-kebab}/integ-{P.id} plan/{plan-id-kebab}/phase-{first-dep.id}
git -C <integ.workroot> merge --no-ff plan/{plan-id-kebab}/phase-{next-dep.id}   # once per remaining dep, in plan order
git -C <integ.workroot> push -u origin plan/{plan-id-kebab}/integ-{P.id}
```

**Keep what the branch already holds.** When `integ-{P.id}` already exists (a resume, a retry of `P`), check it out instead of cutting it again, and merge only the dependencies it lacks (`git merge-base --is-ancestor plan/{plan-id-kebab}/phase-{dep.id} HEAD` is true for the ones it has). Recutting it with `checkout -B` throws away every conflict fix already made on it. Cut it fresh only when it no longer contains its first dependency's tip, because that dependency was rebuilt.

**Gate the base before dispatching `P`.** Every merge into it, clean or conflicted, runs the [merged-tree gate](#gate-every-merged-tree). `P` is not dispatched onto a red base: a red gate after a clean merge goes to the conflict fixer exactly as a conflict does (see [Merge conflicts during integration](#merge-conflicts-during-integration)), because two dependencies that merge cleanly can still break each other.

**Wave integration branches** are the durable spine. `plan/{plan-id-kebab}/wave-0` is `<BASE_BRANCH>`. When every phase at wave `N` has passed review, the conductor builds `plan/{plan-id-kebab}/wave-{N}` in the integration worktree by merging each wave-`N` lane branch into `wave-{N-1}` with `--no-ff`, in plan order, and runs the [merged-tree gate](#gate-every-merged-tree) after each merge. An existing `wave-{N}` that still contains `wave-{N-1}` is kept the same way as an `integ-` branch: merge in only the members it lacks. Wave branches are what a resume anchors on, what the final report points at, and what a phase whose dependency set covers an entire earlier wave may use directly as its base.

### Gate every merged tree

A merged tree is code nobody has run. Each lane's gate ran on its own branch, and two branches that are each green can be red together. So every merge the conductor makes — each dependency merged into an `integ-` base, each lane merged into a wave branch, conflicted or clean — is followed in the integration worktree by:

1. **Generated files, regenerated.** When either side changed a file the project generates (anything AGENTS.md names a generator for, or that opens with a "generated, do not edit" header) or the inputs it is generated from, run that generator and commit what it writes as part of the merge. A schema dump or API client merged line by line is a third version neither side produced.
2. **A test database that matches the tree.** The integration worktree checks out a different branch for nearly every merge, and a reused test database keeps the last tree's migrations. Recreate it with the `reset_cmd` recorded under `state.test_db` in the integration worktree's `worktree_summary` before the test run when any of these holds: the last commit gated here is not an ancestor of `HEAD`; the last test run here was killed or timed out; a migration file changed between the last gated commit and `HEAD`. Record the gated commit in `run.md` after each run.
3. **The full gate, whatever `run_options.full_test_suite` says:** `{{BUILD_CMD}}` and the full `{{TEST_CMD}}`, one at a time.

Green → commit the merge (when it is not committed yet), push, and record the result in `waves/wave-{N}.md`. Red with failures that read as a stale schema (missing or extra columns or tables no model in the tree defines) → recreate the test database and run the gate once more before spending a fixer round. Red otherwise → the fixer loop below, with the failing output.

**Before the plan PR, run every gate on the final wave branch** — the lint and e2e gates included, not only build and tests — so the PR opens on a tree that has passed everything a phase had to pass.

**A phase does not wait for its wave — it waits for its dependencies.** Wave branches are built behind the scheduler, not in front of it: a wave-3 phase whose two dependencies are both green starts immediately, even while other wave-2 phases are still running. The wave branch is bookkeeping and integration; the `depends_on` set is the gate.

### Merge conflicts during integration

The orchestrator **never edits code**, including merge conflicts. When a `merge` stops, or the merged-tree gate is red:

1. **Read why it stopped.** Capture `git -C <integ.workroot> diff --name-only --diff-filter=U`. Two failures look like conflicts and are not, and neither goes to a fixer:
   - **`MERGE_HEAD` exists and no path is unmerged**: git merged, and a commit hook refused the commit. Stage the files the hook rewrote (tracked paths only) and commit once more. Refused again → ask via `AskUserQuestion` (header `Merge hook`), quoting the hook's output: `Fix what the hook reports (Recommended)` (it goes to the fixer as a red gate), `Commit with --no-verify`, `Abort this merge`.
   - **No `MERGE_HEAD`**: git refused before merging (an untracked file in the way, a dirty tree). Show git's message and ask (header `Merge`): `Save the tree to a ref, clean it and retry (Recommended)` (the [lane recycle](#recycling-a-lane-for-its-next-phase)'s save-then-reset steps, run in the integration worktree), `Stop`.
2. **Spawn a fixer** subagent (the project's `fixer` agent type, at the `agent_models.fixer` model) inside the integration worktree. Its prompt carries: the conflicted paths (or the red gate's output, for a clean merge that broke), both phases' bodies from the plan, both phases' `phase-{id}.md` summaries, any earlier fix between the same two phases recorded in `waves/wave-*.md`, and the instruction to resolve for **both** intents — never to `--ours` / `--theirs` a conflict away. It also carries these rules:
   - **Deletions are intent.** What one side removed since the merge base stays removed unless the other side's code still needs it. "Keep both sides" on a block one phase deleted brings back the code that phase was written to get rid of.
   - **Generated files are regenerated, not merged.** A conflicted generated file takes either side, then its generator runs and its output is staged. This is the one place a side is taken whole.
   - **A clean merge can still be broken.** Two migrations added on the same parent by two phases need a merge migration; two registrations of one name need one removed. Look for these even where git reported nothing.
   - **Check what git merged by itself.** Syntax-check every file git auto-merged that both sides touched (`python -m py_compile <file>` for Python, the project's type check for the rest). A clean auto-merge of a list both sides appended to has left two openers that never close.
   - **Fix the cause, not the gate.** Read the gate's output before the code. Never weaken, skip or delete a test, or loosen a check, to turn it green.
   - **A stale environment is not a merge problem.** When the merged tree's failures are missing or extra columns or tables that no model in the tree defines, the integration worktree's test database belongs to another branch. The fixer changes no code and reports `ENVIRONMENT_STALE`; you recreate the test database there and run the gate again, without counting the round.
   - **Stage by name.** Only tracked or conflicted paths, plus a file it created on purpose (a merge migration) added by its own path. Never `git add -A` or `git add .`: tool caches and test databases sit untracked in this tree.
   - **Verify narrowly, one command at a time.** Type-check or test only the files it touched. The conductor runs the full gate next.
3. After the fixer returns, scan the conflicted paths for conflict markers, then run the [merged-tree gate](#gate-every-merged-tree) again. Red → loop back to step 2 with the failure, **handing the next round the tree this one left** rather than resetting it.

   **Red on an unchanged tree.** When a round leaves `HEAD` and `git status --porcelain` exactly as they were and the same gate is still red, the fixer found nothing to fix. Clear the tool caches in the integration worktree (type-checker, test and linter caches), recreate the test database, and run the gate once more. Still red → ask now, as in step 5, instead of spending another round.
4. Green → commit the merge, push the branch, and record in `waves/wave-{N}.md` the conflict, the resolution and any change the fixer made beyond the conflicted lines, so a later merge of the same two phases can be handed it.

   **Flag reverted deletions.** For each conflicted path, compare the resolution against what each side deleted since the merge base (`git diff <merge-base> <side> -- <path>`). Lines a side deleted that the resolution still holds are listed — path, the phase that deleted them, how many — in `waves/wave-{N}.md`, in the user update and in the plan PR description. This flags; it does not block.
5. **The budget.** A merge still red after its fixer-round budget (default **two**) stops. First show the first failing test and its error from the gate's log, and say whether the test database was recreated for that run; a stale database is ruled out before anything is called a plan defect. Then:
   - **A wave build that fails is the wave's failure, not its phases'.** Each phase stays `done`, and its dependents keep running off their own bases; only a phase based on this `wave-{N}` waits. Ask via `AskUserQuestion` (header `Wave merge`), naming both phases and the paths: `Retry the merge from the fixer's tree (Recommended)` (one more budget, starting from what the last round left), `I'll finish it by hand` (the conductor waits, then runs the gate), `Serialize them` (add the edge, re-derive waves, re-run the later phase), `Skip this wave build` (the plan PR is not opened until it is built).
   - **An `integ-{P.id}` base that fails** blocks `P` and its dependents. Ask the same question (header `Integ base`); `Skip this wave build` is not offered.

   Two phases whose merge keeps failing usually own the same code, which is a plan defect rather than a code problem — say so when the paths support it, and recommend `Serialize them` instead.

The budget is an **integration-level** setting, not either phase's `max_fix_rounds`. A conflict belongs to a *pair* of phases, so deriving it from one of them would make the answer depend on which phase happened to merge second.

**Confirming a fix requires reading the files, not asking git.** `git add` clears a path's unmerged flag whether or not `<<<<<<<` is still sitting in it, so git cannot tell you whether the fixer actually resolved anything. Scan the conflicted paths for conflict markers before committing the merge. Skip this and a fixer that did nothing produces a merge commit full of markers that passes straight into the wave branch.

### PRs: one per phase, plus what it takes to reach `<BASE_BRANCH>`

The PR `base` written into the prs-context frontmatter is the phase's **computed `base_branch`** — `<BASE_BRANCH>`, a single dependency's branch, or the `integ-{P.id}` branch. Never `<BASE_BRANCH>` for a phase that has dependencies; a wrong base makes the PR diff include every upstream phase and the review is unusable.

Phase PRs are review units, and on their own they do not land the plan. Under a per-phase PR strategy the conductor also opens:

- **An integration PR per `integ-{P.id}` branch**, into `<BASE_BRANCH>`, just before `P`'s own PR. Without it `P`'s PR targets a branch nothing targets, and nothing stacked on `P` can reach `<BASE_BRANCH>`.
- **A plan PR at run end**, from the final `wave-{N}` branch into `<BASE_BRANCH>`. It is the only branch carrying the conflict resolutions made during wave merges, so **it is the one PR that lands the plan**: merge it, with a merge commit, and no other. Merging the phase PRs one by one instead re-resolves by hand every conflict the wave merges already resolved and gated. Its description lists every phase and integration PR, so a reviewer can read the plan one phase at a time.

The commit strategy's PR-open timing says which files to write and when.
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
        recycle_lane(lane, p)                 # save, reset, clean, branch, DB reset, install
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
2. **Otherwise the cheapest free member at that member's tier, or one tier above it — no higher.** A wave should not serialize behind one agent when a qualified peer is idle. But covering must not quietly promote the phase: an uncapped "at or above" lets a busy wave run every Tier 2 phase on the Tier 4 member's model, and one observed run moved 73 phases up a tier, 23 of them onto one member whose credits then ran out. **Don't borrow a member a pending phase is planned for** — taking them makes that phase wait in turn. A member no pending phase is planned for is fair to borrow.
3. **Otherwise nobody, and the phase waits** — even with a lane free. This is the one place staffing costs throughput, and it is deliberate: a phase run below its tier does not fail cleanly. It produces plausible code that fails review two rounds later, by which point nothing points back at the staffing decision.

An implementer is held for the **whole phase**, not one turn of it: answering the review's findings is the implementer continuing its own session, so handing the phase to someone else mid-flight would hand it to an agent with no session to continue. Release it when the phase settles.

**The wait cannot deadlock.** The floor is the assigned member's own tier, so a waiting phase is always waiting on somebody who is *holding another phase* — never on a qualification nobody on the roster has. If you find yourself with every agent idle and a phase that cannot be staffed, the plan assigned it to a member the **Crew** table does not list; stop and ask.

**Record every claim** with the phase's `planned_tier` and the tier it ran at, and whether it was the plan's own assignment or a peer covering. A run where half the phases were covered by a dearer peer is a run that cost more than the plan said while every phase came back green — and that is invisible in the phase statuses.

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

**`phase-{id}.md`** carries: status, the crew member that took it + the model actually used + whether that member is the one the plan assigned + whether its session was continued from an earlier phase or started cold (and why, when cold) + the reviewer's model, the review iterations, the rejected findings and the settled decisions{{TRACKING_PHASE_BRANCH_FIELD}}, base branch, wave, `depends_on`, e2e + screenshots if any, and the 5–15 line summary the conductor writes **from the git diff plus the agent's report** — not from the agent's narration.

**`waves/wave-{N}.md`** carries: which lane branches were merged, in what order, any conflicts and how they were resolved, and the outer-gate result on the merged tree.

**Migrating a legacy single-file tracking.** A plan started before this layout has `{{PLAN_DIR}}/TRACKING_{plan-id}.md`. On resume: create the directory, split the existing content (run options + graph → `run.md`; each completed-phase entry → its own `phase-{id}.md`), `git rm` the old file, and continue. Say so in the resume report.

**Deletion.** [Step 2](#step-2--final-report) deletes the whole directory (`git rm -r`) on the final integration branch, in one commit. The plan file stays.
<!-- block-end: TRACKING_DIR -->

<!-- block-begin: SIBLING_LANE_ISOLATION -->
**Sibling-lane writes — only when the pool has more than one lane.** The reviewer is bound by this too: it works in the `WORKROOT` of the phase under review, and that lane is the only one it may touch, and only to read. The main checkout is not the only tree an agent can wander into: with a pool provisioned, `<lane-2>/app/models.py` is as reachable from lane 1 as the main checkout is, and a write there is worse than a stray main-checkout write — it lands in a tree another agent is actively editing and testing. The same guard covers both: everything outside the lane's own `WORKROOT` is off-limits.

- **Sandbox** (`SANDBOX_TIER = enforced`): the `--deny` / `--allow` set for a lane denies the **worktree root that holds the pool**, not just the main checkout, and allows only that lane's `WORKROOT` (plus `<main_checkout>/.git` and `<main_checkout>/.vinta-ai-workflows`). One `--deny <pool-root>` covers every sibling.
- **Backstop check** (`SANDBOX_TIER = none`, or as the cheap confirmation when enforced): after every implementer, every review fix round and every conflict fixer returns, run the stray-write check against the main checkout **and every sibling lane's workroot**:

  ```bash
  for tree in <main_checkout> <every lane workroot except this lane's>; do
    git -C "$tree" status --short | grep -vE '^\?\?'
  done
  ```

  Output from a sibling lane is a BLOCKER, handled exactly like a stray main-checkout write: diff it, recover the intent into the correct lane, then `git -C <tree> restore --` it away. Do this **before** the sibling's own review reads its diff — otherwise the sibling reviews foreign changes as its own.
<!-- block-end: SIBLING_LANE_ISOLATION -->
