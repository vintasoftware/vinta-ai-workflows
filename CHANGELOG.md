# Changelog

All notable changes to `vinta-ai-workflows` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] — YYYY-MM-DD

<!-- pre-release: 0.7.0-alpha19 on 2026-09-19 -->
<!-- pre-release: 0.7.0-alpha18 on 2026-09-17 -->
<!-- pre-release: 0.7.0-alpha17 on 2026-09-17 -->
<!-- pre-release: 0.7.0-alpha16 on 2026-09-16 -->
<!-- pre-release: 0.7.0-alpha15 on 2026-09-16 -->
<!-- pre-release: 0.7.0-alpha14 on 2026-09-16 -->
<!-- pre-release: 0.7.0-alpha13 on 2026-09-16 -->
<!-- pre-release: 0.7.0-alpha12 on 2026-09-15 -->
<!-- pre-release: 0.7.0-alpha11 on 2026-09-15 -->
<!-- pre-release: 0.7.0-alpha10 on 2026-09-15 -->
<!-- pre-release: 0.7.0-alpha9 on 2026-09-14 -->
<!-- pre-release: 0.7.0-alpha8 on 2026-09-14 -->
<!-- pre-release: 0.7.0-alpha7 on 2026-09-14 -->
<!-- pre-release: 0.7.0-alpha6 on 2026-09-13 -->
<!-- pre-release: 0.7.0-alpha5 on 2026-09-13 -->
<!-- pre-release: 0.7.0-alpha4 on 2026-09-13 -->
<!-- pre-release: 0.7.0-alpha3 on 2026-09-12 -->
<!-- pre-release: 0.7.0-alpha2 on 2026-09-12 -->
<!-- pre-release: 0.7.0-alpha1 on 2026-09-11 -->

### Added

- **A timed-out gate says whether it hung or was slow.** A `gate_result` with
  `status: timed_out` used to carry only the status, so a run with nine
  timeouts could not say whether any of them was a stuck suite or a host too
  busy to finish one. It now carries `timeout`: `quiet_ms` (how long the gate
  had gone without writing anything when it was killed), `output_bytes`, and
  the host's `load_1m` beside `cpus`. `quiet_ms` near the timeout is a gate
  waiting on something; a small one with `load_1m` well above `cpus` is
  contention. Numbers only, as before: nothing the gate printed reaches the
  row. The monitor's brief points at the new field. Older rows have no
  `timeout`.

- **Gate durations are now kept, not just displayed.** Every `gate_result` has
  carried the runner's own `duration_ms` since gates were journalled, and
  nothing read it back: the figure went to a live panel and was afterwards
  reachable only by hand-parsing event payloads, so the one measurement that
  answers "is the suite why this run took an hour" could not be asked of a
  finished run. `analyzeRun` now rolls it up per gate — runs, cache hits,
  summed runtime, the slowest single run, verdicts by kind — and each phase's
  time split carries `gateRunMs` beside `gatePoolQueueMs`, so a run says how
  much of its working time was the gate queue and how much was the gate. The
  post-mortem carries the same as a `gate_costs` finding, which is what makes
  it durable: `plan-feature` reads these artifacts when sizing the next plan,
  and a gate pool's capacity and `max_parallel_lanes` are one decision made
  with half the numbers. Cache hits are counted and their time kept in its own
  `cache_saved_ms` column — a hit's duration is what the gate cost when it last
  ran, and adding it to the runtime would report time the run specifically did
  not spend. A verdict written before the runner measured itself is counted and
  its milliseconds are not: both reports emit a `gate_durations_unrecorded` gap
  naming the gates, because a gate reported as free is the number a planner
  would act on hardest.

- **Phases can run chores: declared agent turns that change the diff rather than
  judge it.** A gate is a shell command that says pass or fail; a chore is an
  agent asked to do something to the work — rewrite the comments this phase
  wrote, add the changelog entry, extract the strings that need translating. It
  runs on the implementer's own session, so the agent that wrote the diff is the
  one asked to act on it. Declare them in `chores.<id>` (a `prompt` or a
  `prompt_ref` into the plan, plus an optional `skill` the prompt names) and
  pick them with `defaults.chores` for the run or `nodes[].chores` for one
  phase — a node's list replaces the default rather than adding to it, so `[]`
  opts a phase out. In `standard-phase` they run in a new `polish` state,
  between a passing review and the gate: a chore edits the tree, so running it
  later would merge a diff the gates never ran against, and running it earlier
  would have the fixer rewrite what it just did. A chore that fails, or that the
  harness had no capacity for, is journalled and the phase continues to its
  gates — `on_failure: "fail"` is for one the phase is not correct without.

- **The post-mortem now reports what the schedule cost.** Two findings, both
  derived from events the journal already carried. `critical_path` is the
  dependency chain that decided the wall clock — each phase's span, the total,
  and its share of elapsed — because every phase *off* that chain could be made
  instant without moving the run, and nothing said which phases those were.
  `idle_capacity` reports the width the graph actually reached against the lanes
  it asked for: a plan declaring three lanes that never runs more than two
  phases at once pays for a third worktree, a third forked database and a third
  desk, and gets none of them back. Run against a real fourteen-hour build, the
  two say its critical path was **99% of elapsed time** — six phases, effectively
  serial — with peak concurrency 2 against 3 lanes and **55% of lane time idle**.
  `plan-feature` already reads these artifacts before drawing the next set of
  dependency lines; until now neither depth nor width was in them. A
  `blocking_cause_unrecorded` gap ships alongside, because the chain is what the
  *graph* forced and a phase can also wait on a busy lane or an unanswered
  question — which the journal cannot currently tell apart.

- **`--retry-after <15m>`: an unanswered failure question eventually answers
  itself.** An observed fourteen-hour run spent 4h07m — 29% of its wall clock —
  parked on "This phase failed. Try it again?" with nobody at the keyboard; the
  answer, when it came, was `retry`, and it worked. Unset by default, so a run
  behaves exactly as it did. Accepts minutes bare or a unit (`15`, `15m`, `90s`,
  `2h`) on both `run` and `serve`. It is deliberately unbounded and fires again
  on each new question: a version capped by `--retries` would stall at the cap
  and idle for the rest of the night, which is the failure it exists for. Every
  firing is a full phase attempt, so the interval is the throttle. It reaches
  the failure question and nothing else — a plan's own `await_human` gate asked
  for a person, and both park through the same code, so answering those would be
  the orchestrator overruling the plan. An unattended answer is journalled with
  `unattended: true`, because "a human said try again" and "nobody was here" are
  the same answer with very different meanings.

- **The daemon now has a log of its own, and a Logs view to read it in.**
  Transcripts said what the agents did; nothing said what the *daemon* did, so
  "the run stopped and I don't know why" had no evidence behind it at all.
  `.vinta-ai-maestro/logs/daemon.ndjson` now records what the process bound,
  every HTTP request and socket upgrade it refused and why, every start request
  that produced no run, every scheduler dispatch and node transition, and every
  deadlock — on one clock, so a node failure can be read beside the refusal
  thirty seconds before it. `GET /api/logs` serves it as a tail or a follow,
  with filters for level, run, node and a substring of any event or field; the
  UI's new **Logs** section follows the tail until you scroll up. The file
  rotates at 8 MiB and keeps five rotations, so it is bounded whatever the
  daemon's uptime, and `purge` leaves it alone for the same reason it leaves
  `flow.db` alone — it holds no repository contents, and it is the record of the
  failure somebody is about to ask about.

- **A crash is no longer silent.** An exception escaping a node's own handling
  used to become an unhandled rejection on a promise the scheduler does not
  hold, and an unhandled rejection ends the process: hours of agent turns and a
  real amount of money, gone with no journal row, no transcript entry and
  nothing on disk saying why — because the thing that would have said it was the
  thing that died. Three changes. A node that throws is now **contained** by the
  rule §6 already states for failures: it fails, its transitive dependents
  block, and everything independent of it keeps going. A crash that is still
  fatal is **recorded first** — `daemon.uncaught_exception` /
  `daemon.unhandled_rejection`, with the error's kind, its stack frames and the
  ids of every run in flight. And the in-flight runs are **journalled as ended**
  before the process goes, so `run --resume <run-id>` picks them up instead of
  finding a row that says `running` for ever. `serve` and `run` both take
  `--log-level`, `--log-stderr` and `--log-detail`.

- **The log is identifiers only, enforced rather than asked for — plus the one
  field that is deliberately prose.** A log is called from anywhere, and "please
  do not log repository contents" is a hope rather than a control. So a field
  may only hold a string, a number, a boolean or null — an object is dropped,
  never stringified, which is the way a diff or a file read becomes a log line —
  identifier values are capped at 200 characters, field names that are secrets
  by their name are redacted, and the daemon's token is registered at boot so
  any value containing it is written `<redacted>`.

  The exception is an error's **`message`**, which every failure record carries
  beside its kind, capped at 2000 characters and redacted like anything else. It
  is the default because `.vinta-ai-maestro/runs/` already holds every agent
  transcript and gate log *verbatim*, in the same gitignored store and under the
  same `purge` — an error message is a rounding error against a directory that
  is already a copy of the repository, and excluding it cost the one string that
  most often explains a failure. `--log-detail kind` narrows to the kind and the
  stack frames for a checkout under a stricter obligation than this store's own.
- **A run that is dragging can now tune itself, within bounds somebody wrote
  down.** A run can be mis-*configured* rather than broken — every phase doing
  what it was asked, every gate reporting honestly, and the whole thing paying
  for a test database it rebuilds on every gate run in every lane. Nobody needs
  waking for that, and the post-mortem found it out an afternoon too late to
  help. Now a watchdog wakes the run's monitor when a phase passes an hour or a
  gate's uncached cost passes thirty minutes, the monitor reads the gate logs
  and the durations, and it answers with a **proposal** that the daemon
  validates and applies through the existing amend path. `--no-intervene` turns
  it off.

  It proposes; it never writes. Its authority is four verbs — a gate's command,
  a gate's timeout, a phase's fix budget, a phase's model — and the line they
  draw is that it may change **how** the run executes and never **what** it
  builds. There is no way to express a change to a dependency, a phase brief, a
  touch list, the base branch, or the set of phases: not refused at runtime,
  unrepresentable.

  The one field that can do real damage is a gate's command, because
  `--reuse-db` and `-k not_slow` are the same edit to the same string, and a
  gate narrowed wrongly goes green and looks like success in every log there
  is. So a command may only be changed when the gate itself declares
  `tuning.allowed_flags` — a list a person wrote in the committed plan, under
  review, before the run started — and the proposed command must be the current
  one's argv tokens, in order, plus additions from that list. A gate that
  declares no `tuning` block is not tunable, which is the default.

  A run gets three of these in its life, at most one per gate and per phase.
  What it changed is journalled as identifiers; why it changed it is the
  monitor's prose and goes in `runs/<run-id>/interventions.jsonl` beside the
  run, including every attempt that was refused — an agent trying to do
  something it may not do, with nobody in the room, is the record most worth
  keeping. See `packages/vinta-ai-maestro/docs/monitor-intervention.md`.

- **`plan-feature` is told what the newer post-mortem findings mean.** The
  skill documents each finding and what to *do* about it, and three had been
  added to the artifact without reaching it: `gate_costs`, `critical_path` and
  `idle_capacity`. A finding a planning agent cannot interpret is a finding
  that changes no plan, which is the whole return on emitting it — and the
  three are among the most actionable there are. `gate_costs` sizes the gate
  pool capacities a plan declares, and separates a slow suite from a fix loop
  re-paying for the same one. `critical_path` is the chain to re-draw the graph
  against: shortening a phase that is not on it changes nothing, so a plan that
  parallelises harder without touching that chain buys nothing at all.
  `idle_capacity` says the graph never got as wide as the lanes it asked for,
  which is a fact about the plan rather than about the machine. Each now has a
  row beside the findings that already had one.

