#!/usr/bin/env bash
# gen-compose-worktree-override.sh — generate an out-of-tree docker-compose
# override that neutralizes the isolation leaks COMPOSE_PROJECT_NAME does NOT
# cover, so a per-worktree compose stack cannot collide with the main checkout's.
#
# Why this exists: COMPOSE_PROJECT_NAME namespaces containers and networks, but
# NOT two very common compose patterns —
#
#   1. Volumes declared `external: true` and/or pinned to a fixed top-level
#      `name:`. These are addressed by name, so EVERY worktree's compose stack
#      mounts the SAME physical volume. For a database volume that means two
#      postmasters on one PGDATA → data corruption (the 2026-07-17 incident).
#   2. Fixed host port bindings (`ports: - "5432:5432"`). These publish to a
#      fixed host port that collides across compose projects regardless of name.
#
# The fix is a GENERATED, out-of-tree override (never a mutation of the project's
# committed compose files) that, for the worktree:
#   - re-pins every leaky volume to a NON-external, worktree-namespaced volume
#     (`<project>_wt_<name>_<volkey>`), EXCEPT volumes the caller marks shareable
#     (a read-only dep/venv cache with no dep churn is safe to keep shared);
#   - strips host port publishing from every service that has it, using compose's
#     `!override []` tag (a plain `ports: []` MERGES/appends in Compose v2+ and
#     would NOT strip the port — verified on Docker Compose v5.1.1).
#
# Detection is 100% generic — no project / service / volume name is hardcoded.
# Everything comes from `docker compose config --format json` run in the main
# checkout. A volume leaks when `.external == true` OR its resolved `.name`
# differs from the auto-namespaced form `<project>_<volkey>` (i.e. it carries a
# fixed top-level `name:`). Setting `external: false` in the override is
# mandatory — without it the base `external: true` merges through and the volume
# stays externally-pinned (verified).
#
# Usage:
#   gen-compose-worktree-override.sh \
#     --main     <main-checkout-root> \
#     --worktree <worktree-path> \
#     --name     <worktree-name> \
#     --out      <override-output-path> \
#     [--share-volume <volkey>]...   # volumes safe to keep shared (repeatable)
#
# Output:
#   stdout — the override path (only, on success) so it is safe to capture with
#            $(...). stderr carries a human-readable decision report + the
#            suggested `COMPOSE_FILE=<base>:<override>` wiring line.
#   The generated override's `volumes:` block lists the forked volumes by their
#   pinned name — that IS the teardown manifest (`docker volume rm <name>`).
#
# Exit: 0 on success; 2 on argument / setup errors (no `docker compose`, config
#       does not parse, no base compose file found).

set -u

die() { echo "gen-compose-worktree-override: $*" >&2; exit 2; }

MAIN=""; WORKTREE=""; NAME=""; OUT=""
SHARE=()
while [ $# -gt 0 ]; do
  case "$1" in
    --main)         shift; [ $# -gt 0 ] || die "--main needs a path"; MAIN="$1"; shift ;;
    --worktree)     shift; [ $# -gt 0 ] || die "--worktree needs a path"; WORKTREE="$1"; shift ;;
    --name)         shift; [ $# -gt 0 ] || die "--name needs a value"; NAME="$1"; shift ;;
    --out)          shift; [ $# -gt 0 ] || die "--out needs a path"; OUT="$1"; shift ;;
    --share-volume) shift; [ $# -gt 0 ] || die "--share-volume needs a volume key"; SHARE+=("$1"); shift ;;
    *)              die "unknown arg: $1" ;;
  esac
done

[ -n "$MAIN" ]     || die "--main <main-checkout-root> required"
[ -n "$WORKTREE" ] || die "--worktree <path> required"
[ -n "$NAME" ]     || die "--name <worktree-name> required"
[ -n "$OUT" ]      || die "--out <override-path> required"

command -v docker >/dev/null 2>&1 || die "docker not found on PATH — cannot generate compose override"
docker compose version >/dev/null 2>&1 || die "'docker compose' unavailable — is the Compose v2 plugin installed?"

# Canonicalize the main checkout (must exist).
[ -d "$MAIN" ] || die "main checkout path is not a directory: $MAIN"
MAIN=$(cd "$MAIN" && pwd -P)

# Locate the base compose file compose will auto-load (standard search order).
BASE=""
for f in compose.yaml compose.yml docker-compose.yaml docker-compose.yml; do
  if [ -f "$MAIN/$f" ]; then BASE="$f"; break; fi
done
[ -n "$BASE" ] || die "no compose file (compose.yaml / docker-compose.yml) found in $MAIN"

# Render the resolved config from the MAIN checkout. Do not force
# COMPOSE_PROJECT_NAME: let it default exactly as the project normally resolves
# it, so the auto-namespace comparison below reflects reality.
CONFIG_JSON=$(cd "$MAIN" && docker compose config --format json 2>/dev/null) \
  || die "'docker compose config' failed in $MAIN — the compose config does not parse"

