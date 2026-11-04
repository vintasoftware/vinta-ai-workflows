# Changelog

All notable changes to `vinta-ai-workflows` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.1] — YYYY-MM-DD

### Changed

- **`vinta-ai-maestro`: the run graph shows the run, not just the plan.** A
  running phase's card names the pipeline step it is on (`gate`, `review`, …)
  and wears its colour on every side with a soft glow; a phase parked on
  capacity wears amber. The edges follow: a dependency that has landed turns
  green, and one a running phase is consuming flows blue (still, under
  reduced motion). The resource pools that matter now sit directly under the
  canvas, beside the cards they park, so a node that is not moving is
  explained without a scroll. The DAG canvas gained an optional `step` on its
  nodes and two host-bindable properties, `--vdag-edge-done` and
  `--vdag-edge-active`, for this.
- **`vinta-ai-maestro` signs with the Vinta wordmark and calls itself AI
  Maestro** in the run monitor's and the interview page's top bar, blue in
  light mode and the text colour in dark. The package, the command and the
  storage keys keep their `vinta-ai-maestro` name.

### Fixed

- **A DAG card no longer hangs out of its wave band.** The canvas sized its
  cards with a minimum height while the bands and the scene were computed
  from that same number as if it were exact, so a two-line name overflowed
  the band. Cards are now drawn at exactly the slot the layout reserves
  (96px, room for a two-line name and the status row with a step).

## [0.7.0] — YYYY-MM-DD

<!-- Graduates the 0.7.0-alpha1 … 0.7.0-alpha39 series (2026-09-11 to
     2026-10-24). This section is the net change since 0.6.1. The
     alpha-by-alpha record is in the GitHub pre-releases and in this file's
     git history before the release commit. -->

### Added

