#!/usr/bin/env python3
"""claude-worktree-write-guard.py — Claude Code PreToolUse hook that blocks
file-tool writes escaping a worktree into the protected main checkout.

Why this exists: Claude Code runs sub-agents (the Task tool) IN-PROCESS — they
share the orchestrator's OS process and tool pipeline, so there is no child
launch command to wrap with an OS sandbox (that model only works on harnesses
that spawn sub-agents as subprocesses, e.g. `codex exec`). A session-level
PreToolUse hook, by contrast, fires for every tool call in the session —
orchestrator AND Task sub-agents alike — because they run through the same
pipeline. This hook is the in-process equivalent of prepare-worktree's
`sandbox-run.sh` deny-main/allow-rest guard, scoped to the file-editing tools.

Scope: the file-write tools only — Edit, Write, MultiEdit, NotebookEdit. Bash
writes are NOT covered here (a hook can't reliably know every path a shell
command touches); use Claude Code's native `sandbox` (see
gen-claude-sandbox-settings.sh `--os-sandbox`) for OS-level Bash confinement,
and rely on implement-plan's post-run `git -C <main> status` backstop otherwise.

Model — deny-main, allow-rest (mirrors sandbox-run.sh): every path is allowed
EXCEPT ones that resolve under a --deny root, and an --allow root punches a
subtree back to writable even when nested under a --deny root. The worktree
usually lives UNDER the main checkout (.claude/worktrees/<name>/), and git
worktrees write commits into <main>/.git, so both the worktree and <main>/.git
are passed as --allow. Symlinks are resolved (realpath) before the check, so a
write through a symlink that lands back in the main checkout (e.g. a shared
node_modules) is correctly caught.

Usage (wired by gen-claude-sandbox-settings.sh into settings.json hooks):
    claude-worktree-write-guard.py \
        --deny  <main-checkout-root> \
        --allow <worktree-path> \
        --allow <main-checkout-root>/.git \
        --allow <main-checkout-root>/.vinta-ai-workflows

Reads the PreToolUse event JSON on stdin. Blocks by exiting 2 with a reason on
stderr — Claude Code feeds that stderr back to the model as the denial reason,
so the agent retries against the correct worktree path. Any non-write tool, or
a write that stays inside an --allow subtree, exits 0 (allowed). The guard fails
OPEN (exit 0) on malformed input or its own errors — it is a safety net layered
under the OS sandbox and the post-run backstop, never the sole gate, and must
never wedge a run by denying on a parsing hiccup.
"""
import json
import os
import sys

# Tool-input keys that carry a write target, per tool.
PATH_KEYS = ("file_path", "notebook_path")
GUARDED_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}


def canon(path):
    """Absolute, symlink-resolved path. realpath resolves a shared node_modules
    / .vinta-ai-workflows symlink back to its real location so the prefix check
    reflects where the byte actually lands, not the symlink's apparent path."""
    return os.path.realpath(os.path.abspath(path))


def under(path, root):
    """True if `path` is `root` or nested beneath it. Compares canonical paths
    with a trailing separator so /main-evil is not treated as under /main."""
    path, root = canon(path), canon(root)
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def parse_args(argv):
    deny, allow = [], []
    i = 0
    while i < len(argv):
        if argv[i] == "--deny" and i + 1 < len(argv):
            deny.append(argv[i + 1]); i += 2
        elif argv[i] == "--allow" and i + 1 < len(argv):
            allow.append(argv[i + 1]); i += 2
        else:
            i += 1
    return deny, allow


def main():
    deny, allow = parse_args(sys.argv[1:])
    if not deny:
        # Nothing to protect — nothing to do.
        return 0

    try:
        event = json.load(sys.stdin)
    except Exception:
        return 0  # fail open — never wedge a run on a parse error

    if event.get("tool_name") not in GUARDED_TOOLS:
        return 0

    tool_input = event.get("tool_input") or {}
    target = next((tool_input[k] for k in PATH_KEYS if tool_input.get(k)), None)
    if not target:
        return 0  # no write target we recognize

    # allow wins over deny (the worktree + .git + .vinta-ai-workflows are nested
    # under the denied main root and must stay writable).
    if any(under(target, a) for a in allow):
        return 0
    if any(under(target, d) for d in deny):
        resolved = canon(target)
        wt = allow[0] if allow else "the worktree"
        sys.stderr.write(
            f"Blocked write to the main checkout: {resolved}\n"
            f"This file is outside the worktree. Write to the worktree instead "
            f"(under {wt}). If you meant to edit a shared file, it is protected "
            f"for the duration of this plan run.\n"
        )
        return 2  # exit 2 → Claude Code blocks the call, stderr is the reason

    return 0


if __name__ == "__main__":
    sys.exit(main())
