#!/usr/bin/env bash
# Show open tasks (from GH issues at $GH_TASK_REPO) + vault index on session start.
# Tasks live in GH Issues since Phase 1 of inbox.md → GH migration.
# Vault index enables brain-first lookup: agent sees recent research, aha notes,
# active plans, and grill sessions before deciding to do external research.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/resolve-vault.sh"

# Invalidate /status cache so the next /status briefing reflects any GH
# mutations from cron / external sessions that the touch-status-dirty hook
# couldn't catch (e.g. GH eventual-consistency window where the dirty marker
# was cleared by a regen running while the close hadn't propagated yet).
touch "${HOME}/.cache/brain-os/status.dirty" 2>/dev/null || true

# Tasks panel — query GH issues (parallel calls). Silent if gh missing/unauthed/offline,
# if GH_TASK_REPO not configured in brain-os.config.md, or if jq is unavailable.
if [ -n "${GH_TASK_REPO:-}" ] && command -v gh >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
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
    # Plan parents — fetch body too so we can parse child checklist locally
    # without one extra `gh issue view` per parent.
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
    # Single bulk lookup for child state tally (ready / in-progress / closed).
    # Avoids fan-out gh calls per child.
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

  # Set of plan parent numbers — used to filter In Progress + Ready so parents
  # don't double-render.
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

  # Resolve a single child issue's bucket (ready | in-progress | closed | other).
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
    # Extract distinct child issue numbers from `- [ ]` / `- [x]` checklist lines.
    # Match only refs that sit *directly after the checkbox* (`- [ ] #N` or
    # `- [ ] ai-brain#N`) — skips `#N` mentions buried inside prose like
    # `- [ ] /slice re-run (ai-brain#153 source) produces ...`. Bare acceptance
    # criteria (no leading `#N`) contribute nothing — N counts true child refs.
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
    # Drop `Story: ` prefix — section header already conveys the kind.
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
fi

# Vault index — brain-first lookup
# Shows recent content across zones so agent knows what exists before searching externally.
extract_title() {
  local file="$1"
  local title
  title=$(awk '/^---$/{f++; next} f==1 && /^title:/{sub(/^title: *"?/, ""); sub(/"?$/, ""); print; exit}' "$file")
  if [ -z "$title" ]; then
    title=$(awk '/^# /{sub(/^# /, ""); print; exit}' "$file")
  fi
  if [ -z "$title" ]; then
    title=$(basename "$file" .md)
  fi
  echo "$title"
}

list_recent() {
  local dir="$1"
  local limit="$2"
  local abs_dir="$VAULT_PATH/$dir"
  [ ! -d "$abs_dir" ] && return
  find "$abs_dir" -maxdepth 1 -name "*.md" -not -name "README.md" -type f \
    -exec stat -f "%m %N" {} \; 2>/dev/null \
    | sort -rn | head -n "$limit" \
    | while read -r _ file; do
      local title rel
      title=$(extract_title "$file")
      rel=${file#$VAULT_PATH/}
      echo "  • $title ($rel)"
    done
}

RESEARCH=$(list_recent "knowledge/research/reports" 5)
AHA=$(list_recent "thinking/aha" 5)
HANDOVERS=$(list_recent "daily/handovers" 3)
GRILLS=$(list_recent "daily/grill-sessions" 5)

if [ -n "$RESEARCH" ] || [ -n "$AHA" ] || [ -n "$HANDOVERS" ] || [ -n "$GRILLS" ]; then
  echo ""
  echo "🧠 Vault Index (check before external research — RESOLVER.md for full map)"

  if [ -n "$RESEARCH" ]; then
    echo ""
    echo "📚 Recent Research:"
    echo "$RESEARCH"
  fi

  if [ -n "$AHA" ]; then
    echo ""
    echo "💡 Recent Aha:"
    echo "$AHA"
  fi

  if [ -n "$GRILLS" ]; then
    echo ""
    echo "🔥 Recent Grills:"
    echo "$GRILLS"
  fi

  if [ -n "$HANDOVERS" ]; then
    echo ""
    echo "📋 Recent Handovers:"
    echo "$HANDOVERS"
  fi
fi
