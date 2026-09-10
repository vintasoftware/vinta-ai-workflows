# vinta-flow — specification

**Status:** decisions settled — O1–O8 all resolved (§14). Ready for implementation; nothing is implemented yet.
**Packages:** `vinta-flow` at `packages/vinta-flow/` (name free on npm), and `vinta-dag-editor` at `packages/vinta-dag-editor/` (private for now).
**Method:** written under the [Karpathy guidelines](https://github.com/multica-ai/andrej-karpathy-skills/blob/main/CLAUDE.md) — assumptions stated rather than buried, minimum machinery per unit, every implementation step paired with a verification check.

Simplicity here is a **sequencing strategy, not a scope cap**. Each unit is built as the smallest thing that can be verified, so risk is retired early and cheaply; the destination is still the complete product described below, reached by iterating over these units rather than by cutting them. "Not yet" is a valid answer in this document; "not ever" is only used where a non-goal is stated as such and justified.

---

## 1. What this is

`vinta-flow` executes a `plan-feature` plan as a real, code-orchestrated run: it schedules independent phases concurrently across git worktree lanes, drives coding agents through installed CLIs, queues expensive gates behind capacity limits, and gives the user a live graph, per-agent logs, and a way to steer any running agent mid-flight.

Today `implement-plan` *is* the orchestrator, written as a prompt. That prompt is the starting specification this daemon implements. The partials under `skills/vinta-derive-skills/resources/plan-execution/partials/` — `parallel-lanes.md`, `implementer-prompt.md`, `worktree-seam.md`, `review-layers.md`, `commit-strategy/` — are the input this document was written from, and remain the shared description of the semantics both implementations follow. They are not, however, a constraint on it: see [Relationship to the skills path](#relationship-to-the-skills-path).

### Scope

**Required. The product is not finished until every one of these exists:**

- Workflow JSON as the executable artifact, with a JSON Schema and a visual editor.
- Continuous DAG scheduling with worktree lanes, matching the semantics already specified in `parallel-lanes.md#LANE_SCHEDULER`.
- Named resource pools with capacities, so costly gates (test suite, e2e) queue instead of stampeding.
- Three harness adapters: `claude-code`, `codex`, `opencode`.
- Subscription auth only. The daemon never handles an API key.
- Live directed-graph view, per-agent transcript view, per-agent interaction (interrupt, redirect, add context), and PTY takeover.
- Crash-safe resume.
- Integration: dependency-derived phase branches, wave merges, conflict fixer, PR opening.
- **Graceful degradation under harness capacity limits** (§6.1). A vendor saying "not right now" is backpressure, not failure: the node waits and resumes automatically.
- **Browser and OS notifications**, with `await_human` questions answerable directly from the UI (§9).
- **Windows**, after macOS and Linux are complete, tested and polished (Wave 7).
- The additions in §13, which are part of the product rather than extras.

**Deferred — wanted, sequenced after the above:**

- Multiple concurrent runs and multiple projects per daemon. One project per daemon is a v1 boundary, not a design limit; the journal is already keyed by `run_id`.
- Distributing agents across machines. The browser UI already lets the *daemon* live on a remote box, which covers the actual need; a scheduler that farms nodes to a fleet is a different product and should not be designed for speculatively.

**Non-goals, stated so they don't get built by accident:**

- Authoring plans. `plan-feature` keeps that job; `vinta-flow` executes and reports back (§13.6).
- Multi-user access control. Runs are operator-owned; anyone who can reach the daemon can drive it, which is why it binds loopback behind a token.
- Speculative execution — starting a node on a dependency that is reviewed-green but not yet merged. It would cut latency on deep chains, and it makes every rollback path a partial-rebase problem. Revisit only with a measured critical path (§13.3) showing it would pay.

### Relationship to the skills path

Decided: **coexist.** `vinta-ai-workflows` must keep working with no daemon installed — that zero-install property is its entire value proposition for client repos. `vinta-flow` is an upgrade for projects that opt in.

**Where they conflict, the skills change to accommodate `vinta-flow`.** The partials remain the shared vocabulary — both implementations are readings of one description of the same semantics — but they are not a veto. If a skill's current shape blocks something the daemon needs, the skill is amended rather than the daemon contorted around it. The zero-install path stays working; it does not get to freeze the design.

The standing cost is two implementations of one spec. The mitigation is direction: a semantic change is decided here, then written into the partial, then read by both.

---

## 2. Constraints

| Constraint | Consequence |
|---|---|
| No API keys — subscription/OAuth auth only | Adapters are process supervisors driving already-authenticated CLIs, never API clients. Preflight verifies login; if absent, the user logs in themselves. The daemon never prompts for, stores, or forwards a credential. |
| The root CLI's zero-runtime-deps property is load-bearing | `vinta-flow` is a separate package. Nothing it needs may enter the root `dependencies`, and the root `files` whitelist must continue to exclude `packages/`. |
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
    workflow.v1.schema.json   # NEW: generated from vinta-flow's zod, committed here
  packages/
    vinta-flow/
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

**Two packages.** The daemon and its React UI stay together in `vinta-flow` — they share type definitions by importing the same `src/types.ts`, and splitting them would require a `workspace:` dependency and a build-order dance to buy nothing.

`vinta-dag-editor` is separate because it is a genuinely reusable component with a different consumer profile, and because extracting it to npm later should be a `pnpm publish`, not a refactor. It is **built as a sibling to `vinta-state-machine-editor` and deliberately mirrors its architecture**: a framework-agnostic Web Component in plain strict TypeScript, Vite + Biome + Vitest, deeply readonly data with new objects returned on every change, no data ownership (the host injects catalogs; the component never fetches or authenticates), a host-owned `data` passthrough blob on every node and edge, all labels from a `strings` object, and semantic HTML with keyboard support. Same conventions, same shape, different graph kind — so a developer moving between the two packages is not learning a second set of rules.

It renders and edits **plan DAGs**: nodes with status, wave banding, edges labelled with the dependency artifact, pan/zoom, auto-layout, and edit affordances (add node, draw dependency, delete edge). `vinta-flow` consumes it via `workspace:*` in both the live run view and the workflow editor — the same component in two modes, which is what keeps the run view and the editor from drifting apart.

`.gitignore` gains `.vinta-flow/`.

---

## 4. Architecture

```
  ┌─────────────── browser (localhost or port-forward) ────────────────┐
  │  React app: run graph · node detail · transcript · xterm · editor  │
  └───────────────────────────┬────────────────────────────────────────┘
                    HTTP + WebSocket (127.0.0.1, token)
  ┌───────────────────────────┴────────────────────────────────────────┐
  │  vinta-flow daemon (Node 22+)                                      │
  │                                                                    │
  │   Scheduler ── Resource pools ── Gate runner                       │
  │       │              │                                             │
  │   Pipeline interpreter (state machine per node)                    │
  │       │                                                            │
  │   Harness adapters      Lane manager        Journal                │
  │   claude-code│codex│    git worktrees +     SQLite events +        │
  │   opencode              DB forks            transcript files       │
  └───────────┬──────────────────┬─────────────────────┬───────────────┘
        child processes     git / compose        .vinta-flow/
```

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
- **The phase pipeline** (`pipelines`) is a state machine — implement → review → fix → gate → integrate, with guards and side effects. This is what `vinta-state-machine-editor` edits.

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
| `spawn_agent` | `role`, `prompt_template`, `harness?`, `model?` | `role` ∈ implementer, reviewer, fixer, conflict-fixer |
| `run_gate` | `gate` | Acquires the gate's resources first |
| `git_branch` | `from` | `from` resolves via the dependency-derived base rule |
| `git_merge` | `branch`, `strategy` | `--no-ff` for lane merges; never squash |
| `git_push` | — | |
| `open_pr` | `base`, `draft` | |
| `write_tracking` | `scope` | `run` / `phase` / `wave` |
| `await_human` | `reason` | Releases gate resources immediately; lane retention per §6 and O3 |
| `notify` | `channel`, `text` | |

Guards are expressions over a small documented context: `review.verdict`, `gate.exit_code`, `human.answer`, `fix_rounds`, `node.*`, `run.*`. Evaluated by a tiny hand-written evaluator — **never `eval` or `new Function`**. A guard is author-supplied data in a tool running with the developer's full permissions; treating it as code turns "someone edited my plan" into arbitrary code execution. Safety is structural rather than a blocklist: the root identifier is allowlisted at parse time, every path step goes through `Object.hasOwn`, and the grammar has no call syntax at all, so `f(x)` is a parse error rather than a sandbox to escape.

**`fix_rounds` is host state, supplied by the scheduler.** The interpreter cannot know which state means "fix" without special-casing an author-chosen state id, which would stop it being a general state machine. It arrives as a fact like any other.

The default `standard-phase` pipeline ships with the package:

```
implement ──▶ review ──┬─ verdict=pass ──▶ gate ──┬─ exit=0 ──▶ integrate ──▶ done
                       │                          └─ exit≠0 ──▶ fix ──▶ review
                       └─ verdict=fail ──▶ fix ──▶ review
fix ── guard: fix_rounds >= node.max_fix_rounds ──▶ failed
```

### 5.3 Journal and on-disk layout

```
.vinta-flow/                      # gitignored, inside the project
  flow.db                         # SQLite
  runs/<run-id>/
    workflow.json                 # frozen snapshot at run start
    nodes/<node-id>/
      transcript.jsonl            # normalized AgentEvent stream, append-only
      raw.jsonl                   # harness-native stream, append-only
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

Semantics are already specified in `parallel-lanes.md#LANE_SCHEDULER`; this implements them. A node is dispatched when **every dependency is `done`**, it is **not blocked**, and **all its required resources can be acquired**. Waves exist as a durable spine — the resume anchor, the merge target, the reporting unit — but a node's start gate is its own dependency set, not its wave filling or draining.

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
  | { ok: false; kind: 'rate_limit' | 'concurrency' | 'quota' | 'transient' | 'fatal';
      retryAfter?: Date; message: string }
```

Only `fatal` — a missing binary, a broken workflow, an unauthenticated CLI that preflight somehow missed — fails the node. Everything else returns it to the ready set.

**Resources are released before waiting — but only while the lane is still empty.** The rule splits on whether the node has produced anything yet:

- **Refused at dispatch**, before any agent has run: release the lane and every gate slot, and go back to pending. Nothing is lost, and holding a lane here starves the pool to do no work — with a shared quota it deadlocks the whole run, every lane held by a node that cannot start. This is the case §6.1 was written for.
- **Refused mid-pipeline**, when a reviewer or fixer spawn is turned away after the implementer has already worked: **the lane is pinned and the node waits in place**, releasing only its gate slots. The lane *is* the work. Releasing it discards a completed implementation and makes the re-dispatched node redo it, so a transient rate limit would cost hours of model time — a far worse outcome than an idle worktree.

These do not conflict. The dispatch-time deadlock is caused by nodes that have done *nothing* holding lanes; a node mid-pipeline is not waiting to start, it is waiting to continue, and its work has to live somewhere until it does. A run whose in-flight nodes are all waiting on a quota window is stalled either way — pinning only decides whether it resumes or restarts.

Resuming in place needs the harness's session id (`AgentTask.resumeSessionId`), which is why `resume` is a declared capability rather than an optimization.

**Per-harness admission control, adaptive.** Each harness has an effective in-flight ceiling, starting at its configured value. On a `concurrency` or `rate_limit` refusal the ceiling halves (floor 1); after a run of clean spawns it increments by one back toward the configured value. Additive-increase/multiplicative-decrease, because the real limit is undocumented, varies by account and plan, and changes under us — so it has to be discovered and re-discovered rather than configured.

**Waiting is honest and durable.** Backoff is exponential with full jitter, except when the harness reports an actual reset time, in which case that time is used rather than guessed. A `quota` wait can last hours: such a node enters `waiting_on_capacity`, is rendered as such in the UI (not as an error), notifies the user once, and **journals its wake time** so a daemon restart resumes the wait rather than losing or re-firing it. Waiting nodes are never busy-polled — one timer per harness, not one per node.

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

**`usage` is cumulative and terminal-only.** One event per session, emitted from the harness's final frame. Per-message usage is a delta while the session total is their sum, so emitting both would make any consumer that adds `usage` events double-count. Settled here because the transcript format should not be frozen with this ambiguous. A UI wanting live token counts needs a second, explicitly-delta variant — not a reinterpretation of this one.

**An unrecognized spawn refusal is `fatal`.** An unrecognized failure is by definition not a recognized capacity signal, and treating it as a wait converts a deterministic misconfiguration into a run that stalls forever instead of reporting. The opposite default would need a retry ceiling to be safe, and none is defined. This is the classification most likely to want revisiting once real vendor output has been collected across all three harnesses.

| Harness | Invocation | inject | resume | pty | Notes |
|---|---|---|---|---|---|
| `claude-code` | `claude -p --output-format stream-json --input-format stream-json --verbose` | ✅ native | ✅ `--resume` | ✅ | The only one with true bidirectional stdio; steering is a message on stdin. Also has `--permission-mode` and hooks. |
| `codex` | `codex exec --json` | ❌ | ✅ | ✅ | JSONL out, one-way. Steering = interrupt, then resume with an amended prompt. |
| `opencode` | `opencode serve` + official TS SDK | ✅ session API | ✅ | ➖ | An HTTP server rather than a supervised pipe; the richest control surface, and the adapter manages a server process rather than one process per agent. |

**Preflight is a hard gate.** Before a run starts, every harness the workflow references is checked for presence and authentication. A missing login is reported with the exact command the *user* runs to log in. The daemon never performs an authentication flow and never touches a credential store.

**Headless by default; PTY for takeover.** Orchestrated runs use structured JSONL — parseable, resumable, journal-able. Interactive takeover is a separate mode: interrupt the headless session, hand its **session id** to an interactive CLI in a PTY, and on detach resume headless from the same id. Trying to make one session simultaneously machine-parseable and human-drivable is the trap; the session id is the handoff token.

For `claude-code` and `opencode`, the common case — "add context", "go a different direction" — needs no PTY at all: it is a message injected into the live session, rendered in the UI as chat. PTY is the fallback path and the raw-log escape hatch.

---

## 8. Lanes, gates, integration

**Lane manager.** A pool of `capacity(lane)` worktrees plus one integration worktree, provisioned once per run and reused across nodes, per `parallel-lanes.md#LANE_WORKTREE_POOL`. Teardown is never automatic.

**`vinta-flow` does not invent database provisioning.** `prepare-worktree` already specifies this, and the daemon delegates to it and reads back the summary it writes at `.vinta-ai-workflows/worktrees/<name>.yaml`. The strategies that matter here, in that skill's terms:

- **Template clone is what makes N lanes affordable.** The template DB is created or refreshed **once**, and each lane clones from it (`createdb -T <main_db> <main_db>_wt_<lane>` on Postgres; dump/restore on MySQL; file copy on SQLite). N lanes cost N cheap clones against one shared server, not N database servers.
- **Provisioning has two serialization points, not one.** The template is the obvious one. The other is **`git worktree add` itself**: git rewrites `.git/worktrees/` on every add and concurrent adds corrupt each other's metadata — this was found the hard way, as a reproducible failure, not theorized. Add worktrees one at a time; everything a lane actually costs time for (dependency linking, DB cloning, summary writing) still overlaps around it.
- **A global/external DBMS is the cheap delivery mode**, and the one to prefer for pooling: forking means a new *database* on the already-running server, not a new server.
- **Compose-delivered DBs always fork their data volumes**, unconditionally. Two server processes on one data directory corrupts the store, so this is not a tunable. Each lane gets its own `COMPOSE_PROJECT_NAME`.
- **Test databases are per-lane by name** (`<main_db>_test_wt_<lane>`), injected through the channel the runner already reads — an env var or a worktree-local override, never an edit to tracked config.
- **`reset_cmd` per forked DB** is what makes a lane reusable across a migration boundary. **A lane whose databases have no `reset_cmd` is single-use** and is re-provisioned rather than reset.
- **Reuse resets the worktree too, not only the databases** — checkout the lane's branch, hard-reset to its base, and clean untracked files (keeping the linked dependency tree, which is what lets a lane run a gate at all). Otherwise the next phase in that lane starts on the previous phase's branch and files. Order matters: cleaning *after* a database reset would delete the database file the reset just restored. The two `recycle` outcomes must be equivalent, and the re-provision branch already yields a clean worktree.
- **Recycling happens at hand-over, not at release.** The lane released by the *last* phase to use it is never handed on, and its worktree, branch and databases are the evidence a human reads afterwards — resetting at release would wipe that in every run, which is precisely what "teardown is never automatic" forbids.
- **The disk probe runs against `lanes + 1`**, not 1× and not N× — the integration worktree costs the same disk as a lane. It refuses to provision rather than filling the disk halfway through wave 1, and it runs *before* any worktree is created so a refusal leaves nothing behind.

**Seeds and fixtures are the project's, never ours.** `vinta-flow` runs whatever seed command the project already has, recorded during worktree provisioning; it ships no fixture set and makes no assumption about what a fresh database should contain. The one exception is `vinta-flow`'s own test suite, which needs a small fixture repository to run its contract and E2E tests against (§14, O2) — that fixture exists to test the daemon, and is never presented to users as a template.

Sandbox denies the whole pool root and allows back only the running lane, so an agent cannot write into a sibling lane that is mid-implementation.

**Gate runner.** Gates are declarative (`cmd`, `requires`, `timeout_s`), run in the node's lane, stream output to `gates/<id>.log`, and report an exit code. A gate is not an agent — no LLM is involved — which is exactly why it can be queued behind a capacity limit without wasting a model turn.

**Integration.** Branch topology follows dependencies, not plan order: no dependencies cuts from `base_branch`; exactly one cuts from that node's branch; several cut from an `integ-<id>` merge of them, merged in `depends_on` declaration order so the result is deterministic and derivable from the node alone. `wave-0` *is* `base_branch`; each later wave merges into `wave-<N>`. Merge conflicts are handed to a conflict-fixer agent in the dedicated integration worktree and re-enter the gate.

A conflict surviving its fixer-round budget is reported as a plan defect — two same-wave nodes own the same code — naming **both** nodes and the contested paths, and the conflicted merge is left in place because it is the only copy of what the fixer attempted. **That budget is an integration-level setting (default 2), not either node's `max_fix_rounds`**: a conflict belongs to a pair of nodes, so deriving it from one would make the answer depend on which node happened to merge second.

**A resolved conflict is confirmed by scanning the files, never by asking git.** `git add` clears a path's unmerged flag whether or not conflict markers remain in it, so git's index cannot answer "did the fixer actually fix it". Without the scan, a fixer that did nothing produces a merge commit full of markers that passes into the wave branch unnoticed.

---

## 9. Interaction model

Five operations on a running node, exposed in the UI and over the API:

| Operation | Mechanism |
|---|---|
| Add context | `session.send(text)` where `capabilities.inject`; otherwise queued and delivered on the next resume |
| Redirect | interrupt, then send the new instruction (or resume with an amended prompt) |
| Pause | finish the current turn, then `await_human` (§9.1) |
| Abort node | kill the session; mark failed; dependents blocked |
| Take over | interrupt → PTY attach → detach → resume headless |

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

**A paused node keeps its lane** and releases its gate resources immediately. This resolves O3: the human is being asked about work in progress *in that lane*, the diff and log views read from it, and a takeover attaches to it. Releasing it would destroy the thing the question is about. Idle disk is the cheapest resource in the system; the gate slot, which is the expensive one, is freed at once.

**Amending a live run.** Editing the workflow while a run is in flight is not a live mutation of the snapshot. It produces an amendment applied at a safe point: nodes not yet started take the change immediately; nodes already `done` whose dependency closure changed are rebased in topological order, `integ-` bases rebuilt first. Amending is **refused while any affected node is running** — matching the rule `amend-plan` already states.

---

## 10. UI

React + Vite, served by the daemon at `127.0.0.1` behind a random per-run token in the URL. Chosen for mature `xterm.js` bindings, virtualized log views, and the general ecosystem weight the app shell needs. Both graph surfaces are Web Components and mount unchanged: `vinta-dag-editor` (ours, §3) for the plan DAG, `vinta-state-machine-editor@0.10.0` for pipelines.

| View | Contents |
|---|---|
| Runs | List, status, elapsed, resume/purge |
| Run | Live DAG via `vinta-dag-editor` in read mode — node status colors, wave banding, edges labelled with the dependency artifact. Resource pool meters, the gate queue with positions, and per-harness capacity state (§6.1). |
| Node | Transcript (chat-rendered normalized events), gate logs, `git diff` for the node's branch, the steering box, the pending human question with its context (§9.1), and the five operations from §9 |
| Terminal | `xterm.js` over WebSocket — PTY takeover and raw stream tailing |
| Editor | `vinta-dag-editor` in edit mode (add node, draw dependency, set gates/harness/model) plus `vinta-state-machine-editor` for pipelines |

The run view and the workflow editor are **the same component in two modes**, which is what keeps them from drifting into two different pictures of the same graph.

Notification permission is requested on first run, not on page load, and the UI degrades to an in-page banner when it is refused — the OS-notification channel from the daemon is unaffected either way.

Transport: HTTP for commands and snapshots, one WebSocket for the event stream and PTY bytes. The UI holds no authoritative state — it renders a projection of the journal, so a reload mid-run is free and two browsers can watch the same run.

---

## 11. Security and data handling

- Binds `127.0.0.1` by default. A random token is required on every request including the WebSocket upgrade. `--host` for remote access is explicit, printed with a warning, and never the default.
- **No credentials, ever.** No API keys, no token storage, no login flows. Auth lives entirely in the harness CLIs the user already logged into.
- Transcripts and gate logs contain repository contents verbatim. They stay inside the project under `.vinta-flow/` (gitignored), never in a global cache directory. `vinta-flow purge <run-id>` and a documented retention default.
- Structured log fields carry opaque identifiers — run id, node id, session id — never file contents or record data.
- The existing worktree sandbox deny-rules apply per lane, plus the pool-root deny that keeps lanes from writing into each other.

---

## 12. Implementation plan

Steps are phrased as Karpathy's `step → verify` pairs. Dependencies are declared so this plan can itself be run in parallel lanes — which is also the most honest dogfooding test available.

**Wave 1 — foundations (independent)**

| # | Step | Depends on | Verify |
|---|---|---|---|
| 1 | pnpm workspace + `packages/vinta-flow` and `packages/vinta-dag-editor` skeletons, TS configs, `.gitignore` entry | — | `pnpm -r typecheck` passes; `node vinta-ai-workflows.mjs list` still succeeds; `npm pack --dry-run` at root lists exactly the same files as before |
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
| 23 | `vinta-flow doctor` | 4, 6 | On a deliberately broken environment, each of: missing harness, unauthenticated harness, no worktree support, missing `reset_cmd`, insufficient disk is reported with the exact remedy |
| 24 | Dry-run / simulation mode | 10 | A workflow with known durations simulates to a predictable schedule; a workflow whose graph deadlocks is caught without spawning an agent |
| 25 | Gate result caching | 8 | A gate re-run against an unchanged tree hash is skipped; any tree change invalidates; `--no-cache` forces |
| 26 | Cost and token accounting | 6, 3 | Per-node usage aggregates to run totals matching the harnesses' own reported figures |
| 27 | Critical-path and queue analytics | 24, 26 | On a recorded run, the reported critical path matches a hand-computed one; queue-wait and capacity-wait attribution sum to observed elapsed |
| 28 | Run replay | 3, 14 | Scrubbing a finished run reproduces every intermediate DAG state from the journal alone |
| 29 | Plan post-mortem → `plan-feature` | 27, 21 | A run with a known undeclared dependency and a known same-wave file conflict produces a post-mortem naming both |

**Wave 6 — polish and release (macOS + Linux)**

| # | Step | Depends on | Verify |
|---|---|---|---|
| 30 | Docs, `vinta-flow purge`, retention defaults, CHANGELOG, UI polish pass | all | `README` walkthrough reproduces a two-phase parallel run end to end on the fixture repo, from `plan-feature` output to merged wave branch |

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

**13.4 Gate result caching.** Key a gate result on `(gate id, git tree hash of the lane)`. Fix loops re-run the same suite against unchanged trees constantly, and the test suite is by construction the most expensive resource in the system. Invalidate on any tree change; `--no-cache` to force. Small, and it directly relieves the bottleneck that §6's queue exists to manage.

**13.5 `vinta-flow doctor`.** Preflight everything before a run: harness presence and authentication, git version and worktree support, each forked DB's `reset_cmd`, compose availability, disk headroom for N lanes. Nearly every failure this system can have at minute zero is in that list, and discovering them one at a time across a half-started run is the worst way to learn them.

**13.6 Plan post-mortem fed back to `plan-feature`.** A run knows things the plan's author could not: dependencies that were declared but never used, dependencies discovered at gate time that were missing, same-wave nodes that actually conflicted, and phases whose real duration diverged wildly from their wave placement. Emit that as a structured post-mortem the `plan-feature` skill reads when planning the next feature in the same repo. This is the one addition that makes the two halves of the system compound rather than merely coexist, and it is unique to owning both.

**13.7 Cost and token accounting.** Every harness already reports usage; aggregating it per node, wave and run is bookkeeping, not new machinery. It belongs in the product because model choice per node is a first-class field in the workflow — without the numbers, tuning it is superstition.

*(Notifications were proposed here and have been promoted to a required feature — see §9.1.)*

---

## 14. Open questions

### Resolved

- **O1 — Harness concurrency.** Terms are not a design input for now. The requirement is instead to **fail gracefully and wait automatically** whenever a spawn is refused. Specified in §6.1 and built as step 7. This also renders the default `capacity(lane)` low-stakes: admission control discovers the real ceiling at runtime, so the configured value is a starting hint, not a contract.
- **O2 — Databases and fixtures.** Lane databases delegate entirely to `prepare-worktree`'s existing strategies — template-clone from a once-refreshed template against a shared/global DBMS, per-lane test DB names, unconditional volume forking for compose-delivered DBs (§8). **Seed data is always the project's own**; `vinta-flow` ships no fixtures and assumes nothing about database contents. Its own test suite is the sole exception and needs a minimal fixture repository (a test suite, one migration, one DB) built under `packages/vinta-flow/tests/fixtures/` as a prerequisite of step 4.
- **O3 — Human gates.** A paused node **keeps its lane** and releases its gate resources at once — the human is being asked about work in progress in that lane, and the diff, logs and takeover all read from it. Pauses notify on **both** the browser and OS channels and are **answered from the UI**, with the answer entering the pipeline's guard context. Specified in §9.1, built as step 16.
- **O4 — Windows.** macOS and Linux for v1; Windows is a required Wave 7, gated on every requirement being working, tested and polished on the other two first.
- **O5 — DAG canvas.** A separate `vinta-dag-editor` package (§3), strongly modelled on `vinta-state-machine-editor` — same framework-agnostic Web Component architecture, same tooling, same readonly-data and host-passthrough conventions — so extracting it to npm later is a publish rather than a refactor. Built as step 13, consumed by both the run view and the workflow editor.

- **O6 — Publishing `vinta-dag-editor`.** Not published for now. It stays a private workspace package (`"private": true`), consumed via `workspace:*`. Its API is therefore free to move while the run view exercises it, and extraction later is a version bump and a `pnpm publish`.
- **O7 — Notification reminders.** Off by default, with an opt-in interval. Specified in §9.1.
- **O8 — Skills accommodate `vinta-flow`.** Emission is **unconditional** — no config gate, no new bootstrap question. `plan-feature` always writes `workflow.json` beside the plan; projects without the daemon simply carry a file they don't read, and gain a workflow already waiting if they later install it. The schema is therefore a shipped-skill output and lives in the root `schemas/` (§5.1). The `AGENTS.md` ripple for step 21 reduces to: root schema entry + `schemas/README.md` + `plan-feature` body + CHANGELOG — no config field, no Step 0.5 emission, no interview question.

  More broadly this settles the direction of authority: where a skill's shape blocks the daemon, the skill changes. See [Relationship to the skills path](#relationship-to-the-skills-path).

### Still open

Nothing blocking. New questions will land here as implementation surfaces them.

---

## 15. Session reuse

A node's pipeline spawns several agent turns — implement, review, fix, review again. Until now every one of them was a cold session: a new process, a new context window, and a prompt that re-sent the phase brief, the plan-level framing and the whole dependency closure from scratch. On the fix path that is paid twice more per round.

Session reuse makes the fixer **continue the implementer's own session**, and the reviewer **continue its own across rounds**. The prompt for a continued turn is then a delta — the findings, and what to do about them — because everything else is already in the session. The saving is a prompt-cache hit on a prefix that was previously rebuilt from nothing.

Almost none of this is new machinery. `AgentTask.resumeSessionId` and `capabilities.resume` are §7 as originally specified, and all four shipped adapters implement them. What was missing was a *policy*: nothing ever set the field except an operator detaching from a PTY takeover (§9). This section is that policy.

### 15.1 Slots

A node keeps a **session ledger**: a map from slot name to `{ harnessId, sessionId, lane }`. A slot is author-chosen vocabulary, exactly like a state id — the interpreter knows nothing about which slots exist.

`spawn_agent` takes one new param, `session`:

- **absent** — a fresh session, always. This is today's behaviour, so every workflow written before this section keeps its exact meaning.
- **`session: '<slot>'`** — continue that slot's session where the ledger entry is valid, and otherwise start fresh and record the new id under it.

`standard-phase` therefore reads: `implement` and `fix` both carry `session: 'main'`; `review` carries `session: 'review'`. Two lines of pipeline data are the whole feature at the authoring layer.

**A fix round remains a `spawn_agent` with `role: 'fixer'`.** Counting keys off the role, never off the session or the state id (§5.2), so sharing the implementer's session leaves `max_fix_rounds` untouched.

### 15.2 When an entry is invalid

A ledger entry is usable only when all of these hold. Any failure means a fresh session **and the full, non-continuation prompt** — never a delta prompt against a session that does not exist.

- **The harness matches.** A codex session id means nothing to claude-code.
- **The lane matches.** A session is about a worktree: resumed into a different one it carries a history of paths and file states that no longer describe where it is standing. The entry therefore records its lane.

  The stronger rule sits above it, because the lane name is not enough. On a capacity refusal a node releases its lane and re-drives its pipeline from the initial state, and the free list usually hands back *the lane it just released* — which `#prepareLane` then recycles, resetting the worktree under a name that did not change. **The whole ledger is therefore cleared at the start of every attempt**, and the lane check remains as the invariant that keeps the mistake unwritable rather than merely un-made.
- **The adapter declares `capabilities.resume`.**
- **The vendor still has the session** — which cannot be known in advance, so it is handled as a refusal (§15.4).
- **The slot is under its turn ceiling** (§15.5).

Every fresh-instead-of-continued decision is journalled with a fixed reason token. A silent fallback would make a run that quietly stopped reusing sessions indistinguishable from one that never started.

### 15.3 Continuation prompts

A continued turn gets a delta, composed by `src/prompts` behind a `continuation` flag. Re-sending the brief to an agent that has already acted on it is not merely wasteful — it instructs an agent to implement what it has already implemented.

This puts one constraint on slot authoring. A continuation prompt tells the agent what it already has, and the fixer's says it has the plan's bounds — which is true because `fix` shares `main` with `implement`, and the implementer is the role that gets them. **A fixer slot must therefore be one an implementer opened.** A pipeline that gave its fix state a slot of its own would produce a delta claiming context that session was never given. Nothing checks this, because the composer cannot see which role opened a slot; it is an authoring rule, and the shipped pipeline follows it.

A continuation also **does not resolve `prompt_ref` or `plan_context_refs` at all** — a delta does not carry them, and reading a document only to fail a turn over a reference it will not use trades a working turn for nothing. The cold prompt that opened the session already validated both.

One rule is load-bearing beyond token economy: **a reviewer continuation always restates the `VERDICT:` protocol.** `readVerdict` is exported from `src/prompts` and imported by the executor precisely so the protocol and its parser cannot drift; a continuation that dropped the marker would take the fail-closed default on every node and burn the fix budget on reviews nobody asked for.

### 15.4 A session the vendor has forgotten

Resuming an id the vendor has expired or pruned fails the spawn. Before this section that classified as `fatal` and failed the node — acceptable when resume was an operator's rare manual path, and not acceptable once it is the default one.

`SpawnRefusalKind` therefore gains **`stale_session`**, which is neither of the kinds around it. It is not a capacity wait: waiting changes nothing, because a forgotten session does not come back. It is not `fatal`: the harness is healthy and the work is fine — only the token is stale. The host's answer is exactly one retry with a fresh session and the full prompt, after which an ordinary failure is an ordinary failure.

An adapter may classify a refusal this way **only when the task actually carried a `resumeSessionId`**. With no token there was nothing to be stale. The rule is enforced in `shared.ts` rather than per adapter: the stale rows are hoisted ahead of every other signature *and* gated on the resuming flag, so neither invariant depends on an adapter remembering to order its own table.

**The vendor wording is inferred, not observed.** No real expired session was exercised against any of the three CLIs; the patterns cover each vendor's phrasing for a missing conversation, thread or rollout. A pattern that misses would otherwise turn a routine expired token into a dead node and a blocked subtree — far too much to lose to a string — so the host does not rely on the classification alone: **a spawn that carried a token and came back `fatal` is also retried once, cold.** A genuinely broken harness fails again identically one spawn later; a misread refusal recovers. A task with no token is never retried, because nothing about it would change. The classification stays worth having — it avoids the wasted spawn and names the reason in the journal — but it is an optimisation over the net rather than the thing keeping runs alive.

### 15.5 Context growth, and the last fix round

A shared session across implement plus N fix rounds only ever grows. `max_fix_rounds` bounds it loosely; a per-slot turn ceiling bounds it directly, forcing the next spawn fresh and journalling why. Without one, a long node eventually dies on a context-window error that reads as a broken harness.

The ceiling has a second, better-motivated sibling. Reusing the implementer's session means **the agent that wrote the bug is the agent fixing it**, with every original assumption intact. That is usually the point — it knows why the code is the way it is — and occasionally exactly wrong, because the assumption *was* the bug. So **the final fix round goes fresh**: if the author cannot fix it in the rounds before last, the work is handed to an agent that has not seen it. The cost is one cold prompt on the path that was already heading for `failed`, and it recovers reviewer-style independence in the one case where it demonstrably matters.

### 15.6 Measuring it

A caching optimisation nobody measures is a claim rather than a result, and there was no cache accounting anywhere: the usage event carried input, output and cost, while the vendors' cache counters sat unread in the same objects.

`AgentEvent`'s `usage` variant gains optional `cacheRead` and `cacheWrite`, aggregated through `src/usage` under the same rule `costUsd` already follows — **a missing figure is not a zero**, or a harness that reports nothing is aggregated as having achieved a 0% hit rate. `cacheReadShare` therefore returns `undefined` rather than `0` for an unreported total, and its denominator counts only the sessions that reported. Reused-versus-fresh session counts come from the journal's `node_session` rows beside them, so the report can state both what reuse was attempted and what it bought.

**`input` is normalized to mean the fresh remainder, in every adapter.** This is the one place the harness layer does not pass a vendor's number through. Codex reports the OpenAI shape, where `input_tokens` is the *whole* prompt and `cached_input_tokens` names the cached subset of it; claude-code and opencode report the fresh remainder with the cache counts beside it. Carried through verbatim, one field would mean two different things inside a single aggregate and every cross-harness cache figure would be wrong by exactly the cached prefix. So codex subtracts, floored at zero, and the invariant `input + cacheRead + cacheWrite = the whole prompt` holds everywhere. The cost is that codex's reported `input` no longer matches what the codex CLI prints, which is the trade a cross-harness number requires.

### 15.7 What the operator sees

Reuse fails *quietly*. A run whose sessions stopped being continued looks exactly like one that never continued any — same statuses, same transcripts, same result, just more tokens and a slower fix loop. So the node view carries a **Agent sessions** panel: one row per agent turn, saying which slot it ran on, whether it continued that slot's session, and — when it did not — why, in words rather than in journal tokens.

Two rules the panel follows, both about not crying wolf:

- **Cold is not failure.** Most cold turns are correct: the first turn on a slot has nothing to continue, and the last fix round is escalated on purpose (§15.5). They are rendered in the idle tone. Only `stale_session` gets the waiting tone, because it is the one that cost a spawn nobody asked for. Nothing in the panel is ever an error tone — a lost session costs a turn, not a run.
- **An unrecognised reason is shown, not swallowed.** A browser served by a newer daemon renders the raw token rather than hiding it behind the vocabulary this build happens to know. Ugly and true beats tidy and blank, because the token is the only clue there is.

The rows come from the journal, not from a projection, over the existing node-detail endpoint (`sessions`) with a narrow per-node query. Folding a whole run's log in the browser to keep four rows would make the panel's cost grow with the length of the run it describes, and a table keyed by node would answer "is reuse working" with whichever turn happened to be last.

### 15.8 Interaction with takeover

§9's PTY round trip stages a resumed id for the node's next spawn. With a ledger that id belongs to **the slot the taken-over turn was running under** — an operator who takes over a fixer turn must not have their session handed to whatever spawns next.
