#!/usr/bin/env bash
# open-pr.sh — publish one .vinta-ai-workflows/prs-context/{feature}/{phase}.md file as a real PR
# + inline review comments via the project's PR CLI (`gh` for GitHub,
# `glab` for GitLab). Reads frontmatter + sections, opens the PR (or
# detects an existing one), posts each comment from the YAML list,
# rewrites the file's frontmatter to `status: published` + populated
# `pr_url`, and appends a publish log.
#
# Usage:
#   open-pr.sh <path-to-prs-context-file> [--cli gh|glab] [--dry-run]
#
# Exit codes:
#   0  PR opened (or pre-existing); all comments posted.
#   1  PR opened; one or more comments failed to post.
#   2  Hard failure (file invalid, branch not pushed, CLI missing/unauthed,
#      missing dependency).
#
# Dependencies:
#   bash 4+, git, yq (Mike Farah's), jq, and one of: gh, glab.

set -euo pipefail

# ── Output helpers ────────────────────────────────────────────────────────

die() { echo "open-pr: $*" >&2; exit 2; }
log() { echo "open-pr: $*"; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1"
}

# ── Args ──────────────────────────────────────────────────────────────────

FILE=""
CLI=""
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cli) CLI="$2"; shift 2;;
    --cli=*) CLI="${1#--cli=}"; shift;;
    --dry-run|-n) DRY_RUN=1; shift;;
    -h|--help)
      echo "Usage: open-pr.sh <path> [--cli gh|glab] [--dry-run]"
      exit 0
      ;;
    --*) die "unknown arg: $1";;
    *)
      [[ -n "$FILE" ]] && die "unexpected positional arg: $1"
      FILE="$1"; shift
      ;;
  esac
done

[[ -n "$FILE" ]] || die "missing path to prs-context file"
[[ -f "$FILE" ]] || die "file not found: $FILE"

# ── Dep checks (after --help so it works without yq/jq installed) ────────

require_cmd git
require_cmd yq
require_cmd jq

# ── Parse the file ────────────────────────────────────────────────────────
# Format: --- frontmatter --- \n\n # Title \n ... \n # Description \n ... \n # Comments \n ```yaml ... ```

