#!/usr/bin/env bash
# run-descriptions-evals.sh — exercise the description-bloat detector against
# fixtures.
#
# For each case in fixtures/descriptions/cases.json, pipes the description
# through `scripts/scan-skill-descriptions.py --describe-stdin` and asserts:
#   1. flagged matches expected_flagged
#   2. set of signal names matches expected_signals
#
# Output ends with `PASS_COUNT=<N>/<M>` so the cron / repo-wide eval gate can
# parse the result. Exit code = number of failed assertions.
#
# Usage:
#   bash run-descriptions-evals.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
DETECTOR="$PLUGIN_ROOT/scripts/scan-skill-descriptions.py"
CASES="$HERE/fixtures/descriptions/cases.json"

if [[ ! -f "$DETECTOR" ]]; then
  echo "ERROR: detector script missing: $DETECTOR" >&2
  exit 2
fi
if [[ ! -f "$CASES" ]]; then
  echo "ERROR: cases file missing: $CASES" >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq not found in PATH" >&2
  exit 2
fi

TOTAL=0
PASS=0
FAIL=0

# Extract case count for the loop
CASE_COUNT=$(jq 'length' "$CASES")

for ((i = 0; i < CASE_COUNT; i++)); do
  TOTAL=$((TOTAL + 1))
  name=$(jq -r ".[$i].name" "$CASES")
  desc=$(jq -r ".[$i].description" "$CASES")
  expected_flagged=$(jq -r ".[$i].expected_flagged" "$CASES")
  expected_signals=$(jq -r ".[$i].expected_signals | sort | join(\",\")" "$CASES")

  result=$(printf '%s' "$desc" | python3 "$DETECTOR" --describe-stdin)
  actual_flagged=$(printf '%s' "$result" | jq -r '.flagged')
  actual_signals=$(printf '%s' "$result" | jq -r '.signals | map(.name) | sort | join(",")')

  case_ok=true
  if [[ "$actual_flagged" != "$expected_flagged" ]]; then
    case_ok=false
  fi
  if [[ "$actual_signals" != "$expected_signals" ]]; then
    case_ok=false
  fi

  if $case_ok; then
    PASS=$((PASS + 1))
    printf "  ✓ %s  (flagged=%s, signals=[%s])\n" "$name" "$actual_flagged" "$actual_signals"
  else
    FAIL=$((FAIL + 1))
    printf "  ✗ %s\n" "$name"
    printf "      expected: flagged=%s, signals=[%s]\n" "$expected_flagged" "$expected_signals"
    printf "      actual:   flagged=%s, signals=[%s]\n" "$actual_flagged" "$actual_signals"
  fi
done

printf "\nPASS_COUNT=%d/%d\n" "$PASS" "$TOTAL"
exit "$FAIL"
