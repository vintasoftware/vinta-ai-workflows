# Partial — a plan with a live vinta-ai-maestro run

Included by `amend-plan`. A plan run by [vinta-ai-maestro](https://github.com/vintasoftware/vinta-ai-workflows/tree/main/packages/vinta-ai-maestro) holds its own frozen copy of the workflow, owns the phase, `integ-` and `wave-` branches, and rebases them itself. An amendment that edits only the plan files leaves that run building the old plan; one that force-pushes its branches pulls them out from under it. Both blocks describe the CLI as `vinta-ai-maestro --help` shows it; when a command named here is missing or its options differ, follow `--help` and say so.

<!-- block-begin: AMEND_LIVE_RUN -->
### Is a maestro run live for this plan?

Run `npx --no-install vinta-ai-maestro status --json` from the main checkout. It lists every run in the project; the ones for this plan carry the workflow id of `{{PLAN_DIR}}/<plan>.workflow.json`. When maestro is not installed, or no run of this workflow is `running`, `paused`, `interrupted` or `failed`, there is no live run: skip this block and continue with Step 1. A run that is `done` or `cancelled` is over, and its branches are amended like any other, as below.

When a live run exists, ask via `AskUserQuestion` (header `Live run`), naming the run id and its state:

- `Amend the live run (Recommended)` — edit the plan and the workflow, then hand the change to the run. maestro rebases the done phases the change reaches, in dependency order; this skill rewrites no branch itself.
- `Edit the plan only` — the run keeps building its snapshot. Choose this only when the run will be stopped and the plan run again.
- `Stop` — nothing written.

On `Amend the live run`, Steps 2–5 below are the run's job, not this skill's. Do this instead:

1. **Edit the plan** as Step 1 says.
2. **Edit the workflow to match.** Start from what the run holds, not from the committed file: `vinta-ai-maestro workflow <run-id> > <scratch>/workflow.json`. That copy carries every amendment already applied — the operator's and the run coordinator's — and editing the committed file instead silently reverts them. Change only what the plan change implies: a new node (with `prompt_ref`, `depends_on` with `artifact`, `touches`, `crew`), a changed `depends_on`, a changed `touches` or gate list. Then `vinta-ai-maestro validate <scratch>/workflow.json`.
3. **Commit both files on the run's plan branch**, `plan/<workflow-id>/base` (and wherever the plan lives, when that is elsewhere). Phases cut from that branch afterwards read the amended body. The commit also reaches the run as a `config` amendment, but that path keeps every started phase's definition, so it is not enough on its own.
4. **Apply it:** `vinta-ai-maestro amend <run-id> <scratch>/workflow.json`. Not-started phases take the change at once; done phases whose dependency closure changed are rebased by the run.
5. **A refusal names the running phases the change would move.** Wait for them, or pause each with `vinta-ai-maestro node pause <run-id> <phase>` and run `amend` again. Never stop the run to get past a refusal: a stopped run cannot be resumed.
6. **Record it** under `## Amendments` in the plan, with the run id in place of the branch list.

A done phase whose PR is already open is updated by the run's rebase. Tell the user which PRs will move before step 4; Step 3's approved-PR question applies to them too.
<!-- block-end: AMEND_LIVE_RUN -->

<!-- block-begin: OPERATOR_RECIPES -->
## Operator recipes for a live maestro run

Changes to *how* a live run executes rather than *what* the plan builds. None rewrites the plan, so none needs the amendment log. Each one is a dedicated command; check its options with `vinta-ai-maestro <command> --help` before running it.

**Move the whole run off a harness** (an account ran out of credits, a harness is down). `vinta-ai-maestro switch-harness <run-id> --from <harness> --to <harness> --model <model>` moves it without pausing: phases in flight are reassigned at the pipeline step they reached, phases not started yet run on the new harness, and the conflict fixer moves too. `--after-turn` lets each live turn finish first. Run `vinta-ai-maestro doctor <workflow.json> --resume <run-id>` beforehand, so a harness that is not installed or not logged in shows up before anything is moved to it.

**Hand one phase to another member or model.** `vinta-ai-maestro node reassign <run-id> <phase> --crew <member>` (or `--harness <h> --model <m>`) interrupts the phase, changes who holds it and lets it carry on at the same step. The same member on the same harness keeps its session; anyone else starts fresh with a hand-off (the last report, the work in the lane, the red gate). To stop a phase's turn without failing it — to look at its lane, say — use `node interrupt <run-id> <phase>`; it is held, with its lane and its uncommitted work, until `resume`, `reassign` or `step` lets it go.

**Run as another account.** An account is a harness profile: a binary and an environment named once in maestro's `profiles.yaml` (see its README). Start or resume with `--harness-profile <name>`. A phase reported as logged out is waiting for a login or a profile change; no timer retries it.

**Resume.** `vinta-ai-maestro run --resume <run-id>` picks a paused, interrupted or failed run back up under the policy it was started with — permission, failure policy, retries, coordinator, host and harness profile are stored with the run. Pass a flag only to change it.

**Carry a fix on a phase branch into the run's integration branches.** `vinta-ai-maestro propagate <run-id> <phase>` merges that phase branch into every `integ-` and `wave-` branch that contains it, keeping the wave chain, and pushes them. `--dry-run` shows the merges first. It stops at a conflict and leaves that branch as it was.

**Move the base branch forward** (the base gained commits the remaining phases need). `vinta-ai-maestro sync-base <run-id>` merges the moved base into `plan/<workflow-id>/base` and every wave, in order, with merge commits — never a rebase, since lanes, `integ-` and `wave-` branches are built on those commits. On a live run a wave's conflict goes to the run's conflict fixer. When nothing still to run needs the new commits, skip this and resolve against the base once, on the plan PR. Basing the plan on a different branch is a new run, not a move.
<!-- block-end: OPERATOR_RECIPES -->
