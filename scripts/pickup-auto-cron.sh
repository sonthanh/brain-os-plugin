#!/bin/bash
# pickup-auto-cron.sh — every 2h via launchd, polls GH for ready+bot issues,
# atomically claims them, and spawns a `claude -w` worker per issue.
#
# Config: sources ~/work/brain-os-plugin/hooks/resolve-vault.sh (or installed
# plugin cache) → $VAULT_PATH + $GH_TASK_REPO from brain-os.config.md.
#
# Gates:
#   • Weekly usage ≥80% (ccstatusline cache) → skip
#   • Work hours 09:00–22:00 local → only weight:quick (unless --force)
#   • --force → skip time filter
#   • --dry-run → query + filter, no claim/spawn
#
# Recovery: at start of run, releases claim:session-* labels older than 6h.

set -uo pipefail

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

STATE_DIR="$HOME/.local/state/pickup-auto"
LOG_FILE="$STATE_DIR/cron.log"
USAGE_FILE="${PICKUP_AUTO_USAGE_FILE:-$HOME/.cache/ccstatusline/usage.json}"
WEEKLY_THRESHOLD="${PICKUP_AUTO_THRESHOLD:-80}"
STALE_CLAIM_SEC=21600  # 6h

FORCE=0
DRY_RUN="${DRY_RUN:-0}"
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
  esac
done

mkdir -p "$STATE_DIR"

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG_FILE"
}

log "=== pickup-auto tick (force=$FORCE dry_run=$DRY_RUN) ==="

# ---- Resolve config
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
  log "ERROR: resolve-vault.sh not found — install brain-os plugin or set BRAIN_OS_RESOLVER"
  exit 1
fi
# shellcheck disable=SC1090
source "$RESOLVER"

if [[ -z "${GH_TASK_REPO:-}" ]]; then
  log "pickup-auto: GH_TASK_REPO not configured — exiting"
  exit 0
fi
WORK_DIR="${VAULT_PATH:-$HOME/work/brain}"
log "config: GH_TASK_REPO=$GH_TASK_REPO VAULT_PATH=$WORK_DIR"

# ---- Weekly quota gate
if [[ ! -f "$USAGE_FILE" ]]; then
  log "WARN: no usage cache at $USAGE_FILE — proceeding without gate"
else
  DECISION=$(jq -r --argjson threshold "$WEEKLY_THRESHOLD" '
    def reset_epoch:
      if .weeklyResetAt then
        (.weeklyResetAt | sub("\\..*$"; "Z") | fromdateiso8601)
      else 0 end;
    (.weeklyUsage // 0) as $u |
    reset_epoch as $r |
    if $u >= $threshold and (now < $r) then
      "skip:" + ($u|tostring) + ":" + (.weeklyResetAt // "unknown")
    else
      "run:" + ($u|tostring)
    end
  ' "$USAGE_FILE" 2>/dev/null || echo "run:parse-error")

  case "$DECISION" in
    skip:*)
      log "SKIP — weekly usage ${DECISION#skip:} (>= ${WEEKLY_THRESHOLD}%)"
      exit 0
      ;;
    run:*)
      log "PROCEED — weekly usage ${DECISION#run:}%"
      ;;
    *)
      log "WARN: unknown decision '$DECISION' — proceeding"
      ;;
  esac
fi

# ---- Pre-flight
for bin in claude gh jq; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    log "ERROR: $bin not in PATH — aborting"
    exit 1
  fi
done

if [[ ! -d "$WORK_DIR" ]]; then
  log "ERROR: work dir $WORK_DIR not found — aborting"
  exit 1
fi
cd "$WORK_DIR" || { log "ERROR: cd $WORK_DIR failed"; exit 1; }

# ---- Stale claim cleanup (release claim:session-*-<ts> labels older than 6h)
log "stale-sweep: scanning open issues for stale claim labels"
NOW_EPOCH=$(date +%s)
STALE_JSON=$(gh issue list -R "$GH_TASK_REPO" --state open \
  --json number,labels --limit 200 2>>"$LOG_FILE" || echo "[]")

