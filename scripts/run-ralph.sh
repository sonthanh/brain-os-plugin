#!/bin/bash
# run-ralph.sh — passthrough wrapper to ralph-loop's setup script.
# Resolves the installed ralph-loop plugin path dynamically so we are not
# pinned to a specific cache version. Used by /impl auto.
set -euo pipefail

RALPH_DIR=$(ls -d "$HOME"/.claude/plugins/cache/claude-plugins-official/ralph-loop/*/ 2>/dev/null | sort -V | tail -1)
if [[ -z "$RALPH_DIR" ]]; then
  echo "run-ralph.sh: ralph-loop plugin not found under ~/.claude/plugins/cache/claude-plugins-official/ralph-loop/" >&2
  exit 1
fi

exec bash "${RALPH_DIR}scripts/setup-ralph-loop.sh" "$@"
