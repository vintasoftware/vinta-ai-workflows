# Canned answers — sync (vinta-sync-ai-tools interview)

Answer every question with the following; do not ask for anything else.

- **Apply all pending changes** for this upgrade unless one conflicts with a
  hand-tuned region — in that case preserve the hand-tuned content and note it.
- **Preserve** the `<!-- hand-tuned:keep -->` region in `AGENTS.md` verbatim.
- **Respect existing opt-outs** — do not re-add anything previously opted out.
- **Config**: update `vinta_ai_workflows_version` and `last_synced_at`; keep
  project-specific fields as-is.
- **Commits**: conventional; one logical commit per applied change group.
- **No interactive confirmation** between changes — proceed autonomously and
  summarize what was applied vs. preserved at the end.
