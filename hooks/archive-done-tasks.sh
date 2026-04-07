#!/usr/bin/env bash
# Auto-archive done tasks older than 7 days from kanban inbox.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/resolve-vault.sh"

INBOX="$VAULT_PATH/business/tasks/inbox.md"
ARCHIVE_DIR="$VAULT_PATH/business/tasks/archive"

if [ ! -f "$INBOX" ]; then
  exit 0
fi

CUTOFF=$(date -v-7d +%Y-%m-%d 2>/dev/null || date -d '7 days ago' +%Y-%m-%d 2>/dev/null)
if [ -z "$CUTOFF" ]; then
  exit 0
fi

MONTH=$(date +%Y-%m)
ARCHIVE_FILE="$ARCHIVE_DIR/$MONTH.md"
mkdir -p "$ARCHIVE_DIR"

if [ ! -f "$ARCHIVE_FILE" ]; then
  cat > "$ARCHIVE_FILE" << EOF
---
title: Task Archive — $MONTH
tags: [tasks, archive]
zone: business
---

# Task Archive — $MONTH

EOF
fi

TMPFILE=$(mktemp)
cp "$INBOX" "$TMPFILE"

sed -n '/^## Done$/,$ p' "$INBOX" | grep '^\- \[x\]' | while IFS= read -r line; do
  TASK_DATE=$(echo "$line" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' | tail -1)
  if [ -z "$TASK_DATE" ]; then
    continue
  fi

  if [ "$TASK_DATE" \< "$CUTOFF" ] || [ "$TASK_DATE" = "$CUTOFF" ]; then
    echo "$line" >> "$ARCHIVE_FILE"
    ESCAPED=$(printf '%s\n' "$line" | sed 's/[[\.*^$()+?{|]/\\&/g')
    sed -i '' "/${ESCAPED}/d" "$TMPFILE" 2>/dev/null || sed -i "/${ESCAPED}/d" "$TMPFILE" 2>/dev/null
  fi
done

if [ -s "$TMPFILE" ]; then
  cp "$TMPFILE" "$INBOX"
fi
rm -f "$TMPFILE"
