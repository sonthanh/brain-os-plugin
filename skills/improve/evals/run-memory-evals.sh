#!/usr/bin/env bash
# run-memory-evals.sh — behavioral eval for /improve memory.
#
# For each of the 6 synthetic fixtures, ask Claude to apply the rubric encoded
# in /improve SKILL.md and assert what /improve memory would do:
#   1. tier               — which of {hook, skill, rules, claude-md, memory}
#   2. source_deleted     — does the encoding remove the source feedback file
#   3. memory_md_updated  — does Step 0.5 need to regenerate MEMORY.md
#   4. expiry_flagged     — does Step 0.7 surface the file (last_validated > 90d)
#
# Mirrors /skill-creator's behavioral pattern: hand the LLM the rubric, the
# fixture, and a tightly-scoped JSON output schema. Results are LLM judgments
# against the actual SKILL.md, not regex matches against the fixture body.
#
# Usage:
#   bash run-memory-evals.sh                     # default — invokes claude -p
#   bash run-memory-evals.sh --keyword-quick-check  # offline keyword sanity check
#                                                # (does NOT exercise the rubric)
#
# Output ends with `PASS_COUNT=<N>/<M>` so the cron can parse the result.
# Exit code = number of failed assertions (0 = all pass).

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$HERE/.." && pwd)"
FIXTURES="$HERE/fixtures/memory"
MODE="${1:-default}"
EXPIRY_DAYS="${EXPIRY_DAYS:-90}"

if [[ ! -d "$FIXTURES" ]]; then
  echo "ERROR: fixtures dir missing: $FIXTURES" >&2
  exit 2
fi

read_field() {
  awk -F': *' -v key="$1" '$1 == key { sub(/^[^:]*: */, ""); print; exit }' "$2"
}

read_how_to_apply() {
  awk '
    /^## How to apply/ {capture=1; next}
    capture && /^## / {capture=0}
    capture {print}
  ' "$1" | tr '[:upper:]' '[:lower:]'
}

# Quick offline check using positive encoding-action keywords. Useful in
# environments without `claude` (CI, sandbox). Does NOT exercise the rubric —
# only checks that fixtures contain the right encoding-action language for the
# tier they claim. Use the default mode for true behavioral coverage.
classify_keyword() {
  local how="$1"
  if [[ "$how" == *"pretooluse hook"* ]] \
     || [[ "$how" == *"posttooluse hook"* ]] \
     || [[ "$how" == *"~/.claude/hooks/"* ]]; then
    echo hook
  elif [[ "$how" == *"belongs in a skill"* ]] \
       || [[ "$how" == *"routes to /skill-creator"* ]] \
       || [[ "$how" == *"surgical addition to an existing skill"* ]]; then
    echo skill
  elif [[ "$how" == *".claude/rules/"* ]]; then
    echo rules
  elif [[ "$how" == *"~/.claude/claude.md"* ]] \
       || [[ "$how" == *"~/work/brain/claude.md"* ]] \
       || [[ "$how" == *"belongs in"*"claude.md"* ]] \
       || [[ "$how" == *"auto-loads into every session"* ]]; then
    echo claude-md
  else
    echo memory
  fi
}

claude_classify() {
  local fixture="$1"
  local rubric_excerpt fixture_body
  rubric_excerpt=$(awk '/^### Step 0.0 — Triage/,/^### Step 0.5/' "$SKILL_DIR/SKILL.md")
  fixture_body=$(cat "$fixture")
  local prompt
  prompt=$(printf '%s\n' \
    'You are predicting what /improve memory will do when it processes the memory feedback' \
    'file below, applying the 5-tier rubric encoded in SKILL.md (excerpt below).' \
    '' \
    'Rubric excerpt:' \
    "$rubric_excerpt" \
    '' \
    'Apply the rubric. Predict behavior of THIS run (current execution, not future runs).' \
    'Output exactly one JSON object on a single line — no prose, no fences, no markdown:' \
    '' \
    '{"tier": "<hook|skill|rules|claude-md|memory>",' \
    ' "source_removed_this_run": <true|false>,' \
    ' "memory_md_regenerated_this_run": <true|false>}' \
    '' \
    'Field semantics — read carefully:' \
    '' \
    '  tier: which tier the rubric routes this fixture into (first match wins).' \
    '' \
    '  source_removed_this_run: would Step 0.0 encoding execution call rm on the' \
    '  fixture memory feedback file during the CURRENT run?' \
    '    - tiers hook/skill/rules/claude-md → encoding executes → rm fires → true' \
    '    - tier memory                       → no encoding → file stays → false' \
    '    - Step 0.7 expiry on its own does NOT delete this run; it only files a' \
    '      type:human-review issue. Only the NEXT run (after the user closes the' \
    '      issue) deletes. So when the tier is memory but the file is also expired,' \
    '      source_removed_this_run is still false.' \
    '' \
    '  memory_md_regenerated_this_run: would Step 0.5 rewrite MEMORY.md this run?' \
    '    Step 0.5 runs unconditionally when any feedback file is removed in Step 0.0.' \
    '    So track 1:1 with source_removed_this_run.' \
    '' \
    'Memory feedback file under classification:' \
    "$fixture_body")
  claude --dangerously-skip-permissions --model sonnet -p "$prompt" 2>/dev/null \
    | tr -d '\r' \
    | grep -oE '\{[^{}]*\}' \
    | head -1
}