- **`vinta-ai-maestro`: a `plan-feature` plan runs itself, phases in parallel,
  with you steering from a terminal or a browser.** A new workspace package,
  `packages/vinta-ai-maestro/`, published as its own npm package under the same
  version number as `vinta-ai-workflows` and run with `npx vinta-ai-maestro`
  (Node ≥ 22). It is not part of the `vinta-ai-workflows` tarball: what reaches
  the skills package is the generated schemas below and the skill changes that
  produce and consume them. [SPEC.md](packages/vinta-ai-maestro/SPEC.md) is the
  authority and the package README is the operator's manual.
  - **A run.** `run <workflow.json>` starts the plan's `.workflow.json` as a
    background job and returns; closing the terminal changes nothing
    (`--foreground` keeps it in the process, for CI). The run works on a plan
    branch, `plan/<workflow-id>/base`, cut from `base_branch`. Each phase gets a
    crew member, a lane — a git worktree with its own copy of the dependency
    dirs, forked `dev` / `test` databases, an isolated compose project, a
    namespace in each shared service, the declared `env_files` and a
    `setup_cmd` — and the `standard-phase` pipeline: implement, gates, review,
    polish chores, verify, integrate (merge, gates on the merged tree, push,
    PR), `after_pr` chores. A phase with one dependency branches from it, one
    with several from an `integ-<id>` merge; each wave merges into
    `plan/<id>/wave-<N>`, and the last wave opens the plan PR, the one PR that
    lands the plan. `run --resume <run-id>` picks a paused, interrupted or
    failed run back up with the policy it was started with. Policy flags:
    `--on-failure retry|ask|stop` (default `retry`: one cold attempt, then a
    question), `--retries`, `--retry-after <15m>` (an unanswered failure
    question answers itself, backing off when attempts fail fast),
    `--agent-answer-after` (how long an agent's own question waits before the
    recommended options are taken), `--permission ask|auto|full|judged`
    (default `auto`), `--harness-profile <name>` (a named binary and
    environment — a second account, say — from
    `~/.config/vinta-ai-maestro/profiles.yaml`), `--system-one <config.json>`,
    `--no-coordinator` and `--coordinator-authority full`.
  - **Harnesses.** claude-code, codex (`codex app-server`, codex-cli ≥ 0.147.0)
    and opencode, behind one adapter contract: spawn, resume, inject a message
    into a running turn, wait for background work, compact. A quota, rate-limit
    or concurrency refusal parks the harness, not the phase, until the reset
    time the vendor stated; `defaults.model_fallbacks` and
    `defaults.harness_fallbacks` move the refused spawn to a fallback instead;
    a provider outage re-runs the phase when the harness answers, charging
    nothing to its attempts; a logged-out CLI asks you to log in. Sessions
    start one at a time per harness, and the ceiling a run discovers is kept
    for the next one.
  - **The crew.** A plan staffs a team, the Crew table `plan-feature` writes:
    one member per agent with a tier, a model and a harness, and every phase
    assigned to one of them. A member keeps its worktree and its session across
    the phases it takes, so what it learned in phase 1 is still there in
    phase 4. A busy member is covered by the cheapest qualified free peer or by
    a spare in its image (`defaults.max_spare_crew`, default 2); a phase is
    never handed below its tier (`defaults.substitution`, default
    `up_one_tier`); a phase its review keeps rejecting moves up a tier
    (`defaults.escalate_after_rejections`, default 3); a merge conflict goes to
    the most senior member who wrote one of its sides.
  - **Gates.** A gate is a shell command, by type (`test`, `lint`, `typecheck`,
    `e2e`, taking the project's `commands.*`) or by a project-wide id
    (`maestro.gates.<id>`), or a judge question put to a System One classifier.
    Phase gates run a `scoped_cmd` (`{changed_files}` / `{touches}`) until the
    review approves; `verify` then runs the full `cmd` on the phase branch, and
    the full suite runs on every merged base and wave (`verify_gates`,
    `base_gates`, `wave_gates`, all full by default). Results are cached per
    gate, command and tree. `fresh_cmd` and `fresh_when` run a gate from a
    fresh test database when the tree moved under it; `cold_cmd` and
    `scope_cache` cover a lane with no test cache; `timeout_s`,
    `queue_timeout_s` and `tuning.allowed_flags` bound and retune a gate.
    Resource pools (`resources`, `scope: run | host`) serialise the heavy ones
    across lanes, and across every maestro run on the machine. Agents run a
    gate with `vinta-ai-maestro gate <id>` and take a pool with
    `vinta-ai-maestro with <resource> -- <cmd>`; on claude-code a `PreToolUse`
    gate guard refuses the bare command, and `--permission judged` asks a
    classifier about each shell call. `codegen` steps regenerate generated
    files rather than merging them, `append_only` files merge as a union,
    `post_merge` runs a formatter over what git merged, and `ci_only` records
    the CI checks deliberately left to CI.
  - **Review and chores.** Once a phase's gates are green, the implementer's
    own session runs the `review` chore, `thermo-nuclear-review-loop`: one
    reviewer sub-agent, each finding verified and fixed or rejected with
    counter-evidence, until the reviewer explicitly approves. A phase's
    decisions — answered questions, operator context, rejected findings — are
    kept and carried into every later prompt, so nothing is asked twice.
    `deslop` and the project's other `after_review` chores run before verify;
    `after_pr` chores (a review canvas, say) run once the PR is open. A chore
    reporting `Status: FAILURE` is recorded as failed. `max_fix_rounds` is
    unset by default, which means no limit; set it to be asked.
  - **Integration.** A conflict goes to a conflict fixer in the integration
    worktree, with a time limit per round and its resolution gated by the union
    of both phases' gates; what a round left is kept under
    `refs/vinta-ai-maestro/` across attempts. A resolution that undoes a
    phase's deletion is flagged. A merge git or a hook refuses goes to you.
    Every phase and integration PR carries a **Landing** section pointing at
    the plan PR; `land <run>` says how a finished run lands and closes the PRs
    whose work is already in the base; `propagate <run> <phase>` carries a late
    fix into every `integ-` and `wave-` branch; `sync-base <run>` brings a moved
    `base_branch` into a live plan.
  - **Steering.** `status`, `logs [-f]`, `logs --failures <gate-log>`, `pause`,
    `stop`, `node context|redirect|pause|resume|abort|retry|fresh|answer`,
    `node interrupt|reassign|step` (take a phase over at its step without
    failing it), `switch-harness`, `fixer interrupt|reassign`, `workflow`,
    `amend` (a live run takes an edited workflow, rebasing the done phases the
    change reaches), `exec <run> <lane|integration> -- <cmd>` (a command with
    the lane's environment, holding the integration worktree while it runs),
    `gate-cache invalidate`, `purge [--lanes --branches]` (never the only copy
    of work), `doctor` (every check a run depends on, from disk and servers to
    env files, compose `-T`, gate scope and the CI jobs no gate covers),
    `validate`, `simulate` and `judge calibrate`. Every acting request takes a
    reason, journalled with what it explains.
  - **The run coordinator.** One agent per run, woken when a phase fails, an
    attempt errors, a phase waits on the integration worktree or a gate crosses
    its cost threshold, at most 24 times a run. It reads the journal and the
    repository and acts through the same API as you: steer, pause, retry,
    answer the questions a timer could answer, amend the live run, run a
    command. It may change how the run executes, never what it builds, and
    never weakens a check. Everything decided without you — by it or by a
    timer — is listed in `status`, the run view, the plan PR and the
    post-mortem.
  - **The browser UI.** `ui` serves every run in the project and hosts none,
    so closing it interrupts nothing. A run view with the plan graph, the
    roster, the integration worktree's record, resource pools, sessions and
    cost, what was decided without you, a notifications inbox and the
    coordinator as a sidebar; a phase view with the transcript rendered the way
    the harnesses render it, the phase's running processes and gates, its
    changes as a diff, its integration timeline, its PR, and steering as a chat
    input; an analytics page while the run goes and the post-mortem as a report
    after; a Logs view over the daemon's own log; a workflow editor that saves
    only what you changed; Pause, Stop, Retry and Resume. Every page fits a
    phone, in light and dark.
  - **The record.** Everything lands under `.vinta-ai-maestro/` (gitignored):
    the run's journal, each phase's transcript with the role that wrote each
    line, gate logs, the daemon's own log (`logs/daemon.ndjson`, identifiers
    only, enforced), and once the run ends a post-mortem (`postmortem.v1`):
    dependencies declared but unused or discovered at gate time, conflicts,
    the critical path, idle capacity, gate costs, failure causes, crew
    substitutions, failed chores and unattended decisions. `plan-feature` reads
    it before planning the next feature in the same repository.
  - **Security.** The daemon binds loopback and every API request carries a
    token. Agents hold a token of their own that reaches only their leases,
    gates and hooks; the coordinator has one of its own; a run's job keeps its
    token in a `0600` file that `ui` never prints. Nothing in the journal or
    the log holds repository contents, and every token is redacted from both.
    The only API key the package ever uses is the one a `--system-one`
    classifier config names; the harnesses run on your logged-in CLIs.
  - **Platforms.** macOS, Linux and Windows, each in CI.

- **`vinta-design-system` and `vinta-dag-editor`**, two more workspace
  packages maestro's UI is built on: oklch tokens in three layers, six
  run-status tones (waiting is amber and failure is red, never the same hue),
  shadcn/ui components on Tailwind CSS v4 and a light/dark/system theme; and
  the framework-agnostic Web Component that draws and edits plan DAGs —
  arrowed edges, dependencies drawn by dragging, phase ids on the cards, a
  details strip, keyboard zoom, full screen. They publish on their own cadence
  as dependencies of `vinta-ai-maestro`; nothing in either reaches
  `npx vinta-ai-workflows install`.

- **Plan review: a page for a plan before it runs, and a chat with the agent
  that wrote it.** `vinta-ai-maestro review open <workflow.json>` serves the
  plan's graph with every phase's real prompts, the plan's markdown, a phase ×
  gate matrix, the projected schedule and what `validate` reports. You comment
  on the plan, a phase, a prompt or a gate and send the batch; the agent answers
  through `review wait` and `review reply`, edits the plan, and **Approve plan**
  ends the loop. The review is committed beside the plan as
  `ai-plans/<id>.review.json` (`plan-review.v1`, see
  [packages/vinta-ai-maestro/SPEC.md § 19](packages/vinta-ai-maestro/SPEC.md)).
  When maestro is installed, `plan-feature` runs `validate --json` on every
  workflow it writes and asks whether to review on the page, in chat, or later.

- **The browser interview.** A decision-heavy interview — `create-spec`'s
  Step 0 first — can run as a full-screen browser form instead of a chat
  exchange: one decision per screen with the context the agent already knows,
  Markdown, Mermaid or HTML explainers, option cards that state each option's
  consequences with the recommended default marked, and a question panel for
  asking the agent. Round-based and file-based, so it works the same under
  every harness: the agent writes
  `.vinta-ai-workflows/interviews/<slug>/rounds/round-NN.json`
  (`interview-round.v1`), blocks on `vinta-ai-maestro interview wait`, and
  resumes when the page submits `answers/round-NN.json`
  (`interview-answers.v1`). The page is maestro's
  (`interview start|wait|status|stop --dir <dir>`,
  [SPEC.md § 20](packages/vinta-ai-maestro/SPEC.md)), rendered with the design
  system; the server binds loopback, carries a token in the printed URL,
  serves documents only from the interview's `docs/` and accepts a round's
  answers once. Opt in with the new `interview-ui` foundation skill (bootstrap
  **Optional foundation skills** question 7, `foundation_skills.interview-ui`
  in the config schema); it ships `SKILL.md` and an example round, and needs
  `vinta-ai-maestro` runnable from the project (`npx --no-install
  vinta-ai-maestro` when it is a devDependency, `npx vinta-ai-maestro`
  otherwise). `create-spec` asks once per interview whether to decide in the
  browser or in chat; projects without the skill see no change.

- **`thermo-nuclear-review-loop` foundation skill.** A review-and-fix loop
  over a change: the agent running it spawns one reviewer sub-agent, checks
  each finding against the code, fixes the justified ones and answers the rest,
  until the reviewer explicitly approves under a strict code-quality standard.
  Questions only a person can settle — unreachable scenarios, requirement
  ambiguity, destructive operations — go to them instead of being assumed.
  Always shipped (`foundation_skills.thermo-nuclear-review-loop`), because
  `review-phase` runs it and every maestro workflow names it in its `review`
  chore; also invokable on its own.

- **`plan-feature` emits an executable workflow and staffs a crew.**
  `ai-plans/YYYY-MM-DD-<feature-kebab>.workflow.json` lands beside every plan,
  unconditionally — a project with no orchestrator carries a file nothing
  reads, and one that adopts maestro later finds its plans already executable.
  It is the same phase graph in the form a run loads: one node per phase,
  `depends_on` from each phase's `**Depends on**:` line, its Touch List, gates,
  pools and crew member, validated by `workflow.v1`. The plan opens **Phased
  Rollout** with a **Crew** table and an **Execution graph** table, and every
  phase carries `**Assigned to**:` and `**Depends on**:` lines; they replace
  `**Suggested AI model**:`, which old plans may keep. The skill asks what a
  phase lane needs its own copy of and writes the workflow's `project` block,
  emits the codegen steps and append-only files it detects in the project,
  writes the crew's model fallbacks, puts a contract test for any interface two
  parallel phases share into the foundation phase, and reads the post-mortems
  of earlier runs before drawing the next graph.

- **`implement-plan` runs independent phases in parallel** on the skills path
  too, with no maestro. The plan carries a dependency graph and the conductor
  schedules against it: a phase starts as soon as every phase it depends on is
  green and a worktree lane is free. A chain-shaped plan behaves exactly as
  before. Lanes are a pool of worktrees, branches base on their dependencies
  (`integ-<id>` for several, `plan/<id>/wave-<N>` per wave), tracking is a
  directory with one file per phase so wave merges never conflict on it, a
  sibling-lane write guard covers the pool, and `modular-commits` keeps its
  atomic units on lane branches. Two new config fields:
  `run_options.implement-plan.parallel_phases` (default `true`) and
  `max_parallel_lanes` (default `3`). The skill refuses rather than degrading
  when parallel execution is asked for and worktrees are unavailable.

- **Provision worktrees with your own script instead of the `prepare-worktree`
  skill.** Set `commands.worktree_prepare` (and optionally
  `commands.worktree_teardown`) in `.vinta-ai-workflows.yaml`; `implement-plan`
  and maestro run that command for every lane and the integration worktree,
  with `VINTA_WORKTREE_NAME`, `_PATH`, `_BRANCH`, `_BASE_REF`, `_KIND`,
  `VINTA_MAIN_CHECKOUT`, `VINTA_PLAN_PATH` and `VINTA_WORKTREE_SUMMARY` set,
  and check the result with git rather than trusting the exit code. The
  bootstrap offers existing worktree scripts `vinta-analyze-codebase` found,
  and can write the scripts for you — `prepare.sh`, `teardown.sh` and `lib.sh`
  under `scripts/worktree/`, from templates that carry the contract, dry runs,
  rollback, compose isolation and a teardown that refuses a dirty worktree.

- **Agents stop for input with clickable questions instead of prose.** Every
  skill and sub-agent asks through the harness's structured question tool
  (Claude Code's `AskUserQuestion`, OpenCode's `question`, Codex's
  `request_user_input`, Cursor's `AskQuestion`, Copilot's `askQuestions`,
  Gemini CLI's `ask_user`): 2–4 options with descriptions, the recommended one
  first. `AGENTS.md` gains an **Asking the human** section, copied verbatim
  from
  [`vinta-write-agents-md/resources/asking-the-human.md`](skills/vinta-write-agents-md/resources/asking-the-human.md).
  Sub-agents, which cannot ask, return `status: NEEDS_INPUT` with the question
  in the tool's shape, and the new `plan-execution/partials/relay-questions.md`
  turns it into a question, records the answer and continues the same agent.
  Every prose stop point across the plan-execution unit, the foundation skills
  and the bootstrap skills became such a question. `vinta-sync-ai-tools` adds
  a one-time migration for existing projects.

- **PR Review Canvas integration (`integrations.pr-review-canvas`).** The
  bootstrap offers [PR Review Canvas](https://github.com/vintasoftware/pr-review-canvas)
  as its first *integration*: an external tool that installs its own skill,
  nothing of which is bundled here. A new optional top-level `integrations`
  object in the config schema records the opt-in (interview group D.2, asked
  when `code_host` is GitHub or GitLab and `pr_creation` is `agents-create`).
  When enabled, `vinta-install-ai-tools-setup` runs `pr-review install-skill`
  (the CLI is never auto-installed; the install command is printed), the
  `integrate-phase` PR step runs `/pr-review-canvas <n>` after `open-pr.sh`
  publishes, and `plan-feature` adds an `after_pr` `review-canvas` chore to the
  workflow it writes. The analysis, derive and update skills treat an
  integration-owned skill as the tool's and never edit it.

- **Model fallbacks for models that run out of quota.** `ai-models.yaml`
  entries take `fallback:` (the shipped table sets
  `claude-fable-5-1 → claude-opus-5-5` and `gpt-6-astra → gpt-5.6-sol`),
  `ai-models.v1.schema.json` gains the optional field, the nightly
  `check-ai-models` job checks fallback ids for staleness, `plan-feature`
  writes the map into each workflow's `defaults.model_fallbacks`, and the
  plan-execution skills follow the same rule when maestro is not running them.

- **Five generated JSON Schemas, and the schemas are checked.**
  [`workflow.v1`](schemas/workflow.v1.schema.json) (the executable plan),
  [`postmortem.v1`](schemas/postmortem.v1.schema.json),
  [`plan-review.v1`](schemas/plan-review.v1.schema.json),
  [`interview-round.v1`](schemas/interview-round.v1.schema.json) and
  [`interview-answers.v1`](schemas/interview-answers.v1.schema.json) are
  generated from zod sources in `vinta-ai-maestro` and byte-compared in its
  tests; see [`schemas/README.md`](schemas/README.md). `npm run
  validate-schemas` (part of `npm test`) compiles every schema under `schemas/`
  with Ajv in strict Draft 2020-12 mode and checks the fixtures in
  `tests/schema-fixtures/`: `valid/` must pass, `invalid/` must fail.

- **Config schema (`vinta-ai-workflows-config.v1`), all additive.** A `maestro`
  section holding what every plan used to repeat — gates by type and by id,
  resources (with `scope`), chores, `defaults` (gates, harness, pipeline,
  `gate_scope`, `verify_gates`, `base_gates`, `wave_gates`,
  `pull_requests: phase | plan`, `max_spare_crew`, `substitution`,
  `escalate_after_rejections`, `model_fallbacks`, `harness_fallbacks`), the
  `project` block (databases, services, `env_files`, `setup_cmd`,
  `prepare_cmd`, `reset_cmd`, `recycle_keep`, `hooks`, `lane_seed`), `codegen`,
  `append_only`, `ci_only` and `post_merge` — which maestro layers each plan
  over (`commands.*`, then `maestro.*`, then the plan, then the run's own
  amendments). Also `integrations`, `foundation_skills.interview-ui`,
  `foundation_skills.thermo-nuclear-review-loop`, `commands.worktree_prepare`
  / `worktree_teardown`, `commands.worktree_candidates`, `commands.lint_scoped`
  and `run_options.implement-plan.parallel_phases` / `max_parallel_lanes`. The
  bootstrap interview asks for each (maestro defaults are group C.11, with
  follow-ups on `env_files`, the test gate in lanes, a fresh-database form,
  when the full suite runs, CI checks with no gate, and test-tool caches
  missing from `.gitignore`), and `vinta-sync-ai-tools` offers them to
  existing projects. `prs-context-frontmatter.v1` gains an optional `kind`
  (`phase | integration | plan`).

### Changed

- **`plan-feature`: plans have fewer, longer phases.** The phase size ceiling
  rises from 1500 to 4000 LoC, tests included, and the sub-phase trigger moves
  to that same ceiling; the Step 0 **Phase granularity** default flips to
  bundling closely-related use-cases into one phase, with one use-case per
  phase as the opt-in answer. A phase of a few hundred lines has to justify
  standing alone. A plan drawn before the change is still valid as written.
  The skill also tells the author to read the CI config and give every locally
  runnable CI job a gate (and to record the rest under `ci_only`), treats two
  parallel phases adding migrations to the same app as file overlap, treats a
  rename of a shared symbol as an interface change, names the enum for
  same-named choice fields two phases expose, lists the usual append-only
  registries, tells authors to declare the gitignored files a lane needs under
  `project.env_files`, and states that `gates: []` means *none*. Its AI model
  tiers cite the latest OpenAI, Anthropic and Google releases
  (`claude-sonnet-5-5`, `gpt-6.1-sol`, `gemini-3.1-pro-preview`); tier
  placement is unchanged. Re-derive the skill to pick these up.

- **`implement-plan` and its sub-skills follow what maestro learned from real
  runs.** Implementers commit when a gate stays red and report `FAILURE`
  naming the gate; an uncommitted file does not exist as far as the run is
  concerned. They run every command in the foreground, never hand-edit a
  generated file, and list every gate they ran and its result; the conductor
  reviews only a `SUCCESS` report whose gates are all green. Every spawn of a
  phase carries the decisions already made in it, and a resumed implementer
  checks the branch for committed work first. Every merged tree runs the full
  gate, whatever the `full_test_suite` answer is, and the Quick test scope
  means scoped tests until the review approves and the full suite once before
  integration. The merge fixer keeps what a side deleted, stages by name,
  verifies narrowly, and confirms a resolution by scanning the files for
  markers, never by asking git; a merge refused by a hook or by git goes to
  the human. A member moved to its next phase is told first that its objective
  changed; a continuation that fails is retried cold with the full brief; an
  outage or an expired login asks `Wait and retry` / `Switch model` / `Stop
  the run` rather than escalating the tier. Lanes are recycled fully between
  phases, leftovers saved to a `refs/wip/` ref first. A dispatched phase agent
  does the work itself: every composed implementer prompt and a guard at the
  top of each conductor refuse to hand a phase to a sub-agent. The plan PR is
  the one PR that lands the plan, and every phase and integration PR says so.
  Re-derive the skills to pick this up; plans and tracking directories written
  before the change still work.

- **`review-phase` runs the thermo-nuclear review loop.** Each phase is
  reviewed by `thermo-nuclear-review-loop`, hosted by the conductor because a
  sub-agent cannot spawn sub-agents of its own: one reviewer one tier above the
  phase's implementer (a Tier 4 phase is reviewed at Tier 4), each round of
  findings handed to the phase's own implementer, which verifies, fixes or
  rejects with counter-evidence and commits the round. A reviewer pass with no
  verdict is continued once and never counts as approval; a finding re-raised
  without new evidence is rejected on the spot; after 3 rejecting passes a
  fresh implementer one tier up takes over; after 20 passes that still return
  blockers the conductor asks whether to continue, stop the phase unapproved,
  **Accept as is** (integrated with its open blockers recorded) or amend the
  plan. After approval the implementer runs `deslop-comments` over the
  comments the phase added.

- **`amend-plan` cascades along the dependency graph, and amends a live
  maestro run.** A rewrite touches the amended phase's dependent closure
  instead of "every phase with a higher number", rebases in topological order,
  rebuilds `integ-` bases first, refuses to run while a phase is in flight, and
  gains a `dependency-change` amendment kind. When a maestro run of the plan is
  running, paused, interrupted or failed, the skill asks whether to amend it,
  edits the plan and the run's own workflow copy, commits both on the plan
  branch and applies them with `vinta-ai-maestro amend`; it also carries the
  operator recipes for a live run (`switch-harness`, `node reassign`, `node
  interrupt`, `--harness-profile`, `propagate`, `sync-base`).

- **`prepare-worktree`: worktrees get their own copy of the dependency dirs,
  never a symlink.** A symlinked `node_modules` / `vendor/` / `venv/` sent
  writes back into the main checkout and made parallel worktrees race on one
  tree. The skill copies every dependency dir with a copy-on-write clone
  (`cp -ac` on macOS, `cp -a --reflink=auto` on Linux) and reinstalls
  virtualenvs and yarn PnP; `skills.prepare-worktree.deps_strategy` now
  defaults to `copy`. The skill also documents provisioning a pool of lanes for
  one plan with a `reset_cmd` per forked database, and its summary's `|`
  alternatives are closed sets read by machine. **Consumers:** re-sync to pick
  up the new body; worktrees that already exist keep their links until they
  are re-provisioned.

- **`create-spec` offers a browser surface for its Step 0 interview** when
  `ai-tools/skills/interview-ui/` exists (see **The browser interview** above).
  The question bank, clarity loop, read-back and exit conditions are
  unchanged.

- **`write-unit-test`: time-independent tests and deterministic generated
  output.** Rule 8 requires a frozen clock and an explicit timezone on any test
  touching dates, and host-independent schema or client generation. The Django
  pack and stack notes spell out `freezegun` / `time-machine` with
  `override_settings(TIME_ZONE=...)` and `tzdata`-sourced timezone choices.

- **Django stack notes** cover database reuse and testmon in lanes, keeping
  the virtual environment out of a bind-mounted worktree, registries every
  phase appends to, drf-spectacular `ENUM_NAME_OVERRIDES` for new choice
  fields, and the CI-mirroring checks a plan's gates should carry
  (`manage.py check --deploy --fail-level WARNING`, `makemigrations --check`,
  a regenerate-and-diff gate for a schema or client).

- **The bootstrap and sync skills.** `vinta-bootstrap-ai-tools` asks the new
  questions listed under **Config schema** above, no longer offers `symlink`
  for dependency dirs, and no longer asks for a reviewer tier; the **Optional
  foundation skills** group grows to eight questions (`interview-ui` is 7,
  `handoff-to-client` moves to 8). `vinta-analyze-codebase` records existing
  worktree scripts and integration-owned skills. `vinta-sync-ai-tools` carries
  the asking-the-human migration, offers the PR Review Canvas integration to
  existing projects as an `opt-in-offer`, and re-renders the plan-execution
  skills together. Every generated skill now carries
  `disable-model-invocation: true`.

- **`agent_models.fixer` now sets only the merge-conflict fixer's tier.** The
  phase's own implementer fixes review findings at its own tier, so a project
  that set `fixer` cheap to save money is saving it on fewer rounds.

### Deprecated

- **`agent_models.reviewer` is ignored.** The review runs one tier above the
  phase's implementer, so no configured tier is read. The key stays in the v1
  config schema so existing configs still validate; drop it at your next edit.

- **`skills.prepare-worktree.deps_strategy: symlink`** stays in the schema
  enum so existing configs validate, but is deprecated and read as `copy`.
  Change it to `copy` (or `reinstall`) in `.vinta-ai-workflows.yaml` to stop
  the interview default from being re-emitted.

### Removed

- **The three-layer phase review.** `review-phase` no longer runs the
  mechanical checks (including the review-time secret scan, dependency-license
  check and co-author trailer check), the plan-compliance walkthrough
  (including the comment-hygiene check), the crew reviewer, or a separate
  fixer per finding; the thermo-nuclear review loop replaces them. The
  implementer's own install-time license check and co-author rules are
  unchanged.

- **Reviewers on the plan.** `plan-feature`'s Crew table has no `Role` column
  and no reviewer rows, and phases have no `**Review models**:` line.
  **Migration:** plans written with them still run; `implement-plan` ignores
  them.

### Fixed

- **`open-pr.sh` posts inline comments on macOS and reports why a comment
  failed.** Four bugs in the `open-pr-from-context` script, all seen while
  publishing a stacked plan from a Mac: a GNU-only `sed` idiom that BSD `sed`
  rejected, so trailing blank lines were never trimmed; a lowercase
  `side: right` that GitHub answered with "422 Validation Failed", now
  upper-cased; `gh api` and `glab api` stderr thrown away, so a failed comment
  gave no reason; and a multi-line `awk -v` that BSD `awk` rejected when
  adding to a `## Publish log` section. Projects that patched their own copy
  can re-sync with `vinta-sync-ai-tools`.

- **`check-ai-models` no longer mistakes sibling models for snapshots of a
  cited id.** The matcher used substrings, so `claude-sonnet-5` matched
  `claude-sonnet-5-5` and hid the newer release, and `gemini-3-pro` matched
  `gemini-3-pro-image` so a retired model still looked available. It accepts
  only exact ids, dated or `-vN` snapshot suffixes, and provider prefixes.

- **`implement-plan`'s final report no longer suggests `docker compose down -v`
  to tear down a lane.** `down -v` also deletes the compose volumes a worktree
  deliberately shares with the main checkout. The report prints the sequence
  `prepare-worktree` documents: `docker compose -p <project> down`, then
  `docker volume rm` for each forked volume, then removal of the generated
  compose override.

- **`prepare-worktree` serialises `git worktree add`, not only the database
  template.** Git rewrites `.git/worktrees/` metadata on every add, and
  concurrent adds against one repository clobber each other's entries.
  Worktrees are added one at a time; the per-lane work around them still
  overlaps.

## [0.6.1] — 2026-08-17

### Fixed

- **Codex sub-agent descriptions are emitted as valid TOML basic strings.**
  Newlines and other control characters are escaped when
  `setup-ai-tools.mjs` generates `.codex/agents/*.toml` files.

## [0.6.0] — 2026-08-17

### Changed

- **`write-unit-test` now covers the bug-fix case.** The shipped skill body
  gains a **Regression tests** section. A bug fix ships a test that fails
  without the fix; when the test came second, revert the fix to check. Name the
  test for what must not happen. Assert the cause too, when the visible symptom
  can look right while the bug is still there. Record a state that settles
  instead of only its final value. This adds one narrow exception to universal
  rule 6, which otherwise keeps tests decoupled from internals. When no test can
  cover the regression, the PR says so and a comment gives the reason.
- **`stacks/react.md`** shows how to record a value on every render, so a bug in
  a state that settles cannot hide behind the final UI. It also notes that
  `waitFor` hides the same bug.
- **`systematic-debugging`** Phase 3 accepts the case where the fix came before
  the test: revert the fix to prove the test fails. Phase 4 covers the
  regression no test can reach, and the verification checklist asks for the
  revert check.
- **`deslop-comments`** rule 2 no longer accepts a bug fix as a reason to keep
  "not X, it's Y" framing. The regression test is the record.
- **`AGENTS.md` now lands at the repo root as a regular file, not at
  `ai-tools/AGENTS.md` behind a root symlink.** The doc was always *read* from
  the root through that symlink, so its links were written as repo-root paths —
  which broke the moment anyone opened the real file at `ai-tools/AGENTS.md`, on
  GitHub or in an editor that follows the real path. One location means one set
  of links that resolves for every reader. `ai-tools/` still owns skills,
  sub-agent definitions, and the setup script; only the conventions doc moved
  out. Mirrors the change [vintasoftware/building-blocks#403](https://github.com/vintasoftware/building-blocks/pull/403)
  made by hand, so the next sync into that repo no longer reverts it.

  Wiring that changed in
  [`setup-ai-tools.mjs`](skills/vinta-install-ai-tools-setup/resources/setup-ai-tools.mjs):

  - The script no longer creates a root `AGENTS.md` symlink. It creates the
    per-vendor aliases instead — `CLAUDE.md → AGENTS.md` when `claude` is a
    selected vendor, `.github/copilot-instructions.md → ../AGENTS.md` when
    `copilot` is. Both are gated on `--only`, matching the script's own rule
    that unlisted vendors are left untouched.
  - `ensureSymlink` now resolves a link's target relative to the link's own
    directory and throws when it does not exist. Before, a link to a missing
    file was created anyway: the script printed "Symlinks ensured" and exited 0
    while leaving a dangling link that reads as an empty instruction file to an
    agent.

  Skills link the doc as `../../../AGENTS.md` — the depth from
  `ai-tools/skills/<name>/SKILL.md`, and the same depth through every vendor
  symlink (`.claude/skills/<name>/SKILL.md`, `.agents/…`, `.cursor/…`,
  `.github/…`). The `implement-plan` / `amend-plan` templates and the
  dependency-license block previously emitted a bare `[AGENTS.md](AGENTS.md)`,
  which resolved to a non-existent file inside the skill's own folder; the
  `systematic-debugging` template was one level short at `../../AGENTS.md`. All
  four are fixed.

- **`vinta-write-agents-md` writes to the repo root.** Its output section now
  states the doc's links must be repo-root-relative, and its verification adds a
  link-resolution check run from the root.

- **`vinta-install-ai-tools-setup` requires a root `AGENTS.md` up front.** The
  prerequisite check asks for a regular file at the root and routes projects on
  the old layout to the sync migration below.

### Added

- **`vinta-sync-ai-tools` migrates projects off the old layout.** New
  `layout-migration` classification bucket — never batched with `tooling`, one
  question of its own — plus a step-by-step migration for
  `ai-tools/AGENTS.md` → root `AGENTS.md`: `git mv` so history follows the file,
  link checks in both directions, a prose sweep over `ai-tools/**` for the old
  path, and the setup-script re-run ordered *after* the move. Projects
  bootstrapped on 0.6.0 or later skip it.

  A skipped layout migration is **not** sticky the way a declined foundation
  skill is — the next sync re-offers it. Nothing errors in the meantime: the new
  script runs fine against the old layout, because `.github/copilot-instructions.md`
  → `../AGENTS.md` still resolves through the surviving root symlink. That is
  what makes the half-migrated state easy to miss, so the final report names it.

- **`vinta-analyze-codebase` recognizes the legacy layout.** A root `AGENTS.md`
  that is a symlink into `ai-tools/AGENTS.md` is recorded as a finding for the
  sync skill to act on.

## [0.5.0] — 2026-08-05

### Changed

- **PR context is now written in Simple English.** `integrate-phase` runs
  `deslop-comments` over the prs-context file it just wrote, before `open-pr.sh`
  publishes it, so the PR title, the description body, and every inline comment
  read as Simple English — one idea per sentence, current behavior stated
  directly, no AI-slop vocabulary. The project's PR-template structure survives
  the pass untouched. `amend-plan` runs the same pass whenever it rewrites a
  prs-context file after a force-push. New step 5 in
  [`partials/pr-context.md`](skills/vinta-derive-skills/resources/plan-execution/partials/pr-context.md)
  (the old steps 5–7 shift to 6–8); the writing rules are also stated up front in
  [`prs-context-template.md`](skills/vinta-derive-skills/resources/prs-context-template.md)
  so the first draft comes out clean. No config change — `deslop-comments`
  already always ships.
- **`deslop-comments` now deletes comments, not just rewrites them.** The pass
  used to reword whatever it found; deleting a comment is now a normal outcome.
  The "What counts as slop" list splits accordingly — rules 1–5 are rewordings,
  rules 6–12 are usually deletions — and seven new rules cover the comments that
  should not exist at any length: **where-used lists** (call-site inventories go
  stale the first time someone adds a caller), **another module's internals
  explained from here**, **one decision explained in several places** (write the
  reason once at the site that makes the decision), **restating the code**, **a
  comment standing in for a name** (report the rename, don't edit the comment),
  **plans and deferred work** ("temporary until Y"), and **paths not taken**
  ("tried X, settled on Y"). A new **essay-voice** rule bans sayings, metaphor,
  and "it looks like X but is really Y" framing, and the buzzword table grew by
  roughly a dozen entries (`gloss`, `roll-call`, `signal`, `the tell`, `unpick`,
  `papering over`, `strictly worse`, `earns its place`, …).

  Process gained four steps: check comments next to changed code for claims that
  are no longer true (nothing else catches a stale comment — no test, no type
  error, no lint rule), decide delete-or-reword before editing, collect
  duplicates across the whole file set before editing any of it, and grep the
  result for the skill's own buzzword list, since those words get written and
  then skimmed past. The summary now reports comment counts before and after,
  plus any comment found to be factually wrong.

  A new **"When the fix is not a comment edit"** section covers the case where
  the real fix is a test, a rename, or a function split: leave the comment,
  report it with the file and what must exist first. "What to leave alone" gains
  a matching guard — keep the reason a non-obvious line exists, and shorten the
  wording instead. This pass removes noise, not knowledge.

## [0.4.0] — 2026-07-31

### Added

- **`write-unit-test` foundation skill (template-rendered, default-on when a
  unit-test framework is detected).** A new foundation skill that ships into
  target projects' `ai-tools/skills/write-unit-test/` to write durable unit
  tests. The body enforces six universal rules regardless of framework — mock
  only genuine externals (never the unit under test / DB / local collaborators),
  assert the **full** expected output (not counts or truthiness), clean up
  created data or run inside a rolled-back transaction, never hit an external
  service that can't run in dev/test, keep test logic literal (no loops /
  conditionals recomputing the expectation), and decouple from implementation
  internals — plus a self-review checklist and a "run it green, then break it to
  see it go red" step.
  - Rendered from
    [`skills/vinta-derive-skills/resources/write-unit-test-template.md`](skills/vinta-derive-skills/resources/write-unit-test-template.md)
    (bucket B). New placeholders: `{{FRAMEWORK_PACKS_LIST}}`,
    `{{FRAMEWORK_PACK_LOADER_BLOCK}}`, `{{PROJECT_TEST_PREFERENCES_BLOCK}}`,
    `{{ADDITIONAL_CONVENTIONS_BLOCK}}` (reuses the existing `{{TEST_CMD}}` /
    `{{NEW_TEST_CMD_PATTERN}}` / `{{SCOPED_TEST_NOTE}}` / `{{PROJECT_NAME}}` /
    `{{STACK_SUMMARY}}` set). All four new placeholders are documented in the
    `vinta-derive-skills` placeholder table.
  - **Best-practice packs on two independent axes** (the framework-specific
    "sub-skills"), verbatim references under
    [`skills/vinta-derive-skills/resources/write-unit-test-packs/`](skills/vinta-derive-skills/resources/write-unit-test-packs/).
    `derive-skills` copies only what the project matches into
    `ai-tools/skills/write-unit-test/resources/packs/` so framework-specific
    advice never ships to a project that doesn't use that framework (a FastAPI
    repo never receives Django guidance; a pure library gets no web-framework
    pack):
    - **Runner packs** (`packs/runners/`, stack-agnostic — structure /
      assertions / mocking): `pytest.md`, `vitest.md`, `jest.md`. One selected
      by `inventory.tests.unit_framework`.
    - **Stack packs** (`packs/stacks/`, DB isolation / framework client / domain
      mocks): `django.md`, `fastapi.md`, `flask.md`, `medplum.md`, `react.md`,
      `nextjs.md`, `tanstack-start.md`, `react-router.md`, `prisma.md`,
      `python-package.md`, `typescript-package.md`. Every pack whose stack the inventory matched
      ships (a project can match several — e.g. Next.js + React, or TanStack
      Start + React); a repo with no web framework (a standalone TS/Python package like
      an open-source lib) gets its `*-package.md` and no more; when nothing
      matches, the runner pack ships alone. Missing packs for a present
      framework are recorded as a gap (candidate for a new pack via
      `add-foundation-skill`).
    - **Stack packs may carry a one-time project-setup step**, applied at derive
      time (not per test). Medplum ships the two Vitest setup files
      `medplum-test.globalSetup.ts` + `medplum-test.setup.ts` (FHIR search-parameter
      indexing shared across workers via `provide`/`inject`, so `MockClient`
      search filtering works) — the derive flow installs them and registers both
      `test.globalSetup` + `test.setupFiles` in the Vitest config; the `medplum.md`
      pack only references it. Bundled verbatim (dated headers) from the team's
      `medplum-snippet-catalog` (`TestSetup/`) so bootstrap stays offline-safe.
  - **Schema:** new `foundation_skills.write-unit-test` enum
    (`enabled` / `disabled`) and a new `skills.write-unit-test` config block —
    `test_style` (functions / classes / framework-default), `data_setup`
    (factories / fixtures / inline / framework-default), `assertion_style`
    (plain-assert / framework-methods / framework-default), `db_isolation`
    (transaction-rollback / truncate / recreate / framework-default), and a
    free-form `additional_conventions[]`. All optional; every field defaults to
    `framework-default`.
  - **Bootstrap:** `write-unit-test` is **default-on, not an opt-in** — the
    interview sets `foundation_skills.write-unit-test: enabled` whenever a
    unit-test framework was detected, `disabled` otherwise. New Project-conventions
    interview item **C.9 (Test conventions for `write-unit-test`)** captures the
    four preferences + extras, pre-filled from inference on existing projects.
    (The former C.9 "Agent model tiers" is now **C.10**; its Step 0.5 references
    were updated.) Step 0.5 emits the `skills.write-unit-test` block; the outputs
    tree, the three-buckets paragraph, and the `Replace with Vinta foundation
    version` foundation-shape list all now list `write-unit-test`.
  - **Inference:** `vinta-analyze-codebase` §6 (Tests) now reads a sample of the
    existing unit tests and reports a `tests.conventions` block
    (`test_style` / `data_setup` / `assertion_style` / `db_isolation` / `extras`,
    each `framework-default` when mixed / greenfield) that seeds the C.9 defaults.
  - **Review-driven refinements** (PR #21): two universal rules added — **kill
    nondeterminism** (clock / randomness / timezone / ordering / concurrency → no
    flaky tests) and **cover the branches** (aim 95%+ branch coverage); the
    full-value assertion rule now carves out **brittle human-facing text** (assert
    a stable anchor — error code, role, i18n key — for error/UI strings, not exact
    prose). Runner packs gained a **record/replay cassette** note for complex APIs
    like LLM endpoints (PollyJS / `nock.back` for JS, `vcrpy` / `betamax` for
    Python). The Medplum pack gained a **`MockClient` limitations** section
    (pre-seeded example resources skew unfiltered searches, partial search-param
    support, server-only behavior not enforced — defer those to integration/e2e).

## [0.3.0] — 2026-07-17

### Fixed

- **`prepare-worktree` — data-corruption bug: `COMPOSE_PROJECT_NAME` alone does
  NOT isolate a per-worktree docker-compose stack, so worktrees could run a
  second database server against the main checkout's data volume.** Step 4
  assumed `COMPOSE_PROJECT_NAME` fully isolates a compose stack. It does not for
  two very common patterns: (1) volumes declared `external: true` and/or pinned
  to a fixed top-level `name:` — the project name namespaces containers and
  networks but NOT these volumes, so every worktree's `db` service mounted the
  **same physical volume**; and (2) fixed host port bindings
  (`ports: - "5432:5432"`) — published to the same host port across compose
  projects. On a Django + docker-compose project (2026-07-17) this ran two
  Postgres postmasters against one PGDATA for a whole test run; when the
  worktree stack was `docker compose down`'d, its Postgres removed the shared
  `postmaster.pid` and the **main checkout's database self-terminated**
  (recovered on restart — luck, not safety). The fix also corrects a deeper
  conceptual error: Step 3a's "share the DB (don't fork)" is now explicit that
  *share* means share a **connection to a single already-running server** — for
  a compose-delivered DB the data volumes are **always forked, independent of
  `schema_change` / `test_db_strategy`**, because the worktree runs its own
  server and two servers on one volume is corruption.

  **User impact / migration:** existing worktrees provisioned before this fix
  are **unsafe to boot their DB compose stack while the main stack is up** —
  they share main's data volume. For an already-provisioned worktree, regenerate
  the override without re-running the whole skill:

  ```bash
  ai-tools/skills/prepare-worktree/scripts/gen-compose-worktree-override.sh \
    --main <main-checkout-root> --worktree <worktree-path> --name <name> \
    --out <summary_dir>/<name>.docker-compose.override.yml
  echo "COMPOSE_FILE=<base-compose-file>:<override-path>" >> <worktree>/.env
  ```

  Then confirm the worktree's resolved DB volume name differs from main's before
  booting its stack. **Consumers**: re-sync (`vinta-sync-ai-tools`) to pick up
  the new script, the reworked Step 4/Step 3a, and the `shared_volumes` config.

### Added

- **`prepare-worktree` bundled script
  `scripts/gen-compose-worktree-override.sh`.** Detects the compose isolation
  leaks above entirely from `docker compose config --format json` (no project /
  service / volume name hardcoded) and emits a **generated, out-of-tree**
  compose override that re-pins every `external:`/fixed-`name:` volume to a
  non-external, worktree-namespaced volume (`<project>_wt_<name>_<volkey>`) and
  strips fixed host-port publishing (via compose's `!override []` — a plain
  `ports: []` merges/appends in Compose v2+; verified on Docker Compose v5.1.1).
  The override is written under `<summary_dir>/` and wired in via
  `COMPOSE_FILE=<base>:<override>` appended to the worktree's **copied** `.env`,
  so **no tracked compose file is ever mutated**. Volumes safe to keep shared
  (a read-only dep/venv cache) are exempted via `--share-volume`.
- **`skills.prepare-worktree.shared_volumes` config field** (array of compose
  volume keys, default `[]`). Lists volumes safe to keep shared across worktrees
  — read-only dep/venv caches only, never a data/DB volume. Feeds
  `gen-compose-worktree-override.sh --share-volume`. Added to the config schema
  and the bootstrap template's `prepare-worktree` block.
- **`prepare-worktree` Step 4a "Neutralize compose isolation leaks"**, a
  Verification invariant that boots the worktree's DB service and asserts its
  resolved data volume name differs from main's (failing provisioning loudly
  otherwise), a matching Pitfall + Rules entry, and a `state.compose` summary
  schema extension (per-volume fork decisions, override path, stripped ports)
  so teardown is mechanical (`docker volume rm` the forked names; `rm` the
  override — never `down -v`, which would nuke shared volumes).

### Changed

- **`prepare-worktree` foundation skill — rebalanced Step 3b (test database)
  to be stack-agnostic.** The section previously led with a detailed
  `pytest-django` recipe (with `vitest`/`jest` and Rails as one-liners),
  which read as Django-centric. It now opens with the stack-agnostic
  principle — give the worktree its own test DB name, inject it through
  whatever channel the runner already reads (env var or per-worktree config
  override), and never edit tracked test config in place — then lists the
  runners as equal-weight illustrations grouped by *how they take config*:
  env-var runners (`vitest`/`jest`, `go test`, `cargo test`), config-file
  runners (`pytest-django`), convention-based runners (Rails), and
  compose-based test DBs. No behavior change; the pytest-django mechanics
  (`conftest_worktree.py`, don't touch the tracked `conftest.py`) are
  preserved. **Consumers**: re-sync to pick up the reworded skill body.

## [0.2.0] — 2026-07-15

### Added

- **Project-wide model selection for the review sub-agents and mechanical
  steps, via a new optional `agent_models` section in
  `.vinta-ai-workflows.yaml`.** Until now only the per-phase *implementer*
  model was configurable (each plan phase's `**Suggested AI model**:` line);
  the reviewer, the fixer, and the mechanical steps (worktree prep, opening
  the PR / integrate) always inherited the runtime default. `agent_models`
  maps each of `reviewer` / `fixer` / `worktree_prep` / `integrate` to a
  **tier (1–4)** into the same `plan-feature/resources/ai-models.yaml` table
  the implementer uses — so no model IDs are hard-coded and the nightly
  `check-ai-models` job keeps them fresh. Behavior:
  - `review-phase` spawns the reviewer at `agent_models.reviewer` and the
    fixer at `agent_models.fixer` **as the project default** — a plan phase
    can override either for that phase via an optional `**Review models**:`
    line (per-phase override wins → else `agent_models` → else runtime
    default). Lets a plan raise the review model on its few critical /
    high-blast-radius phases without changing the project-wide setting.
  - `implement-plan` **delegates** the mechanical steps to a cheap subagent
    when `agent_models.worktree_prep` / `agent_models.integrate` is set —
    provisioning the worktree and pushing + opening the PR run on the
    configured model instead of the conductor's (usually pricier) session.
    The PR-context file + `open-pr.sh` stays the only PR-creation path.
  - `plan-feature` phases always pick the implementer model
    (`**Suggested AI model**:`) and MAY add an optional `**Review models**:`
    line to override the reviewer / fixer tier for that phase; the mechanical
    models stay config-only.
  Every key is optional and backward-compatible: an unset key (or the whole
  section absent) means that spawn keeps using the runtime default.
  **Consumers**: re-sync to pick up the `agent_models` bootstrap question and
  the updated plan-execution skills; existing configs are unaffected until
  they add the section.

<!-- pre-release: 0.2.0-alpha7 on 2026-07-13 -->

### Changed

- **E2E tests are now opt-in in both `plan-feature` and `implement-plan`,
  because they make the implementation run a LOT slower.** Previously, for
  e2e-enabled projects, `plan-feature` *required* a happy-path Playwright spec on
  every phase that reached the browser, and `implement-plan` ran those specs in
  every phase's outer gate + review layers — browser boot, seeded data, and
  screenshot capture on each phase. Now:
  - `plan-feature` gained a Step 0 (group I) **E2E coverage** question that
    **defaults to NO**. When not opted in, phases ship unit + integration tests
    only and carry no e2e spec, `QA_USE_CASES.md`, or `pr-screenshots/`
    references; e2e can still be added later per-flow via `add-e2e-test`.
  - `implement-plan` gained a Step 0 question **(e) Run E2E tests this run?**
    (`run_options.run_e2e`, **default off**). Even when a plan carries e2e specs,
    the outer-gate e2e step, the Layer 1 verification note, the Layer 2
    walkthrough check, and the implementer report field only run when the user
    opts in for that run. The shared review/debug e2e gate follows the same
    `run_options.run_e2e` flag, so standalone `systematic-debugging` /
    `amend-plan` runs skip e2e unless it is set.
  **Consumers**: re-sync to pick up the opt-in questions. E2E-disabled projects
  are unaffected (the e2e regions strip out as before).

<!-- pre-release: 0.2.0-alpha6 on 2026-07-13 -->

### Changed

- **`plan-feature` AI model tiers refreshed to the current model
  generation.** `plan-feature/resources/ai-models.yaml` now cites the latest
  IDs: tier 1 `gemini-2.5-flash-lite` → `gemini-3.1-flash-lite` and 
  `gpt-5-nano` → `gpt-5.6-luna`; tier 2 `claude-sonnet-4-6` → `claude-sonnet-5` 
  (incl. the Haiku step-up note) and `gemini-2.5-flash` → `gemini-3.5-flash`; tier 3 
  `claude-sonnet-4-6` → `claude-sonnet-5` and the retired `gemini-2.5-pro` 
  dropped in favor of `gemini-3-pro` and the retired `gpt-5` dropped in favor of
  `gpt-5.6-terra`; tier 4 `claude-opus-4-7` → `claude-opus-4-8` and the retired
  `o3` dropped in favor of `gpt-5.6-sol`. Tier *placement* is unchanged — only the
  concrete IDs move. **Consumers**: re-sync to pick up the refreshed model
  suggestions.

### Fixed

- **`implement-plan` stacked-branches now opens each phase PR against its
  parent phase, not the default branch.** The git branch topology was already
  stacked correctly (each phase branches off the previous phase's branch), but
  nothing told the orchestrator what to write into the prs-context `base`
  field, so it defaulted to `<BASE_BRANCH>` and **every stacked PR targeted the
  default branch** — collapsing the stack and showing each PR the cumulative
  diff. The stacked commit-strategy partial now spells out the PR base per
  phase (first phase → default branch; every subsequent phase → the previous
  phase's branch), the shared `pr-context` write step no longer defaults `base`
  blindly, and the `prs-context` template comment states the rule. Modular /
  single-PR strategies are unaffected (one PR against the default branch).
  **Consumers**: re-sync to pick up the corrected `base` resolution; existing
  PRs opened against the wrong base must be re-targeted manually.

<!-- pre-release: 0.2.0-alpha5 on 2026-07-13 -->

### Added

- **`handoff` foundation skill — session-continuation handoff docs between
  agents.** Write mode captures the current task (goal, verified-vs-unverified
  state, decisions + rejected alternatives, landmines, single concrete next
  step) into `.vinta-ai-workflows/handoffs/{date}-{slug}.md`, gathering state
  from the repo — never from memory; resume mode reads a handoff, verifies its
  claims against the repo before trusting them, and continues from the doc's
  next step. Ships at
  [skills/vinta-derive-skills/resources/foundation-skills/handoff/SKILL.md](skills/vinta-derive-skills/resources/foundation-skills/handoff/SKILL.md).
  Wired as an **always-ship** bucket-A skill: new
  `foundation_skills.handoff` enum entry (schema), derive-skills bucket-A
  table + always-ships note, bootstrap always-copy-verbatim list + outputs
  tree + Step 0.5 YAML (`handoff: enabled`), and both foundation-shape
  replace lists. No bootstrap interview question — it always ships.

- **`handoff-to-client` foundation skill — API-change handoff docs for
  API-only repos (opt-in, template-rendered).** Generates a self-contained
  markdown document for the client teams consuming the repo's API: every
  endpoint/operation added / changed / deprecated / removed on the current
  branch vs the default branch, with request/response shapes derived from the
  code (or a regenerated API spec), auth/error changes, breaking-change flags
  judged from the strictest plausible client, one realistic example per
  operation, and per-platform migration notes. Template at
  [skills/vinta-derive-skills/resources/handoff-to-client-template.md](skills/vinta-derive-skills/resources/handoff-to-client-template.md)
  (bucket B + C). New schema fields: `foundation_skills.handoff-to-client`
  enum entry and the `skills.handoff-to-client` config block
  (`client_platforms` — required non-empty array, `api_style`,
  `api_spec_path`, `output_dir` — default
  `.vinta-ai-workflows/client-handoffs`). New template placeholders
  `{{API_STYLE}}`, `{{CLIENT_PLATFORMS_LIST}}`, `{{CLIENT_HANDOFF_DIR}}`,
  `{{API_SPEC_BLOCK}}` documented in the derive-skills placeholder table.
  Bootstrap gains **Optional foundation skills question 7** (asked only when
  the inventory suggests an API-only repo) plus a four-part config follow-up;
  Step 0.5 YAML, outputs tree, optional-bucket lists, and both
  foundation-shape replace lists updated. **Consumers**: API-only projects
  re-sync + answer the new interview question to enable it.

<!-- pre-release: 0.2.0-alpha4 on 2026-07-08 -->

- **`implement-plan` outer-gate test scope is now configurable — and defaults
  to the quick path.** Each phase's outer gate still always runs the repo-wide
  type/build gate, but for tests it now runs **only the scoped suite** covering
  the apps/files that phase touched by default, instead of the whole repo suite
  every phase (new tests still pass individually in the inner loop). This
  **flips the previous default** (full suite every phase → scoped) to make
  multi-phase plans materially faster. Opt back into the full suite per run via
  the new Step 0 question (d), or set the default in
  `.vinta-ai-workflows.yaml` under
  `run_options.implement-plan.full_test_suite: true`. New config field
  (`run_options.implement-plan.full_test_suite`, boolean, default `false`);
  threaded from the conductor into `implement-phase` (outer-gate marker in the
  implementer prompt) and `review-phase` (Layer 1 verifies whichever gate the
  flag selects); recorded in `TRACKING_{plan-id}.md` `run_options`.

- **`deslop-comments` foundation skill — Simple-English comment cleanup, now
  part of the review flow.** Rewrites comments + doc blocks touched during a
  task into Simple English (strips AI-slop vocabulary and negative framing;
  comment-only — no renames, no behavior change). Ships at
  [skills/vinta-derive-skills/resources/foundation-skills/deslop-comments/SKILL.md](skills/vinta-derive-skills/resources/foundation-skills/deslop-comments/SKILL.md).
  Wired as an **always-ship** bucket-A skill (new
  `foundation_skills.deslop-comments` enum, added to the derive-skills bucket-A
  table + always-on note, the bootstrap always-copy-verbatim list + outputs
  tree + Step 0.5 YAML, and both foundation-shape replace lists) because
  `review-phase` now depends on it: **Layer 2 gains a comment-hygiene check**
  and the **fix loop dispatches a `fixer` to run `deslop-comments`** on the
  phase's touched files for any comment-slop finding. Also invokable
  standalone ("deslop these comments"). **Consumers**: re-sync to pick up the
  skill and the `review-phase` comment-hygiene step.

- **`thermo-nuclear-code-quality-review` foundation skill — opt-in deep
  structural-maintainability audit.** A deliberately harsh, on-demand review
  of a diff (abstraction quality, giant files, spaghetti-condition growth)
  that hunts for "code-judo" reframes collapsing whole branches / helpers /
  modes / layers rather than polishing them. Copy-verbatim foundation skill
  (bucket A), read-only — it reports findings and hands each fix to the
  `fixer` agent. Ships at
  [skills/vinta-derive-skills/resources/foundation-skills/thermo-nuclear-code-quality-review/SKILL.md](skills/vinta-derive-skills/resources/foundation-skills/thermo-nuclear-code-quality-review/SKILL.md).
  Wired as **opt-in / ask-first**: new `foundation_skills.thermo-nuclear-code-quality-review`
  enum in `schemas/vinta-ai-workflows-config.v1.schema.json`, a new
  question 6 in the bootstrap **Optional foundation skills** interview, and
  the derive-skills bucket-A + foundation-shape lists. The `review-phase`
  Layer 3 reviewer now applies a **condensed structural-simplification lens**
  on every phase and escalates to this full audit only when a phase touches
  core architecture, crosses ~1,000 lines, or surfaces a structural smell too
  big to resolve inline — the deep pass never auto-runs on every diff.
  **Consumers**: re-sync; the bootstrap now asks one more optional-skill
  question, and `review-phase` gains the escalation hook.

- **`prepare-worktree` — write-guard for *in-process* subagent runtimes
  (claude-code's Task tool).** `sandbox-run.sh` confines a *process*, so it
  only works when the harness spawns subagents as subprocesses (`codex exec`,
  a `claude -p` child). Claude Code runs subagents in-process — same OS
  process, same tool pipeline, no child command to wrap — so a new
  harness-config guard covers it instead. Two bundled scripts:
  `prepare-worktree/scripts/claude-worktree-write-guard.py` (a `PreToolUse`
  hook that fires for the orchestrator **and** every in-process Task subagent,
  blocking the file-editing tools — `Edit`/`Write`/`MultiEdit`/`NotebookEdit`
  — from writing outside the worktree; filesystem-only, no network impact) and
  `prepare-worktree/scripts/gen-claude-sandbox-settings.sh` (generates the
  worktree's `.claude/settings.json` wiring that hook, and optionally
  Claude Code's **native** OS sandbox via `sandbox.filesystem.denyWrite`/
  `allowWrite` under `--os-sandbox` to also block Bash-issued writes — noting
  the native sandbox forces network isolation, so registry + git-remote hosts
  must be allow-listed via `--allow-domain`). Same deny-main/allow-rest model
  as `sandbox-run.sh`. Step 5.5 of `prepare-worktree` gains an *In-process
  runtimes (claude-code)* subsection; `implement-plan` §1c makes the
  previously hand-wavy "in-process runtime" branch concrete. **Consumers**:
  re-sync `prepare-worktree` + `implement-plan` — the two new scripts ship
  with the foundation-skill dir.

### Fixed

- **`prepare-worktree/scripts/sandbox-run.sh` — two correctness bugs.**
  (1) The macOS profile temp file used `mktemp -t vinta-sandbox`, which fails
  with "too few X's in template" under GNU `mktemp` (present on any machine
  with coreutils on `PATH`, including many macOS setups) — the whole sandbox
  path errored out; now uses an explicit `…/vinta-sandbox.XXXXXX` template
  portable across BSD + GNU `mktemp`. (2) Callers must now pass
  `--allow <main>/.git`: git worktrees write every commit into the main repo's
  `.git` (`.git/worktrees/<name>/index.lock`, shared objects/refs), so a
  deny-main that omits it made the subagent's own `git commit` fail with
  `Operation not permitted`. `implement-plan` §1c's documented invocation +
  checklist + rules are updated to include `<main>/.git` in the allow-set.

### Changed

- **`implement-plan` / `amend-plan` decomposed into a modular "plan-execution
  unit" of deterministic sub-skills.** The single ~440-line
  `implement-plan-template.md` (and its `implement-plan-template-modular-substitutions.md`
  sister file) are replaced by a thin **conductor** plus three co-shipped
  single-purpose sub-skills, all rendered from
  [skills/vinta-derive-skills/resources/plan-execution/](skills/vinta-derive-skills/resources/plan-execution/)
  (`shell/` templates that `<!-- include -->` shared `partials/`):
  - `implement-plan` — conductor: parse → classify → resolve one `WORKROOT`
    → per-phase loop (dispatch) → track → report.
  - `implement-phase` — compose prompt + pick model + spawn the implementer.
  - `review-phase` — the three-layer review + fix loop, now shared by
    `implement-plan`, `amend-plan`, **and** `systematic-debugging` (one review
    implementation instead of three).
  - `integrate-phase` — push + open PR via context file, rendered
    commit-strategy-resolved.
  The scattered runtime `if use_worktree` branches collapse into a single
  `WORKROOT` / `BASE_BRANCH` / `SANDBOX_TIER` seam the conductor resolves once
  and passes to every sub-skill as data; only two local, data-driven checks
  remain (the sandbox spawn-wrap in `implement-phase`, the stray-write
  backstop in `review-phase`). Under `commit_strategy = ask`, the former
  dual-rendered branch/commit/PR bodies become **two** rendered
  `integrate-phase-stacked` / `integrate-phase-modular` skills the conductor
  dispatches by name — no more both-paths-in-one-file. `amend-plan` reuses
  `review-phase` verbatim + the shared inner/outer verification loop, and
  picks up the same `WORKROOT` uniformity, while keeping its own
  history-rewriting topology. **Consumers**: re-sync — the target now gets
  five plan-execution SKILL.md files (`implement-plan`, `implement-phase`,
  `review-phase`, `integrate-phase` [or the two `ask` variants], `amend-plan`)
  instead of two. The three new sub-skills are a co-shipped unit: always
  generated with `implement-plan`, not individually opt-in (no new
  `foundation_skills` enum entry, no new interview question). Runtime
  behavior is unchanged; the decomposition is for reviewability + determinism.

<!-- pre-release: 0.2.0-alpha3 on 2026-06-23 -->

### Added

- **`plan-feature` AI model tier table extracted to a data resource +
  nightly freshness job.** The per-tier model recommendations that used to
  be hard-coded in `plan-feature/SKILL.md` now live in
  `plan-feature/resources/ai-models.yaml` (ships verbatim with the skill;
  schema: `schemas/ai-models.v1.schema.json`). The SKILL.md body keeps the
  *tier-selection rubric* (stable judgement) and points at the resource for
  concrete model IDs, so the prose no longer goes stale. A source-side
  nightly GitHub Action (`.github/workflows/check-ai-models.yml`, runner
  `scripts/check-ai-models.mjs`) checks the cited IDs against a **free,
  no-key model aggregator** (models.dev, LiteLLM JSON as fallback) — no
  vendor API keys required — flags IDs that disappear or that a newer
  same-family model has superseded, and on drift has an LLM propose an
  updated table that it opens as a reviewable PR (the optional LLM step is
  the only one that uses a key). **Consumers**: re-sync the
  `plan-feature` skill to pick up a refreshed table; the resource's
  `last_verified` date signals how current it is.

- **`prepare-worktree` — OS-level filesystem sandbox that *prevents*
  stray main-checkout writes (harness-agnostic).** The prompt instruction
  "stay in the worktree" is cooperative only; a smaller phase subagent can
  resolve a path back to the main checkout and silently write there. A new
  bundled script `prepare-worktree/scripts/sandbox-run.sh` confines the
  *process* (not the agent tool) at the kernel layer — `sandbox-exec` on
  macOS, `bwrap` (bubblewrap) on Linux — using a **deny-main, allow-rest**
  model: the whole filesystem stays writable except the main checkout, with
  the worktree (nested under it) and `.vinta-ai-workflows` punched back to
  writable, so package managers / caches / `$HOME` behave normally and no
  per-stack allowlist tuning is needed. A stray main-checkout write fails
  with `Operation not permitted` / `EROFS` regardless of which harness
  (claude-code, Codex, …) issued it. `prepare-worktree` adds a capability
  probe + a `sandbox` block in its summary YAML recording the achieved tier
  (`enforced` / `none`); `implement-plan` wraps each subprocess subagent
  spawn in the script when `sandbox_tier = enforced`, threads the tier
  through tracking + the re-running-mid-plan resume path, and downgrades its
  existing Layer 1 stray-write check from sole defense to a backstop. On
  machines without a sandbox tool (`tier = none`) the script runs the
  command unsandboxed with a loud warning and the Layer 1 check remains the
  guard. Escape hatch: `VINTA_SANDBOX=off`. **Consumers**: re-sync
  `prepare-worktree` + `implement-plan` to pick up the guard; the whole
  `prepare-worktree/` dir now ships (SKILL.md + `scripts/sandbox-run.sh`),
  so re-run the foundation-skill copy, not just the SKILL.md.

### Changed

- **`plan-feature` — per-phase PR-size target raised from ~100–300 LoC to
  up to 1500 LoC** (tests included). The old "reviewer reads the diff in
  30 minutes / ~100–300 LoC" guidance forced excessive phase splitting:
  trivial use-cases became standalone PRs and the phase count ballooned
  past what a reviewer wants to track. The new ceiling — "reviewer reads
  ≤1500 LoC and understands the phase in isolation" — keeps phases
  MR-sized and single-concern while letting a coherent unit of work land
  in one PR. Pairs with the new **Phase granularity** Step 0 choice
  below: bundled phases also cap at 1500 LoC. Plan-shape checklist
  updated to match.

- **`plan-feature` — "one use-case per phase" is now a Step 0 choice, not
  a hard mandate.** Added a **Phase granularity** question to the Scope
  group (default: one use-case per phase). The rule, its apply-even-when
  list, and the checklist item now branch on the answer — opting into
  bundling lets closely-related use-cases share a phase as long as each
  phase stays MR-sized, single-concern, and independently mergeable.

- **E2E content is stripped from no-e2e projects.** `create-qa-use-cases`
  now ships **only when `add-e2e-test` is enabled** (it seeds e2e specs),
  and `plan-feature`'s Playwright / `QA_USE_CASES.md` / `pr-screenshots/`
  sections are wrapped in `<!-- e2e:start/end -->` markers that
  `vinta-derive-skills` strips when `add-e2e-test` is disabled. The
  bootstrap `add-e2e-test` answer now also sets
  `foundation_skills.create-qa-use-cases`. Result: projects marked as
  having no e2e tests get foundation skills with zero e2e references.
  
<!-- pre-release: 0.2.0-alpha2 on 2026-06-13 -->

### Changed

- **Fixed bug on setup-ai-tools.mjs**: Sub agents were being generated 
with an invalid description and were not being loaded by claude-code and 
possibly other AI tools.

- **`implement-plan` template — stray main-checkout-write guard (only
  when `run_options.use_worktree = true`).** A subagent told to work
  inside the worktree can resolve an absolute path back to the **main
  checkout** and silently edit files there; because worktrees have
  independent working trees those edits never reach the phase commit —
  they sit as uncommitted thrash in the main checkout and read as a
  silent implementer/fixer failure. Layer 1 mechanical checks gain a new
  item: after **every** implementer **and** fixer subagent returns, run
  `git -C <main-checkout-path> status --short | grep -vE '^\?\?'`
  (tracked modifications only); any output is a BLOCKER — recover intent
  via `git -C <main-checkout-path> diff`, re-dispatch the agent with an
  explicit worktree-path instruction if the change belongs there, then
  `git -C <main-checkout-path> restore` so the main checkout returns
  clean between phases. `<main-checkout-path>` is the repo root the skill
  was invoked from, never `run_options.worktree_path`. Skipped entirely
  when `use_worktree = false`. Mirrored in the per-phase Quick checklist
  Layer 1 line and a new **Important rules** bullet.

<!-- pre-release: 0.2.0-alpha1 on 2026-06-12 -->

### Added

- **Third-party dependency license policy captured at bootstrap, surfaced
  to AI agents at implementation time.** `vinta-bootstrap-ai-tools` Step 0
  group **C. Project conventions** gains question 7 — enforcement
  (`block` (default) / `warn` / `off`), a confirm-and-edit prompt for the
  forbidden SPDX list (seed: `GPL-2.0-only`, `GPL-3.0-only`,
  `AGPL-3.0-only`, `SSPL-1.0`), per-package overrides, and free-form
  notes. Captured in a new `policies.dependency_licenses` block of
  `vinta-ai-workflows-config.v1.schema.json`. Consumers:
  - `vinta-write-agents-md` renders a new **Dependency licenses** section
    in `ai-tools/AGENTS.md` (enforcement mode + forbidden list + approved
    overrides table + notes + pre-install check pointers like
    `npm view <pkg> license`, PyPI metadata, etc.).
  - `vinta-derive-skills` substitutes three new placeholders into the
    `implement-plan` + `amend-plan` templates: `{{DEPENDENCY_LICENSE_BLOCK}}`
    (top-level "Adding new third-party dependencies" section directly
    before Working instructions — canonical body at
    [vinta-derive-skills/resources/dependency-license-block.md](skills/vinta-derive-skills/resources/dependency-license-block.md)),
    `{{DEPENDENCY_LICENSE_LAYER1_CHECK}}` (reviewer Layer 1 mechanical
    check that greps the manifest diff for forbidden licenses), and
    `{{DEPENDENCY_LICENSE_RULE_LINE}}` (an Important-rules bullet).
  All three placeholders render the empty string when
  `enforcement: off` or the config block is absent — projects that opt
  out get no extra prose in their rendered skills. `enforcement: block`
  refuses the install + asks the user to acknowledge before recording an
  `allowed_overrides[]` entry and re-running; `warn` proceeds but flags
  in the phase report. **Missing / `UNKNOWN` / undeclared license is
  always handled as a stop-and-ask, regardless of enforcement mode** —
  unknown ≠ permissive, so the subagent surfaces the gap (registry
  lookup output, upstream URL) and asks the user to pick `skip the dep`
  / `treat as forbidden` / `record an `allowed_overrides` entry with an
  off-channel-confirmed SPDX`. Same behaviour reinforced in the Layer 1
  reviewer check: undeclared license = BLOCKER, no enforcement-mode
  downgrade.
  
- **New `policies.commit_strategy` field in `.vinta-ai-workflows.yaml`**
  (`stacked-branches` | `modular-commits` | `ask`, default
  `stacked-branches`). Drives how the rendered `implement-plan` skill
  structures branches and commits across phases:
  - `stacked-branches` — current behavior. One branch + one PR per
    phase, stacked on top of each other.
  - `modular-commits` — one branch + one PR for the whole plan; each
    phase contributes multiple atomic commits (one per logical unit:
    service, use-case wire-up, init/exports, serializer field,
    refactor, fix). Tests travel in the same commit as the code they
    test. The commit list becomes a table of contents for reviewers.
  - `ask` — `implement-plan` prompts the user at Step 0 (alongside
    `pause_between_phases` / `generate_inline_comments`) and caches the
    resolved value in `TRACKING_{plan-id}.md` under
    `run_options.commit_strategy_resolved`.
  Additive on schema v1 — existing configs without the field default
  to `stacked-branches` at read time (backward-compatible). Bootstrap
  interview captures the answer in **C. Project conventions**.

- **New optional foundation skill: `prepare-worktree`** (copied verbatim
  to `ai-tools/skills/prepare-worktree/SKILL.md` per project, opt-in via
  the bootstrap **Optional foundation skills** interview, new
  `prepare-worktree` question). Source:
  [skills/vinta-derive-skills/resources/foundation-skills/prepare-worktree/SKILL.md](skills/vinta-derive-skills/resources/foundation-skills/prepare-worktree/SKILL.md).
  Provisions a fully-runnable git worktree for parallel feature work so a
  long-running plan (or experiment) can build, test, lint, migrate, and
  hit databases without disturbing the main checkout — or other parallel
  worktrees on the same machine. Walks the project's `.gitignore` +
  package manifests + env templates + docker config and decides per
  ignored path whether to **symlink** (read-only-ish reuse), **copy**
  (defensive, when the feature mutates the path), or **fork** (state
  that would corrupt main if shared — dev DB, test DB, docker-compose
  project name). Reads the active plan to bias decisions: dep churn
  flips dep dirs to copy/reinstall; migrations flip the dev DB to fork
  and run them once; new env vars flip `.env` from symlink to copy +
  mutate; compose changes flip the network strategy. Drops a per-worktree
  summary YAML at `.vinta-ai-workflows/worktrees/<name>.yaml` + a
  `WORKTREE.md` at the worktree root so teardown is mechanical (no
  decision lives only in conversation memory). Bucket A (copy verbatim) —
  body is project-agnostic; per-project variability lives in
  `skills.prepare-worktree.*` config (worktree root, deps strategy,
  compose-network strategy, test-DB strategy, summary dir).

- **`implement-plan` Step 0 question (c) — "Run phases in a worktree?"**.
  New opt-in: when the user picks `Yes`, the orchestrator runs
  `prepare-worktree` **once** at the start of the plan (new
  **Provision worktree** step between Step 0 and Step 1), records
  `worktree_path` / `worktree_branch` / `worktree_summary` in the
  tracking file, and threads them into every phase's subagent prompt +
  every `git` call in the **Branch + push** step. **One worktree per
  plan run** — every phase branch stacks inside the same worktree; the
  skill never provisions a second one mid-plan. Mid-plan resumes detect
  the worktree from tracking and reuse it (asking only when the worktree
  is missing). When `foundation_skills.prepare-worktree` is `disabled`,
  the question is skipped and `run_options.use_worktree` is forced to
  `false` with a one-line note pointing at `vinta-sync-ai-tools` to
  enable later. Failure modes are explicit — prepare-worktree errors
  never fall back silently to the main checkout; the user picks `Retry`
  / `Run in main` / `Stop`.

- **`.vinta-ai-workflows.yaml` config additions for `prepare-worktree`**:
  - `foundation_skills.prepare-worktree: enabled | disabled` — sticky
    opt-in like every other foundation skill.
  - `skills.prepare-worktree.worktree_root: string` (default
    `.claude/worktrees` for claude-code-primary projects;
    `../<repo>-wt-` sibling-dir layout otherwise) — where new worktrees
    land. The skill resolves `<root>/<name>` per provisioning call.
  - `skills.prepare-worktree.deps_strategy: symlink | copy | reinstall`
    (default `symlink`) — default for dep dirs (`node_modules/`,
    `vendor/`, `venv/`) when the active plan does NOT install new deps.
    The skill auto-flips to `reinstall` when it detects dep churn in the
    plan body.
  - `skills.prepare-worktree.compose_network: per-worktree | shared-external | host`
    (default `per-worktree`) — docker-compose networking strategy.
    `shared-external` joins an externally-declared network so the
    worktree can reach main's compose services (queues, caches, search
    indexes that are expensive to spin twice).
  - `skills.prepare-worktree.test_db_strategy: fork-on-schema-change | always-fork | share`
    (default `fork-on-schema-change`) — when to fork the test DB per
    worktree. `share` is only safe for solo work (parallel runs flake).
  - `skills.prepare-worktree.summary_dir: string` (default
    `.vinta-ai-workflows/worktrees`) — where per-worktree summary YAMLs
    land. Covered by the umbrella `.vinta-ai-workflows/` gitignore.
  - `run_options.implement-plan.use_worktree: boolean` (default
    `false`) — suggested default shown for the Step 0 question (c)
    above; per-run prompt always asks. Flipped to `true` at bootstrap
    when the user opts in via the `prepare-worktree` follow-up.

- **Bootstrap interview — new `prepare-worktree` question** under
  **Optional foundation skills**, plus four short follow-ups (worktree
  root, default deps strategy, default test-DB strategy, and the
  `implement-plan` default for question (c)). The **Optional foundation
  skills** opener switched from "four skills" to "five skills"
  accordingly. Outputs tree updated to list
  `ai-tools/skills/prepare-worktree/SKILL.md` as an opt-in foundation
  skill. The **Existing AI artifacts** disposition flow's
  `foundation-shape` name list (which gates the
  `Replace with Vinta foundation version` option) gained
  `prepare-worktree`.

- **`vinta-derive-skills` — Always copy bucket** gains a row for
  `prepare-worktree` (verbatim copy). The **Optional — ask the user**
  bucket also gets a row covering the opt-in interview + the four
  follow-ups; this is the same compose pattern as `add-one-off-script`
  (verbatim copy, gated by ask-first). Foundation-shape lists in both
  "Reconcile against existing skills" + Rules sections extended with
  `prepare-worktree`.

### Changed

- **`implement-plan` template**: the Step 0 opt-in questions block grew
  from two questions to three (added (c) for worktree opt-in); a new
  **Provision worktree** step sits between Step 0 and Step 1; the
  per-phase prompt (`Prepare agent prompt` step) carries a worktree
  block when `use_worktree = true`; the `Branch + push` step's branch
  and push commands now prefix with `git -C <worktree_path>` when
  applicable; tracking schema (`Update tracking file` step) gains
  `run_options.worktree_path` / `worktree_branch` / `worktree_summary`;
  Re-running mid-plan flow learned to detect + reuse the worktree;
  Step 2 final report surfaces the teardown command (never auto-runs
  it). Three new entries in the **Important rules** section codify the
  one-worktree-per-plan-run invariant + the no-silent-fallback rule.

## [0.1.7] — 2026-06-01

### Added

- **`DESIGN.md` detection + Cursor Project Rules wiring during bootstrap.**
  `vinta-bootstrap-ai-tools` Step 0 gains group **F. Design system doc
  (`DESIGN.md`)**: if a `DESIGN.md` exists at the repo root, the
  orchestrator asks via `AskUserQuestion` whether to wire it into AI
  tooling (`Keep and wire into AI tooling` (recommended) /
  `Keep as-is, don't reference` / `Drop`). The file itself is never
  overwritten — the team owns its contents. When `wired`:
  - `vinta-write-agents-md` inserts a "Design system" section in
    `ai-tools/AGENTS.md` pointing at `DESIGN.md`.
  - `vinta-install-ai-tools-setup` writes `.cursor/rules/design.mdc`
    with the frontmatter + body from
    [Design.md with Cursor — Option A: Project Rules (recommended)](https://designmd.app/blog/design-md-with-cursor/)
    so Cursor auto-loads the design system before generating UI files.
    Only emitted when `cursor` ∈ `vendors`. Globs default to
    `**/*.tsx`, `**/*.jsx`, `**/*.vue`, `**/*.svelte`, `**/*.astro`,
    `**/*.css`; the orchestrator asks once before shipping defaults
    when the analysis surfaced a UI framework not covered.
  Disposition lands in a new `project.design_md: wired |
  kept-unreferenced | absent` field of `.vinta-ai-workflows.yaml`.
  Outputs tree updated to show `DESIGN.md` preserved at repo root and
  `.cursor/rules/design.mdc` (conditional). New top-level rule added
  to the orchestrator: **`DESIGN.md` is sacrosanct** — read-only at
  all times; only the sibling Cursor pointer is ever written.

### Changed

- **`implement-plan` template rendered with new
  `{{COMMIT_STRATEGY_*}}` placeholder family.** Branch naming, per-phase
  push, subagent commit instructions, PR-open timing, tracking-file
  branch field, and final-report branch summary now swap based on
  `policies.commit_strategy`. Under `ask`, both code paths render in
  the same body gated by `run_options.commit_strategy_resolved` —
  mirrors the existing `pause_between_phases` /
  `generate_inline_comments` opt-in pattern.
- **`amend-plan` refuses to run when
  `policies.commit_strategy != stacked-branches`** and points users at
  appending a new phase via `implement-plan` (or hand-crafting the
  rebase). Modular-commits amendment support is tracked as a follow-up
  — rewriting an arbitrary number of inline commits on a shared branch
  is out of scope for this release.

- **Replaced all `§N` shorthand cross-references with named section
  links across the repo.** `§1`, `§4.3`, `§1f`, `§A.3`, etc. were
  unreadable for humans (forced readers to flip back to the source doc
  and count headings) and brittle (broke as soon as section numbering
  shifted). Every reference now uses the section's full name — and a
  markdown anchor link when the link target is reachable — in:
  - README.md (plan structure, `Open PR via context file` matrix).
  - Bundled foundation skills under
    `skills/vinta-derive-skills/resources/foundation-skills/`
    (`plan-feature/SKILL.md`, `create-spec/SKILL.md`,
    `create-qa-use-cases/SKILL.md`, `add-one-off-script/SKILL.md`).
  - Template-rendered foundation skills
    (`implement-plan-template.md`, `amend-plan-template.md`,
    `prs-context-template.md`). The
    `amend-plan` `section-2-decision-change` change classification was
    renamed to `guiding-decisions-change` to follow suit.
  - Builder skills (`vinta-bootstrap-ai-tools`, `vinta-analyze-codebase`,
    `vinta-write-agents-md`, `vinta-derive-skills`,
    `vinta-derive-subagents`, `vinta-install-ai-tools-setup`,
    `vinta-sync-ai-tools`, `vinta-bootstrap-ai-tools/resources/stacks/README.md`).
  - JSON schemas (`vinta-ai-workflows-config.v1.schema.json`,
    `prs-context-comments.v1.schema.json`,
    `prs-context-frontmatter.v1.schema.json`).
  - Dev-skills (`add-foundation-skill`, `add-stack`).
  - Historical CHANGELOG entries (descriptions only — wording
    cleaned, no semantic change).

- **Added explicit "no `§N` shorthand" rules to every skill that drafts
  or renders documentation.** Each generator now refuses the pattern in
  the bodies it produces, so the fix sticks instead of drifting back in
  the next regeneration. Touched skills: `vinta-derive-skills` (Rules
  list), `vinta-analyze-codebase` (Rules list), `vinta-write-agents-md`
  (Style rules), `vinta-derive-subagents` (Rules list),
  `implement-plan-template.md` + `amend-plan-template.md` (Important
  rules sections), `prs-context-template.md` (new "Never use `§N`
  shorthand" section), `plan-feature/SKILL.md` (What to avoid),
  `create-spec/SKILL.md` (Style rules + Checklist).

## [0.1.6] — 2026-05-13

### Changed

- **Scrubbed source-repo path leaks from foundation skill bodies and
  illustrative examples across the repo.** The bundled foundation skills
  under `skills/vinta-derive-skills/resources/foundation-skills/`
  (`plan-feature/SKILL.md`, `create-spec/SKILL.md`) referenced paths,
  module names, table names, and worked-example plan filenames carried
  over from the project this content was originally extracted from
  (`core-service/ai-plans/`, `@core-service/app/core/common/feature_flags/feature_flags.py`,
  `lbd-integrations-data`, `sales_order` / `catalog_product`, `core.public_api`,
  `data_auditing`, `ProductSellingAccount.attributes`, `vw_sales_order_*`,
  `@app/core/sales/models/order.py`, `@tests/integration/sales/use_cases/`,
  and `BOOKMARKS` / `ORDER_TAGS` / `SHIPMENT_ATTRIBUTES` / `SELLTHROUGH`
  worked-reference plan filenames). All replaced with project-agnostic
  descriptions or generic placeholders (`ai-plans/`, `<source-repo>/`,
  `apps/<service>/`, `<app>/<module>/`, `WIDGETS`). The bundled skill
  bodies now read cleanly when pasted into an unrelated repo — no
  `vinta-derive-skills` scrub pass required for these particular leaks.
  Same scrub applied to meta-files that mentioned `core-service/` or
  `apps/provider-app/` as illustrative examples of "what gets leaked"
  (`AGENTS.md` + symlinked `.github/copilot-instructions.md`,
  `CHANGELOG.md` historical note, `dev-skills/add-foundation-skill/SKILL.md`
  + its four hardlinked installed copies under
  `.agents/.claude/.cursor/.github/skills/`,
  `skills/vinta-derive-skills/SKILL.md`,
  `skills/vinta-bootstrap-ai-tools/SKILL.md`,
  `skills/vinta-bootstrap-ai-tools/resources/stacks/django/notes.md`,
  `skills/vinta-bootstrap-ai-tools/resources/stacks/medplum/notes.md`,
  `skills/vinta-sync-ai-tools/SKILL.md`,
  `skills/vinta-migrate-plans-specs/SKILL.md`, and
  `schemas/vinta-ai-workflows-config.v1.schema.json` description). No
  schema change; no skill behavior change.

- **Second pass: genericized AWS / Strawberry / Shopify / FHIR examples
  in foundation skill bodies.** Five remaining stack-specific examples
  in foundation skills replaced with framework-neutral language:
  `plan-feature/SKILL.md`'s **Concurrency, transactions, idempotency**
  group, question 1 ("parallel Lambda on same row" → "parallel workers
  / serverless invocations on the same row"); the reusable-skills
  table's `create-lambda` row renamed to `create-cloud-function |
  scaffolds new serverless function`, and the `graphql-public-query`
  row dropped the Strawberry mention. `create-spec/SKILL.md`'s **Use
  cases** group, question 2 swapped "Webhook from Shopify, scheduled
  Lambda" for "Webhook from upstream SaaS, scheduled function".
  `create-qa-use-cases/SKILL.md` dropped the FHIR mention from the
  "no implementation details" rule. Reader still reads cleanly; no
  presumed stack. Other concrete platform mentions in the foundation
  set (Medplum / Vercel / K8s / Jupyter / Django in
  `add-one-off-script/SKILL.md`, Django/DRF/HStore/pytest in
  `plan-feature/SKILL.md` Tier 2) were reviewed and kept as
  illustrative examples per maintainer call.

- **README cheat sheet for foundation skills + sub-agents.** New
  "Cheat sheet — what lands in your project" section inserted between
  "The AI workflow after bootstrap" and "Staying in sync with upstream"
  in `README.md`. Two tables cover what `vinta-bootstrap-ai-tools`
  writes into a target repo's `ai-tools/` layout: the foundation skill
  set (`create-spec`, `plan-feature`, `create-qa-use-cases`,
  `open-pr-from-context`, `implement-plan`, `amend-plan`, plus the
  opt-in skills `systematic-debugging`, `add-e2e-test`, `add-env-var`,
  `add-one-off-script`) with a status column flagging always-on vs
  opt-in, and the foundation sub-agent trio (`implementer`, `reviewer`,
  `fixer`) with access mode + role. Two upfront disclaimers: optional
  foundation skills are gated by the bootstrap interview (recorded in
  `.vinta-ai-workflows.yaml` under `foundation_skills.*.enabled`,
  sticky across syncs); stack-specific skills and sub-agents are
  user-supplied — the package ships only detection signals + category
  lists per stack under
  `skills/vinta-bootstrap-ai-tools/resources/stacks/`, not the bodies.
  No content change; orients new readers before they read the workflow
  sections.

## [0.1.5] — 2026-05-08

### Added

- **README: prominent "Staying in sync with upstream" section** + sync
  pitch in `## Why this is useful`. The new top-level section lands
  between "The AI workflow after bootstrap" and "Running the bootstrap
  skills" and documents the two-step flow (`npm update` →
  `/vinta-sync-ai-tools` from the AI tool), the five classification
  buckets (`affects-project`, `opt-in-offer`, `config-schema-change`,
  `tooling`, `not-applicable`), the role of `.vinta-ai-workflows.yaml`
  as the opt-in source of truth, the per-change `Apply` / `Skip` /
  `Show diff` gating, and when to reach for `vinta-update-project-skills`
  vs the CLI `update` command instead. `## Why this is useful` gains a
  paragraph framing sync as a first-class capability of the package
  (project keeps getting better without re-bootstrapping; opt-outs
  sticky; schema migrations automatic). The `## Update` section gets a
  callout pointing at the new section + a step 3 in its workflow that
  invokes `vinta-sync-ai-tools`. Stale references in the intro
  paragraph and the "Repo internals" section that framed
  `vinta-update-project-skills` as the primary upstream-refresh path
  now point to `vinta-sync-ai-tools`. No skill behavior change.

### Changed

- **Renamed builder skill `vinta-ai-workflows-sync` → `vinta-sync-ai-tools`.**
  Directory moved from `skills/vinta-ai-workflows-sync/` to
  `skills/vinta-sync-ai-tools/`; SKILL.md frontmatter `name:` updated;
  every prose + link reference across the repo (other skill bodies under
  `skills/`, dev-skills, schemas/README.md inventory row, schema
  descriptions in `vinta-ai-workflows-config.v1.schema.json`) repointed
  to the new name. New name reads as a verb-object pair matching its
  sibling `vinta-bootstrap-ai-tools` and avoids embedding the package
  name twice. No behavior change.

## [0.1.4] — 2026-05-06

### Fixed

- **Repository URL typo** across README, `package.json`, and every
  `schemas/*.schema.json` `$id` + the schema directive examples in
  `schemas/README.md`: `git@github.com:vinta/vinta-ai-workflows.git` →
  `git@github.com:vintasoftware/vinta-ai-workflows.git`. The `vinta`
  GitHub org doesn't exist; the package lives under `vintasoftware`.
  Install commands (`npm install -D git+ssh://...`), the `npx -y -p
  git+ssh://...` one-shot, the update-flow examples, and the canonical
  `$schema` URLs IDEs resolve via `# yaml-language-server:` directives
  all pointed at the wrong host. Schema `$id` change is metadata only —
  no validation behavior change, no major bump warranted.

## [0.1.3] — 2026-05-06

### Added

- **`dev-skills/` — maintenance skills for this repo.** New top-level
  directory holding skills agents load when editing `vinta-ai-workflows`
  itself. Excluded from the npm package via the `files` whitelist and
  from the CLI's `SKILLS_SRC` discovery (which only walks `skills/`), so
  these skills never ship to consumer projects.
  - [add-foundation-skill](dev-skills/add-foundation-skill/SKILL.md) —
    walks the full schema-ripple checklist for adding a new foundation
    skill (schema enum, bootstrap interview, derive-skills bucket,
    foundation-shape lists, outputs tree, CHANGELOG). Catches the
    "orphaned schema field" / "schema-but-no-bucket-entry" footguns the
    `AGENTS.md` pitfall list calls out.
  - [add-stack](dev-skills/add-stack/SKILL.md) — adds a new stack under
    `skills/vinta-bootstrap-ai-tools/resources/stacks/<stack>/notes.md`
    + the orchestrator's stack table + `vinta-analyze-codebase`
    detection signals. Enforces the notes-only rule (no SKILL.md / agent
    YAML inside stack dirs).
  - [release](dev-skills/release/SKILL.md) — release flow: pre-flight
    checks (clean tree, on `main`, fetched, CHANGELOG section
    non-empty + matches bump kind, schema enums match every shipped
    foundation skill), version bump, CHANGELOG close, commit + tag +
    push. Surfaces `npm publish` for the user; never auto-publishes.
  - [validate-skill-md](dev-skills/validate-skill-md/SKILL.md) —
    read-only repo-wide lint of every `SKILL.md` (frontmatter shape,
    `name:` = dir name, surviving `{{PLACEHOLDER}}` outside declared
    template files, broken relative links, missing `resources/` paths).
    Exits 1 on errors; CI-friendly.
  - [bump-schema-major](dev-skills/bump-schema-major/SKILL.md) — cuts a
    `v<N>` → `v<N+1>` of a JSON Schema for breaking changes. Copies
    file, applies breaking diff to v<N+1> (leaves v<N> intact during
    deprecation window), walks every consumer for dual-read
    translation, updates `schemas/README.md` inventory + CHANGELOG +
    triggers a major package bump via `release`.
  `AGENTS.md` gains a `dev-skills/` reference table pointing at each.

- **Committed vendor symlinks for `dev-skills/`.** Five repo-root
  symlinks let Claude Code, Cursor, Codex, and VS Code + Copilot
  auto-discover the maintenance skills under `dev-skills/` without any
  per-developer setup step:
  - `.claude/skills` → `../dev-skills`
  - `.cursor/skills` → `../dev-skills`
  - `.github/skills` → `../dev-skills`
  - `.agents/skills` → `../dev-skills` (universal — also picked up by
    Cursor + Copilot)
  - `.github/copilot-instructions.md` → `../AGENTS.md` (Copilot's path)

  `.gitignore` reshaped to un-ignore exactly these paths: `.claude/`,
  `.cursor/`, `.agents/` are now `.<vendor>/*` with explicit
  `!.<vendor>/skills` negations. Every other file under those vendor
  dirs (the per-vendor generated sub-agent files, settings, etc.)
  remains gitignored as before. New committers don't run anything;
  `git clone` + open editor is enough.

  No `dev-skills/setup.mjs` — symlinks are committed once. To add a new
  dev skill: drop the dir under `dev-skills/<name>/` and commit. The
  symlinks expose it automatically.

- **Per-script folder layout for `add-one-off-script`.** Each script
  generated by the skill now lives in its own directory
  `<scripts_dir>/<YYYY-MM-DD>-<name>/` containing `script.{py,ts}`,
  `test_script.{py,ts}`, and `README.md`. Sister
  `run-one-off-script-<stack>` skills (see below) drop the runner
  artefact (Jupyter notebook, Medplum bot, Vercel Function, Django
  management command) into the same folder. Run logs + CSV backups
  land separately under `<log_dir>/<name>/` (default
  `.vinta-ai-workflows/one-off-runs/<name>/`) so an interrupted run
  never pollutes the source folder.

- **Pluggable `Runtime` interface in `BaseOneOffScript`.** Engine
  delegates every runtime-specific concern (single-instance lease,
  stop signal source, log sink, processed-items log, artifact paths,
  final upload) to a `Runtime` instance. Default `LocalRuntime` ships
  alongside the base class — covers a plain CLI invocation with
  filesystem state, PID-file lease, SIGINT/SIGTERM handlers, and
  optional S3 upload. Stack-specific runners ship their own adapters
  (`JupyterRuntime`, `DjangoMgmtRuntime`, `MedplumBotRuntime`,
  `VercelFunctionRuntime`, `K8sJobRuntime`) without needing to fork
  the engine. The contract — "stop must finish current item then
  flush + upload" — is enforced regardless of surface.

- **Sister skill family: `run-one-off-script-<stack>`.** Stack-specific
  skills opted into via the per-stack notes file under
  [resources/stacks/<stack>/notes.md](skills/vinta-bootstrap-ai-tools/resources/stacks/).
  Two stacks shipped notes for this release:
  - `run-one-off-script-django` — authors a Jupyter notebook at
    `notebooks/<name>/runner.ipynb` (Vinta default) or a `BaseCommand`
    subclass under `<app>/management/commands/<name>.py`, plus the
    matching `JupyterRuntime` / `DjangoMgmtRuntime` adapter at
    `<scripts_dir>/_runtime_django.py`. New placeholders in the Django
    notes: invocation surface (Jupyter / mgmt command / both),
    notebook directory path.
  - `run-one-off-script-medplum` — authors a Medplum bot under
    `<bots_dir>/one_off_<YYYY_MM_DD>_<name>/handler.ts` plus
    `MedplumBotRuntime` at `<scripts_dir>/_runtime_medplum.ts`.
    Backups + run log upload to Medplum `Binary` resources (no FS in
    a bot) — restore reads them back via the FHIR API. Tenant
    scoping (`meta.account`) follows the project's standard pattern.
  Skill content itself is user-supplied per the existing convention
  (`resources/stacks/<stack>/notes.md` describes the category, not
  ready-made content).

- **New optional foundation skill: `add-one-off-script`** (copied verbatim
  to `ai-tools/skills/add-one-off-script/` per project, opt-in via the
  Step 0 **Optional foundation skills → add-one-off-script** question).
  Source:
  [skills/vinta-derive-skills/resources/foundation-skills/add-one-off-script/](skills/vinta-derive-skills/resources/foundation-skills/add-one-off-script/).
  Authors safe one-off operational scripts (data backfills, ad-hoc
  cleanups, tenant fixes outside the regular migration / ETL / cron
  path) following a strict contract: `execute(dry_run=True)` by default,
  idempotent on re-run via state-based filters or a fsync'd resume log,
  batched DB ops (no full-table locks), streamed reads via generators
  (no `.all()` / `fetchall()`), segmented CSV backups before destructive
  writes (max 1M cells per file, never nested across tables, one set of
  files per affected table) with a built-in `restore_from_backup()`
  path, interruption-safe SIGINT/SIGTERM handlers that flush + upload
  before exit, console + filesystem + S3 logging that survives the
  interruption, and a PID file + `--status` mode for monitoring from a
  second shell. Filenames must start with the authoring date
  (`YYYY-MM-DD-<descriptive-kebab>.{py,ts}`) and live under
  `<scripts_dir>/one_off/` (default `scripts/one_off/`).

  Bundled `BaseOneOffScript` templates ship in two languages — pick one
  per project at bootstrap (or per-script if polyglot):
  - [resources/one_off_script_base.py](skills/vinta-derive-skills/resources/foundation-skills/add-one-off-script/resources/one_off_script_base.py)
    — Python (Django, plain SQLAlchemy, raw psycopg).
  - [resources/one_off_script_base.ts](skills/vinta-derive-skills/resources/foundation-skills/add-one-off-script/resources/one_off_script_base.ts)
    — TypeScript (Node 20+, works with Prisma, Drizzle, Knex, raw `pg`).

  Subclasses override only the per-script hooks (`describe`,
  `iter_targets`, `process`, `item_id`, `tables_touched`, `snapshot`,
  `apply_restore_row`); the engine methods (`run`, `_safe_process`,
  `_write_backup`, signal handlers, S3 upload, PID lifecycle) are part
  of the contract and not overridable in practice.

- **`.vinta-ai-workflows.yaml` config additions for `add-one-off-script`**:
  - `foundation_skills.add-one-off-script: enabled | disabled` —
    sticky opt-in like every other foundation skill.
  - `skills.add-one-off-script.scripts_dir: string` (default
    `scripts/one_off`) — where the new scripts land in the repo.
  - `skills.add-one-off-script.language: python | typescript` — selects
    which `BaseOneOffScript` template gets staged at
    `<scripts_dir>/_base.{py,ts}`.
  - `skills.add-one-off-script.log_dir: string` (default
    `.vinta-ai-workflows/one-off-runs`) — where logs, PID files,
    processed-items logs, and CSV backup chunks land. Already covered
    by the umbrella `.vinta-ai-workflows/` gitignore entry added in
    0.1.3.
  - `skills.add-one-off-script.default_batch_size: integer` (default
    `500`) — passed into `BaseOneOffScript.config.batch_size` when the
    script doesn't override.
  - `skills.add-one-off-script.csv_max_cells: integer` (default
    `1000000`) — per-CSV-chunk cell cap before the writer rolls over to
    the next file. Encodes the contract's "max 1M cells per file" rule.
  - `skills.add-one-off-script.s3_bucket: string` (optional; falls back
    to `ONE_OFF_S3_BUCKET` env at runtime) — destination for log + CSV
    uploads on clean or signal-driven exit. Empty disables S3 upload;
    the filesystem copy stays authoritative.
  - `skills.add-one-off-script.s3_prefix: string` (default
    `one-off-runs/`; falls back to `ONE_OFF_S3_PREFIX` env).

- **Bootstrap interview Step 0 — Optional foundation skills → `add-one-off-script` question**:
  new question for the `add-one-off-script` skill plus three short
  follow-ups (scripts dir, primary language, S3 bucket + prefix). The
  **Optional foundation skills** header wording at the top switched from
  "three skills" to "four skills" accordingly. Outputs tree updated to
  list `ai-tools/skills/add-one-off-script/` plus its `resources/`
  directory carrying the language-specific `BaseOneOffScript` templates.
  The **Existing AI artifacts** group's foundation-shape name list
  (which gates the `Replace with Vinta foundation version` option)
  gained `add-one-off-script`.

- **`vinta-derive-skills` bucket C** gains a third optional skill —
  `add-one-off-script` — alongside `add-e2e-test` and `add-env-var`.
  Unlike the other two, this one is copy-verbatim (no per-project
  drafting interview); the project-specific variability lives entirely
  in the `skills.add-one-off-script.*` config block and in env vars
  consumed at runtime.

- **New optional foundation skill: `systematic-debugging`** (renders to
  `ai-tools/skills/systematic-debugging/SKILL.md` per project, opt-in
  via the Step 0 **Optional foundation skills → systematic-debugging**
  question). Source:
  [skills/vinta-derive-skills/resources/systematic-debugging-template.md](skills/vinta-derive-skills/resources/systematic-debugging-template.md).
  Root-cause-first debugging flow with project-specific reproduction
  commands ({{TEST_CMD}}, {{LINT_CMD}}, {{BUILD_CMD}},
  {{NEW_TEST_CMD_PATTERN}}, etc) and an enforced **Phase 0 observability
  sweep** that requires pulling evidence from the project's MCP servers
  before any hypothesis. Skill enforces an "iron law" — no code change
  until the cause is named — plus a three-strikes architectural-question
  rule, a red-flag self-talk list, and a verification checklist.
  Generated only when `foundation_skills.systematic-debugging: enabled`
  in `.vinta-ai-workflows.yaml`.

- **MCP-agnostic evidence categories doc**:
  [skills/vinta-derive-skills/resources/systematic-debugging-mcp-tools.md](skills/vinta-derive-skills/resources/systematic-debugging-mcp-tools.md).
  Replaces a per-vendor catalogue (Sentry / Datadog / etc.) with seven
  evidence categories (error tracking, distributed tracing, logs,
  metrics, alerts / SLO burn, deploys / releases, dashboards). The
  rendered SKILL.md tells the agent to list available MCP tools at
  runtime and match them to categories by description + parameter
  names — so the skill stays correct as MCP servers add or rename
  tools. The block is rendered verbatim into `{{OBSERVABILITY_MCP_BLOCK}}`;
  no per-server templating happens at generation time.

- **New schema: `mcp-preflight-cache.v1`**
  ([schemas/mcp-preflight-cache.v1.schema.json](schemas/mcp-preflight-cache.v1.schema.json)).
  Defines `.vinta-ai-workflows/cache.yaml` — the per-developer-machine
  preflight state for the systematic-debugging skill. No TTL: `ok`
  entries stay valid until something fails. A failed MCP call mid-debug
  flips the offending server to `dirty`, forcing a re-preflight on the
  next debug run. Statuses: `ok | dirty | missing | auth-error |
  unreachable`. Inventory row added to
  [schemas/README.md](schemas/README.md).

- **`.vinta-ai-workflows.yaml` config additions**:
  - `foundation_skills.systematic-debugging: enabled | disabled`.
  - `skills.systematic-debugging.observability_mcp_servers: string[]`
    — free-form list of MCP server identifiers (no enum — the user
    names whatever shorthand the team uses). Empty array allowed but
    degrades the skill (Phase 0 collapses to "local logs only").
  - `run_options.systematic-debugging.allow_local_only_debug: boolean`
    (default `true`) — controls whether developers may opt out of
    Phase 0 per run with a `local-only` keyword.

- **Bootstrap interview Step 0 — Optional foundation skills → `systematic-debugging` question**:
  new question for the systematic-debugging skill, plus a free-form follow-up that asks the
  user to name observability MCP servers already wired up. The
  orchestrator cross-checks the answer against the project's actual MCP
  config files (`.mcp.json`, `~/.claude/mcp_servers.json`,
  `.codex/mcp.json`, etc.) and surfaces servers the user did not
  mention. Selection lands in
  `skills.systematic-debugging.observability_mcp_servers`.

### Changed

- **`prs-context/` moved to `.vinta-ai-workflows/prs-context/`.**
  Brings PR-context drafts under the same per-developer-machine
  umbrella as the new MCP preflight cache. All path references updated
  across schemas, templates, foundation skills, README, sync skill,
  bootstrap skill, and `setup-ai-tools.mjs`. Migration for projects
  bootstrapped against earlier versions is the natural job of
  [vinta-sync-ai-tools](skills/vinta-sync-ai-tools/SKILL.md);
  the existing `prs-context/` dir + stale `.gitignore` entry stay
  harmless until sync runs.

- **`setup-ai-tools.mjs` gitignore management**: entries collapsed
  from `['prs-context/']` to `['.vinta-ai-workflows/']`. Single umbrella
  entry now covers `prs-context/`, `cache.yaml`, and any future
  per-machine state added under `.vinta-ai-workflows/`. Comment block
  rewritten to document the directory's contents.

- **`vinta-derive-skills` bucket B**: `systematic-debugging` joins
  `implement-plan` and `amend-plan` as a template-rendered foundation
  skill. Placeholder table extended with `{{OBSERVABILITY_MCP_BLOCK}}`
  and `{{OBSERVABILITY_MCP_LIST}}`. Render rules call out the runtime
  tool-discovery contract.

- **`schemas/vinta-ai-workflows-config.v1.schema.json`** —
  `foundation_skills` properties block gains the
  `systematic-debugging` enum entry; `skills.systematic-debugging`
  added under the (already open) per-skill `skills` map;
  `run_options.systematic-debugging.allow_local_only_debug` added.
  All additions are optional fields → no schema major bump.

## [0.1.2] — 2026-05-06

### Added

- **Schema-as-contract: `schemas/` directory** at the repo root. Four
  JSON Schema (Draft 2020-12) files now define every YAML format the
  toolchain produces or consumes. Every YAML payload carries a top-level
  `schema_version: <int>` matching the schema filename suffix.
  - [`vinta-ai-workflows-config.v1.schema.json`](schemas/vinta-ai-workflows-config.v1.schema.json)
    — for `.vinta-ai-workflows.yaml` (project config, see below).
  - [`sub-agent.v1.schema.json`](schemas/sub-agent.v1.schema.json) —
    for `ai-tools/agents/<name>.yaml` (vendor-agnostic sub-agent
    definitions consumed by `setup-ai-tools.mjs`). Documents the four
    vendor-override sub-objects (`overrides.{claude,cursor,copilot,codex}`).
  - [`prs-context-frontmatter.v1.schema.json`](schemas/prs-context-frontmatter.v1.schema.json)
    — for the YAML frontmatter at the top of every
    `prs-context/{feature-kebab}/phase-{phase.id}.md` file.
  - [`prs-context-comments.v1.schema.json`](schemas/prs-context-comments.v1.schema.json)
    — for the YAML list inside the `# Comments` ` ```yaml ` fence.
  - [`schemas/README.md`](schemas/README.md) documents versioning
    rules (when to bump major, how to ship `vN+1` alongside `vN`),
    IDE wiring via `# yaml-language-server: $schema=...` directives,
    and CI validation snippets (`ajv-cli`).

- **Project config file: `.vinta-ai-workflows.yaml`** (new — written by
  `vinta-bootstrap-ai-tools` Step 0.5, read + rewritten by
  `vinta-ai-workflows-sync`). Single source of truth for project-wide
  settings:
  - `vinta_ai_workflows_version` — last package version synced from.
  - `project.{name, default_branch, code_host, stack_summary, ai_plans_dir, pr_template_paths}`.
  - `commands.{lint, format, build, test_unit, test_unit_scoped, test_unit_new_pattern, e2e}`.
  - `policies.{pr_creation, ai_coauthor, commit_style, stage_pattern, anti_git_add_all_reason}`.
  - `vendors` — claude / cursor / copilot / codex selection.
  - `foundation_skills` + `foundation_agents` — per-artifact opt-in
    (`enabled` / `disabled`). `disabled` is sticky — `vinta-ai-workflows-sync`
    won't re-propose disabled artifacts.
  - `stacks` + `stack_specialist_agents` — applied stack templates.
  - `run_options.<skill>` — per-skill defaults
    (`implement-plan.{pause_between_phases, generate_inline_comments}`,
    `amend-plan.blast_radius_signal_threshold`).
  - `skills.<name>` — per-skill custom config (open shape per skill).
  Replaces today's pattern of inlining interview answers into rendered
  SKILL.md bodies; bodies will continue to inline values (Path B) but
  re-rendering is driven from the config so values can be edited and
  propagated by re-running sync.

- **New builder skill: `vinta-ai-workflows-sync`**
  ([SKILL.md](skills/vinta-ai-workflows-sync/SKILL.md)). Brings a
  project up to date with the latest package version. Workflow:
  1. Load `.vinta-ai-workflows.yaml`; validate against schema. If
     missing, run "Bootstrapping the config file" — reverse-extracts
     state from existing artifacts + interview-fills gaps.
  2. Diff the project's `vinta_ai_workflows_version` against the
     cloned package's current version; parse `CHANGELOG.md` to
     enumerate releases between.
  3. Per change, classify against the project's opt-in surface
     (`affects-project` / `opt-in-offer` / `config-schema-change` /
     `not-applicable` / `tooling`). Cross-validate via file diff;
     surface orphan diffs (no changelog entry) at the end.
  4. Build a per-bucket proposal with inline diffs; `AskUserQuestion`
     per change (`Apply` / `Skip` / `Show diff`); batch tooling
     changes under one prompt.
  5. Apply approved: migrate config schema, flip opt-ins to
     `enabled`, re-render templates, re-copy verbatim foundation
     skills (delegated to [vinta-update-project-skills](skills/vinta-update-project-skills/SKILL.md)),
     re-run setup-ai-tools.mjs in idempotent mode.
  6. Re-validate every YAML file against its schema.
  7. Bump `vinta_ai_workflows_version` + `last_synced_at`.
  Layers on top of `vinta-update-project-skills` (narrow tool stays;
  sync calls it for foundation-skill body diffs).

- **`vinta-bootstrap-ai-tools` Step 0.5 — Write `.vinta-ai-workflows.yaml`**.
  New step inserted between Step 0 (interview) and the sub-skill flow.
  Captures all interview state into the canonical config file before
  any sub-skill runs. Validates against the schema; partial configs
  route back to the relevant interview question. Re-bootstrap of an
  existing-config project asks `Keep existing / Re-interview / Stop`.
  Outputs tree updated to show `.vinta-ai-workflows.yaml` at the repo
  root.

- **Schema directives** added to the templates that emit YAML files —
  `# yaml-language-server: $schema=...` lines at the top of each
  authored payload so IDEs auto-validate. Wired into:
  - [skills/vinta-derive-skills/resources/prs-context-template.md](skills/vinta-derive-skills/resources/prs-context-template.md)
    (frontmatter + `# Comments` fence).
  - [skills/vinta-derive-subagents/SKILL.md](skills/vinta-derive-subagents/SKILL.md)
    (sub-agent YAML shape examples now show `schema_version: 1` +
    schema directive).

- **New project-skill template: `amend-plan`** (renders to
  `ai-tools/skills/amend-plan/SKILL.md` per project, alongside
  `implement-plan`). Source:
  [skills/vinta-derive-skills/resources/amend-plan-template.md](skills/vinta-derive-skills/resources/amend-plan-template.md).
  Companion to `implement-plan` — same agents, same review gates, same
  prs-context flow; opposite git topology direction (history rewriting
  instead of forward execution). Use cases: spec change forces a phase
  body rewrite, a phase needs to slot in between existing ones, or a
  **Guiding Decisions** row changes and cascades through later phases.

  Flow:
  1. Edit the plan file (rewrite affected phase bodies, insert / append
     new phases, log the amendment in `## Amendments`).
  2. Build a per-phase state map (`not-started` / `in-progress` /
     `implemented-not-merged` / `merged-to-default`).
  3. **Blast-radius evaluation.** Compute signals (rewrite share ≥ 50%,
     **Guiding Decisions** cascade ≥ 50%, ≥2 immutable phases combined with earlier
     rewrites, data-model contract change in >2 phases, ≥70% rewritten
     LoC, multi-author branches, ≥2 approved PRs). ≥2 signals tripping
     → surface a `Restart` option to the user before any force-push
     plan is shown. On `Restart`: hand off to `plan-feature` for a
     fresh `YYYY-MM-DD-FEATURE_NAME_PLAN.md`; annotate the old plan
     `Superseded`; leave old phase branches in place for audit; exit.
  4. Refuse force-pushes that can't work — phases merged to the default
     branch are immutable; amendment must be a new appended phase.
     Branch protection, multi-author branches, and approved PRs all
     prompt for explicit confirmation.
  5. Per affected phase, in stack order: spawn an implementer subagent
     to bring the diff into compliance with the new body, run inner +
     outer test loops, run all three review layers, rebase onto the
     (possibly-rewritten) parent, then `git push --force-with-lease`.
     Conflicts resolved by a fixer subagent.
  6. Refresh the `prs-context/{feature}/phase-{id}.md` file: pending
     ones get rewritten in place; published ones may flip back to
     pending and re-publish via `open-pr.sh` so new comments post.
  7. Update `TRACKING_{plan-id}.md` with amendment notes; final report
     lists every branch state, pending PR-contexts, blocked rewrites
     with forward-phase suggestions, and a reviewer re-request reminder.

  Hard rules:
  - Never `--force`. Always `--force-with-lease`.
  - Per-branch confirmation; never batch.
  - Subagents commit but never push — orchestrator owns force-push.
  - Phases merged to default branch are converted to `append-new` and
    handed off to `implement-plan`, not rewritten here.
  - `not-started` phases never executed by this skill — also handed off
    to `implement-plan`.
- **`vinta-bootstrap-ai-tools` Outputs tree** updated to list
  `ai-tools/skills/amend-plan/SKILL.md` alongside `implement-plan`.
- **`vinta-derive-skills` bucket B** now generates two skills from
  templates instead of one. Both templates share the same placeholder
  set (`{{LINT_CMD}}`, `{{BUILD_CMD}}`, `{{TEST_CMD}}`, `{{DEFAULT_BRANCH}}`,
  `{{PR_*}}` family, `{{COAUTHOR_*}}` family, `{{COMMIT_STYLE_LINE}}`,
  etc.) — substitute once, render twice.

- **New foundation skill + bundled script: `open-pr-from-context`**
  ([SKILL.md](skills/vinta-derive-skills/resources/foundation-skills/open-pr-from-context/SKILL.md),
  [scripts/open-pr.sh](skills/vinta-derive-skills/resources/foundation-skills/open-pr-from-context/scripts/open-pr.sh)).
  The mechanical work — parse frontmatter + sections, detect CLI, open
  PR, post each inline comment, rewrite frontmatter, append publish log —
  lives in the bash script; the SKILL.md is a thin wrapper that picks
  the file, runs the script, and reports the result. Script deps:
  `bash 4+`, `git`, `yq` (Mike Farah), `jq`, plus one of `gh` / `glab`.
  Per-comment failure tolerated — bad ones reported, run continues.
  On success rewrites the file's frontmatter to `status: published` +
  `pr_url`, appends a timestamped publish log. Strictly scoped: no push,
  no test re-runs, no diff editing, no draft generation. Bundled with
  the `vinta-derive-skills` foundation set so it ships with every new
  bootstrap. Exit codes: 0 (full success), 1 (PR up, comment failures),
  2 (hard failure / missing deps).
- **PR-context template** at
  [skills/vinta-derive-skills/resources/prs-context-template.md](skills/vinta-derive-skills/resources/prs-context-template.md)
  defining the reproducible file shape: frontmatter (plan_id, feature_name,
  phase_id, phase_title, branch, base, created_at, status, pr_url) +
  `# Title`, `# Description`, `# Comments` sections (single fenced YAML
  list of `{file, start_line, end_line?, side, body}` entries).
- **`implement-plan` Step 0 opt-in questions** (template-level —
  `vinta-derive-skills` renders these into the project's `implement-plan`
  skill body):
  - **Pause between phases?** Default off (auto-flow). When on, a new
    **Per-phase pause gate** step fires after each phase's user update
    with `Continue` / `Pause` / `Stop` options; orchestrator exits
    cleanly on Pause and resumes on next invocation per the existing
    "Re-running mid-plan" flow.
  - **Generate PR descriptions + inline comments?** Default off. When on,
    a new **Open PR via context file** draft step fires after every
    phase: agent picks 3–10
    non-obvious comment targets from the diff (subtle invariants,
    feature-flag short-circuits, cross-phase coupling, upstream-contract
    naming), writes `prs-context/{feature-kebab}/phase-{phase.id}.md`
    following the template, and — if a PR CLI is detected — invokes
    `open-pr-from-context` to publish.
- **`prs-context/` auto-added to `.gitignore`** by
  [skills/vinta-install-ai-tools-setup/resources/setup-ai-tools.mjs](skills/vinta-install-ai-tools-setup/resources/setup-ai-tools.mjs)
  on first invocation. Idempotent (re-runs don't duplicate the entry);
  preserves any existing `.gitignore` content; appends a labeled block.
- **Run-options state** (`run_options.pause_between_phases`,
  `run_options.generate_pr_context`) recorded in the per-plan tracking
  file so re-running mid-plan honors the original choices.
- **Quick checklist + Important rules** in the implement-plan template
  updated with bullets for opt-in honoring and PR-context durability.

### Changed

- **`setup-ai-tools.mjs` validates `schema_version`** on every loaded
  `ai-tools/agents/<name>.yaml`. Files lacking `schema_version: 1`
  fail fast with a clear error pointing at
  `schemas/sub-agent.v1.schema.json`.

- **PR-context generation honors existing project PR / MR templates.**
  New `project.pr_template_paths: string[]` field in
  [`vinta-ai-workflows-config.v1.schema.json`](schemas/vinta-ai-workflows-config.v1.schema.json)
  lists templates detected at bootstrap. Detection in
  [`vinta-analyze-codebase`'s **Existing AI-tooling artifacts** scan](skills/vinta-analyze-codebase/SKILL.md#11-existing-ai-tooling-artifacts)
  now scans (case-insensitive):
  - GitHub: `.github/pull_request_template.md`,
    `.github/PULL_REQUEST_TEMPLATE.md`,
    `.github/PULL_REQUEST_TEMPLATE/*.md`,
    repo-root + `docs/` variants.
  - GitLab: `.gitlab/merge_request_templates/*.md`.
  Inventory output adds `existing_ai_artifacts.pr_templates[]` with
  `path` + section summary per template.

  The `implement-plan` skill's **Open PR via context file** step (step 2) now reads `project.pr_template_paths`
  and uses the chosen template's section structure verbatim for the
  prs-context `# Description`. Sections are filled with phase-specific
  content; `<!-- HTML comments -->` placeholders are preserved;
  checklists are ticked only for items the diff actually satisfies.
  Multi-template directories prompt the user once; the choice is
  cached under `run_options.pr_template_used` for subsequent phases.
  Empty array → free-form description with default sections
  (`## Summary`, `## Plan reference`, `## Test plan`).

  The `amend-plan` skill's **Refresh the PR-context file** step follows the same rule when refreshing prs-context
  bodies, picking up the current `pr_template_paths` even when the
  template was added or swapped after the original `implement-plan`
  run.

  [`prs-context-template.md`](skills/vinta-derive-skills/resources/prs-context-template.md)
  `# Description` guidance updated with the three branches (one
  template / multiple templates / empty).

- **PR creation consolidated to a single flow.** Earlier drafts had two
  parallel paths in `implement-plan`: the legacy `{{PR_CREATION_INSTRUCTION_BLOCK}}`
  inside the **Branch push** step (raw `gh pr create` / `glab mr create`)
  and the new `prs-context` + `open-pr.sh` flow inside the **Open PR via
  context file** step. Removed the legacy block. PRs now always go through
  a `prs-context/{feature-kebab}/phase-{phase.id}.md` file + the bundled
  script, even when inline comments are off. Behavior matrix in the
  [implement-plan template's **Open PR via context file** step](skills/vinta-derive-skills/resources/implement-plan-template.md):

  | PR policy | inline comments | What the **Open PR via context file** step does |
  |---|---|---|
  | agents create | off | write file (empty comments) + run `open-pr.sh` |
  | agents create | on  | write file (full) + run `open-pr.sh` |
  | branches only | off | skip the step |
  | branches only | on  | write file (durable record); skip script |

- **Renamed run-option:** `run_options.generate_pr_context` →
  `run_options.generate_inline_comments`. The opt-in is now strictly
  about inline comments — PR opening itself is governed by the project's
  PR creation policy captured at bootstrap, not by this per-run flag.
- **Removed placeholder** `{{PR_CREATION_INSTRUCTION_BLOCK}}` from the
  implement-plan template + `vinta-derive-skills` SKILL.md substitution
  table. The remaining `{{PR_*}}` placeholders cover framing only
  (description, push, checklist, summary phrasing); they no longer
  carry raw `gh pr create` lines.
- **Important rule + Quick checklist** updated to describe the unified
  **Open PR via context file** matrix instead of the previous two-flag gate.

## [0.1.1] — 2026-05-05

### Added

- **New sub-skill: `vinta-migrate-plans-specs`** — finds existing implementation
  plans and feature specs scattered across a project (`docs/`, `specs/`,
  `plans/`, root markdown, branch-named files, ADRs, legacy `_IMPLEMENTATION_PLAN`
  variants) and migrates them to the canonical `ai-plans/YYYY-MM-DD-{FEATURE_NAME}_{PLAN|SPEC}.md`
  layout. Read-only by default; every rename gated on per-file user approval
  via `AskUserQuestion`. Classifies PLAN vs SPEC by filename + body shape;
  derives date from filename, doc body, `git log --diff-filter=A --follow`,
  or asks. Locks paired spec+plan to the same `FEATURE_NAME`. Rewrites
  inbound markdown references in the same batch as each move.
- **`vinta-bootstrap-ai-tools` Step 0 — Existing AI artifacts disposition.**
  Per-artifact `AskUserQuestion` over every instruction doc, skill, and
  sub-agent found in the repo. Options: `Migrate to ai-tools/<…>`,
  `Keep in current vendor path, don't touch`, `Drop`, plus
  `Replace with Vinta foundation version` for foundation-shape names
  (`plan-feature`, `create-spec`, `create-qa-use-cases`, `implement-plan`,
  `add-e2e-test`, `add-env-var`, `implementer`, `reviewer`, `fixer`).
  Decisions never batched — one prompt per artifact.
- **`vinta-bootstrap-ai-tools` sub-skill flow extended to six steps.**
  Step 6 dispatches `vinta-migrate-plans-specs`. The Step 0 **Scope →
  Which sub-skills to run** question updated to offer a `Skip
  migrate-plans-specs` option in the custom selection.
- **`vinta-bootstrap-ai-tools` Outputs section** now documents the
  `ai-plans/` tree alongside the `ai-tools/` tree.
- **`vinta-bootstrap-ai-tools` Verification** check #6 — confirms migrated
  docs land in canonical `YYYY-MM-DD-{FEATURE_NAME}_{PLAN|SPEC}.md` form
  and no orphaned plan/spec markdown remains in `docs/`, `specs/`, or
  repo root.
- **`vinta-analyze-codebase` — Existing AI-tooling artifacts scan.** Full
  enumeration of instruction docs, skills (across `.claude/skills/`,
  `.cursor/skills/`, `.codex/skills/`, `.github/skills/`, `.agents/skills/`,
  `ai-tools/skills/`), and sub-agents (across the parallel `agents/`
  paths). Each entry classified `vinta-managed` / `foundation-shape` /
  `project-custom` / `stack-specialist`. Setup-script presence + symlinks
  recorded. Plans-dir presence flagged.
- **Inventory schema** (`existing_ai_artifacts.{instructions,skills,agents,setup,plans_dir_present}`)
  added to `vinta-analyze-codebase` output, consumed by the four
  downstream sub-skills.
- **`vinta-write-agents-md` Inputs — existing instruction docs** — three explicit branches per
  existing instruction doc: `Merge into new ai-tools/AGENTS.md`,
  `Keep as-is, link from ai-tools/AGENTS.md`, `Replace from scratch`.
  Discarded files surfaced in the run summary.
- **`vinta-derive-subagents` "Reconcile against existing agents (do this FIRST)"
  section.** Vendor-format → canonical YAML conversion table (Claude
  `tools:` CSV, Cursor `readonly`, Codex `sandbox_mode`, Copilot
  `tools[]`). Foundation trio only emitted when missing or explicitly
  replaced.
- **`vinta-derive-skills` "Reconcile against existing skills (do this FIRST)"
  section.** Migrate uses `git mv`, body scrubbed for hard-coded vendor
  paths after move. `vinta-*` directories left alone (managed by the
  CLI). Foundation duplicates suppressed when the user has `Migrate` /
  `Keep` on the matching name.

### Changed

- **`vinta-bootstrap-ai-tools` sub-skill flow** updated from "five sub-skills"
  to "six sub-skills" wording across the orchestrator. The Step 0 **Scope
  → Which sub-skills to run** default changed from `All five` to `All six`.
- **`vinta-analyze-codebase`** documentation split: the **Documentation
  already present** scan is now READMEs / ADRs only; existing AI tooling
  moved to its own **Existing AI-tooling artifacts** scan with deeper
  coverage.

### Notes

- The new disposition flow makes bootstrap **non-destructive by default**
  for any repo that already has AI tooling — nothing gets overwritten
  without an explicit per-artifact `Replace` answer.
- Foundation skills (`plan-feature`, `create-spec`, `create-qa-use-cases`)
  still hard-code source-repo paths (e.g. `<source-repo>/ai-plans/`) in their
  bundled bodies; `vinta-derive-skills` already scrubs these after copy.
  `vinta-migrate-plans-specs` flags the legacy `_IMPLEMENTATION_PLAN`
  suffix during migration so projects can align their foundation-skill
  bodies to the new `_PLAN` standard. A follow-up release will update
  the bundled foundation-skill resources to use the project's canonical
  paths from the start.

## [0.1.0] — 2026-05-05

### Added

- Initial release of `vinta-ai-workflows` as a private npm package
  exposing the `vinta-ai-workflows` CLI bin.
- Seven `vinta-`-prefixed bootstrap skills under `skills/`:
  `vinta-analyze-codebase`, `vinta-bootstrap-ai-tools`, `vinta-derive-skills`,
  `vinta-derive-subagents`, `vinta-install-ai-tools-setup`,
  `vinta-update-project-skills`, `vinta-write-agents-md`.
- `vinta-ai-workflows` CLI commands: `install`, `update`, `uninstall`, `list`.
- Multi-vendor install support: Claude Code (`.claude/skills/`), Codex
  (`.agents/skills/`), Cursor (`.cursor/skills/`), VS Code + Copilot
  (`.github/skills/`), plus virtual `agents` tool that writes to
  `.agents/skills/` to cover Codex + Cursor + Copilot in one shot.
- Symlink-by-default install (auto-tracks `npm install` / `git pull`
  refreshes); `--copy` mode for projects that don't preserve symlinks.
- Marker-based uninstall safety: removes only symlinks pointing back
  into the package's `skills/` tree or directories containing
  `.installed-by-vinta-ai-workflows`. Hand-installed skills survive.
- `vinta-update-project-skills` skill: refresh project's
  `ai-tools/skills/` against latest source, per-skill diff + explicit
  accept gate.
- README documenting `git+ssh://` install (no registry needed),
  optional GitHub Packages flow, `npx` one-shot, and full workflow recap.
