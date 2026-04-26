#!/usr/bin/env bash
# run-story.sh — Greedy DAG drainer for multi-issue stories.
#
# Usage: run-story.sh <parent-N> [-p PARALLEL]
#
# Reads parent issue body checklist, builds DAG from each child's "Blocked by"
# section, spawns AFK workers (claude -w + /impl) for owner:bot children up to
# parallel cap, surfaces owner:human children via osascript notify (no spawn),
# ticks parent body checklist on each close, closes parent when all children
# done, fires final macOS notification.
#
# Self-detaches via re-exec with --child sentinel. Caller returns immediately.

set -euo pipefail

PARENT="${1:?usage: $0 <parent-N> [-p PARALLEL]}"
shift

PARALLEL=3
HARD_CAP=5
CHILD_MODE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p) PARALLEL="$2"; shift 2 ;;
    --child) CHILD_MODE=true; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

[[ $PARALLEL -gt $HARD_CAP ]] && PARALLEL=$HARD_CAP

LOG_DIR="${HOME}/.local/state/impl-story"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/${PARENT}.log"

# Self-detach on first invocation
if ! $CHILD_MODE; then
  nohup bash "$0" "$PARENT" -p "$PARALLEL" --child >> "$LOG" 2>&1 &
  PID=$!
  echo "Started orchestrator for story #$PARENT (PID $PID, parallel=$PARALLEL)"
  echo "Log: $LOG"
  echo "Tail: tail -f $LOG"
  exit 0
fi

# === Detached child below ===

GH_TASK_REPO=$(grep -oE 'gh_task_repo: [^[:space:]]+' ~/.brain-os/brain-os.config.md 2>/dev/null | awk '{print $2}')
GH_TASK_REPO="${GH_TASK_REPO:-sonthanh/ai-brain}"

log() {
  echo "$(date -Iseconds) | $*"
}

notify() {
  osascript -e "display notification \"$1\" with title \"Brain OS — Story #$PARENT\" sound name \"Glass\"" 2>/dev/null || true
}

log "=== run-story.sh start | parent=#$PARENT parallel=$PARALLEL repo=$GH_TASK_REPO ==="

# Parse parent body checklist
PARENT_BODY=$(gh issue view "$PARENT" -R "$GH_TASK_REPO" --json body --jq .body)

mapfile -t CHILDREN < <(
  echo "$PARENT_BODY" | grep -oE '^- \[[ x]\] #[0-9]+' | grep -oE '[0-9]+'
)

