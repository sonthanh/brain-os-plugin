#!/usr/bin/env bash
# check-trunk-paths.sh — thin wrapper that resolves trunk-paths.txt and invokes
# the Python matcher. Reads paths from stdin, prints matches to stdout, exits 1
# if any match.
#
# Resolution order for trunk-paths.txt:
#   1. Argument $1 (explicit override)
#   2. $CLAUDE_PLUGIN_ROOT/references/trunk-paths.txt (in-source dev)
#   3. Latest installed plugin under ~/.claude/plugins/cache (deployed)
#
# Usage:
#   echo -e "skill-spec.md\nfoo.txt" | bash check-trunk-paths.sh
#
# Output: tab-separated `<path>\t<matched-pattern>` for each input path that hits.
# Exit code: 0 if no matches, 1 if any matches, 2 on usage error.

set -uo pipefail

TRUNK_PATHS="${1:-}"
if [ -z "$TRUNK_PATHS" ]; then
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$CLAUDE_PLUGIN_ROOT/references/trunk-paths.txt" ]; then
    TRUNK_PATHS="$CLAUDE_PLUGIN_ROOT/references/trunk-paths.txt"
  else
    TRUNK_PATHS=$(ls -d ~/.claude/plugins/cache/brain-os-marketplace/brain-os/*/references/trunk-paths.txt 2>/dev/null \
      | grep -E '/[0-9]+\.[0-9]+\.[0-9]+/references/trunk-paths\.txt$' \
      | sort -Vr | head -1)
  fi
fi

[ -z "$TRUNK_PATHS" ] && { echo "check-trunk-paths: no trunk-paths.txt resolved" >&2; exit 2; }
[ ! -r "$TRUNK_PATHS" ] && { echo "check-trunk-paths: cannot read $TRUNK_PATHS" >&2; exit 2; }

# Resolve the .py companion next to this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY_SCRIPT="$SCRIPT_DIR/check-trunk-paths.py"
[ ! -r "$PY_SCRIPT" ] && { echo "check-trunk-paths: cannot read $PY_SCRIPT" >&2; exit 2; }

python3 "$PY_SCRIPT" "$TRUNK_PATHS"
