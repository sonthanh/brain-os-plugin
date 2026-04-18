#!/usr/bin/env bash
# Show open tasks (from GH issues at $GH_TASK_REPO) + vault index on session start.
# Tasks live in GH Issues since Phase 1 of inbox.md → GH migration.
# Vault index enables brain-first lookup: agent sees recent research, aha notes,
# active plans, and grill sessions before deciding to do external research.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/resolve-vault.sh"

# Tasks panel — query GH issues (3 parallel calls). Silent if gh missing/unauthed/offline
# or if GH_TASK_REPO not configured in brain-os.config.md.
if [ -n "${GH_TASK_REPO:-}" ] && command -v gh >/dev/null 2>&1; then
  TMP_DIR=$(mktemp -d)
  trap 'rm -rf "$TMP_DIR"' EXIT

  fetch_titles() {
    local status="$1"
    local out="$2"
    gh issue list -R "$GH_TASK_REPO" --state open --label "status:${status}" \
      --limit 100 --json title \
      --template '{{range .}}{{.title}}{{"\n"}}{{end}}' \
      > "$out" 2>/dev/null || true
  }

  fetch_count() {
    local status="$1"
    local out="$2"
    gh issue list -R "$GH_TASK_REPO" --state open --label "status:${status}" \
      --limit 200 --json number --jq 'length' \
      > "$out" 2>/dev/null || echo 0 > "$out"
  }

  fetch_titles in-progress "$TMP_DIR/in_progress" &
  fetch_titles ready "$TMP_DIR/ready" &
  fetch_count backlog "$TMP_DIR/backlog_count" &
  wait

  IN_PROGRESS=$(cat "$TMP_DIR/in_progress" 2>/dev/null)
  READY=$(cat "$TMP_DIR/ready" 2>/dev/null)
  BACKLOG_COUNT=$(cat "$TMP_DIR/backlog_count" 2>/dev/null | tr -d '[:space:]')
  case "$BACKLOG_COUNT" in
    ''|*[!0-9]*) BACKLOG_COUNT=0 ;;
  esac

  count_lines() {
    [ -z "$1" ] && echo 0 && return
    printf '%s' "$1" | grep -c '^' 2>/dev/null || echo 0
  }

  IP_COUNT=$(count_lines "$IN_PROGRESS")
  R_COUNT=$(count_lines "$READY")

  if [ "$R_COUNT" -gt 0 ] || [ "$IP_COUNT" -gt 0 ] || [ "$BACKLOG_COUNT" -gt 0 ]; then
    echo "📋 Open Tasks"

    if [ "$IP_COUNT" -gt 0 ]; then
      echo ""
      echo "▶ In Progress ($IP_COUNT):"
      echo "$IN_PROGRESS" | while IFS= read -r line; do
        [ -z "$line" ] && continue
        clean=$(echo "$line" | sed 's/\*\*//g; s/\[\[.*|\(.*\)\]\]/\1/g; s/\[\[.*\]\]//g' | cut -c1-120)
        echo "  • $clean"
      done
    fi

    if [ "$R_COUNT" -gt 0 ]; then
      echo ""
      echo "⏳ Ready ($R_COUNT):"
      echo "$READY" | while IFS= read -r line; do
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