if [[ ${#CHILDREN[@]} -eq 0 ]]; then
  log "ERROR: no checklist children found in parent #$PARENT body"
  notify "Story #$PARENT — no checklist children found, aborting"
  exit 1
fi

log "found ${#CHILDREN[@]} children: ${CHILDREN[*]}"

# Build dependency map
declare -A DEPS_OF       # child → "blocker1 blocker2"
declare -A WAITERS_ON    # blocker → "waiter1 waiter2"
declare -A OWNER_OF      # child → "bot|human"
declare -A TITLE_OF      # child → "<title>"
declare -A STATE_OF      # child → "OPEN|CLOSED"

for child in "${CHILDREN[@]}"; do
  body=$(gh issue view "$child" -R "$GH_TASK_REPO" --json body,labels,title,state)
  TITLE_OF[$child]=$(jq -r .title <<<"$body")
  STATE_OF[$child]=$(jq -r .state <<<"$body")
  OWNER_OF[$child]=$(jq -r '.labels[].name' <<<"$body" | grep -oE 'owner:(bot|human)' | head -1 | cut -d: -f2)
  OWNER_OF[$child]="${OWNER_OF[$child]:-bot}"

  # Parse Blocked by section: lines like "- ai-brain#147" inside "## Blocked by" section
  blocked_section=$(jq -r .body <<<"$body" | awk '/^## Blocked by/{f=1;next} /^## /{f=0} f' || true)
  blockers=$(echo "$blocked_section" | grep -oE 'ai-brain#[0-9]+' | grep -oE '[0-9]+' | sort -u | tr '\n' ' ')

  filtered=""
  for b in $blockers; do
    [[ "$b" == "$PARENT" ]] && continue
    filtered+="$b "
  done
  DEPS_OF[$child]="${filtered% }"

  for b in ${DEPS_OF[$child]}; do
    WAITERS_ON[$b]="${WAITERS_ON[$b]:-} $child"
  done

  log "child #$child owner=${OWNER_OF[$child]} state=${STATE_OF[$child]} deps=[${DEPS_OF[$child]}] title=\"${TITLE_OF[$child]}\""
done

# Initial ready queue: children with all deps closed AND not yet closed themselves
READY=()
for child in "${CHILDREN[@]}"; do
  [[ "${STATE_OF[$child]}" == "CLOSED" ]] && continue
  ready=true
  for dep in ${DEPS_OF[$child]}; do
    dep_state=$(gh issue view "$dep" -R "$GH_TASK_REPO" --json state --jq .state 2>/dev/null || echo "OPEN")
    if [[ "$dep_state" != "CLOSED" ]]; then
      ready=false; break
    fi
  done
  $ready && READY+=("$child")
done

log "initial ready: ${READY[*]:-<empty>}"

# Watching set: child → "afk:PID" or "hitl"
declare -A WATCHING

afk_count() {
  local count=0
  for c in "${!WATCHING[@]}"; do
    [[ "${WATCHING[$c]}" == "afk:"* ]] && count=$((count + 1))
  done
  echo $count
}

tick_parent() {
  local child=$1
  log "ticking #$child in parent #$PARENT"
  local body new_body
  body=$(gh issue view "$PARENT" -R "$GH_TASK_REPO" --json body --jq .body)
  new_body=$(echo "$body" | sed -E "s/^- \[ \] #${child} /- [x] #${child} /")
  gh issue edit "$PARENT" -R "$GH_TASK_REPO" --body "$new_body" >/dev/null
}

spawn_or_watch() {
  local child=$1
  local owner="${OWNER_OF[$child]:-bot}"

  if [[ "$owner" == "human" ]]; then
    log "HITL: #$child — ${TITLE_OF[$child]}"
    notify "HITL: #$child needs human. Run: cr /pickup $child"
    WATCHING[$child]="hitl"
  else
    log "spawning AFK worker for #$child"
    local worker_log="$LOG_DIR/${PARENT}-worker-${child}.log"
    (
      claude -w "story-${PARENT}-issue-${child}" --dangerously-skip-permissions \
        -p "/impl $child" >> "$worker_log" 2>&1
    ) &
    WATCHING[$child]="afk:$!"
  fi
}

# Greedy drainer
while [[ ${#READY[@]} -gt 0 ]] || [[ ${#WATCHING[@]} -gt 0 ]]; do
  # Top up: HITL anytime, AFK within cap
  i=0
  while [[ $i -lt ${#READY[@]} ]]; do
    next="${READY[$i]}"
    owner="${OWNER_OF[$next]}"
    if [[ "$owner" == "human" ]]; then
      READY=("${READY[@]:0:$i}" "${READY[@]:$((i+1))}")
      spawn_or_watch "$next"
    elif [[ $(afk_count) -lt $PARALLEL ]]; then
      READY=("${READY[@]:0:$i}" "${READY[@]:$((i+1))}")
      spawn_or_watch "$next"
    else
      i=$((i + 1))
    fi
  done

  sleep 30

  # Poll closure
  for child in "${!WATCHING[@]}"; do
    state=$(gh issue view "$child" -R "$GH_TASK_REPO" --json state --jq .state 2>/dev/null || echo "ERROR")
    if [[ "$state" == "CLOSED" ]]; then
      log "child #$child closed (${WATCHING[$child]})"
      unset 'WATCHING[$child]'
      tick_parent "$child"

      # Promote waiters
      for waiter in ${WAITERS_ON[$child]:-}; do
        # Skip if already running, queued, or closed
        [[ -n "${WATCHING[$waiter]:-}" ]] && continue
        [[ " ${READY[*]} " == *" $waiter "* ]] && continue
        waiter_state=$(gh issue view "$waiter" -R "$GH_TASK_REPO" --json state --jq .state 2>/dev/null || echo "OPEN")
        [[ "$waiter_state" == "CLOSED" ]] && continue

        # Check all deps closed
        all_closed=true
        for dep in ${DEPS_OF[$waiter]}; do
          dep_state=$(gh issue view "$dep" -R "$GH_TASK_REPO" --json state --jq .state)
          [[ "$dep_state" != "CLOSED" ]] && { all_closed=false; break; }
        done

        if $all_closed; then
          log "promoting #$waiter (deps cleared)"
          READY+=("$waiter")
        fi
      done
    fi
  done
done

# Close parent
parent_state=$(gh issue view "$PARENT" -R "$GH_TASK_REPO" --json state --jq .state)
if [[ "$parent_state" != "CLOSED" ]]; then
  log "all children resolved — closing parent #$PARENT"
  gh issue close "$PARENT" -R "$GH_TASK_REPO" --reason completed >/dev/null
fi

notify "Story #$PARENT complete. Run: cr /story-debrief $PARENT for review"
log "=== run-story.sh DONE ==="
