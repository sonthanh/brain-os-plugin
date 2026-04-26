#!/usr/bin/env bash
# pre-commit-trunk-block.sh — PreToolUse(Bash) hook that blocks AFK commits
# whose staged files touch any path on the trunk-paths.txt list.
#
# Trigger condition (BOTH must hold):
#   1. Tool command contains the literal token `IMPL_AFK=1` (set by /impl
#      skill before its commit + push step)
#   2. Tool command invokes `git commit` (the actual writing-of-record event)
#
# When triggered: diffs staged files against the trunk-paths.txt globs (using
# git's `:(glob)` pathspec). Any match → exit 2 with explanation. Caller
# (Claude Code) blocks the commit.
#
# Interactive commits (no IMPL_AFK=1 prefix) are pass-through: the hook is a
# no-op. This preserves the direct-push-to-main default for interactive work
# (working-rules.md §3).
#
# Source: daily/grill-sessions/2026-04-26-depth-leaf-trunk-design.md (#136)

set -uo pipefail

INPUT=$(cat 2>/dev/null || true)
[ -z "$INPUT" ] && exit 0

CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$CMD" ] && exit 0

# Must be an AFK-marked git commit
case "$CMD" in
  *IMPL_AFK=1*git\ commit*) ;;
  *) exit 0 ;;
esac

# Run inside the cwd Claude is operating in. If not in a git repo, no-op.
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

STAGED=$(git diff --cached --name-only 2>/dev/null)
[ -z "$STAGED" ] && exit 0

# Resolve check-trunk-paths.sh — prefer same-version plugin install
CHECK_SH=""
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -x "$CLAUDE_PLUGIN_ROOT/scripts/check-trunk-paths.sh" ]; then
  CHECK_SH="$CLAUDE_PLUGIN_ROOT/scripts/check-trunk-paths.sh"
else
  CHECK_SH=$(ls -d ~/.claude/plugins/cache/brain-os-marketplace/brain-os/*/scripts/check-trunk-paths.sh 2>/dev/null \
    | grep -E '/[0-9]+\.[0-9]+\.[0-9]+/scripts/check-trunk-paths\.sh$' \
    | sort -Vr | head -1)
fi
[ -z "$CHECK_SH" ] && exit 0
[ ! -x "$CHECK_SH" ] && exit 0

MATCHES=$(printf '%s\n' "$STAGED" | bash "$CHECK_SH" 2>/dev/null || true)
[ -z "$MATCHES" ] && exit 0

{
  printf '\n\033[1;31m✗ TRUNK-PATH COMMIT BLOCKED (IMPL_AFK=1)\033[0m\n\n'
  printf 'AFK commit touches paths on the trunk-paths list:\n'
  printf '%s\n' "$MATCHES" | awk -F'\t' '{printf "  • %-40s (matched %s)\n", $1, $2}'
  printf '\n'
  printf 'Why: trunk-class changes (CLAUDE.md, hooks/, references/, plugin.json,\n'
  printf 'cross-skill primitives) demand human review at merge regardless of test pass.\n'
  printf 'Source: knowledge/research/reports/2026-04-26-anthropic-vibe-coding-prod-playbook.md\n\n'
  printf 'Options:\n'
  printf '  1. Drop IMPL_AFK=1 and re-run interactively — direct-push remains unchanged.\n'
  printf '  2. Re-classify the issue owner:human and run /impl interactively next session.\n'
  printf '  3. If the rubric is wrong (path is not actually trunk), edit\n'
  printf '     references/trunk-paths.txt — itself a trunk change, review accordingly.\n'
} >&2

exit 2
