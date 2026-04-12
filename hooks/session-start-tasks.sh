#!/usr/bin/env bash
# Show open tasks + vault index on session start.
# Vault index enables brain-first lookup: agent sees recent research, aha notes,
# active plans, and grill sessions before deciding to do external research.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/resolve-vault.sh"

INBOX="$VAULT_PATH/business/tasks/inbox.md"
if [ ! -f "$INBOX" ]; then
  exit 0
fi

get_column() {
  local col="$1"
  local next="$2"
  sed -n "/^## ${col}$/,/^## ${next}$/p" "$INBOX" | grep '^- \[ \]' | sed 's/^- \[ \] //'
}

READY=$(get_column "Ready" "In Progress")
IN_PROGRESS=$(get_column "In Progress" "Backlog")
BACKLOG=$(get_column "Backlog" "Done")

count_lines() {
  [ -z "$1" ] && echo 0 && return
  printf '%s' "$1" | grep -c '^' 2>/dev/null || echo 0
}

R_COUNT=$(count_lines "$READY")
IP_COUNT=$(count_lines "$IN_PROGRESS")
B_COUNT=$(count_lines "$BACKLOG")

if [ "$R_COUNT" -gt 0 ] || [ "$IP_COUNT" -gt 0 ] || [ "$B_COUNT" -gt 0 ]; then
  echo "📋 Open Tasks"

  if [ "$IP_COUNT" -gt 0 ]; then
    echo ""
    echo "▶ In Progress ($IP_COUNT):"
    echo "$IN_PROGRESS" | while IFS= read -r line; do
      clean=$(echo "$line" | sed 's/\[\[.*|\(.*\)\]\]/\1/g; s/\[\[.*\]\]//g; s/\*\*//g' | cut -c1-120)
      echo "  • $clean"
    done
  fi

  if [ "$R_COUNT" -gt 0 ]; then
    echo ""
    echo "⏳ Ready ($R_COUNT):"
    echo "$READY" | while IFS= read -r line; do
      clean=$(echo "$line" | sed 's/\[\[.*|\(.*\)\]\]/\1/g; s/\[\[.*\]\]//g; s/\*\*//g' | cut -c1-120)
      echo "  • $clean"
    done
  fi

  if [ "$B_COUNT" -gt 0 ]; then
    echo ""
    echo "📦 Backlog ($B_COUNT)"
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
