# Handoff: lane infrastructure (items 1–4), targeting `0.7.0-alpha9`

Written mid-task, at the user's request, for whoever picks this up.

**Read [lane-infrastructure.md](lane-infrastructure.md) first.** It is the plan
this is executing and it carries the diagnosis — the failing project's compose
file, the three collision sources, and why the daemon did not prevent any of
them. This document is only *where things stand*.

## State

Branch `claude/lane-infrastructure`, cut from `origin/alpha` (`4a90137`, the
alpha8 release commit). Nothing pushed, no PR open.

```
2f9b530 feat(lanes): one shared server, a namespace per lane          # item 3
2207609 feat(lanes): close the compose leaks the project name …       # item 2
02f285b feat(lanes): a project says what a lane needs and what …      # item 1
4a90137 chore(release): v0.7.0-alpha8                                 # origin/alpha
```

Working tree clean. **1070 tests passing**, both typechecks clean, as of
`2f9b530`. CI has not run — none of this has been pushed.

The user's instruction was: *"implement all 4 items in the order you proposed
and release alpha9. DO NOT SKIP/LEAVE ANY OF THEM FOR LATER!"* Items 1–3 are
done. Item 4 is not started. The release is not done.

## What is done

### Item 1 — the project declares what a lane needs (`02f285b`)

Three additive fields on `project`, in [types.ts](../src/types.ts):

- `env_files` — copied into every lane by `LanePool.#copyEnvFiles`, and
  **copied rather than linked** because provisioning appends to them. A
  declared file the checkout lacks throws `LaneEnvFileError` — fail-closed, and
  the alternative is a lane that provisions cleanly and cannot boot four steps
  later wearing an unrelated error. Re-copied on recycle, which `git clean`
  cannot do: the file is ignored, so the clean leaves whatever the last phase
  made of it.
- `setup_cmd` — `LanePool.#setup`, run in the lane with the lane's env. Runs
  again on every recycle, hence the idempotence in its contract.
- `commands` — a **fixed vocabulary** (`lint`, `typecheck`, `test`, `test_one`,
  `migrate`), rendered by `commandBlock()` in
  [prompts.ts](../src/prompts/prompts.ts) into the implementer, reviewer and
  fixer prompts. Fixed rather than free-form so the implementer's step 3 can
  point at one by name; `hasCommands()` switches that sentence, and a workflow
  declaring none gets byte-for-byte the prompt it had.

### Item 2 — the compose leaks (`2207609`)

New [compose.ts](../src/lanes/compose.ts). `planComposeIsolation` is **pure**:
config in, override document out, so every rule is testable with a JSON object
and no docker. `readComposeConfig` is the thin impure half.

It is a TypeScript port of `prepare-worktree`'s
`gen-compose-worktree-override.sh`, whose detection rules were already right and
which the daemon never ran. **Those rules are the contract — do not let the two
drift.** A volume leaks when it is `external: true` *or* its resolved name is
not the auto-namespaced `<project>_<key>`, which is what a fixed top-level
`name:` looks like after compose resolves it. `external: false` in the override
is mandatory, and `!override []` is mandatory — a plain `ports: []` merges in
Compose v2+ and strips nothing.

The override is written **out of tree**, under `.vinta-ai-workflows/worktrees/`,
never as `docker-compose.override.yml` at the worktree root: that path is
auto-loaded, and it is frequently a tracked file, so writing there would put the
lane's isolation into the phase's diff and then into the merge.

**The second half of this commit is the one to understand.** `AgentTask.env` did
not exist. Lane environment reached *gates* and stopped there, so every lane's
agent ran `docker compose up` under the daemon's bare environment and resolved
to the same compose project. It is now threaded
`LanePool.Lane.env` → `HostWiring.laneEnv` → `SchedulerOptions.laneEnv` →
`AgentTask.env` → each adapter's `childEnv(STRIPPED_ENV, task.env)`, and through
`PtyAttach.env` to an operator's takeover terminal. **The overlay is applied
before `STRIPPED_ENV` is removed, never after** — a lane environment must not be
able to reinstate a provider credential §2 exists to strip.

`PoolOptions.readCompose` is a test seam, following `perLaneBytes`'s existing
precedent: without it the wiring is testable only on a machine running docker.

### Item 3 — shared infrastructure (`2f9b530`)

New [services.ts](../src/lanes/services.ts), pure like `database.ts`.
`project.services` generalizes what `delivery: 'external'` already did for
Postgres: one server, a namespace per lane. `namespace: 'index'` for a server
with fixed slots (redis), `'name'` for one that names freely (vhost, prefix).
The engine is deliberately not modelled — `create_cmd` / `reset_cmd` are the
project's own lines, with `{namespace}`, `{url}`, `{lane}` substituted.

A pool larger than a service's `capacity` is refused before anything is created
(`ServiceCapacityError`), rather than wrapped with a modulo.

Two decisions worth not re-litigating blindly:

- `Lane.index` is **stable across a re-provision**, because an `index` namespace
  is derived from it and a lane whose redis database moved between phases is a
  lane that lost its own state.
- **Services do not vote on `Lane.reusable`.** A database with no reset truly
  cannot be handed on (next phase, previous schema); a service with no reset
  merely keeps what the last phase left, which for a cache is usually right.
  Making them vote would force a full worktree re-provision over an
  `S3_PREFIX`. This is a judgement call and it is written down in the code.

