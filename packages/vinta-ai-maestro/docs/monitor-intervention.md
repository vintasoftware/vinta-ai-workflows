# Monitor intervention: letting the run tune itself

Status: implemented. The post-mortem half of "closing the loop" is not built.

## The failure this comes from

A six-phase run spent its afternoon re-creating the same test database. The
project's `unit` gate was `pytest`, with no `--reuse-db`, so every gate run in
every lane paid a full `CREATE DATABASE` plus the whole migration chain before
the first assertion executed. Multiply by the gate runs a fix round costs and
the run burned hours on setup nothing needed.

Nothing in the system was broken. Every phase did what it was asked, every gate
reported honestly, and the plan was valid. The run was simply **mis-tuned**, and
there was no path from "the machine can see this" to "the machine fixes it".
The monitor could have diagnosed it in one turn — the evidence is sitting in the
gate logs, one `Creating test database for alias 'default'...` per run — and had
no way to act on it.

That gap is what this is about. A plan is authored once, before anything runs,
by someone guessing at costs they cannot measure yet. A run learns things the
plan's author could not know. Today all of that learning goes into the
post-mortem, which helps the *next* feature and does nothing for the run
currently burning money.

## The shape

A watchdog notices a phase has been running past a threshold (1h by default),
wakes the monitor with a narrower brief than its conversational one, and the
monitor answers with a **structured proposal** that the host validates and
applies through the existing amend path.

```
watchdog (elapsed > threshold, or gate cost > threshold)
  └─> Monitor.intervene()  — reads gate logs, transcripts, durations
        └─> intervention.v1 document (closed set of verbs)
              └─> zod validation
                    └─> workflow mutation, built by host code
                          └─> amendRun()  — the existing gate, snapshot, journal
```

### Why a proposal and not a file write

The monitor has a shell and it runs in the repository. Letting it edit
`workflow.json` directly would be one line of brief text and would be wrong in
the way this package is consistently not wrong: **no unvalidated bytes reach a
run's definition**. Every other write in this system goes through
`parseWorkflow`, and a model with an `Edit` tool pointed at the snapshot is a
second, unguarded path to the same file.

So the model authors a patch document and host code translates it. The benefit
is not only validation — it is that the monitor's authority becomes
*enumerable*. "The monitor is not an orchestrator" stops being a sentence in a
docstring and becomes the set of verbs that exist.

### The verbs

| verb | payload | why it is safe to apply unattended |
|---|---|---|
| `retune_gate` | `{ gate, cmd, evidence }` | bounded by the gate's declared `tuning` — see below |
| `retime_gate` | `{ gate, timeout_s, evidence }` | a wrong value costs time; it cannot produce a false pass |
| `rebudget_fixes` | `{ node, max_fix_rounds, evidence }` | bounded by its own schema (`int >= 0`) |
| `retier_phase` | `{ node, model, evidence }` | costs money; the model must be on the run's roster |

What has deliberately **no verb**: `depends_on`, `prompt_ref`, `touches`,
`base_branch`, `pipeline`, and adding or removing nodes. The line is

> the monitor may change **how** the work is executed, never **what** work is
> done.

That is the same line `amend/diff.ts` already draws between `TOPOLOGY_KINDS` /
`body_changed` and everything else, so it falls out of machinery that exists
rather than being a second, parallel notion of "safe".

`evidence` is required on every verb. It cannot be mechanically verified — a
model can write a plausible sentence about a log line it never read — but it is
what the post-mortem scores after the fact, and a verb that cannot say why it
fired is a verb nobody can audit.

## The one thing that is not safe by construction

`timeout_s`, `max_fix_rounds` and `model` are bounded by their own schema types.
A wrong value there costs time or money and **cannot turn a red gate green**.

A gate command is different, and it is the motivating case. `--reuse-db` is
harmless. `-k`, `--deselect` and `--ignore=` are one keystroke away and silently
narrow what the gate proves. With no human in the loop, a monitor that
"optimised" a slow gate by running fewer tests would produce a run that passes
everything and ships nothing working — and it would look, in every log, like a
success.

