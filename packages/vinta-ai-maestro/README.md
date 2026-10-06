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
- **A lane's `node_modules` is its own copy**, on every platform. Where the filesystem supports cloning (APFS, btrfs, XFS, ReFS) the copy shares blocks with the main checkout until a lane changes something; on NTFS it is a full copy, and the disk preflight budgets for that. The one exception is a main checkout whose `node_modules` is itself a link: the lane gets the same link, as a junction, because a directory symlink on Windows needs Developer Mode or an elevated shell.

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
npx vinta-ai-maestro@alpha ui
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

## The commands

| Command | What it does |
|---|---|
| `validate <workflow.json> [--repo <dir>] [--json]` | Checks a workflow without running anything. It checks the document's shape and its graph, layered over the project's `.vinta-ai-workflows.yaml`, as a run loads it. It also checks that the file is named `<id>.workflow.json`, and that `plan_ref` and every `prompt_ref`, `plan_context_refs` and chore anchor name a heading that exists in the plan. `--json` prints one object for an agent. `plan-feature` runs this on every workflow it writes. Exits 1 on any issue. |
| `review open <workflow.json> [--repo <dir>] [--host <host>] [--port <n>]` | Serves the UI and prints the URL of that plan's [review page](#reviewing-a-plan-before-it-runs). |
| `review wait <workflow.json> [--timeout <s>]` | The authoring agent's side of the review chat. It blocks until the person sends something, prints it as JSON, and marks it delivered. It gives up after `--timeout` (default 110 s) with `{"kind":"timeout"}`. |
| `review reply <workflow.json> -m <text\|-> [--comment <id> [--resolve]] [--as <name>]` | Answers in the chat, or on a comment thread, as the agent. |
| `doctor <workflow.json> [--repo <dir>] [--resume <run-id>]` | Preflights every check a run depends on and exits non-zero if a run cannot start. `--resume` asks the question for `run --resume <run-id>`: that run's own lanes are holding its phase branches on purpose, and are not leftovers to clear. |
| `simulate <workflow.json>` | Projects the schedule without running it — wall clock, critical path, pool contention. Spawns no agent. |
| `run <workflow.json> [--repo <dir>]` | Starts the workflow as a **background job** and returns once it is under way. The run does not need the terminal: close it and the run carries on. `--foreground` hosts it in this process instead and exits when it ends, for CI. |
| `run --resume <run-id>` | Picks an interrupted or paused run back up, as a background job. |
| `status [run-id] [--json]` | Every run in the project and what it is doing — or one run, phase by phase. A run whose job died without ending it shows as `interrupted`. |
| `logs <run-id> [-f] [-n <lines>]` | The run's job log: what `run` used to print to the terminal, plus its daemon's records. `-f` follows it until the job exits. |
| `pause <run-id> [--wait]` | Nothing new starts; each running phase finishes the step it is in, then the job exits. The run is `paused`, its lanes intact, and `run --resume` continues it. |
| `stop <run-id> [--wait]` | Kills every live agent turn and gate now. The run is `cancelled` and cannot be resumed. |
| `ui [--repo <dir>] [--host <host>] [--port <n>]` | Serves the browser UI for every run in the project and prints the URL to open. Runs are not hosted here — close it whenever you like. A run started from its editor is launched as a background job. `serve` is the same command. |
| `purge [run-id] [--repo <dir>] [--yes] [--dry-run]` | Deletes run state under `.vinta-ai-maestro/runs/`. A run whose job is still running is kept. |
| `with <resource> -- <cmd>` | Inside an agent turn, waits for a semaphore resource, runs the command, and releases it. The live run supplies its daemon connection through the lane environment. |
| `gate <gate-id>` | Inside an agent turn, asks the daemon to run one of the plan's declared gates against this turn's lane. The daemon holds the gate's resources and caches the result; the CLI exits with the gate's exit code. |

