#!/usr/bin/env bash
# Render /status briefing to ~/.cache/brain-os/status.md. Pure bash, no LLM.
#
# Usage:
#   render-status.sh             Force regenerate (for /status -f)
#   render-status.sh --if-stale  Regen only when stale; exit 0 if cache fresh
#
# Staleness: cache missing/empty | ~/.cache/brain-os/status.dirty present |
#            any watched source mtime > cache mtime | cache-date header != today.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../hooks/resolve-vault.sh"

CACHE_DIR="${HOME}/.cache/brain-os"
CACHE_FILE="${CACHE_DIR}/status.md"
DIRTY_MARKER="${CACHE_DIR}/status.dirty"
TODAY=$(date +%Y-%m-%d)
TIMESTAMP=$(date +"%Y-%m-%d %H:%M")

mkdir -p "$CACHE_DIR"

IF_STALE=false
for arg in "$@"; do
  [ "$arg" = "--if-stale" ] && IF_STALE=true
done

# --- Staleness decision --------------------------------------------------
watched_sources() {
  cat <<EOF
$VAULT_PATH/business/intelligence/emails/sla-open.md
$VAULT_PATH/business/intelligence/emails/${TODAY}-daily-summary.md
$VAULT_PATH/business/intelligence/emails/${TODAY}-needs-reply.md
$HOME/work/ai-leaders-vietnam/content-ideas.md
$VAULT_PATH/context/strategy.md
$VAULT_PATH/context/goals.md
EOF
  find "$VAULT_PATH/knowledge/research/reports" -maxdepth 1 -name '*-ai-engineer-weekly.md' -type f 2>/dev/null | sort -r | head -1
  find "$VAULT_PATH/knowledge/research/reports" -maxdepth 1 -name '*-ai-engineer-daily.md' -type f 2>/dev/null | sort -r | head -1
}

should_regen() {
  [ ! -s "$CACHE_FILE" ] && return 0
  [ -f "$DIRTY_MARKER" ] && return 0

  local cache_date
  cache_date=$(grep -m1 '<!-- cache-date: ' "$CACHE_FILE" 2>/dev/null | sed 's/.*cache-date: //; s/ -->.*//')
  [ "$cache_date" != "$TODAY" ] && return 0

  local cache_mtime now age
  cache_mtime=$(stat -f %m "$CACHE_FILE" 2>/dev/null || echo 0)

  # Max-age safety net: GH mutations outside Claude Code (cron, launchd,
  # external terminal) bypass the dirty marker and leave no file mtime.
  # Force regen if cache is older than MAX_AGE_SECONDS to cap drift.
  now=$(date +%s)
  age=$((now - cache_mtime))
  [ "$age" -gt "${STATUS_CACHE_MAX_AGE:-1800}" ] && return 0

  local src src_mtime
  while IFS= read -r src; do
    [ -z "$src" ] && continue
    [ ! -f "$src" ] && continue
    src_mtime=$(stat -f %m "$src" 2>/dev/null || echo 0)
    [ "$src_mtime" -gt "$cache_mtime" ] && return 0
  done < <(watched_sources)

  return 1
}

if $IF_STALE && ! should_regen; then
  exit 0
fi

# CRITICAL race-fix: clear dirty marker BEFORE reading sources. If a mutation
# touches the marker during regen, the next /status run catches it.
rm -f "$DIRTY_MARKER"

TMP_FILE=$(mktemp "${CACHE_DIR}/status.XXXXXX")
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_FILE" "$TMP_DIR"' EXIT

{
  echo "<!-- cache-date: ${TODAY} -->"
  echo "<!-- generated: ${TIMESTAMP} -->"
  echo ""
  echo "## Status — ${TIMESTAMP}"
  echo ""
} > "$TMP_FILE"

# --- GH queries (parallel) -----------------------------------------------
GH_AVAILABLE=false
if [ -n "${GH_TASK_REPO:-}" ] && command -v gh >/dev/null 2>&1; then
  GH_AVAILABLE=true

  gh issue list -R "$GH_TASK_REPO" --state open --label type:handover \
    --limit 50 --json number,title,body > "$TMP_DIR/handovers.json" 2>/dev/null &
  gh issue list -R "$GH_TASK_REPO" --state open --label status:in-progress \
    --limit 50 --json number,title,labels > "$TMP_DIR/in-progress.json" 2>/dev/null &
  gh issue list -R "$GH_TASK_REPO" --state open --label status:ready \
    --limit 50 --json number,title,labels > "$TMP_DIR/ready.json" 2>/dev/null &
  gh issue list -R "$GH_TASK_REPO" --state open --label status:blocked \
    --limit 50 --json number,title,labels > "$TMP_DIR/blocked.json" 2>/dev/null &
  gh issue list -R "$GH_TASK_REPO" --state open --label status:backlog \
    --limit 200 --json number --jq 'length' > "$TMP_DIR/backlog.txt" 2>/dev/null &
  wait