Two mechanisms, applied together:

1. **A declared tuning surface.** `GateSchema` gains
   `tuning: { allowed_flags: [...] }`. The plan's author says, in the committed
   document, which flags the monitor may add to that gate. A gate with no
   `tuning` block is not tunable at all — `retune_gate` against it is refused.
   This is the same argument `harness/permissions.ts` makes about why a
   committed document may say which model writes a phase but may not say how
   much of a stranger's filesystem it gets: the blast radius of an autonomous
   edit has to be set by a human, in advance, in a file under review.

2. **An additive-argv rule**, always, as the floor. The proposed command must be
   the existing command's tokens, in order, plus new ones. Purely mechanical,
   and it blocks rewriting the test selection outright. It does *not* block
   adding a weakening flag, which is why it is the backstop and (1) is the
   answer.

## Anti-thrash

An hourly autonomous editor oscillates unless something stops it. Three rules,
all foldable from events the journal already carries:

- **`author` on `workflow_amended`** (`operator` | `monitor`). Needed for audit
  regardless of the rest.
- **A per-run intervention budget and a cooldown.** "Has the monitor already
  retuned gate `unit` in this run" is a fold over `workflow_amended.changes`.
- **No self-reversal.** The monitor may not undo an amendment it authored. Same
  fold.

## Closing the loop — not built

`postmortem.v1` should gain an `interventions[]` finding: what changed, on what
evidence, and whether the gate actually got cheaper afterwards. Without it there
is no way to learn that the feature is making runs worse, and `plan-feature`
never finds out that this project's `unit` gate wants `--reuse-db` *before* the
next run starts paying for it again.

Everything it needs is now recorded — `workflow_amended` rows carry `author` and
`targets`, `gate_result` rows carry `duration_ms` and `cached`, and
`runs/<id>/interventions.jsonl` holds every attempt including the refused ones
— so this is a fold and a schema addition rather than new plumbing.

## Where the record lives

Two places, deliberately split along §11's line.

`workflow_amended` carries `author` and `targets` — identifiers, in the journal,
served by the API. That is what the ledger folds and what an audit reads.

`runs/<run-id>/interventions.jsonl` carries the monitor's `summary` and every
verb's `evidence`. That is a model's prose about a repository, which is exactly
what does not go in an event payload. One line per attempt, appended, including
the attempts that changed nothing: a proposal that was *refused* is the most
interesting thing this feature produces — an agent trying to do something it may
not do, with nobody in the room — and a version that dropped those would be one
whose safety properties nobody could check afterwards.

## Implementation sequence

**1. `duration_ms` on the `gate_result` payload.** ✅

The gate runner measures it and it only ever reached the cache table, so "this
gate costs fourteen minutes every single time" was not answerable from the
journal. Prerequisite for both triggers and for scoring interventions after the
fact. Additive to the event payload; nothing that reads events has to change.

**2. Make an amended workflow reach the thing that runs the gate.** ✅

`adopt` replaced the scheduler's `#workflow` and nothing else. The executor, the
`AgentGateBroker` and the integrator each captured `workflow` at construction,
and the command actually executed is read from the *executor's* copy. An
amended gate command changed the snapshot, the journal and the pool
reservations — and not the command. This is a live bug for operator-driven
amendments today, independent of the monitor.

The executor and the broker now take an amendment, fanned out from one
`AmendRunner.adopt` in `run/start.ts`, host side first so no node is dispatched
against a definition half the system has not seen.

**The integrator still captures its plan, and is left that way on purpose.** It
reads node topology — branch names, wave membership, merge order — not the gate
table, so nothing in this step or in the monitor's verb set reaches it. What
*would* reach it is an amendment that adds a node or moves a dependency, which
is a pre-existing staleness that predates this work and is not made worse by
it. Fixing it means reconciling the integrator's wave index with a rebase queue
that is mid-flight, which is its own change with its own tests.

