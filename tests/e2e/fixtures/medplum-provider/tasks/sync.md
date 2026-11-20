# Sync request — Upgrade the harness to the current version

This repo was bootstrapped against an **older** `vinta-ai-workflows` version.
Run `/vinta-sync-ai-tools` to upgrade it to the current version: bump schema
versions, add any new foundation skills, honor per-change apply gating, and
migrate the config.

Constraints:

- **Do not clobber hand-tuned regions.** `AGENTS.md` contains a
  `<!-- hand-tuned:keep -->` marker whose surrounding content must survive.
- **Opt-outs stay sticky.** Anything the project opted out of must not reappear.
- Managed harness files should converge on what a fresh current bootstrap
  produces.

Success = the harness-managed files match a current bootstrap (modulo hand-tuned
regions and the version/timestamp in the config), and the result lands as clean
commits.
