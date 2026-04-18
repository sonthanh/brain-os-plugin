#!/usr/bin/env bash
# pre-commit-eval-gap.sh — BLOCK commits that change skills/X/SKILL.md
# without also staging skills/X/evals/evals.json.
#
# Same principle as unit tests in code: you don't ship behavior changes
# without updating the test suite.
#
# Bypass: `git commit --no-verify` (use only if the SKILL.md change is
# purely cosmetic — typo, whitespace, formatting).
#
# Install:
#   ln -sf ../../hooks/pre-commit-eval-gap.sh .git/hooks/pre-commit
# Or run scripts/install-hooks.sh

set -euo pipefail

# Staged files in this commit
STAGED=$(git diff --cached --name-only)
[[ -z "$STAGED" ]] && exit 0

# Which skills have SKILL.md in the stage?
# (|| true: grep exits 1 when no match, which is the common case. pipefail+set -e would kill us.)
CHANGED_SKILLS=$(printf '%s\n' "$STAGED" \
  | { grep -E '^skills/[^/]+/SKILL\.md$' || true; } \
  | awk -F/ '{print $2}' \
  | sort -u)

[[ -z "$CHANGED_SKILLS" ]] && exit 0

GAP=""
for skill in $CHANGED_SKILLS; do
  if ! printf '%s\n' "$STAGED" | grep -q "^skills/$skill/evals/evals.json$"; then
    GAP+="  • skills/$skill/SKILL.md (evals/evals.json not staged)\n"
  fi
done

if [[ -n "$GAP" ]]; then
  printf '\n\033[1;31m✗ EVAL COVERAGE GAP — commit blocked\033[0m\n\n' >&2
  printf 'You changed skill behavior without updating evals:\n' >&2
  printf "$GAP" >&2
  printf '\n' >&2
  printf 'Same principle as unit tests: behavior changes ship with test updates.\n' >&2
  printf 'Options:\n' >&2
  printf '  1. Add/update the matching evals.json in the same commit (preferred).\n' >&2
  printf '  2. If the SKILL.md change is cosmetic (typo/whitespace), bypass with --no-verify.\n' >&2
  printf '\n' >&2
  exit 1
fi

exit 0
