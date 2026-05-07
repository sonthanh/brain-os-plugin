#!/usr/bin/env bash
# audit-team-consensus.sh — TeammateIdle hook for `/audit --team` runs.
#
# Fires on each TeammateIdle event. Scoped to `audit-*` team names; exits silently
# for any other team. Inspects the per-teammate JSON files written by each
# `principle-auditor-p{1..5}` agent, logs progress, and escalates when an agent
# idles after round 3 with unresolved dissent (within-principle split, missing
# cross-principle signatures, or `dissent_acknowledged: true`).
#
# Always exits 0 — this hook is observational + escalation, not enforcement.
# The agents run all 3 rounds within one agent turn (filesystem-polling between
# rounds), so by the time TeammateIdle fires, the agent has either finished
# (good) or hit a wait timeout (escalate).
#
# Exit code: always 0. Never blocks the teammate from idling.

set -euo pipefail

LOG_DIR="$HOME/.claude/audit-runs"
mkdir -p "$LOG_DIR"

# Read JSON payload from stdin if available (Claude Code hook convention).
# Fall back to env vars if stdin is empty / non-JSON.
PAYLOAD=""
if [ -p /dev/stdin ] || [ ! -t 0 ]; then
  PAYLOAD="$(cat || true)"
fi

# Extract team_name + agent_name. Try jq first; fall back to env.
TEAM_NAME=""
AGENT_NAME=""
if command -v jq >/dev/null 2>&1 && [ -n "$PAYLOAD" ]; then
  TEAM_NAME="$(echo "$PAYLOAD" | jq -r '.team_name // .team // empty' 2>/dev/null || true)"
  AGENT_NAME="$(echo "$PAYLOAD" | jq -r '.agent_name // .name // .agent // empty' 2>/dev/null || true)"
fi
TEAM_NAME="${TEAM_NAME:-${CLAUDE_TEAM_NAME:-}}"
AGENT_NAME="${AGENT_NAME:-${CLAUDE_AGENT_NAME:-}}"

# Skip silently when not an audit-* team.
case "$TEAM_NAME" in
  audit-*) ;;
  *) exit 0 ;;
esac

RUN_DIR="$LOG_DIR/$TEAM_NAME"
HOOK_LOG="$RUN_DIR/hook.log"
mkdir -p "$RUN_DIR"

NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "$NOW | TeammateIdle | team=$TEAM_NAME agent=${AGENT_NAME:-?}" >> "$HOOK_LOG"

# If we don't know the agent, just observe and exit.
if [ -z "$AGENT_NAME" ]; then
  exit 0
fi

AGENT_JSON="$RUN_DIR/agent-$AGENT_NAME.json"
if [ ! -f "$AGENT_JSON" ]; then
  echo "$NOW | warn | $AGENT_NAME idled without writing JSON" >> "$HOOK_LOG"
  exit 0
fi

# Inspect agent JSON. Need jq to parse; if not available, just log and exit.
if ! command -v jq >/dev/null 2>&1; then
  echo "$NOW | warn | jq not available — cannot validate $AGENT_NAME state" >> "$HOOK_LOG"
  exit 0
fi

ROUND="$(jq -r '.round // 0' "$AGENT_JSON")"
VERDICT="$(jq -r '.verdict // "?"' "$AGENT_JSON")"
# jq // is "alternative" — it returns the fallback when left side is null OR
# false, which would mask an explicit `agreed: false`. Read the raw value and
# normalize "null" (field absent) to "true" (default = agreed).
WITHIN_AGREED="$(jq -r '.within_principle_vote.agreed' "$AGENT_JSON")"
[ "$WITHIN_AGREED" = "null" ] && WITHIN_AGREED="true"
DISSENT="$(jq -r '.dissent_acknowledged' "$AGENT_JSON")"
[ "$DISSENT" = "null" ] && DISSENT="false"
SIG_COUNT="$(jq -r '.cross_principle_signatures | length' "$AGENT_JSON")"
DISAGREE_COUNT="$(jq -r '[.cross_principle_signatures[]? | select(.agreed_with_their_finding == false)] | length' "$AGENT_JSON")"

echo "$NOW | state | $AGENT_NAME round=$ROUND verdict=$VERDICT within_agreed=$WITHIN_AGREED sigs=$SIG_COUNT disagree=$DISAGREE_COUNT dissent=$DISSENT" >> "$HOOK_LOG"

