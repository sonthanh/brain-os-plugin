#!/usr/bin/env bash
# PostToolUse/Bash — if command is a gh issue mutation, mark status cache dirty.
# File-based sources (sla-open.md, daily summaries, content-ideas.md) are
# detected by mtime in render-status.sh; only GH state changes need a signal.
set -u

INPUT=$(cat 2>/dev/null || true)
[ -z "$INPUT" ] && exit 0

CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$CMD" ] && exit 0

if echo "$CMD" | grep -qE 'gh[[:space:]]+issue[[:space:]]+(edit|close|reopen|comment|delete|lock|unlock|transfer|create)'; then
  CACHE_DIR="${HOME}/.cache/brain-os"
  mkdir -p "$CACHE_DIR" 2>/dev/null || true
  touch "$CACHE_DIR/status.dirty" 2>/dev/null || true
fi

exit 0
