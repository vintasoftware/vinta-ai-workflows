# vinta-ai-maestro — specification

**Status:** decisions settled — O1–O8 all resolved (§14). Ready for implementation; nothing is implemented yet.
**Packages:** `vinta-ai-maestro` at `packages/vinta-ai-maestro/` (name free on npm), and `vinta-dag-editor` at `packages/vinta-dag-editor/` (private for now).
**Method:** written under the [Karpathy guidelines](https://github.com/multica-ai/andrej-karpathy-skills/blob/main/CLAUDE.md) — assumptions stated rather than buried, minimum machinery per unit, every implementation step paired with a verification check.

Simplicity here is a **sequencing strategy, not a scope cap**. Each unit is built as the smallest thing that can be verified, so risk is retired early and cheaply; the destination is still the complete product described below, reached by iterating over these units rather than by cutting them. "Not yet" is a valid answer in this document; "not ever" is only used where a non-goal is stated as such and justified.

---

## 1. What this is

`vinta-ai-maestro` executes a `plan-feature` plan as a real, code-orchestrated run: it schedules independent phases concurrently across git worktree lanes, drives coding agents through installed CLIs, queues expensive gates behind capacity limits, and gives the user a live graph, per-agent logs, and a way to steer any running agent mid-flight.

Today `implement-plan` *is* the orchestrator, written as a prompt. That prompt is the starting specification this daemon implements. The partials under `skills/vinta-derive-skills/resources/plan-execution/partials/` — `parallel-lanes.md`, `implementer-prompt.md`, `worktree-seam.md`, `review-loop.md`, `commit-strategy/` — are the input this document was written from, and remain the shared description of the semantics both implementations follow. They are not, however, a constraint on it: see [Relationship to the skills path](#relationship-to-the-skills-path).

### Scope

**Required. The product is not finished until every one of these exists:**

- Workflow JSON as the executable artifact, with a JSON Schema and a visual editor.
- Continuous DAG scheduling with worktree lanes, matching the semantics already specified in `parallel-lanes.md#LANE_SCHEDULER`.
- Named resource pools with capacities, so costly gates (test suite, e2e) queue instead of stampeding.
- Three harness adapters: `claude-code`, `codex`, `opencode`.
- Subscription auth only. The daemon never handles an API key.
- Live directed-graph view, per-agent transcript view, per-agent interaction (interrupt, redirect, add context), and PTY takeover.
- Crash-safe resume.
- Integration: dependency-derived phase branches, wave merges, conflict fixer, and every PR the plan needs to reach `base_branch` (phase, integration and plan PRs).
- **Graceful degradation under harness capacity limits** (§6.1). A vendor saying "not right now" is backpressure, not failure: the node waits and resumes automatically.
- **Browser and OS notifications**, with `await_human` questions answerable directly from the UI (§9).
- **Windows**, after macOS and Linux are complete, tested and polished (Wave 7).
- The additions in §13, which are part of the product rather than extras.

**Deferred — wanted, sequenced after the above:**

- Multiple concurrent runs and multiple projects per daemon. One project per daemon is a v1 boundary, not a design limit; the journal is already keyed by `run_id`.
- Distributing agents across machines. The browser UI already lets the *daemon* live on a remote box, which covers the actual need; a scheduler that farms nodes to a fleet is a different product and should not be designed for speculatively.

**Non-goals, stated so they don't get built by accident:**

- Authoring plans. `plan-feature` keeps that job; `vinta-ai-maestro` executes and reports back (§13.6).
- Multi-user access control. Runs are operator-owned; anyone who can reach the daemon can drive it, which is why it binds loopback behind a token.
- Speculative execution — starting a node on a dependency that is reviewed-green but not yet merged. It would cut latency on deep chains, and it makes every rollback path a partial-rebase problem. Revisit only with a measured critical path (§13.3) showing it would pay.

### Relationship to the skills path

Decided: **coexist.** `vinta-ai-workflows` must keep working with no daemon installed — that zero-install property is its entire value proposition for client repos. `vinta-ai-maestro` is an upgrade for projects that opt in.

**Where they conflict, the skills change to accommodate `vinta-ai-maestro`.** The partials remain the shared vocabulary — both implementations are readings of one description of the same semantics — but they are not a veto. If a skill's current shape blocks something the daemon needs, the skill is amended rather than the daemon contorted around it. The zero-install path stays working; it does not get to freeze the design.

The standing cost is two implementations of one spec. The mitigation is direction: a semantic change is decided here, then written into the partial, then read by both.

---

## 2. Constraints

| Constraint | Consequence |
|---|---|
| No API keys for LLM harnesses — subscription/OAuth auth only | Harness adapters are process supervisors driving already-authenticated CLIs, never API clients. Preflight verifies login; if absent, the user logs in themselves. The daemon never prompts for, stores, or forwards a harness credential. The one exception is a System One classifier (§17.3): its key is read from an environment variable the operator names, sent only to the endpoint the operator configured, and never stored. |
| The root CLI's zero-runtime-deps property is load-bearing | `vinta-ai-maestro` is a separate package. Nothing it needs may enter the root `dependencies`, and the root `files` whitelist must continue to exclude `packages/`. |
| Vinta operates as a HIPAA Business Associate on some engagements | Agent transcripts and gate logs capture repository contents verbatim. They are a new data-at-rest surface: stored **inside the project directory**, gitignored, never in a global cache, with an explicit retention/purge command. No PHI in structured log fields. |
| Runs last hours and outlive laptop sleep, crashes, and daemon restarts | Event-sourced journal; all in-memory state is a projection and is rebuilt on boot. Git is the durable record of work; SQLite is a cache of what the branches already prove. |
| Several agents write concurrently | Every artifact path is owned by exactly one writer. This is why tracking is a directory, and why lane sandboxes deny sibling lane roots. |

---

## 3. Repo layout

Decided: **root stays as-is; add `packages/*`.** The root `package.json` remains the published `vinta-ai-workflows` *and* becomes the pnpm workspace root. Nothing moves — the `files` whitelist, the committed `.claude`/`.cursor`/`.agents` dev-skills symlinks, and the CI workflow paths are all untouched.

```
/                             # workspace root AND the published vinta-ai-workflows
  pnpm-workspace.yaml         # NEW: packages: ['packages/*']
  package.json                # + "packageManager": "pnpm@10.33.0"; dependencies stay empty
  vinta-ai-workflows.mjs      # unchanged, still dependency-free
  skills/ dev-skills/ scripts/
  schemas/
    workflow.v1.schema.json   # NEW: generated from vinta-ai-maestro's zod, committed here
  packages/
    vinta-ai-maestro/
      package.json
      SPEC.md                 # this file
      src/                    # daemon, CLI, adapters, scheduler
      ui/                     # Vite + React app, built into dist/ui
      tests/
    vinta-dag-editor/         # framework-agnostic Web Component (name free on npm)
      package.json
      src/
      tests/
```

**Two packages.** The daemon and its React UI stay together in `vinta-ai-maestro` — they share type definitions by importing the same `src/types.ts`, and splitting them would require a `workspace:` dependency and a build-order dance to buy nothing.

`vinta-dag-editor` is separate because it is a genuinely reusable component with a different consumer profile, and because extracting it to npm later should be a `pnpm publish`, not a refactor. It is **built as a sibling to `vinta-state-machine-editor` and deliberately mirrors its architecture**: a framework-agnostic Web Component in plain strict TypeScript, Vite + Biome + Vitest, deeply readonly data with new objects returned on every change, no data ownership (the host injects catalogs; the component never fetches or authenticates), a host-owned `data` passthrough blob on every node and edge, all labels from a `strings` object, and semantic HTML with keyboard support. Same conventions, same shape, different graph kind — so a developer moving between the two packages is not learning a second set of rules.

It renders and edits **plan DAGs**: nodes with status, wave banding, edges labelled with the dependency artifact, pan/zoom, auto-layout, and edit affordances (add node, draw dependency, delete edge). `vinta-ai-maestro` consumes it via `workspace:*` in both the live run view and the workflow editor — the same component in two modes, which is what keeps the run view and the editor from drifting apart.

`.gitignore` gains `.vinta-ai-maestro/`.

---

## 4. Architecture

```
  ┌─────────────── browser (localhost or port-forward) ────────────────┐
  │  React app: run graph · node detail · transcript · xterm · editor  │
  └───────────────────────────┬────────────────────────────────────────┘
                    HTTP + WebSocket (127.0.0.1, ui token)
  ┌───────────────────────────┴────────────────────────────────────────┐
  │  vinta-ai-maestro ui — static app · journal reads · editor        │
  │  forwards a live run's /api/runs/<id>/* and /ws?run=<id> ──────┐   │
  └────────────────────────────────────────────────────────────────┼───┘
                            loopback, that job's token (job.json)  │
  ┌────────────────────────────────────────────────────────────────┴───┐
  │  one run's job: `run --foreground`, detached (Node 22+)             │
  │  its own loopback API — for its agents and for pause / stop        │
  │                                                                    │
  │   Scheduler ── Resource pools ── Gate runner                       │
  │       │              │                                             │
  │   Pipeline interpreter (state machine per node)                    │
  │       │                                                            │
  │   Harness adapters      Lane manager        Journal                │
  │   claude-code│codex│    git worktrees +     SQLite events +        │
  │   opencode              DB forks            transcript files       │
  └───────────┬──────────────────┬─────────────────────┬───────────────┘
        child processes     git / compose        .vinta-ai-maestro/
```

**Each run is a background job, and the UI is a separate process.** `run` spawns a detached `run --foreground`, waits until it reports the run started, and exits; the job is then the run's only host, and no terminal's lifetime is attached to it. The job keeps a loopback API because its agents need one (`with`, `gate`, the judged hook) and because `pause` and `stop` reach it there; it serves no UI. It writes `runs/<id>/job.json` — pid, address, token, `0600` — which is how every other process finds it, and removes it on the way out; a record whose pid is gone means no job. `ui` serves the app and the journal for every run, and forwards everything addressed to a run with a live job — the `/api/runs/<id>` prefix and that run's socket — to the job, swapping its own token for the job's so the browser never holds the second. A run started from the browser is launched as a job like any other. Two processes on one journal is the case SQLite's WAL and `busy_timeout` already cover; several jobs on one project is the same case again.

**Why a daemon plus a browser UI rather than a desktop app.** Running several agents in parallel worktrees with forked databases and full test suites is a workstation-melting workload; the first time it needs to run on a bigger remote box or a devcontainer, a browser UI is a port-forward and a desktop app is a rewrite. It also erases code signing, notarization, per-OS build matrices and updater infrastructure. Wrapping the same served UI in Electrobun or Tauri later, if a dock icon is wanted, does not require touching application code.

**The daemon never edits code.** It spawns agents that do. Every write to the repository comes from an agent process inside a lane, or from a git operation the daemon runs (branch, merge, push) that touches no file contents.

---

## 5. Data model

### 5.1 Workflow JSON

The executable artifact. Decided: **`plan-feature` emits it alongside the markdown plan, unconditionally**; the markdown stays the human-reviewable document, the JSON is what runs.

**The schema lives at the repo root, in `schemas/workflow.v1.schema.json`** — not inside this package. That directory is by definition where "JSON Schema definitions for every YAML payload the skills produce or consume" live, and a shipped skill now produces this one. Putting it anywhere else would make a skill's output schema invisible to the place the repo documents schemas.

To avoid maintaining the same shape twice, **zod in `src/types.ts` is the source of truth and the JSON Schema is generated from it**, committed, and CI-checked for drift. Versioning follows `schemas/README.md` exactly like every other schema here: additive fields are a minor bump, breaking changes cut a `v2` via the `bump-schema-major` dev-skill.

Two graphs, deliberately separate:

- **The plan graph** (`nodes` + `depends_on`) is a DAG — which phases exist and what each needs. This is what the live view renders and what users edit most.
- **The phase pipeline** (`pipelines`) is a state machine — implement → gate → review → polish → verify → integrate, with a fix loop on red gates, guards and side effects. This is what `vinta-state-machine-editor` edits.

Expressing parallel phase execution inside a single state machine would require parallel regions and gets awkward immediately; keeping them separate keeps each editor simple.

```jsonc
{
  "$schema": "https://…/workflow.v1.schema.json",
  "schema_version": 1,
  "id": "bookmark-folders",
  "plan_ref": "ai-plans/PLAN_bookmark-folders.md",
  "base_branch": "main",

  "defaults": { "harness": "claude-code", "model": "opus", "pipeline": "standard-phase" },

  "resources": {
    "lane":       { "capacity": 3, "kind": "worktree" },
    "test-suite": { "capacity": 1, "kind": "semaphore" },
    "e2e":        { "capacity": 1, "kind": "semaphore" }
  },

  "gates": {
    "types": { "cmd": "pnpm typecheck", "requires": [],             "timeout_s": 300  },
    "unit":  { "cmd": "pnpm test",      "requires": ["test-suite"], "timeout_s": 1800 },
    "e2e":   { "cmd": "pnpm e2e",       "requires": ["e2e"],        "timeout_s": 3600 }
  },

  "nodes": [
    {
      "id": "p1",
      "name": "BookmarkFolder model + migration",
      "depends_on": [],
      "prompt_ref": "ai-plans/PLAN_bookmark-folders.md#phase-1",
      "touches": ["apps/bookmarks/models.py", "apps/bookmarks/migrations/"],
      "pipeline": "standard-phase",
      "gates": ["types", "unit"],
      "harness": "claude-code",
      "model": "opus",
      "max_fix_rounds": 2
    },
    {
      "id": "p2",
      "name": "Folder CRUD API",
      "depends_on": [{ "node": "p1", "artifact": "the BookmarkFolder model" }],
      "…": "…"
    }
  ],

  "pipelines": { "standard-phase": { "states": [], "transitions": [], "initialStateIds": [], "finalStateIds": [] } }
}
```

`depends_on` carries the *artifact* alongside the node id, matching what `plan-feature` now requires of every phase. That string is not decoration: it is what the implementer prompt uses to explain what this phase builds on.

`touches` is the Touch List. The daemon warns — does not refuse — when two nodes in the same wave declare overlapping paths.

### 5.2 Pipeline state machines

Authored in a shape close to `vinta-state-machine-editor`'s own (`states` / `transitions` / `initialStateIds` / `finalStateIds`, with `trigger`, `guard`, `effects` per transition and a host-owned `data` blob on every entity).

**Correction: there is a translation layer.** This section originally claimed there was none. Against the editor at 0.11.0 there are four real divergences, and pretending otherwise would have made the mapping somebody's surprise rather than a designed seam:

| Editor | Pipeline schema | Consequence |
|---|---|---|
| effects as ordered `{before, after}` hooks | one flat array | mapped to `before` and concatenated back — content and order survive, the phase distinction does not |
| `trigger` is `{id, name}` | opaque string | flattened |
| `name` / `description` / `color` / `data` required | optional | filled on the way in |
| `from` nullable (creation transitions) | required | becomes `''`, so validation names the transition instead of the edge silently vanishing |

Two further frictions belong to the components rather than the schema, and are worth fixing at the source: the editor mints ids like `state_<uuid>`, which the workflow `Id` pattern forbids (the host normalises deterministically and remaps every reference, so a legal round trip is still the identity); and `labelOffset` / `requiredPermission` have no workflow counterpart and do not survive a save.

The editor's design says hosts inject the side-effect catalog and treat guards as opaque strings the host validates. The daemon's catalog:

| Effect | Params | Notes |
|---|---|---|
| `spawn_agent` | `role`, `prompt_template`, `harness?`, `model?`, `session?`, `verdict?` | `role` ∈ implementer, fixer, chore, conflict-fixer. `verdict: true` reads the turn's closing `VERDICT:` line into `review.verdict` (§16) |
| `run_gate` | `gate`, `no_cache?` | Acquires the gate's resources first. `no_cache` skips the cache (§13.4) for every gate it runs (`true`) or for the one it names, and the fresh result replaces the entry |
| `run_chore` | `chore?`, `when?` | One agent turn per chore the node runs; no `chore` takes the node's own list, narrowed to the chores whose `when` matches (`review`, `after_review` by default, or `after_pr`). With `when: review` it states `review.verdict` (§16) |
| `git_branch` | `from` | `from` resolves via the dependency-derived base rule |
| `git_merge` | `branch`, `strategy` | `--no-ff` for lane merges; never squash |
| `git_push` | — | |
| `open_pr` | `base`, `draft` | States `pr.opened`, plus `pr.url` / `pr.number` when it opened |
| `write_tracking` | `scope` | `run` / `phase` / `wave` |
| `await_human` | `question`, `kind`, `choices`, `context`, `unattended_answer` | Releases gate resources immediately; lane retention per §6 and O3. `unattended_answer` is the plan saying what the question means when nobody is there (§16.3) |
| `notify` | `channel`, `text` | |
| `grant_fix_rounds` | — | Gives the node its `max_fix_rounds` budget again; the scheduler owns the counter (§16.3) |

Guards are expressions over a small documented context: `review.verdict`, `gate.exit_code`, `gate.stalled`, `human.answer`, `fix_rounds`, `node.*`, `run.*`. Evaluated by a tiny hand-written evaluator — **never `eval` or `new Function`**. A guard is author-supplied data in a tool running with the developer's full permissions; treating it as code turns "someone edited my plan" into arbitrary code execution. Safety is structural rather than a blocklist: the root identifier is allowlisted at parse time, every path step goes through `Object.hasOwn`, and the grammar has no call syntax at all, so `f(x)` is a parse error rather than a sandbox to escape.

**`fix_rounds` is host state, supplied by the scheduler.** The interpreter cannot know which state means "fix" without special-casing an author-chosen state id, which would stop it being a general state machine. It arrives as a fact like any other.

The default `standard-phase` pipeline ships with the package:

```
implement ──▶ gate ──┬─ exit=0 ──▶ review ──┬─ verdict=pass ──▶ polish ──▶ verify ──┬─ exit=0 ──▶ integrate ──▶ done
                     │                      └─ otherwise ──▶ unapproved             └─ exit≠0 ──▶ fix
                     └─ exit≠0 ──▶ fix ──▶ gate
gate / verify ── guard: gate.stalled, or max_fix_rounds set and fix_rounds >= it ──▶ exhausted
exhausted  ──┬─ continue (grant_fix_rounds) ──▶ fix
             └─ stop ──▶ failed
unapproved ──┬─ continue ──▶ review
             ├─ accept ──▶ polish
             └─ stop ──▶ failed
```

Each step runs on what the step before it passed. The gates run first because they are cheap next to a review, and a review of code that does not build is wasted. `review` runs the phase's review chores (§16) once the gates are green. `polish` runs the `after_review` chores (§8) once the review approved. `verify` runs the gates again on the tree that merges, because the review loop and the polish both edit it.

`polish` sits where it does on purpose: a chore edits the tree, so anywhere after the last gate merges a diff the gates never ran against, and anywhere before the review has the review rewriting what the chore just did. A chore declared `when: after_pr` is the exception. It runs at the end of `integrate`, after `open_pr`, because it is about the PR rather than the diff. It must not edit the tree, it is skipped when no PR opened, and it cannot be `on_failure: fail`, because the phase is already merged. Because nothing after it can fail the phase, the node's dependents are released as it starts (§6); a crew member finishing one is waited for rather than covered.

### 5.3 Journal and on-disk layout

```
.vinta-ai-maestro/                      # gitignored, inside the project
  flow.db                         # SQLite
  runs/<run-id>/
    job.json                      # the live job's pid, address and token, 0600; gone when it ends
    job.log                       # the job's stdout and stderr, every attempt appended
    workflow.json                 # frozen snapshot at run start
    nodes/<node-id>/
      transcript.jsonl            # normalized AgentEvent stream, append-only
      raw.jsonl                   # harness-native stream, append-only
      decisions.jsonl             # the phase's decisions (§16.4), append-only
      gates/<gate-id>.log
```

The workflow is snapshotted at run start. Editing the source workflow mid-run does not retroactively change a run; changing a live run goes through the amend path (§9).

SQLite holds the event log and cheap projections:

```sql
events (id INTEGER PRIMARY KEY, run_id, node_id, ts, type, payload_json)  -- append-only, the source of truth
runs   (id, workflow_id, status, base_branch, started_at, ended_at)
nodes  (run_id, node_id, status, wave, lane, branch, base_branch, harness, session_id, ...)
leases (resource, holder_node, acquired_at)                              -- rebuilt on boot, never trusted across restart
```

Everything but `events` is derived and can be dropped and rebuilt. Transcripts are files, not blobs: they get large, they are append-only, and tailing a file is cheaper than paging a table.

**Node rows are projected from events, never read out of the snapshot.** `createRun` emits a `node_registered` per node so that "drop and rebuild" depends on the log alone. Reading `workflow.json` during a rebuild would make the snapshot a second, undeclared source of truth.

**`capacity_waits` is a table, not an event.** §6.1 requires a wake time to survive a restart, but the event vocabulary is a closed union and no variant's payload carries a timestamp. It therefore lives beside `leases` — and unlike `leases` it is *not* cleared on open, since the whole point is that the wait outlives the process. Rows are deleted when their window ends so a later boot cannot resurrect one. If a future event variant carries a deadline, this table should fold into it.

---

## 6. Scheduler

Semantics are already specified in `parallel-lanes.md#LANE_SCHEDULER`; this implements them. A node is dispatched when **every dependency is `done` or landed**, it is **not blocked**, and **all its required resources can be acquired**. A node is *landed* once it has merged, pushed and opened its PR, and only `after_pr` chores that cannot fail it are left (§5.2): what a dependent builds on is already on the integration branch, and a review canvas is not worth holding the critical path for — observed at up to four minutes a phase. Waves exist as a durable spine — the resume anchor, the merge target, the reporting unit — but a node's start gate is its own dependency set, not its wave filling or draining.

```
while pending or running:
    ready = [n for n in pending if deps_done(n) and n not in blocked]
    for n in ready:
        if not try_acquire_all(n.resources): continue   # fixed global order
        dispatch(n); pending.remove(n)
    if not running: break
    ev = await any_node_settles()
    on done:    mark done; release; write phase tracking; maybe build wave branch
    on failed:  mark failed; release; blocked |= transitive_dependents(n)
```

Rules that will cause bugs if left implicit:

- **Fixed global acquisition order.** Resources are acquired in a canonical order (pool name, lexicographic). A node needing `lane` + `test-suite` and another needing them in the other order is how you deadlock.
- **A node holds its lane while queued for a gate.** This is intentional — an idle lane is just disk. It implies `capacity(lane) > capacity(test-suite)` is normal and healthy, and that the gate queue must be **FIFO with aging** so a long-waiting node is not starved by newly-ready ones.
- **Never hold a resource across `await_human`.** A paused node releases everything but its lane's *existence* (the worktree stays, the lane slot is freed only if the pause is expected to be long — see open question O3).
- **Failure containment.** A failed node blocks its transitive dependents; everything else keeps going; in-flight nodes finish rather than being killed.
- **Deadlock detection.** Nothing running, nothing ready, something pending → stop and report the cycle or the unsatisfiable resource requirement. Never spin.

Resource pools are the generalization that makes the costly-gate queue fall out for free: the worktree lane pool is just the pool named `lane`.

### 6.1 Harness capacity and backpressure

A vendor refusing to start a session is **backpressure, not failure**. Rate limits, per-account concurrency caps and exhausted usage windows are all expected operating conditions when running N agents on one seat, and none of them may fail a node or end a run.

Adapters classify every spawn refusal rather than throwing:

```ts
type SpawnOutcome =
  | { ok: true; session: AgentSession }
  | { ok: false; kind: 'rate_limit' | 'concurrency' | 'quota' | 'transient' | 'unauthenticated' | 'fatal';
      retryAfter?: Date; message: string }
```

Only `fatal` — a missing binary, a broken workflow — fails the node. Every capacity kind returns it to the ready set.

**A logged-out harness waits for a person, with no fallback.** `unauthenticated` is neither a failure nor a wait: no timer ends it and retrying only re-asks a vendor that already said no. The node parks in place (lane held, as a mid-pipeline refusal is) in `awaiting_human` on a question with two answers, `logged in` and `stop`. Nothing answers it automatically — no automatic attempt, no unattended retry — whatever `onFailure` says. The harness holds the refusal, so every later spawn on it asks the same question without spawning; the first `logged in` resumes every node waiting on that harness, and `stop` fails only the node it was given for, bypassing the retry policy. A login that did not take is refused again and asked again.

**Resources are released before waiting — but only while the lane is still empty.** The rule splits on whether the node has produced anything yet:

- **Refused at dispatch**, before any agent has run: release the lane and every gate slot, and go back to pending. Nothing is lost, and holding a lane here starves the pool to do no work — with a shared quota it deadlocks the whole run, every lane held by a node that cannot start. This is the case §6.1 was written for.
- **Refused mid-pipeline**, when a fixer or review spawn is turned away after the implementer has already worked: **the lane is pinned and the node waits in place**, releasing only its gate slots. The lane *is* the work. Releasing it discards a completed implementation and makes the re-dispatched node redo it, so a transient rate limit would cost hours of model time — a far worse outcome than an idle worktree.

These do not conflict. The dispatch-time deadlock is caused by nodes that have done *nothing* holding lanes; a node mid-pipeline is not waiting to start, it is waiting to continue, and its work has to live somewhere until it does. A run whose in-flight nodes are all waiting on a quota window is stalled either way — pinning only decides whether it resumes or restarts.

Resuming in place needs the harness's session id (`AgentTask.resumeSessionId`), which is why `resume` is a declared capability rather than an optimization.

**Per-harness admission control, adaptive.** Each harness has an effective in-flight ceiling, starting at its configured value. On a `concurrency` or `rate_limit` refusal the ceiling halves (floor 1); after a run of clean spawns it increments by one back toward the configured value. Additive-increase/multiplicative-decrease, because the real limit is undocumented, varies by account and plan, and changes under us — so it has to be discovered and re-discovered rather than configured.

The discovered ceiling is kept per harness (`capacity_ceilings`, beside `capacity_waits`) as a **hint for the next run**, trusted for six hours: a run started soon after another was throttled opens at the width that worked rather than re-learning the limit by being refused. It is never above the configured value, additive increase still probes upward from it, and the row is dropped once the ceiling recovers. Past the window it is ignored — the limit belongs to the vendor, and a stale guess is worse than starting over.

**One spawn starting at a time, per harness.** The ceiling bounds how many sessions run, not how many boot in the same instant, and CLIs booting together contend for local state (config, OAuth token refresh). A spawn waits until the one ahead of it has a session or a refusal; a refusal therefore parks every spawn queued behind it before any of them spends one.

**Critical path first.** When spawns queue behind the ceiling, a freed slot goes to the node with the greatest height — the longest chain of nodes still in front of it — with arrival order breaking ties. At the configured ceiling nothing queues and this changes nothing; under throttling it is what decides the run's length. The plan itself is never rewritten to reduce parallelism: the graph states what *can* run together, admission decides what *does*.

**Waiting is honest and durable.** Backoff is exponential with full jitter, except when the harness reports an actual reset time, in which case that time is used rather than guessed. A `quota` wait can last hours: such a node enters `waiting_on_capacity`, is rendered as such in the UI (not as an error), notifies the user once, and **journals its wake time** so a daemon restart resumes the wait rather than losing or re-firing it. Waiting nodes are never busy-polled — one timer per harness, not one per node.

**A model out of quota is not a harness out of quota.** Some models carry their own allowance, far smaller than the plan's usage window — a frontier tier sold as credits. A `quota` refusal on a model `defaults.model_fallbacks` lists does not park the harness. The model is remembered as out on that harness, until the vendor's stated reset or, with none stated, for the rest of the run. The spawn goes again at once on the fallback, and every later spawn of that model does too, without first spending a refused spawn. A turn cut off mid-way gets the same treatment: it is re-driven straight away rather than after a wait. If the fallback is refused for quota as well, the refusal was the account's: the memory is undone and the harness parks as above. Every substituted spawn is journaled (`node_model_fallback`), because a run whose top tier quietly ran a tier lower otherwise reads as one that ran as staffed.

**Deadlock detection must exclude capacity waits.** The rule above ("nothing running, nothing ready, something pending → stop and report") is now legitimately reachable while the whole run waits on a quota window. The detector distinguishes *unsatisfiable* (a cycle, or a resource requirement no pool can ever meet) from *not right now*, and only the former stops the run.

---

## 7. Harness adapters

The no-API-keys constraint decides the shape: adapters supervise the user's already-logged-in CLI. Capabilities differ enough that the interface **declares** them rather than pretending uniformity — the UI greys out what a harness cannot do instead of failing at the moment the user tries.

```ts
interface HarnessAdapter {
  readonly id: string   // registry key, NOT the workflow's harness enum — see below
  readonly capabilities: {
    inject: boolean            // deliver a message into a running turn
    interrupt: boolean
    resume: boolean            // continue a prior session by id
    pty: boolean               // interactive takeover
    permissionControl: boolean // non-interactive tool permission policy
    backgroundWork: boolean    // the session outlives a turn that left background work running
  }
  preflight(): Promise<{ installed: boolean; authenticated: boolean; version?: string; hint?: string }>
  spawn(task: AgentTask): Promise<SpawnOutcome>   // never throws on capacity — see §6.1
  attachPty?(sessionId: string): Promise<PtyHandle>
}

interface AgentSession {
  readonly id: string
  readonly events: AsyncIterable<AgentEvent>
  send(text: string): Promise<void>
  interrupt(): Promise<void>
  kill(): Promise<void>
}

type AgentEvent =
  | { type: 'session_started'; sessionId: string }
  | { type: 'user_message'; text: string }   // steering the operator typed — see below
  | { type: 'assistant_text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; name: string; input: unknown; id: string }
  | { type: 'tool_result'; id: string; ok: boolean; summary: string }
  | { type: 'permission_request'; tool: string; detail: unknown }
  | { type: 'usage'; input: number; output: number; costUsd?: number }
  | { type: 'error'; message: string }
  | { type: 'session_ended'; result: 'ok' | 'error' | 'interrupted' }
```

Two details in that block are load-bearing and were both corrected during implementation.

**`user_message` is part of the union.** §5.3 makes the transcript exactly this stream, and §9 lets an operator steer a running agent. Without a variant for the message they typed, the one input that changed a run's direction would be missing from the record of it — and "assert the injected message appears in the transcript" would be untestable.

**`id` is a plain string, not the workflow's `harness` enum.** Those are different contracts: the enum constrains what a *workflow may request*, while this is the internal registry key that admission control keeps one ceiling under. Pinning them together forces test and out-of-tree adapters to impersonate a real vendor and contend for its ceiling.

**`events` is single-consumer.** The first iterator gets the stream; later ones terminate immediately rather than blocking forever on a stream that will never speak to them. Replay is the journal's job — transcripts are files precisely so nobody buffers megabytes in memory to serve a second reader.

**`usage` is per turn, from each turn's terminal frame.** Per-message usage is a delta while the turn total is their sum, so emitting both would make any consumer that adds `usage` events double-count. A session is usually one turn and so one event; a session held open for background work (below) has one per turn, each carrying only what that turn added — claude-code's `total_cost_usd` is the process's running total, and the adapter turns it into the difference. Settled here because the transcript format should not be frozen with this ambiguous. A UI wanting live token counts needs a second, explicitly-delta variant — not a reinterpretation of this one.

**A turn is not a session where `backgroundWork` holds.** An agent that resumes a sub-agent with a message, or backgrounds a command, ends its turn while that work runs. An interactive session waits and wakes the agent when the work reports; a headless one used to end at the first `result` frame and kill the work with its process. claude-code does what the interactive session does when its stdin stays open — the work reports with a `task_notification` and the CLI starts the next turn itself — so its adapter ends the session on the first `result` that leaves no background task running (`background_tasks_changed`, with `task_started` and `task_notification` as the fallback). Work that reports *before* the turn ends counts too. A reviewer that answers while the agent is writing its last message has left the list empty by the `result`, but the agent has not read the answer, and the CLI hands it over in a turn of its own right after; ending at that `result` killed the verdict with the process. A notification is read inside the turn only when a main-thread `user` frame follows it, because the next model call carries it; otherwise the adapter holds the session for the wake turn, for at most a minute of silence. It also waits for the prompt to be answered: on `--resume` the CLI first replays the notifications of tasks the previous process was killed under, and closes that replay with a `result` of zero turns before it reads the prompt. A held session is bounded by silence rather than length — thirty minutes with no frame ends it the way its last turn did — and a turn that failed ends it at once. These frames were checked against a headless claude-code 2.1.285 run: a sub-agent resumed with `SendMessage` is announced by `background_tasks_changed` and a `task_started` with `is_backgrounded: true`, and its answer by an emptied list and a `task_notification`, in both orders above.

The other two harnesses get there differently, and the table below says how. **codex** keeps background commands and sub-agent threads alive between turns under `codex app-server` but never wakes the agent itself, so the adapter holds the session and starts the next turn, naming by id what finished (`exec` killed the work outright). **opencode** wakes the parent itself when a background `task` finishes — injecting its result as a synthetic user message — but only behind `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`, which the adapter sets on every server it starts. It has no background shell, its wake-up can be lost to a race in the server (the adapter re-prompts once when a session goes idle on an unanswered message), and a configured `baseUrl` reports `false` because that server's environment is not the adapter's to set. Every adapter tracks and cancels leftover background work at the end of a session whatever it declares, because work nobody is waiting for must not run unobserved in a lane.

**An unrecognized spawn refusal is `fatal`.** An unrecognized failure is by definition not a recognized capacity signal, and treating it as a wait converts a deterministic misconfiguration into a run that stalls forever instead of reporting. The opposite default would need a retry ceiling to be safe, and none is defined. This is the classification most likely to want revisiting once real vendor output has been collected across all three harnesses.

| Harness | Invocation | inject | resume | pty | Notes |
|---|---|---|---|---|---|
| `claude-code` | `claude -p --output-format stream-json --input-format stream-json --verbose` | ✅ native | ✅ `--resume` | ✅ | Bidirectional stdio; steering is a message on stdin. `--permission-mode` is passed per the operator's `--permission` setting; hooks are not used. Has `backgroundWork`: stdin stays open across turns and the CLI wakes the agent itself. |
| `codex` | `codex app-server` — JSON-RPC over stdio, `experimentalApi` on, one server per session; prompt sent with `turn/start` | ✅ `turn/steer` | ✅ `thread/resume` | ✅ | The thread is started (and resumed) with an explicit sandbox, approval policy and reviewer per `--permission`; an approval request that still reaches the client is recorded as `permission_request` and declined. Has `backgroundWork`, but the server never wakes the agent itself: the adapter holds the session while a backgrounded command (`thread/backgroundTerminals/list`, command items) or a sub-agent thread is still running, and starts a short turn naming, by id, what finished. Needs codex-cli ≥ 0.147.0. |
| `opencode` | `opencode serve` + official TS SDK | ✅ session API | ✅ | ➖ | An HTTP server rather than a supervised pipe; the richest control surface, and the adapter manages a server process rather than one process per agent. Has `backgroundWork` for background `task` sub-agents on servers the adapter starts (the experimental flag is set in their environment); no background shell. |

**Preflight is a hard gate.** Before a run starts, every harness the workflow references is checked for presence and authentication. A missing login is reported with the exact command the *user* runs to log in. The daemon never performs an authentication flow and never touches a credential store.

**Headless by default; PTY for takeover.** Orchestrated runs use structured JSONL — parseable, resumable, journal-able. Interactive takeover is a separate mode: interrupt the headless session, hand its **session id** to an interactive CLI in a PTY, and on detach resume headless from the same id. Trying to make one session simultaneously machine-parseable and human-drivable is the trap; the session id is the handoff token.

For every shipped harness, the common case — "add context", "go a different direction" — needs no PTY at all: it is a message injected into the live session, rendered in the UI as chat. PTY is the fallback path and the raw-log escape hatch.

---

## 8. Lanes, gates, integration

**Lane manager.** A pool of one worktree per crew member — `capacity(lane)` of them on an unstaffed run — plus one integration worktree, provisioned once per run and reused across nodes, per `parallel-lanes.md#LANE_WORKTREE_POOL`. Teardown is never automatic.

**`vinta-ai-maestro` does not invent database provisioning.** `prepare-worktree` already specifies this, and the daemon delegates to it and reads back the summary it writes at `.vinta-ai-workflows/worktrees/<name>.yaml`. The strategies that matter here, in that skill's terms:

- **Template clone is what makes N lanes affordable.** The template DB is created or refreshed **once**, and each lane clones from it (`createdb -T <main_db> <main_db>_wt_<lane>` on Postgres; dump/restore on MySQL; file copy on SQLite). N lanes cost N cheap clones against one shared server, not N database servers.
- **Provisioning has two serialization points, not one.** The template is the obvious one. The other is **`git worktree add` itself**: git rewrites `.git/worktrees/` on every add and concurrent adds corrupt each other's metadata — this was found the hard way, as a reproducible failure, not theorized. Add worktrees one at a time; everything a lane actually costs time for (dependency linking, DB cloning, summary writing) still overlaps around it.
- **A global/external DBMS is the cheap delivery mode**, and the one to prefer for pooling: forking means a new *database* on the already-running server, not a new server.
- **The create/drop commands are configurable, and never block.** An external Postgres spec may set `createdb_cmd` / `dropdb_cmd`, replacing only the binary name (default `createdb` / `dropdb`) in the template setup, the per-lane clone and the reset; `-h/-p/-U` from `server_url` still follow. This is the way to a containerized server the host holds no password for (`docker compose exec -T db createdb`). Every such command runs with stdin closed, its own process group and a timeout, so a password prompt is an error with the child's stderr rather than a run stuck at `starting`; `doctor` probes `dropdb_cmd --if-exists <name>_wt_doctor_probe` and fails when it does not authenticate.
- **Compose-delivered DBs always fork their data volumes**, unconditionally. Two server processes on one data directory corrupts the store, so this is not a tunable. Each lane gets its own `COMPOSE_PROJECT_NAME`.
- **Test databases are per-lane by name** (`<main_db>_test_wt_<lane>`), injected through the channel the runner already reads — an env var or a worktree-local override, never an edit to tracked config.
- **`reset_cmd` per forked DB** is what makes a lane reusable across a migration boundary. **A lane whose databases have no `reset_cmd` is single-use** and is re-provisioned rather than reset.
- **Reuse resets the worktree too, not only the databases** — checkout the lane's branch, hard-reset to its base, and clean untracked **and ignored** files. Otherwise the next phase in that lane starts on the previous phase's branch and files — and on its caches: a `.mypy_cache` and a deleted package that survived as its `__pycache__` once failed a type check on clean code. The clean keeps what provisioning put there on purpose: the copied dependency tree (what lets a lane run a gate at all), the `env_files` (copied again straight after), the empty hooks directory, and the project's `recycle_keep` patterns — what is too expensive to rebuild, a `.venv` typically. Anything else ignored is the project's `setup_cmd` to rebuild, and it runs on every recycle. Order matters: cleaning *after* a database reset would delete the database file the reset just restored. After maestro's own resets the project's `reset_cmd`, when declared, runs in the lane with its environment, then `setup_cmd`; `reset_cmd` runs on a recycle only, never on a fresh lane. The two `recycle` outcomes must be equivalent, and the re-provision branch already yields a clean worktree. A recycle that fails fails the node that was handed the lane, and the reason names the lane, the stage (`preserve`, `worktree`, `database`, `reprovision`) and the cause: the failing step's exit code and the tail of its stderr, bounded as a failed `setup_cmd`'s is, never its command line. A project hook failing during the recycle reports its own error.
- **Recycling happens at hand-over, not at release.** The lane released by the *last* phase to use it is never handed on, and its worktree, branch and databases are the evidence a human reads afterwards — resetting at release would wipe that in every run, which is precisely what "teardown is never automatic" forbids.
- **The disk probe charges every worktree the run will create, and only those.** One count (`lanes/count.ts`), read by the doctor's preflight, the pool and the refusal line alike: one lane per crew member on a staffed run, else `capacity(lane)`; plus the integration worktree, which costs the same disk as a lane; plus `defaults.max_spare_crew` headroom on a staffed run, because a spare's desk is a worktree too; less the up-front worktrees a resume adopts. Capacity bounds how many phases run at once, never how many worktrees exist. A worktree is sized from what provisioning puts in it — the tracked tree at the base ref, its index, the copied dependency tree, the env files — and never by walking the main checkout, whose `.git`, maestro store, nested worktrees and ignored caches no lane gets. What `setup_cmd` builds is not estimated. The probe refuses to provision rather than filling the disk halfway through wave 1, it runs *before* any worktree is created so a refusal leaves nothing behind, and a resume that creates nothing is not probed.

**Git hooks run where the project says, in the integration worktree too.** `project.hooks` (`run`, the default, or `skip`) is applied per worktree, and the integration worktree is one of them: a merge commit maestro makes there — a conflict a fixer resolved, a wave — runs the repository's hooks under `run` and skips them under `skip`, exactly as a lane's commits do. The two never disagree. What the integration worktree adds is that its failures are everyone's: it is the one worktree every multi-dependency base and every wave is built in, so a commit a hook refuses there must not leave `MERGE_HEAD` behind. It does not. The resolution is kept as a commit under `refs/vinta-ai-maestro/resolutions/<node>` (plumbing, so no hook runs), the merge is abandoned, and the operator is asked on the node whose merge it is: *commit* (the hooks again, for an operator who fixed what they wanted), *commit --no-verify* (the resolution already passed the phases' gates), or *abort merge* (the phase fails, naming git's own line). Under `--retry-after`, nobody there answers *abort*. A retry of the phase reuses the kept resolution when its parents still match. **A merge that fails with nothing conflicted is not a conflict and never reaches the fixer:** when git merged the trees and a `pre-merge-commit` or `commit-msg` hook refused the commit, `MERGE_HEAD` is in place with no unmerged path, and the same question is asked — worded for a clean merge, since no resolution or gate stands between the two; when git refused before merging anything (an untracked file in the way), there is no `MERGE_HEAD` and git's own error fails the phase. Before this, such a merge was handed to the fixer as a conflict with an empty file list, round after round. Before any checkout, the integrator refuses a worktree that is mid-merge, mid-rebase or mid-cherry-pick by name — `integration worktree is mid-merge: a merge of plan/x/phase-b into plan/x/integ-c was started and never concluded` — rather than letting every phase fail on `git checkout exited 1`. `GitCommandError` carries the redacted tail of git's stderr for the same reason.

**A merge the run started itself is redone, not refused.** A pause, a stop or a kill that lands while the integrator is merging leaves that merge standing, and nothing else will ever conclude it: refusing it failed every later attempt in its setup, backed off the unattended retries and parked the phase on a person whose only move was `git merge --abort`. So before that refusal the integrator asks whether the merge is its own, from git rather than memory: the branch checked out is one of the plan's `integ-` or `wave-` branches, and what is being merged is one of the plan's phase branches (at its tip, or behind it when a retry has moved it on since), a kept resolution, or the plan branch catching a wave up. If it is, whatever the merge has in its tree is kept as a commit under `refs/vinta-ai-maestro/abandoned/<branch>` (plumbing, never reused automatically: it passed no gate and may hold conflict markers), the merge is aborted, and it is redone — so its result reaches the gates and the conflict fixer again. Each one journals `integration_reclaimed`. Anything else — a rebase, a cherry-pick, a merge of a branch the plan does not know or into one it does not own — is somebody's own work and is still refused by name. The same sweep runs when a run resumes, before any phase needs the worktree, and on the way out of a stop whose drain outlived its deadline; and a `git_merge` of a named branch, which no fixer reaches, aborts its own merge when it fails.

**A wave is built from the journal's view of who arrived, not the process's.** A phase counts as arrived at its wave merge when it reached it in this process or when the journal calls it `done`; a `done` phase is not run again on a resume, so a count held only in memory never completed a wave whose phases merged on both sides of a restart — one observed run never built waves 2 to 5. Whether a wave is *built* is read from git: its branch has the wave under it and every member's tip in its history, and its last wave gate was not red. The turn that completes a wave first builds any earlier wave that is missing and complete, and afterwards any later wave that completed while this one was missing; a wave that completes over a missing, incomplete one journals `wave_deferred` and is built by whoever completes that one. Each build journals `wave_built`.

**Every merged tree is gated in full.** Every phase passes its gates on its own branch, and two parallel phases can still disagree — a signal's sender and receiver, observed failing 22 tests on a merged wave no gate had run on. `defaults.wave_gates: every`, the default, runs a wave's own gates on every wave, so the next wave builds on a passing tree, and every gate of the plan once on the last wave before the plan PR opens; `final` runs the last wave's and any wave whose merge needed a conflict resolution; `off` runs neither. Under `gate_scope: scoped` the full form of a narrowed gate still runs on every wave whatever this says. A red merged tree fails the node that built the wave, as before. A multi-dependency phase's base is a merged tree too: once `prepareBase` builds `integ-<id>`, every command gate its dependencies declare runs on it in full, inside the same hold on the worktree, before the phase starts (`base_gate` steps). They are cached on the merged tree, so a retry on the same base is a hit; red fails the phase in its setup with `BaseGateError`, naming the gate and its log; `defaults.base_gates: off` skips them. A clean base merge used to run nothing, and two dependencies that broke together handed the phase a red tree its own scoped gates never looked at.

**Pausing a parked phase holds it.** `pause` on a node parked on a question (`awaiting_human`) is journalled `held`: no `--retry-after` timer answers it, and the next answer — a person's — releases it. It was `ignored` before while the timer fired anyway, and an unattended retry then checked out a wave branch under an operator's manual repair. Every node operation answers the API with the delivery it journalled.

**A phase that moves lanes takes its branch with it.** `startNode` detaches any sibling worktree of the pool that still has the phase branch checked out — at the commit it is on, touching nothing in its tree — before checking the branch out in the lane that now runs the phase. Git's refusal to check one branch out in two worktrees failed one observed phase thirty-nine times.

**A fix round is bounded, and so is the queue behind it.** A conflict-fixer round that runs past its time limit (twenty minutes by default) is killed and the phase fails with the reason; the prompt tells the fixer to verify only what it touched and that other phases are queued behind the worktree it holds. A node queued behind the integration worktree journals `node_wait` (`queued`, with the holder; `granted` when let in), which `status` and the node view show — a `running` node with no agent used to be indistinguishable from a frozen run.

**What a phase is doing in the worktree is journalled as it happens.** `node_step` records each pipeline state an attempt enters (`implement`, `gate`, `review`, `integrate`, …), with the attempt number, when the state's first effect starts. `integration_step` records each step in the integration worktree as it starts and as it finishes, filed against the node whose turn it is: `hold` for the whole time the node has the worktree, then `merge`, `fix_round`, `verify`, `wave_gate`, `push` and `open_pr` inside it. Each carries identifiers, a round, a wave and a gate log path, never output (§11). A conflict fixer's turn is written to the phase being based or building the wave as well as to the incoming phase, so the phase being watched has the transcript. The node view draws the attempt's steps as a timeline with a clock on the step in progress and each step's log; the run view has an **Integration worktree** panel naming the holder, its step and who is queued; `status` prints each running phase's step and one `integration` line. A step left open by a process that ended is closed `interrupted` at the next `run_resumed` or `run_ended`. Before these, a phase in `integrate` — a merge, a suite on the merged tree, a push, none with an agent — read as frozen for as long as it took.

**A deferred phase waits for a person.** `node.deferred` carries the plan's reason — a soak window, typically. When its dependencies are done the scheduler parks it on a question naming that reason instead of dispatching it; `start` releases it, `stop` fails it with the reason and blocks its dependents. No timer answers it.

**An interrupted run leaves nothing running.** A signal (`SIGHUP`, `SIGINT`, `SIGTERM`) to the job kills every live turn and gate, the fix round in progress and any merge of its own standing in the integration worktree, and ends the run `interrupted` — a `RunStatus` of its own, resumable. The daemon's close is bounded so a browser socket cannot hold the exiting process open.

**A setup failure that repeats is not retried unattended.** A phase that fails before any agent ran — the lane recycle, the branch cut, the base merge — twice in a row on the same line is failing deterministically, and `--retry-after`'s self-answer is withheld for it. The question still waits for a person; it says why.

**`project.env_files` reaches adopted and recreated lanes.** A resume gives each lane every declared file it lacks and never overwrites one it has, and the pool takes the amended `project` block (`adoptProject`) so a single-use lane re-provisioned mid-run reads the list as amended rather than as loaded at job start. A compose-delivered database whose service is in `compose.publish` also gets `<connection_url_var>_HOST`, the same URL on the lane's published host port. `doctor` fails a declared file that is missing from the checkout and warns, by name, when a gitignored file has a tracked example (`.env.example`, `settings/local.py.example`) and nothing declares it.

**Seeds and fixtures are the project's, never ours.** `vinta-ai-maestro` runs whatever seed command the project already has, recorded during worktree provisioning; it ships no fixture set and makes no assumption about what a fresh database should contain. The one exception is `vinta-ai-maestro`'s own test suite, which needs a small fixture repository to run its contract and E2E tests against (§14, O2) — that fixture exists to test the daemon, and is never presented to users as a template.

Sandbox denies the whole pool root and allows back only the running lane, so an agent cannot write into a sibling lane that is mid-implementation.

**`vinta-ai-maestro` resolves from inside every lane.** The daemon writes a launcher for itself — the Node it runs under, its flags, its own entry — into `.vinta-ai-maestro/bin/` on every run start and puts that directory first on the agents' `PATH`. However maestro was installed (a project devDependency reached through `node_modules/.bin`, `npx`, a checkout alias), `with` and `gate` resolve to the same build the daemon is.

**An agent's leases and gates belong to its session.** `with <pool> -- <cmd>` takes a renewable lease on a semaphore through the daemon's `POST /leases`, and `gate <id>` asks the daemon to run a declared gate, which takes the gate's pools itself. Both wait in hops: a `202` is "come back", and a lease wait keeps its place in the queue through a `waitToken`. Four rules sit on top:

- **A gate is never run inside `with`.** `with test-suite -- vinta-ai-maestro gate test`, where `test` requires `test-suite` at capacity 1, held the only slot while the gate queued for it, and every lane's gates queued behind the pair for 55 minutes. The guard (§18.4) refuses the line, and the gate broker refuses any gate whose `requires` the asking node already holds through `with` (`holds_required:<pool>`, with the holding lease's process id). It refuses rather than making leases re-entrant: a gate holding its own pools is what tells the other lanes they are not sharing them. `gate_needs_lane` is the same refusal for the node's lane.
- **A waiter is told who holds what it waits for.** A queued answer carries `holders`: the node, its lane, and how it holds the pool — `with` (with the process id the client sent), `gate` (a gate an agent asked for, running), or `gate_step` (the phase's own gate step, from the scheduler's lease rows). The CLIs print it, and say so when the holder is the asking phase. A gate's `202` also says `queued` or `running`.
- **Each agent session has a turn id.** The scheduler mints one per task it builds and puts it in the agent's environment as `VINTA_AI_MAESTRO_TURN_ID`, beside the node id; `with` and `gate` send it with every request. When the session's stream drains, the lease broker releases every lease that turn holds and cancels its queued waits, and the gate broker takes that turn's queued gates out of the pool queue. A gate already running is left to finish, because its result is cached. Requests carrying an ended turn are refused `turn_ended`, and requests for a node that is not `running` are refused `holder_not_running`. Adapters cancel the background work they track at the end of a session (§7), but a command backgrounded with a shell `&` is reparented, and before this it kept its place in the queue for as long as it lived: one run had nine such waiters, up to 55 minutes old. The turn id is per session, not per model turn: on a `backgroundWork` harness one session spans several turns, and a command it backgrounded legitimately outlives each of them.
- **A draining run answers its waiters** (§9.3). There is no maximum queue wait: the turn id and the node-status check cover the clients that have nobody to answer to, and a cap would also cut off a legitimate wait behind a long suite.

**A phase with no gates is refused unless the plan says so.** A node that resolves to an empty `gates` list passes its gate step without running anything. `validate` (and the review page) report it as an issue, and `doctor` warns naming the phases, unless `defaults.allow_ungated_phases: true`. The run itself still loads such a workflow — a snapshot that ran yesterday loads today — which is why the check lives in `validate`, where `plan-feature` runs it, and not in `parseWorkflow`.

**Two parallel phases adding migrations to one app are warned about, not refused.** `validate` and the review page list `warnings` apart from issues; they never change `validate`'s exit code or the page's `valid`. The one warning today: two phases neither of which depends on the other, directly or through another, whose `touches` both reach into the same migrations directory (Django's `<app>/migrations/`, Alembic's `…/versions/`, Rails' `db/migrate/`, Prisma's `prisma/migrations/`). Each starts from the same latest migration, so the merged tree has two leaves or two heads and fails its gates. The files differ, so no same-path check sees it. Observed as a wave whose integration failed on Django's "Conflicting migrations detected". A plan may keep the pair parallel and have the merge migration written at integration; the warning asks it to decide.

**A conflict fixer the harness refuses is backpressure.** The fixer spawns outside admission control; its refusal (`ConflictFixerRefused`) is handed to admission after the fact exactly as a window closing mid-turn is, so a plan limit parks the phase on the harness's wait instead of failing it and retrying on a timer. The merge it was handed is abandoned first, so the worktree is clean for the retry.

**Gate runner.** Gates are declarative (`cmd`, `requires`, `timeout_s`), run in the node's lane, stream output to `gates/<id>.log`, and report an exit code. A gate is not an agent — no LLM is involved — which is exactly why it can be queued behind a capacity limit without wasting a model turn.

**Chores.** The other thing a phase runs, and the inverse of a gate in every respect that matters: an agent turn rather than a shell command, one that *changes* the tree rather than judging it, and one that is never allowed to decide whether a phase merges. Declared per workflow (`chores.<id>`) and selected per phase — `defaults.chores` for the run, `node.chores` for the exception, where a list replaces the default rather than adding to it and `[]` is how one phase opts out. Each runs as its own turn on the session slot it names, `main` by default, so the agent that wrote the diff is the one asked to act on it.

They are a separate registry rather than a second kind of gate because sharing one would be wrong three ways: a chore invalidates the gate cache key (§13.4) by running, it contends for a harness slot rather than a `test-suite` pool, and it must not be the thing standing between a phase and its merge. A chore that fails is journalled and the phase continues to its gates; `on_failure: 'fail'` is for one the phase is not correct without. A capacity refusal skips it for the same reason — re-driving a finished phase to fit in a polish turn costs more than the polish is worth.

**Integration.** Branch topology follows dependencies, not plan order: no dependencies cuts from `base_branch`; exactly one cuts from that node's branch; several cut from an `integ-<id>` merge of them, merged in `depends_on` declaration order so the result is deterministic and derivable from the node alone. `wave-0` *is* the run's plan branch (`plan/<id>/base`, §18.2), which starts at `base_branch`; each later wave merges into `wave-<N>`, merging the plan branch's newer commits first. Every pull request still targets `base_branch`. Merge conflicts are handed to a conflict-fixer agent in the dedicated integration worktree and re-enter the gate.

**A branch the integrator can build on is kept.** `prepareBase` and `mergeWave` both reuse an existing `integ-<id>` or `wave-<N>` when it still contains the branch it was cut from (the first dependency; `wave-<N-1>`) and every merge made on it since brought in work that is still in some member's current tip, or in the plan branch. They then merge only the members it lacks. That is what lets a conflict the fixer could not settle be finished by hand: concluded with `git commit`, it survives the next attempt, along with anything merged on top. `mergeWave` used to `checkout -B wave-<N> wave-<N-1>` and merge every member again, which threw the resolution away and brought the conflict back on every attempt. A member redone after it was merged (its old commits in the branch, no longer in the member) fails the check, and the branch is rebuilt.

**`verify` names what is red.** The outer gate on a merged tree returns the failing gate's id, exit code and log path (`nodes/_integration/gates/<gate>.log`). The next fix round is told which gate failed and where its output is. Two phases can each be right alone and wrong together — two migrations on one parent need a merge migration — and only the gate shows it. When the last round ends on a red gate, the phase fails with `IntegrationVerifyError` (a subclass of `UnresolvedConflictError`, handled the same way), which names the gate and its log. "Still conflicts after 2 fix rounds" over an empty path list used to send operators looking for a conflict that was a test.

**A merge git stopped with nothing unmerged reaches no fixer by itself.** `rerere.autoupdate` replays a recorded resolution and stages it, and a `pre-merge-commit` or `commit-msg` hook can refuse merged code; either way `git merge` exits non-zero with `MERGE_HEAD` in place and no unmerged path. With no conflict markers in the paths both sides changed, it goes to `verify` and is committed, recorded as resolved in 0 rounds. Only a red gate sends it to the fixer, with that gate. Without `MERGE_HEAD`, git refused before merging anything (an untracked file in the way), and its own error fails the phase.

**Every branch a plan lands through has a PR** — under `defaults.pull_requests: phase`, the default. Under `plan` the run opens the plan PR alone, from the `open_pr` of the node that built the last wave; no phase or integration PR opens, the plan PR's body lists no review units, and `after_pr` chores are skipped because there is no phase PR to be about. Under `phase`, three kinds, all opened by `open_pr` and journalled whether or not they opened (`node_pr` with `kind`, and `run_pr`):

- **Phase PR** — the node's branch into its computed base. The review unit.
- **Integration PR** — a multi-dependency node's `integ-<id>` into `base_branch`, opened by that node just before its phase PR. Without it the phase PR targets a branch nothing targets, and no stack containing a multi-dependency node reaches `base_branch`.
- **Plan PR** — the final wave branch into `base_branch`, opened by the `open_pr` of the node whose `git_merge` built that wave (after its own phase PR, so the body can list it). The body lists every PR above in a merge order that works. It is the only PR carrying the conflict resolutions between sibling nodes that no later node depends on both of, so it is merged last whether the plan lands in one merge or phase by phase.

Every wave branch is pushed after its merge. A `gh` refusal saying the head already has a PR is recorded as opened, with that PR's URL, so a retried phase or a resumed run does not report a failure for a PR that exists.

A conflict surviving its fixer-round budget is reported as a plan defect — two same-wave nodes own the same code — naming **both** nodes and the contested paths, and the conflicted merge is left in place because it is the only copy of what the fixer attempted. A person who finishes it there and commits keeps it for the retry; one still unfinished when the phase is retried is the run's own merge, so the retry keeps it under `refs/vinta-ai-maestro/abandoned/` and starts the merge over rather than refusing the worktree on every attempt. **That budget is an integration-level setting (default 2), not either node's `max_fix_rounds`**: a conflict belongs to a pair of nodes, so deriving it from one would make the answer depend on which node happened to merge second.

**A resolved conflict is confirmed by scanning the files, never by asking git.** `git add` clears a path's unmerged flag whether or not conflict markers remain in it, so git's index cannot answer "did the fixer actually fix it". Without the scan, a fixer that did nothing produces a merge commit full of markers that passes into the wave branch unnoticed.

---

## 9. Interaction model

Five operations on a running node, exposed in the UI and over the API:

| Operation | Mechanism |
|---|---|
| Add context | `session.send(text)` where `capabilities.inject`; otherwise queued and delivered on the next resume. Either way it is also kept as a decision of the phase (§16.4), so a later session gets it too |
| Redirect | interrupt, then send the new instruction (or resume with an amended prompt) |
| Pause | finish the current turn, then `await_human` (§9.1). On a node already parked on a question, hold it: no `--retry-after` timer answers it |
| Resume | undo Pause: withdraw a pause not yet taken, release the phase parked on it, or give a held phase its timer back, a full interval from now. Its own verb (`node resume`), because answering the synthesized "Resume it?" was undocumented and releasing a hold meant answering the question by hand. `status` shows each open question with its choices |
| Abort node | kill the session; mark failed; dependents blocked. A run with nothing else left to run stays up for the node's retry |
| Take over | interrupt → PTY attach → detach → resume headless |

**An abort is a decision about one attempt, not about the run.** The usual next step is `retry`, often after a fix in between, and `retry` needs a run still in flight. A run whose last runnable phase was aborted — every other pending phase depending on it — used to settle in the same turn and end `failed`, and the retry sent a moment later was refused as `run has ended`. So aborted nodes hold the run open, the way `--on-failure retry` holds a failure on its question: the node stays `failed`, its dependents `blocked`, and nothing answers for the operator — the abort was a person's, so no `--retry-after` timer retries it. `node retry` releases it; `pause` or `stop` on the run ends it as that halt. Under `--on-failure stop` an abort ends the run like any other failure, since nobody is there to retry it. A retry sent while the aborted attempt is still unwinding is applied as that attempt leaves, so the two never overlap.

**`fresh` drops a node's agent session without failing the attempt** (`node fresh`, `POST …/nodes/:node/fresh`). The session ledger — every slot, and a takeover's staged id — is cleared, and the node's next turn starts cold with the whole brief, journalled `node_session` `reason: operator_fresh` (§15). It is the way out of a session gone wrong — an agent replaying work its last process was killed under, or carrying on with the phase before — that used to cost an abort. It does not stop the turn in flight, which would move the pipeline on with whatever that turn left; `redirect` is what ends a turn now. An answer to an agent's own question still resumes the session that asked; the turn after it is the cold one. On a settled node it is `ignored`: there is no next turn, and a retry is cold anyway.

### 9.1 Human gates and notifications

A run that executes unattended for hours must be able to say when it stopped being unattended. `await_human` is therefore a **question with an answer**, not a bare pause flag:

```ts
{ question: string
  kind: 'confirm' | 'choice' | 'text'
  choices?: string[]
  context?: { diffRef?: string; gateLogRef?: string; transcriptCursor?: number } }
```

The answer is journaled as an event and enters the pipeline's guard context as `human.answer`, so a pipeline can branch on it exactly like it branches on a review verdict.

**Answered from the UI.** The node view renders the question inline with its context — the diff, the failing gate log, the transcript position it paused at — so the operator decides without leaving the page or opening a terminal. Answering resumes the node in place.

**Notified on both channels.** The browser Notification API covers the case where the UI is open in a background tab; an OS notification from the daemon covers the case where it is closed entirely. Both fire, because neither alone is sufficient and the failure mode of missing one is a lane sitting idle for hours. The same channel carries gate-failed and run-finished.

Delivery is **once per pause**. Reminders for an unanswered gate are **off by default**, with an opt-in interval: a system that nags gets trained out of attention, and the cost of staying quiet is bounded because the run view already shows the pause plainly. Delivery survives a daemon restart without re-firing — it is journaled alongside the pause, not held in memory.

**The agent can ask too.** Everything above is a question the *pipeline* asks. An agent in the middle of a phase also hits decisions it should not make alone, such as an ambiguous requirement, a dependency whose license is unclear, or a change outside its phase. Headless, its harness's own question tool reaches nobody, and a question written into its report reads as a finished turn. So the implementer prompt teaches the protocol the shipped skills use: commit what is done, then end the turn with a `status: NEEDS_INPUT` block. Its `questions:` list gives each question a header, the question itself, and two to four options with descriptions. The scheduler reads every turn as it drains (`src/questions`), and takes either that block or a question tool call (`AskUserQuestion`, `question`, `request_user_input`) that was the agent's last act. When it finds one, it parks the node on a `kind: 'agent'` question:

- **The questions live in the transcript, not the journal.** They are agent prose (§11). The `human_question` row carries a fixed sentence and an effect id. An `agent_question` transcript entry with that id carries the questions, and the node endpoint reads it back as `question.ask`.
- **The node view renders them as a card to click.** Each option is a button with its consequence under it and the recommended one marked. The last choice is always **Other**, a text field for an answer no option covers. On a single-choice question it is exclusive, since the agent should get one answer and not an option with a sentence that may contradict it. The daemon applies the same rule when it decodes an answer. On a multi-choice question Other is one more box to tick. A single single-choice question answers on the click. Several questions are a wizard: one step per question, then a review step, then Send.
- **The answer resumes the same session.** It is journalled as option indices plus the operator's own words. It reaches the agent as one message that restates each question with its answer, and is recorded in the transcript as the operator's. The effect that spawned the turn returns only once the agent ends a session without asking, so the pipeline's guards read the work the answer led to.
- **An unattended run answers itself.** Under `--retry-after` it picks each question's recommended option after the interval, and the row is marked `unattended`, as a plan question's `unattended_answer` is.
- **The answer outlives the session.** The message reaches only the session that asked, so each answered question is also kept as a decision of the phase, marked as the operator's, the coordinator's or unattended (§16.4), and every later prompt carries it.
- **A harness that cannot resume** has no way to deliver an answer. Its question stays in the transcript and the turn ends as it would have.

**A paused node keeps its lane** and releases its gate resources immediately. This resolves O3: the human is being asked about work in progress *in that lane*, the diff and log views read from it, and a takeover attaches to it. Releasing it would destroy the thing the question is about. Idle disk is the cheapest resource in the system; the gate slot, which is the expensive one, is freed at once.

**Amending a live run.** Editing the workflow while a run is in flight is not a live mutation of the snapshot. It produces an amendment applied at a safe point: nodes not yet started take the change immediately; nodes already `done` whose dependency closure changed are rebased in topological order, `integ-` bases rebuilt first. Amending is **refused while any node it blocks is running** — matching the rule `amend-plan` already states.

*Blocks*, rather than *affects*, and the difference is one kind wide. A node's harness, model, pipeline, body and base are all read at a moment — its spawn, its brief, the cut of its branch — and none of them can move under a turn that has already started, so an amendment touching any of them is refused exactly as before. A gate's **command** has no such moment: the scheduler, the effect executor and the agent-gate broker each resolve it per gate run and each take an amendment, so a running node's next gate runs the new command with no stale window and no completed work invalidated. That is the one change a live node may take, and it is what makes a mis-tuned run fixable without discarding it.

Two consequences worth stating, because both are load-bearing:

- The set the refusal reads closes over transitive dependents only where a **base** moved. A gate command moves no base, so nothing downstream of a node that declares it is blocked by the change. The wider "who does this reach" set is still computed and still journalled — it is the audit record, not the safety gate.
- Changing **which gates a node declares** is not a gate-table change. A phase that gained a gate mid-flight would finish without ever running it and settle `done` against a definition it never satisfied, so a node's declared gate list is part of its body and blocks like the rest of it.

**An amendment reaches every object that reads the plan, and the wave merge is pinned against it.** The scheduler, the effect executor, the agent-gate broker and the integrator all take an amended workflow; a run whose definition moved in some of them and not others is worse than one where it moved in none, because the halves disagree silently. The case that forces this is a phase nobody depends on: it blocks nothing, so it lands freely beside its future wave-mates, and the wave it joins has to be the same set on both sides of the decision.

So a wave's membership is decided **once**, synchronously, by the code that decides the wave is complete, and handed to the merge. A wave merge runs behind the integration worktree's queue and an amendment can land between the decision and the execution; a merge that re-derived its own membership would merge a phase that never ran, or count one as arrived and then leave it out. §9's rebase runs in that same worktree and through that same queue, since "the nodes this amendment blocks are idle" says nothing about whether another wave's merge is in flight in that directory.

### 9.2 The run coordinator

A run goes wrong in ways nobody needs to be paged for and somebody needs to act on: an agent looping on a database its lane cannot reach, a phase queued for an hour behind a fix round that hung, an `env_files` entry nobody declared, a gate command missing its reuse flag, an error maestro logged about itself at three in the morning. Each used to wait for a person to happen to look. The first answer to that was a monitor that could read the run and propose four kinds of tuning; an operator found it "sort of useless", because it could explain the problem and do nothing about it, and nothing woke it when maestro itself failed.

So every run has a **coordinator**: one agent, built once per run (`cli/serve.ts`'s factory) and the same one the operator talks to in the run view. It does not orchestrate — the scheduler dispatches, the integrator merges, the gates decide — it watches, fixes what is wrong around the agents, and tunes how the run executes.

**It is woken** (`coordinator/loop.ts`, every 30 s) by: a phase that failed, an attempt that errored, a fix loop that stalled on a gate (§13.4), an error maestro logged about itself (the job's logger is tapped, `coordinator/errors.ts`), a phase queued behind the integration worktree for 20 minutes, a phase running for an hour, a gate whose uncached runs have cost more than 15 minutes for each phase that ran it (never less than 30 minutes; a gate with no scoped form under `gate_scope: scoped` is named as such in the wake). Each trigger is told once; a burst is one wake; two wakes are at least two minutes apart; a run wakes it at most 24 times. History before the loop started is not news. Every wake is journalled as `coordinator_woke` with the triggers' kinds and ids; what it read and did is in its conversation. `--no-coordinator` (formerly `--no-intervene`) turns the wakes off; the operator can still ask it things.

**It acts through the run's own API, with its own token.** The job's daemon mints a second token for it (`Daemon.coordinatorToken`), and its session's environment carries that token, the job's URL, the run id and the launcher on `PATH`. From its shell it drives the same commands an operator has: `node context|redirect|pause|abort|retry|fresh|answer`, `workflow` and `amend`, `gate-cache invalidate` (§13.4), and `exec <lane|integration> -- <cmd>`, which runs a command in that worktree with its environment and, in the integration worktree, holds the worktree's queue until it exits. (`node resume` is the operator's only: what the operator paused, the coordinator cannot release.) `exec` takes a lane's full name, its name without the `<run-id>-` prefix, or the id of the phase running in it, and a refusal lists the run's targets. The command gets a lease holder and a turn of its own, so `with` and `gate` work inside it: it holds as the phase running in the lane, so a gate is that phase's, or as `exec:<target>` on a lane no phase is in, accepted only while the command runs. Its leases and queued waits end with it. Every request with its token is attributed to it — `node_operation.by`, `human_answered.by`, `workflow_amended.author: coordinator`, `workspace_exec.by` — and steering text reaches the agent prefixed "From the run coordinator:".

**What it may not do is refused where the request lands**, never merely discouraged:

- **What the plan builds is the operator's.** An amendment from the coordinator that adds or removes a phase, changes dependencies, a brief, touches, the base branch, a pipeline, chores, the plan documents or a deferred phase's condition is refused `coordinator_forbidden` (`coordinator/policy.ts`).
- **A check may only get stricter.** No gate or chore dropped from a phase or the defaults, no gate definition removed, no judge gate edited, `tuning` untouched, `hooks` unchanged, `allow_ungated_phases` never turned on, `gate_scope` never narrowed, `wave_gates` never lowered. A gate's command may only gain tokens, in order, from its own `tuning.allowed_flags` — a list a person wrote in a committed file; a gate with no `tuning` block is not tunable. Shell metacharacters make a command untunable, because "plus new tokens" says nothing true about a pipeline.
- **It answers only what a timer could.** A question is the coordinator's to answer exactly when `--retry-after` could answer it — a failure's retry/stop (including one whose timer was withheld for a repeating setup failure, which is what it is woken to fix), an agent's own questions, a plan question with an `unattended_answer`, a refused merge commit. A deferred start, a plan's human gate, an operator's pause, a harness login and any question the operator is holding (§9's pause) are refused.
- **It cannot end the run**: `pause` and `stop` of the run, and editor saves of the workflow documents, are refused for its token.

What remains is *how* the run executes — models, harnesses and the crew, fix budgets, gate timeouts and pools, resources, the `project` block's environment, model fallbacks, `wave_gates` upward — and the run's environment itself, through `exec`. Those can make a run slower or dearer when set wrongly; none of them can make a failing check pass.

The post-mortem scores the coordinator's amendments as it scored the monitor's (`interventions`), pointing at its conversation for the reasoning.

### 9.4 After the run: landing, carrying fixes forward, cleaning up

**One PR lands the plan.** A run opens a PR per phase, one per `integ-<id>` branch and one for the plan — the final wave branch into `base_branch`. Only the plan PR carries every phase with every conflict resolved once; the others are review units, and every one of them says so in a **Landing** section, naming the plan's head branch and `vinta-ai-maestro land <run> --close`. The plan PR says to merge it, with a merge commit, and no other. A phase PR also says which phases in its wave or earlier its base leaves out — its CI runs without them, so a failure in their area is not its own. An observed landing of 36 PRs with none of this resolved the same conflicts several times by hand; two resolutions were wrong.

**`land <run>`** lists the plan PR and every review PR with its state, and marks a review PR as landed when every commit it adds is a merge whose parents the base already has — what GitHub's "Update branch" on a landed phase looks like. `--close` closes exactly those, with a comment saying they landed.

**`propagate <run> <phase>`** carries new commits on a phase branch — a fix found after the run — into every `integ-*` and `wave-*` branch that contains the phase (read from git: the branch shares a commit of the phase's own). Integration branches take the phase; waves keep their chain, the lowest one taking the phase and each above it the wave below. A scratch worktree, merge commits only, a conflict stops it with the branch left as it was, `--dry-run` shows the merges, and it refuses a live run.

**A run that ends `done` stops its compose stacks** — `docker compose down` in every lane and the integration worktree, volumes kept — journals `stacks_stopped`, and prints the commands that remove the rest (`purge <run> --lanes`, `docker compose -p <project> down -v`). A failed run keeps them: it is resumable, and they are what someone debugging it needs. `status` and `doctor` list what runs that are over (`done`, `cancelled`) left behind — stacks still running, lane worktrees, live job processes — each with its command.

**`purge` never ends a run nobody named.** A lane belongs to the known run whose id is the longest prefix of its name (`<run>-lane-N`, `<run>-integ`, `<run>-crew-…`); one matching no known run belongs to a run already purged. A run whose job is alive is kept whole — directory, lanes, summaries — even when named and under `--force`. A run that `run --resume` would accept (paused, failed, interrupted: `isResumable`) is kept whole by a purge that does not name it; naming it, or `--force`, purges it, which ends it. Before this, `purge --lanes` filtered lanes by name alone, and a bulk purge removed a paused run's lanes and integration worktree out from under its resume.

**`purge --lanes` undoes a lane, not just its worktree.** Each reaped lane's summary is its teardown manifest, and `lanes/teardown.ts` plans from it, in order: `docker compose -p <project> down` (volumes kept) where the lane had a compose file, `docker volume rm --force` for each `forked_volumes` entry, the `reset_cmd` of each service slice whose namespace is the lane's own name, and `dropdb --if-exists` (or the project's `dropdb_cmd`, with `serverFlags`) for each forked Postgres database. Only what is provably the lane's: a database is dropped only when its recorded name is the one `planDatabase` derives for that lane from the run's frozen `project` block — so never a compose-delivered database, which records the main checkout's name, and never when the snapshot is gone — and an `index` service slot, which the next run's lane in that position uses, is never reset. Whatever is left is listed with the reason. A summary whose worktree is gone is reaped the same way when it records its own lane-root path (or, for a bare compose override, starts with the pool's `GENERATED` header); summaries `prepare-worktree` wrote for worktrees a person made are never matched. Every command is printed before anything runs, and `--dry-run` stops there; a service's `reset_cmd` is printed as `reset service <id> namespace <ns>`, never verbatim, since it is the project's text and may carry a credential. A failed step is reported and does not stop the rest; it keeps that lane's summary, so a rerun retries from the same manifest.

**The post-mortem reads the journal, not the host's memory.** `wave_conflicts` comes from `node_conflict` rows, base merges included (`where`); new findings `failure_causes` (failed attempts grouped by reason, setup failures apart), `crew_substitutions` (with tier, model and the phase's cost), `operations` (amendments by any author, steering, questions and who answered them, `exec` runs) and `cross_phase_failures` (wave gates red on a merged tree). An observed post-mortem reported no conflicts, no interventions and no dependencies against 16 conflicts, 3 amendments, 485 failed attempts and 861 questions in its journal.

**Crew substitution is capped** (`defaults.substitution`, default `up_one_tier`): a busy member's phase may go to the next tier up the roster has, and a warm session moves a phase only within its tier unless the setting is `any`. Every substitution carries `planned_tier`, and `status`, the run view and the post-mortem show the ones that ran above plan. One run had moved 73 phases up a tier, 23 of them onto a member whose limited credits then ran out.

**A busy member is replaced, not borrowed** (`defaults.max_spare_crew`, default 2). When the member a phase is planned for — or the member an operator picked with `retry with <member>` — is busy, or is planned for a phase still to come, the scheduler does not borrow a member another pending phase is planned for, and does not wait: it takes on a spare in the target's image (same tier, model and harness), provisions a worktree for it (`LanePool.addLane`, from the run's templates, on a slot after the integration worktree's), grows the `lane` pool by one, and journals `node_crew` with `reason: spare_crew`. A member no pending phase is planned for is still borrowed, and an idle spare is reused before another is taken on. A spare stays for the run, is never planned for, and covers its tier like anyone else. A member busy only with a landed phase's `after_pr` chores is waited for: a warm session is worth a short wait. A provisioning that fails stops spares for the rest of the run, and staffing falls back to covering and waiting. `0`, or a host that injected its own lanes, keeps the roster to the plan's. One run left a phase on its critical path idle for 17 minutes while a retry held the member it was planned for.

### 9.3 Ending a run early

Two operations on a run as a whole, beside §9's five on a node, and both are journalled as how the run ended — `run_ended` carries `paused` or `cancelled`:

| Operation | Mechanism | Ends | Resumable |
|---|---|---|---|
| Pause | no new dispatch; every running node stops at its next piece of work; nothing killed | `paused` | yes |
| Stop | every live agent session and running gate killed, then the same drain | `cancelled` | no |

**Draining is the whole design of pause.** The scheduler stops dispatching, and the effect door — the one place every agent turn, gate, chore and question starts — is shut. A step already in flight runs to its end, and the pipeline keeps evaluating transitions until it reaches its next effect, so a phase whose last turn just finished still settles `done`. Everything else is unwound where it waits: a node parked on a question is woken, one waiting on capacity or a lane is released, and each unwound node goes back to `pending`, which is what a resume would make of it anyway. Its lane stays, with whatever the step left in it. The run ends when no node body is still executing, and the job exits.

**A turn waiting on a lease is told to end.** An agent turn blocked in `with` or `gate` behind a semaphore never reaches a step boundary by itself, so a pause used to wait on it forever. Before the scheduler drains, the halt answers every queued lease wait and every queued agent gate with `409 run_pausing` (`run_stopping` for stop) and refuses new ones. The CLIs tell the agent to end its turn and report where it got to, and the end of the turn is the boundary. Nothing is lost: the phase goes back to `pending` and its next attempt runs the command again. Leases already granted and gates already running are steps in flight and finish. The halt logs each node the drain is waiting on and what it is doing (`agent_turn`, `gate`, `question`, or `step`), and `POST /pause` answers with the same list (`waitingOn`), which `vinta-ai-maestro pause` prints.

**Stop is the kill, then the same drain, bounded.** A killed turn is not let reach a transition: a guard reading it would record a failure that never happened. The drain is as quick as the slowest effect noticing its process died, so the job bounds it, and past the bound writes `cancelled` itself. A gate leads its own process group, so the gate runner keeps a registry of live gates for this; nothing else would end one.

**A run with no job.** A `running` row whose job is gone is a run whose host died. There is nothing to drain, so pause refuses — it is already as resumable as a pause would leave it — and stop writes `cancelled` directly. A job that is alive but will not answer is the one case stop ends from outside: signalled, then killed, with the cancellation written afterwards.

Pause is upgradeable to stop; the reverse is ignored. A run whose last node settles in the same turn it is halted ends as what it actually was. A paused run writes no post-mortem: it has not ended in the sense §13.6 means.

---

## 10. UI

React + Vite, served by `vinta-ai-maestro ui` at `127.0.0.1` behind a random token in the URL, minted when `ui` starts. `ui` hosts no run (§4): a live run's traffic is forwarded to its job, so the views below behave the same whichever process answers them. Chosen for mature `xterm.js` bindings, virtualized log views, and the general ecosystem weight the app shell needs. Both graph surfaces are Web Components and mount unchanged: `vinta-dag-editor` (ours, §3) for the plan DAG, `vinta-state-machine-editor@0.10.0` for pipelines.

| View | Contents |
|---|---|
| Runs | List, status, elapsed, resume/purge |
| Run | Live DAG via `vinta-dag-editor` in read mode — node status colors, wave banding, edges labelled with the dependency artifact. Resource pool meters, the gate queue with positions, and per-harness capacity state (§6.1). Pause and Stop for the whole run (§9.3) while it is running, Stop confirmed inline because it is final. The integration worktree's holder, its step with a clock, and its queue (§8). |
| Node | Transcript (chat-rendered normalized events: markdown prose, tool calls as a verb and a target with their result seated under them, consecutive reads grouped), gate logs, what the phase changed — files with line counts, and a link to the full diff — the steering box, the pending human question with its context (§9.1), and the five operations from §9 The pipeline step a running phase is in, and an Integration timeline of this attempt's steps in the integration worktree, each with its log (§8). |
| Changes | The node's whole diff, full page and linkable (`#/runs/<run>/nodes/<node>/changes`): a sticky file list, unified hunks with syntax highlighting and both line numbers. Served by `GET …/nodes/:nodeId/changes`, which the git unit answers from the lane's working tree while the lane holds the branch — uncommitted work included — and from the branch after that |
| Terminal | `xterm.js` over WebSocket — PTY takeover and raw stream tailing |
| Editor | `vinta-dag-editor` in edit mode (add node, draw dependency, set gates/harness/model) plus `vinta-state-machine-editor` for pipelines |
| Plans | §19's review page for a plan that has not run: the graph coloured by review state, each phase's brief, composed prompts and gates, the plan's markdown, a gate matrix, the projected schedule, comments anchored to any of them, and the conversation with the agent that wrote the plan |
| Logs | The daemon's own log (§13.8) — level, run, node and substring filters, following the tail. Its own section rather than a run panel, because the records worth reading most are the ones with no run to file them under |

The run view and the workflow editor are **the same component in two modes**, which is what keeps them from drifting into two different pictures of the same graph.

Notification permission is requested on first run, not on page load, and from an explicit opt-in in the notification inbox, because some browsers only honour a prompt a click raised. Every notification also lands in that inbox — durable in the browser, shared across tabs, read and cleared by the operator — which is what the UI degrades to when permission is refused. The UI listens to every running run for this, not only the one on screen. The OS-notification channel from the daemon is unaffected either way.

Transport: HTTP for commands and snapshots, one WebSocket for the event stream and PTY bytes. The UI holds no authoritative state — it renders a projection of the journal, so a reload mid-run is free and two browsers can watch the same run.

---

## 11. Security and data handling

- Binds `127.0.0.1` by default. A random token is required on every request including the WebSocket upgrade. `--host` for remote access is explicit, printed with a warning, and never the default.
- **Three tokens, one per kind of caller.** Each daemon mints the operator's token (the URL's, and the only one that opens the WebSocket or is forwarded by `ui` to a run's job), the run coordinator's, and the agents'. Lanes receive the agents' token as `VINTA_AI_MAESTRO_TOKEN`, and it reaches only what a lane calls: `POST`/`PUT`/`DELETE` on `/api/runs/:runId/leases…` (`with`), `POST /api/runs/:runId/gates` (`gate`), and the judge and guard hooks (`/permission`, `/guard`). Every other route answers it `403 agent_forbidden` — the §9 operations, `/amend`, `/exec`, `/pause`, `/stop`, the editor, and the reads. All three are registered with `redactValue`, so none reaches a log.
- **No credentials, ever.** No API keys, no token storage, no login flows. Auth lives entirely in the harness CLIs the user already logged into.
- Transcripts and gate logs contain repository contents verbatim. They stay inside the project under `.vinta-ai-maestro/` (gitignored), never in a global cache directory. `vinta-ai-maestro purge <run-id>` and a documented retention default.
- Structured log fields carry opaque identifiers — run id, node id, session id — never file contents or record data.
- The existing worktree sandbox deny-rules apply per lane, plus the pool-root deny that keeps lanes from writing into each other.

---

## 12. Implementation plan

Steps are phrased as Karpathy's `step → verify` pairs. Dependencies are declared so this plan can itself be run in parallel lanes — which is also the most honest dogfooding test available.

**Wave 1 — foundations (independent)**

| # | Step | Depends on | Verify |
|---|---|---|---|
| 1 | pnpm workspace + `packages/vinta-ai-maestro` and `packages/vinta-dag-editor` skeletons, TS configs, `.gitignore` entry | — | `pnpm -r typecheck` passes; `node vinta-ai-workflows.mjs list` still succeeds; `npm pack --dry-run` at root lists exactly the same files as before |
| 2 | zod types in `src/types.ts` + generated `schemas/workflow.v1.schema.json` at the repo root | — | Generated schema is valid Draft 2020-12 and matches `schemas/README.md`'s conventions; a golden workflow validates; a workflow with a dependency cycle and one with an unknown node id both fail with located errors; a drift check fails when zod and the committed schema disagree |
| 3 | Journal: SQLite event log, projections, run directories | — | Unit tests for append + rebuild; `kill -9` the daemon mid-run and reconstruct identical projected state |
| 4 | Lane manager, delegating to `prepare-worktree` | — | Provision 3 lanes on the fixture repo; assert the template DB is created once and cloned per lane; assert isolated test DBs and `COMPOSE_PROJECT_NAME`s; assert `reset_cmd` restores schema; assert a lane with no `reset_cmd` is re-provisioned rather than reused; assert the N× disk probe refuses rather than half-filling the disk |

**Wave 2 — execution core**

| # | Step | Depends on | Verify |
|---|---|---|---|
| 5 | Harness adapter interface + mock adapter | 2 | Mock drives a scripted event sequence; contract test suite that every real adapter must also pass |
| 6 | `claude-code` adapter | 5 | Contract suite green against a real `claude -p` on the fixture repo; assert inject lands mid-turn, interrupt stops, `--resume` continues |
| 7 | Harness admission control + backpressure (§6.1) | 5 | Simulated `rate_limit` / `concurrency` / `quota` refusals: assert resources are released before waiting, the ceiling halves then recovers, `retryAfter` is honored over backoff, the wait survives a daemon restart without re-firing, and no node is ever marked failed |
| 8 | Resource pools + gate runner | 3 | Property test: capacity never exceeded under randomized arrival; FIFO+aging order holds; fixed-order acquisition proven deadlock-free on the pool set |
| 9 | Pipeline interpreter + effect catalog + guard evaluator | 2, 5 | `standard-phase` driven by the mock through pass, fail→fix→pass, and fix-round-exhausted paths; guard evaluator rejects host access |
| 10 | Scheduler | 7, 8, 9 | Synthetic graphs (chain, diamond, wide fan, disconnected) against the mock: assert dispatch order, containment on failure, correct wave banding, no deadlock — and that a run entirely blocked on harness capacity waits instead of reporting deadlock |

**Wave 3 — surface**

| # | Step | Depends on | Verify |
|---|---|---|---|
| 11 | Daemon HTTP + WS API, token auth | 10 | Contract tests against the zod schemas; unauthenticated request and unauthenticated WS upgrade both rejected |
| 12 | Integration: dependency-derived bases, wave merges, conflict fixer, PR opening | 10, 6 | E2E on the fixture repo with a deliberately conflicting pair: assert base computation per topology rule, `--no-ff` merges, fixer invoked, defect reported after `max_fix_rounds` |
| 13 | `vinta-dag-editor` Web Component | 1 | Vitest suite mirroring `vinta-state-machine-editor`'s conventions: deeply readonly input never mutated, host `data` blob preserved verbatim, auto-layout stable, keyboard navigable, renders with no host catalogs injected |
| 14 | UI shell + run view (DAG, pools, queue, capacity state) | 11, 13 | Playwright against a mock run: DAG reflects every transition; queue positions update; a capacity wait renders as waiting, not error; reload mid-run loses nothing |
| 15 | Node view: transcript, diff, gate logs, steering | 11, 14 | Playwright: inject a message into a live `claude-code` session and assert it appears in the transcript and changes agent behavior |
| 16 | Human gates + notifications (browser + OS) | 11, 15 | `await_human` fires both channels once; the question is answered from the UI and the answer reaches the guard context; a daemon restart re-surfaces the pending question without re-notifying; refused browser permission degrades to the in-page banner |
| 17 | PTY takeover: `node-pty` + `xterm.js` | 6, 15 | Attach, type, detach, resume headless; assert the journal records the takeover and the session id is preserved |

**Wave 4 — breadth**

| # | Step | Depends on | Verify |
|---|---|---|---|
| 18 | `codex` adapter | 5, 7 | Contract suite green; `inject: false` correctly surfaced and the UI degrades to interrupt+resume |
| 19 | `opencode` adapter | 5, 7 | Contract suite green; server lifecycle managed; assert clean shutdown leaves no orphan process |
| 20 | Workflow editor: `vinta-dag-editor` edit mode + `vinta-state-machine-editor` | 13, 14, 2 | Load → edit → save round-trips byte-identically for an untouched workflow; edited pipelines validate |
| 21 | `plan-feature` emits `workflow.json` alongside the plan, unconditionally | 2 | Golden test: a known plan produces a schema-valid workflow whose graph matches the plan's Execution graph table; `validate-skill-md` still passes; a project with no daemon is unaffected by the extra file |
| 22 | Amend-live-run path | 10, 20 | Amend a not-started node mid-run; assert refusal while an affected node is running; assert topological rebase of dependents |

**Wave 5 — leverage (§13)**

| # | Step | Depends on | Verify |
|---|---|---|---|
| 23 | `vinta-ai-maestro doctor` | 4, 6 | On a deliberately broken environment, each of: missing harness, unauthenticated harness, no worktree support, missing `reset_cmd`, insufficient disk is reported with the exact remedy |
| 24 | Dry-run / simulation mode | 10 | A workflow with known durations simulates to a predictable schedule; a workflow whose graph deadlocks is caught without spawning an agent |
| 25 | Gate result caching | 8 | A gate re-run against an unchanged tree hash is skipped; any tree change invalidates; `gate <id> --no-cache` forces and replaces the entry; `gate-cache invalidate` forgets it; a fixer that leaves the tree unchanged gets one fresh rerun, then the phase asks instead of spending another fixer |
| 26 | Cost and token accounting | 6, 3 | Per-node usage aggregates to run totals matching the harnesses' own reported figures |
| 27 | Critical-path and queue analytics | 24, 26 | On a recorded run, the reported critical path matches a hand-computed one; queue-wait and capacity-wait attribution sum to observed elapsed |
| 28 | Run replay | 3, 14 | Scrubbing a finished run reproduces every intermediate DAG state from the journal alone |
| 29 | Plan post-mortem → `plan-feature` | 27, 21 | A run with a known undeclared dependency and a known same-wave file conflict produces a post-mortem naming both |

**Wave 6 — polish and release (macOS + Linux)**

| # | Step | Depends on | Verify |
|---|---|---|---|
| 30 | Docs, `vinta-ai-maestro purge`, retention defaults, CHANGELOG, UI polish pass | all | `README` walkthrough reproduces a two-phase parallel run end to end on the fixture repo, from `plan-feature` output to merged wave branch |

**Wave 7 — Windows**

| # | Step | Depends on | Verify |
|---|---|---|---|
| 31 | Windows support | 30 | The full suite — contract, E2E, Playwright — green on Windows; lane isolation, `node-pty`, and compose project naming verified natively |

Wave 1 is four independent lanes. The critical path runs 2 → 5 → 6 → 7 → 10 → 11 → 15 → 16.

**Steps the plan missed, discovered while building it.** Each was found by a unit failing to be buildable without it, which is the point of pairing every step with a verification:

| # | Step | Why the plan missed it |
|---|---|---|
| 10b | **Live session registry + the four §9 operations.** The scheduler must keep an `AgentSession` handle per running node so add-context, redirect, pause and abort can reach it. | §9 lists the operations and §7 gives `AgentSession` the methods, so the capability looked present. Nothing said *who holds the handle*, and the answer is the scheduler — the only component that knows a node is running. Until this exists the daemon can only return 409 for four of five operations. |
| 10c | **Human-gate question in the journal.** An event variant carrying `{question, kind, choices, context}` and its answer. | §9.1 promises the pause "is journaled alongside the pause" and survives a restart. The event union is closed and no variant's payload could carry it, so the promise was unimplementable as written. |
| 29b | **CLI entrypoint.** `bin`, argv parsing, and subcommands for `doctor`, `run`, `simulate`, `serve`, `purge`. | Every step produced a library surface and assumed a CLI existed to call it. None does — `runDoctor` returns an exit code nobody passes to `process.exit`, and `--host` (§11) has no flag to be. |

Two smaller gaps are recorded rather than scheduled, because both are one-line additions to a module whose owner should make them: `ResourcePools` publishes an aggregate `waiting` count with no per-waiter identity, so §10's "gate queue **with positions**" cannot be served as specified; and `Journal` has no `runs()` listing, so §10's Runs view cannot show historical runs after a daemon restart.

Wave 7 is gated on Wave 6 by explicit decision: Windows starts only once every requirement is working, tested and polished on macOS and Linux.

---

## 13. Additions

Proposed rather than requested. Each is here because it is cheap given the architecture already specified and pays for itself in the product's own terms; none is speculative flexibility.

**13.1 Dry-run / simulation mode.** Run the scheduler end to end against a mock adapter that only sleeps, using per-node duration estimates. Validates the graph, the resource sizing and the projected wall clock before a single model turn is spent. This is the step-9 test harness exposed as a product feature, so its marginal cost is a CLI flag and a UI button. It is also the honest way to answer "should `max_parallel_lanes` be 3 or 6 on this plan" without paying to find out.

Estimates are per **agent turn**, not per node — `standard-phase` spawns at least two on the clean path. The critical path is derived by walking the *observed* schedule backwards rather than by finding the longest path by duration, so a chain made long by queueing shows up as the critical path it actually was.

Three limits the projection must state rather than let a reader assume:

- **It cannot predict an agent's turn length.** It answers "given these durations, what schedule follows" — not "how long will this take".
- **Harness concurrency ceilings are not modelled.** Admission control releases its slot when the session stream drains, and a mock session drains instantly, so the only constraints a projection applies are the workflow's own pools. A run that would be throttled by a vendor limit projects as if it were not.
- ~~Pool aging is not exercised.~~ **Closed.** `ResourcePools` now takes an optional `now` and defaults to the system clock, so a virtual-clock consumer reaches the aging bypass rather than silently running strict FIFO and reporting a schedule the real pool would not produce.

A dry run also creates and deletes a throwaway journal, because `Journal` is mandatory and disk-backed. A feature defined by having no side effects should not need one; an in-memory journal would remove the last of them.

**13.2 Run replay.** The journal is already append-only and the UI already renders a projection of it, so scrubbing a finished run back through its DAG states is a slider over `events` — near-free. It is the difference between "the run failed" and "here is the minute it went wrong", and it is how a reviewer understands what happened without reading four transcripts.

**13.3 Critical-path and queue analytics.** After a run, attribute the elapsed time: which nodes formed the critical path, how long each spent queued on `test-suite` versus actually running, how often lanes sat idle. This closes the loop on the entire premise of the project — parallelism is a wall-clock claim, and without measurement it stays a claim. It is also what tells you whether the gate capacity or the lane count is the real constraint, which is not guessable.

**13.4 Gate result caching.** Key a gate result on `(gate id, git tree hash of the lane, a hash of the gate's definition)`. The definition is in the key because §9's amend can move `gates[id]` under a live run while the id it moves under stays the same — `retune_gate` rewrites `cmd`, `retime_gate` rewrites `timeout_s`, and an operator's or external agent's amendment can rewrite any of it — so an unchanged tree would otherwise be served the previous definition's verdict, and the one amendment whose purpose is to change what a gate does would change nothing observable. The definition is every field of the gate *as it runs* (the rendered `cmd`, scoped or full), minus the ones that never reach the run: `description`, `tuning`, `type` and the `scoped_cmd` template. Built by subtraction, so a field added later is in the key until someone argues it out. It is hashed rather than stored: a command line is repository content. A cache from before this key is dropped on open rather than served. Fix loops re-run the same suite against unchanged trees constantly, and the test suite is by construction the most expensive resource in the system. Invalidate on any tree change. Small, and it directly relieves the bottleneck that §6's queue exists to manage.

The tree hash is `git add -A` into a scratch index, so it holds tracked and untracked files and **not ignored ones**. A gate whose verdict depends on an ignored file — a type checker's own cache, a stale build directory, an installed dependency, the lane's database — is replayed after its cause is gone. Observed: a typecheck red because of ignored files left in a lane kept coming back from the cache once they were removed, and twenty fixers in a row found nothing to fix. Three ways out, each of which only ever makes a gate run again:

- **`vinta-ai-maestro gate <id> --no-cache`** is the agent's. It runs the gate in the agent's lane past the lookup, and the result *replaces* the entry: the entry is dropped before the run, so a fresh run that times out (never stored) leaves no verdict rather than the stale one. A cached red tells the agent the flag exists, at the moment it reads the red. `earlier_gate_red` (§18.3) still reads the cache, so a stale red on an earlier gate is cleared by running *that* gate with the flag.
- **`vinta-ai-maestro gate-cache invalidate <run> <gate> [--tree <hash>]`** (`POST /api/runs/:id/gates/:gate/invalidate`) is the operator's and the coordinator's (§9.2), and never an agent's: an agent's token does not reach it. It forgets one gate's results on one tree, or on every tree, across every definition the gate has had, and journals `gate_cache_invalidated` with who asked.
- **The scheduler takes the first one itself when a fix loop stalls.** It keeps, per node, the gate and tree of the last red, and whether a fixer turn has run since. A gate red again on that same `(gate id, tree hash)` after a fixer turn means the turn changed nothing the gate reads — a fixer that moved the tree at all, committed or not, is never a stall. If the repeat came from the cache, the scheduler reruns `run_gate` with `no_cache` naming the red gate (the gates before it stay hits); green, or red on something else, and the loop carries on with that answer (`gate_stalled`, `rerun_cleared`). Red the same way — or a repeat that was already fresh — and the fact goes out as `gate.stalled`, which `standard-phase` routes to `exhausted` whatever the budget says, with no budget too (`gate_stalled`, `escalated`, which also wakes the coordinator). `exhausted`'s answers are the ones §16.3 already gives it: `continue` buys one more fixer, and a second stall in the attempt asks again; unattended that is `continue` once, then `stop`. Cleared when an attempt restarts, and not rebuilt across a daemon restart, which costs at most one extra fixer.

**13.5 `vinta-ai-maestro doctor`.** Preflight everything before a run: harness presence and authentication, git version and worktree support, each forked DB's `reset_cmd`, compose availability, disk headroom for N lanes. Nearly every failure this system can have at minute zero is in that list, and discovering them one at a time across a half-started run is the worst way to learn them.

**13.6 Plan post-mortem fed back to `plan-feature`.** A run knows things the plan's author could not: dependencies that were declared but never used, dependencies discovered at gate time that were missing, same-wave nodes that actually conflicted, phases whose real duration diverged wildly from their wave placement, and — since §9.2 — the amendments the run made to its own plan and what happened to the thing each one changed. A gate is scored against its own uncached durations either side of the amendment, which is a comparison rather than a claim of cause; a phase-level change has no before to compare against and is reported `unmeasured` rather than estimated. Without that last finding an autonomous editor is one nobody can tell is making runs worse. Emit that as a structured post-mortem the `plan-feature` skill reads when planning the next feature in the same repo. This is the one addition that makes the two halves of the system compound rather than merely coexist, and it is unique to owning both.

**13.7 Cost and token accounting.** Every harness already reports usage; aggregating it per node, wave and run is bookkeeping, not new machinery. It belongs in the product because model choice per node is a first-class field in the workflow — without the numbers, tuning it is superstition.

**13.8 A log of the daemon itself.** Everything else in this document records what a *run* did — `events` is the run's history, transcripts are its agents' words, the post-mortem is its retrospective. None of it records what the **process** did, and that is the half an operator needs when the answer is "nothing happened", "it stopped", or "the daemon is gone". A run that was refused before it had an id has no journal row to carry the refusal; a bind that failed has no run at all; a crash takes down the thing that would have explained it.

So: `.vinta-ai-maestro/logs/daemon.ndjson`, one JSON record per line, served by `GET /api/logs` as a tail or a cursor-follow, and rendered as a fourth UI section beside Runs, Editor and the per-run views. It is **not** part of §5.3's event log, and the separation is load-bearing: `events` is a closed union every projection is folded from, and a diagnostic stream in it would make "drop the projections and replay" mean something different. It is also not per-run, because the records most worth reading are the ones with no run to file them under.

Three properties it must keep.

- **It survives what it describes.** Writes are synchronous (`appendFileSync`), because a buffered logger loses exactly the records explaining why the process died. Process-level `uncaughtException` and `unhandledRejection` handlers record the kind, the stack frames and the ids of every run in flight, give the host one synchronous chance to journal those runs as ended — so `--resume` can pick them up instead of finding `running` for ever — and then exit. They do not swallow: an exception unwound an unknown number of frames, and a scheduler running on that heap makes decisions about worktrees and branches.
- **It never fails its host.** A full disk or a read-only checkout makes every write a no-op and increments a counter the command reports on exit. Instrumentation that can take down a run is a liability, and "the log is empty" must stay distinguishable from "the log could not be written".
- **It carries identifiers only, by construction, with one deliberate exception.** §11 says structured log fields hold opaque identifiers and never file contents. For the journal that is achievable by review — its payloads are a closed union. A log is called from anywhere, so the rule is enforced instead: a field admits only a string, number, boolean or null (an object is **dropped**, never stringified); values are capped; secret-by-name keys and the registered daemon token are redacted, including inside the exception below.

  The exception is an error's **`message`**, recorded by default beside its kind. The case against it is real — a message is prose a dependency composed out of whatever it was holding, and a git diagnostic or a line of a source file can end up in one. The case for it is that §5.3 already puts every transcript and every gate log **verbatim** in the same store, under the same `purge`: the repository is already at rest in that directory, so excluding one string bought no protection worth having and cost the field that most often explains a failure. `message` is therefore the single allowlisted prose field — capped longer than an identifier, redacted like everything else — and `--log-detail kind` narrows to the kind alone for a checkout whose obligation is stricter than this store's own.

Bounded by rotation rather than by `purge`: 8 MiB per file, five rotations kept. `purge` leaves it alone for the same reason it leaves `flow.db` alone — no repository contents, and it is the record of the failure somebody is about to ask about.

*(Notifications were proposed here and have been promoted to a required feature — see §9.1.)*

---

## 14. Open questions

### Resolved

- **O1 — Harness concurrency.** Terms are not a design input for now. The requirement is instead to **fail gracefully and wait automatically** whenever a spawn is refused. Specified in §6.1 and built as step 7. This also renders the default `capacity(lane)` low-stakes: admission control discovers the real ceiling at runtime, so the configured value is a starting hint, not a contract.
- **O2 — Databases and fixtures.** Lane databases delegate entirely to `prepare-worktree`'s existing strategies — template-clone from a once-refreshed template against a shared/global DBMS, per-lane test DB names, unconditional volume forking for compose-delivered DBs (§8). **Seed data is always the project's own**; `vinta-ai-maestro` ships no fixtures and assumes nothing about database contents. Its own test suite is the sole exception and needs a minimal fixture repository (a test suite, one migration, one DB) built under `packages/vinta-ai-maestro/tests/fixtures/` as a prerequisite of step 4.
- **O3 — Human gates.** A paused node **keeps its lane** and releases its gate resources at once — the human is being asked about work in progress in that lane, and the diff, logs and takeover all read from it. Pauses notify on **both** the browser and OS channels and are **answered from the UI**, with the answer entering the pipeline's guard context. Specified in §9.1, built as step 16.
- **O4 — Windows.** macOS and Linux for v1; Windows is a required Wave 7, gated on every requirement being working, tested and polished on the other two first.
- **O5 — DAG canvas.** A separate `vinta-dag-editor` package (§3), strongly modelled on `vinta-state-machine-editor` — same framework-agnostic Web Component architecture, same tooling, same readonly-data and host-passthrough conventions — so extracting it to npm later is a publish rather than a refactor. Built as step 13, consumed by both the run view and the workflow editor.

- **O6 — Publishing `vinta-dag-editor`.** Not published for now. It stays a private workspace package (`"private": true`), consumed via `workspace:*`. Its API is therefore free to move while the run view exercises it, and extraction later is a version bump and a `pnpm publish`.
- **O7 — Notification reminders.** Off by default, with an opt-in interval. Specified in §9.1.
- **O8 — Skills accommodate `vinta-ai-maestro`.** Emission is **unconditional** — no config gate, no new bootstrap question. `plan-feature` always writes `workflow.json` beside the plan; projects without the daemon simply carry a file they don't read, and gain a workflow already waiting if they later install it. The schema is therefore a shipped-skill output and lives in the root `schemas/` (§5.1). The `AGENTS.md` ripple for step 21 reduces to: root schema entry + `schemas/README.md` + `plan-feature` body + CHANGELOG — no config field, no Step 0.5 emission, no interview question.

  More broadly this settles the direction of authority: where a skill's shape blocks the daemon, the skill changes. See [Relationship to the skills path](#relationship-to-the-skills-path).

### Still open

Nothing blocking. New questions will land here as implementation surfaces them.

---

## 15. Session reuse

A node's pipeline spawns several agent turns — implement, fix, the review, the polish chores. Until now every one of them was a cold session: a new process, a new context window, and a prompt that re-sent the phase brief, the plan-level framing and the whole dependency closure from scratch. On the fix path that is paid twice more per round.

Session reuse makes the fixer and the chores **continue the implementer's own session**. The prompt for a continued turn is then a delta — the red gate, or the chore's instruction — because everything else is already in the session. The saving is a prompt-cache hit on a prefix that was previously rebuilt from nothing.

Almost none of this is new machinery. `AgentTask.resumeSessionId` and `capabilities.resume` are §7 as originally specified, and all four shipped adapters implement them. What was missing was a *policy*: nothing ever set the field except an operator detaching from a PTY takeover (§9). This section is that policy.

### 15.1 Slots

A node keeps a **session ledger**: a map from slot name to `{ harnessId, sessionId, lane }`. A slot is author-chosen vocabulary, exactly like a state id — the interpreter knows nothing about which slots exist.

`spawn_agent` takes one new param, `session`:

- **absent** — a fresh session, always. This is today's behaviour, so every workflow written before this section keeps its exact meaning.
- **`session: '<slot>'`** — continue that slot's session where the ledger entry is valid, and otherwise start fresh and record the new id under it.

`standard-phase` therefore reads: `implement` and `fix` both carry `session: 'main'`, and a chore's `session` defaults to `main` too. Pipeline data is the whole feature at the authoring layer.

**A fix round remains a `spawn_agent` with `role: 'fixer'`.** Counting keys off the role, never off the session or the state id (§5.2), so sharing the implementer's session leaves `max_fix_rounds` untouched.

### 15.2 When an entry is invalid

A ledger entry is usable only when all of these hold. Any failure means a fresh session **and the full, non-continuation prompt** — never a delta prompt against a session that does not exist.

- **The harness matches.** A codex session id means nothing to claude-code.
- **The lane matches.** A session is about a worktree: resumed into a different one it carries a history of paths and file states that no longer describe where it is standing. The entry therefore records its lane.

  The stronger rule sits above it, because the lane name is not enough. On a capacity refusal a node releases its lane and re-drives its pipeline from the initial state, and the free list usually hands back *the lane it just released* — which `#prepareLane` then recycles, resetting the worktree under a name that did not change. **The whole ledger is therefore cleared at the start of every attempt**, and the lane check remains as the invariant that keeps the mistake unwritable rather than merely un-made.
- **The adapter declares `capabilities.resume`.**
- **The vendor still has the session** — which cannot be known in advance, so it is handled as a refusal (§15.4).
- **The slot is under its turn ceiling** (§15.5).
- **The operator has not dropped the session.** `fresh` (§9) clears the ledger and marks the node's next turn cold, `operator_fresh` — including a warm member session a pending phase would otherwise have been handed.

Every fresh-instead-of-continued decision is journalled with a fixed reason token. A silent fallback would make a run that quietly stopped reusing sessions indistinguishable from one that never started.

### 15.3 Continuation prompts

A continued turn gets a delta, composed by `src/prompts` behind a `continuation` flag. Re-sending the brief to an agent that has already acted on it is not merely wasteful — it instructs an agent to implement what it has already implemented.

This puts one constraint on slot authoring. A continuation prompt tells the agent what it already has, and the fixer's says it has the plan's bounds — which is true because `fix` shares `main` with `implement`, and the implementer is the role that gets them. **A fixer slot must therefore be one an implementer opened.** A pipeline that gave its fix state a slot of its own would produce a delta claiming context that session was never given. Nothing checks this, because the composer cannot see which role opened a slot; it is an authoring rule, and the shipped pipeline follows it.

A cross-phase continuation's preamble says the change of objective first, in so many words: the previous phase is finished, nothing in flight for it — background commands, a reviewer, todos, findings, a verdict — is owed, and the objective is now the new phase. Only then the worktree note. With the worktree note alone, an agent woken on a new phase kept reporting on the old one under the new one's name.

A continuation also **does not resolve `prompt_ref` or `plan_context_refs` at all** — a delta does not carry them, and reading a document only to fail a turn over a reference it will not use trades a working turn for nothing. The cold prompt that opened the session already validated both.

**How a turn waits is the harness's, not the role's.** Every turn on a slot is the same agent in the same session, so implementer, fixer and chore turns are told the same thing about work they start. On a harness with `backgroundWork` (§7) a long command may run in the background, and the agent waits for it by ending its turn — it is woken in the same session when the command reports — never by sleeping, polling or a monitor; it starts nothing that does not finish on its own, since the session stays open for it. On a harness without it, everything runs in the foreground, because whatever a turn backgrounds is killed when the turn ends and nothing wakes the agent. The prompt names each harness's own tools (`BACKGROUND_TERMS` in `src/prompts`), because each backgrounds work differently: claude-code with the Bash tool's `run_in_background` and a `SendMessage` to a sub-agent; codex with an `exec_command` left running past its yield and a `send_input` to a sub-agent; opencode with a background `task` only — it has no background shell, so its implementer and fixer turns keep the foreground rule and its review sends the reviewer to the background while the gates run in the foreground beside it.

One rule is load-bearing beyond token economy: **a review chore's continuation always restates the `VERDICT:` protocol.** `readVerdict` is exported from `src/prompts` and imported by the executor precisely so the protocol and its parser cannot drift; a continuation that dropped the marker would take the fail-closed default on every node and send every phase to the operator unapproved.

### 15.4 A session the vendor has forgotten

Resuming an id the vendor has expired or pruned fails the spawn. Before this section that classified as `fatal` and failed the node — acceptable when resume was an operator's rare manual path, and not acceptable once it is the default one.

`SpawnRefusalKind` therefore gains **`stale_session`**, which is neither of the kinds around it. It is not a capacity wait: waiting changes nothing, because a forgotten session does not come back. It is not `fatal`: the harness is healthy and the work is fine — only the token is stale. The host's answer is exactly one retry with a fresh session and the full prompt, after which an ordinary failure is an ordinary failure.

An adapter may classify a refusal this way **only when the task actually carried a `resumeSessionId`**. With no token there was nothing to be stale. The rule is enforced in `shared.ts` rather than per adapter: the stale rows are hoisted ahead of every other signature *and* gated on the resuming flag, so neither invariant depends on an adapter remembering to order its own table.

**The vendor wording is inferred, not observed.** No real expired session was exercised against any of the three CLIs; the patterns cover each vendor's phrasing for a missing conversation, thread or rollout. A pattern that misses would otherwise turn a routine expired token into a dead node and a blocked subtree — far too much to lose to a string — so the host does not rely on the classification alone: **a spawn that carried a token and came back `fatal` is also retried once, cold.** A genuinely broken harness fails again identically one spawn later; a misread refusal recovers. A task with no token is never retried, because nothing about it would change. The classification stays worth having — it avoids the wasted spawn and names the reason in the journal — but it is an optimisation over the net rather than the thing keeping runs alive.

**A turn the model never took part in is retried the same way.** A session that starts and ends with no text, no thought and no tool call — a zero usage row does not count — delivered nothing, so nothing the pipeline reads next can be about it. Observed on resumes: claude-code replays the notifications of work its previous process was killed under and closes that replay with a `result` before it reads the prompt. As a review turn it read as `fail` with no reviewer behind it; as a cross-phase continuation it was worse — the new phase's brief was in the unread prompt, the ledger filed the session under the new phase, and every later turn got a delta, so the agent carried on with the phase it had finished. A resumed empty turn is retried once, cold, with the whole brief, journalled `node_session` `reason: empty_turn`; a cold one that is empty fails the turn (`SpawnFatal`). An interrupted turn is not empty: that is §9's doing.

### 15.5 Context growth, and the last fix round

A shared session across implement plus N fix rounds only ever grows. `max_fix_rounds` bounds it loosely; a per-slot turn ceiling bounds it directly, forcing the next spawn fresh and journalling why. Without one, a long node eventually dies on a context-window error that reads as a broken harness.

The ceiling has a second, better-motivated sibling. Reusing the implementer's session means **the agent that wrote the bug is the agent fixing it**, with every original assumption intact. That is usually the point — it knows why the code is the way it is — and occasionally exactly wrong, because the assumption *was* the bug. So **the final fix round goes fresh**: if the author cannot fix it in the rounds before last, the work is handed to an agent that has not seen it. The cost is one cold prompt on the path that was already heading for `failed`, and it recovers an outsider's independence in the one case where it demonstrably matters.

### 15.6 Measuring it

A caching optimisation nobody measures is a claim rather than a result, and there was no cache accounting anywhere: the usage event carried input, output and cost, while the vendors' cache counters sat unread in the same objects.

`AgentEvent`'s `usage` variant gains optional `cacheRead` and `cacheWrite`, aggregated through `src/usage` under the same rule `costUsd` already follows — **a missing figure is not a zero**, or a harness that reports nothing is aggregated as having achieved a 0% hit rate. `cacheReadShare` therefore returns `undefined` rather than `0` for an unreported total, and its denominator counts only the sessions that reported. Reused-versus-fresh session counts come from the journal's `node_session` rows beside them, so the report can state both what reuse was attempted and what it bought.

**`input` is normalized to mean the fresh remainder, in every adapter.** This is the one place the harness layer does not pass a vendor's number through. Codex reports the OpenAI shape, where `input_tokens` is the *whole* prompt and `cached_input_tokens` names the cached subset of it; claude-code and opencode report the fresh remainder with the cache counts beside it. Carried through verbatim, one field would mean two different things inside a single aggregate and every cross-harness cache figure would be wrong by exactly the cached prefix. So codex subtracts, floored at zero, and the invariant `input + cacheRead + cacheWrite = the whole prompt` holds everywhere. The cost is that codex's reported `input` no longer matches what the codex CLI prints, which is the trade a cross-harness number requires.

### 15.7 What the operator sees

Reuse fails *quietly*. A run whose sessions stopped being continued looks exactly like one that never continued any — same statuses, same transcripts, same result, just more tokens and a slower fix loop. So the node view carries a **Agent sessions** panel: one row per agent turn, saying which slot it ran on, whether it continued that slot's session, and — when it did not — why, in words rather than in journal tokens.

Two rules the panel follows, both about not crying wolf:

- **Cold is not failure.** Most cold turns are correct: the first turn on a slot has nothing to continue, and the last fix round is escalated on purpose (§15.5). They are rendered in the idle tone. Only `stale_session` gets the waiting tone, because it is the one that cost a spawn nobody asked for. Nothing in the panel is ever an error tone — a lost session costs a turn, not a run.
- **An unrecognised reason is shown, not swallowed.** A browser served by a newer daemon renders the raw token rather than hiding it behind the vocabulary this build happens to know. Ugly and true beats tidy and blank, because the token is the only clue there is.

At the run level the same question is asked once, over the whole run: a **Sessions and cost** panel pairing how often reuse engaged with what the prompts cost. The two halves belong together because neither answers it alone — a poor hit rate can mean reuse is working and the prompts are simply short, or that reuse silently stopped, and only the turn counts separate those. A tally of cold turns by reason says which of §15.2's rules is responsible.

That rollup is **its own endpoint, not a block on the snapshot**: answering it folds every transcript in the run, and the snapshot is re-read whenever an event lands. The run view polls it on a slow cadence instead, and a daemon too old to serve it costs the page nothing — the graph and the capacity panels are why an operator opened it.

The `unreported` statuses cross the wire intact rather than being flattened to numbers, which is the one decision this panel cannot be allowed to make in the browser. A `?? 0` there turns a codex run's unknown bill into a confident $0.00, and a silent harness into a 0% hit rate — the precise claims §15.6 exists to prevent. Every figure on the panel sits behind its status, and the share is computed by the same `cacheShare` the server uses, so the browser cannot divide by a different denominator.

The per-node rows come from the journal, not from a projection, over the existing node-detail endpoint (`sessions`) with a narrow per-node query. Folding a whole run's log in the browser to keep four rows would make the panel's cost grow with the length of the run it describes, and a table keyed by node would answer "is reuse working" with whichever turn happened to be last.

### 15.8 Interaction with takeover

§9's PTY round trip stages a resumed id for the node's next spawn. With a ledger that id belongs to **the slot the taken-over turn was running under** — an operator who takes over a fixer turn must not have their session handed to whatever spawns next.

---

## 16. The review loop

A phase's code review is the **thermo-nuclear review loop** Vinta runs by hand: one reviewer held to a demanding standard, a fixer that checks every finding before acting on it, scope questions sent to a person rather than assumed by either agent, and a loop that ends only on the reviewer's explicit approval. The skill it comes from, `thermo-nuclear-review-loop`, runs both roles from one host session — the host is the fixer and spawns the reviewer as a sub-agent. Maestro runs it the same way, as a **chore** on the implementer's own session.

**Correction: this used to be two pipeline roles.** An earlier design spread the loop across the state machine: a `reviewer` role on its own session slot, a `fix` state for its findings, a `consult` state for scope questions, a review ledger file carrying rejected findings and settled decisions between them, reviewer members on the roster, and a host check that the reviewer had not edited the lane. Every round was a cold spawn or a resume, a prompt rebuilt from the plan and the ledger, and a pass through the scheduler. It was too slow and too expensive to run on every phase. Inside one turn a round is a message to a warm reviewer, and the state the ledger carried between sessions is simply in the implementer's context. That holds only as long as the session does, so the one part of the ledger worth keeping — what was decided — is back, as a list the host keeps and every prompt renders rather than a file the agents edit (§16.4).

### 16.1 The review chore

A chore with `when: review` (§8) runs in `standard-phase`'s `review` state, once the phase's gates are green. Its turn continues `main`, so the agent running the loop is the one that wrote the code and knows why each line is there. The prompt (`src/prompts`) gives it what only the orchestrator knows:

- **the scope** — the phase's diff against its base — and **the stated requirement**: the phase brief and the plan-level sections, verbatim, to hand to the reviewer;
- **the gates**, through `vinta-ai-maestro gate`, so each round's verification is on the run's cache and the `verify` state after it is usually a hit. Where the harness has `backgroundWork` (§7), a round's gates start as one background command at the moment the round goes to the reviewer, so a round costs the longer of the two rather than their sum; the loop still ends only on an approval of a commit the gates passed;
- **one sub-agent, exactly**: the reviewer, spawned once at the harness's most capable tier and kept for the turn. Every other turn is told not to delegate at all (`soloTurn`); this one is told that the verification, the fixes and the commits stay in the session;
- **how to wait**, where the harness has `backgroundWork`. The reviewer's first pass is a foreground spawn; every later pass is a message to it, and a resumed reviewer answers in the background whatever the prompt says. The agent waits for it, and for the gates, the way an interactive session does: it ends its turn and is woken in the same session when each reports. It is told not to sleep, poll or start a monitor, and that a message ending a turn to wait carries no `VERDICT:` line. Before this, the session ended with that turn and took the reviewer with it, so every round after the first ended "waiting on the reviewer" with no verdict, went to the operator as `unapproved`, and restarted cold. The rule is the one every turn gets on such a harness (§15.3) with two lines added — the reviewer and the verdict; on a harness without it the turn keeps the foreground rule;
- **the budget**: none by default — the loop runs until the reviewer approves. With `max_fix_rounds` set, at most that many passes return blockers, after which the loop stops and reports rather than pausing on its own — a headless turn that stops to ask whether to continue is a turn that ends;
- **how a scope question reaches a person**: the `NEEDS_INPUT` block (§9.1), not the harness's question tool. The node parks, the operator answers in the node view, and the same session resumes with the answer. The reviewer may not survive the resume; the prompt says to spawn a fresh one and hand it the rejected findings and the decisions;
- **the decisions made so far** (§16.4), to hand the reviewer with the scope, and what to do with a finding that re-opens one;
- **the verdict**: the turn's last line is `VERDICT: pass` — the reviewer explicitly approved — or `VERDICT: fail`. Before it, each finding the loop rejected is restated on a `REJECTED:` line with its counter-evidence, which the scheduler keeps (§16.4).

The skill the chore names carries the loop's own procedure and the reviewer's standard (a project `REVIEW.md` where there is one). Where the skill and the prompt disagree, the prompt wins.

### 16.2 The verdict

`run_chore` with `when: review` spawns each review chore with `verdict: true`, and the executor reads the turn's closing line with `readVerdict` — the same definition the prompt asks for. It states `review.verdict`:

- `pass` when every review chore approved, and when the node runs none;
- `fail` at the first review chore that did not, without running the rest. A turn that stated no verdict, errored or was refused by its harness for good reads as `fail`: a merge on a review's silence is the one failure a review exists to prevent. A capacity refusal is not skipped, as a polish chore's is — skipping it would merge a phase nobody reviewed.

The chore's `chore_result` row says `failed` for an unapproved review, so the post-run report counts it.

### 16.3 Budget, and what an unattended run does

**`unapproved`** is an `await_human` choice of `continue`, `accept` or `stop`, and the question says what each does. `continue` runs the review again; the new turn continues the same session, and the prompt tells it to pick the loop up where it stopped with a fresh budget. `accept` ends the review loop and keeps the work as it is: the phase goes on through the polish chores, `verify` and integration, and the `human_answered` row records that it was accepted without the reviewer's approval. A red gate still stops it — accepting a review's open findings is not accepting a failing gate. `stop` fails the attempt into `--on-failure`, which under `retry` starts the phase over from `implement` on a fresh session. Operators read `stop` as "accept as it is" for want of the other two being spelled out. The coordinator cannot answer `accept`: it answers only what a timer could.

**`max_fix_rounds` is both budgets, and is unset by default.** Unset, neither runs out: the fixer works until the gates are green and the review loop until the reviewer approves, and neither `exhausted` nor a budget-driven `unapproved` is reached. The scheduler states the unset budget to the guards as `node.max_fix_rounds == null` rather than leaving the fact out, since a missing fact makes every comparison false. Set, it bounds the fixer turns a phase spends on red gates before `exhausted` asks, and the passes each review turn may run before it stops unapproved. The cost of the default is that a phase that cannot converge keeps spending until an operator stops it (§9) — except for the one non-convergence the scheduler can see for certain, a fixer that left the tree unchanged under a gate that is still red on it, which reaches `exhausted` on `gate.stalled` with or without a budget (§13.4). `exhausted`'s `continue` runs `grant_fix_rounds` — the one verb that moves the scheduler's counter — and goes straight to a fixer. Under §15.5 the last fix round of each grant goes fresh; with no budget there is no last round, and the turn ceiling is what retires a session.

**Unattended, the plan supplies the answer and `--retry-after` supplies the moment.** A plan question may declare `unattended_answer`; with `--retry-after` set, the host answers it with that value once the window passes and journals the answer `unattended`. `unattended_answer` may be a list: the nth unattended answer to that question within an attempt is its nth entry, the last repeating. Both `exhausted` and `unapproved` declare `[continue, stop]` — one more budget where the session already is, then the phase stops — so an unattended run spends at most one budget past each. They used to declare `stop`, and that was the dearest answer: the failure's unattended retry re-drove the phase from `implement` on a cold session, gates and review from scratch, to reach the same question again — twelve failed attempts in one observed run, each a review that needed one more round. A scope question the review loop raises is an agent question, answered unattended with its recommended options (§9.1). A plan question that declares none still waits for a person.

### 16.4 Decisions that outlive a session

A decision used to live in the session it was made in. An agent's question answered under `--retry-after` reached the session that asked; an operator's `node context` reached the next spawn and was then cleared; a finding the loop rejected lived in the implementer's context. Every review pass is a fresh reviewer, so it raised the same finding again, the implementer asked the same question again, and the run answered it again: one observed phase asked one decision four times and another twice, in some thirty review, fix and polish rounds that never converged. A session replaced after a stale token or a cold retry lost the operator's note the same way, and it had to be sent again.

So each node keeps a list of **decisions** (`src/decisions`), appended where they happen:

- **`answer`** — each answered question of an agent's ask, with the option it got and that option's consequence, marked `operator`, `coordinator` or `unattended` (§9.1);
- **`context`** — the text of an `add_context` or `redirect`, the operator's or the coordinator's, whether it was sent into a live session or queued (§9);
- **`rejected`** — each `REJECTED:` line of a review chore's closing report: a finding the loop rejected, with its counter-evidence (§16.1).

The same kind with the same words is one decision. The list is prose — the operator's and the agent's — so it is mirrored to `decisions.jsonl` beside the transcript, never to the event log (§11). It survives what a session does not: `#restartAttempt` clears everything else about an attempt and keeps it, because a retry discards the branch, not what was decided about the phase; a resumed run reads it back from the file (`#seed`).

**Every prompt renders it**, the delta included, under "Decisions already made in this phase": the session that was not there when a decision was made is the reason the list exists. The block says each one is settled and binding on the turn, and that evidence one cannot hold goes in the report rather than into re-opening it. It is **bounded**: the newest twelve answers and notes and the newest eight rejected findings, in the order they were made, with a count of what was left out — rejected findings have their own allowance so a long review cannot push the operator's answers out of every prompt — and each entry is cut at 800 characters.

**A finding that re-opens a decision is rejected, or escalated once.** The review chore's prompt tells it to hand the decisions to the reviewer with the scope — on the first pass, on every later one, and whenever it spawns a fresh reviewer. A finding that re-raises one is not a finding: the loop rejects it citing the decision, and neither fixes it nor asks about it again. Only a finding that brings evidence the decision did not weigh goes to the operator, once, in one `NEEDS_INPUT` block naming the decision; the answer is kept like any other and stands after it. This is the smallest rule consistent with §16.1 — the loop's procedure stays in the turn, and the host only remembers — so nothing in the scheduler compares findings with decisions or answers a repeated question on its own.

### 16.5 Not done here

- **The skills path's host.** `review-phase` runs the same `thermo-nuclear-review-loop` (`partials/review-loop.md`), but the conductor hosts it rather than the implementer, because a sub-agent cannot spawn sub-agents of its own. The conductor spawns the one reviewer, continues the phase's implementer as the fixer, and asks the gate questions itself. Its reviewer runs one tier above the tier the implementer ran at, and it pauses after 20 unapproved passes; neither rule is specified here.
- **Reviewer edits.** The prompt tells the implementer to check `HEAD` and `git status` around each pass and not to build on anything the reviewer changed. The host no longer checks it, because the reviewer is a sub-agent of the implementer's turn and the turn itself edits the tree.
- **The reviewer's model.** The prompt asks for the harness's most capable tier. Reasoning effort and the tier itself are the harness's to resolve, not the scheduler's.

---

## 17. System One

A **System One** model is a fast classifier: given a text and a closed set of labels, it says how likely each label is. A yes/no question is the two-label case. It writes nothing, edits nothing, runs no tools and keeps no session. That is why it is not a harness adapter (§7). There is no turn to admit, no transcript to drain and no lane to sandbox. One request costs one round trip.

The daemon asks one wherever it would otherwise hard-code a decision or spend a frontier-model turn on it. Every place it asks is a **judge**: a question, a label set, a threshold, and a rule for what an *unanswered* question means.

### 17.1 The adapter seam

```ts
interface SystemOneAdapter {
  readonly id: string
  preflight(): Promise<{ ready: boolean; hint?: string }>   // offline: no question is sent
  classify(q: { question: string; labels: readonly string[]; input: string }): Promise<SystemOneOutcome>
}
type SystemOneOutcome =
  | { ok: true; scores: Record<string, number>; latencyMs: number }   // a distribution over exactly `labels`
  | { ok: false; kind: 'unavailable' | 'invalid'; message: string }   // never throws
```

`normalizeScores` runs once, in shared code, for every adapter. It accepts `{ scores }` for any label set and `{ yes }` for a yes/no question. It refuses a label nobody asked about. A label the vendor left out scores zero, and the result is rescaled to sum to one. Every judge compares a *sum* of scores against a threshold, and that comparison only means the same thing across vendors if their numbers do.

Adapters are a **registry**, not a switch. Each one owns the schema of its own config block (`registerSystemOneAdapter`). Two ship with the package:

- `http` — one POST per question. The body is `{ kind, question, labels, input }`, and the answer is `{ scores }` or `{ yes }`. A vendor that speaks something else gets a shim in front of it rather than an adapter in here.
- `command` — one local process per question, with the same JSON on stdin and stdout and no shell. This is for a classifier that must not see repository content leave the machine.

A `mock` adapter exists for tests.

### 17.2 What a judge may never do

- **Make a phase greener.** A judge gate can only turn a gate red. Gate triage can only add a rerun. The permission judge can only deny what `full` would have allowed. None of them can pass something that would otherwise have failed.
- **Put what it judged into the journal.** `system_one_judged` carries the judge, a subject id, the adapter id, the outcome, the decision, the top label, the score and the latency. It never carries the diff, the log or the command. The gate log is the one place a judge writes prose (the question and the answer), because that is where the fixer reads why a gate went red, and it is already a file of repository content (§5.3).
- **Fail silently.** Every judgement writes a row, including the ones nobody answered. A classifier that stopped answering otherwise looks exactly like one that kept approving.

### 17.3 Configuration: the operator's, not the plan's

`--system-one <config.json>` on `run`, `serve` and `doctor`:

```jsonc
{
  "adapter": { "type": "http", "url": "https://classifier.internal/v1", "api_key_env": "S1_API_KEY", "timeout_ms": 10000 },
  "judges": {
    "gate_triage": { "rerun_above": 0.8, "max_reruns": 1, "max_input_bytes": 32768 },
    "permission":  { "tools": ["Bash"], "allow_above": 0.9 }
  }
}
```

This amends §2's no-API-keys constraint. That constraint still holds for every **LLM harness**, which keeps driving the user's logged-in CLI. A System One adapter may use a key, under four conditions:

- The key is read from the environment variable the operator named.
- It is never stored or written.
- It is registered for redaction in the daemon log.
- It is removed from the daemon's own environment once the adapter has read it, so no agent, gate or hook process inherits it.
- It is never read from a workflow document.

The file lives on the operator's machine for the reason `permissions.ts` gives. A committed document may say which model writes a phase. It may not say where a stranger's machine sends its diffs, or what an agent may do on it. A block that is present enables its judge; an absent one disables it.

**The preflight asks once.** `doctor`, and the preflight before every run, ask the classifier one synthetic question (`PROBE_QUESTION`, whose input is a fixed string and carries no project data). The offline check can see a key that is missing from the environment. It cannot see a key the endpoint rejects, or a URL nobody answers on, and those otherwise surface only as every judgement of the run coming back unanswered. An unanswered probe fails the preflight, naming the status (`HTTP 401`), never a response body. `"probe": false` at the top level of the config keeps the preflight offline.

An `http` adapter with no `api_key_env` is valid, because an internal classifier may need no key. It is also the usual cause of an endpoint that answers every question with a 401, so `doctor` warns about it (`system-one-config`) and does not refuse.

**Data handling (§11).** A configured classifier receives repository content: diffs, the end of gate logs, and shell commands. On an engagement where that must not leave the machine, the `command` adapter pointed at a local model is the supported answer. Whether a hosted classifier is acceptable is a compliance decision for the project lead, not something this package can settle.

### 17.4 Judge gates

A gate in the workflow's `gates` map is now one of two shapes: a command gate (`cmd`, as before) or a judge gate (`judge`). A judge gate asks the plan's own question of the lane's diff:

```jsonc
"no-body-logs": {
  "judge": {
    "question_ref": "ai-plans/PLAN.md#no-request-bodies-in-logs",   // or "question": "…"
    "labels": ["yes", "no"],          // default
    "fail_on": ["yes"],
    "threshold": 0.6,                 // fails when fail_on's labels together score ≥ this
    "input": "diff",                  // the lane against the phase's base, uncommitted work included
    "max_input_bytes": 204800,        // larger is unavailable, never a truncated judgement
    "on_unavailable": "pass"          // default: advisory. "fail" for a check the phase must not merge without.
  }
}
```

The judge gate reports exit code 0 or 1, so `standard-phase`'s `gate.exit_code` guards, the fix loop and the fixer's prompt all work unchanged. Its log holds the question, the scores and the verdict. A node's gates run in declaration order and stop at the first red one, so a judge gate cannot cover for a failing command gate. Put judge gates after command gates, and the classifier is only asked about a tree that already builds.

The cache (§13.4) keys a judge gate on the tree hash plus a hash of the judge spec, the resolved question and the adapter id. Only an *answered* judgement is stored. An outage is a fact about the network, not about the tree.

A judge gate is left out of everything agents are told to run. The `gate` verb refuses one (`judge_gate`), and so does the integration worktree's conflict verification: a merge resolution is not the phase diff the question was written for. `retune_gate` and `retime_gate` refuse one too, since there is no command to change and no process to time out.

Without `--system-one`, a judge gate answers as `unconfigured` under its own `on_unavailable`. `doctor` warns about advisory judge gates and fails on required ones.

### 17.5 Gate triage

When a **command** gate goes red on a fresh run (not a cache hit, not a timeout), the triage judge reads the end of its log. It sorts the failure into `real`, `flaky`, `environment` or `pre_existing`.

- If `flaky` plus `environment` together reach `rerun_above`, the gate runs again (skipping the cache, then storing the new result), up to `max_reruns` times, before a fixer is spent on it.
- Anything else, including no answer, takes the ordinary path. A missing hint must cost nothing.

The top label is exposed as `gate.triage` for authored pipelines. `standard-phase` does not branch on it yet. Routing `pre_existing` to a human instead of a fixer is the obvious next guard.

### 17.6 `--permission judged`

`judged` is `full` with a check. claude-code runs with `bypassPermissions`, so no vendor prompt fires. The per-lane settings file (§7) installs a `PreToolUse` hook on the judged tools (default `Bash`). The hook is this package's own binary, by absolute path, under the daemon's node: `vinta-ai-maestro judge-hook`. It reads the call on stdin and posts it to `POST /api/runs/:runId/permission` with the run's token. The daemon asks the classifier whether the call is `safe` or `unsafe`, and the call runs only at or above `allow_above` on `safe`.

It **fails closed** at every link:

| Failure | Result |
|---|---|
| No hook configured, or the settings file cannot be written | the spawn is refused (`fatal`) |
| The hook process dies before it can decide | the `\|\| exit 2` wrapper turns the exit into claude-code's blocking code |
| The daemon is unreachable, refuses, or answers with no boolean | deny |
| The classifier is unavailable or answers invalidly | deny |

The settings file also asserts `disableAllHooks: false` at the highest precedence. The agent can write a `settings.local.json` in its own lane, and that must not switch the judge off for the next session.

Decisions are remembered per run, keyed on lane, tool and input, bounded at 512. Only answered decisions are remembered. An agent runs the same test command dozens of times a phase.

**The shipped question draws the lines a classifier will not draw for itself.** Because the judge fails closed, an over-cautious question does not look broken; it looks like a run that stalls. The first wording set "reading credentials or secrets" beside "reads files inside that worktree" with nothing between them, and in a field run it allowed 44 of 69 real commands: listing `.env*`, reading `.env.example`, `docker ps` and the project's own `make` targets were refused. A project-specific question that drew those lines allowed 170 of 178 at 0.7 and refused all 21 must-deny commands (reading `.env` values, force-push, `docker compose -p <other project> down -v`, `sudo`; highest score 0.47). `PERMISSION_QUESTION` now draws the same lines without naming a project: a secret is a *value*, so listing which env files exist or reading a template is safe and reading a real one is not; read-only inspection (`ls`, `git status/log/diff`, `docker ps/logs/inspect`) and the project's own commands in the worktree (make, npm/pnpm/yarn scripts, the worktree's own compose stack) are safe; pushing, git config or remotes, writes outside the worktree, another project's containers, volumes or databases, `sudo`, system installs and sending data out are not. `allow_above` stays 0.9: the 0.7 above was measured for a different question, and a default threshold moves only on a calibration of the shipped one. A project's own `question` and `allow_above` are where a measured project-specific answer goes.

**`judge calibrate`** is how that is measured. It replays commands through `judgePermission` itself — same rendering, labels and fail-closed reading — against a candidate question and threshold (defaults: the `--system-one` config's permission judge, else the shipped question and 0.9). Commands come from a run (`--run`: every `tool_use` of a judged tool in its `transcript.jsonl` files, once per distinct command) or a file (`--commands`: a line per command, optionally `safe<TAB>` / `unsafe<TAB>`, or `{"command", "expect"}` JSON lines). The `cwd` the classifier sees is a lane path under the lane root. It reports allowed and refused counts (unanswered among the refused), a ten-bucket histogram of the weight on `safe`, every labelled command judged the wrong way, the highest-scoring must-deny and lowest-scoring must-allow, and the refused unlabelled commands highest score first; `--json` gives every command with its score. It exits 1 when a labelled command is misjudged. Only commands are printed, as recorded: never a `tool_result`, which is where a command's output — and any secret it printed — would be, and never a classifier's error text, only its kind.

What `judged` is **not** is a sandbox. A classifier reads one command line and cannot see what a script it names will do. The editing tools are not judged; they keep the sibling-lane deny rules `auto` has. So `judged` narrows `full` without approaching `auto`: it trades a vendor prompt nobody would answer for one round trip per command. Only claude-code can host it, because neither codex nor opencode offers a per-call hook. `doctor` refuses `judged` for a plan that dispatches elsewhere, and for a config with no `permission` judge. The coordinator runs at `auto` under `judged`: it acts through the run's API and `exec`, not through a lane's write grant.

### 17.7 Not done here

- **Review-tier routing.** Classify a phase's diff (mechanical / architectural / schema) and pick the review loop's reviewer tier from that, instead of always asking for the most capable one.
- **Fix-loop repetition.** Ask whether round N's findings repeat round N−1's, and escalate to the fresh last round (§15.5) early.
- **Refusal classification.** Classify spawn refusals the regex patterns miss (§7's "unrecognized is fatal"), with `fatal` below the threshold.
- **opencode's permission API.** It could host `judged` through its session permission events instead of a hook.
- **Plan time.** `plan-feature` does not emit judge gates. That is deliberate for now; judge gates are hand-authored.

## 18. Project configuration

### 18.1 Layers

A plan's workflow file is resolved over the project's `.vinta-ai-workflows.yaml` before it is validated (`src/config/resolve.ts`). The layers, lowest first: `commands.*` (shared with `implement-plan`), `maestro.*`, the workflow file, and the run's own amendments. Maps keyed by id merge per id, with the higher entry replacing the lower one whole. A typed gate (`type: test | lint | typecheck | e2e`) is the exception and merges field by field. Lists replace, and plain objects merge per field. Every gate type the project has a command for is available under the type's own name.

`WorkflowSchema` describes the *resolved* document: what a run freezes, executes and amends. `AuthoredWorkflowSchema` describes the file, in which a typed gate may omit `cmd` and `base_branch` may be omitted. The generated `workflow.v1.schema.json` is the authored one. `runs/<id>/sources.json` keeps the layers a run was resolved from, because a resolved document cannot be re-resolved.

The editor shows the resolved document and saves a patch (`src/config/own.ts`). The stored file is resolved the same way, the two resolved documents are diffed, and only what changed is written back to the file. Writing the resolved document would freeze the project's values into the plan.

### 18.2 The plan branch

`startRun` ensures `plan/<workflow-id>/base` before it creates anything (`src/run/plan-branch.ts`):

- **Missing:** cut from `base_branch`.
- **Contains `base_branch`:** reused.
- **Only behind:** moved forward, unless a worktree has it checked out.
- **Diverged:** refused.

A resume reuses the branch as it is. Lanes, the integration worktree and dependency-free phases use the branch as their base (`IntegratorOptions.runBase`), and the PR bases do not change.

`src/config/reload.ts` polls the branch. When new commits touch the config file or the plan's workflow file, it reads both at the new commit, resolves them, and submits the result to `amendRun` as author `config` with the commit as `source`. Before submitting, the proposal is pinned:

- every target of an `operator`, `coordinator` or (historical) `monitor` amendment in this run keeps the run's value;
- every started node keeps its definition;
- `base_branch` never moves.

A `nodes_in_flight` refusal is retried on the next tick. Any other refusal is journalled as `config_reload` and the commit is passed over. Every `workflow_amended` row now carries `targets`, computed for non-monitor authors, which is what the pinning reads.

A gate-table change is live-safe for a node that is `done` as well as for one in flight. It changes nothing the node built, so it is not a rewrite of that node.

### 18.3 Scoped gates

A command gate may carry `scoped_cmd` with `{changed_files}` / `{touches}`. Under `defaults.gate_scope: scoped`, a phase's gates run it until its review approves — the `gate` state and an agent's `gate` verb (`src/gates/scope.ts`). `standard-phase`'s `verify`, after the review approves, runs `run_gate` with `scope: 'full'`: every gate's whole `cmd`, so a PR never ships a suite only a scoped run saw. The fact it leaves says `scope: 'full'`, and a fixer answering it is told so and to check with `gate <id> --full`, which runs the whole command as a flight of its own. The two forms are cached apart, on their own commands. `defaults.verify_gates: scoped` keeps `verify` on the scoped form, for a suite too slow to run once per phase; the merged-tree gates are then a phase's first full run. Both settings, like `wave_gates`, may be set in a plan's `defaults` or a project's `maestro.defaults`, and the coordinator may tighten them, never loosen them. Each placeholder is filled shell-quoted. When a placeholder would be empty, the gate runs `cmd`. After a wave merges, the full `cmd` of every gate its members ran narrowed runs once in the integration worktree, without pools and uncached, and is journalled as `wave_gate_result`. If it is red, the merge fails with `WaveGateError`.

A scoped line inherited from `commands.test_unit_scoped` / `lint_scoped` must contain a placeholder; a skill-era line without one (`pytest <app>/tests/`) is not inherited. Because a phase gate with no `scoped_cmd` silently runs `cmd`, `doctor` warns (`gate-scope:<gate>`) for every `test`/`lint` gate a phase uses that has none under `gate_scope: scoped`, naming whether a placeholderless line was passed over or nothing is configured; the preflight repeats it as a startup line. It is a warning: the run is correct, only slower — one observed run spent two of its five hours running a 6,500-test suite on every phase gate and fix round.

**The first red gate is the answer, for an agent's gates too.** The gate node stops at the first red gate. An agent's `gate <id>` is refused (`earlier_gate_red:<gate>`) while a gate declared before it on the node has a red cached result for the lane's current tree; it runs once the tree moves. Read off the cache, so it costs no run; a stale red there is cleared by running the earlier gate with `--no-cache` (§13.4). Agents check gate by gate, and a red typecheck did not stop a `for g in lint typecheck test` loop from running a 400-second suite whose result the next round threw away.

### 18.4 The gate guard

A claude-code `PreToolUse` hook (`guard-hook`) is installed for every spawn in every permission mode, through the per-lane `--settings` file. It asks the daemon (`POST /api/runs/:runId/guard`), which matches the Bash line against two things: the gates' full commands, and the `match` patterns of semaphore pools that are not leased through `with` (`src/guard/match.ts`). Scoped forms are not matched as gates, because they are indistinguishable from inner-loop work. A hit is refused with the verb to use and journalled as `bare_gate_blocked`. A third rule refuses `vinta-ai-maestro gate` run inside `vinta-ai-maestro with` (`rule: nested_gate`), telling the agent to run the gate on its own, because inside `with` it waits on the pool its own command holds (§8). The hook fails open and never answers "allow". On codex and opencode the scheduler checks each `tool_use` after it ran and journals `bare_gate_detected`. `doctor` reports each harness as `gate-guard:<harness>`.

### 18.5 Not done here

- **opencode enforcement.** Its plugin API could host the guard before a call runs.
- **A plan branch on a remote.** The reload reads the local ref, and a commit pushed from another machine is not fetched.

## 19. Plan review

A plan is cheapest to fix before anything has run, and a reviewer who sees only the markdown sees half of what will happen. The other half is three things: the graph, the prompts each agent will be sent, and the gates each phase must pass. Plan review puts all of it on one page and gives the reviewer a channel back to the agent that wrote the plan.

This does not make maestro a plan author, so the §1 non-goal stands. The agent that ran `plan-feature` still writes and edits the plan. Maestro serves the page, stores the review, and relays the conversation.

### 19.1 The page

`#/plans/<workflow-id>`, under a **Plans** section beside Runs, Editor and Logs. `vinta-ai-maestro review open <workflow.json>` serves the UI as `ui` does and prints a URL deep-linked to the page.

| Tab | Contents |
|---|---|
| Graph | `vinta-dag-editor` in read mode, wave-banded, with each node coloured by **review state** rather than run state. Four run statuses are borrowed for their tone and relabelled through the canvas's `strings`: no comments, open comments, comments resolved, has issues. Below the graph is the selected phase: staffing, the standard pipeline as a strip of steps, dependencies and dependents, touches, and tabs for its brief, its implementer and fixer prompts, its gates and its chores — the review chore's prompt among them (§16) |
| Plan | The markdown cut at every `#`–`###` heading outside a code fence. Each section is commentable and each selection quotable. A phase's section links to its node |
| Gates | A phase × gate matrix over the resolved workflow, then each gate's command, scoped command, timeout and pools, the resource pools, and the chores |
| Schedule | §13.1's projection drawn as a timeline with the critical path marked. It reads `GET /api/plans/:id/schedule` |
| Issues | `validate`'s issues, each linked to its node where it has one |

**The prompts are composed, not described.** `GET /api/plans/:id` calls `composeSpawnPrompt` for every role and every chore over a journal with no history (`src/review/plan.ts`). What the page shows is therefore the cold prompt a run would send, with three exceptions. A run names its lane's path where the page names the checkout. Its branch line is the phase branch, not `HEAD`. And it appends each dependency's final report. A reference that leaves the repository, or a graph with a cycle, blocks composition. The brief still shows and the issue list says why.

**References are contained.** The page reads files named inside a document, on a browser's request, so every `plan_ref`, `prompt_ref` and `plan_context_refs` path is resolved inside the checkout, after following symlinks, before it is read. Anything else is an issue and is never opened (`src/review/references.ts`). Plan ids are the workflow schema's kebab-case, as on the editor's routes.

### 19.2 The review document

`ai-plans/<id>.review.json` sits beside the plan and is committed with it. It is generated from `src/review/document.ts` as `schemas/plan-review.v1.schema.json`. It holds:

- **Comments.** Each comment has an anchor: the plan, a section, a phase, a role's prompt, or a gate, optionally on a phase. It can carry a quote, replies, and a status of open or resolved.
- **A conversation.** Messages and one approval.
- **A status.** Open or approved.

A person's comment is a **draft** until it is sent. One "Send to agent" message carries every unsent thread by id, the way a code review is submitted. A person's new reply on a sent thread makes the thread unsent again. Writing after approving reopens the review.

Every change is a pure function over the document. `src/review/store.ts` applies it as a read-modify-write under an exclusive lock file, with atomic writes. The daemon and the agent's CLI are separate processes editing one file, and the lock is what lets them do it safely. A review file that does not parse is never overwritten.

**The browser writes only as the person.** A request body names no author; the route stamps `human`. The agent writes only through `review reply`. A page that could post as the agent would let anyone holding the token put words in its mouth that the agent would later read back as its own.

### 19.3 The agent's loop

The agent is whatever session ran `plan-feature`. It is not hosted by maestro, and there is no harness adapter in the loop. It runs shell commands:

- `review wait <workflow.json>` blocks until a person's message is undelivered. It marks the message delivered under the lock and prints one JSON object. The object holds each message, and each sent thread spelled out with a `where` in words, its anchor, its quote, its body and its replies. It also prints `kind: "approved"` when the last thing the person did was approve. After `--timeout` it exits 0 with `kind: "timeout"`, because agents have a ceiling on how long one command may run.
- `review reply <workflow.json> -m …` posts to the conversation, or with `--comment <id> [--resolve]` to a thread.

While it waits, `wait` beats a heartbeat into `.vinta-ai-maestro/reviews/<id>.listener.json`, which holds a pid, the time it started listening, and the last beat. That file is per-machine and gitignored. The page shows one of three states:

- **listening:** a fresh beat from a live pid.
- **working:** the agent picked up a message and has not answered yet, within thirty minutes of its last beat.
- **away:** neither. The away state prints the exact `review wait` command, so any session can attach.

The page polls the review every two seconds, along with a stamp of every file the view is built from: the workflow, `.vinta-ai-workflows.yaml`, and the plan files the references name. It rebuilds the view only when the stamp moves, which is how an edit the agent makes appears without a reload.

### 19.4 Validation

`vinta-ai-maestro validate <workflow.json> [--json]` runs the load a run does, `resolveWorkflow` over the project configuration. It then runs two checks that only a run used to perform: that the filename stem is the id, and that every reference names a heading that exists. `plan-feature` runs it on every workflow it writes when maestro is installed, and the review page shows the same issues.

### 19.5 Not done here

- **A hosted reviser.** When no agent is listening, messages wait. Spawning a harness to answer them would add an author maestro would have to permission. A §17-style adapter for that is the natural next step.
- **Multi-reviewer identity.** A comment's author is `human`, with an optional name. Runs are operator-owned (§1), and so are reviews.
- **Line-anchored comments on the plan.** Anchors are headings, not lines. A heading survives the edits a review causes; a line number does not.
