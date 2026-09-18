# vinta-ai-maestro

Runs a `plan-feature` plan as a real, code-orchestrated run: independent phases are scheduled concurrently across git worktree lanes, each phase's branch is cut from its own dependencies, expensive gates queue behind capacity limits instead of stampeding, and a browser UI shows the graph, the transcripts and the queue while it happens.

The executable artifact is `ai-plans/<feature>.workflow.json` — the file `plan-feature` writes beside every plan. Its schema is [`schemas/workflow.v1.schema.json`](../../schemas/workflow.v1.schema.json) at the repo root, generated from [`src/types.ts`](src/types.ts).

[SPEC.md](SPEC.md) is the authority for everything below. Where this README and the spec disagree, the spec is right and this file is stale.

**Status: private workspace package.** `vinta-ai-maestro` is not published to npm and is not part of the `vinta-ai-workflows` package that `npx vinta-ai-workflows install` puts in your project — the root `files` whitelist excludes `packages/`. You get it by cloning this repository. It is developed on **macOS and Linux**; Windows support exists and is described under [Platforms](#platforms).

## It does not replace the skills path

The zero-install path still works and is still the default. `implement-plan` — the prompt-shaped orchestrator that ships into projects as a skill — runs the same plan with no daemon installed, and that property is the whole value of `vinta-ai-workflows` in a client repo.

`vinta-ai-maestro` is an opt-in upgrade for projects that want a scheduler, a UI and a journal instead of a conductor prompt. The two are readings of one description of the same semantics (the partials under `skills/vinta-derive-skills/resources/plan-execution/partials/`), so a plan written for one runs on the other. Nothing about installing this changes what `plan-feature` emits: it writes `workflow.json` unconditionally, daemon or no daemon.

## Requirements

- **Node 22 or newer.**
- **git 2.17 or newer**, with worktree support. `doctor` checks both.
- **A harness CLI you are already logged into** — `claude`, `codex` or `opencode`. See [Harnesses](#harnesses).
- Docker Compose, only if your workflow's `project` block declares a `compose`-delivered database.

## Platforms

macOS, Linux and Windows. CI runs the whole suite on all three (`.github/workflows/vinta-ai-maestro.yml`) — the *whole* suite, and it passes: **847 tests on Windows**, where eighty of them used to be skipped for being written in `sh`. What still does not run there is one test, for a stated reason, plus whatever needs a real agent CLI that is not installed on a runner. Fixtures are declared as data and rendered for whichever platform is running, so a stand-in CLI is a shebang script on POSIX and a `.cmd` shim on Windows, exactly as npm installs a real one. The four places the operating systems genuinely disagree are decided in one module — `src/platform/platform.ts` — rather than scattered through the code that depends on them. Every function there takes the platform as an argument, so both answers are asserted from either kind of machine in `tests/platform.test.ts`.

What differs, and what you inherit as a consequence:

| | macOS / Linux | Windows |
| --- | --- | --- |
| A gate's `cmd` runs under | `/bin/sh -c` | `cmd.exe /d /s /c` |
| A harness CLI is spawned | directly | through `cmd.exe`, because npm installs it as a `.cmd` shim |
| A timed-out or interrupted process is ended by | one signal to its process group | `taskkill /t` |
| OS notifications | `osascript` / `notify-send` | none — a documented no-op |

**`cmd.exe`, not PowerShell.** A gate is *your* command line, and on Windows your own `package.json` scripts and `.cmd` shims already run under `cmd.exe`. `pnpm test && pnpm run lint` means what you meant there; under PowerShell 5.1 `&&` will not parse, and redirection and `%VAR%` differ under both PowerShell versions. So the shell that matches the rest of your tooling wins.

Four Windows caveats worth knowing before you rely on it:

- **An interrupt is less gentle.** Windows has no console signal Node can send, so `taskkill` is the whole vocabulary. Where POSIX sends `SIGINT` and gives a CLI a moment to persist its session before the deadline, Windows reaches the same deadline having done nothing in between. Take-over and resume still work; the CLI simply gets less warning.
- **A grandchild that outlives its parent survives.** A process group holds every descendant; `taskkill /t` reads parent links that a dead parent no longer has. If a gate backgrounds something that then loses its parent, it can stay running and hold the pipe open. There is no fix for this without a native dependency, which this package does not take.
- **`core.autocrlf`.** Git for Windows enables it by default, which means your gates see CRLF where the same gate on Linux sees LF. Nothing here changes that setting for you — it is your repository's decision — but a formatter or a golden-file test that disagrees across platforms is usually this. CI pins it off so the suite tests the committed bytes.
- **A lane's `node_modules` is a junction**, not a symlink. Real directory symlinks on Windows need Developer Mode or an elevated shell; junctions need neither and behave the same for this purpose.

**The shebang is now covered, and was not before.** Windows never reads a `#!` line: npm rewrites it into a generated `.cmd` shim at install time. That used to be untested here — the package was private, so nothing ever installed it, and CI started the entry point through Node directly, which covers the flag and the module graph and not the shim. CI now packs the tarball and installs it into a throwaway project on all three platforms, so the shim is exercised where it actually exists.

The shipped shebang is also simpler than it was. `dist/cli/bin.js` is plain JavaScript starting with `#!/usr/bin/env node` — no `env -S`, no flags to forward — because the build rewrites it. `src/cli/bin.ts` keeps `#!/usr/bin/env -S node --experimental-transform-types` for running from a checkout, and the build asserts it found that form rather than letting the two drift apart quietly.

**What CI still does not cover** is opening a pull request. `openPullRequest` hands `gh` to `execFile` directly rather than through `commandInvocation`, which is right for the real thing — `gh` is `gh.exe` on Windows and needs no shell — but leaves no way to point it at a test fixture there, since Node refuses to spawn a `.cmd` without one. Routing it through the seam like every other spawn would be worse than the gap: one of `gh`'s arguments is the pull request body, and `cmd.exe` cannot escape a `\"` or a `%` inside a quoted region, so a spawn that cannot be broken by its own payload would become one that can. `tests/support/platform.ts` carries the whole argument.

## Install and run

```bash
git clone https://github.com/vintasoftware/vinta-ai-workflows
cd vinta-ai-workflows
pnpm install
```

That is the development setup. To *use* it, there is no clone at all — the package is published:

```bash
npx vinta-ai-maestro@alpha serve
```

`@alpha` while the only published versions are pre-releases. Plain `npx vinta-ai-maestro` resolves the `latest` dist-tag, which is correct once a stable exists.

### Running it from a checkout

For development, run the CLI **by its path** rather than through `node`:

```bash
packages/vinta-ai-maestro/src/cli/bin.ts --help
alias vinta-ai-maestro="$PWD/packages/vinta-ai-maestro/src/cli/bin.ts"
```

The file is executable and its shebang asks Node for the flags it needs. `node packages/vinta-ai-maestro/src/cli/bin.ts` does **not** work: that bypasses the shebang, and Node's strip-only TypeScript mode rejects the parameter properties the adapters use.

The published binary is a different file — `dist/cli/bin.js`, plain JavaScript started by plain `node`, built by `pnpm --filter vinta-ai-maestro build` and rebuilt by `prepack` on every publish. It needs no flags at all, which is the point: **Node refuses to strip types anywhere under `node_modules`**, so a `bin` pointing at the `.ts` file installs cleanly and then dies on first run with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`.

Every command runs against a project checkout — your project, not this one. `--repo <dir>` names it; with no flag it is the current directory.

## The six commands

| Command | What it does |
|---|---|
| `doctor <workflow.json> [--repo <dir>]` | Preflights every check a run depends on and exits non-zero if a run cannot start. |
| `simulate <workflow.json>` | Projects the schedule without running it — wall clock, critical path, pool contention. Spawns no agent. |
| `serve [--repo <dir>] [--host <host>] [--port <n>]` | Starts the daemon and prints the URL to open. Its editor edits `<repo>/ai-plans/*.workflow.json`. |
| `run <workflow.json> [--repo <dir>] [--host <host>] [--port <n>]` | Starts the daemon *and* executes the workflow. Exits when the run ends. |
| `purge [run-id] [--repo <dir>] [--yes] [--dry-run]` | Deletes run state under `.vinta-ai-maestro/runs/`. |
| `with <resource> -- <cmd>` | Inside an agent turn, waits for a semaphore resource, runs the command, and releases it. The live run supplies its daemon connection through the lane environment. |
| `gate <gate-id>` | Inside an agent turn, asks the daemon to run one of the plan's declared gates against this turn's lane. The daemon holds the gate's resources and caches the result; the CLI exits with the gate's exit code. |

`--port` defaults to `0`, an OS-assigned port printed with the URL. `--host` defaults to `127.0.0.1` — see [The URL is the credential](#the-url-is-the-credential). `vinta-ai-maestro <command> --help` prints the command's own options.

The daemon-facing commands use three exit codes, so a script can tell the cases
apart: `0` success, `1` the command ran and the answer was no, `2` the command
line was wrong. `with` and `gate` pass through the exit code of the thing they
ran.

### Leasing heavy inner-loop commands

The scheduler acquires a gate's `requires` resources itself. Agents also run
tests and other heavy commands before that outer gate, so their prompts expose
the workflow's semaphore resources and tell them to use the same pools:

```console
$ vinta-ai-maestro with test-suite -- pnpm test
```

The command waits until the daemon grants the resource. While it runs, the CLI
renews a short lease; on exit it releases in a `finally`. If the CLI disappears,
the renewal stops and the daemon expires the lease, so a wedged turn cannot
starve the rest of the run. The worktree lane itself is not leasable through
this verb: the current phase already holds it, and asking for it again would
deadlock against itself.

### Running the outer gate

The gates themselves are not commands an agent should type. A phase's
implementer, its reviewer and each fixer round are all told to run the outer
gate, and before this verb every one of those was a bare shell line: invisible
to the gate cache, and inside the resource pool only if the agent remembered to
wrap it. The authoritative `gate` node then ran the same suite a fifth time.

So agents ask for a gate by id instead:

```console
$ vinta-ai-maestro gate unit
```

The daemon resolves the id to the gate's declared `cmd`, runs it in the asking
phase's lane with that lane's environment, and exits with the gate's own code.
Three things follow from the daemon being the one that runs it:

- **The result is cached**, on the same `(gate id, lane tree hash)` key the
  `gate` node reads — so the reviewer's run of a gate the implementer already
  ran against an unchanged tree is a lookup, and so is the gate node's
  afterwards.
- **The lease cannot be forgotten**, because the daemon takes the gate's
  `requires` around the run rather than trusting the agent to.
- **The command cannot be improvised**, because an id resolves to the plan's
  own command. "I ran the unit gate" in a report means the command the gate
  node will run.

A gate is recorded whoever asked for it: a `gate_result` event and a `gate_run`
entry in the phase transcript, attributed to `gate`.

**Caching depends on your gates not writing into the lane.** The tree hash
covers untracked but non-ignored files, so a gate that leaves `coverage/`,
`.pytest_cache/` or a build directory behind changes the key it was just looked
up under. Where that output varies run to run — a timestamp, a duration, a run
id — the gate invalidates itself every time and nothing is ever cached. Add
those paths to `.gitignore`: ignored files are deliberately outside the key,
and that is the whole fix.

## Chores — the other thing a phase runs

A gate judges a phase. A chore *changes* it: rewrite the comments this phase
wrote, add the changelog entry, extract the strings that need translating. It is
an agent turn rather than a shell command, and it runs on the implementer's own
session, so the agent that wrote the diff is the one asked to act on it — it
still holds the brief and its reasons for every line.

Declare them per workflow and pick them per phase:

```jsonc
"defaults": { "chores": ["deslop"] },       // what every phase runs
"chores": {
  "deslop": {
    "prompt_ref": "ai-plans/PLAN.md#deslop", // or `prompt`, inline
    "skill": "deslop-comments",              // named in the prompt, not a CLI flag
    "session": "main"                        // the implementer's, by default
  }
},
"nodes": [
  { "id": "p1" },                            // runs defaults.chores
  { "id": "p2", "chores": ["deslop", "changelog"] },
  { "id": "p3", "chores": [] }               // opts out
]
```

A node's list **replaces** the run-wide default rather than adding to it, which
is what makes `[]` an opt-out.

In `standard-phase` they run in the `polish` state, between a passing review and
the gate. That position is the design: a chore edits the tree, so running it
after the gate would merge a diff the gates never saw, and running it before the
review would have the fixer rewrite what it just did. Here it runs on the diff
that actually merges, and the gates behind it check what it did — which also
means the gate cache misses, correctly, because the tree changed.

A chore that fails is journalled and the phase goes on to its gates; a chore is
polish, and losing an implemented phase to one that timed out is the worse
trade. Set `on_failure: "fail"` on a chore the phase is not correct without. A
chore the harness had no capacity for is skipped for the same reason, rather
than re-driving a finished phase to fit the turn in.

Each turn lands in the phase transcript attributed to `chore` and its id, beside
a `chore_result` event saying whether it ran, failed or was skipped.

## Walkthrough — two phases in parallel

A repository with two phases that depend on nothing, so both belong to wave 1 and both run at once.

**1. Have a workflow.** `plan-feature` writes one beside every plan, as `ai-plans/YYYY-MM-DD-<feature-kebab>.workflow.json` — sharing the date prefix of the plan and spec it belongs to, so a feature's three files sort together — committed, reviewed with the markdown plan, and the same file every command below is pointed at. By hand, save the smallest one that runs two phases in parallel as `ai-plans/widget-tags.workflow.json`:

```jsonc
{
  "$schema": "https://github.com/vintasoftware/vinta-ai-workflows/schemas/workflow.v1.schema.json",
  "schema_version": 1,
  "id": "widget-tags",
  "plan_ref": "ai-plans/2026-09-10-WIDGET_TAGS_IMPLEMENTATION_PLAN.md",
  "base_branch": "main",
  "defaults": { "harness": "claude-code", "model": "claude-sonnet-5", "pipeline": "standard-phase" },
  "resources": {
    "lane":       { "capacity": 2, "kind": "worktree" },
    "test-suite": { "capacity": 1, "kind": "semaphore" }
  },
  "gates": {
    "types": { "cmd": "npm run typecheck", "timeout_s": 300 },
    "unit":  { "cmd": "npm test", "requires": ["test-suite"], "timeout_s": 1800 }
  },
  "nodes": [
    { "id": "p1", "name": "Tag model", "depends_on": [],
      "prompt_ref": "ai-plans/2026-09-10-WIDGET_TAGS_IMPLEMENTATION_PLAN.md#phase-1",
      "touches": ["src/tag.js"], "gates": ["types", "unit"] },
    { "id": "p2", "name": "Tag list endpoint", "depends_on": [],
      "prompt_ref": "ai-plans/2026-09-10-WIDGET_TAGS_IMPLEMENTATION_PLAN.md#phase-2",
      "touches": ["src/list.js"], "gates": ["types", "unit"] }
  ]
}
```

**2. Prepare the project.** Two things, both one-time and both easy to discover the hard way:

- Add `.vinta-ai-maestro/` to the project's `.gitignore`. Nothing adds it for you, and what lands there holds your repository's contents verbatim — see [What `.vinta-ai-maestro/` holds](#what-vinta-ai-maestro-holds). Add `.vinta-ai-workflows/worktrees/` too: a run writes one summary per lane there, and every one of them is absolute paths and machine-local state.
- Commit the harness permissions a phase needs. A lane is a worktree of your repository, so committed settings travel into it; without them the agents run headless with nothing able to approve a prompt, and each phase ends its turn asking for permission it will never get. For `claude-code` that is a `.claude/settings.json`:

  ```json
  { "permissions": { "defaultMode": "acceptEdits", "allow": ["Bash", "Read", "Write", "Edit", "Glob", "Grep"] } }
  ```

  Scope it to what your phases actually need; this is the permissive end.

**3. Review and approve it in the editor.** `serve` opens the daemon with no run attached. Its Editor lists every `ai-plans/*.workflow.json` in the project — the file you just wrote, or the one `plan-feature` wrote — and saving writes back to that same file:

```console
$ vinta-ai-maestro serve
vinta-ai-maestro: daemon listening on http://127.0.0.1:52218
Open this URL. It carries the access token, so treat it as a secret:
  http://127.0.0.1:52218/?token=<the-token-printed-here>
```

The document's `id` and its filename must agree: `widget-tags` lives in `widget-tags.workflow.json`. The id lands in every branch a run cuts (`plan/widget-tags/phase-p1`), so a file that disagrees with itself is refused rather than quietly opened. A save is a rewrite of a committed file, in place and atomically — review it the way you review the plan beside it, with `git diff`:

```console
$ git diff ai-plans/widget-tags.workflow.json
```

A save writes the *validated* document — the one the executor would run — so the first save of a hand-written file also normalizes it: two-space indentation, and the fields the schema defaults made explicit (`plan_context_refs: []`, each node's `depends_on`, `gates`, `touches`). That is a one-time diff; every save after it shows only what you changed.

Nothing here is copied into `.vinta-ai-maestro/`. The store holds run state; `ai-plans/` holds the source, and the editor edits the source. Saving *during* a run is a different operation: the run has its own frozen snapshot, so the save goes through the amend path, which refuses while an affected node is in flight and rebases the finished ones whose base moved. The file is written only after the run accepts the change.

**4. Preflight.**

```console
$ vinta-ai-maestro doctor ai-plans/widget-tags.workflow.json
vinta-ai-maestro doctor

  PASS  harness claude-code: installed and authenticated (2.1.236 (Claude Code))
  PASS  git: 2.54.0
  PASS  git worktrees: usable
  PASS  docker compose: not required by this project
  PASS  disk: 2 lanes + 1 integration worktree needs 0 MiB, 28.4 GiB free
  PASS  lane summaries: none yet — lanes will be provisioned fresh

0 failed, 0 warned, 6 passed
A run can start.
```

Every check runs even after one fails, so one report names everything wrong at minute zero. A `FAIL` blocks the run; a `WARN` means it starts degraded — a lane whose forked database has no `reset_cmd` is the usual one, and it just means the lane is single-use.

**5. Project the schedule.** `simulate` drives the real scheduler on a virtual clock against a mock harness. It is the cheapest way to see whether the graph is actually parallel, and whether the lane count or a gate pool is the constraint:

```console
$ vinta-ai-maestro simulate ai-plans/widget-tags.workflow.json
Simulated run — projection, not a prediction.

Projected wall clock: 1h

Critical path
  p2 (wave 1)  0s → 1h  work 50m, queued 10m

Nodes
  node                 wave  status      start       finish      work        queued
  p1                   1     done        0s          50m         50m         0s
  p2                   1     done        0s          1h          50m         test-suite 10m

Pools
  pool                 capacity  peak  busy        saturated   queued
  lane                 2         2     1h          50m         0s
  test-suite           1         1     20m         20m         10m
```

Both phases start at `0s` — that is the parallelism the plan claimed, confirmed before a model turn is spent. `p2` finishes ten minutes later only because `test-suite` has capacity 1 and `p1` was holding it.

**6. Run it.**

```console
$ vinta-ai-maestro run ai-plans/widget-tags.workflow.json
vinta-ai-maestro: daemon listening on http://127.0.0.1:52765
Open this URL. It carries the access token, so treat it as a secret:
  http://127.0.0.1:52765/?token=<the-token-printed-here>
vinta-ai-maestro: run widget-tags-mtvodosx started (2 nodes).
```

The daemon comes up before the first node dispatches, so you can open the URL and watch. Both phases are assigned a lane immediately and implement concurrently, each in its own worktree under `.vinta-ai-maestro/lanes/`, on its own branch cut from `base_branch`:

```console
$ git branch
* main
+ plan/widget-tags/phase-p1
+ plan/widget-tags/phase-p2
+ wt/widget-tags-mtvodosx-integ
  wt/widget-tags-mtvodosx-lane-1
  wt/widget-tags-mtvodosx-lane-2
```

`plan/…/phase-<id>` is the phase's own branch; `wt/…` are the branches the lane and integration worktrees are checked out on. When the run ends, read [What this walkthrough has and has not been run against](#what-this-walkthrough-has-and-has-not-been-run-against) before you read the last two lines it prints.

**7. Read what happened, then clean up.** A finished run leaves its worktrees, branches and databases in place on purpose — they are the evidence. The post-mortem is written at the end and is what `plan-feature` reads before drawing the next feature's graph:

```console
$ cat .vinta-ai-maestro/runs/<run-id>/postmortem.json
$ vinta-ai-maestro purge <run-id> --dry-run
$ vinta-ai-maestro purge <run-id>
```

### What this walkthrough has and has not been run against

Every step above is transcribed from a real run of exactly these commands, and that run predates agent prompt composition — at the time, the scheduler handed the harness `node.prompt_ref` as the entire prompt for every role, so the reviewer was never told to end its turn with `VERDICT: pass`, every node fell back to the fail-closed default, and the run ended with `failed nodes: p1, p2`.

**That cause is fixed.** `spawn_agent`'s `prompt_template` now selects a composed, per-role prompt, and the shipped `standard-phase` pipeline is driven to `done` in the test suite against real git worktrees, real branches, real gate commands and real merges — including the fix loop, where a red gate produces a fixer and the next review passes. The verdict protocol the reviewer is asked for and the parser that reads it are one definition, so they cannot drift.

What has **not** happened is a live run with real agents since that landed. The mechanism is tested; the numbers in the walkthrough above are from the older run. Treat the failure output it describes as history rather than as current behaviour, and expect to be the first to see a full real-agent run reach a merged wave branch.

`simulate` remains the fastest way to size `resources.lane` for a plan, because it answers the scheduling question without spending a model turn.

## What `.vinta-ai-maestro/` holds

Everything a run writes lives inside the project, never in a global cache directory, so the project's own retention rules reach it:

```
.vinta-ai-maestro/
  flow.db                       # SQLite event log — opaque identifiers only
  gate-cache.db                 # gate results keyed by (gate id, lane tree hash)
  logs/daemon.ndjson            # the daemon's own log — opaque identifiers only
  logs/daemon.<n>.ndjson        # rotations, oldest pruned past five
  lanes/<lane>/                 # the lane worktrees, and .templates/ for forked DBs
  runs/<run-id>/
    workflow.json               # the snapshot frozen at run start
    postmortem.json             # written once the run has ended
    nodes/<node-id>/
      transcript.jsonl          # normalized agent events
      raw.jsonl                 # the harness's native stream
      gates/<gate-id>.log       # the gate's output
```

**Transcripts and gate logs contain repository contents verbatim** — files the agent read, diffs it produced, test output. Treat that directory as a copy of your source, because it is one. `flow.db` is different by design: structured log fields carry only run, node and session identifiers, never file contents or record data.

Two things follow. **Add `.vinta-ai-maestro/` to `.gitignore`** — the daemon does not do it for you, and an unignored store commits your transcripts. And **purge on a schedule if the repository carries a data-handling obligation.**

One directory sits outside the store: a run writes a per-lane summary to `.vinta-ai-workflows/worktrees/<lane>.yaml`, in the layout `prepare-worktree` defines. Those hold absolute paths and lane state rather than repository contents, but they are machine-local and belong in `.gitignore` as well.

**Retention default: keep until purged.** Nothing under `.vinta-ai-maestro/` expires, rotates, or is deleted on its own; a run's directory survives until someone removes it. `purge` is the mechanism:

```console
$ vinta-ai-maestro purge --dry-run          # every run, listed, nothing deleted
$ vinta-ai-maestro purge <run-id>           # names every path, then asks
$ vinta-ai-maestro purge <run-id> --yes     # for scripts
```

It removes the run *directory* — snapshot, transcripts, raw streams, gate logs. It does not touch `flow.db`, which holds the identifiers the post-mortem is built from and no repository contents. A run id is a single name, never a path: anything containing a separator or `..` is refused before anything is unlinked.

## When something goes wrong: the daemon's own log

Transcripts say what the *agents* did. This says what the *daemon* did — which is the half you need when the answer is "nothing happened", "it stopped", or "the process is gone".

It is a file and a view, and they show the same records:

```console
$ vinta-ai-maestro serve
vinta-ai-maestro: daemon listening on http://127.0.0.1:52765
Open this URL. It carries the access token, so treat it as a secret:
  http://127.0.0.1:52765/?token=<the-token-printed-here>
Daemon log: /your/project/.vinta-ai-maestro/logs/daemon.ndjson
```

Open the **Logs** tab in the UI to read it live — filter by level, by run, or by a substring of any event name or field; it follows the tail until you scroll up, and resumes following when you scroll back down. Or read the file directly, since it is NDJSON:

```console
$ tail -f .vinta-ai-maestro/logs/daemon.ndjson | jq -c '{ts,level,event,run,fields}'
$ jq -c 'select(.level=="error")' .vinta-ai-maestro/logs/daemon.ndjson
```

### What it records

| Event | When |
|---|---|
| `daemon.listening`, `daemon.closing` | The process's own lifetime. The host and the port; never the token. |
| `daemon.uncaught_exception`, `daemon.unhandled_rejection` | **A crash.** The error's kind and message, its stack frames, and which runs were in flight when it died. |
| `daemon.process_warning` | A Node warning — `MaxListenersExceededWarning` is what a leak looks like an hour before it matters. |
| `api.request`, `api.threw`, `bridge.threw` | Every HTTP request's method, path and status. Refusals at `warn`; the ordinary 200s at `debug`. |
| `ws.refused`, `ws.attached` | Why a socket upgrade was turned away — a bad token, an unknown run, a malformed cursor. From the browser these are one symptom. |
| `runs.refused`, `runs.started` | A start request that produced no run has no run id, so it has no journal row, no transcript and no post-mortem. This is the only record of it. |
| `run.preflight_refused`, `run.provision_failed` | The two commonest ways a run does not begin. |
| `scheduler.started`, `scheduler.dispatch`, `scheduler.node_status`, `scheduler.ended` | Every dispatch and every node transition, on the same clock as everything above. |
| `scheduler.deadlock` | Nothing running, nothing ready, something pending — the failure that looks like nothing at all, with the pending set named. |
| `scheduler.node_threw` | An exception escaping a node's own handling. The node fails and its dependents block; the rest of the DAG keeps going. |

### Why a crash used to be silent

The scheduler dispatches each node as a floating promise. An exception escaping one became an unhandled rejection, and an unhandled rejection terminates the process — correctly, and with nothing written anywhere. A plan that had been running for hours simply was not any more, and the only evidence was the shape of the hole.

Three things changed. A node that throws is now **contained** rather than fatal, by the same rule a failed node already followed: it fails, its transitive dependents block, and everything independent of it finishes. A crash that is still fatal is **recorded first** — kind, frames, and the ids of every run in flight. And before the process goes, those runs are journalled as ended, so `vinta-ai-maestro run --resume <run-id>` can pick them up instead of finding a row that says `running` for ever.

### Errors carry their own words

Every record that describes a failure has two fields: `error`, the kind (`TypeError`, `Error: ENOENT`), and `message`, what the error actually said. A crash adds numbered `stack_N` frames. The kind names a category; the message names the bug, and you want both.

```json
{"ts":1758035071550,"level":"error","event":"scheduler.node_threw","run":"auth-m9x2k1",
 "fields":{"node":"p1-endpoints","error":"TypeError",
           "message":"Cannot read properties of undefined (reading 'lane')"}}
```

`--log-detail kind` drops the message and keeps the kind and the frames, for a checkout under a data-handling obligation stricter than this store's own. It is not the default, because `.vinta-ai-maestro/runs/` in this same directory already holds every agent transcript and gate log **verbatim** — an error message is a rounding error against that, and excluding it costs the one string that most often explains a failure.

### What it will not record

Everything other than `message` is **identifiers only** — the rule `flow.db` follows — and it is enforced rather than asked for. A field may only be a string, a number, a boolean or null, so an object handed to the logger is *dropped* rather than stringified, which is how a diff or a file read would otherwise become a log line. Identifier values are capped at 200 characters and `message`, the single allowlisted prose field, at 2000. Field names that are secrets by their name are redacted. And the daemon's token is registered as a secret at boot, so any value containing it — including inside a message — comes back `<redacted>`.

Flags:

```console
$ vinta-ai-maestro serve --log-level debug   # adds a line per request and per socket
$ vinta-ai-maestro serve --log-stderr        # also print to the terminal, one line each
$ vinta-ai-maestro serve --log-detail kind   # drop error messages, keep kinds and frames
```

`run` accepts the same three, and writes to the same file.

**It is bounded, and `purge` does not touch it.** The active file rotates at 8 MiB and five rotations are kept — about 40 MiB, whatever the daemon's uptime. `purge` leaves it alone for the same reason it leaves `flow.db` alone: it holds no repository contents, and deleting it would remove the record of the failure somebody is about to ask about.

## The URL is the credential

There is no login, no account and no session. The daemon mints a random token at boot, requires it on every request including the WebSocket upgrade, and prints it exactly once, on stdout, in the URL:

```
vinta-ai-maestro: daemon listening on http://127.0.0.1:52765
Open this URL. It carries the access token, so treat it as a secret:
  http://127.0.0.1:52765/?token=<the-token-printed-here>
```

That line is the only place in this package's output where the token ever appears. It is not in the "listening on" line, not in warnings, not in errors — so pasting a log into a ticket is safe, and pasting *that* URL into a ticket publishes the run.

**`--host` is explicit and warned about.** The default bind is `127.0.0.1`. Any other value makes the daemon reachable from other machines, and the daemon prints a warning naming the host — on stderr, where it cannot be mistaken for part of the URL. Anyone who can reach the daemon and holds the token can drive the run: there is no per-user access control, by design. Prefer an SSH port-forward to `--host` for a daemon on a bigger box.

## Harnesses

Three adapters: `claude-code`, `codex`, `opencode`. They are process supervisors around a CLI you have already logged into.

**Subscription authentication only. The daemon never handles an API key** — it does not read a credential store, never prompts for a secret, and never forwards one. `doctor` *reports* on authentication and never performs it: if a harness is logged out, the check fails and prints the command **you** run to log in.

Point the adapter at a specific binary with an environment variable, which overrides the bare name on `PATH`:

| Harness | Variable | Default |
|---|---|---|
| `claude-code` | `VINTA_AI_MAESTRO_CLAUDE_BIN` | `claude` |
| `codex` | `VINTA_AI_MAESTRO_CODEX_BIN` | `codex` |
| `opencode` | `VINTA_AI_MAESTRO_OPENCODE_BIN` | `opencode` |

### What an agent may do in its lane

`--permission <ask|auto|full>` on `run` and `serve`, defaulting to **`auto`**: the agent works unattended inside its own lane, which is what a lane is for.

**The operator sets this, never the workflow document.** It is an argument to the command rather than a field in the JSON, and deliberately so — the document is committed and shared, and a file in a repository should not be able to tell someone else's machine to run agents without approvals. A plan may say which model writes a phase; it may not say how much of a stranger's filesystem that model gets.

| | claude-code | codex |
|---|---|---|
| `ask` | `--permission-mode manual` | `--sandbox workspace-write` |
| `auto` | `--permission-mode auto` | `--approve-for-me` |
| `full` | `--allow-dangerously-skip-permissions --permission-mode bypassPermissions` | `--dangerously-bypass-approvals-and-sandbox` |

`ask` is the CLIs' own default and the one to avoid headlessly: nothing answers a permission prompt in a `run`. The request surfaces as a `permission_request` event and the transcript renders it, but no reply is ever sent — so the agent reports a blocked working directory and the phase fails having written nothing. Use it with `serve` and a human watching, or not at all.

`full` is available and is not the default. Both vendors describe their equivalent as being for sandboxes with no internet access, and a lane is not that — it has the network and whatever credentials the machine holds.

Two argument combinations are refused by the CLIs themselves, which is why the table is not symmetric: codex rejects `--sandbox` alongside `--approve-for-me` (the latter already implies the former), and `codex exec resume` accepts neither, so a resumed thread keeps the policy it was created under.

A lane is still a worktree of your repository, so committed settings travel into it: for `claude-code`, a `.claude/settings.json` narrowing tools further is honoured on top of whatever mode is passed.

## Limits worth knowing before you rely on it

- **Windows runs the same suite as macOS and Linux**, minus one test that cannot be given a fixture there. See [Platforms](#platforms) for that one, and for the caveats you inherit — a less gentle interrupt, `taskkill` in place of process groups, no OS notifications.
- **One project, one run at a time** per daemon. The journal is keyed by run id, so this is a boundary rather than a design limit — but it is today's boundary.
- **A full run with real agents has not been done since prompt composition landed.** The path is covered end to end by tests against real git worktrees, gates and merges, but the walkthrough's transcript is from an older run. See [What this walkthrough has and has not been run against](#what-this-walkthrough-has-and-has-not-been-run-against).
- **A projection is not a prediction.** `simulate` answers "given these durations, what schedule follows", and three things it cannot know:
  - **It cannot predict an agent's turn length.** The durations are yours; the schedule is its answer to them.
  - **Harness concurrency ceilings are not modelled.** A mock session drains instantly, so admission control never blocks. A run that a vendor would throttle projects as if it were not throttled.
  - **It simulates the clean path.** Every review passes, every gate exits zero, no phase needs a fix round.

## Developing on it

From this directory:

```bash
pnpm run typecheck
pnpm test
pnpm run schema:check              # workflow.v1 vs src/types.ts
pnpm run postmortem:schema:check   # postmortem.v1 vs src/postmortem/postmortem.ts
```

`schemas/workflow.v1.schema.json` and `schemas/postmortem.v1.schema.json` are **generated** and drift-checked. Edit the zod source and regenerate with `schema:gen` / `postmortem:schema:gen`; never hand-edit the JSON.

The browser UI lives in `ui/` and is built on the workspace's design system, [`packages/design-system`](../design-system/README.md) — its tokens, its shadcn/ui components and its layout kit; the two canvas Web Components are re-skinned through their own custom properties in `ui/src/app.css` so the graph and the badges beside it share one palette. `pnpm run ui:dev` serves it with Vite against a running daemon; `pnpm run ui:build` writes the bundle the daemon serves into `dist/ui`. The UI follows the operating system's light or dark scheme by default; the toggle in the top bar remembers a choice per browser. Fonts ship in the bundle — the page makes no request outside its own origin.