- **The post-mortem says what a run changed about itself, and whether it
  helped.** `postmortem.v1` gains an `interventions[]` finding: one entry per
  amendment the run made to itself, with the effect on the thing it changed. A
  gate is scored against its own uncached durations either side of the
  amendment — mean before, mean after, `cheaper` / `dearer` / `unchanged`
  outside a ten-per-cent band. Cached hits are excluded, because a hit reports
  the duration of the run that filled the cache and would drag the mean toward
  whichever side of the boundary that run fell on.

  It is a comparison and not a claim of cause, and the schema says so: a gate
  that got cheaper did so while phases were finishing and caches warming. It is
  worth carrying anyway, because without it an autonomous editor is one nobody
  can tell is making runs worse — and because `plan-feature` now reads it, so a
  project whose `unit` gate wants `--reuse-db` pays to find that out once
  instead of every run.

  A phase-level change (a fix budget, a model) is reported `unmeasured` rather
  than estimated: a phase runs once, so there is no before to compare an after
  against, and the only candidate baseline is a different phase doing different
  work. An operator's amendment is not scored at all — a person deciding
  something is not the run choosing it.

- **`schemas/intervention.v1.schema.json`** — the document the monitor answers
  with, generated from `src/intervention/intervention.ts` the way the workflow
  and post-mortem schemas are generated from theirs. It is the odd one in
  `schemas/`: it validates something a *model* writes rather than a skill or a
  person, and it is the boundary deciding what an unattended run may change
  about itself.

- **A run no longer dies with the terminal that started it.** `vinta-ai-maestro
  serve` accepts `POST /api/runs`, so a run can be submitted to a daemon that
  was already listening and belongs to that daemon rather than to the shell that
  asked for it; the request answers with the run id as soon as the run is
  registered, not when it finishes. Previously `run` was the only way to start a
  run and it hosted its own daemon, so closing the window killed the scheduler
  and every agent under it — and left the journal claiming `running` for ever,
  with nothing able to tell that row apart from a run still in flight.

- **`vinta-ai-maestro run --resume <run-id>` picks an interrupted run back up.**
  Phases already `done` stay done and are not dispatched again, their lane
  worktrees are adopted rather than re-provisioned — so whatever an agent had
  written and not committed is still there — and a phase that was mid-turn when
  the process died runs again from the top of its pipeline, because the turn it
  was in belonged to a process that is gone. The plan comes from the run's
  frozen snapshot, never from the document it was written from, so editing that
  file in the meantime cannot switch plans under a run already under way. A new
  `run_resumed` event records each hand-over; it is deliberately not a second
  `run_started`, which would have moved the run's `started_at` to whenever it
  was last picked up and made every duration short by the length of the outage.

- **`vinta-ai-maestro gate <gate-id>` runs a declared gate from inside an agent
  turn.** A phase used to run its full gate suite five or six times a round —
  implementer, reviewer, fixer, reviewer again, then the authoritative `gate`
  node — and only the last of those consulted the gate cache or the resource
  pool. Agents now ask the daemon for a gate by id: the result is cached on the
  same `(gate id, lane tree hash)` key the `gate` node reads, the gate's
  resources are held by the daemon rather than by whichever agent remembered to
  wrap the command, and the id resolves to the plan's own command so a scoped
  approximation cannot be reported as the gate. Each run is journalled as a
  `gate_result` event and a `gate_run` transcript entry under the GATE band,
  whoever asked for it.

- **A project declares what makes a lane runnable.** `project.env_files` copies
  ignored configuration into each worktree, `project.setup_cmd` runs an
  idempotent setup hook on provisioning and recycle, and the fixed
  `project.commands` vocabulary tells implementers, reviewers and fixers the
  project's real lint, typecheck, test and migration entry points.

- **Compose-backed lanes are isolated past `COMPOSE_PROJECT_NAME`.** The daemon
  now generates an out-of-tree Compose override per lane, strips fixed host
  ports, re-pins fixed and external volumes, and carries the complete lane
  environment into agent and takeover processes as well as gates. Explicitly
  published services receive probed per-lane ports recorded in the teardown
  summary.

- **Shared services get one namespace per lane.** `project.services` models a
  fixed index or lane-derived name inside one Redis, RabbitMQ, object-storage,
  or similar server, with project-owned create/reset commands and capacity
  validation before provisioning creates templates or worktrees.

- **Agents can take the semaphore a workflow declares.**
  `vinta-ai-maestro with <resource> -- <cmd>` waits on the run's existing
  `ResourcePools`, runs the heavy inner-loop command, and releases on exit.
  Renewable leases expire when their client disappears, are visible in the
  live journal, and are surfaced in implementer, reviewer and fixer prompts.

- **A failed phase retries itself, and then asks.** `--on-failure` defaults to
  `retry`: one cold re-attempt (`--retries <n>`, 0–5), and then the node parks
  on a question — retry, retry with another member of the crew, or stop. The
  failures this system produces are overwhelmingly environmental and are gone by
  the second attempt; the ones that survive it are the ones worth a person.
  `ask` skips the automatic attempt. `stop` is the old behaviour and remains the
  right choice for CI, because everything else eventually **waits**.

  A failure that survives its retries says so: the reason carries
  `(after N attempts)`, which no event otherwise records.

- **A failed phase can be retried by hand.** A **Retry phase** button, and
  `POST /api/runs/:runId/nodes/:nodeId/retry`. It returns the node to the ready
  set and unblocks the subtree its failure blocked — a phase that died of
  something environmental holds up work that was never broken. It needs the run
  to still be in flight, which with the new default it usually is; a run that
  has genuinely ended is re-run, not retried, and says so rather than doing
  nothing.

- **The monitor can go and look.** It was given a digest and nothing else, and
  read exactly as thin as that sounds — it could say a phase had failed and
  never say what the phase had written. It is briefed as a technical project
  manager now, with the map: the plan document, each phase's brief, each lane's
  worktree path, each branch and its base, and where the journal and transcripts
  live. It has a shell and its working directory is the repository, so it can
  read the diff before drawing a conclusion. The digest stays as the index —
  bounded, cheap, enough to know which phase is worth a closer look.

- **The monitor conversation is kept.** It lived in component state, so a reload
  threw away every question and every answer — a worse record than the run it
  describes. It is written to the transcript store under a reserved node id and
  read back on load, so it outlives the tab, the daemon and the run.

- **Panels expand.** Anything holding content that is only nominally
  summarisable — an agent's transcript, a gate log, the monitor conversation,
  the steering box — takes the full container width and about a screen of
  height on demand. The height travels as a CSS variable, because the element
  that has to grow is a scroller several components below the panel.

- **A run has a spokesperson you can ask.** `serve` grows a **Monitor** panel on
  the run view: one agent that reads the journal and answers in prose — what is
  blocked, why a phase failed, what it would take to move on. It runs on the
  dearest tier on the crew, because it is read by a person deciding what to do
  about a failing run, and it is asked a handful of times rather than hundreds.

  Three things it deliberately is not.

  **It is not in the permission path.** The obvious thought, once an agent has
  been refused something, is to put a smarter agent in front of the refusals —
  but a phase makes hundreds of tool calls (one node in one real run made 179)
  and a model turn before each is latency and cost spent on questions like "may
  I run ruff", which should never have been questions. Permissions are settled
  structurally, once per spawn, for free.

  **It does not read the transcripts.** Piping every agent's output into a
  second agent would make the monitor the most expensive thing in the run and
  tie its cost to the work rather than to the questions. It reads a bounded
  digest — statuses, failure reasons, pending questions, the last few refusals
  with their sentences, one trimmed last word per phase — so a one-hour run and
  a one-day run cost about the same to ask about.

  **It has no authority.** It can explain a §9.1 pause; it cannot answer one.
  An agent that could quietly approve its colleagues' work would turn a
  checkpoint into a formality, and the checkpoint is the point.

  It answers about **finished runs too**, which is when "why did this fail" is
  usually asked, and it needs no lane: it writes nothing.

- **`serve` reads `--permission`.** The flag has been accepted and ignored since
  it existed. It decides how the monitor is spawned, so it is read now.

- **A plan staffs a team, instead of picking a model per phase.** Choosing a tier
  phase by phase answers "what runs this one" ten times and never adds it up, so the
  two questions that decide what a feature costs go unasked: how many agents does
  this need at once, and is any of them too junior for what it was handed.
  - `plan-feature` opens **Phased Rollout** with a **Crew** table — one row per
    agent, carrying its tier and the phases it takes — and every phase carries an
    **`**Assigned to**:`** line naming one of them. It replaces
    `**Suggested AI model**:`; a plan that still has the old line keeps working, and
    the executor reads the tier straight off it.
  - The **Execution graph** table gains an **Agent** column and an **Idle** note.
    Reading across a row says who is working that wave; reading down a column says
    who is not. A wave that will serialize because the roster cannot staff it is now
    stated in the plan rather than discovered as a slow run.
  - **Every member has to earn their place**, by concurrency (a wave genuinely needs
    that many hands *at or above* those phases' tiers) or by cheapness (they take
    work a dearer member would otherwise do). The roster is therefore **not** capped
    at the widest wave — a junior who runs the migration and the flag deletion is
    worth having in a graph that never runs two phases at once — but the lane pool
    still is, because lanes are bought with concurrency and crew are not.
  - **Reviewers are a role on the crew, and implementers and reviewers are
    disjoint.** A member has `role: implementer` or `role: reviewer`; a phase cannot
    be assigned to a reviewer and a reviewer never writes code, so an agent reading
    its own diff is not something a plan can express. A phase is read by the
    cheapest reviewer at or above its tier. A roster with no reviewer still runs and
    falls back to `agent_models.reviewer`, cold, one session per phase.
    - **A reviewer reads the lane it is reviewing**, with the phase's changes still
      uncommitted in it, and has no worktree of its own. That is what puts review
      before the commit: a finding is fixed in the working tree rather than
      recorded as a mistake on the branch plus a correction after it. The cost is
      that a reviewer's directory follows the work, so its session carries only
      between reviews that land in the same lane.
  - **A crew member is an agent that lives for the whole run.** Each one keeps its
    own worktree and its own session across every phase it takes, so the agent that
    takes Phase 4 still knows what it learned about the codebase in Phase 1 —
    which is most of what a cold agent's first turn of a phase is spent
    rediscovering.
    - This works because the *directory* stops moving. Lanes used to be anonymous
      slots handed out by a free list, so a member landed somewhere different each
      phase and its context described paths it was not standing in. Pinning each
      member to one worktree leaves a far smaller question — which files changed —
      and `git diff --name-only` answers it exactly.
    - A cross-phase continuation therefore gets the new phase's **full brief** (it
      is new work, not a delta) behind a re-orientation: same agent, same directory,
      everything you learned still holds; the tree is on a different branch; these
      files differ; and — the sentence that matters most — whether the previous
      phase's own work is in this tree at all.
    - A delta that cannot be computed is reported as **unknown**, never as empty.
      "Nothing changed" is the one wording that would stop an agent re-reading.
    - Two things still start cold: a member whose previous phase **failed**, because
      its session is the context that failed with it, and the final fix round.
    - The cost, stated plainly: **one worktree and one set of forked databases per
      implementer**, so `resources.lane.capacity` is now the implementer count
      rather than the widest wave, and adding a cheaper implementer is a trade of
      disk against money rather than free.
  - The workflow document gained a top-level **`crew`** block and **`nodes[].crew`**.
    A staffed node carries no `model` — the member has one — and a document that is
    half-staffed, names a member nobody declared, assigns a phase to a reviewer,
    declares an implementer nobody is assigned to, or staffs a reviewer below every
    phase on the plan is refused before the run starts.
  - `vinta-ai-maestro` claims an agent **before** the lane, prefers the member the plan
    named, covers with the **cheapest** qualified free peer when they are busy, and
    **waits rather than handing a phase below its tier** — even with a lane free. A
    lane is disk; a phase run by too junior an agent does not fail cleanly, it fails
    review two rounds later with nothing pointing back at the staffing. A reviewer is
    claimed per review turn rather than per phase — it has one session ledger and
    two concurrent reviews would collide over it — so one reviewer on a three-lane
    plan is a queue at the review step and not a serialised run.
    - **"Cheapest qualified" has one exception, and it is about sessions.** A
      member who already holds a session this phase would genuinely resume takes
      it ahead of a cheaper member who would have to start cold — even when they
      are more senior than the phase needs, and even when the member the plan
      named is free. What it buys is the context a cold session spends its first
      turn rebuilding; what it costs is the dearer model for that phase, which is
      the smaller of the two bills. **The tier floor is untouched**: warmth
      reorders the members who already qualify and never widens them, so a warm
      junior still cannot take a Tier 3 phase.
    - **Only when a session is genuinely already up.** "Warm" means the scheduler
      asked its own session-reuse rules and got a yes — same pinned lane, same
      harness, under the turn ceiling, not poisoned by a failed phase. A member
      who has merely run before is not warm, because a promotion bought on a
      resume that is then refused pays the senior's rate *and* cold-starts
      anyway. With nobody warm, staffing is exactly what it was: a session is
      being opened either way, and the plan's own level wins.
    - An operator who picks the member by hand on a retry gets that member. A
      saving nobody asked for does not overrule an explicit answer.
  - The run view reports who actually worked against who the plan said would.
    `substituted` is the figure to read beside a cost that overran: every
    substitution ran at or above the budgeted tier, so a run can be entirely green
    and still have been staffed dearer than planned. The phases promoted to reuse
    a warm session are counted **within** that figure and reported apart from it —
    a peer covering for a busy member costs what the plan budgeted, while a warm
    promotion is the scheduler deliberately trading model rate against cold
    starts, and folded together a run that promoted everything to the top tier
    would read as an ordinary busy wave.

