#!/bin/bash
# create-task-issue.sh — central filer for tracker issues.
#
# Builds the canonical label set, validates each value against the canon, then
# invokes `gh issue create -R sonthanh/ai-brain`. Caller passes content + axes;
# this script owns label assembly so /to-issues, /slice, /handover, and
# anything else that files an issue stop drifting on label spelling.
#
# Returns the new issue URL on stdout (or the underlying gh command on
# --dry-run). Exits non-zero on validation failure or gh error.

set -uo pipefail

REPO="sonthanh/ai-brain"

VALID_AREA=("plugin-brain-os" "plugin-ai-leaders-vietnam" "vault" "claude-config")
VALID_OWNER=("bot" "human")
VALID_PRIORITY=("p1" "p2" "p3")
VALID_WEIGHT=("quick" "heavy")
VALID_STATUS=("ready" "blocked" "backlog")
VALID_TYPE=("handover" "plan")

TITLE=""
BODY=""
AREA=""
OWNER=""
PRIORITY=""
WEIGHT=""
STATUS=""
TYPE=""
DRY_RUN=0

usage() {
  cat <<EOF
create-task-issue.sh — file a tracker issue with canonical labels.

Usage:
  create-task-issue.sh --title <T> --body <B> --area <A> --owner <bot|human> \\
    --priority <p1|p2|p3> --weight <quick|heavy> --status <ready|blocked|backlog> \\
    [--type <handover|plan>] [--dry-run]

Required:
  --title <T>           Issue title
  --body <B>            Issue body (markdown)
  --area <A>            One of: ${VALID_AREA[*]}
  --owner <O>           One of: ${VALID_OWNER[*]}
  --priority <P>        One of: ${VALID_PRIORITY[*]}
  --weight <W>          One of: ${VALID_WEIGHT[*]}
  --status <S>          One of: ${VALID_STATUS[*]}

Optional:
  --type <handover|plan>  Adds type:handover or type:plan
  --dry-run               Print the gh command without executing
  --help                  Show this message and exit

Output: new issue URL on stdout (or gh command in --dry-run mode).
EOF
}

in_list() {
  local needle="$1"; shift
  for v in "$@"; do
    [[ "$v" == "$needle" ]] && return 0
  done
  return 1
}

if [[ $# -eq 0 ]]; then
  usage; exit 2
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --title)    TITLE="${2:-}";    shift 2 ;;
    --body)     BODY="${2:-}";     shift 2 ;;
    --area)     AREA="${2:-}";     shift 2 ;;
    --owner)    OWNER="${2:-}";    shift 2 ;;
    --priority) PRIORITY="${2:-}"; shift 2 ;;
    --weight)   WEIGHT="${2:-}";   shift 2 ;;
    --status)   STATUS="${2:-}";   shift 2 ;;
    --type)     TYPE="${2:-}";     shift 2 ;;
    --dry-run)  DRY_RUN=1;         shift ;;
    *) echo "ERROR: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

[[ -z "$TITLE"    ]] && { echo "ERROR: --title required" >&2;    exit 2; }
[[ -z "$BODY"     ]] && { echo "ERROR: --body required" >&2;     exit 2; }
[[ -z "$AREA"     ]] && { echo "ERROR: --area required" >&2;     exit 2; }
[[ -z "$OWNER"    ]] && { echo "ERROR: --owner required" >&2;    exit 2; }
[[ -z "$PRIORITY" ]] && { echo "ERROR: --priority required" >&2; exit 2; }
[[ -z "$WEIGHT"   ]] && { echo "ERROR: --weight required" >&2;   exit 2; }
[[ -z "$STATUS"   ]] && { echo "ERROR: --status required" >&2;   exit 2; }

in_list "$AREA"     "${VALID_AREA[@]}"     || { echo "ERROR: invalid --area '$AREA' (canon: ${VALID_AREA[*]})" >&2; exit 2; }
in_list "$OWNER"    "${VALID_OWNER[@]}"    || { echo "ERROR: invalid --owner '$OWNER' (canon: ${VALID_OWNER[*]})" >&2; exit 2; }
in_list "$PRIORITY" "${VALID_PRIORITY[@]}" || { echo "ERROR: invalid --priority '$PRIORITY' (canon: ${VALID_PRIORITY[*]})" >&2; exit 2; }
in_list "$WEIGHT"   "${VALID_WEIGHT[@]}"   || { echo "ERROR: invalid --weight '$WEIGHT' (canon: ${VALID_WEIGHT[*]})" >&2; exit 2; }
in_list "$STATUS"   "${VALID_STATUS[@]}"   || { echo "ERROR: invalid --status '$STATUS' (canon: ${VALID_STATUS[*]})" >&2; exit 2; }
if [[ -n "$TYPE" ]]; then
  in_list "$TYPE"   "${VALID_TYPE[@]}"     || { echo "ERROR: invalid --type '$TYPE' (canon: ${VALID_TYPE[*]})" >&2; exit 2; }
fi

LABELS=("area:$AREA" "owner:$OWNER" "priority:$PRIORITY" "weight:$WEIGHT" "status:$STATUS")
[[ -n "$TYPE" ]] && LABELS+=("type:$TYPE")

LABEL_CSV=$(IFS=,; echo "${LABELS[*]}")

# Build single-line gh command (each label as its own --label flag for gh,
# AND a comma-joined preview that the dry-run consumer can grep).
CMD="gh issue create -R $REPO --title '$TITLE' --body '$BODY' --label '$LABEL_CSV'"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "$CMD"
  exit 0
fi

# Real invocation: pass each label individually so commas inside future label
# values can't break parsing.
GH_ARGS=(issue create -R "$REPO" --title "$TITLE" --body "$BODY")
for L in "${LABELS[@]}"; do
  GH_ARGS+=(--label "$L")
done

gh "${GH_ARGS[@]}"
