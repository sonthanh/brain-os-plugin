#!/usr/bin/env bash
# Open a GitHub issue for an existing handover doc.
# Fails loudly if gh create fails so the caller can't silently skip.
# Appends an outcome line with `issue={N}` to skill-outcomes/handover.log.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$PLUGIN_ROOT/hooks/resolve-vault.sh"

HANDOVER_PATH=""
TITLE=""
TLDR=""
NEXT_STEP=""
AREA="vault"
PRIORITY="p1"
WEIGHT="heavy"
OWNER="human"

usage() {
  cat >&2 <<USAGE
Usage: create-handover-issue.sh \\
  --handover-path <vault-relative path, e.g. daily/handovers/YYYY-MM-DD-topic.md> \\
  --title "<issue title>" \\
  --tldr "<one-line summary>" \\
  --next-step "<first action from the handover>" \\
  [--area <plugin-brain-os|plugin-ai-leaders-vietnam|vault|claude-config>] (default vault) \\
  [--priority p1|p2|p3] (default p1) \\
  [--weight heavy|quick]   (default heavy) \\
  [--owner human|bot]      (default human)
USAGE
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --handover-path) HANDOVER_PATH="$2"; shift 2 ;;
    --title) TITLE="$2"; shift 2 ;;
    --tldr) TLDR="$2"; shift 2 ;;
    --next-step) NEXT_STEP="$2"; shift 2 ;;
    --area) AREA="$2"; shift 2 ;;
    --priority) PRIORITY="$2"; shift 2 ;;
    --weight) WEIGHT="$2"; shift 2 ;;
    --owner) OWNER="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown flag: $1" >&2; usage ;;
  esac
done

[[ -z "$HANDOVER_PATH" || -z "$TITLE" || -z "$TLDR" || -z "$NEXT_STEP" ]] && usage

if [[ -z "${GH_TASK_REPO:-}" ]]; then
  echo "GH_TASK_REPO not set — check brain-os.config.md (keys: vault_path, gh_task_repo)" >&2
  exit 2
fi

FULL_PATH="$VAULT_PATH/$HANDOVER_PATH"
if [[ ! -f "$FULL_PATH" ]]; then
  echo "Handover doc not found at: $FULL_PATH" >&2
  echo "Create the handover doc FIRST, then call this script." >&2
  exit 2
fi

BODY=$(cat <<EOF
Continue unfinished work from the prior session.

- TL;DR: $TLDR
- Next step: $NEXT_STEP
- [handover]($HANDOVER_PATH)
EOF
)

URL=$(bash "$PLUGIN_ROOT/scripts/gh-tasks/create-task-issue.sh" \
  --title "$TITLE" \
  --body "$BODY" \
  --area "$AREA" \
  --owner "$OWNER" \
  --priority "$PRIORITY" \
  --weight "$WEIGHT" \
  --status ready \
  --type handover)

ISSUE_NUM="${URL##*/}"
if ! [[ "$ISSUE_NUM" =~ ^[0-9]+$ ]]; then
  echo "Failed to parse issue number from: $URL" >&2
  exit 1
fi

LOG_FILE="$VAULT_PATH/daily/skill-outcomes/handover.log"
mkdir -p "$(dirname "$LOG_FILE")"
DATE=$(date +%Y-%m-%d)
TOPIC=$(basename "$HANDOVER_PATH" .md | sed 's/^[0-9-]*-//')
COMMIT=$(cd "$VAULT_PATH" && git log -1 --pretty=format:%h -- "$HANDOVER_PATH" 2>/dev/null || echo pending)
echo "$DATE | handover | handover | $VAULT_PATH | $HANDOVER_PATH | commit:$COMMIT issue=$ISSUE_NUM | pass | args=$TOPIC" >> "$LOG_FILE"

echo "$URL"
echo "issue=$ISSUE_NUM"