fi

json_count() {
  local file="$1"
  [ ! -s "$file" ] && echo 0 && return
  jq -r 'length' "$file" 2>/dev/null || echo 0
}

format_issues() {
  local file="$1"
  [ ! -s "$file" ] && return
  jq -r '.[] |
    ((.labels // []) | map(.name) | map(select(startswith("priority:"))) | (.[0] // "")) as $raw_pri |
    ($raw_pri | sub("priority:"; "") | ascii_upcase) as $pri |
    "- #\(.number) — \(if $pri != "" then "[\($pri)] " else "" end)\(.title)"' "$file" 2>/dev/null
}

# --- Pending Handovers ---------------------------------------------------
if $GH_AVAILABLE; then
  H_COUNT=$(json_count "$TMP_DIR/handovers.json")
  if [ "$H_COUNT" -gt 0 ]; then
    echo "### Pending Handovers" >> "$TMP_FILE"
    jq -r '.[] | "- #\(.number) — \(.title)"' "$TMP_DIR/handovers.json" >> "$TMP_FILE" 2>/dev/null
    echo "" >> "$TMP_FILE"
  fi
fi

# --- Tasks ---------------------------------------------------------------
echo "### Tasks" >> "$TMP_FILE"
if $GH_AVAILABLE; then
  R_COUNT=$(json_count "$TMP_DIR/ready.json")
  IP_COUNT=$(json_count "$TMP_DIR/in-progress.json")
  B_COUNT=$(json_count "$TMP_DIR/blocked.json")
  BACKLOG=$(tr -d '[:space:]' < "$TMP_DIR/backlog.txt" 2>/dev/null)
  case "$BACKLOG" in ''|*[!0-9]*) BACKLOG=0 ;; esac

  {
    echo "**Ready ($R_COUNT)**"
    [ "$R_COUNT" -gt 0 ] && format_issues "$TMP_DIR/ready.json"
    echo ""
    echo "**In Progress ($IP_COUNT)**"
    [ "$IP_COUNT" -gt 0 ] && format_issues "$TMP_DIR/in-progress.json"
  } >> "$TMP_FILE"

  if [ "$B_COUNT" -gt 0 ]; then
    {
      echo ""
      echo "**Blocked ($B_COUNT)**"
      format_issues "$TMP_DIR/blocked.json"
    } >> "$TMP_FILE"
  fi

  {
    echo ""
    echo "**Backlog: $BACKLOG items** (expand on request)"
    echo ""
  } >> "$TMP_FILE"
else
  echo "_GH unavailable — tasks skipped._" >> "$TMP_FILE"
  echo "" >> "$TMP_FILE"
fi

# --- Content Ideas -------------------------------------------------------
CONTENT_IDEAS="$HOME/work/ai-leaders-vietnam/content-ideas.md"
if [ -f "$CONTENT_IDEAS" ]; then
  count_col() {
    awk -v col="## $1" '
      $0 == col { in_col=1; next }
      /^## / && in_col { in_col=0 }
      in_col && /^- \[/ { n++ }
      END { print n+0 }
    ' "$CONTENT_IDEAS"
  }
  list_col() {
    awk -v col="## $1" '
      $0 == col { in_col=1; next }
      /^## / && in_col { in_col=0 }
      in_col && /^- \[/ {
        line=$0
        sub(/^- \[.\] */, "", line)
        sub(/ *—? *\[\[[^\]]*\]\].*$/, "", line)
        print "  - " line
      }
    ' "$CONTENT_IDEAS"
  }
  NEXT_UP=$(count_col "Next Up")
  WRITING=$(count_col "Writing")
  if [ "$((NEXT_UP + WRITING))" -gt 0 ]; then
    {
      echo "### Content"
      echo "- $NEXT_UP ideas ready, $WRITING in writing"
      if [ "$WRITING" -gt 0 ]; then
        echo ""
        echo "**Writing:**"
        list_col "Writing"
      fi
      echo ""
    } >> "$TMP_FILE"
  fi
fi

# --- Email summary -------------------------------------------------------
EMAIL_DIR="$VAULT_PATH/business/intelligence/emails"
SUMMARY_FILE="$EMAIL_DIR/${TODAY}-daily-summary.md"
NEEDS_REPLY_FILE="$EMAIL_DIR/${TODAY}-needs-reply.md"

if [ -f "$SUMMARY_FILE" ] || [ -f "$NEEDS_REPLY_FILE" ]; then
  echo "### Email" >> "$TMP_FILE"
  if [ -f "$SUMMARY_FILE" ]; then
    NR_FROM_SUMMARY=$(grep -oE '\*\*Needs reply:\*\* *[0-9]+' "$SUMMARY_FILE" | head -1 | grep -oE '[0-9]+')
    [ -n "$NR_FROM_SUMMARY" ] && echo "- $NR_FROM_SUMMARY needs reply today" >> "$TMP_FILE"
    # Extract first substantive bullet under "## Key Signals"
    KEY=$(awk '
      /^## Key Signals/ { in_sec=1; next }
      /^## / && in_sec { exit }
      in_sec && /^- / {
        sub(/^- */, "")
        print
        exit
      }
    ' "$SUMMARY_FILE")
    [ -n "$KEY" ] && echo "- Key: $KEY" >> "$TMP_FILE"
  fi
  echo "" >> "$TMP_FILE"
fi

# --- SLA ledger ----------------------------------------------------------
# Parse sla-open.md markdown tables. Column layout (ai-brain#100 Phase 2):
# | Tier | Owner | From | To | Subject | MsgID | Received | Breach At | Overdue/Remaining | Status | Category |
# After awk "|" split, fields are: f[1]="" f[2]=tier f[3]=owner f[4]=from
# f[5]=to f[6]=subject f[7]=msgid f[8]=received f[9]=breach f[10]=overdue f[11]=status f[12]=category f[13]=""
# We emit 6 pipe-delimited fields downstream: tier|owner|from|subject|overdue|category
# Legacy rows without Category (pre-Phase-2) produce an empty 6th field — the
# Email Focus filter shows them under an "uncategorized" bucket so nothing is
# silently dropped.
SLA_FILE="$EMAIL_DIR/sla-open.md"
echo "### SLA" >> "$TMP_FILE"
BREACHED_RAW=""
OPEN_RAW=""
if [ -f "$SLA_FILE" ]; then
  parse_section() {
    awk -v sec="## $1" -F'|' '
      $0 == sec { in_sec=1; next }
      /^## / && in_sec { exit }
      in_sec && /^\| / && !/^\| *Tier/ && !/---/ {
        for (i=1; i<=NF; i++) { gsub(/^ +| +$/, "", $i) }
        if ($2 != "" && $3 != "") print $2 "|" $3 "|" $4 "|" $6 "|" $10 "|" $12
      }
    ' "$SLA_FILE"
  }
  BREACHED_RAW=$(parse_section "Breached")
  OPEN_RAW=$(parse_section "Open (within SLA)")

  count_rows() { [ -z "$1" ] && echo 0 || echo "$1" | awk 'NF>0{n++} END{print n+0}'; }
  B_TOTAL=$(count_rows "$BREACHED_RAW")
  O_TOTAL=$(count_rows "$OPEN_RAW")

  if [ "$B_TOTAL" -eq 0 ] && [ "$O_TOTAL" -eq 0 ]; then
    echo "All clear — no open items." >> "$TMP_FILE"
  else
    # mine = user_category=r-user (user owes reply)
    # team = user_category=team-sla-at-risk (team owes reply, user awareness)
    # aware = user_category=awareness (info only, counted separately)
    b_mine=$(echo "$BREACHED_RAW" | awk -F'|' '$6=="r-user"{n++} END{print n+0}')
    b_team=$(echo "$BREACHED_RAW" | awk -F'|' '$6=="team-sla-at-risk"{n++} END{print n+0}')
    b_aware=$(echo "$BREACHED_RAW" | awk -F'|' '$6=="awareness"{n++} END{print n+0}')
    b_uncat=$(echo "$BREACHED_RAW" | awk -F'|' 'NF>=5 && ($6=="" || $6==$5){n++} END{print n+0}')
    echo "$B_TOTAL breached ($b_mine mine / $b_team team / $b_aware awareness) + $O_TOTAL open" >> "$TMP_FILE"
    [ "$b_uncat" -gt 0 ] && echo "⚠️ $b_uncat breached row(s) missing Category — run migration to refresh." >> "$TMP_FILE"

    if [ "$B_TOTAL" -gt 0 ]; then
      echo "Top breaches:" >> "$TMP_FILE"
      # Rank breached rows for "Top breaches": r-user first, then team-sla-at-risk,
      # then others. Within category, preserve ledger order (fast→normal→slow).
      echo "$BREACHED_RAW" | awk -F'|' '
        BEGIN { catp["r-user"]=1; catp["team-sla-at-risk"]=2; catp["awareness"]=3 }
        NF>=5 { p = (catp[$6] ? catp[$6] : 9); print p "\t" $0 }
      ' | sort -k1,1n | head -3 | while IFS=$'\t' read -r _ row; do
        IFS='|' read -r tier owner from subj overdue category <<<"$row"
        icon="🟡"
        [ "$tier" = "normal" ] && icon="🟠"
        [ "$tier" = "fast" ] && icon="🔴"
        sender=$(echo "$from" | sed 's/ *<.*//' | cut -c1-40)
        subj_short=$(echo "$subj" | tr -d '"' | cut -c1-60)
        over=$(echo "$overdue" | sed 's/ *⚠️//g; s/^ *//; s/ *$//')
        cat_tag=""
        [ -n "$category" ] && cat_tag=" [$category]"
        echo "- $icon $tier — $sender → $owner — \"$subj_short\" — $over overdue$cat_tag" >> "$TMP_FILE"
      done
    fi
    echo "→ Full ledger: [[business/intelligence/emails/sla-open]]" >> "$TMP_FILE"
  fi
else
  echo "All clear (no ledger)" >> "$TMP_FILE"
fi
echo "" >> "$TMP_FILE"

# --- Cron (last 24h) -----------------------------------------------------
# Surface what local launchd jobs have been doing. Especially pickup-auto,
# which can claim+spawn auto-worker sessions in the background.
CRON_CUTOFF=$(date -u -v-24H +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)
CRON_LINES=""

# auto-journal — detect via latest YYYY-MM-DD.log in journal logs dir
JOURNAL_LOG_DIR="$VAULT_PATH/daily/journal/logs"
if [ -d "$JOURNAL_LOG_DIR" ]; then
  AJ_LATEST_LOG=$(find "$JOURNAL_LOG_DIR" -maxdepth 1 -name '????-??-??.log' -type f 2>/dev/null | sort -r | head -1)
  if [ -n "$AJ_LATEST_LOG" ]; then
    AJ_TARGET=$(basename "$AJ_LATEST_LOG" .log)
    if grep -q "Journal completed successfully" "$AJ_LATEST_LOG" 2>/dev/null; then
      AJ_LINE="**auto-journal** (daily 08:00) — ✅ wrote $AJ_TARGET"
    elif grep -q "SKIP — weekly usage" "$AJ_LATEST_LOG" 2>/dev/null; then
      AJ_LINE="**auto-journal** (daily 08:00) — ⏭️ $AJ_TARGET skipped (quota)"
    elif grep -q "All .* attempts failed" "$AJ_LATEST_LOG" 2>/dev/null; then
      REASON=""
      grep -q "hit your limit" "$AJ_LATEST_LOG" 2>/dev/null && REASON=" quota exhausted"
      AJ_LINE="**auto-journal** (daily 08:00) — ❌ $AJ_TARGET failed${REASON}"
    else
      AJ_LINE="**auto-journal** (daily 08:00) — ⚠️ $AJ_TARGET status unclear"
    fi
    CRON_LINES="${CRON_LINES}${AJ_LINE}
"
  fi
fi

# pickup-auto — parse cron.log for last-24h ticks / claims / spawns
PICKUP_LOG="$HOME/.local/state/pickup-auto/cron.log"
if [ -f "$PICKUP_LOG" ] && [ -n "$CRON_CUTOFF" ]; then
  PU_RECENT=$(awk -v cutoff="$CRON_CUTOFF" '
    /^\[/ {
      ts = substr($1, 2, length($1) - 2)
      if (ts >= cutoff) print
    }
  ' "$PICKUP_LOG")
  PU_TICKS=$(printf '%s\n' "$PU_RECENT" | grep -c "=== pickup-auto tick" || true)
  PU_SKIPS=$(printf '%s\n' "$PU_RECENT" | grep -c "SKIP — weekly usage" || true)
  PU_PROCEEDS=$(printf '%s\n' "$PU_RECENT" | grep -c "PROCEED — weekly usage" || true)
  PU_CLAIMS=$(printf '%s\n' "$PU_RECENT" | grep -c "\] claimed:" || true)
  PU_SPAWNS=$(printf '%s\n' "$PU_RECENT" | grep -c "\] spawned:" || true)
  # Force-numeric (grep -c can print empty in some edge cases under set -u)
  : "${PU_TICKS:=0}"; : "${PU_SKIPS:=0}"; : "${PU_PROCEEDS:=0}"; : "${PU_CLAIMS:=0}"; : "${PU_SPAWNS:=0}"
  if [ "$PU_TICKS" -gt 0 ]; then
    PU_ICON="✅"
    [ "$PU_PROCEEDS" -eq 0 ] && PU_ICON="⏭️"
    PU_DETAIL="${PU_TICKS} ticks · ${PU_PROCEEDS} proceed / ${PU_SKIPS} skip · ${PU_CLAIMS} claimed, ${PU_SPAWNS} spawned"
    if [ "$PU_SPAWNS" -gt 0 ]; then
      PU_ISSUES=$(printf '%s\n' "$PU_RECENT" | grep "\] spawned:" | grep -oE "auto-issue-[0-9]+" | sort -u | sed 's/auto-issue-/#/' | tr '\n' ' ' | sed 's/ $//')
      [ -n "$PU_ISSUES" ] && PU_DETAIL="${PU_DETAIL}: ${PU_ISSUES}"
    fi
    CRON_LINES="${CRON_LINES}**pickup-auto** (every 2h) — ${PU_ICON} ${PU_DETAIL}
"
  fi
fi

# clean-temp-git-cache — parse log for tick count + total cleaned
CTGC_LOG="$HOME/.local/state/clean-temp-git-cache.log"
if [ -f "$CTGC_LOG" ] && [ -n "$CRON_CUTOFF" ]; then
  CTGC_RECENT=$(awk -v cutoff="$CRON_CUTOFF" '
    /^\[/ {
      ts = substr($1, 2, length($1) - 2)
      if (ts >= cutoff) print
    }
  ' "$CTGC_LOG")
  CTGC_TICKS=$(printf '%s\n' "$CTGC_RECENT" | grep -c "cleaned=" || true)
  CTGC_TOTAL=$(printf '%s\n' "$CTGC_RECENT" | grep -oE "cleaned=[0-9]+" | awk -F= '{sum+=$2} END {print sum+0}')
  : "${CTGC_TICKS:=0}"; : "${CTGC_TOTAL:=0}"
  if [ "$CTGC_TICKS" -gt 0 ]; then
    CRON_LINES="${CRON_LINES}**clean-temp-git-cache** (every 30m) — ✅ ${CTGC_TICKS} ticks · ${CTGC_TOTAL} cleaned
"
  fi
fi

# vault-lint — parse cron.log for last-24h ticks / decision / completion
VL_LOG="$HOME/.local/state/vault-lint/cron.log"
if [ -f "$VL_LOG" ] && [ -n "$CRON_CUTOFF" ]; then
  VL_RECENT=$(awk -v cutoff="$CRON_CUTOFF" '
    /^\[/ {
      ts = substr($1, 2, length($1) - 2)
      if (ts >= cutoff) print
    }
  ' "$VL_LOG")
  VL_TICKS=$(printf '%s\n' "$VL_RECENT" | grep -c "=== vault-lint tick" || true)
  VL_SKIPS=$(printf '%s\n' "$VL_RECENT" | grep -c "SKIP — weekly usage" || true)
  VL_PROCEEDS=$(printf '%s\n' "$VL_RECENT" | grep -c "PROCEED — weekly usage" || true)
  VL_OK=$(printf '%s\n' "$VL_RECENT" | grep -c "vault-lint completed successfully" || true)
  VL_FAIL=$(printf '%s\n' "$VL_RECENT" | grep -c "vault-lint failed" || true)
  : "${VL_TICKS:=0}"; : "${VL_SKIPS:=0}"; : "${VL_PROCEEDS:=0}"; : "${VL_OK:=0}"; : "${VL_FAIL:=0}"
  if [ "$VL_TICKS" -gt 0 ]; then
    if [ "$VL_FAIL" -gt 0 ]; then
      VL_ICON="❌"
    elif [ "$VL_OK" -gt 0 ]; then
      VL_ICON="✅"
    elif [ "$VL_SKIPS" -gt 0 ] && [ "$VL_PROCEEDS" -eq 0 ]; then
      VL_ICON="⏭️"
    else
      VL_ICON="⚠️"
    fi
    VL_DETAIL="${VL_TICKS} ticks · ${VL_PROCEEDS} proceed / ${VL_SKIPS} skip · ${VL_OK} ok / ${VL_FAIL} fail"
    CRON_LINES="${CRON_LINES}**vault-lint** (daily 03:00) — ${VL_ICON} ${VL_DETAIL}
"
  fi
fi

# improve — parse cron.log for last-24h ticks / decision / completion
IMP_LOG="$HOME/.local/state/improve/cron.log"
if [ -f "$IMP_LOG" ] && [ -n "$CRON_CUTOFF" ]; then
  IMP_RECENT=$(awk -v cutoff="$CRON_CUTOFF" '
    /^\[/ {
      ts = substr($1, 2, length($1) - 2)
      if (ts >= cutoff) print
    }
  ' "$IMP_LOG")
  IMP_TICKS=$(printf '%s\n' "$IMP_RECENT" | grep -c "=== improve tick" || true)
  IMP_SKIPS=$(printf '%s\n' "$IMP_RECENT" | grep -c "SKIP — weekly usage" || true)
  IMP_PROCEEDS=$(printf '%s\n' "$IMP_RECENT" | grep -c "PROCEED — weekly usage" || true)
  IMP_OK=$(printf '%s\n' "$IMP_RECENT" | grep -c "improve completed successfully" || true)
  IMP_FAIL=$(printf '%s\n' "$IMP_RECENT" | grep -c "improve failed" || true)
  : "${IMP_TICKS:=0}"; : "${IMP_SKIPS:=0}"; : "${IMP_PROCEEDS:=0}"; : "${IMP_OK:=0}"; : "${IMP_FAIL:=0}"
  if [ "$IMP_TICKS" -gt 0 ]; then
    if [ "$IMP_FAIL" -gt 0 ]; then
      IMP_ICON="❌"
    elif [ "$IMP_OK" -gt 0 ]; then
      IMP_ICON="✅"
    elif [ "$IMP_SKIPS" -gt 0 ] && [ "$IMP_PROCEEDS" -eq 0 ]; then
      IMP_ICON="⏭️"
    else
      IMP_ICON="⚠️"
    fi
    IMP_DETAIL="${IMP_TICKS} ticks · ${IMP_PROCEEDS} proceed / ${IMP_SKIPS} skip · ${IMP_OK} ok / ${IMP_FAIL} fail"
    CRON_LINES="${CRON_LINES}**improve** (Sun 04:00) — ${IMP_ICON} ${IMP_DETAIL}
"
  fi
fi

if [ -n "$CRON_LINES" ]; then
  {
    echo "### Cron (last 24h)"
    printf '%s' "$CRON_LINES"
    echo ""
  } >> "$TMP_FILE"
fi

# --- Research Signal (≤8 days old) --------------------------------------
latest_report=$(find "$VAULT_PATH/knowledge/research/reports" -maxdepth 1 -name '*-ai-engineer-weekly.md' -type f 2>/dev/null | sort -r | head -1)
if [ -z "$latest_report" ]; then
  latest_report=$(find "$VAULT_PATH/knowledge/research/reports" -maxdepth 1 -name '*-ai-engineer-daily.md' -type f 2>/dev/null | sort -r | head -1)
fi
if [ -n "$latest_report" ]; then
  report_date=$(basename "$latest_report" | sed -E 's/-ai-engineer-(weekly|daily)\.md$//')
  epoch_report=$(date -j -f "%Y-%m-%d" "$report_date" +%s 2>/dev/null || echo 0)
  epoch_now=$(date +%s)
  if [ "$epoch_report" -gt 0 ] && [ $((epoch_now - epoch_report)) -lt $((8 * 86400)) ]; then
    APPLICABILITY=$(awk '
      /^## Brain-os applicability/ { in_sec=1; next }
      /^## / && in_sec { exit }
      in_sec && /^- / { print }
    ' "$latest_report")
    if [ -n "$APPLICABILITY" ]; then
      {
        echo "### Research Signal ($report_date)"
        echo "$APPLICABILITY"
        rel_path=${latest_report#$VAULT_PATH/}
        wiki_path=${rel_path%.md}
        echo "→ Full report: [[${wiki_path}]]"
        echo ""
      } >> "$TMP_FILE"
    fi
  fi
fi

# --- Email Focus (Category filter — Phase 2 ai-brain#100) ----------------
# Replaces the old me-personal/me-business owner-bucket filter with
# user_category-based filtering per the dual-perspective taxonomy. Rank:
#   1. r-user (user must reply) → always shown
#   2. team-sla-at-risk + breached (team missing SLA, surface for CEO awareness)
#   3. team-sla-at-risk + open (team responsible but SLA not yet breached)
# Awareness items are counted in the header but not listed inline — they
# clutter the focus list. Noise items never enter the ledger.
echo "### Email Focus" >> "$TMP_FILE"
if [ -f "$SLA_FILE" ] && { [ -n "$BREACHED_RAW" ] || [ -n "$OPEN_RAW" ]; }; then
  # Combine breached (flag as B) + open (flag as O) so we can prefer breached.
  FOCUS_RANKED=$(
    {
      printf '%s\n' "$BREACHED_RAW" | awk -F'|' 'NF>=5{print "B|" $0}'
      printf '%s\n' "$OPEN_RAW"     | awk -F'|' 'NF>=5{print "O|" $0}'
    } | awk -F'|' '
      BEGIN {
        # Priority: lower wins
        # r-user  breached → 1   r-user  open → 2
        # team-SLA breached → 3   team-SLA open → 4 (only if fast/normal)
        # All others excluded.
      }
      {
        state=$1; tier=$2; owner=$3; from=$4; subj=$5; overdue=$6; cat=$7
        if (cat == "r-user")            p = (state == "B" ? 1 : 2)
        else if (cat == "team-sla-at-risk") {
          if (state == "B")              p = 3
          else if (tier == "fast" || tier == "normal") p = 4
          else                            next   # slow team-sla-at-risk + open = too quiet
        }
        else next  # awareness + noise + uncategorized excluded from focus list
        print p "\t" state "\t" tier "\t" owner "\t" from "\t" subj "\t" overdue "\t" cat
      }
    ' | sort -k1,1n | head -5
  )
  if [ -n "$FOCUS_RANKED" ]; then
    echo "$FOCUS_RANKED" | while IFS=$'\t' read -r _ state tier owner from subj overdue cat; do
      sender=$(echo "$from" | sed 's/ *<.*//' | cut -c1-35)
      subj_short=$(echo "$subj" | tr -d '"' | cut -c1-55)
      over=$(echo "$overdue" | sed 's/ *⚠️//g; s/^ *//; s/ *$//')
      case "$cat" in
        r-user)            prefix="⭐ r-user" ;;
        team-sla-at-risk)  prefix="🟡 team" ;;
        *)                 prefix="? $cat" ;;
      esac
      case "$state" in
        B) state_tag="breached, $over overdue" ;;
        *) state_tag="open, $over" ;;
      esac
      echo "- $prefix ($tier/$owner) — $sender — \"$subj_short\" — $state_tag" >> "$TMP_FILE"
    done
    # Awareness summary line (header-only signal)
    aware_total=$(
      {
        printf '%s\n' "$BREACHED_RAW" | awk -F'|' '$6=="awareness"{n++} END{print n+0}'
        printf '%s\n' "$OPEN_RAW" | awk -F'|' '$6=="awareness"{n++} END{print n+0}'
      } | awk '{s+=$1} END{print s+0}'
    )
    [ "$aware_total" -gt 0 ] && echo "_+ $aware_total awareness item(s) — glance via full ledger._" >> "$TMP_FILE"
  else
    echo "All clear — no r-user or team-SLA-at-risk items." >> "$TMP_FILE"
  fi
else
  echo "All clear." >> "$TMP_FILE"
fi
echo "" >> "$TMP_FILE"

# --- Atomic publish ------------------------------------------------------
mv "$TMP_FILE" "$CACHE_FILE"
trap - EXIT
rm -rf "$TMP_DIR"

echo "status cache regenerated: $CACHE_FILE" >&2
