#!/bin/bash
# pickup-claim.sh — atomic claim of a GH issue: status:ready → status:in-progress
#
# Single source of truth for the claim flip used by all /pickup entry points
# (interactive, /pickup <N>, /pickup auto). Pulled out of SKILL.md prose to
# eliminate skip-step bugs where the foreground LLM orchestrator spawns
# workers without flipping labels, leaving /status mis-classifying issues.
#
# Usage: pickup-claim.sh <issue-number>
#
# Exit codes:
#   0 — claim flip just happened (caller may now spawn worker / start work)
#   1 — not claimable (closed, blocked, backlog, unknown status)
#   2 — config / gh API error
#   3 — already status:in-progress (no-op; caller should skip spawn but may
#        proceed for /pickup <N> where user explicitly chose this issue)
#
# Output: one-line status to stdout on success, error to stderr on failure.

set -uo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: pickup-claim.sh <issue-number>" >&2
  exit 2
fi

N="$1"
if [[ ! "$N" =~ ^[0-9]+$ ]]; then
  echo "ERROR: '$N' is not a valid issue number" >&2
  exit 2
fi

# Resolve config
RESOLVER=""
for candidate in \
  "${BRAIN_OS_RESOLVER:-}" \
  "$HOME/work/brain-os-plugin/hooks/resolve-vault.sh" \
  "$HOME/.claude/plugins/cache/brain-os-marketplace/brain-os/hooks/resolve-vault.sh"; do
  if [[ -n "$candidate" && -f "$candidate" ]]; then
    RESOLVER="$candidate"
    break
  fi
done

if [[ -z "$RESOLVER" ]]; then
  echo "ERROR: resolve-vault.sh not found" >&2
  exit 2
fi
# shellcheck disable=SC1090
source "$RESOLVER"

if [[ -z "${GH_TASK_REPO:-}" ]]; then
  echo "ERROR: GH_TASK_REPO not configured" >&2
  exit 2
fi

META=$(gh issue view "$N" -R "$GH_TASK_REPO" --json state,labels 2>/dev/null) || {
  echo "ERROR: cannot fetch issue #$N from $GH_TASK_REPO" >&2
  exit 2
}

STATE=$(echo "$META" | jq -r '.state')
STATUS=$(echo "$META" | jq -r '[.labels[].name | select(startswith("status:"))][0] // empty')

if [[ "$STATE" != "OPEN" ]]; then
  echo "ABORT: #$N is $STATE (expected OPEN)" >&2
  exit 1
fi

case "$STATUS" in
  status:in-progress)
    echo "✓ #$N already status:in-progress (no-op)"
    exit 3
    ;;
  status:ready|"")
    # Atomic flip via the canonical helper (single source of truth for all
    # status:* transitions). transition-status.sh issues one `gh issue edit`
    # call removing the current status:* and adding the target — same wire
    # behavior as the previous inline edit, plus uniform validation + logging.
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    TRANSITION="$SCRIPT_DIR/gh-tasks/transition-status.sh"
    if bash "$TRANSITION" "$N" --to in-progress >/dev/null 2>&1; then
      FROM_LABEL="${STATUS:-(none)}"
      echo "✓ claimed #$N ($FROM_LABEL → status:in-progress)"
      exit 0
    fi
    echo "ERROR: claim flip failed on #$N (transition-status.sh returned non-zero)" >&2
    exit 2
    ;;
  status:blocked|status:backlog)
    echo "ABORT: #$N has status='$STATUS' (not claimable — groom first)" >&2
    exit 1
    ;;
  *)
    echo "ABORT: #$N has unknown status='$STATUS'" >&2
    exit 1
    ;;
esac
