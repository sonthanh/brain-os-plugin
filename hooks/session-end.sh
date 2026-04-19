#!/usr/bin/env bash
# Auto-commit vault changes and capture session summary on session end.

set -uo pipefail

# Skip in non-interactive claude -p subprocess context (e.g. email extraction workers).
# These subprocesses run in parallel; the hook racing 10× on git causes index.lock failures.
[[ -n "${CLAUDE_SUBPROCESS:-}" ]] && exit 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/resolve-vault.sh"

# --- 0. Clear trace-capture active-skill state for this session ---
INPUT=$(cat 2>/dev/null || echo "")
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
if [ -n "$SESSION_ID" ]; then
  rm -f "${TMPDIR:-/tmp}/claude-trace/${SESSION_ID}.skill" 2>/dev/null || true
fi

TIMESTAMP=$(date +%Y-%m-%dT%H-%M)
DATE=$(date +%Y-%m-%d)
REPO_NAME=$(basename "$PWD" 2>/dev/null || echo "unknown")
SESSIONS_DIR="$VAULT_PATH/daily/sessions"

# --- 1. Auto-commit vault changes ---
if [ -d "$VAULT_PATH/.git" ]; then
  cd "$VAULT_PATH"
  if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    git add -A
    git commit -m "auto: session close — $(date +%Y-%m-%d\ %H:%M)" --no-verify 2>/dev/null || true
    git push 2>/dev/null || true
  fi
fi

# --- 2. Capture session summary ---
mkdir -p "$SESSIONS_DIR"
SUMMARY_FILE="$SESSIONS_DIR/${TIMESTAMP}-${REPO_NAME}.md"

SINCE=$(date -v-2H +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -d "2 hours ago" +%Y-%m-%dT%H:%M:%S 2>/dev/null)

{
  echo "---"
  echo "title: Session — $TIMESTAMP ($REPO_NAME)"
  echo "created: $(date +%Y-%m-%dT%H:%M:%S)"
  echo "tags: [session, $REPO_NAME]"
  echo "zone: daily"
  echo "---"
  echo ""
  echo "# Session — $TIMESTAMP ($REPO_NAME)"
  echo ""
  echo "## Commits (last 2h)"

  # Find all git repos under ~/work/ (one level deep)
  for repo in "$HOME"/work/*/; do
    if [ -d "$repo/.git" ]; then
      COMMITS=$(git -C "$repo" log --oneline --since="$SINCE" 2>/dev/null || true)
      if [ -n "$COMMITS" ]; then
        echo "### $(basename "$repo")"
        echo "$COMMITS" | sed 's/^/- /'
        echo ""
      fi
    fi
  done

  echo "## Files Changed"
  if [ -d "$VAULT_PATH/.git" ]; then
    git -C "$VAULT_PATH" diff --stat HEAD~3 HEAD 2>/dev/null | tail -5 || true
  fi
} > "$SUMMARY_FILE" 2>/dev/null

# Commit the session summary
if [ -d "$VAULT_PATH/.git" ]; then
  cd "$VAULT_PATH"
  git add "$SUMMARY_FILE" 2>/dev/null
  git commit -m "auto: session summary $TIMESTAMP" --no-verify 2>/dev/null || true
  git push 2>/dev/null || true
fi
