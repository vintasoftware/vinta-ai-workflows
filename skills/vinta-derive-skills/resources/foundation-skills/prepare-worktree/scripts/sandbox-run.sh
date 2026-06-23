#!/usr/bin/env bash
# sandbox-run.sh — run a command with writes to a protected subtree (the main
# checkout) blocked at the OS level, regardless of which agent harness issues
# the writes. Harness-agnostic: it confines the *process*, not the tool.
#
# Model: deny-main, allow-rest. The whole filesystem stays writable EXCEPT the
# --deny subtree(s), with --allow subtree(s) punched back to writable (so a
# worktree nested under the main checkout, and the shared .vinta-ai-workflows
# dir, keep working). This deliberately does NOT lock HOME / caches / tmp, so
# package managers, build tools, and test runners behave exactly as unsandboxed.
#
# Usage:
#   sandbox-run.sh --deny <path> [--deny <path>...] \
#                  [--allow <path>...] -- <command> [args...]
#
# Required:
#   --deny  <path>   subtree to make read-only (the main checkout root). Repeatable.
# Optional:
#   --allow <path>   subtree to keep writable even if nested under a --deny path
#                    (the worktree; the .vinta-ai-workflows summary/prs-context dir).
#                    Repeatable.
#
# Environment:
#   VINTA_SANDBOX=off         bypass entirely — exec the command unsandboxed and
#                             print a warning (escape hatch when a tool needs
#                             access the sandbox blocks, or on an unsupported FS).
#   VINTA_SANDBOX_TIER_FILE   if set, write the achieved tier to this file:
#                             "enforced" (sandbox active) or "none" (no sandbox
#                             tool available / bypassed). Callers read it to know
#                             whether the OS guarantee held or a backstop is needed.
#
# Exit: the command's own exit code. Setup failures exit 2.

set -u

die() { echo "sandbox-run: $*" >&2; exit 2; }

DENY=()
ALLOW=()
CMD=()
parsing_cmd=0
while [ $# -gt 0 ]; do
  if [ "$parsing_cmd" -eq 1 ]; then CMD+=("$1"); shift; continue; fi
  case "$1" in
    --deny)  shift; [ $# -gt 0 ] || die "--deny needs a path"; DENY+=("$1"); shift ;;
    --allow) shift; [ $# -gt 0 ] || die "--allow needs a path"; ALLOW+=("$1"); shift ;;
    --)      parsing_cmd=1; shift ;;
    *)       die "unknown arg: $1 (did you forget '--' before the command?)" ;;
  esac
done

[ "${#CMD[@]}" -gt 0 ] || die "no command given after '--'"
[ "${#DENY[@]}" -gt 0 ] || die "at least one --deny <path> required"

# Canonicalize a path without requiring the leaf to exist.
canon() {
  local p="$1" d b
  if [ -d "$p" ]; then (cd "$p" && pwd -P); return; fi
  d=$(dirname "$p"); b=$(basename "$p")
  if [ -d "$d" ]; then echo "$(cd "$d" && pwd -P)/$b"; else echo "$p"; fi
}

DENY_C=();  for p in "${DENY[@]}";  do DENY_C+=("$(canon "$p")");  done
ALLOW_C=(); for p in "${ALLOW[@]}"; do ALLOW_C+=("$(canon "$p")"); done

record_tier() {
  [ -n "${VINTA_SANDBOX_TIER_FILE:-}" ] && printf '%s' "$1" > "$VINTA_SANDBOX_TIER_FILE" 2>/dev/null || true
}

if [ "${VINTA_SANDBOX:-}" = "off" ]; then
  echo "sandbox-run: VINTA_SANDBOX=off — running UNSANDBOXED (no main-checkout protection)" >&2
  record_tier none
  exec "${CMD[@]}"
fi

# ---- macOS: sandbox-exec -----------------------------------------------------
if command -v sandbox-exec >/dev/null 2>&1; then
  profile=$(mktemp -t vinta-sandbox) || die "mktemp failed"
  trap 'rm -f "$profile"' EXIT
  {
    echo '(version 1)'
    echo '(allow default)'
    for p in "${DENY_C[@]}";  do echo "(deny file-write* (subpath \"$p\"))"; done
    for p in "${ALLOW_C[@]}"; do echo "(allow file-write* (subpath \"$p\"))"; done
  } > "$profile"
  record_tier enforced
  exec sandbox-exec -f "$profile" "${CMD[@]}"
fi

# ---- Linux: bubblewrap -------------------------------------------------------
if command -v bwrap >/dev/null 2>&1; then
  args=(--bind / /)
  for p in "${DENY_C[@]}";  do args+=(--ro-bind "$p" "$p"); done   # main → read-only
  for p in "${ALLOW_C[@]}"; do args+=(--bind    "$p" "$p"); done   # worktree → writable (overrides ro)
  args+=(--dev /dev --proc /proc)
  record_tier enforced
  exec bwrap "${args[@]}" -- "${CMD[@]}"
fi

# ---- No sandbox tool: best-effort fallback -----------------------------------
echo "sandbox-run: no sandbox tool (sandbox-exec / bwrap) found — running UNSANDBOXED." >&2
echo "sandbox-run: main-checkout writes are NOT blocked; rely on the post-run stray-write check." >&2
record_tier none
exec "${CMD[@]}"
