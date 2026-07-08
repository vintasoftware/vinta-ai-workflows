#!/usr/bin/env bash
# gen-claude-sandbox-settings.sh — generate a Claude Code settings.json that
# confines a worktree session (orchestrator + its in-process Task sub-agents)
# to writing inside the worktree, blocking stray writes to the main checkout.
#
# Claude Code runs sub-agents in-process (the Task tool shares the orchestrator's
# OS process), so the subprocess-wrapping model of sandbox-run.sh does not apply
# — the guard has to live in the harness's own settings. This script wires two
# complementary layers, matching prepare-worktree's deny-main/allow-rest model:
#
#   Layer A (always) — a PreToolUse hook (claude-worktree-write-guard.py) that
#     blocks the file-editing tools (Edit/Write/MultiEdit/NotebookEdit) from
#     writing outside the worktree. Filesystem-only; no network impact. Fires
#     for the orchestrator AND every Task sub-agent (shared session pipeline).
#
#   Layer B (opt-in, --os-sandbox) — Claude Code's NATIVE OS sandbox
#     (`sandbox.filesystem.denyWrite`/`allowWrite`, Seatbelt on macOS / bwrap on
#     Linux) so Bash-issued writes are blocked at the kernel too. NOTE: enabling
#     the native sandbox also turns on NETWORK isolation — dep installs and
#     `git push` break unless you allow-list registries/remotes. Pass the hosts
#     the plan needs via --allow-domain (repeatable). Without --os-sandbox, Bash
#     writes fall back to implement-plan's post-run `git -C <main> status` check.
#
# Both layers keep <worktree>, <main>/.git (git worktrees commit into the main
# repo's .git), and the shared .vinta-ai-workflows dir writable.
#
# Usage:
#   gen-claude-sandbox-settings.sh \
#     --worktree <worktree-path> \
#     --main     <main-checkout-root> \
#     [--allow <extra-writable-path>]...   # e.g. .vinta-ai-workflows if elsewhere
#     [--out <settings-file>]              # default: <worktree>/.claude/settings.json
#     [--os-sandbox]                       # also emit the native sandbox block
#     [--allow-domain <host>]...           # network hosts to allow under --os-sandbox
#
# The generated file is meant to govern a Claude Code session ROOTED IN THE
# WORKTREE (`cd <worktree> && claude`), the recommended claude-code topology for
# an isolated plan run — the settings are read at session start. See Step 5.5 of
# ../SKILL.md for the two deployment models and their timing caveats.
#
# Exit: 0 on success; 2 on argument/setup errors.

set -u

die() { echo "gen-claude-sandbox-settings: $*" >&2; exit 2; }

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
GUARD="$SCRIPT_DIR/claude-worktree-write-guard.py"

WORKTREE=""; MAIN=""; OUT=""; OS_SANDBOX=0
EXTRA_ALLOW=(); DOMAINS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --worktree)     shift; [ $# -gt 0 ] || die "--worktree needs a path"; WORKTREE="$1"; shift ;;
    --main)         shift; [ $# -gt 0 ] || die "--main needs a path"; MAIN="$1"; shift ;;
    --out)          shift; [ $# -gt 0 ] || die "--out needs a path"; OUT="$1"; shift ;;
    --allow)        shift; [ $# -gt 0 ] || die "--allow needs a path"; EXTRA_ALLOW+=("$1"); shift ;;
    --allow-domain) shift; [ $# -gt 0 ] || die "--allow-domain needs a host"; DOMAINS+=("$1"); shift ;;
    --os-sandbox)   OS_SANDBOX=1; shift ;;
    *)              die "unknown arg: $1" ;;
  esac
done

[ -n "$WORKTREE" ] || die "--worktree <path> required"
[ -n "$MAIN" ]     || die "--main <path> required"
[ -f "$GUARD" ]    || die "guard hook not found next to this script: $GUARD"

# Canonicalize (leaf need not exist).
canon() {
  local p="$1" d b
  if [ -d "$p" ]; then (cd "$p" && pwd -P); return; fi
  d=$(dirname "$p"); b=$(basename "$p")
  if [ -d "$d" ]; then echo "$(cd "$d" && pwd -P)/$b"; else echo "$p"; fi
}

