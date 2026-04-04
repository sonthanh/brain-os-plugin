#!/usr/bin/env bash
# smart-diff-check.sh — PostToolUse hook for SKILL.md changes
#
# Auto-derives invariants from the previous git version and checks
# the new version hasn't lost critical content. No manual rules file.
#
# Exit codes:
#   0 = pass (or not a SKILL.md file)
#   2 = blocked (critical removals detected)

set -euo pipefail

# Read tool input from stdin (Claude Code passes JSON)
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.file // empty' 2>/dev/null)

# Only check SKILL.md files inside brain-os skills
if [[ -z "$FILE_PATH" ]] || [[ ! "$FILE_PATH" =~ /skills/[^/]+/SKILL\.md$ ]]; then
  exit 0
fi

# Skip if file doesn't exist (deleted)
if [[ ! -f "$FILE_PATH" ]]; then
  exit 0
fi

# Find the git repo root for this file
REPO_ROOT=$(cd "$(dirname "$FILE_PATH")" && git rev-parse --show-toplevel 2>/dev/null) || exit 0
RELATIVE_PATH=$(python3 -c "import os; print(os.path.relpath('$FILE_PATH', '$REPO_ROOT'))")

# Get skill name from path
SKILL_NAME=$(echo "$FILE_PATH" | grep -oE 'skills/[^/]+' | sed 's|skills/||')

# Get old version from git
OLD=$(cd "$REPO_ROOT" && git show "HEAD:$RELATIVE_PATH" 2>/dev/null) || {
  # New skill, no git history — skip checks
  exit 0
}

NEW=$(cat "$FILE_PATH")

# --- Extract invariants from old version ---

ISSUES=()
PASSES=()

# 1. Word count check (warn if dropped >40%)
OLD_WORDS=$(echo "$OLD" | wc -w | tr -d ' ')
NEW_WORDS=$(echo "$NEW" | wc -w | tr -d ' ')

if [[ "$OLD_WORDS" -gt 0 ]]; then
  DROP=$(( (OLD_WORDS - NEW_WORDS) * 100 / OLD_WORDS ))
  if [[ "$DROP" -gt 40 ]]; then
    ISSUES+=("✗ Word count dropped ${DROP}% (${OLD_WORDS} → ${NEW_WORDS})")
  elif [[ "$DROP" -gt 20 ]]; then
    PASSES+=("⚠ Word count dropped ${DROP}% (${OLD_WORDS} → ${NEW_WORDS})")
  else
    PASSES+=("✓ Word count OK (${OLD_WORDS} → ${NEW_WORDS})")
  fi
fi

# 2. Script references (*.py files)
OLD_SCRIPTS=$(echo "$OLD" | grep -oE '[a-z_]+\.py' | sort -u)
MISSING_SCRIPTS=()
if [[ -n "$OLD_SCRIPTS" ]]; then
  while IFS= read -r script; do
    if ! echo "$NEW" | grep -qF "$script"; then
      MISSING_SCRIPTS+=("$script")
    fi
  done <<< "$OLD_SCRIPTS"
fi

if [[ ${#MISSING_SCRIPTS[@]} -gt 0 ]]; then
  for s in "${MISSING_SCRIPTS[@]}"; do
    ISSUES+=("✗ Removed script reference: $s")
  done
else
  if [[ -n "$OLD_SCRIPTS" ]]; then
    PASSES+=("✓ All script references preserved")
  fi
fi

# 3. Section headers (## lines)
OLD_SECTIONS=$(echo "$OLD" | grep '^## ' | sort -u)
MISSING_SECTIONS=()
if [[ -n "$OLD_SECTIONS" ]]; then
  while IFS= read -r section; do
    if ! echo "$NEW" | grep -qF "$section"; then
      MISSING_SECTIONS+=("$section")
    fi
  done <<< "$OLD_SECTIONS"
fi

if [[ ${#MISSING_SECTIONS[@]} -gt 0 ]]; then
  for s in "${MISSING_SECTIONS[@]}"; do
    ISSUES+=("✗ Removed section: $s")
  done
else
  if [[ -n "$OLD_SECTIONS" ]]; then
    PASSES+=("✓ All section headers preserved")
  fi
fi

# 4. Key terms (important concepts/tools that shouldn't disappear)
OLD_TERMS=$(echo "$OLD" | grep -oiE 'notebooklm use|notebooklm ask|information barriers|autoresearch|audit-flag\.json|obsidian_vault|notebooklm_bin|scripts_dir|knowledge/raw' | sort -u)
MISSING_TERMS=()
if [[ -n "$OLD_TERMS" ]]; then
  while IFS= read -r term; do
    if ! echo "$NEW" | grep -qiF "$term"; then
      MISSING_TERMS+=("$term")
    fi
  done <<< "$OLD_TERMS"
fi

if [[ ${#MISSING_TERMS[@]} -gt 0 ]]; then
  for t in "${MISSING_TERMS[@]}"; do
    ISSUES+=("✗ Removed key term: \"$t\"")
  done
else
  if [[ -n "$OLD_TERMS" ]]; then
    PASSES+=("✓ All key terms preserved")
  fi
fi

# 5. Numeric thresholds (≥ 95, 100%, 50%, etc.)
OLD_NUMBERS=$(echo "$OLD" | grep -oE '≥\s*[0-9]+|[0-9]+%' | sort -u)
MISSING_NUMBERS=()
if [[ -n "$OLD_NUMBERS" ]]; then
  while IFS= read -r num; do
    if ! echo "$NEW" | grep -qF "$num"; then
      MISSING_NUMBERS+=("$num")
    fi
  done <<< "$OLD_NUMBERS"
fi

if [[ ${#MISSING_NUMBERS[@]} -gt 0 ]]; then
  for n in "${MISSING_NUMBERS[@]}"; do
    ISSUES+=("✗ Removed threshold/number: $n")
  done
else
  if [[ -n "$OLD_NUMBERS" ]]; then
    PASSES+=("✓ All thresholds preserved")
  fi
fi

# --- Report ---

TOTAL_ISSUES=${#ISSUES[@]}

if [[ "$TOTAL_ISSUES" -eq 0 ]]; then
  # All good — brief pass report
  echo "✓ SKILL.md check passed: $SKILL_NAME"
  for p in "${PASSES[@]}"; do
    echo "  $p"
  done
  exit 0
else
  # Issues found — detailed report
  echo ""
  echo "⚠️  SKILL.md changed: $SKILL_NAME"
  echo "─────────────────────────────────"
  for issue in "${ISSUES[@]}"; do
    echo "  $issue"
  done
  for p in "${PASSES[@]}"; do
    echo "  $p"
  done
  echo ""
  echo "$TOTAL_ISSUES issue(s) detected. Review removals — if intentional, commit the old version first."
  echo ""
  exit 2
fi
