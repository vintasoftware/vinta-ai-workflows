# Stack templates

Each subdirectory here defines a **stack** — a set of detection signals + a description of what kinds of skills + sub-agents typically belong to that stack. The bootstrap flow uses these to:

1. Detect (via [vinta-analyze-codebase](../../../vinta-analyze-codebase/SKILL.md)) which stacks the target project matches.
2. Ask the user "I detected stack X; do you have skill / sub-agent templates for it? Point me at them" — bootstrap doesn't ship pre-baked content.
3. Copy + adapt the user-provided templates into the target's `ai-tools/skills/` and `ai-tools/agents/`.

This keeps the bootstrap skill **infrastructure only**. Specific skill content (e.g. "how to add a Medplum bot") lives wherever the user keeps their personal / team skill library, not here.

## Layout per stack

```
<stack-name>/
└── notes.md     # detection signals + typical skill/agent categories for this stack
```

That's it. No `skills/` or `agents/` subdirs with content — those would be project-specific by nature, and the bootstrap orchestrator can't ship "the right" Medplum / Django / etc skill for every team.

## How the orchestrator uses these

For each stack whose detection signals match the target's analyze-codebase inventory:

1. Read `<stack>/notes.md`.
2. Surface the match to the user: *"This project looks like a Medplum stack. The notes say teams typically maintain skills for: bot creation, AccessPolicy management, notification dispatch. Do you have existing templates for any of these?"*
3. If yes → ask for paths (filesystem, Git URL, gist, etc). Copy + adapt into target's `ai-tools/`.
4. If no → record as a known gap. The user can run [vinta-derive-skills](../../../vinta-derive-skills/SKILL.md) standalone later to draft them from scratch.

## Adding a new stack

1. `mkdir resources/stacks/<stack-name>`.
2. Write `notes.md` with:
   - **Detection signals** (what tells you this stack matches).
   - **Skill categories typically needed** (just names + one-liners — no full SKILL.md content).
   - **Agent categories typically needed** (same).
   - **Common placeholders** the orchestrator should ask the user about (paths, command names, env-var names).
3. Update [vinta-analyze-codebase](../../../vinta-analyze-codebase/SKILL.md) §3 if a new dep / signal-file table row is needed.
4. Update [vinta-bootstrap-ai-tools](../../SKILL.md) "Stack templates" table.

## Existing stacks

| Stack | Detection notes |
|---|---|
| [medplum/](medplum/) | FHIR R4 backend, bot deploy, AccessPolicy model |
| [django/](django/) | Django + Postgres, multi-tenant if `tenant_id` columns / partitioning |
| [typescript-monorepo/](typescript-monorepo/) | Turbo / pnpm workspaces, `apps/` + `lib/` layout |
| [python-package/](python-package/) | `pyproject.toml` non-Django, `src/<pkg>/` layout |
| [nextjs-app-router/](nextjs-app-router/) | Next.js App Router, `app/` directory |

Add stacks as the team encounters new ones. Each is one notes.md file.