STALE_PAIRS=$(echo "$STALE_JSON" | jq -r '
  .[] | .number as $n |
  .labels[].name | select(startswith("claim:session-")) |
  "\($n)\t\(.)"
')

RELEASED=0
if [[ -n "$STALE_PAIRS" ]]; then
  while IFS=$'\t' read -r N CLAIM; do
    [[ -z "$N" || -z "$CLAIM" ]] && continue
    # claim format: claim:session-<pid>-<ts>[-<i>]
    TS=$(echo "$CLAIM" | awk -F- '{print $3}')
    if [[ "$TS" =~ ^[0-9]+$ ]]; then
      AGE=$((NOW_EPOCH - TS))
      if (( AGE > STALE_CLAIM_SEC )); then
        log "stale-claim: releasing $CLAIM on #$N (age=${AGE}s)"
        if (( DRY_RUN == 0 )); then
          gh issue edit "$N" -R "$GH_TASK_REPO" --remove-label "$CLAIM" >/dev/null 2>&1 \
            && RELEASED=$((RELEASED + 1)) \
            || log "WARN: failed to remove $CLAIM on #$N"
        else
          RELEASED=$((RELEASED + 1))
        fi
      fi
    fi
  done <<< "$STALE_PAIRS"
fi
log "stale-sweep: released=$RELEASED"

# ---- Query eligible issues
log "eligibility: querying status:ready + owner:bot"
ELIGIBLE_JSON=$(gh issue list -R "$GH_TASK_REPO" --state open \
  --label status:ready --label owner:bot \
  --json number,title,labels,body \
  --limit 50 2>>"$LOG_FILE" || echo "[]")

# Drop already-claimed issues
UNCLAIMED_JSON=$(echo "$ELIGIBLE_JSON" | jq -c '[.[]
  | select(all(.labels[]; .name | startswith("claim:session-") | not))
]')

# Time-aware weight filter
HOUR=$(date +%H)
HOUR=$((10#$HOUR))
IS_WORK_HOURS=0
(( HOUR >= 9 && HOUR < 22 )) && IS_WORK_HOURS=1

if (( FORCE == 1 )); then
  FILTERED_JSON="$UNCLAIMED_JSON"
  log "filter: --force — no time filter"
elif (( IS_WORK_HOURS == 1 )); then
  # Work hours: pick only issues that have weight:quick (and not heavy).
  FILTERED_JSON=$(echo "$UNCLAIMED_JSON" | jq -c '[.[]
    | select(any(.labels[]; .name == "weight:quick"))
    | select(all(.labels[]; .name != "weight:heavy"))
  ]')
  log "filter: work-hours (hour=$HOUR) — weight:quick only"
else
  FILTERED_JSON="$UNCLAIMED_JSON"
  log "filter: off-hours (hour=$HOUR) — any weight"
fi

COUNT=$(echo "$FILTERED_JSON" | jq 'length')
log "eligible: $COUNT issue(s) after filter"

if (( COUNT == 0 )); then
  log "no eligible tasks — exiting"
  log "=== pickup-auto done ==="
  exit 0
fi

# ---- Per-issue claim + spawn (use process substitution so $SPAWNED persists)
SPAWNED=0
ITER=0
while IFS= read -r issue; do
  ITER=$((ITER + 1))
  N=$(echo "$issue" | jq -r '.number')
  TITLE=$(echo "$issue" | jq -r '.title')
  BODY=$(echo "$issue" | jq -r '.body')
  CLAIM_LABEL="claim:session-$$-$(date +%s)-$ITER"

  log "candidate: #$N ($TITLE)"

  if (( DRY_RUN == 1 )); then
    log "DRY_RUN: would claim #$N with $CLAIM_LABEL, then spawn claude -w auto-issue-$N"
    SPAWNED=$((SPAWNED + 1))
    continue
  fi

  # Atomic claim
  if ! gh issue edit "$N" -R "$GH_TASK_REPO" --add-label "$CLAIM_LABEL" >/dev/null 2>&1; then
    log "WARN: failed to add $CLAIM_LABEL on #$N — skipping"
    continue
  fi

  # Race check: re-fetch, count claim:session-* labels
  CLAIM_COUNT=$(gh issue view "$N" -R "$GH_TASK_REPO" --json labels \
    --jq '[.labels[].name | select(startswith("claim:session-"))] | length' 2>/dev/null || echo "0")

  if [[ "$CLAIM_COUNT" != "1" ]]; then
    log "race-lost: #$N has $CLAIM_COUNT claims — releasing $CLAIM_LABEL"
    gh issue edit "$N" -R "$GH_TASK_REPO" --remove-label "$CLAIM_LABEL" >/dev/null 2>&1 || true
    continue
  fi

  # Promote to in-progress
  if ! gh issue edit "$N" -R "$GH_TASK_REPO" \
      --remove-label status:ready --add-label status:in-progress >/dev/null 2>&1; then
    log "WARN: status transition failed on #$N — continuing anyway"
  fi

  log "claimed: #$N — spawning worker"

  PROMPT=$(cat <<EOF
Execute GitHub issue #$N in $GH_TASK_REPO to completion.

Title: $TITLE

Issue body:
---
$BODY
---

Instructions:
1. Read the issue body carefully. If it references handover docs, plan docs, or vault paths, read those first from the vault.
2. Do the work end-to-end. Use Ralph Loop if iteration is needed.
3. Commit and push changes to the appropriate repo (git pull --rebase before push).
4. Close the issue: gh issue close $N -R $GH_TASK_REPO --reason completed
5. Exit cleanly.

Exit protocol (non-negotiable): commit → push → gh issue close $N --reason completed → exit.

DO NOT invoke /pickup, /status, or any other skill after finishing — exit cleanly.
EOF
)

  SLUG="issue-$N"
  claude -w "auto-$SLUG" \
    --model opus \
    --dangerously-skip-permissions \
    -p "$PROMPT" \
    </dev/null > "/tmp/auto-task-$SLUG.log" 2>&1 &

  log "spawned: auto-$SLUG (pid=$!) log=/tmp/auto-task-$SLUG.log"
  SPAWNED=$((SPAWNED + 1))
done < <(echo "$FILTERED_JSON" | jq -c '.[]')

log "summary: spawned=$SPAWNED of $COUNT eligible"
log "=== pickup-auto done ==="
exit 0
