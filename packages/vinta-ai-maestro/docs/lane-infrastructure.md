# Lane infrastructure: what a lane has to *be*

Status: in progress, targeting `0.7.0-alpha9`.

## The failure this comes from

A six-lane run against a Django project completed every phase and then failed
almost every gate on docker port collisions. The collisions were the polite
symptom. The impolite one was invisible.

That project's `docker-compose.yml` has three independent collision sources:

| | |
|---|---|
| Fixed host ports | `db 5432:5432`, `result 6379:6379`, `api 8000:8000`, mailpit, floci |
| `external: true` volumes with pinned names | `dbdata`, `floci_data`, `virtualenv` |
| `env_file: .env.docker` | compose refuses to start where a fresh worktree has no copy |

The middle row is the serious one. Those volumes are pinned by absolute name,
so **every lane's stack mounts the same physical volume** — the same `PGDATA`,
under as many postmasters as there are lanes. That is not a collision that
fails loudly; it is corruption that surfaces later, somewhere else. The shared
`virtualenv` volume is the same shape of bug against the dependency tree: a
phase that installs a package changes the environment under every sibling
mid-run.

## Why the daemon did not prevent it

`LanePool.#provisionWorktree` provisioned a lane by doing four things: `git
worktree add`, symlink `node_modules`, clone the declared databases, and set
`COMPOSE_PROJECT_NAME`. A comment called that name "the isolation key for every
`docker compose` any project command might reach for."

It is not. `COMPOSE_PROJECT_NAME` namespaces containers, networks and
*auto-named* volumes. It does nothing about a fixed `ports:` binding and
nothing about a volume pinned with `name:` + `external: true` — which is
exactly the two things that project has.

The uncomfortable part is that **we already knew all of this**.
`prepare-worktree/SKILL.md` says it in as many words, and ships
`gen-compose-worktree-override.sh`, which strips published ports and re-pins
volumes per worktree. It specifies copying `.env` and wiring the override in
via `COMPOSE_FILE`. It specifies redis indices and S3 prefixes.

The daemon runs none of it. It provisions its own lanes and never invokes the
skill, so the skill's half of a documented contract simply never executed.
`LanePool` had reimplemented about a quarter of that skill and the rest stayed
prose.

**The rule this establishes:** if the daemon provisions it, the daemon must
know how to provision it correctly. Knowledge that only exists in a skill's
prose is knowledge the daemon does not have.

## Why no agent was ever seen taking a semaphore

Because an agent cannot. `requires` exists on `GateSchema` and nowhere else.
The scheduler takes a `lane` lease per node and the gate's pools around the
`run_gate` effect. An agent running the suite during its own inner loop holds
nothing, and there is no verb it could call to hold something.

So N agents boot N stacks with no coordination, and the containers they leave
running are still holding the ports when the gate starts. That is the likely
mechanism behind failures that cluster *at* the gate while the phase itself
reported success.

Gate commands *are* already in the prompt. What is not is the inner loop —
"lint clean, then each new test on its own, then the scoped suite" names no
command, so the agent guesses `pytest` where the project means `make test`
(which is `docker compose run --rm api python -m pytest … -n auto --reuse-db`).

## The four changes

### 1. The project declares what a lane needs and what its commands are

Three additive fields on the `project` block:

- `env_files` — repo-relative ignored files each lane gets its own **copy** of.
  Copied, never symlinked: provisioning appends lane-specific lines to them,
  and a symlink writes those back into the main checkout. A declared file that
  is missing fails provisioning, rather than producing a lane whose stack
  cannot boot.
- `commands` — a fixed vocabulary (`lint`, `typecheck`, `test`, `test_one`,
  `migrate`) rendered into every agent prompt verbatim, with the instruction to
  use them and not to reach for the underlying tool. A fixed vocabulary rather
  than free-form, because the prompt has to be able to say which one step 3
  means.
- `setup_cmd` — the project's own lane-setup hook, run inside the lane with the
  lane's environment applied. Required to be idempotent: it runs again on every
  recycle.

### 2. The daemon closes the compose leaks itself

Generate a compose override per lane, from `docker compose config --format
json`, and wire it in through the lane's copied env file via `COMPOSE_FILE`:

- strip host port publishing from every service that publishes a fixed port
  (via `!override []` — a plain `ports: []` merges in Compose v2+ and would not
  strip anything);
- re-pin every volume with a fixed `name:` or `external: true` to a
  lane-specific name, so two lanes never mount one data directory;
- record both in the lane summary, which is then the teardown manifest.

Where the project's own test command runs *inside* compose — as that Django
project's does — stripping published ports costs nothing, because services
reach each other by container DNS on the lane's own network. Where a host port
is genuinely needed, the same override republishes onto a per-lane port block
that is probed before it is accepted and recorded in the summary, so a second
run on the same machine does not silently reuse it.

### 3. Shared infrastructure, with a namespace per lane

`database.ts` already draws the right distinction: `delivery: 'external'` means
one shared server with a forked database per lane, and it works. Nothing
equivalent existed for redis, rabbit, or object storage — so those were either
booted per lane (N servers on a laptop) or shared with no isolation at all.

`project.services` generalizes it: each service declares how a lane gets its
own namespace inside one shared server — a database for postgres, a db index
for redis, a vhost for rabbit, a key prefix for object storage — and the lane's
environment is set accordingly. One server per machine instead of one per lane
is the difference between six lanes being viable on a laptop and not.

### 4. A lease an agent can actually take

`vinta-ai-maestro with <resource> -- <cmd>`: blocks until the daemon grants the
lease, runs the command, releases it on exit. It goes in the prompt as the
sanctioned way to run anything heavy, which makes the semaphore reachable from
inside a turn for the first time.

It needs a lease **expiry**, or one wedged agent starves the pool for the rest
of the run. The journal already has a `leases` table to hang that on.

## Ordering, and why

1 and 2 stop the bleeding and are small. 3 is the architecture and is worth
doing properly. 4 only pays off once 2 exists, because with ports stripped most
of the contention is gone — what remains is contention for the machine (CPU,
memory, a shared database server), which is what a semaphore is actually for.

## What is deliberately not decided here

Whether lanes should share a dependency volume read-only or each build their
own. Re-pinning `virtualenv` per lane is *correct* — it is the fix for the
silent corruption — but it costs each lane the install the shared volume was
avoiding. That is a call about a team's workflow, not a bug to be fixed
quietly, so the generator re-pins by default and the project can override it.
