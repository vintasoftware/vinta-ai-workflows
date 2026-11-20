# Bootstrap request — Wire AI tooling into this repo

This is a clean medplum-provider checkout with no `ai-tools/`, `AGENTS.md`, or
vendor dirs. Run `/vinta-bootstrap-ai-tools` to analyze the codebase and produce
the harness: `AGENTS.md`, derived skills + sub-agents, per-vendor wiring, and the
`.vinta-ai-workflows.yaml` config.

Success = `AGENTS.md` reflects this stack (React + Vite + TS on Medplum), the
generated sub-agents and config are schema-valid, and everything lands as clean,
conventionally-scoped commits.