WORKTREE=$(canon "$WORKTREE")
MAIN=$(canon "$MAIN")
[ -d "$WORKTREE" ] || die "worktree path is not a directory: $WORKTREE"
[ -d "$MAIN" ]     || die "main checkout path is not a directory: $MAIN"
[ -z "$OUT" ] && OUT="$WORKTREE/.claude/settings.json"

# Writable exceptions punched back through the main-checkout deny: the worktree,
# the shared git database (worktree commits land in <main>/.git), the shared
# .vinta-ai-workflows dir, plus any caller extras.
ALLOW=("$WORKTREE" "$MAIN/.git" "$MAIN/.vinta-ai-workflows")
for p in "${EXTRA_ALLOW[@]:-}"; do [ -n "$p" ] && ALLOW+=("$(canon "$p")"); done

if [ "$OS_SANDBOX" -eq 1 ] && [ "${#DOMAINS[@]}" -eq 0 ]; then
  echo "gen-claude-sandbox-settings: WARNING --os-sandbox with no --allow-domain — network" >&2
  echo "  isolation is ON, so dep installs / git push over the network will fail. Pass the" >&2
  echo "  registry + git remote hosts via --allow-domain, or drop --os-sandbox for hook-only." >&2
fi

mkdir -p "$(dirname "$OUT")" || die "cannot create settings dir for $OUT"

# Emit JSON via python3 (safe escaping of paths); merge into an existing file if
# one is present so we don't clobber unrelated settings the worktree may carry.
GUARD="$GUARD" OUT="$OUT" MAIN="$MAIN" WORKTREE="$WORKTREE" OS_SANDBOX="$OS_SANDBOX" \
python3 - "${ALLOW[@]}" -- "${DOMAINS[@]:-}" <<'PY' || die "failed to write settings"
import json, os, sys

guard, out, main, worktree = (os.environ[k] for k in ("GUARD", "OUT", "MAIN", "WORKTREE"))
os_sandbox = os.environ["OS_SANDBOX"] == "1"

sep = sys.argv.index("--")
allow = [a for a in sys.argv[1:sep] if a]
domains = [d for d in sys.argv[sep + 1:] if d]

# Layer A — PreToolUse write-guard hook (always).
guard_cmd = " ".join(
    [json.dumps(guard) if " " in guard else guard, "--deny", main]
    + sum((["--allow", a] for a in allow), [])
)
hook_entry = {
    "matcher": "Edit|Write|MultiEdit|NotebookEdit",
    "hooks": [{"type": "command", "command": guard_cmd}],
}

# Merge into an existing settings file if present (preserve unrelated keys).
settings = {}
if os.path.exists(out):
    try:
        with open(out) as f:
            settings = json.load(f) or {}
    except Exception:
        settings = {}

hooks = settings.setdefault("hooks", {})
pre = hooks.setdefault("PreToolUse", [])
# Drop any prior guard entry (idempotent re-runs) then append the fresh one.
pre = [e for e in pre if "claude-worktree-write-guard" not in json.dumps(e)]
pre.append(hook_entry)
hooks["PreToolUse"] = pre

# Layer B — native OS sandbox (opt-in).
if os_sandbox:
    settings["sandbox"] = {
        "enabled": True,
        # Degrade to unsandboxed on platforms without Seatbelt/bwrap rather than
        # hard-failing the run; the hook (Layer A) still guards file writes.
        "failIfUnavailable": False,
        "filesystem": {
            "denyWrite": [main],
            "allowWrite": allow,
        },
        "network": {
            # Sandbox forces network isolation; without an allow-list, installs
            # and pushes break. Callers pass registry + remote hosts.
            "allowedDomains": domains,
        },
    }

with open(out, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")

print(f"wrote {out}")
print(f"  layer A (hook): guard on Edit|Write|MultiEdit|NotebookEdit, deny {main}")
print(f"  allow-write: {', '.join(allow)}")
if os_sandbox:
    dom = ", ".join(domains) if domains else "(none — network will be blocked)"
    print(f"  layer B (os sandbox): enabled, network allowedDomains: {dom}")
else:
    print("  layer B (os sandbox): OFF (hook-only; Bash writes rely on the post-run backstop)")
PY

echo "gen-claude-sandbox-settings: done."
