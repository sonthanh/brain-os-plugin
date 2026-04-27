#!/usr/bin/env bash
# Render Vault Index panel — recent research / aha / grills / handovers.
# Brain-first lookup: agent sees what exists in vault before deciding to do
# external research.
#
# Caller responsibility: source resolve-vault.sh (or otherwise export VAULT_PATH)
# before invoking. Standalone invocation will source it itself if needed.
#
# Extracted from hooks/session-start-tasks.sh (issue #174 path-narrowing) — keeps the
# hook entry point thin so render-only edits ship as leaf changes.

set -uo pipefail

if [ -z "${VAULT_PATH:-}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  RESOLVE="$SCRIPT_DIR/../hooks/resolve-vault.sh"
  [ -f "$RESOLVE" ] && source "$RESOLVE"
fi

[ -z "${VAULT_PATH:-}" ] && exit 0
[ ! -d "$VAULT_PATH" ] && exit 0

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
