#!/usr/bin/env bash
# trace-capture.sh — PostToolUse hook that writes per-skill tool-call traces
#
# Detects skill invocations (tool_name=="Skill") and records subsequent tool
# calls to {vault}/daily/skill-traces/{skill}.jsonl until the next Skill call
# or session end. Keyed by session_id so concurrent sessions don't collide.
#
# Exit code is always 0 — tracing must never block tool execution.

set -uo pipefail

INPUT=$(cat)

# shellcheck source=resolve-vault.sh
source "${CLAUDE_PLUGIN_ROOT}/hooks/resolve-vault.sh"

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)

[[ -z "$SESSION_ID" || -z "$TOOL_NAME" ]] && exit 0

STATE_DIR="${TMPDIR:-/tmp}/claude-trace"
mkdir -p "$STATE_DIR" 2>/dev/null || exit 0
STATE_FILE="$STATE_DIR/${SESSION_ID}.skill"

TRACE_DIR="$VAULT_PATH/daily/skill-traces"
mkdir -p "$TRACE_DIR" 2>/dev/null || exit 0

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# --- Skill invocation: start new trace segment ---
if [[ "$TOOL_NAME" == "Skill" ]]; then
  RAW_SKILL=$(echo "$INPUT" | jq -r '.tool_input.skill // empty' 2>/dev/null)
  [[ -z "$RAW_SKILL" ]] && exit 0

  # Strip plugin prefix ("brain-os:grill" → "grill") and sanitize
  SKILL_NAME="${RAW_SKILL##*:}"
  SKILL_NAME=$(echo "$SKILL_NAME" | tr -c 'a-zA-Z0-9_-' '_' | sed 's/_*$//')
  [[ -z "$SKILL_NAME" ]] && exit 0

  echo "$SKILL_NAME" > "$STATE_FILE"

  ARGS=$(echo "$INPUT" | jq -r '.tool_input.args // ""' 2>/dev/null)
  jq -cn \
    --arg ts "$TS" \
    --arg skill "$SKILL_NAME" \
    --arg session "$SESSION_ID" \
    --arg args "$ARGS" \
    '{ts: $ts, event: "skill_start", skill: $skill, session: $session, args: $args}' \
    >> "$TRACE_DIR/${SKILL_NAME}.jsonl" 2>/dev/null
  exit 0
fi

# --- Regular tool: append to active skill trace, if any ---
[[ ! -f "$STATE_FILE" ]] && exit 0
ACTIVE_SKILL=$(cat "$STATE_FILE" 2>/dev/null)
[[ -z "$ACTIVE_SKILL" ]] && exit 0

# Minimal input summary — never full tool_input (avoid leaking content + bloat)
SUMMARY=$(echo "$INPUT" | jq -c '
  (.tool_input // {}) as $i |
  if $i.file_path then {file: $i.file_path}
  elif $i.path then {path: $i.path}
  elif $i.pattern then {pattern: $i.pattern, glob: ($i.glob // null), type: ($i.type // null)}
  elif $i.command then {command: ($i.command | tostring | .[0:120])}
  elif $i.url then {url: $i.url}
  elif $i.query then {query: ($i.query | tostring | .[0:120])}
  elif $i.skill then {skill: $i.skill}
  elif $i.description then {description: ($i.description | tostring | .[0:80])}
  else {} end
' 2>/dev/null)
[[ -z "$SUMMARY" || "$SUMMARY" == "null" ]] && SUMMARY="{}"

jq -cn \
  --arg ts "$TS" \
  --arg skill "$ACTIVE_SKILL" \
  --arg tool "$TOOL_NAME" \
  --arg session "$SESSION_ID" \
  --argjson summary "$SUMMARY" \
  '{ts: $ts, event: "tool_call", skill: $skill, tool: $tool, session: $session, input: $summary}' \
  >> "$TRACE_DIR/${ACTIVE_SKILL}.jsonl" 2>/dev/null

exit 0
