#!/bin/bash
# close-issue.sh — central close helper for tracker issues.
#
# Strips ALL status:* labels first, then closes (--reason completed). Optional
# --comment is posted before the close. This is the lifecycle close-step that
# plugs the ghost-label leak: closed issues with stale status:in-progress
# (or status:ready) labels were leaking into /status counts.
#
# Usage: close-issue.sh <issue-N> [--comment <C>] [--dry-run]

set -uo pipefail

REPO="sonthanh/ai-brain"

ISSUE=""
COMMENT=""
DRY_RUN=0

usage() {
  cat <<EOF
close-issue.sh — strip all status:* labels then close a tracker issue.

Usage:
  close-issue.sh <issue-N> [--comment <C>] [--dry-run]

Arguments:
  <issue-N>          Issue number (positional, required)
  --comment <C>      Post comment <C> before closing (optional)
  --dry-run          Print the gh commands without executing
  --help             Show this message and exit

Behavior:
  - Closes with --reason completed
  - Removes EVERY status:* label in a single gh edit call before close
  - Errors cleanly on already-closed issues
EOF
}

if [[ $# -eq 0 ]]; then
  echo "ERROR: issue number required (usage: close-issue.sh <N>)" >&2
  exit 2
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --comment) COMMENT="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -*) echo "ERROR: unknown flag '$1'" >&2; exit 2 ;;
    *)
      if [[ -z "$ISSUE" ]]; then
        ISSUE="$1"; shift
      else
        echo "ERROR: unexpected positional arg '$1'" >&2; exit 2
      fi
      ;;
  esac
done

if [[ -z "$ISSUE" ]]; then
  echo "ERROR: issue number required" >&2; exit 2
fi
if [[ ! "$ISSUE" =~ ^[0-9]+$ ]]; then
  echo "ERROR: '$ISSUE' is not a valid issue number (numeric)" >&2; exit 2
fi

META=$(gh issue view "$ISSUE" -R "$REPO" --json state,labels 2>&1) || {
  echo "ERROR: cannot fetch issue #$ISSUE from $REPO: $META" >&2; exit 2
}

STATE=$(echo "$META" | jq -r '.state' 2>/dev/null)
if [[ "$STATE" == "CLOSED" ]]; then
  echo "ERROR: #$ISSUE is already closed" >&2; exit 1
fi

# Collect every status:* label on the issue (defensive — there may be more
# than one if drift has accumulated). Portable read loop (macOS bash 3.2 has
# no `mapfile`).
STATUS_LABELS=()
while IFS= read -r LBL; do
  [[ -n "$LBL" ]] && STATUS_LABELS+=("$LBL")
done < <(echo "$META" | jq -r '.labels[].name | select(startswith("status:"))')

build_edit_cmd() {
  local cmd="gh issue edit $ISSUE -R $REPO"
  for L in "${STATUS_LABELS[@]}"; do
    cmd+=" --remove-label $L"
  done
  echo "$cmd"
}

build_comment_cmd() {
  echo "gh issue comment $ISSUE -R $REPO --body '$COMMENT'"
}

build_close_cmd() {
  echo "gh issue close $ISSUE -R $REPO --reason completed"
}

if [[ "$DRY_RUN" -eq 1 ]]; then
  if [[ ${#STATUS_LABELS[@]} -gt 0 ]]; then
    build_edit_cmd
  fi
  [[ -n "$COMMENT" ]] && build_comment_cmd
  build_close_cmd
  exit 0
fi

# Real run.
if [[ ${#STATUS_LABELS[@]} -gt 0 ]]; then
  EDIT_ARGS=(issue edit "$ISSUE" -R "$REPO")
  for L in "${STATUS_LABELS[@]}"; do
    EDIT_ARGS+=(--remove-label "$L")
  done
  if ! gh "${EDIT_ARGS[@]}" >/dev/null 2>&1; then
    echo "ERROR: failed to strip status:* labels on #$ISSUE" >&2; exit 2
  fi
fi

if [[ -n "$COMMENT" ]]; then
  if ! gh issue comment "$ISSUE" -R "$REPO" --body "$COMMENT" >/dev/null 2>&1; then
    echo "ERROR: failed to post comment on #$ISSUE" >&2; exit 2
  fi
fi

if ! gh issue close "$ISSUE" -R "$REPO" --reason completed >/dev/null 2>&1; then
  echo "ERROR: failed to close #$ISSUE" >&2; exit 2
fi

echo "✓ closed #$ISSUE (stripped ${#STATUS_LABELS[@]} status label(s))"