# Frontmatter: lines between the first two `---` markers.
FRONTMATTER=$(awk '
  /^---$/ { count++; if (count == 2) exit; if (count == 1) next }
  count == 1 { print }
' "$FILE")

# Body: everything after the second `---` line.
BODY=$(awk '
  /^---$/ { count++; next }
  count >= 2 { print }
' "$FILE")

[[ -n "$FRONTMATTER" ]] || die "$FILE: missing YAML frontmatter (--- ... ---)"

# Extract typed fields from frontmatter via yq.
get_meta() { echo "$FRONTMATTER" | yq -r ".${1} // \"\""; }

BRANCH=$(get_meta branch)
BASE=$(get_meta base)
STATUS=$(get_meta status)
PR_URL=$(get_meta pr_url)
PLAN_ID=$(get_meta plan_id)
PHASE_ID=$(get_meta phase_id)

[[ -n "$BRANCH" ]] || die "$FILE: frontmatter missing required 'branch'"
[[ -n "$BASE" ]] || die "$FILE: frontmatter missing required 'base'"

# Already published?
if [[ "$STATUS" == "published" && -n "$PR_URL" && "$PR_URL" != "null" ]]; then
  log "already published: $PR_URL"
  exit 0
fi

# Body sections — split on `^# ` H1 headings.
extract_section() {
  local heading="$1"
  echo "$BODY" | awk -v h="^# +${heading}\$" '
    $0 ~ h { in_sec = 1; next }
    /^# / && in_sec { in_sec = 0 }
    in_sec { print }
  ' | sed -e ':a;/./,$!d;/^$/{$d;ba;}'   # trim trailing blank lines
}

TITLE=$(extract_section "Title" | sed -e '/./,$!d')
DESCRIPTION=$(extract_section "Description")
COMMENTS_RAW=$(extract_section "Comments")

[[ -n "$TITLE" ]] || die "$FILE: # Title section is empty"
[[ -n "$DESCRIPTION" ]] || die "$FILE: # Description section is empty"

# Comments are inside ```yaml ... ``` fence within the # Comments section.
COMMENTS_YAML=$(echo "$COMMENTS_RAW" | awk '
  /^```ya?ml$/ { in_fence = 1; next }
  /^```$/ && in_fence { in_fence = 0; next }
  in_fence { print }
')

# Convert comments YAML to JSON for jq iteration. Empty list when no fence.
if [[ -z "$COMMENTS_YAML" ]]; then
  COMMENTS_JSON='[]'
else
  COMMENTS_JSON=$(echo "$COMMENTS_YAML" | yq -o=json '.' 2>/dev/null || echo '[]')
  [[ "$COMMENTS_JSON" == "null" ]] && COMMENTS_JSON='[]'
fi

COMMENT_COUNT=$(echo "$COMMENTS_JSON" | jq 'length')

# ── Detect CLI + verify ──────────────────────────────────────────────────

if [[ -z "$CLI" ]]; then
  if command -v gh >/dev/null 2>&1; then CLI=gh
  elif command -v glab >/dev/null 2>&1; then CLI=glab
  else die "no PR CLI found in PATH (gh or glab). install one or pass --cli"
  fi
fi

case "$CLI" in
  gh|glab) ;;
  *) die "unsupported --cli: $CLI";;
esac

require_cmd "$CLI"
log "using $CLI"

if [[ $DRY_RUN -eq 0 ]]; then
  # Auth check.
  "$CLI" auth status >/dev/null 2>&1 || die "$CLI not authenticated. run: $CLI auth login"

  # Branch pushed?
  git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1 \
    || die "branch not pushed: origin/$BRANCH. push it first."
fi

# ── Open PR (or detect existing) ─────────────────────────────────────────

PR_URL_NEW=""
PR_NUMBER=""
PR_IS_NEW=0

open_pr_gh() {
  # Detect existing PR for branch.
  local existing
  if existing=$(gh pr view "$BRANCH" --json url,number 2>/dev/null); then
    PR_URL_NEW=$(echo "$existing" | jq -r '.url')
    PR_NUMBER=$(echo "$existing" | jq -r '.number')
    PR_IS_NEW=0
    return 0
  fi
  local out
  out=$(gh pr create \
    --base "$BASE" \
    --head "$BRANCH" \
    --title "$TITLE" \
    --body "$DESCRIPTION" 2>&1) \
    || die "gh pr create failed: $out"
  PR_URL_NEW=$(echo "$out" | tail -n1 | tr -d '[:space:]')
  PR_NUMBER=$(echo "$PR_URL_NEW" | grep -oE '/pull/[0-9]+' | grep -oE '[0-9]+')
  PR_IS_NEW=1
}

open_pr_glab() {
  local existing
  if existing=$(glab mr view "$BRANCH" -F json 2>/dev/null); then
    PR_URL_NEW=$(echo "$existing" | jq -r '.web_url')
    PR_NUMBER=$(echo "$existing" | jq -r '.iid')
    PR_IS_NEW=0
    return 0
  fi
  local out
  out=$(glab mr create \
    --target-branch "$BASE" \
    --source-branch "$BRANCH" \
    --title "$TITLE" \
    --description "$DESCRIPTION" \
    --yes 2>&1) \
    || die "glab mr create failed: $out"
  PR_URL_NEW=$(echo "$out" | grep -oE 'https?://[^[:space:]]+' | head -n1)
  PR_NUMBER=$(echo "$PR_URL_NEW" | grep -oE '/[0-9]+$' | tr -d '/')
  PR_IS_NEW=1
}

if [[ $DRY_RUN -eq 1 ]]; then
  PR_URL_NEW="<dry-run>"
  PR_NUMBER="0"
  PR_IS_NEW=1
else
  case "$CLI" in
    gh)   open_pr_gh ;;
    glab) open_pr_glab ;;
  esac
fi

if [[ $PR_IS_NEW -eq 1 ]]; then
  log "PR opened → $PR_URL_NEW"
else
  log "PR already existed → $PR_URL_NEW"
fi

# ── Post inline comments ─────────────────────────────────────────────────

PUBLISH_LOG=()
NOW() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

if [[ $PR_IS_NEW -eq 1 ]]; then
  PUBLISH_LOG+=("$(NOW) — opened: $PR_URL_NEW")
else
  PUBLISH_LOG+=("$(NOW) — reused existing PR: $PR_URL_NEW")
fi

FAILURES=0

post_comment_gh() {
  local file="$1" start="$2" end="$3" side="$4" body="$5"
  local repo commit
  repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
  commit=$(git rev-parse "origin/$BRANCH")
  local args=(
    api --method POST
    -H "Accept: application/vnd.github+json"
    "/repos/$repo/pulls/$PR_NUMBER/comments"
    -f "body=$body"
    -f "commit_id=$commit"
    -f "path=$file"
    -F "line=${end:-$start}"
    -f "side=${side:-RIGHT}"
  )
  if [[ -n "$end" && "$end" != "$start" && "$end" != "null" ]]; then
    args+=( -F "start_line=$start" -f "start_side=${side:-RIGHT}" )
  fi
  gh "${args[@]}" >/dev/null 2>&1
}