# Escalation criteria (any of):
#   - round < 3 at idle (timed out)
#   - round == 3 AND within_principle_vote.agreed == false
#   - round == 3 AND cross_principle_signatures.length < 4
#   - round == 3 AND dissent_acknowledged == true
#   - round == 3 AND ≥2 cross_principle_signatures with agreed_with_their_finding == false (majority dissent)
ESCALATE=0
ESCALATION_REASON=""

if [ "$ROUND" -lt 3 ]; then
  ESCALATE=1
  ESCALATION_REASON="$AGENT_NAME idled at round=$ROUND (<3) — wait-loop timeout or peer absence"
elif [ "$WITHIN_AGREED" = "false" ]; then
  ESCALATE=1
  ESCALATION_REASON="$AGENT_NAME within-principle vote split (variance signal)"
elif [ "$SIG_COUNT" -lt 4 ]; then
  ESCALATE=1
  ESCALATION_REASON="$AGENT_NAME has $SIG_COUNT/4 cross-principle signatures"
elif [ "$DISAGREE_COUNT" -ge 2 ]; then
  ESCALATE=1
  ESCALATION_REASON="$AGENT_NAME disagrees with $DISAGREE_COUNT/4 cross-principle peers (majority dissent)"
elif [ "$DISSENT" = "true" ]; then
  ESCALATE=1
  ESCALATION_REASON="$AGENT_NAME flagged dissent_acknowledged=true"
fi

if [ "$ESCALATE" -eq 0 ]; then
  echo "$NOW | ok | $AGENT_NAME consensus reached" >> "$HOOK_LOG"
  exit 0
fi

# Escalate once per agent: write a marker so we don't re-escalate on subsequent
# TeammateIdle re-fires for the same agent.
MARKER="$RUN_DIR/.escalated-$AGENT_NAME"
if [ -f "$MARKER" ]; then
  echo "$NOW | already-escalated | $AGENT_NAME ($ESCALATION_REASON)" >> "$HOOK_LOG"
  exit 0
fi
touch "$MARKER"

echo "$NOW | escalate | $AGENT_NAME ($ESCALATION_REASON)" >> "$HOOK_LOG"

ESCALATION_MD="$RUN_DIR/escalation.md"
{
  echo "# audit --team escalation — $TEAM_NAME"
  echo
  echo "Time: $NOW"
  echo "Agent: $AGENT_NAME"
  echo "Reason: $ESCALATION_REASON"
  echo
  echo "## Agent state"
  echo
  echo "\`\`\`json"
  cat "$AGENT_JSON"
  echo "\`\`\`"
  echo
  echo "## All agents in this run"
  echo
  for f in "$RUN_DIR"/agent-*.json; do
    [ -f "$f" ] || continue
    BN="$(basename "$f" .json | sed 's/^agent-//')"
    R="$(jq -r '.round // 0' "$f" 2>/dev/null || echo "?")"
    V="$(jq -r '.verdict // "?"' "$f" 2>/dev/null || echo "?")"
    echo "- $BN: round=$R verdict=$V"
  done
} >> "$ESCALATION_MD"

# Banner via osascript (fallback when sp unreachable).
osascript -e "display notification \"$AGENT_NAME — $ESCALATION_REASON\" with title \"audit --team needs HITL\" sound name \"Glass\"" 2>/dev/null || true

# Open Supaterm tab for HITL focus per feedback_long_running_alert_via_sp_tab.md.
if command -v sp >/dev/null 2>&1; then
  SP_SCRIPT="echo '⚠️  audit --team — HITL escalation'; echo; echo '$ESCALATION_REASON'; echo; echo 'See: $ESCALATION_MD'; echo; printf 'open escalation.md? [y/N] '; read -r ans; case \"\$ans\" in y|Y) \${EDITOR:-vi} '$ESCALATION_MD' ;; esac; printf 'Press Enter to close tab...'; read -r _"
  sp tab new --focus --cwd "$RUN_DIR" --script "$SP_SCRIPT" \
    >> "$HOOK_LOG" 2>&1 || echo "$NOW | warn | sp tab new failed (osascript fallback only)" >> "$HOOK_LOG"
fi

exit 0