## What is left

### Item 4 — a lease an agent can actually take

Not started. The design, from the plan doc:

> `vinta-ai-maestro with <resource> -- <cmd>`: blocks until the daemon grants
> the lease, runs the command, releases it on exit.

Why it matters: `requires` exists on `GateSchema` and **nowhere else**. The
scheduler takes a `lane` lease per node (`scheduler.ts`, `#runNode`) and a
gate's pools around the `run_gate` effect (`#acquireGate`). An agent running the
suite in its own inner loop holds nothing, and there is no verb it could call.
That is why no agent has ever been seen taking a semaphore — not a
configuration mistake, an absent capability.

What exists to build on:

- [`ResourcePools`](../src/resources/pools.ts) — `acquire(needs)` returns a
  `Lease` with an idempotent `release()`. Canonical ordering, all-or-nothing,
  FIFO with aging. Already correct under concurrency; do not reimplement it.
- The daemon API ([api.ts](../src/daemon/api.ts)) is Hono, every route under
  `/api/`, guarded by one process-minted bearer token
  ([auth.ts](../src/daemon/auth.ts)) accepted in a header *or* the query.
- `journal.acquireLease(resource, holderNode)` / `releaseLease(...)` /
  `leases()` already exist and are already called around gates. The `leases`
  table is deliberately *not* replayed across a restart — a lease records that a
  live process holds a slot, and after a restart no such process does.

Sketch, not prescription:

1. `POST /api/runs/:runId/leases` with the resource ids; hold the request open
   until granted, or return a lease id the client polls. `DELETE
   /api/runs/:runId/leases/:leaseId` releases. Journal both, as gates do.
2. A `with` verb in [src/cli/](../src/cli/) that reads the daemon URL and token
   the same way the agent's environment would carry them, acquires, spawns
   through `shellInvocation` (never a raw shell — see
   [platform.ts](../src/platform/platform.ts)), and releases in a `finally`.
3. **Lease expiry.** One wedged agent must not starve the pool for the rest of
   the run. `ResourcePools` has no TTL today; this is the one piece of new
   mechanism the feature needs, and it is the piece most worth a test.
4. Surface it: the agent has to be *told* to use it. That means the lane
   environment carrying the daemon URL and token, and `commandBlock()` or a
   sibling saying "run anything heavy through this". Without step 4 the feature
   exists and nothing uses it — which is precisely the failure this whole branch
   is a correction of.

Open question the user should settle: whether `requires` should also become
declarable on a **node**, letting a phase hold a pool for its whole agent turn.
It is simple, and it serializes the phase entirely, so it is usually too coarse
— but it is the right answer for a phase that genuinely needs exclusive use of a
machine-wide resource. I would build `with` first and offer this as an escape
hatch, not instead of it.

### The release

Not started. Before it:

- **CHANGELOG.** No entries have been written for any of items 1–4. The
  `release` skill validates that the in-progress section is non-empty and
  refuses otherwise. Four bullets, in the style of the existing ones.
- **Push and get CI green** on macOS / Ubuntu / Windows. None of this has been
  near CI. Windows is the one to watch: this branch adds `delimiter`-joined
  `COMPOSE_FILE` values, new temp-directory fixtures, and commands spawned
  through `sh()` — all three have produced Windows-only failures in this
  package before (`EBUSY` on open handles, `cmd.exe` quoting, path separators).
- Then `/release`, kind `alpha`, **from the `alpha` branch** — the skill refuses
  an alpha cut from `main` and it is right to.

### Standing item, unrelated to this branch

`vinta-ai-maestro`'s `latest` dist-tag still resolves to `0.7.0-alpha1`. A
workflow cannot fix it — moving a dist-tag is not a publish. It needs
`npm dist-tag add vinta-ai-maestro@<stable> latest` once a stable exists.

## Things that will bite you

- **`schema:gen` after every `types.ts` edit.** `schemas/workflow.v1.schema.json`
  is generated and drift-checked in CI, and the check is not part of
  `typecheck`. Run `pnpm --filter vinta-ai-maestro schema:gen`.
- **Zod `.default({})` on an object whose fields have defaults** fails to
  typecheck — the output type has required properties. Pass a function:
  `ComposeSchema.default(() => ({ ... }))`. `CommandsSchema.default({})` works
  only because every one of its fields is optional.
- **`writeSummary` takes `WorktreeSummaryInput`** (`z.input`), not
  `WorktreeSummary`, and parses on the way out so the file is written complete.
  A test building a summary literal wants the `Input` type.
- **The lane env the executor holds is captured once**, at provisioning
  (`createRunExecutor({ lanes: pool.lanes.map(...) })`). This is why compose
  ports are allocated once and the override is not regenerated on recycle: new
  ports would not reach the gates. `laneEnv` reads *through* the pool
  (`pool.lane(name).env`) precisely so a re-provision's new `Lane` object is
  seen — do not "simplify" it back to a captured map.
- **Known bound, documented in `#composeConfig`:** the compose config is read
  once per pool, from the base ref. A phase that *adds* a compose service
  mid-run publishes a port the override does not know to strip. Narrower than
  the gap it closes; closing it would mean re-planning ports a running executor
  already holds.
