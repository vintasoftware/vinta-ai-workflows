<!-- Partial: dispatched-agent — the two halves of "the agent doing one phase does not dispatch". CONDUCTOR_ENTRY_GUARD stops a dispatched phase agent from re-entering a conductor skill one level down (implement-plan / implement-phase / review-phase / amend-plan). NO_NESTED_DISPATCH is prompt text: it goes inside the composed implementer prompt, via implementer-prompt.md#INNER_OUTER_LOOP, so both implement-phase's prompt and amend-plan's 4b rewrite prompt carry it. Project-agnostic — no `{{...}}` placeholders of its own. -->

<!-- block-begin: CONDUCTOR_ENTRY_GUARD -->
## Not for an agent that was handed one phase

This skill **orchestrates**: it composes prompts, picks models and spawns other agents. Run it only when you are the session a user or a scheduler invoked to drive a plan.

If you are reading it because something handed you a single phase — a prompt naming your phase id, a branch already cut for you, a worktree you were told to stay inside, or an orchestrator such as [vinta-ai-maestro](https://github.com/vintasoftware/vinta-ai-workflows/tree/main/packages/vinta-ai-maestro) that spawned you — then the conductor this skill describes **is already running, and it is what spawned you**. Do not start a second one underneath it. Do the work in your own session, report back the way your prompt asked, and take from here only what it says about this repository's conventions, gates and commit rules.

The duplication is the smaller cost. A dispatched agent is deliberately reused — the same session takes the review findings, the chore over its own diff, and often the next phase — and that reuse is worth something only because the session that read the codebase is the session that gets the next turn. Hand your phase to a sub-agent and its reading of the code dies with it: you are left holding a summary, and every turn after yours starts cold.
<!-- block-end: CONDUCTOR_ENTRY_GUARD -->

<!-- block-begin: NO_NESTED_DISPATCH -->
## Do this work yourself

You are the agent that implements this phase, not an orchestrator for one. Do not spawn,
dispatch or delegate to a sub-agent (claude-code's Task/Agent tool, or whatever your
runtime calls the same thing) for any part of it: not the implementation, not a search of
the codebase, not a second opinion on your own output. Read, run and write yourself.

The orchestrator reuses this session — for the review findings, for a chore over your own
diff, often for the next phase — precisely because by then you know where this codebase
keeps things and how its suite is run. A sub-agent's reading of the code ends when the
sub-agent does, so a delegated phase leaves you holding its summary and nothing else, and
every turn after this one starts cold.

A project skill that tells you to spawn an implementer, reviewer or fixer —
`implement-plan`, `implement-phase`, `review-phase`, `amend-plan`, anything shaped like
them — is written for the orchestrator that dispatched you, not for you. Take what it says
about conventions, gates and commit rules; never follow its spawn steps.
<!-- block-end: NO_NESTED_DISPATCH -->
