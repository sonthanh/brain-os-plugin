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
# Parse sla-open.md markdown tables. Column layout:
# | Tier | Owner | From | To | Subject | MsgID | Received | Breach At | Overdue/Remaining | Status |
# After awk "|" split, fields are: f[1]="" f[2]=tier f[3]=owner f[4]=from
# f[5]=to f[6]=subject f[7]=msgid f[8]=received f[9]=breach f[10]=overdue f[11]=status f[12]=""
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
        if ($2 != "" && $3 != "") print $2 "|" $3 "|" $4 "|" $6 "|" $10
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
    b_fast=$(echo "$BREACHED_RAW" | awk -F'|' '$1=="fast"{n++} END{print n+0}')
    b_norm=$(echo "$BREACHED_RAW" | awk -F'|' '$1=="normal"{n++} END{print n+0}')
    b_slow=$(echo "$BREACHED_RAW" | awk -F'|' '$1=="slow"{n++} END{print n+0}')
    echo "$B_TOTAL breached / $O_TOTAL open total — fast: $b_fast, normal: $b_norm, slow: $b_slow" >> "$TMP_FILE"

    OWNER_LINE=$(printf '%s\n%s\n' "$BREACHED_RAW" "$OPEN_RAW" \
      | awk -F'|' 'NF>=2 && $2 != "" { c[$2]++ } END {
          out=""
          for (o in c) out = out o " " c[o] ", "
          sub(/, $/, "", out)
          print out
        }')
    [ -n "$OWNER_LINE" ] && echo "By owner: $OWNER_LINE" >> "$TMP_FILE"

    if [ "$B_TOTAL" -gt 0 ]; then
      echo "Top breaches:" >> "$TMP_FILE"
      echo "$BREACHED_RAW" | head -3 | while IFS='|' read -r tier owner from subj overdue; do
        icon="🟡"
        [ "$tier" = "normal" ] && icon="🟠"
        [ "$tier" = "fast" ] && icon="🔴"
        sender=$(echo "$from" | sed 's/ *<.*//' | cut -c1-40)
        subj_short=$(echo "$subj" | tr -d '"' | cut -c1-60)
        over=$(echo "$overdue" | sed 's/ *⚠️//g; s/^ *//; s/ *$//')
        echo "- $icon $tier — $sender → $owner — \"$subj_short\" — $over overdue" >> "$TMP_FILE"
      done
    fi
    echo "→ Full ledger: [[business/intelligence/emails/sla-open]]" >> "$TMP_FILE"
  fi
else
  echo "All clear (no ledger)" >> "$TMP_FILE"
fi
echo "" >> "$TMP_FILE"

# --- Recent Activity (24h, auto: commits filtered) -----------------------
echo "### Recent Activity (24h)" >> "$TMP_FILE"
RECENT=""
if [ -d "$VAULT_PATH/.git" ]; then
  RECENT=$(git -C "$VAULT_PATH" log --oneline --since="24 hours ago" \
    --invert-grep \
    --grep='^auto:' \
    --grep='^gmail-triage:' \
    --grep='Update OAuth token' 2>/dev/null)
fi
if [ -n "$RECENT" ]; then
  echo "$RECENT" | while IFS= read -r line; do
    [ -n "$line" ] && echo "- $line" >> "$TMP_FILE"
  done
else
  echo "All quiet (routine auto-saves only)" >> "$TMP_FILE"
fi
echo "" >> "$TMP_FILE"

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

# --- Email Focus (me-personal + me-business only, top 3) ----------------
echo "### Email Focus" >> "$TMP_FILE"
if [ -f "$SLA_FILE" ] && { [ -n "$BREACHED_RAW" ] || [ -n "$OPEN_RAW" ]; }; then
  FOCUS=$(
    {
      printf '%s\n' "$BREACHED_RAW"
      printf '%s\n' "$OPEN_RAW"
    } | awk -F'|' '
      BEGIN { tierp["fast"]=1; tierp["normal"]=2; tierp["slow"]=3 }
      NF>=4 && ($2 == "me-personal" || $2 == "me-business") {
        tier=$1; owner=$2; from=$3; subj=$4
        sub(/ *<.*/, "", from)
        gsub(/"/, "", subj)
        p = (tierp[tier] ? tierp[tier] : 9)
        print p "\t" tier "\t" owner "\t" from "\t" subj
      }
    ' | sort -k1,1n | head -3
  )
  if [ -n "$FOCUS" ]; then
    N=1
    echo "$FOCUS" | while IFS=$'\t' read -r _ tier owner from subj; do
      sender=$(echo "$from" | cut -c1-35)
      subj_short=$(echo "$subj" | cut -c1-55)
      echo "$N. [$tier/$owner] $sender — \"$subj_short\"" >> "$TMP_FILE"
      N=$((N+1))
    done
  else
    echo "All clear." >> "$TMP_FILE"
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
