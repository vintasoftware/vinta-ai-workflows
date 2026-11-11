# Canned answers — bootstrap (vinta-bootstrap-ai-tools interview)

Answer every interview question with the following; do not ask for anything else.

- **Project name**: medplum-provider
- **Default branch**: main
- **Code host**: github
- **Stack**: React + Vite + TypeScript on @medplum/core / @medplum/react, React
  Router, Mantine; tests via Vitest + MockClient.
- **Medplum stack applies?**: Yes — the app consumes @medplum/react. It has no
  `bots/` dir and no tenant compartmenting, so apply only the SDK-consumer parts;
  skip bot/access-policy/notification categories.
- **ai-plans dir**: `ai-plans`
- **Vendors to wire**: claude-code (primary). Others optional.
- **Testing pack**: Medplum (`MockClient` + the two Vitest setup files), on top
  of the Vitest runner pack.
- **Keep a hand-tuned region marker** in AGENTS.md: include the literal comment
  `<!-- hand-tuned:keep -->` so sync preservation can be tested later.
- **Commits**: conventional; separate the AGENTS.md, config, and skills/agents
  commits logically.