There are also `judge-hook` and `guard-hook`, which are internal: they are the hooks `--permission judged` and [the gate guard](#the-gate-guard) install, and claude-code runs them, not you.

`--port` defaults to `0`, an OS-assigned port printed with the URL. `--host` defaults to `127.0.0.1` — see [The URL is the credential](#the-url-is-the-credential). `vinta-ai-maestro <command> --help` prints the command's own options.

### A run is a background job

`run` hands the run to a detached copy of itself — the run's *job* — and returns as soon as the job says the run has started. The job is the run's only host: it holds the scheduler, the agents, and a loopback API the agents call back into (`with`, `gate`). It writes `.vinta-ai-maestro/runs/<run-id>/job.json` — its pid, that API's address and its token — and every other command finds the run through that file. It serves no UI.

`ui` is the browser's way in. It reads every run's history from the journal, and for a run whose job is alive it forwards that run's requests and socket to the job, so the live graph, steering, answering a question and taking over a terminal all work as if the two were one process. Close `ui` and the runs carry on; open it tomorrow and it shows them where they got to.

A run ends one of four ways, and the journal says which: it settles (`done` or `failed`), it is paused (`paused`, resumable), it is stopped (`cancelled`, final), or its job is killed by a signal (`failed`, resumable — exactly what closing the terminal used to do). `status` shows a run whose job vanished without writing any of those — a reboot, a `kill -9` — as `interrupted`, and `run --resume` picks it up.

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

The verb resolves from inside every lane however maestro was installed. The
daemon writes a launcher for itself into `.vinta-ai-maestro/bin/` on every run
start — the Node it runs under, its flags, its own entry file — and puts that
directory first on the agents' `PATH`. A maestro reached through
`node_modules/.bin` or `npx` is therefore the same `vinta-ai-maestro` the agent's
shell finds.

### Running the outer gate

The gates themselves are not commands an agent should type. A phase's
implementer, each fixer round and the review loop are all told to run the outer
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
  `gate` node reads — so the review loop's run of a gate the implementer
  already ran against an unchanged tree is a lookup, and so is the `verify`
  node's afterwards.
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

### The gate guard

The prompts ask for `vinta-ai-maestro gate <id>`; on claude-code the guard
makes it stick. Every agent a run starts gets a `PreToolUse` hook, in every
`--permission` mode, that refuses two kinds of Bash line before they run:

- **A gate's full command, typed by hand.** The agent is told the `gate` line
  to use instead.
- **A command matching a pool's `match` pattern without the pool's lease.**
  The agent is told to run it under `vinta-ai-maestro with <pool> --`.

```jsonc
"resources": {
  "test-suite": { "capacity": 1, "kind": "semaphore", "match": ["pytest*", "uv run pytest*"] }
}
```

A gate's *scoped* form is not refused as a gate: `pytest app/a.py` is also what
an agent running one test file in its inner loop types, which is the work. It
owes the pool's lease, and the `match` rule asks for exactly that.

The hook is installed through the per-lane settings file the adapter passes
with `--settings` for that one spawn. It never touches the repository's
`.claude/settings.json`, so your own sessions and `implement-plan` are not
affected. It asks the run's daemon, which matches against the gate commands as
they stand now (a retuned gate is matched on its new command), and journals each
refusal as `bare_gate_blocked`. It fails open: no daemon, no answer, unreadable
input, and the call goes ahead as if there were no hook. It never answers
"allow", so it cannot skip a permission prompt your mode asks for.

It compares command lines. `bash -c "…"`, a script that runs the suite, or the
same tool spelled differently are not seen. It is a guardrail against habit, not
a sandbox.

codex has no per-call hook and opencode's is not wired, so on those harnesses a
matching command is only recorded after it ran, as `bare_gate_detected`. `doctor`
says which you are getting, per harness, as `gate-guard:<harness>`.

## Project configuration — `.vinta-ai-workflows.yaml`

Most of a workflow repeats from plan to plan: the test, lint and typecheck
gates, the pool the suite contends for, the comment-hygiene chore, the `project`
block a lane is provisioned from. Put those in `.vinta-ai-workflows.yaml` at the
repository root, and each plan states only what is different. The file is the
one the bootstrap writes; maestro reads two parts of it.

```yaml
commands:                       # shared with implement-plan
  build: uv run mypy .
  test_unit: uv run pytest
  test_unit_scoped: uv run pytest --testmon {changed_files}

maestro:
  defaults:
    gates: [typecheck, test]    # what every phase runs unless it names its own
  gates:
    test:                       # maestro's own line; implement-plan keeps commands.test_unit
      cmd: uv run pytest --reuse-db -n auto
      requires: [test-suite]
  resources:
    test-suite: { capacity: 1, kind: semaphore, match: ['pytest*', 'uv run pytest*'] }
  chores:
    deslop: { skill: deslop-comments, prompt_ref: ai-plans/CHORES.md#deslop }
  project:
    migrate_cmd: uv run python manage.py migrate
```

A plan over that file can be this small. Every node runs `typecheck` and `test`
with the project's commands:

```jsonc
{
  "schema_version": 1,
  "id": "widget-tags",
  "defaults": { "model": "claude-sonnet-5" },
  "resources": { "lane": { "capacity": 2, "kind": "worktree" } },
  "nodes": [ /* … */ ]
}
```

**The layers, lowest first**, each overriding the one before:

1. `commands.*`: the lines `implement-plan` runs.
2. `maestro.*`: what maestro does differently, or what every plan would repeat.
3. The plan's `.workflow.json`.
4. The run's own amendments (an operator's edit, the monitor's retune). A config
   change never undoes one of these.

**The merge rules are the workflow's own.** Maps keyed by id (`resources`,
`chores`, `project.databases`, `project.services`) merge per id, and the higher
layer's entry replaces the lower one's whole. Lists replace (`defaults.gates`,
`defaults.chores`, a node's `gates`), so `[]` still opts out. Plain objects
(`defaults`, `project`, `project.commands`) merge field by field. A plan with no
`base_branch` takes `project.default_branch`. `defaults.harness` and
`defaults.pipeline` default to `claude-code` and `standard-phase`.

**`[]` means none, not "the defaults".** A node with `"gates": []` runs no gate
and passes its gate step vacuously; a plan with `"defaults": { "chores": [] }`
runs no chore. To take the project's `maestro.defaults.gates` or
`maestro.defaults.chores`, omit the key. `validate` refuses a phase that resolves
to no gates, and `doctor` warns naming it, unless the plan sets
`defaults.allow_ungated_phases: true` — a plan whose phases genuinely have
nothing to run.

### The files git does not carry — `project.env_files`

A lane is a worktree, and a worktree has only what git tracks. `.env`,
`.env.docker`, a `settings/local.py` — the gitignored files every hook,
`manage.py` call and compose stack in the project reads — reach a lane only if
`project.env_files` names them, and then each lane gets its own *copy* (never a
link: provisioning appends lane-specific lines to them). Declare them once, here,
and every plan inherits them:

```yaml
maestro:
  project:
    env_files: [.env, .env.docker, app/settings/local.py]
```

`doctor` fails a declared file that is missing from the checkout, and warns —
naming them — when a gitignored file has a tracked example (`.env.example`,
`local.py.example`) and nothing declares it. A resume gives each existing lane
the declared files it lacks and leaves the ones it has, so amending the list
reaches lanes that are already there.

### Git hooks — `project.hooks`

`run` (the default) runs the repository's hooks on commits made in a lane;
`skip` points the lane at an empty `core.hooksPath`. The integration worktree
follows the same setting: the merge commits maestro makes there — a resolved
conflict, a wave — run the hooks under `run` and skip them under `skip`. When a
hook refuses one of those commits (typically because it imports a file that is
not in `env_files`), the worktree is **not** left mid-merge. The resolution is
kept under `refs/vinta-ai-maestro/resolutions/<node>`, the merge is abandoned,
and the phase whose merge it is asks: *commit* (hooks again, once you have fixed
what they wanted), *commit --no-verify* (the resolution already passed the
phases' gates), or *abort merge*. Under `--retry-after`, nobody there means
*abort*. The retry reuses the kept resolution.

### Gate types

A gate with a `type` (`test`, `lint`, `typecheck` or `e2e`) takes any field it
does not set from the project: first `maestro.gates.<type>`, then the
`commands.*` line for that type (`test_unit`, `lint`, `build`, `e2e`). Each type
the project has a command for is also available under the type's own name, which
is why the nodes above can say `typecheck` and `test` with no `gates` table.

```jsonc
"gates": {
  "test":   { "type": "test", "timeout_s": 3600 },  // the project's command, a longer timeout
  "smoke":  { "cmd": "./scripts/smoke.sh" }         // untyped: entirely the plan's
}
```

A typed gate merges field by field. An untyped entry replaces whatever the
project had under that id.

### Scoped and full gates

A gate may carry two commands. `cmd` is the full check. `scoped_cmd` is the
same check narrowed to what the phase changed, with `{changed_files}` (the
files the lane changed against the phase's base, uncommitted work included,
deletions excluded) or `{touches}` (the node's Touch List) in it:

```jsonc
"unit": { "cmd": "pnpm vitest run", "scoped_cmd": "pnpm vitest related {changed_files} --run" }
```

Under `defaults.gate_scope: scoped`, the default, phase gates run `scoped_cmd`.
Those are the gates the implementer, every fixer round and the review loop ask for.
The full `cmd` then runs **once per wave, on the merged tree**, after the wave's
branches are merged. A red full run there is a regression *between* phases. It
fails the merge and names the wave and the gate. `gate_scope: full` runs `cmd`
everywhere and skips the wave run. A gate with no `scoped_cmd`, or a
placeholder with nothing to substitute, runs `cmd`.

The command must accept any path it is given. A source file with no tests of its
own is a normal member of `{changed_files}`. `vitest related` and
`jest --findRelatedTests` are built for this; `pytest` needs a plugin such as
`pytest-testmon`, or a wrapper. A `commands.test_unit_scoped` line is inherited
only when it has a placeholder. A fixed `pnpm test:patient` is a line for an
agent to interpret, and the daemon has no agent to do that.

## The plan branch — changing a run while it runs

Every run works on its own branch, `plan/<workflow-id>/base`, cut from
`base_branch` when the run starts. Dependency-free phases branch from it, lanes
are reset to it, and the wave spine starts from it. Pull requests still target
`base_branch`. If the branch already exists and contains `base_branch`, it is
used as is, so a config change can be committed there before the run starts.
If it is only behind, it is moved forward. If it has diverged, the run refuses
to start.

**Commit to the plan branch to change the run.** The run checks the branch every
few seconds. When new commits touch `.vinta-ai-workflows.yaml` or the plan's own
`.workflow.json`, both are read *at the new commit*, resolved exactly as at
start, and applied to the live run as an amendment authored `config`. The
journal's `workflow_amended` row names the commit.

```console
$ git switch plan/widget-tags/base        # or a worktree of it
$ $EDITOR .vinta-ai-workflows.yaml        # e.g. add --reuse-db to maestro.gates.test.cmd
$ git commit -am "maestro: reuse the test db" && git switch -
```

What a config change may not do:

- **Undo a change made in this run.** A gate, node, chore or pool that an
  operator or the monitor amended keeps the run's value.
- **Rewrite a phase that has started.** Its definition stays as it was. A gate
  *command* change reaches every phase at its next gate run, including phases
  already done.
- **Retarget the plan.** `base_branch` is fixed for the run.

A change the amend rules refuse because a node is in flight is retried on the
next check. Anything else that is refused, such as a file that does not parse
or a workflow that does not validate, is journalled as a `config_reload` row and
passed over.

Only commits count. An uncommitted edit in your checkout reaches no run, and an
edit committed on `main` reaches no run already going. A run *starts* from the
checkout's file, and `run` warns when that file differs from what is committed
on the plan branch, because the next config commit would replace those edits.
The commits ship with the plan: each later wave merges the plan branch in, so
the plan PR carries them to `base_branch` for review with everything else.

## Chores — the other thing a phase runs

A gate judges a phase. A chore *changes* it: rewrite the comments this phase
wrote, add the changelog entry, extract the strings that need translating. It is
an agent turn rather than a shell command, and it runs on the implementer's own
session, so the agent that wrote the diff is the one asked to act on it — it
still holds the brief and its reasons for every line.

Declare them per workflow and pick them per phase:

```jsonc
"defaults": { "chores": ["review", "deslop"] }, // what every phase runs
"chores": {
  "review": {
    "skill": "thermo-nuclear-review-loop",
    "when": "review",                        // the phase's code review
    "prompt": "Run the thermo-nuclear-review-loop skill over this phase's diff until its reviewer approves it."
  },
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

A chore's `when` says where in the phase it runs. `after_review`, the default,
runs it in the `polish` state, once the review approved and before the gates run
again in `verify`. That position is the design: a chore edits the tree, so
running it after the last gate would merge a diff the gates never saw, and
running it before the review would have the review rewrite what it just did.
Here it runs on the diff that actually merges, and the gates behind it check
what it did — which also means the gate cache misses, correctly, when the tree
changed. `review` and `after_pr` are below.

A chore that fails is journalled and the phase goes on; a chore is
polish, and losing an implemented phase to one that timed out is the worse
trade. Set `on_failure: "fail"` on a chore the phase is not correct without. A
chore the harness had no capacity for is skipped for the same reason, rather
than re-driving a finished phase to fit the turn in. Neither applies to a
review chore: see below.

Each turn lands in the phase transcript attributed to `chore` and its id, beside
a `chore_result` event saying whether it ran, failed or was skipped.

### Chores about the PR — `when: "after_pr"`

Some work is about the pull request rather than the diff: posting a review
canvas, or leaving a summary comment. Give such a chore `"when": "after_pr"` and
`standard-phase` runs it in `integrate`, after `open_pr`. The turn is told the
PR's URL and number, and is told not to edit the tree: by then the phase is
merged and pushed. If no PR opened (no `gh`, or `gh` failed), the chore is
skipped. It cannot be `on_failure: "fail"`, because the merge cannot be undone.

The [PR Review Canvas](https://github.com/vintasoftware/pr-review-canvas)
integration is the motivating case. Once `pr-review install-skill` has run in
the project, this chore posts a topic-grouped review canvas on every phase PR:

```jsonc
"defaults": { "chores": ["review", "deslop", "review-canvas"] },
"chores": {
  "review-canvas": {
    "skill": "pr-review-canvas",
    "when": "after_pr",
    "prompt": "Run `/pr-review-canvas` with this phase's PR number. Report the review URL and the comment link."
  }
}
```

The node view links the phase's PR on its **Changes** card, or says why none
opened.

## The review — `when: "review"`

A phase's code review is a chore too ([SPEC §16](SPEC.md#16-the-review-loop)). A chore
with `"when": "review"` runs in the `review` state, once the phase's gates are
green, on the implementer's own session. `plan-feature` gives every plan one,
running the `thermo-nuclear-review-loop` skill:

- **The implementer runs the loop.** It spawns one reviewer sub-agent at the
  harness's most capable tier and keeps it for the whole turn, so a pass costs a
  message to a reviewer that still remembers the last one. The reviewer reads,
  runs commands and never edits.
- **Findings are leads, not orders.** The implementer checks each against the
  code, fixes the ones that hold up, answers the rest with counter-evidence, runs
  the gates through `vinta-ai-maestro gate`, commits the round, and sends the
  reviewer the next pass. A finding that needs your decision — an unreachable
  scenario, a defensive check, a requirements ambiguity, a destructive operation
  — comes to you as an agent question in the node view.
- **It ends on `VERDICT: pass` or `VERDICT: fail`.** Only the reviewer's explicit
  approval is a pass; a turn that states no verdict, or breaks, reads as a fail.
  By default it has no pass limit and runs until the reviewer approves. A node
  with `max_fix_rounds` set stops after that many passes that still had
  blockers, and reports instead of pausing on its own.
- **An unapproved review asks you** whether to continue the review for another
  round of the same budget or stop the phase. Under `--retry-after`, nobody
  answering takes `stop`, as an exhausted fix budget does.

Once the review passes, the `after_review` chores run (`deslop`, in a plan
`plan-feature` writes) and then `verify` runs the gates again on the tree that
merges. A tree the review loop left green and the polish left alone is a cache
hit there. A red `verify` goes back through `fix` and `gate` to the review,
because the fix changed code after the reviewer approved it.

A node with no review chore passes the review state, the way a node with no
gates passes the gate state.

## When an agent stops to ask

An implementer that hits a decision it should not make alone ends its turn with a `NEEDS_INPUT` block. This is the same protocol the shipped skills teach, and the implementer prompt spells it out. A question tool call that was the agent's last act counts too: `AskUserQuestion`, opencode's `question`, Codex's `request_user_input`. Either way the node parks as **Awaiting human**, you get a notification, and the node view shows a card:

- each option is a button, with the agent's description of what it does under it and its recommendation marked;
- the last choice is always **Other**, a text field for an answer no option covers. On a single-choice question it is exclusive: typing in it deselects the option you picked, and picking an option deselects it. On a multi-choice question it is one more box to tick;
- one single-choice question is answered by clicking an option;
- several questions are a wizard: one step each, number keys to pick, then a review step and **Send answers**.

The answer resumes the agent's own session, so it carries on from where it stopped with its context intact. Under `--retry-after`, nobody answering means the recommended options are taken after the interval, and the answer is marked unattended. The questions stay in the transcript, and the journal records only that the node paused and which options were picked (see [SPEC.md §9.1](SPEC.md)).

## Reviewing a plan before it runs

A plan is cheapest to fix before anything has run. The **Plans** section of the UI is a review page for a plan in `ai-plans/` that has not run yet. You can read and comment on all of it, and talk to the agent that wrote it, which revises the plan while you watch.

```bash
npx vinta-ai-maestro@alpha review open ai-plans/2026-03-04-bookmark-folders.workflow.json
```

`review open` serves the UI, as `ui` does, and prints a URL that opens on that plan's page. The page has four tabs and a sidebar:

| Tab | What it shows |
|---|---|
| **Graph** | The phase DAG, with wave bands and an artifact label on every edge. Each phase is coloured by its review state: no comments, open comments, comments resolved, or has issues. Below the graph is the selected phase in full: who implements it at which tier and model and whether a review chore reviews it, its pipeline as a strip of steps (implement → gates → review → polish → verify → integrate), what it depends on and unblocks, and its touch list. Its tabs hold the **brief**, the **implementer and fixer prompts**, its **gates** and its **chores** — the review loop's prompt among them. |
| **Plan** | The markdown plan, whole, with an outline. Every section has its own comment button. A section that is a phase's brief links to that phase on the graph. |
| **Gates** | A phase × gate matrix, and each gate's resolved command, scoped command, timeout and the pools it holds. "Resolved" means the project's `.vinta-ai-workflows.yaml` layered under the plan, so these are the commands a run executes. Resource pools and chores are listed too. |
| **Schedule** | `simulate`'s projection drawn as a timeline: which phases run side by side and which chain is the critical path. It uses default durations, so it shows the shape of the schedule, not how long the run will take. |
| **Issues** | Shown only when there are issues. It lists what `validate` reports. |

The prompts are the real ones: the same function a run calls composes them over an empty journal. A run differs in three ways: it uses its lane's path, it names the phase branch, and it adds the dependencies' final reports.

**Comments.** You can comment on the whole plan, a section, a phase, one of a phase's prompts, or a gate. You can also select text in the plan or a prompt and comment on the selection, which quotes it. A comment is saved as a **draft** at once and reaches the agent only when you press **Send to agent**. One send carries every unsent comment, like submitting a code review. Threads take replies and can be resolved or reopened.

**The agent chat.** The agent is the session that ran `plan-feature`, wherever it runs. It sits in a loop:

```bash
vinta-ai-maestro review wait  <workflow.json>          # blocks; prints what you sent as JSON
vinta-ai-maestro review reply <workflow.json> -m "…"   # answers in the chat
vinta-ai-maestro review reply <workflow.json> --comment c3 --resolve -m "…"   # answers on a thread
```

The chat shows the agent's state:

- **listening:** it is blocked in `wait`, so a message is read at once.
- **working:** it picked up your last message and has not answered yet.
- **away:** no agent is listening. The panel prints the exact `review wait` command for any agent to attach.

When the agent edits the plan or the workflow, the page notices and reloads them. **Approve plan** ends the loop: the agent's next `wait` returns `{"kind": "approved"}`. If you write again after approving, the review reopens.

**Where it lives.** The review is a committed document, `ai-plans/<id>.review.json`, written beside the plan and its workflow and validated by [`plan-review.v1.schema.json`](../../schemas/plan-review.v1.schema.json). The next reader of the plan can see what was questioned and what changed. The agent's presence (pid and heartbeat) and the file lock are per-machine state under `.vinta-ai-maestro/reviews/`. Both the page and the agent write the review under that lock, so neither can overwrite the other. The browser can only write as the person. Agent replies come only through `review reply`.

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

**3. Review and approve it in the editor.** `ui` serves the browser UI for the project. Its Editor lists every `ai-plans/*.workflow.json` in the project — the file you just wrote, or the one `plan-feature` wrote — and saving writes back to that same file:

```console
$ vinta-ai-maestro ui
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
vinta-ai-maestro: starting run widget-tags-mtvodosx in the background…
vinta-ai-maestro: run widget-tags-mtvodosx started (job pid 48213).
  status   vinta-ai-maestro status widget-tags-mtvodosx
  logs     vinta-ai-maestro logs widget-tags-mtvodosx --follow
  ui       vinta-ai-maestro ui
  pause    vinta-ai-maestro pause widget-tags-mtvodosx
  stop     vinta-ai-maestro stop widget-tags-mtvodosx
```

The command returns; the run does not need this terminal. The preflight is the job's — if it refuses, `run` prints the report and says the run did not start. Watch it from the terminal with `status` and `logs -f`, or keep `ui` open in another one and follow it in the browser. Both phases are assigned a lane immediately and implement concurrently, each in its own worktree under `.vinta-ai-maestro/lanes/`, on its own branch cut from `base_branch`:

```console
$ git branch
* main
+ plan/widget-tags/phase-p1
+ plan/widget-tags/phase-p2
+ wt/widget-tags-mtvodosx-integ
  wt/widget-tags-mtvodosx-lane-1
  wt/widget-tags-mtvodosx-lane-2
```

`plan/…/phase-<id>` is the phase's own branch; `wt/…` are the branches the lane and integration worktrees are checked out on. Need the machine back for an hour? `vinta-ai-maestro pause <run-id>` lets the phases finish the step they are in and ends the job; `vinta-ai-maestro run --resume <run-id>` carries on later. When the run ends, read [What this walkthrough has and has not been run against](#what-this-walkthrough-has-and-has-not-been-run-against) before you read the last two lines it prints.

**7. Read what happened, then clean up.** A finished run leaves its worktrees, branches and databases in place on purpose — they are the evidence. The post-mortem is written at the end and is what `plan-feature` reads before drawing the next feature's graph:

```console
$ cat .vinta-ai-maestro/runs/<run-id>/postmortem.json
$ vinta-ai-maestro purge <run-id> --dry-run
$ vinta-ai-maestro purge <run-id>
```

### What this walkthrough has and has not been run against

Every step above is transcribed from a real run of exactly these commands, and that run predates agent prompt composition — at the time, the scheduler handed the harness `node.prompt_ref` as the entire prompt for every role, so the reviewer of that time was never told to end its turn with `VERDICT: pass`, every node fell back to the fail-closed default, and the run ended with `failed nodes: p1, p2`.

**That cause is fixed.** `spawn_agent`'s `prompt_template` now selects a composed, per-role prompt, and the shipped `standard-phase` pipeline is driven to `done` in the test suite against real git worktrees, real branches, real gate commands and real merges — including the fix loop, where a red gate produces a fixer and the review that follows passes. The verdict protocol the review is asked for and the parser that reads it are one definition, so they cannot drift.

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
    job.json                    # while the job runs: pid, API address, token (0600)
    job.log                     # the job's console, every attempt appended
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

It is a file and a view, and they show the same records. Every process writes to the same file — each run's job and `ui` — and every record carries its `pid`. For one run's job alone, `vinta-ai-maestro logs <run-id>` is shorter:

```console
$ vinta-ai-maestro ui
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
$ vinta-ai-maestro ui --log-level debug   # adds a line per request and per socket
$ vinta-ai-maestro ui --log-stderr        # also print to the terminal, one line each
$ vinta-ai-maestro ui --log-detail kind   # drop error messages, keep kinds and frames
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

Each run's job has a token of its own, which it is never printed: it is written to that run's `job.json`, readable by your user only, and removed when the job ends. `ui` reads it to forward a live run's traffic, and the browser never sees it — its requests carry `ui`'s token, which the job would refuse. Treat `job.json` like the URL: it is access to the run.

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

`--permission <ask|auto|full|judged>` on `run` and `ui` (for the runs it starts), defaulting to **`auto`**: the agent works unattended inside its own lane, which is what a lane is for.

**The operator sets this, never the workflow document.** It is an argument to the command rather than a field in the JSON, and deliberately so — the document is committed and shared, and a file in a repository should not be able to tell someone else's machine to run agents without approvals. A plan may say which model writes a phase; it may not say how much of a stranger's filesystem that model gets.

| | claude-code | codex |
|---|---|---|
| `ask` | `--permission-mode manual` | `--sandbox workspace-write` |
| `auto` | `--permission-mode auto` | `--approve-for-me` |
| `full` | `--allow-dangerously-skip-permissions --permission-mode bypassPermissions` | `--dangerously-bypass-approvals-and-sandbox` |
| `judged` | as `full`, plus a `PreToolUse` hook that asks a System One classifier about each judged call | refused by `doctor` |

`ask` is the CLIs' own default and the one to avoid headlessly: nothing answers a permission prompt in a `run`. The request surfaces as a `permission_request` event and the transcript renders it, but no reply is ever sent — so the agent reports a blocked working directory and the phase fails having written nothing. Use it with `ui` open and a human watching, or not at all.

`full` is available and is not the default. Both vendors describe their equivalent as being for sandboxes with no internet access, and a lane is not that — it has the network and whatever credentials the machine holds.

`judged` is `full` with a check: every call to a judged tool (default `Bash`) is put to the classifier configured with `--system-one`, and runs only if it is judged safe. Anything that goes wrong along the way — no answer, no daemon, a hook that crashed — is a denial. It is faster than waiting on vendor prompts nobody will answer, and it is not a sandbox: a classifier reads one command line and cannot see what a script it names will do.

Two argument combinations are refused by the CLIs themselves, which is why the table is not symmetric: codex rejects `--sandbox` alongside `--approve-for-me` (the latter already implies the former), and `codex exec resume` accepts neither, so a resumed thread keeps the policy it was created under.

A lane is still a worktree of your repository, so committed settings travel into it: for `claude-code`, a `.claude/settings.json` narrowing tools further is honoured on top of whatever mode is passed.

## System One classifiers

`--system-one <config.json>` on `run`, `ui` and `doctor` points a run at a fast classifier — one that answers yes/no or scores a fixed set of labels, and writes nothing. The file is the operator's and never part of the plan:

```jsonc
{
  "adapter": { "type": "http", "url": "https://classifier.internal/v1", "api_key_env": "S1_API_KEY" },
  "judges": {
    "gate_triage": { "rerun_above": 0.8 },   // rerun a red gate the classifier calls flaky, once
    "permission": { "tools": ["Bash"], "allow_above": 0.9 }   // needed by --permission judged
  }
}
```

`http` POSTs `{ kind, question, labels, input }` and reads `{ scores }` or `{ yes }` back, with the key from the environment variable you name (removed from the daemon's environment once read, so agents never see it). Before a run starts, the preflight asks the classifier one synthetic question, so a missing or rejected key, or an unreachable URL, stops the run at minute zero instead of at the first gate. Set `"probe": false` to skip it. `doctor` also warns about an `http` adapter with no `api_key_env`, since that sends no `Authorization` header. `command` runs a local program with the same JSON on stdin and stdout — the choice when repository content must not leave the machine, because a hosted classifier receives diffs, gate logs and shell commands.

A plan can then declare **judge gates** next to its command gates:

```jsonc
"gates": {
  "unit": { "cmd": "pytest", "requires": ["test-suite"] },
  "no-body-logs": {
    "judge": { "question": "Does this diff log request or response bodies?", "fail_on": ["yes"], "threshold": 0.6 }
  }
}
```

A judge gate asks its question about the lane's diff and reports exit 0 or 1, so the pipeline and the fix loop treat it as any other gate; its log holds the question and the answer, which is what the fixer reads. It can only fail a phase — gates run in order and stop at the first red one — and without `--system-one` it answers per its `on_unavailable` (`pass` by default). See [SPEC.md §17](SPEC.md).

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
pnpm run review:schema:check       # plan-review.v1 vs src/review/document.ts
```

`schemas/workflow.v1.schema.json`, `schemas/postmortem.v1.schema.json` and `schemas/plan-review.v1.schema.json` are **generated** and drift-checked. Edit the zod source and regenerate with `schema:gen` / `postmortem:schema:gen` / `review:schema:gen`; never hand-edit the JSON.

The browser UI lives in `ui/` and is built on the workspace's design system, [`packages/design-system`](../design-system/README.md) — its tokens, its shadcn/ui components and its layout kit; the two canvas Web Components are re-skinned through their own custom properties in `ui/src/app.css` so the graph and the badges beside it share one palette. `pnpm run ui:dev` serves it with Vite against a running daemon; `pnpm run ui:build` writes the bundle the daemon serves into `dist/ui`. The UI follows the operating system's light or dark scheme by default; the toggle in the top bar remembers a choice per browser. Fonts ship in the bundle — the page makes no request outside its own origin.