- **`implement-plan` runs independent phases in parallel.** The plan now carries a
  dependency graph and the conductor schedules against it: a phase starts as soon as
  every phase it depends on is green and a worktree lane is free, instead of waiting
  for its turn in plan order. A chain-shaped plan behaves exactly as before —
  sequential execution is the one-lane case of the same scheduler.
  - `plan-feature` gives every phase a **`**Depends on**:`** line naming the artifact
    it needs from each upstream phase, and opens **Phased Rollout** with an
    **Execution graph** table derived from those lines. It also checks same-wave
    phases against the **Touch List** for file overlap and tells you to add an edge
    when two phases would fight over the same file.
  - New shared partial `plan-execution/partials/parallel-lanes.md` carries the graph
    parse, the worktree lane pool, the dependency-derived branch topology, the
    dispatch loop, the tracking-directory schema, and the sibling-lane write guard.
  - `prepare-worktree` documents provisioning a **pool** of lanes for one plan and
    records a `reset_cmd` per forked DB so a lane can be reused across phases without
    carrying the previous phase's migrations into the next one's test run.
  - Two new config fields: `run_options.implement-plan.parallel_phases` (default
    `true`) and `run_options.implement-plan.max_parallel_lanes` (default `3`), asked
    at bootstrap alongside the existing `prepare-worktree` follow-ups.

- **`plan-feature` emits an executable `ai-plans/<feature-kebab>.workflow.json`
  beside every plan.** The markdown stays the document humans review; the JSON is
  the same phase graph in the form an orchestrator runs — one node per phase, one
  `depends_on` entry per `**Depends on**:` clause carrying both the upstream phase
  and the artifact it provides, plus the phase's Touch List, gates, capacity pools
  and model tier. Validated by
  [`schemas/workflow.v1.schema.json`](schemas/workflow.v1.schema.json), which the
  emitted file references from its `$schema` key so editors validate it as it is
  written. **Unconditional** — no config field, no bootstrap question, no opt-in:
  a project with no orchestrator carries a file nothing reads, and a project that
  adopts one later finds its plans already executable.

- **Review findings go back to the phase's own implementer, not to a fresh fixer.**
  The agent that wrote the code still holds the phase brief, the plan's bounds, the
  dependency context and its own reasoning; a fresh fixer held a quoted finding and
  had to rediscover the rest — slower, dearer, and likelier to "fix" a symptom by
  undoing something the phase chose deliberately. The fix message is now a delta —
  the findings, nothing else — because re-sending the brief invites a
  re-implementation rather than a fix.

  Three rules keep that from costing what it buys. **The reviewer is never the
  implementer**: continuing the reviewer across rounds is fine, but the review must
  come from an agent that did not write the code. **The last round before giving up
  goes to a fresh fixer, always** — reuse means the agent that wrote the bug is
  fixing it, which is usually the point and occasionally exactly wrong, because that
  assumption *was* the bug. And where a runtime cannot continue a finished
  sub-agent, the old cold hand-off still happens and is recorded as one, so a slow
  phase can be read later without guessing.

  One consequence worth knowing: a continued implementer fixes at its own crew
  member's tier, so `agent_models.fixer` now governs only the cold cases. A project
  that set `fixer` cheap to save money is saving it on fewer rounds.

- **The workflow schema gained `defaults.max_session_turns`.** Optional, default
  12. An orchestrator that reuses one agent session across a phase's implement
  and fix turns needs a ceiling on how long that session may grow before the next
  turn starts cold; without one a long phase eventually dies on a context-window
  error that reads as a broken harness. `plan-feature` omits the field — it is a
  safety limit, not something a plan tunes — and its field table says so.

