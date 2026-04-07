#!/usr/bin/env bash
# Show open tasks from vault kanban inbox on session start.

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

R_COUNT=$(echo "$READY" | grep -c '.' 2>/dev/null || echo 0)
IP_COUNT=$(echo "$IN_PROGRESS" | grep -c '.' 2>/dev/null || echo 0)
B_COUNT=$(echo "$BACKLOG" | grep -c '.' 2>/dev/null || echo 0)

if [ "$R_COUNT" -eq 0 ] && [ "$IP_COUNT" -eq 0 ] && [ "$B_COUNT" -eq 0 ]; then
  exit 0
fi

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