run_default_mode() {
  local fixture="$1"
  local expected_tier
  expected_tier=$(read_field expected_tier "$fixture")
  local expected_source_deleted expected_memory_md
  if [[ "$expected_tier" == "memory" ]]; then
    expected_source_deleted=false
    expected_memory_md=false
  else
    expected_source_deleted=true
    expected_memory_md=true
  fi

  local json
  json=$(claude_classify "$fixture")
  if [[ -z "$json" ]]; then
    echo "FAIL  $(basename "$fixture")  no JSON returned from claude -p"
    return 3
  fi

  local actual_tier actual_deleted actual_memory_md
  actual_tier=$(printf '%s' "$json" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print(d.get("tier",""))' 2>/dev/null)
  actual_deleted=$(printf '%s' "$json" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print(str(d.get("source_removed_this_run","")).lower())' 2>/dev/null)
  actual_memory_md=$(printf '%s' "$json" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print(str(d.get("memory_md_regenerated_this_run","")).lower())' 2>/dev/null)

  local fails=0
  if [[ "$actual_tier" != "$expected_tier" ]]; then
    echo "FAIL  $(basename "$fixture")  tier expected=$expected_tier got=$actual_tier"
    fails=$((fails + 1))
  fi
  if [[ "$actual_deleted" != "$expected_source_deleted" ]]; then
    echo "FAIL  $(basename "$fixture")  source_deleted expected=$expected_source_deleted got=$actual_deleted"
    fails=$((fails + 1))
  fi
  if [[ "$actual_memory_md" != "$expected_memory_md" ]]; then
    echo "FAIL  $(basename "$fixture")  memory_md_updated expected=$expected_memory_md got=$actual_memory_md"
    fails=$((fails + 1))
  fi
  if (( fails == 0 )); then
    echo "PASS  $(basename "$fixture")  tier=$actual_tier deleted=$actual_deleted memory_md=$actual_memory_md"
  fi
  return $fails
}

run_keyword_mode() {
  local fixture="$1"
  local expected
  expected=$(read_field expected_tier "$fixture")
  local how
  how=$(read_how_to_apply "$fixture")
  local actual
  actual=$(classify_keyword "$how")
  if [[ "$actual" == "$expected" ]]; then
    echo "PASS  $(basename "$fixture")  tier=$actual"
    return 0
  else
    echo "FAIL  $(basename "$fixture")  expected=$expected got=$actual"
    return 1
  fi
}

PASS=0
FAIL=0
case "$MODE" in
  --keyword-quick-check)
    echo "=== Tier classification (keyword quick check — does NOT exercise rubric) ==="
    for fixture in "$FIXTURES"/*.md; do
      if run_keyword_mode "$fixture"; then
        PASS=$((PASS + 1))
      else
        FAIL=$((FAIL + 1))
      fi
    done
    ;;
  default)
    if ! command -v claude >/dev/null 2>&1; then
      echo "ERROR: 'claude' CLI not in PATH — required for default behavioral mode." >&2
      echo "Use --keyword-quick-check for an offline sanity check." >&2
      exit 2
    fi
    echo "=== Behavioral eval (claude -p applies rubric to each fixture) ==="
    for fixture in "$FIXTURES"/*.md; do
      run_default_mode "$fixture"
      rc=$?
      if (( rc == 0 )); then
        PASS=$((PASS + 3))
      else
        # 3 assertions per fixture; failed ones already logged
        FAIL=$((FAIL + rc))
        PASS=$((PASS + 3 - rc))
      fi
    done
    ;;
  *)
    echo "ERROR: unknown mode '$MODE' (use default or --keyword-quick-check)" >&2
    exit 2
    ;;
esac

# Step 0.7 expiry assertions — independent of LLM, deterministic from frontmatter.
TODAY_EPOCH=$(date +%s)
EXPIRY_PASS=0
EXPIRY_FAIL=0
echo
echo "=== Expiry detection (threshold: ${EXPIRY_DAYS} days) ==="
for fixture in "$FIXTURES"/*.md; do
  last_validated=$(read_field last_validated "$fixture")
  expected_expiry=$(read_field expected_expiry "$fixture")
  expected="${expected_expiry:-false}"
  if [[ -z "$last_validated" ]]; then
    flagged=false
  else
    lv_epoch=$(date -j -f "%Y-%m-%d" "$last_validated" +%s 2>/dev/null || echo 0)
    age_days=$(( (TODAY_EPOCH - lv_epoch) / 86400 ))
    flagged=$( (( age_days > EXPIRY_DAYS )) && echo true || echo false )
  fi
  if [[ "$flagged" == "$expected" ]]; then
    echo "PASS  $(basename "$fixture")  expected_expiry=$expected"
    EXPIRY_PASS=$((EXPIRY_PASS + 1))
  else
    echo "FAIL  $(basename "$fixture")  expected_expiry=$expected got=$flagged (last_validated=$last_validated)"
    EXPIRY_FAIL=$((EXPIRY_FAIL + 1))
  fi
done

TOTAL_PASS=$((PASS + EXPIRY_PASS))
TOTAL=$((PASS + FAIL + EXPIRY_PASS + EXPIRY_FAIL))
echo
echo "Behavior: $PASS/$((PASS + FAIL)) pass"
echo "Expiry:   $EXPIRY_PASS/$((EXPIRY_PASS + EXPIRY_FAIL)) pass"
echo "PASS_COUNT=$TOTAL_PASS/$TOTAL"
exit $((FAIL + EXPIRY_FAIL))