- **`plan-feature` asks about the project's databases and emits the workflow's
  `project` block.** The block records what a phase lane must **fork** to be a
  working checkout — the `dev` and `test` databases, and the project's own
  migrate command, which runs once per template database rather than once per
  lane. Without it every lane got a git worktree and nothing else, so two phases
  running concurrently pointed their test gate at the same rows. Asked at
  emission time with one `AskUserQuestion` call ("what does a phase lane need its
  own copy of", "how is that database delivered"); the rest — the migrate
  command, the database names, the env var names — is read out of the project's
  settings and task runner rather than asked.

  Two rules the skill is explicit about, because both are easy to get wrong:
  **sharing is the absence of a declaration** (there is no `share` value, and a
  lane that reads the main checkout's database has nothing to describe), and
  **each role names its own database** (a lane's fork is named from `name` and
  the lane, not the role, so `dev` and `test` sharing one `name` collapse to one
  forked database). Everything `prepare-worktree` discovers per worktree —
  `reset_cmd`, compose project names, volume forks, seed commands, env-file
  strategy — stays out of the block by design.

- **New schema
  [`postmortem.v1.schema.json`](schemas/postmortem.v1.schema.json)** — the
  structured plan post-mortem an orchestrator writes at
  `.vinta-ai-maestro/runs/<run-id>/postmortem.json` once a run has ended: dependencies
  that were declared but never used, dependencies discovered at gate time,
  same-wave phases that actually conflicted, and phases whose real duration
  diverged from their wave placement. `plan-feature` reads it before drawing the
  next feature's Execution graph, which is what stops a plan from repeating a
  defect the last run already paid for. Like
  [`workflow.v1.schema.json`](schemas/workflow.v1.schema.json) it is
  **generated** from a zod source rather than hand-written — see
  [`schemas/README.md`](schemas/README.md).

- **The monitor keeps thinking when you look away, and thinks out loud.**
  Asking used to be one long HTTP request that produced the whole answer inside
  it, which made the turn's lifetime the browser's connection: switching view,
  reloading or letting a laptop sleep killed the monitor mid-thought and left a
  question with no answer and no record that one had been attempted. The daemon
  owns the turn now — `POST` answers `202`, and the monitor journals each
  thought and each sentence as it produces them, so the conversation is
  readable while it is being written and by any tab that opens it. The panel
  renders through the same rows a phase's transcript uses, which is what the
  API always claimed and the UI never did.

- **A phase's transcript says which agent wrote each line, and holds the gates.**
  Every spawn on a node appends to one file whatever its role, so a phase that
  took two fix rounds held five agents' output in one undifferentiated stream —
  the role was in scope at the append and simply not written down. Each line now
  carries the role and the session slot that produced it, the view bands the
  list where one agent stops and the next starts, and gate runs are entries in
  it rather than only in a log beside it. The operator's own steering stays the
  operator's (§7), even though the adapter echoes it back on the agent's event
  stream. Transcripts written before this render exactly as they did, with no
  bands. The band stays pinned to the top of the scroller while its own run of
  rows goes past, so the agent you are reading is named without scrolling back
  to where it started — in the phase transcript and in the monitor conversation
  alike.

### Changed

- **Updated the OpenAI and Anthropic models to their latest version.**

- **Updated the generated skills to have `disable-model-invocation: true` set.**

- **`--retry-after` backs off when attempts fail faster than it.** An
  unanswered failure question used to answer itself on a flat interval
  forever, so a phase whose attempts died within seconds was retried every
  fifteen minutes for hours, against the same failure, at the price of a cold
  lane each time. Each attempt that fails in less time than the interval now
  doubles the next wait, up to 8× (15m becomes 2h); one attempt that runs at
  least the interval long puts it back. It still never stops on its own: a
  run whose cause goes away overnight is moving again before morning. The
  `node.unattended_retry` log line reports the actual wait and the streak.

- **Notifications have an inbox, and are heard from every view.** The UI's
  notifications used to be a row of banners in the top bar, shown only when
  browser notifications were refused. They piled up there and could be read
  only one at a time, by dismissing whichever was in front. Every notification
  now lands in an inbox behind a bell with an unread count: newest first,
  filterable by unread and by still-waiting pauses, marked read one at a time
  or all at once, dismissed singly or cleared. A pause that gets answered stays
  listed and says *Answered*. The inbox is kept in `localStorage` and shared by
  every tab, so a reload no longer loses it. It stores what a notification
  body already carries — a run id, a node id, a reason and the journal's
  timestamp — and no question text, output or diff. Browser notifications also
  reach the operator more often now. They used to fire only for the run open
  on screen; the UI now follows every running run in the background, and a run
  view takes over that run's stream instead of opening a second one. They also
  depended on a permission prompt raised by the first pause, which Firefox and
  Safari ignore when no click raised it, so on those browsers they could never
  turn on. An *Enable notifications* button now sits in the top bar until the
  browser has been asked (and in the inbox too), and confirms with one test
  notification. It also says why the channel is off
  when it is: blocked in the browser's site settings, or served over plain
  HTTP on a remote `--host`, which browsers do not allow notifications from.
  The reminder interval moved into the inbox.

- **The run view's Nodes table names a lane by what distinguishes it.**
  Every lane in a run is named `${runId}-...`, so the column spelled them in
  full as `2026-09-11-graphql-aggregations-mubou9ar-crew-3-tier4` on every
  row, phase after phase — the same forty characters of prefix repeated down
  the table, wide enough to push the whole table into a horizontal scroll for
  the sake of a string that was identical everywhere it appeared. The cell now
  shows the tail that actually differs (`crew-3-tier4`, `lane-2`, `integ`) and
  keeps the full name in its `title`, because that is what the worktree
  directory and the branch are called. The phase description beside the node
  id is bounded and wraps for the same reason — table cells are
  `whitespace-nowrap`, so one long phase name was setting the width of the
  whole table.

- **A dispatched phase agent does the work itself, instead of spawning an
  implementer under it.** claude-code sessions run by the orchestrator were
  handing their phase to a sub-agent and reporting its summary back, and the
  pull was not laziness — `implement-phase` ships into the same repositories,
  its description matches "you are implementing P3 of plan X", and its content
  is "spawn exactly one implementer subagent". So a session was loading a
  conductor skill on its own and correctly following it, one level below the
  conductor that had already spawned it. The cost is the whole point of session
  reuse: a sub-agent's reading of the codebase ends with the sub-agent, so the
  warm session that every cross-phase turn greets with "everything you learned
  still holds" was left holding a paragraph, and each phase paid a cold agent's
  first turn again. Both halves are now closed. Every `vinta-ai-maestro` role
  prompt (implementer, reviewer, fixer, chore — cold and continued) carries a
  no-delegation section that names those skills and says what delegating costs,
  and the plan-execution unit grows a `dispatched-agent` partial: a guard at the
  top of all four conductors refusing entry to an agent that was itself handed
  one phase, plus the same rule inside every composed implementer prompt.

- **The node view's gate panel is a list of verdicts you can open, not a stack
  of scrolling boxes.** Every gate used to render its whole log at once, each
  in its own fixed-height box with its own scrollbar — so three gates in a
  third of a grid row was a column of letterbox slots, and a wheel gesture
  over one of them was swallowed by that box instead of scrolling the page.
  Gates are now an accordion: one row per gate, only one open at a time, and
  the open log has no scroller of its own (it is tail-truncated at 64 KiB
  already, and long lines wrap the way the diff panel's do). The panel opens
  on the gate a human question points at, or on the first that is not passing.

- **Each gate row says what happened and what it cost.** The verdict —
  `running`, `passed`, `failed`, `timed out` — is on the wire now, so a phase
  whose lint gate passed and whose unit gate failed reads as that instead of
  as two identical rows; previously the UI could only name the single gate
  §9.1's question happened to point at, because `NodeDetail` carried an id and
  a log and nothing else. A running gate shows a clock counting from the
  daemon's own start time, so a tab opened halfway through a slow suite shows
  the true elapsed figure rather than starting from zero; a finished one shows
  the runner's measurement of its latest attempt, with `cached` where the
  cache served the verdict and a `×N` count where the gate has run more than
  once.

- **Crew members are named after their tier, not after a seniority.** A roster
  reads `tier1`, `tier2-1`, `tier2-2`, `tier4` and `reviewer` where it used to
  read `junior`, `mid-1`, `mid-2` and `senior`. Nothing about the data model
  moved — `tier` was already the 1-4 number the orchestrator staffs on, and it
  is still the only thing compared when one member covers for another. What
  changed is that the label beside it now says the same thing, instead of
  offering a second vocabulary that could drift from it and that reads as a
  ranking of people rather than of difficulty. Workflows using the old ids keep
  running: the ids are free-form and nothing resolves them by name.

- **`plan-feature` emits its workflow with the plan's date prefix.** The
  executable sibling is now
  `ai-plans/YYYY-MM-DD-<feature-kebab>.workflow.json` — previously it carried
  no date, which sorted it away from the `YYYY-MM-DD-FEATURE_NAME_PLAN.md` and
  `_SPEC.md` it belongs to, so the one file you want with the plan open was the
  one you had to go looking for. A feature's three files now land adjacent. The
  case difference between them is not an oversight: the markdown convention is
  `UPPERCASE_WITH_UNDERSCORES` and a workflow's filename stem *is* its `id`,
  which the schema requires to be lowercase kebab-case, so the date prefix is
  the only part the three can share. Existing dateless workflows are unaffected
  — this is the emitter's convention, not a schema rule.
- **A gate's command can be retuned while the phase that runs it is still
  running.** §9's amend refused any change reaching a node in flight, which is
  exactly the node anyone is looking at when a run is dragging: a `unit` gate
  missing `--reuse-db` could not be fixed until the run it was costing hours
  had finished. The refusal now reads a narrower set. A node's harness, model,
  pipeline, body and base are each read at a moment that has already passed, so
  changing them is refused as before; a gate's *command* is resolved per gate
  run by every reader of it, so a running phase simply runs the new command at
  its next gate. Nothing downstream is blocked either, because a command moves
  no branch's base. Changing **which** gates a node declares is still refused
  mid-flight — a phase that gained a gate would finish without ever running it —
  so that now counts as part of the phase body.

- **A gate result is cached against the command that produced it.** The key was
  `(gate id, tree hash)`, on the assumption that a gate id names a command.
  Amending a live run makes that false, and an unchanged tree would have been
  served the old command's verdict. The command is now part of the key, hashed
  rather than stored — a command line is repository content. A cache database
  written before this is dropped when it is opened: its rows cannot say which
  command produced them, and one re-run per stale entry is the price a lost row
  already costs.

- **A session cannot inherit a machine's decision to stop compacting.** All
  three harnesses compact automatically when their context fills — there was
  never a flag to turn on — but each honours an environment variable that turns
  it off, and an agent spawned on a machine carrying one would run a long phase
  straight into a wall it was supposed to be able to survive. Those variables
  are now stripped from every child the daemon spawns, and claude-code's own
  setting is reasserted in the per-lane file beside its permission rules. The
  window itself is left alone: an operator who narrowed theirs compacts earlier,
  which is not the failure this guards against. A harness that compacts declares
  it, and a compaction the harness reports is a transcript row like any other.

  One consequence worth knowing: `max_session_turns` used to be a proxy for "this
  session is nearing a context window it will die on". That death no longer
  happens, so the ceiling now guards a different thing — a session whose memory
  was replaced by a summary of itself, and which answers just as confidently.

- **Agent prompts name gates by id rather than printing their commands.** The
  implementer's step 4 was descriptive — "Outer gate… These run against your
  lane:" followed by the gate commands — and implementers were observed reading
  it as a note about what would run later, finishing the scoped inner loop and
  never running a gate at all. It is imperative now, and every role that runs a
  gate (implementer, reviewer, fixer, and the continuation of each) is pointed
  at `vinta-ai-maestro gate <id>`. The fixer prompts no longer say to re-run the
  gates "until they are green", which contradicted the commit protocol directly
  below them and left fixers running out the turn with the work uncommitted;
  they now say to commit and report FAILURE when a gate cannot be turned green.
  Implementers and fixers report which gates they ran and what each returned —
  a record for the reviewer to check against, explicitly not a licence for the
  reviewer to skip running them itself.

- **Phase branches base on their dependencies, not on the previous phase.** A phase
  with no dependencies cuts from the default branch; one with a single dependency
  cuts from that phase's branch; one with several cuts from a
  `plan/{plan-id}/integ-{phase-id}` branch that merges them. Each wave is then merged
  into a `plan/{plan-id}/wave-{N}` integration branch, which is what a resume anchors
  on and what the final report points at. The PR `base` follows the same value —
  a stacked plan produces exactly the stack it did before.
- **Tracking is a directory, not a file.** `{{PLAN_DIR}}/TRACKING_{plan-id}/` holds
  `run.md` (conductor-owned), one `phase-{id}.md` per phase (written only by the lane
  that ran it, committed on that phase's own branch), and `waves/wave-{N}.md`. No two
  branches write the same path, so wave merges no longer conflict on tracking. A run
  started under the old single-file layout is migrated on resume.
- **An implementer is told about its dependencies only.** Prior-phase context passed
  into a phase prompt is now that phase's transitive dependency closure rather than
  "everything finished so far" — a sibling lane's work is not in the phase's base
  branch, and describing it as done made the implementer code against files it could
  not see.
- **The stray-write guard covers sibling lanes.** The sandbox denies the whole
  worktree pool root and allows back only the running lane; the review-phase backstop
  checks the main checkout and every sibling workroot after each implementer and
  fixer. A write into a lane that is mid-implementation is worse than a stray
  main-checkout write.
- **`amend-plan` cascades along the dependency graph.** A rewrite touches the
  amended phase's dependent closure instead of "every phase with a higher number",
  rebases in topological order, rebuilds `integ-` bases before rebasing a
  multi-dependency phase onto them, and refuses to run while any phase is still in
  flight. It gained a `dependency-change` amendment kind for edits to a
  `**Depends on**:` line.
- **`implement-plan` refuses rather than degrading** when parallel execution is asked
  for but worktrees are unavailable — several agents cannot share one working tree,
  and silently falling back to sequential would discard the schedule the user
  approved.
- **`modular-commits` supports parallel runs**: lanes commit their atomic units on
  `plan/{plan-id}/lane-{phase-id}` branches, merged `--no-ff` into the single plan
  branch at each wave boundary, so the unit commits survive.

- **`project.prepare_cmd`, for the shared servers a run depends on.** A project
  whose databases are `delivery: external` and whose services point at one Redis
  has no long-lived containers of its own — the shape these fields recommend —
  and that makes some *other* stack a hard dependency of every run. Nothing in
  the package could bring it up. `setup_cmd` looks like the place and is not: it
  runs per lane, long after the template database was created on a server that
  had to be up for `createdb` to work at all.

  It runs in the repository root **before anything else a run does** — before
  the preflight, before the templates, before the first worktree — and again
  before every lane recycle, so a server that dies mid-run is restored at the
  next hand-off rather than failing every phase after it. Failure aborts with
  the exit code and a bounded stderr tail, and says what the failure means
  rather than only that a command exited. It must be idempotent, and `--wait`
  is only as good as the `healthcheck` a service declares: without one, compose
  returns as soon as the container starts and `createdb` races the server.

- **A merge conflict goes to the most senior member who wrote one of its
  sides.** The conflict fixer was staffed from `defaults` and ignored the roster
  entirely, so on a tiered crew a collision between two Tier 4 phases was handed
  to a default-tier agent that had read neither of them — the hardest merge in
  the run going to the least contextualised agent available, and resolved by
  guessing which side looked more finished.

  `Integrator` already knows which nodes own the contested paths, and `node_crew`
  already records who took each one; this is the join. Highest tier among them
  wins, on that member's own `model` and `harness`, and a tier tie breaks on
  member id the way roster substitution breaks its own. An unstaffed workflow
  still resolves through `defaults`, unchanged, and so does a conflict whose
  nodes cannot be resolved to a member.

  What is carried is the member's **capability, not their session**. A phase's
  session ran in that phase's lane; the fixer runs in the integration worktree,
  where the files in dispute are half-merged and unlike anything that session
  saw — resuming there would give the agent confident, false memories of exactly
  the files it is merging. The prompt tells the fixer which side is its own, and
  in the same breath that it is a fresh session and must read rather than
  recall.

### Fixed

- **A failed Claude Code turn no longer reads as `claude-code result:
  success`.** When the CLI ends a turn with `is_error: true` beside
  `subtype: "success"` (how a plan limit arrives, for one), the recorded
  error printed the subtype and said "success" — 189 times in one observed
  run. It now reads `claude-code result: is_error`. Other subtypes
  (`error_max_turns`, …) are unchanged.

- **The monitor's conversation was mostly unformatted JSON.** Not its answers —
  its *watchdog's*. An intervention turn must reply with one document matching
  `intervention.v1.schema.json`, which is what makes the monitor's authority
  over a live run a closed set of verbs rather than an editor over
  `workflow.json`; and that turn is journalled into the conversation a person
  reads, because a run that retuned itself should say so where somebody is
  already looking. Both of those are right. Rendering the document verbatim was
  not, and the summary paragraph the operator wanted arrived a thousand
  characters into one unwrapped line of braces. A proposal now renders as what
  it says: the summary, then one line per proposed change with its evidence
  under it, and a tone dot only when something was actually proposed — a turn
  that looked and changed nothing is the expected outcome and should not shout.
  The verb table is keyed on the daemon's own union, so a fifth verb fails the
  UI build rather than shipping as a bare identifier. The journal still holds
  the bytes the model wrote — only the row changed, so conversations already on
  disk read as well as new ones. Any other whole-JSON answer is at least
  indented.

- **The monitor's conversation opened at its oldest entry and never scrolled.**
  It followed the newest row *only while a turn was running*, on the reasoning
  that the list is short and the operator is watching the answer they just
  asked for. Neither half held: the conversation is the journal's, so it holds
  every question ever asked about the run plus every proposal the run's own
  watchdog made with nobody asking anything — a hundred entries is ordinary.
  Opening the panel therefore put the reader at the oldest of them. It now
  follows the way a phase's transcript does: stuck to the newest row, letting
  go the moment the reader scrolls up to read, with a "Jump to latest" as the
  way back. That rule is one module now rather than a well-tested copy in the
  transcript and none in the monitor, which is how the panel came to be missing
  three of its parts — including the one that survives a panel being expanded
  to full page, where the portal hands the view a brand new list scrolled to
  the top.

- **Hitting the plan's session or weekly limit failed the node instead of
  waiting for the window to end.** `claude-code`'s refusal table recognised
  "usage limit reached" and nothing else, and the classifier's default is
  `fatal` — correctly, since an unrecognised failure must not become an
  unbounded wait. But the CLI announces a plan window in its own words:
  "You've hit your session limit", "Session limit reached · resets 3am",
  "5-hour limit reached", "You've reached your weekly limit". None of those
  contain "usage limit", so every one of them fell past the table to `fatal`,
  which fails the node and blocks its whole dependent subtree — for a window
  that ends by itself in a few hours. The machinery to do the right thing was
  already there and simply never reached: a `quota` refusal parks the harness,
  not the node, so every later node joins one wait instead of discovering the
  limit for itself; the wake time is journalled and survives a daemon restart;
  and the AIMD ceiling is left alone, because a plan window says nothing about
  how many agents may run at once. Those wordings are now `quota`. The new row
  sits *below* `concurrency` and `rate_limit` so that "concurrent session limit
  reached" keeps the kind that halves the ceiling, and "approaching session
  limit" — a warning from a harness that is still working — matches nothing.

- **A window that closed *under* a running turn was an ordinary turn failure.**
  §6.1 is written about a spawn, because that is where a vendor usually says
  "not right now" — and everything that follows from it, parking the harness so
  every later node joins one wait, journalling the wake time so a daemon
  restart does not forget it, leaving the AIMD ceiling alone for a window that
  says nothing about concurrency, hung off `admit`. So the other arrival of the
  same fact had none of it: a plan window that closes while an agent is twenty
  minutes into a phase ends the turn, and the node then burnt its retries
  against a closed window and failed, blocking its whole dependent subtree —
  the exact outcome §6.1 exists to prevent, reached by the one path that did not
  go through admission control. A session now reports a `TurnRefusal`, and the
  caller answers it with the `CapacityRetry` a refused spawn raises: the lane
  goes back, the harness parks until the stated reset, and the node re-drives
  when the window opens.

  Each adapter reads it where its own failure prose is, which is not where its
  events are: `claude-code`'s terminal `result` frame carries the sentence in
  the `result` string that `mapResult` deliberately drops (it is agent output,
  §11), `codex` states a failure as prose on three different frames, and
  `opencode`'s `session.error` carries it under `data`, which `#errorName`
  refuses to put in an event. All three read that prose, match it against the
  table they already had, and drop it — what reaches the caller is a kind, a
  fixed reason token and a reset time, and what reaches the transcript is one
  token-only line so the record says why the turn stopped. The stderr-and-exit
  shape of the same event is read too, from the diagnostics buffer that is the
  only place that sentence exists.

  The re-drive is a full one, and that is deliberate: the session the turn was
  using is gone, and resuming from a memory of files a recycle has removed is
  worse than redoing the work. Nothing is destroyed by it — `recycle` sets
  aside whatever the turn left uncommitted as a WIP ref first. What it costs is
  the turn. What it used to cost was the node.

- **A stated reset time was only read when it was an hour on the same day.**
  `parseRetryAfter` prefers a reset the vendor reported over a guessed backoff,
  and its wall-clock pattern wanted `am`/`pm` immediately after "reset", so
  "resets at 15:00", "resets tomorrow at 2am" and the weekly window's "resets
  on Monday at 12am" all reported nothing — falling back to the five-minute
  re-probe interval, which across a week-long window is two thousand spawns to
  discover what the first sentence said. It now reads 24-hour times, `today`,
  `tomorrow` and a named weekday (the next occurrence of it, which is today
  only while the hour is still ahead). A reset named by date, "resets Nov 3 at
  9am", still reports nothing on purpose: a month with no year is a guess, and
  the re-probe is a better answer than a wait that is wrong by a year. So are
  "reset 3", "resets at 25:00" and "resets at 13pm" — an hour with neither
  minutes nor a meridiem is as likely to be a version or a retry count, and
  everything this function returns becomes a wait.

- **`run --resume` could not provision a pool at all on a project that
  disables hooks.** `#configureHooks` enables `extensions.worktreeConfig`
  before it can set `core.hooksPath --worktree`, and that first key is
  repository-wide: the write lands in the shared `.git/config`, which git takes
  `.git/config.lock` to edit. Called once per lane out of the provisioning
  `Promise.all`, the lanes collided on that lock — `could not lock config file
  …: File exists`. A fresh provision never showed it, because `worktree add`
  goes through the pool's serialized git turn and staggered the lanes apart by
  the time they reached the shared write; `adopt` skips `worktree add`, so every
  lane arrived in the same tick and **every** resume of a `hooks: false` project
  failed, reproducibly, before a single phase was scheduled. The extension now
  goes through the same serialized turn. The `--worktree` write stays parallel:
  it lands in `.git/worktrees/<name>/config.worktree`, one file per lane.

- **A provision failure that was not one of three enumerated kinds said nothing
  about itself.** `refusal` detailed `DiskProbeError`, `LaneSetupError` and
  `LaneEnvFileError`; everything else — including the lock collision above and
  `LaneAdoptError`, the one error a resume is most likely to hit — collapsed to
  "could not provision the lane pool under …", and the daemon log recorded that
  same sentence as `run.provision_failed`'s `reason` with no `error` field and
  no stack. So the run that could not start left behind no record of why, in
  either place an operator looks. The exclusion was a §11 reading
  `LaneSetupError` had already revised for this exact reason: §11 keeps
  repository *contents* out of the record — diffs, file bodies, gate output —
  and an error's own complaint about a lock file or a ref is not that. An
  unenumerated error's message is now carried, capped at 500 characters and run
  through the log's redaction set; `LaneAdoptError` speaks for itself like the
  other lane errors; and the failure is logged with its kind and stack frames.

- **`doctor` reported the resumed run's own lanes as leftovers blocking it, and
  offered to destroy them.** The held-branch check fails a run whose phase
  branches are checked out in another worktree, which is right for a fresh run
  and exactly wrong for a resume: the integrator puts a lane on
  `plan/<id>/phase-<n>` for the duration of a phase, so a run killed mid-phase
  — the kill a resume is *for* — leaves its own lanes holding precisely those
  branches. Every `run --resume` therefore refused preflight with one failure
  per phase in flight, each remedied by `git worktree remove --force <lane>`,
  which deletes the uncommitted work the resume existed to adopt. The check now
  takes the run being resumed and excludes lanes belonging to it, identified by
  reading the lane root and asking each worktree which branch it holds — never
  by comparing git's printed paths with this process's, the platform trap
  `reap` and `LanePool` both document. `doctor` takes `--resume <run-id>` to ask
  the same question before a resume, and a lane of *another* run still fails.

- **`vinta-ai-maestro gate` gave up on the slowest gate after five minutes and
  called it a daemon it could not reach.** The command awaited one `fetch`, on
  the stated reasoning that a gate is slow for reasons the client cannot shorten
  and so the client should simply wait — while its own comment claimed it
  imposed no deadline of its own. It imposed 300 seconds, because that is where
  Node's `fetch` abandons a response whose headers have not arrived, and a gate
  that queues for a capacity-1 semaphore and then runs a test suite is routinely
  slower. In a measured fourteen-hour run this fired **33 times, every one of
  them on the `unit` gate and none on any other** — a perfect correlation with
  duration, not a flaky daemon. The gates were running fine and cached green
  results minutes later; only the answer was lost. Told a transport lie about
  work in progress, agents wrote polling loops around a command documented as
  needing none: in one phase, **24 of 108 shell turns were pure waiting, six of
  them burning a full ten-minute ceiling — 60 minutes, 31% of that phase.** The
  wait is a `202` hop loop now, which is what `with` already does, having found
  the same bug the same way and fixed it first.

- **A gate command cut short by the harness started the suite over.** An agent
  harness caps how long one command may run, and a gate may exceed any such cap
  — a plan declaring `timeout_s: 2400` is asking for forty minutes against a
  ten-minute budget. So being killed partway is the *ordinary* ending, and what
  an agent does next is run the command again. That used to start a second full
  suite beside the first, queued behind the very semaphore its own predecessor
  was still holding. The daemon now keys a running gate on `(phase, gate id)`
  and the re-invocation attaches to it, which makes re-running the command the
  correct move rather than a wasteful one — worth having, because it is the move
  an agent makes anyway. There is no token to carry, deliberately: a client that
  was killed has nothing in hand, and needing something would defeat the point.

- **A pipeline that could not progress was journalled as the word "Error".** The
  interpreter composes an id-safe reason for exactly this case — which state it
  could not leave, and which trigger failed to match — and the scheduler threw
  it as a bare `Error`. `failureReason` reports an unrecognised error by its
  name, so the sentence was discarded at the one moment it was worth keeping.
  It is a `PipelineStuckError` now, carrying the state, and the reason survives
  into the journal. The same shape as the non-zero git exit, fixed the same way.

- **A pull request said nothing but the plan anchor.** The daemon opened PRs
  with `title: node.name` and `body: node.prompt_ref` — one line, a link to a
  heading. It had no idea the `prs-context` mechanism existed: there was not a
  single reference to it in the package, so the rich path the skills use
  (`open-pr-from-context`, the project's own PR template, inline review
  comments) was never reached from a run. `open_pr` now reads the phase's
  `.vinta-ai-workflows/prs-context/<plan>/phase-<node>.md` when the agent wrote
  one, and the implementer is asked to write it — the 5–15 line summary it
  already produces, put where a human will read it instead of only the
  transcript. With no context file the body is composed from the run's own
  record: the brief, what the phase is based on and why that is not the default
  branch, its declared surface, its gates, how many attempts it took, and any
  merge conflicts an agent resolved on the way in — which nobody reviews.

- **A phase with two dependencies could never open a pull request.** Its base is
  an `integ-<id>` branch and `git_push` pushes only the node's own branch, so
  `gh` was asked to open against a ref the forge had never seen. It refused, the
  refusal was discarded, and the phase completed with no PR and nothing saying
  so — in one observed run, the single node with two dependencies was the single
  node with no PR. The integration base is pushed before the PR is opened, and
  every outcome is journalled as `node_pr`, so a PR that did not open is now as
  visible as one that did.

- **A conflict resolution was never gated.** `IntegratorOptions.verify` has
  existed as long as the conflict loop, documented as "a resolution that does
  not build is not a resolution", and nothing ever supplied it. Six merges in
  one run were resolved by an agent and went straight in — ungated — to become
  the base the next phase built on, while the phases either side were gated to
  the hilt. The union of the conflicting nodes' declared gates now runs in the
  integration worktree, with that worktree's environment, and a red gate spends
  a fix round instead of shipping.

- **A conflict fixer that committed its own resolution failed the phase.** An
  agent told to resolve a merge conflict reaches for the sequence a person
  would — abort, merge again, resolve, commit — and the orchestrator then
  committed unconditionally on top of it. Against an already-committed
  resolution `git add --all` is a no-op that exits 0 and `git commit --no-edit`
  exits 1 with "nothing to commit", which is a throw. A successful resolution
  was reported as a failed phase, deterministically, on **every wave after a
  parallel one**: a multi-dependency node is the only thing that merges here,
  and two sibling phases both creating one file is the common case rather than
  the rare one. The phase died before its branch was cut, so it left no
  transcript, no gate log and no branch — only a resolved merge commit sitting
  in the integration worktree. The commit is now conditional on there being
  something to commit, and a fixer that discarded the merge instead of resolving
  it is refused rather than recorded as integrated.

- **The conflict fixer's turn is in the transcript now.** Its event stream was
  drained and every event dropped — an unread stream never ends — so the one
  agent turn in a run nobody could watch live was also the one nobody could read
  afterwards: a resolved merge, a row saying it took two rounds, and no record of
  what was decided. It lands in the incoming phase's own transcript, beside the
  implementer and reviewer turns that produced the branches being merged, under
  a `conflict-fixer` role that keeps it distinguishable from the review fixer —
  a different job, in a different worktree, on a different thing. The UI has had
  a band for that role since transcripts learned to name their authors; it had
  simply never been given one to draw.

- **`PlanDefectError` is now `UnresolvedConflictError`.** The old name made a
  judgement the orchestrator is not entitled to make. Two same-wave phases
  touching one file is not a broken plan — the plan's file-overlap analysis is a
  guess made before a line was written, and the fixer exists because of it. What
  reaching that error means is narrower: *this* conflict outlasted its rounds and
  needs a person. The message says so, and now leads with finishing the merge by
  hand in the integration worktree — which, since a prepared base is reused,
  survives into the retry — rather than with re-cutting the plan.

- **A conflict was resolved again on every retry, and recorded nowhere.**
  Conflicts are an ordinary outcome — the plan's file-overlap analysis is a
  guess and two sibling phases legitimately edit one file — but `prepareBase`
  reset and re-merged its `integ-<id>` branch unconditionally, so each retry
  spawned a fresh fixer agent to redo work already done, and discarded any
  resolution a person had finished by hand in that worktree. One observed run
  paid for the same resolution three times. A base that already integrates every
  dependency's current tip is now kept; one built before a dependency moved is
  still rebuilt, because reuse is about reachability of the tips rather than
  about the branch existing. Every settled conflict is also journalled as a
  `node_conflict` event naming both participants, the paths and the rounds it
  took — previously a wave conflict reached only the post-mortem and a *base*
  conflict was discarded entirely, so a phase could sit in `running` for minutes
  while an agent merged in a worktree nobody could see.

- **A failed attempt now says why, wherever it goes next.** The reason was
  computed at the failure site and handed to the path that gives up — which the
  default `onFailure: retry` does not take: it retries automatically, then parks
  on "This phase failed. Try it again?". Both paths dropped the reason, and
  `#offerRetry` carried a comment asserting the opposite. A phase that failed
  three times before any agent ran was undiagnosable after the fact, and the
  only offered action was to repeat it. Every attempt now writes a `node_error`
  event carrying its reason and attempt number, and a `node.attempt_failed`
  record to the daemon log.

- **A git command that exited non-zero was persisted as the word "Error".**
  `failureReason` reports an unrecognised error by its name plus a *string*
  `code`, and an `execFile` rejection carries `name: 'Error'` with a *numeric*
  one — so the most common real failure in this package said nothing at all.
  Git failures now carry their subcommand and exit status (`git commit exited
  1`), which is a command name and an exit code rather than anything §11 keeps
  out of the journal.

- **The conflict fixer ran without its worktree's environment.** It was the one
  agent spawn not given `AgentTask.env`, whose own docstring records this exact
  bug class. With the daemon's bare environment its `docker compose` resolved to
  a project named after the directory rather than the isolated one, ignored the
  `compose.publish: []` override that rides in `COMPOSE_FILE`, and published the
  project's fixed ports on the host — colliding with the developer's own stack
  and outliving the run.

- **"Retry with <member>" offered the member that had just failed.** The menu
  excluded the member the *plan* named, but a substitution means the member that
  actually ran is someone else — so a phase declared for one tier and covered by
  a higher one offered that higher one as its escalation, and a third of the
  menu did nothing distinguishable from plain retry.
- **An amended workflow now reaches the integrator too, and a wave merge is
  pinned to the membership it was decided with.** Fixing the executor without
  fixing the integrator is what made this reachable: `#lastOfWave` decides a
  wave is complete by counting the executor's node set and `mergeWave` decided
  what to merge by reading the integrator's, so while both were stale they
  agreed with each other and nothing showed. One fresh and one stale is a wave
  whose merge silently omits the branch of a phase that ran.

  The case that gets there is a phase nobody depends on. An amendment is
  refused while a node it *blocks* is in flight, and such a phase blocks
  nothing, so it lands freely beside the wave-mates it will be merged with.

  A wave's membership is now computed once, synchronously, by the code that
  decides the wave is complete, and handed to the merge — a wave merge runs
  behind the integration worktree's queue and an amendment can land in between,
  so a merge that re-derived its own membership would merge a phase that never
  ran. §9's rebase goes through that same queue now, since "the nodes this
  amendment blocks are idle" says nothing about whether another wave's merge is
  writing in that directory.

- **An amended workflow now reaches the code that runs the gate.** `adopt`
  replaced the scheduler's copy of the run's definition and nothing else, while
  the effect executor and the agent-gate broker each held the snapshot they were
  constructed with — and the command a gate actually runs is read from the
  executor's. So an operator who edited a gate command mid-run moved the
  snapshot, the journal and the pool reservations, watched the amendment be
  accepted, and went on getting the old command. All three take the amendment
  now, fanned out from one place, host side before the scheduler so that no
  phase is dispatched against a definition half the system has not seen yet.

- **Closing a terminal on a run now records the interruption.** `run` and
  `serve` handle SIGHUP as well as SIGINT and SIGTERM — SIGHUP is what a
  terminal sends when its window closes, and with no handler Node's default was
  to die on the spot, running no teardown and writing no `run_ended`. Both
  commands now mark their live runs interrupted before exiting and print the
  `--resume` line for each, so a closed window leaves something recoverable
  instead of a row nothing will ever move again.

- **A member's reviews were counted as phases they took.** `node_crew` is
  written for both seats — the reviewer's claim carries `role: 'reviewer'`, the
  implementer's omits it — and the staffing rollup read neither, so every phase
  a member reviewed was folded into the count of phases they implemented. On any
  run with reviewers that inflated the number the rollup exists to put beside
  the plan's estimate, and inflated `asPlanned`, which the run view divides by.
  The two seats are counted apart now rather than one of them dropped: a review
  is real work by a real member, and a member who only reviewed is neither a
  phase-taker nor idle.

- **An agent taking a lease left the resource panel showing the one before it.**
  The scheduler's own gate-pool transitions are journalled as `gate_pool`
  events, so the browser re-reads the snapshot when one lands. An agent's lease,
  taken through `vinta-ai-maestro with`, was only a row in the `leases` table —
  correct in the daemon's projection and announced to nobody. A projection
  nobody is told changed is a projection nobody sees change, so the panel showed
  whatever holders it had last time some unrelated event happened to arrive, and
  the waits it was stalest about were the agent ones, which are the long ones.
  The broker now journals `agent_lease` on both edges. A renewal writes nothing:
  it is a heartbeat on a lease already reported, and journalling it would bury
  the two rows that are transitions under a liveness log.

- **An agent waiting for a semaphore could be overtaken without bound.** A
  `vinta-ai-maestro with` wait is served in fifteen-second hops so no client
  timeout has an opinion about it, and each hop used to abort the underlying
  `pools.acquire`. Aborting leaves the pool queue, and the next POST re-entered
  it — at the tail, behind every waiter that had arrived in the meantime. Since
  a gate run holds a capacity-1 semaphore for minutes, an agent lost that race
  on hop after hop while the scheduler's own in-process waiters, which never
  leave the queue, did not. The pool's aging rule could not help: aging reserves
  against waiters *behind* the aged one, and the waiters that overtook it are in
  front of it. A `202` now carries a `waitToken` naming the wait, the client
  sends it back, and the daemon keeps the one queue entry — one arrival time,
  one place in line — across the whole wait. A parked wait whose client stops
  hopping is reaped after a minute, releasing the slot if one was granted to it
  while nobody was watching.

- **The monitor's conversation could never be written on Windows.** It is kept
  under a reserved node id that becomes a directory, and that id was
  `monitor:conversation` — a colon, chosen because no phase id may contain one,
  and the drive separator on Windows. `mkdir` failed with `ENOENT`, so every
  question threw on its first append and the endpoint reported the monitor
  unavailable. A colon is legal in a macOS or Linux filename, which is why no
  machine the feature was built on ever saw it. The id is now
  `_monitor-conversation`: still unrepresentable as a phase id, and legal
  everywhere. Conversations recorded under the old id are not migrated.

- **An implementer was told both to commit and never to commit.** The prompt
  carried "never commit while a gate is red" beside "the turn is not complete
  until `git status --porcelain` is empty of your work" — a contradiction
  whenever the gate could not be turned green inside the turn, which is most of
  why fix rounds exist. Agents obeyed the `never`, and the reviewer one node
  later raised the BLOCKER it is told to raise for uncommitted work, spending a
  fix round re-implementing code that was already on disk. A red gate now
  changes the report and never the decision to commit: commit, and report
  FAILURE saying what is still red.

  The reviewer's side was a false BLOCKER independently of that. Any unclean
  tree was a finding, and a lane's tree is never clean — the pool copies
  configuration in, links dependency trees, and the gates leave build output
  behind, none of which the implementer is allowed to stage. It is scoped to
  the failure it was written for now: work that is in the tree and missing from
  the diff.
- **A live transcript stops following at entry sixty.** The effect that kept the
  box on the newest row was keyed on how many rows were *shown*, which is
  `min(entries, window)` — so it stopped changing the moment a transcript
  outgrew one window, and the following died silently and permanently, including
  after the operator scrolled back to the bottom to ask for it. Which is roughly
  minute two of any real phase. It follows on the entry count now, growing the
  window keeps the reader on the row they were reading instead of teleporting
  them, and a **Jump to latest** button says so out loud rather than leaving a
  60px band at the bottom of a scroller as the only way back in.

- **The transcript spends its space on the noisiest rows.** An agent's answer,
  its private reasoning and four hundred characters of tool-call JSON all
  rendered as the same two lines at the same weight. Thinking is now small and
  quiet, and a streamed thought is one row rather than the dozen events it
  arrived as; tool calls and their results fold to the argument that says what
  they did — a command, a path — and open individually or a whole kind at a time
  from the panel header. Prose is untouched and never folds.

- **A panel's expand control did nothing on the node view.** It expanded by
  taking `col-span-full`, which on the run view bought a strip a third wider and
  on the node view matched nothing at all — those panels sit in a flex column,
  not a grid, so the only thing the button changed was the height of the
  scroller inside it. It now opens the panel over the whole page through a
  portal, so no scrolling ancestor can clip it, with Escape to leave and the
  page behind it held still. A transcript that was following stays on its newest
  row across the change.

- **`doctor` checks that the shared servers answer.** It verified that binaries
  existed and disk fitted, and never looked at a `server_url` — so a project
  whose Postgres lives in another checkout's compose stack passed the preflight
  with that stack down and died on the first `createdb`, before a worktree
  existed. Each external database's server and each service URL is now probed
  with a TCP connect, and a failure names the address that did not answer. A
  compose-delivered database is deliberately not probed: the lane starts it.

  The order matters as much as the check. `prepare_cmd` runs *before* the
  preflight, so the check reports the world that hook just made rather than the
  one in front of it.

- **A service's `create_cmd` runs with the lane's environment.** `reset_cmd`
  always had it and `create_cmd` did not, so a `create_cmd` that reached for
  `docker compose` ran against the lane's own compose file with no project name
  and no override — booting a stack on the project's fixed host ports, which is
  the collision the override exists to prevent, caused by the step that sets a
  lane up.

- **`vinta-ai-maestro with` waits for the lock instead of giving up on it.** Its
  usage said it blocked until the resource was granted, and it did — for about
  five minutes, which is where Node's own `fetch` stops waiting for a response.
  A test suite behind a capacity-1 semaphore beats that regularly. What the
  agent saw was "could not reach the lease daemon", and what agents did with
  that, repeatedly, was run the command without a lease: exactly the stampede
  the pool exists to prevent, arrived at by an agent behaving reasonably.

  The wait is the client's now. The daemon answers `202 still queued` within
  seconds and **leaves its own queue behind it**, so nothing is granted to a
  request that has gone away; the client loops until it is granted, saying so
  once and then occasionally, so a transcript shows a wait rather than a
  silence. Only answers that waiting cannot change — a resource this run does
  not declare, a run that is no longer live — end it.

  And when it does end that way, the refusal says what not to do about it.
  "The resource lease was not granted" is an error with no alternative in it;
  the rule against working around it now travels with the message rather than
  sitting only in a prompt the agent read twenty minutes earlier. The prompt
  says it too, including that waiting is the expected outcome and not a failure.

- **A retry gets a fresh fix budget.** `fix_rounds` was set to 0 when a node was
  created and never again, so a phase that spent its whole budget on attempt 1
  began attempt 2 already exhausted — one review, one fix, and the exhaustion
  transition fired straight back. Seen with `max_fix_rounds: 4`: the retry got a
  single round before the operator was asked again, forty seconds of work
  standing in for four rounds of it. A retry that inherits the reason the last
  attempt ran out is not a retry. It resets wherever a node is re-driven from
  its pipeline's initial state — a capacity refusal, an automatic retry, the
  operator's answer, the `retry` verb — which is one place rather than four.

- **The last fix is reviewed rather than failed unread.** `standard-phase`
  checked the budget on the way *out* of `fix`, so the final fixer's work went
  straight to `failed` with nothing looking at it. Two phases in one run ended
  on a fixer reporting "all gates green, committed, tree clean" and were failed
  anyway. The check now sits in front of the fixer, on both doors into it: every
  fixer that runs is reviewed, and the review after the last one can still pass
  the phase. Guarding only the review side left a red gate under a passing
  reviewer looping forever, which is the other half of the same change.

  `max_fix_rounds` still means the number of fixers a phase may spend. `0` now
  means none, where before it let one run and failed the phase regardless.

- **Agents are told not to background their work.** An implementer started five
  commands with `run_in_background: true` and closed its turn with "I'll wait for
  the test result notification before continuing to the outer gate". There is no
  notification: a headless session ends when the turn ends and whatever it
  backgrounded is killed with it. Three sessions ended with no report and no
  commit, and the reviewer failed each for uncommitted work — true, and not the
  cause. Nothing had said so, and believing a tool that offers backgrounding will
  still be there afterwards is not unreasonable.

- **The reviewer runs the gates instead of taking their word for it.** The prompt
  asked it to confirm the outer gate was green, which an agent can do by reading
  the implementer's report — one reused reviewer session reached a verdict in
  under four minutes without running the project's tests at all. It is now asked
  to run them, to say what they returned, and to treat being unable to run them
  as a finding. Re-review rounds are asked again, because a session that
  remembers running them last round is remembering a different tree.

- **A retried phase keeps the commits the attempt before it made.** A failed
  phase re-enters its pipeline at the initial state, which runs `git_branch`
  again — and `checkout -B` moves an existing branch unconditionally, so attempt
  2 began by resetting attempt 1's work to base. The files left the worktree,
  the next reviewer correctly reported "phase not implemented at all", and the
  fix budget burned re-implementing from nothing until the operator was asked. A
  phase that produced real commits was guaranteed to lose them.

  "Cold" was always meant to describe the agent's *session*, not its branch —
  and the default policy targets environmental failures, which is exactly when
  the previous attempt's code is worth keeping. A resumed branch is checked out,
  never rebased onto a base that moved: a conflict there would fail the retry
  during its setup, before the agent that might resolve it has run. A branch
  that committed nothing is still moved up. Whether this is a second attempt is
  read from the journal rather than from the ref, because a phase branch's name
  carries the plan id and not the run id — an identically named branch left by
  an earlier run must still be cut fresh. `node_assigned` now records
  `previous_head`, so a reset that does happen is visible in the run rather than
  only in a reflog.

- **A phase is judged on commits, and the prompts finally say so.** An
  implementer ran four sessions, reported `SUCCESS` with a green inner loop, and
  never ran `git commit`: its deliverables were untracked files. The reviewer
  reads the committed diff, so it saw an empty one and reported "not implemented
  at all"; the fixer re-implemented, also without committing; the rounds ran out
  and the lane was recycled over the files. Every instruction that agent had was
  *about* committing — "never commit while a gate is red" — and none of them
  said it had to.

  Implementers and fixers, cold and continued, are now told that the phase is
  reviewed and merged from commits on its branch, that an uncommitted file does
  not exist as far as the run is concerned, and that the turn is not over until
  `git status --porcelain` is empty of their work — staged by explicit path,
  never `git add -A`, because a lane holds local files that are not theirs to
  commit. The reviewer reads the working tree as well as the diff: a full tree
  with an empty diff is a real failure and is *not* "not implemented", and the
  difference decides whether the fixer writes the code again or simply commits
  it.

- **A recycled lane no longer deletes work nobody committed.** Both recycle
  paths throw the working tree away. The tree is now committed first — with
  plumbing, and **off the branch**, under `refs/vinta-ai-maestro/wip/`. On the
  branch was the first implementation, and it was wrong: a lane's dirty tree
  holds gate artifacts as often as deliverables, and a phase branch is the base
  of its dependents, so one gate's scratch file reached the next phase and
  failed a gate for a reason nothing in that phase caused. Nothing merges,
  nothing reaches a dependent, and one `git restore --source <ref>` gets a file
  back. Where the rescue itself fails, the recycle refuses and names the paths.

  The retry question says how much is at stake: commits are kept, and *N*
  uncommitted files in the lane will be set aside.

- **`project.hooks: skip`.** Committing is not optional any more, and a
  `language: system` pre-commit chain reads a never-committed-in worktree as a
  fresh machine — one project's hooks built a 510 MB virtualenv before allowing
  a first commit, per lane, after four attempts and a two-minute timeout. Set
  per worktree, so the operator's own checkout keeps its hooks, and opt-in,
  because hooks are usually there for a reason.

- **`doctor` knows when a project needs docker compose.** It assembled its
  options without a `project`, so `needsCompose` was handed `undefined` on every
  invocation and reported "not required by this project" for a
  compose-delivered database — and `run`'s own preflight did the same. A check
  nothing can reach is worse than an absent one: it reads as a pass.

- **A failing `setup_cmd` says why.** It carried a lane name and nothing else,
  so the operator saw "could not provision the lane pool under …" and had to
  replay the command by hand with the lane environment rebuilt to find a missing
  settings module. It carries the exit code and a bounded stderr tail now — the
  same class of thing as a harness refusal's own explanation, which this package
  already decided to carry after an afternoon lost to the same silence.

- **A lane the executor was not given is refused, not guessed.** It fell back to
  the right directory with an *empty environment* — a gate running against the
  wrong compose project and no forked connection string, with nothing anywhere
  saying a lane was missing.

- **The monitor reads, and does not run.** Its shell has no lane environment, so
  the project's own commands run from it contend with the lanes instead of
  observing them. One reported "the final gate fails on a port conflict" when no
  gate had run at all, and the operator believed it. Gate results come from the
  journal and the gate logs.

- **`serve --host 0.0.0.0` prints a URL another machine can open.** Binding
  every interface made the server report the wildcard back, so the line printed
  for the operator to open — and share — was `http://0.0.0.0:<port>`, which
  resolves for nobody. The bind is unchanged; the printed host is now this
  machine's LAN address. The daemon still warns, because the token in that URL
  is the only thing between the run and anyone who can reach the port.

- **An agent can run a shell command.** `auto` mapped to the vendor's
  `acceptEdits`, which accepts file *edits* and nothing else — a shell command
  still goes to a permission prompt, and in `-p` there is nobody to answer one.
  A run of eight phases died of it: the agents wrote their code and were then
  refused `ruff`, `pytest`, `git add` and `docker compose`, **69 denials across
  two lanes**, every gate failing on work that was never allowed to be checked.
  `auto` now allows `Bash` in the policy file it already writes.

  What that costs is worth stating plainly: **`Bash` was never confined to the
  lane.** The deny list covers the file-editing tools and a shell redirection
  walks through it, so allowing the shell allows commands on the machine.
  `auto` has always promised exactly this in words — "the agent works unattended
  inside its lane" — and this is the first version where the words are true.
  `ask` still does not allow it: that mode exists for a human at the browser,
  and the prompt is its purpose.

- **A refusal says why, in the words the harness used.** `permission_denied`
  carried a decision token and deliberately dropped the sentence beside it, on
  §11 grounds. Then a run failed with forty-five denials reading
  `reason: "other"`, and finding out what that meant cost an afternoon and a
  rebuilt reproduction — the sentence said "this Bash command contains multiple
  operations; the following parts require approval". §11 keeps repository
  *contents* out of the record; a refusal's own explanation is not contents, and
  the `tool_use` row above it already carries the path and the command verbatim.
  Withholding it protected nothing and hid the one fact worth having.

- **`serve` opens a run that has already finished.** The API resolved a run from
  the in-memory registry *and* the journal and required both, so a daemon
  started with nothing running listed the operator's history — the list reads
  the journal — and then answered 404 for every run in it, under a message
  saying the daemon was not running. Reads now need only the journal, which is
  where a run's whole record lives and which outlives the daemon by design
  (§5.3). Steering a finished run is still refused, with `409` rather than
  `404`: the run exists, and saying it does not sends the operator hunting for a
  typo instead of reading the status in front of them.

- **Four places the UI asked the operator to work around it.** The transcript
  opened at the *oldest* row it held, so a live agent's newest line — the one
  the panel was opened to read — sat below the fold and every arriving entry
  pushed it further down; it now opens at the newest and stays there, but only
  while the operator is already at the bottom, because scrolling up is reading.
  The `git diff` command overflowed its panel, uncopyable without selecting
  blind, and now wraps. The shell's bounded column went from 1280px to 1600px:
  1280 is a reading measure, and the Nodes table's columns are ids, lane names
  and branch names, none of which can be abbreviated without losing what
  identifies them. And the notification interval said "Remind every 5 min"
  without ever saying what it would remind anyone about — it repeats the
  notification for a phase that stopped to ask the operator something, until
  they answer, which is what the options say now.

- **A killed terminal releases its directory on Windows.** Two PTY tests failed
  teardown with `EBUSY: rmdir`: killing a process there is not synchronous with
  releasing what it held, so the conpty and its background child are gone as far
  as the test is concerned while the OS still has the working directory open.

- **A failed phase can be retried instead of ending the run.** `run` takes
  `--on-failure <stop|ask>`. `stop` is the default and is what every run has
  always done — the phase fails, its dependents block, the run finishes. `ask`
  parks the node on a question instead: retry, retry with another member of the
  crew, or stop.

  It exists because the failures worth retrying are overwhelmingly
  environmental — a permission wall, a grant nobody made, a gate whose service
  was not up — and the only recovery was to start the whole plan again, running
  every phase that had already succeeded a second time. Only pass `ask` when
  somebody is watching: the run waits, which is exactly why it is not the
  default.

  The alternatives offered are **members of the crew, not models**. A staffed
  run has no free-floating models in it — a phase is taken by a member, and the
  tier floor that decides who may take it is the assigned member's own — so a
  model is something the plan cannot express and nobody could be found to hold.
  A member below the phase's tier is never offered: an operator answering a
  question is not a reason to hand a phase to somebody the plan judged too
  junior for it.

  The retry starts **cold**, and everything the node held goes back before it
  waits (§6.1) — an operator at lunch must not be holding a lane another phase
  could use.

- **A refusal nobody was asked about is now said out loud.** The adapter knew
  about `permission_request`, a question waiting for an answer, and nothing
  else. The refusal an operator actually hits is not a question: a read outside
  the working directory is decided by the CLI and announced as
  `permission_denied`, with no request to reply to. That frame was dropped at
  the first `switch` — no event, no journal row, no transcript line. The new
  `permission_denied` event carries the decision token (`workingDir`, `mode`)
  and never the vendor's prose, which names the file being read (§11).

- **A turn that ended blocked is no longer a turn that succeeded.** The CLI
  says `status_category: "blocked"` one frame before reporting
  `is_error: false`, and both are true from its side: it was asked for
  something it could not do and said so. Taking the second at its word is how a
  phase passed having written no code and then failed two steps later under
  another name. A session that reported an error no longer ends `ok` — which
  also makes a reviewer fail closed, since its verdict is read back out of a
  transcript whose session did not end cleanly.

- **An agent still could not write in its own lane.** The entry below passed
  claude-code `--permission-mode auto`, which matched our own vocabulary for
  "works unattended" and is not what the vendor means by the word: `auto` still
  routes a write to a permission prompt, and in `-p` there is nobody to answer
  one. Run against the CLI, a `Write` to the agent's *own working directory*
  comes back denied with no reason attached — the same dead end, wearing the
  word that made it look closed. `acceptEdits` is the mode under which that
  write succeeds, and is what `auto` now maps to. The test covering this
  asserted the word rather than the behaviour, so it pinned the bug in place.

- **A phase can read the operator's checkout.** A lane is a worktree cut from a
  branch, so anything uncommitted — a plan written this morning, a spec that
  never leaves the operator's machine — is present where they are and absent
  from every lane. Reaching for it was refused before the model saw a byte, with
  a message that reads like a prompt awaiting an answer ("Claude requested
  permissions to read from …, but you haven't granted it yet") when in fact
  nothing is asking: the CLI denies it outright, emits no permission request,
  and the session then ends *successfully*, having written nothing.

  The repository root is now granted to every claude-code agent for **reading**.
  Granting a directory also grants writing in it, and the lane sits inside the
  directory being granted, so the grant is paired with a deny list that keeps
  the lane the only writable place under it — the operator's source and every
  sibling lane stay refused. That list names the *siblings* at each level down
  to the lane rather than the root itself, because the vendor resolves deny
  before allow with no carve-out: `deny: <repo>/**` plus `allow: <lane>/**`
  refuses the lane too. Each of those facts was established by running the CLI.

  **This covers the file-editing tools and not `Bash`.** A shell redirection was
  never confined to the working directory and is not confined now; that boundary
  is the OS's, and the vendor's sandbox that enforces it also switches off the
  network a phase needs to install anything.

  codex needed nothing: under `--approve-for-me` it already reads anywhere on
  disk, which was confirmed the same way.

- **An agent can write in its own lane.** Every adapter declared
  `permissionControl: true` and passed no policy at all: claude-code was spawned
  as `-p --output-format stream-json …` with no `--permission-mode`, and codex as
  `exec --json` with no sandbox and no approval flag, under a comment saying it
  took both on the command line. So a headless run asked before its first write,
  emitted a `permission_request`, rendered it in the transcript — and nothing
  anywhere answered. The phase failed reporting a permission system it could not
  see, having written nothing.

  `run` and `serve` now take `--permission <ask|auto|full>`, defaulting to
  `auto`. **The operator sets it, never the workflow document**: the document is
  committed and shared, and a file in a repository should not be able to tell
  someone else's machine to run agents without approvals.

  Both CLIs refuse combinations that looked reasonable, and both were found by
  running them rather than reading them: codex rejects `--sandbox` alongside
  `--approve-for-me`, and `codex exec resume` accepts neither — passing the
  fresh-spawn policy there turned a `stale_session` refusal, which the scheduler
  retries cold, into a `fatal` one that fails the node.

  This reverses a documented decision. The README said the daemon passed no
  permission flags and that a committed `.claude/settings.json` was what made a
  run able to write; that is now the narrowing layer on top of a mode, not the
  only thing standing between an agent and a blocked lane.
- **`purge --lanes --branches` clears what a failed run leaves behind.** A run's
  lane worktrees are not under `runs/`, so no purge ever reached them: three
  failed attempts at one plan left twelve worktrees, twelve summaries, and a set
  of `plan/<id>/phase-*` branches still checked out — which is what makes the
  *next* run of that plan impossible, since git refuses to check out a branch a
  second worktree holds.

  One rule decides both: **never delete the only copy of work.** A phase can
  leave work committed on its branch or uncommitted in its worktree, and both
  count — so a branch carrying commits no other branch has is kept, a lane with
  a dirty tree is kept, and each is listed with the command to remove it by
  hand. Untracked files count as work: a phase that wrote three new modules and
  never committed them is exactly the case worth protecting.

  Emptiness is measured as "carries no commit another branch does not already
  have", not as "merged into HEAD". The latter is relative to wherever the
  operator is standing, so on a feature branch — the checkout this is most often
  run from — every empty phase branch looked unmerged and nothing was ever
  cleaned up.

  `--dry-run` and `--yes` work as they already did, and a worktree that will not
  go is named rather than counted.

- **`doctor` now catches, before a lane exists, the failures that used to take a
  run each.** Four consecutive runs of one plan failed four different ways, and
  every one of them was knowable at minute zero from the workflow and the repo.
  - **Every `prompt_ref` and `plan_context_ref` is resolved against
    `base_branch`**, with `git cat-file -e`, which reads the branch's tree and
    so cannot be satisfied by a working-tree copy — the working tree being
    exactly what a lane will not have. It distinguishes the three cases, because
    they have three different fixes: never committed, **staged but never
    committed** (`git add` alone does not put a file in a branch), and committed
    on a different branch. The last offers both routes out — merge it, or point
    `base_branch` at the branch that has it — since only the operator knows
    which they want.
  - **Phase branches held by another worktree** are reported with the directory
    to remove. Lane directories are named per run and phase branches per
    workflow, so a failed run leaves worktrees holding the branch names the next
    run will try to cut, and git refuses to check out a branch twice. Nothing
    cleans those up: `purge` deletes run state under `.vinta-ai-maestro/runs/`,
    and lane worktrees are not there. `doctor` does not delete them either — a
    failed lane's worktree is the only place its state survives — but it now
    names each one and the exact command.

- **A failed node records why.** `node_status` carried `{"status":"failed"}` and
  nothing else, so two runs failing for two unrelated reasons produced identical
  journal rows and the cause survived only in the operator's terminal. The
  reason is now persisted — **sanitized**, not raw: errors the package builds
  itself are identifiers by construction and are kept verbatim, and anything
  else is reduced to its kind, the rule `recycleStage` already followed. The
  journal is durable and API-served, and an exception message from a dependency
  is exactly how repository content gets into one. Blocked dependents record
  which node blocked them.

- **Two diagnostics that named the symptom and hid the cause.** Both came out of
  one real run, and neither was a wrong answer — just an unusable one.
  - **A phase whose plan is not committed** failed with `prompt_ref "…" names no
    readable file`, against a path that was spelled correctly. A lane is a fresh
    worktree of the base branch, so a plan sitting untracked in the operator's
    checkout is in the one place the run cannot look. The message now names the
    directory it resolved against and says why a plan is often not in it.
  - **A lane summary the daemon could not accept** reported `summary unreadable`
    and advised deleting the lane — which takes its forked databases with it,
    over what turned out to be two wrong fields. `doctor` now names the fields
    and what was expected, and offers repair before deletion. A file that does
    not parse at all still reports as unreadable, because there is no field to
    name. Neither message carries the offending *value*: a summary holds
    database names and connection variables, and the value that failed
    validation is the likeliest thing in it to be one.

  `prepare-worktree` gained the rule that would have prevented the summary in
  the first place — its `|` alternatives are closed sets read by machine, `null`
  is how you say "none", and a strategy outside the set should be the closest
  one plus a `note:` rather than a fourth word.

- **`npx vinta-ai-maestro` now runs.** The published package pointed its `bin` at
  `src/cli/bin.ts` and relied on Node stripping the types at startup — which Node
  refuses to do anywhere under `node_modules`, unconditionally and with no flag to
  override. So the CLI worked from a checkout and died on first run once installed,
  with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`.

  `packages/vinta-ai-maestro` now builds: `tsc` emits `dist/` with
  `rewriteRelativeImportExtensions` (the source imports `.ts` specifiers, which
  emitted JS cannot keep), vite writes the daemon's UI into `dist/ui`, and the
  shebang is rewritten from the source's `--experimental-transform-types` form to
  a plain `#!/usr/bin/env node` — a compiled entry point has no types left to
  transform, and should not ask Node for a flag it is free to retire. `prepack`
  runs the build, so a tarball can never be cut from a stale `dist/`.

  Three packaging faults surfaced with it, each of which broke an install on its
  own:
  - **The UI was never in the tarball.** `serve` resolves its static root as
    `dist/ui` and refuses to read outside it, so it would have booted and answered
    every page with "build the UI first". The build now asserts `dist/ui/index.html`
    exists rather than trusting a vite config that writes outside its own root.
  - **`tailwindcss` and `tw-animate-css` were imported but never declared.** They
    resolved only through pnpm's `.bin` shim setting `NODE_PATH`; building by any
    other path failed to resolve them. Both are now devDependencies.
  - **Everything the UI imports was a runtime dependency.** React, xterm,
    lucide-react and the three workspace packages are bundled into `dist/ui` by
    vite and cannot be loaded at runtime — yet a consumer installed all of them,
    and two carried `workspace:*` specifiers that no registry understands. Moved to
    devDependencies; the published package now declares six runtime dependencies
    instead of fourteen.

  CI packs the tarball, installs it into a throwaway project and runs the binary
  from `node_modules`. Every previous check ran from a checkout, which is the one
  place this class of bug cannot appear.

- **Lane provisioning serializes `git worktree add`, not only the database
  template.** `prepare-worktree` previously named one serialization point; there
  are two. Git rewrites `.git/worktrees/` metadata on every add, and concurrent
  adds against one repository clobber each other's entries — a reproducible
  corruption, not a theoretical race. Worktrees are added one at a time; the
  expensive per-lane work (dependency linking, database cloning, summary
  writing) still overlaps around it.

- **The conflict-fixer round budget is an integration-level setting, not a
  phase's `max_fix_rounds`.** `parallel-lanes.md` now says so, and defaults it to
  two. A merge conflict belongs to a *pair* of phases, so deriving the budget
  from one of them made the answer depend on which phase happened to merge
  second.

- **A resolved merge conflict is confirmed by scanning the files, never by asking
  git.** `git add` clears a path's unmerged flag whether or not `<<<<<<<` is
  still sitting in it, so git's index cannot answer "did the fixer actually fix
  it". `parallel-lanes.md` now requires scanning the conflicted paths for
  conflict markers before the merge is committed. Without it, a fixer that did
  nothing produces a merge commit full of markers that passes into the wave
  branch unnoticed.

> The repository also gained `packages/vinta-ai-maestro/`, the workspace package
> that executes these workflows. It is published as its own npm package,
> `vinta-ai-maestro`, carrying the same version as `vinta-ai-workflows`, and is
> run with `npx vinta-ai-maestro`. It is not part of the `vinta-ai-workflows`
> tarball — the root `files` whitelist excludes `packages/`, so nothing in it is
> installed by `npx vinta-ai-workflows install`. What ships from that work into
> the skills package is the two generated schemas above and the skill changes
> that produce and consume them.
>
> Its browser UI is now built on `packages/design-system/` (`vinta-design-system`),
> a second workspace package: oklch tokens in three layers mirroring
> `vinta-schedule-design-system`, six run-status **tones** (`idle`, `active`,
> `wait`, `attention`, `ok`, `error` — waiting is amber and failure is red, never
> the same hue), shadcn/ui components on Tailwind CSS v4, a small layout kit, and
> a light/dark/system theme. The run graph and the pipeline editor are re-skinned
> through their own custom properties, so the canvas and the badges beside it
> share one palette. It and `vinta-dag-editor` publish on their own cadence
> (`0.1.0`) as dependencies of `vinta-ai-maestro`; nothing in either reaches
> `npx vinta-ai-workflows install`.

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
