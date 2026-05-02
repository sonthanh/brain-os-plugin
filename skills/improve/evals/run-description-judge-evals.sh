#!/usr/bin/env bash
# run-description-judge-evals.sh — behavioral eval for the Phase 4 semantic-judge
# applied to description-trim variants (the routing-preservation gate).
#
# For each case in fixtures/descriptions/judge-cases.json, builds the judge
# prompt verbatim from SKILL.md (so prompt drift is caught), substitutes the
# case's pre_edit_description + candidate, invokes `claude -p`, parses the
# first-line PASS/FAIL verdict, and asserts against expected_verdict.
#
# Catches drift in:
#   - the Phase 4 judge prompt template (if its rules soften)
#   - the model's behavior on subtle drops (synonym substitution, etc.)
#
# Usage:
#   bash run-description-judge-evals.sh
#
# Output ends with `PASS_COUNT=<N>/<M>` so the cron / repo-wide eval gate can
# parse the result. Exit code = number of failed assertions.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$HERE/.." && pwd)"
CASES="$HERE/fixtures/descriptions/judge-cases.json"

if [[ ! -f "$CASES" ]]; then
  echo "ERROR: cases file missing: $CASES" >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq not found in PATH" >&2
  exit 2
fi
if ! command -v claude >/dev/null 2>&1; then
  echo "ERROR: claude CLI not found in PATH (required for behavioral eval)" >&2
  exit 2
fi

build_prompt() {
  local pre="$1" candidate_skill_md="$2"
  printf '%s\n' \
    "You are judging whether a proposed edit to a skill's SKILL.md still matches the skill's original trigger conditions. The pre-edit frontmatter description field is the canonical trigger spec — Claude Code uses it to route invocations by string-matching user input against text in the description." \
    '' \
    "Routing-surface preservation rule (non-negotiable): Extract every single-quoted phrase ('...'), double-quoted phrase (\"...\"), and backtick-quoted token (\`...\`) from the pre-edit description. These — and ONLY these — are the routing surface; Claude Code matches user input against them verbatim. If ANY of these quoted/backticked tokens is missing from the candidate description (verbatim substring match), return FAIL. Unquoted prose, decorative adjectives, and explanatory clauses can be paraphrased, truncated, or dropped freely — they are not routing keywords. Semantic equivalence does not save a missing quoted token: a candidate that drops 'grill me' but keeps 'stress-test this plan' is FAIL even if the skill still does the same thing." \
    '' \
    'Also FAIL if the candidate drifts into different skill territory (changes scope or primary action), even when all quoted tokens survive.' \
    '' \
    'Reply strictly PASS or FAIL on the first line, then a one-sentence rationale on the second line. No other output.' \
    '' \
    'Pre-edit frontmatter description (ANCHOR — do not treat the candidate'\''s own frontmatter as the spec):' \
    '```' \
    "$pre" \
    '```' \
    '' \
    'Candidate SKILL.md (full text, including any mutated frontmatter):' \
    '```' \
    "$candidate_skill_md" \
    '```'
}

build_candidate_skill_md() {
  local skill_name="$1" candidate_desc="$2"
  printf -- '---\nname: %s\ndescription: "%s"\n---\n\n# %s — placeholder body\n\n(body unchanged from pre-edit)\n' \
    "$skill_name" \
    "$candidate_desc" \
    "$skill_name"
}

TOTAL=0
PASS=0
FAIL=0

CASE_COUNT=$(jq 'length' "$CASES")

for ((i = 0; i < CASE_COUNT; i++)); do
  TOTAL=$((TOTAL + 1))
  name=$(jq -r ".[$i].name" "$CASES")
  skill_name=$(jq -r ".[$i].skill_name" "$CASES")
  pre=$(jq -r ".[$i].pre_edit_description" "$CASES")
  candidate=$(jq -r ".[$i].candidate_description" "$CASES")
  expected=$(jq -r ".[$i].expected_verdict" "$CASES")

  candidate_md=$(build_candidate_skill_md "$skill_name" "$candidate")
  prompt=$(build_prompt "$pre" "$candidate_md")

  raw=$(claude --dangerously-skip-permissions --model sonnet -p "$prompt" 2>/dev/null | tr -d '\r')
  verdict=$(printf '%s' "$raw" | head -1 | grep -oE 'PASS|FAIL' | head -1)
  if [[ -z "$verdict" ]]; then
    verdict="MALFORMED"
  fi

  if [[ "$verdict" == "$expected" ]]; then
    PASS=$((PASS + 1))
    printf "  ✓ %s  (verdict=%s)\n" "$name" "$verdict"
  else
    FAIL=$((FAIL + 1))
    printf "  ✗ %s  expected=%s got=%s\n" "$name" "$expected" "$verdict"
    printf "      raw judge output:\n"
    printf '%s' "$raw" | sed 's/^/        /'
    printf '\n'
  fi
done

printf "\nPASS_COUNT=%d/%d\n" "$PASS" "$TOTAL"
exit "$FAIL"