mkdir -p "$(dirname "$OUT")" || die "cannot create output dir for $OUT"

CONFIG_JSON="$CONFIG_JSON" OUT="$OUT" NAME="$NAME" BASE="$BASE" \
python3 - "${SHARE[@]:-}" <<'PY' || die "failed to generate override"
import json, os, sys

cfg = json.loads(os.environ["CONFIG_JSON"])
out = os.environ["OUT"]
wt_name = os.environ["NAME"]
base = os.environ["BASE"]
share = {s for s in sys.argv[1:] if s}

# The override lives OUT of the worktree (under <summary_dir>), so the COMPOSE_FILE
# entry must reference it by ABSOLUTE path — a basename would only resolve if the
# file sat in the compose project dir. The base file is worktree-local (the
# worktree carries its own tracked copy), so it stays relative.
out_abs = os.path.abspath(out)

project = cfg.get("name") or "compose"
volumes = cfg.get("volumes") or {}
services = cfg.get("services") or {}

# ---- Detect leaky volumes -------------------------------------------------
# A volume leaks past COMPOSE_PROJECT_NAME when it is external, or carries a
# fixed top-level name (resolved name != the auto-namespaced <project>_<key>).
forked = []          # (volkey, reason, pinned_name)
shared_leaky = []    # (volkey, reason) — leaky but caller marked shareable
for key, vol in volumes.items():
    vol = vol or {}
    external = bool(vol.get("external"))
    resolved = vol.get("name", "")
    auto = f"{project}_{key}"
    if external:
        reason = "external:true"
    elif resolved and resolved != auto:
        reason = f"fixed name '{resolved}'"
    else:
        continue  # already namespaced by project name — safe
    if key in share:
        shared_leaky.append((key, reason))
        continue
    pinned = f"{project}_wt_{wt_name}_{key}"
    forked.append((key, reason, pinned))

# ---- Detect services publishing fixed host ports --------------------------
stripped = []  # service names whose host port publishing we drop
for svc, spec in services.items():
    spec = spec or {}
    ports = spec.get("ports") or []
    if any((p or {}).get("published") for p in ports):
        stripped.append(svc)

# ---- Emit the override YAML (hand-rolled; no yaml dependency) --------------
def y(s):
    # Quote scalars that YAML could misread; safe for our name/key charset.
    return json.dumps(s)

lines = []
lines.append("# GENERATED by gen-compose-worktree-override.sh — do not edit by hand.")
lines.append("# Out-of-tree compose override that neutralizes the isolation leaks")
lines.append("# COMPOSE_PROJECT_NAME does not cover (external / fixed-name volumes,")
lines.append("# fixed host port bindings). Wire in without touching tracked files via:")
lines.append(f"#   COMPOSE_FILE={base}:{out_abs}   (in the worktree's .env)")
lines.append(f"# Source project: {project}   Worktree: {wt_name}")
if shared_leaky:
    for key, reason in shared_leaky:
        lines.append(f"# KEPT SHARED (caller --share-volume): {key} ({reason})")
lines.append("")

if stripped:
    lines.append("services:")
    for svc in sorted(stripped):
        lines.append(f"  {y(svc)}:")
        # `!override []` REPLACES the base list (plain [] would append/merge).
        lines.append("    ports: !override []")
    lines.append("")

if forked:
    lines.append("volumes:")
    for key, _reason, pinned in forked:
        lines.append(f"  {y(key)}:")
        lines.append(f"    name: {y(pinned)}")
        lines.append("    external: false")
    lines.append("")

if not stripped and not forked:
    lines.append("# No isolation leaks detected: every volume is already namespaced by")
    lines.append("# COMPOSE_PROJECT_NAME and no service publishes a fixed host port.")
    lines.append("# This override is a valid no-op; wiring it in is harmless.")
    lines.append("")

with open(out, "w") as f:
    f.write("\n".join(lines).rstrip("\n") + "\n")

# ---- Report to stderr (human + agent readable) ----------------------------
def err(msg):
    print(msg, file=sys.stderr)

err(f"gen-compose-worktree-override: wrote {out}")
err(f"  base compose file: {base}   project: {project}")
if forked:
    err("  forked volumes (were shared → now worktree-namespaced, non-external):")
    for key, reason, pinned in forked:
        err(f"    - {key} ({reason}) -> {pinned}")
else:
    err("  forked volumes: none")
if shared_leaky:
    err("  KEPT SHARED (caller --share-volume) — verify these are read-only caches:")
    for key, reason in shared_leaky:
        err(f"    - {key} ({reason})")
if stripped:
    err(f"  stripped host-port publishing from: {', '.join(sorted(stripped))}")
else:
    err("  stripped host-port publishing from: none")
err(f"  wire in: COMPOSE_FILE={base}:{out_abs}  (append to the worktree's copied .env)")

# stdout = override path ONLY (safe for $(...) capture).
print(out_abs)
PY