post_comment_glab() {
  local file="$1" start="$2" end="$3" _side="$4" body="$5"
  local refs
  refs=$(glab mr view "$PR_NUMBER" -F json | jq -r '.diff_refs')
  local base_sha head_sha start_sha
  base_sha=$(echo "$refs" | jq -r '.base_sha')
  head_sha=$(echo "$refs" | jq -r '.head_sha')
  start_sha=$(echo "$refs" | jq -r '.start_sha')
  glab api --method POST \
    "projects/:id/merge_requests/$PR_NUMBER/discussions" \
    -f "body=$body" \
    -f "position[base_sha]=$base_sha" \
    -f "position[head_sha]=$head_sha" \
    -f "position[start_sha]=$start_sha" \
    -f "position[position_type]=text" \
    -f "position[new_path]=$file" \
    -f "position[new_line]=${end:-$start}" \
    >/dev/null 2>&1
}

if [[ "$COMMENT_COUNT" -eq 0 ]]; then
  log "no inline comments to post"
elif [[ $DRY_RUN -eq 1 ]]; then
  log "would post $COMMENT_COUNT comment(s) (dry-run)"
else
  for ((i = 0; i < COMMENT_COUNT; i++)); do
    file=$(echo "$COMMENTS_JSON" | jq -r ".[$i].file")
    start=$(echo "$COMMENTS_JSON" | jq -r ".[$i].start_line")
    end=$(echo "$COMMENTS_JSON" | jq -r ".[$i].end_line // \"\"")
    side=$(echo "$COMMENTS_JSON" | jq -r ".[$i].side // \"RIGHT\"")
    body=$(echo "$COMMENTS_JSON" | jq -r ".[$i].body")
    label="$file:$start"
    [[ -n "$end" && "$end" != "null" && "$end" != "$start" ]] && label="$label-$end"

    if [[ "$CLI" == "gh" ]]; then
      if post_comment_gh "$file" "$start" "$end" "$side" "$body"; then
        echo "  comment $((i + 1))/$COMMENT_COUNT posted ($label)"
        PUBLISH_LOG+=("$(NOW) — comment $((i + 1))/$COMMENT_COUNT posted ($label)")
      else
        FAILURES=$((FAILURES + 1))
        echo "  comment $((i + 1))/$COMMENT_COUNT FAILED ($label)" >&2
        PUBLISH_LOG+=("$(NOW) — comment $((i + 1))/$COMMENT_COUNT FAILED ($label)")
      fi
    else
      if post_comment_glab "$file" "$start" "$end" "$side" "$body"; then
        echo "  comment $((i + 1))/$COMMENT_COUNT posted ($label)"
        PUBLISH_LOG+=("$(NOW) — comment $((i + 1))/$COMMENT_COUNT posted ($label)")
      else
        FAILURES=$((FAILURES + 1))
        echo "  comment $((i + 1))/$COMMENT_COUNT FAILED ($label)" >&2
        PUBLISH_LOG+=("$(NOW) — comment $((i + 1))/$COMMENT_COUNT FAILED ($label)")
      fi
    fi
  done
fi

# ── Rewrite frontmatter + append publish log ─────────────────────────────

if [[ $DRY_RUN -eq 0 ]]; then
  # Update frontmatter status + pr_url.
  NEW_FM=$(echo "$FRONTMATTER" | yq -y \
    ".status = \"published\" | .pr_url = \"$PR_URL_NEW\"" 2>/dev/null \
    || echo "$FRONTMATTER" | yq \
       ".status = \"published\" | .pr_url = \"$PR_URL_NEW\"")

  # Compose publish log block.
  LOG_BLOCK=$'\n## Publish log\n\n'
  for entry in "${PUBLISH_LOG[@]}"; do
    LOG_BLOCK+="- $entry"$'\n'
  done

  # If body already has a publish log, append entries to it; else add new section.
  if echo "$BODY" | grep -q '^## Publish log'; then
    NEW_BODY=$(echo "$BODY" | awk -v entries="$(printf '%s\n' "${PUBLISH_LOG[@]}" | sed 's/^/- /')" '
      /^## Publish log/ { in_log = 1; print; next }
      /^## / && in_log { in_log = 0; print entries; print; next }
      { print }
      END { if (in_log) print entries }
    ')
  else
    NEW_BODY="${BODY%$'\n'}"$'\n'"${LOG_BLOCK}"
  fi

  {
    echo '---'
    echo "$NEW_FM"
    echo '---'
    echo "$NEW_BODY"
  } > "$FILE.tmp" && mv "$FILE.tmp" "$FILE"

  log "updated $FILE (status=published, pr_url=$PR_URL_NEW)"
fi

if [[ $FAILURES -gt 0 ]]; then
  log "completed with $FAILURES comment failure(s)"
  exit 1
fi

exit 0
