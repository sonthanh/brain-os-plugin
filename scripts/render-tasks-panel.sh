#!/usr/bin/env bash
# Render Open Tasks panel for SessionStart / /status briefing.
# Pure formatter — queries GH issues, renders Stories / In Progress / Ready / Backlog blocks.
# Silent if gh missing/unauthed/offline, GH_TASK_REPO empty, or jq unavailable.
#
# Caller responsibility: source resolve-vault.sh (or otherwise export GH_TASK_REPO)
# before invoking. Standalone invocation will source it itself if needed.
#
# Extracted from hooks/session-start-tasks.sh (issue #174 path-narrowing) — keeps the
# hook entry point thin so render-only edits ship as leaf changes.

set -uo pipefail

if [ -z "${GH_TASK_REPO:-}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  RESOLVE="$SCRIPT_DIR/../hooks/resolve-vault.sh"
  [ -f "$RESOLVE" ] && source "$RESOLVE"
fi

[ -z "${GH_TASK_REPO:-}" ] && exit 0
command -v gh >/dev/null 2>&1 || exit 0
command -v jq >/dev/null 2>&1 || exit 0

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

fetch_issues() {
  local label="$1"
  local out="$2"
  gh issue list -R "$GH_TASK_REPO" --state open --label "$label" \
    --limit 100 --json number,title \
    > "$out" 2>/dev/null || echo "[]" > "$out"
}

fetch_plans() {
  local out="$1"
  gh issue list -R "$GH_TASK_REPO" --state open --label "type:plan" \
    --limit 50 --json number,title,body \
    > "$out" 2>/dev/null || echo "[]" > "$out"
}

fetch_count() {
  local status="$1"
  local out="$2"
  gh issue list -R "$GH_TASK_REPO" --state open --label "status:${status}" \
    --limit 200 --json number --jq 'length' \
    > "$out" 2>/dev/null || echo 0 > "$out"
}

fetch_all_states() {
  local out="$1"
  gh issue list -R "$GH_TASK_REPO" --state all \
    --limit 500 --json number,state,labels \
    > "$out" 2>/dev/null || echo "[]" > "$out"
}

fetch_issues "status:in-progress" "$TMP_DIR/in_progress.json" &
fetch_issues "status:ready" "$TMP_DIR/ready.json" &
fetch_plans "$TMP_DIR/plans.json" &
fetch_count backlog "$TMP_DIR/backlog_count" &
fetch_all_states "$TMP_DIR/all_states.json" &
wait

BACKLOG_COUNT=$(tr -d '[:space:]' < "$TMP_DIR/backlog_count" 2>/dev/null)
case "$BACKLOG_COUNT" in
  ''|*[!0-9]*) BACKLOG_COUNT=0 ;;
esac

PLAN_NUMS=$(jq -r '.[].number' "$TMP_DIR/plans.json" 2>/dev/null | sort -u)
P_COUNT=0
if [ -n "$PLAN_NUMS" ]; then
  P_COUNT=$(printf '%s\n' "$PLAN_NUMS" | grep -c '^[0-9]' 2>/dev/null || echo 0)
fi

filter_non_plans() {
  local file="$1"
  jq -r '.[] | "\(.number)\t\(.title)"' "$file" 2>/dev/null | \
    while IFS=$'\t' read -r num title; do
      [ -z "$num" ] && continue
      if ! printf '%s\n' "$PLAN_NUMS" | grep -qx "$num"; then
        printf '%s\n' "$title"
      fi
    done
}

IN_PROGRESS=$(filter_non_plans "$TMP_DIR/in_progress.json")
READY=$(filter_non_plans "$TMP_DIR/ready.json")

count_lines() {
  [ -z "$1" ] && echo 0 && return
  printf '%s' "$1" | grep -c '^' 2>/dev/null || echo 0
}

IP_COUNT=$(count_lines "$IN_PROGRESS")
R_COUNT=$(count_lines "$READY")

child_bucket() {
  local n="$1"
  jq -r --argjson n "$n" '
    .[] | select(.number == $n) |
    if .state == "CLOSED" then "closed"
    else
      ((.labels // []) | map(.name) | map(select(startswith("status:"))) | (.[0] // "")) as $s |
      if $s == "status:in-progress" then "in-progress"
      elif $s == "status:ready" then "ready"
      else "other"
      end
    end
  ' "$TMP_DIR/all_states.json" 2>/dev/null
}

render_plan_line() {
  local pnum="$1"
  local ptitle="$2"
  local body
  body=$(jq -r --argjson n "$pnum" '.[] | select(.number == $n) | .body // ""' "$TMP_DIR/plans.json" 2>/dev/null)
  local children
  children=$(printf '%s\n' "$body" \
    | grep -oE '^- \[[ x]\] +(ai-brain)?#[0-9]+' \
    | grep -oE '[0-9]+$' | sort -un)
  local n=0 r=0 ip=0 c=0
  for ch in $children; do
    n=$((n + 1))
    case "$(child_bucket "$ch")" in
      ready)       r=$((r + 1)) ;;
      in-progress) ip=$((ip + 1)) ;;
      closed)      c=$((c + 1)) ;;
    esac
  done
  local clean_title
  clean_title=$(printf '%s' "$ptitle" | sed 's/^Story: *//' | cut -c1-110)
  if [ "$n" -gt 0 ]; then
    echo "  • #${pnum} ${clean_title} (${n} children: ${r} ready / ${ip} in-progress / ${c} closed)"
  else
    echo "  • #${pnum} ${clean_title}"
  fi
}

if [ "$P_COUNT" -gt 0 ] || [ "$R_COUNT" -gt 0 ] || [ "$IP_COUNT" -gt 0 ] || [ "$BACKLOG_COUNT" -gt 0 ]; then
  echo "📋 Open Tasks"

  if [ "$P_COUNT" -gt 0 ]; then
    echo ""
    echo "📦 Stories ($P_COUNT):"
    jq -r '.[] | "\(.number)\t\(.title)"' "$TMP_DIR/plans.json" 2>/dev/null | \
      while IFS=$'\t' read -r pnum ptitle; do
        [ -z "$pnum" ] && continue
        render_plan_line "$pnum" "$ptitle"
      done
  fi

  if [ "$IP_COUNT" -gt 0 ]; then
    echo ""
    echo "▶ In Progress ($IP_COUNT):"
    printf '%s\n' "$IN_PROGRESS" | while IFS= read -r line; do
      [ -z "$line" ] && continue
      clean=$(echo "$line" | sed 's/\*\*//g; s/\[\[.*|\(.*\)\]\]/\1/g; s/\[\[.*\]\]//g' | cut -c1-120)
      echo "  • $clean"
    done
  fi

  if [ "$R_COUNT" -gt 0 ]; then
    echo ""
    echo "⏳ Ready ($R_COUNT):"
    printf '%s\n' "$READY" | while IFS= read -r line; do
      [ -z "$line" ] && continue
      clean=$(echo "$line" | sed 's/\*\*//g; s/\[\[.*|\(.*\)\]\]/\1/g; s/\[\[.*\]\]//g' | cut -c1-120)
      echo "  • $clean"
    done
  fi

  if [ "$BACKLOG_COUNT" -gt 0 ]; then
    echo ""
    echo "📦 Backlog ($BACKLOG_COUNT)"
  fi
fi
