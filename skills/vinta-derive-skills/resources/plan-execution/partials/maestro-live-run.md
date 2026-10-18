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

Changes to *how* a live run executes rather than *what* the plan builds. None rewrites the plan, so none needs the amendment log. Read `vinta-ai-maestro --help` first: when it lists a dedicated command for one of these (`switch-harness`, `node reassign`, `sync-base`), use that command instead of the generic recipe below.

**Switch the harness or model for the remaining phases.** Get the run's workflow (`vinta-ai-maestro workflow <run-id> > <scratch>/workflow.json`), change the crew members' `harness` / `model` (or `defaults.harness`), `validate` it, and `amend <run-id>` it. A phase already running keeps the harness it was spawned on; the change is refused for it until it settles, or pause that phase first with `node pause`. Run `vinta-ai-maestro doctor <workflow.json> --resume <run-id>` beforehand so a harness that is not installed or not logged in shows up before a phase is dispatched to it.

**Switch the account a harness runs as** (a quota or credit allowance ran out, or the login expired). The run's agents use the login of the environment its job was started from. `vinta-ai-maestro pause <run-id> --wait`, log the harness in as the other account in that shell (or point its config-directory variable at the other account's directory), check with `doctor <workflow.json> --resume <run-id>`, then `run --resume <run-id>` from the same shell, with the same flags as the original start (next recipe). A phase reported as logged out is waiting for exactly this; no timer retries it.

**Resume with the same policy.** Check `vinta-ai-maestro run --help`: unless it says a resume reuses the run's own policy, pass the policy flags again — `--on-failure`, `--retries`, `--retry-after`, `--permission`, `--system-one`, `--no-coordinator` — exactly as the run was started. A resume without them runs on the defaults, which can turn an unattended run into one that waits on every question. Write the start command into the plan's tracking notes when the run starts, so the resume can copy it.

**Move the base branch forward** (the base gained commits the remaining phases need). The run's `base_branch` is fixed for its life, and a config commit never moves it. Pause the run (`pause <run-id> --wait`), merge the base into the plan branch `plan/<workflow-id>/base` with a merge commit — never a rebase: lanes, `integ-` and `wave-` branches are built on its commits — push it, and `run --resume <run-id>`. Phases cut after that build on the new commits, and the wave merges carry them to the rest. When nothing still to run needs them, skip this and resolve against the base once, on the plan PR. Basing the plan on a different branch is a new run, not a move.
<!-- block-end: OPERATOR_RECIPES -->
