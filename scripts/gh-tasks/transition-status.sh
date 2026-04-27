#!/bin/bash
# transition-status.sh — atomic status:* label flip for tracker issues.
#
# Reads current status:* label, then in a single `gh issue edit` call removes
# it and adds the target. Atomic from GH's side — no observable window with
# both labels or neither. Idempotent: target == current is a no-op.
#
# Used by /impl (ready→in-progress, in-progress→ready), /pickup (backlog→
# ready), and pickup-claim. Centralized so callers stop reinventing the
# remove-then-add pattern (which races with concurrent observers).
#
# Usage: transition-status.sh <issue-N> --to <ready|in-progress|blocked|backlog> [--dry-run]

set -uo pipefail

REPO="sonthanh/ai-brain"
VALID_TARGETS=("ready" "in-progress" "blocked" "backlog")

ISSUE=""
TARGET=""
DRY_RUN=0

usage() {
  cat <<EOF
transition-status.sh — atomic status:* label flip on a tracker issue.

Usage:
  transition-status.sh <issue-N> --to <ready|in-progress|blocked|backlog> [--dry-run]

Arguments:
  <issue-N>      Issue number (positional, required)
  --to <S>       Target status, one of: ${VALID_TARGETS[*]}
  --dry-run      Print the gh edit command without executing
  --help         Show this message and exit

Behavior:
  - Atomic: single gh edit call removes the current status:* and adds target
  - Idempotent: if current == target, no-op (exit 0)
  - Errors cleanly on closed or non-existent issues
EOF
}

in_list() {
  local needle="$1"; shift
  for v in "$@"; do
    [[ "$v" == "$needle" ]] && return 0
  done
  return 1
}

if [[ $# -eq 0 ]]; then
  usage; exit 2
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --to)      TARGET="${2:-}"; shift 2 ;;
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
  echo "ERROR: issue '$ISSUE' is not a valid number" >&2; exit 2
fi
if [[ -z "$TARGET" ]]; then
  echo "ERROR: --to required" >&2; exit 2
fi
in_list "$TARGET" "${VALID_TARGETS[@]}" || {
  echo "ERROR: invalid --to '$TARGET' (canon: ${VALID_TARGETS[*]})" >&2; exit 2
}

# Fetch current state + status:* label.
META=$(gh issue view "$ISSUE" -R "$REPO" --json state,labels 2>&1) || {
  echo "ERROR: cannot fetch issue #$ISSUE from $REPO (gh view failed): $META" >&2
  exit 2
}

STATE=$(echo "$META" | jq -r '.state' 2>/dev/null)
CURRENT=$(echo "$META" | jq -r '[.labels[].name | select(startswith("status:"))][0] // empty' 2>/dev/null)

if [[ "$STATE" != "OPEN" ]]; then
  echo "ERROR: #$ISSUE is $STATE (not OPEN)" >&2; exit 1
fi

TARGET_LABEL="status:$TARGET"

# Idempotent: target already current.
if [[ "$CURRENT" == "$TARGET_LABEL" ]]; then
  echo "✓ #$ISSUE already $TARGET_LABEL (no-op)"
  exit 0
fi

# Build single atomic edit.
EDIT_ARGS=(issue edit "$ISSUE" -R "$REPO")
[[ -n "$CURRENT" ]] && EDIT_ARGS+=(--remove-label "$CURRENT")
EDIT_ARGS+=(--add-label "$TARGET_LABEL")

if [[ "$DRY_RUN" -eq 1 ]]; then
  CMD="gh"
  for a in "${EDIT_ARGS[@]}"; do
    CMD+=" $a"
  done
  echo "$CMD"
  exit 0
fi

if gh "${EDIT_ARGS[@]}" >/dev/null 2>&1; then
  FROM_LABEL="${CURRENT:-(none)}"
  echo "✓ #$ISSUE: $FROM_LABEL → $TARGET_LABEL"
  exit 0
fi

echo "ERROR: gh edit failed on #$ISSUE" >&2
exit 2