Paired with it: the gate cache is keyed `(gate id, tree hash)`, not the command,
so an amended gate with an unchanged tree was served the old result. The cache
key gains a hash of the command — hashed rather than stored, because a command
line is repository content. A cache database from before the change is dropped
on open: its rows cannot say which command produced them, and one re-run per
stale entry is the price `store` already accepts for a lost row.

**3. Narrow the in-flight refusal to the kinds that need it.** ✅

`amendRun` refuses while any *affected* node is in flight, and the affected set
closes over transitive dependents. The phase that is dragging is `running` by
definition, so a gate-command amendment was refused exactly when it was wanted.

Exactly one kind turned out to qualify: `gates_changed`, meaning the gate
*table* moved. A gate's command is captured by nothing — the scheduler, the
executor and the broker all resolve it per gate run, and step 2 made all three
take an amendment — so a running node's next gate runs the new command with no
stale window and no committed work invalidated.

`model_changed`, `harness_changed` and `pipeline_changed` deliberately did
*not* qualify, though they look similar. `Scheduler.adopt` replaces
`state.node` only for a node that has not started, so letting those through
would accept an amendment and then silently not apply it to the attempt in
flight. Refusing is the honest answer.

The split also forced a distinction `gates_changed` could not previously
express. Changing which gates a *node declares* is not a gate-table change: a
phase that gained a gate mid-flight would finish without ever running it and
end `done` against a definition it never satisfied. So the node's declared gate
list moved into `body`, where it blocks like the rest of the phase body.

And `affected` had to stop being the set the refusal reads. It closes over
transitive dependents for every kind, which is right for an audit record and
wrong here: a gate command moves no base, so nothing downstream of a node is
blocked by it. A separate `blocking` set closes over dependents only where a
base actually moved.

This is a narrowing of an existing rule rather than an exception carved out for
one caller — an operator editing a gate command in the UI mid-run gets the same
relief.

**4. The intervention vocabulary.** ✅

`src/intervention/` — the four verbs, the applier, the ledger, and
`schemas/intervention.v1.schema.json` generated from the zod source the way
`postmortem`'s is. `GateSchema` gained `tuning.allowed_flags`, and
`Monitor.intervene()` has a brief of its own.

Two things came out differently from the sketch above.

**The additive-argv rule needed its own tokenizer, and it refuses more than
expected.** A gate command is run by the platform's shell and the two shells
agree about almost nothing, so a general splitter would have to be right about
both to be worth having. The rule has a much smaller job — is this string that
string plus some arguments — so it refuses any command containing a shell
metacharacter at all. A gate that is a pipeline or a `&&` chain is simply not
tunable, which is the conservative direction and where a guard on an unattended
edit belongs.

**`retier_phase` has to read the crew.** A phase assigned to a crew member runs
on *that member's* model, and `crew` is mutually exclusive with `model`. Reading
`node.model ?? defaults.model` would call a phase staffed at tier 1 "already on
opus" and refuse the one retier worth making; applying the verb has to move the
phase off the roster rather than leave it with two sources of truth.

**5. The watchdog.** ✅

`intervention/watchdog.ts` for the triggers and `intervention/supervisor.ts` for
the timer, wired in `run/start.ts` so `maestro run` and `maestro serve` both get
it rather than only the daemon. Ten-minute tick, one-hour phase threshold,
thirty-minute cumulative gate ceiling, `--no-intervene` to turn it off.

The supervisor holds the workflow as a *function*, not a value: the run amends
itself, and a supervisor holding the snapshot it started with would propose its
second intervention against a document its first one already replaced.

The gate-cost trigger needed one more field than step 1 provided.
`gate_result` now also carries `cached`. Without it a fold over events cannot
tell a gate that ran from one that was served, and since a hit reports the
duration of the run that filled the cache, summing blindly would make a cache
*raise* a gate's apparent cost — the reverse of what it did. The first draft
inferred this from repeated identical durations, which is a guess where a fact
was available at both write sites.
