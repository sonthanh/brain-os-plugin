#!/usr/bin/env bash
# Verifies skills/audit/SKILL.md documents the /audit --all flag per
# ai-brain#255 contract: 5 separate advisor() calls, deterministic P1→P5
# order, consolidation contract, backward-compat note, per-principle
# tracker logging. Pure prose lint — fast regression guard for the
# load-bearing semantic that --all must NOT degrade to a single batched
# advisor() call.

set -euo pipefail

SKILL="$(cd "$(dirname "$0")/.." && pwd)/SKILL.md"
[ -f "$SKILL" ] || { echo "FATAL: $SKILL not found" >&2; exit 1; }

fail=0
check() {
  local label="$1"; shift
  local pattern="$1"; shift
  local flags="${1:-}"
  if grep -E ${flags:+$flags} -q "$pattern" "$SKILL"; then
    echo "  ✓ $label"
  else
    echo "  ✗ $label  (missing pattern: $pattern)"
    fail=1
  fi
}

echo "audit/SKILL.md — /audit --all contract checks"

check "AC#1 — --all flag documented in usage"                '/audit --all'                                                                                  ''
check "AC#1 — 5 SEPARATE advisor calls (load-bearing)"       '5 separate.{0,4}.advisor.{0,4}.{0,40}(call|invocation)'                                          '-i'
check "AC#1 — anti-pattern: NOT one batched call"            '(NOT one|not one).{0,80}(call|invocation).{0,40}all 5'                                          '-i'
check "AC#1 — deterministic P1→P5 ordering callout"          'P1.{0,4}(→|to|through).{0,4}P5'                                                                 ''
check "AC#2 — Output consolidation contract subsection"      '^##+ Output consolidation contract'                                                              ''
check "AC#2 — regex compat preserved"                        '\\\| P\[0-9\]\+ \\\| \(PASS\|FLAG\|FAIL\)'                                                       ''
check "AC#2 — Per-principle Findings section format"         '^##+ Per-principle Findings'                                                                    ''
check "AC#3 — backward compat note for single + p1 p5"       '(backward compat|backward-compat|continues? (to )?work|unchanged)'                              '-i'
check "AC#4 — tracker: one row per principle on --all"       '(one|each).{0,40}(row|log row|tracker row).{0,40}(per principle|each principle)'                '-i'
check "AC#4 — tracker: use count increment per principle"    'increment.{0,40}(use|usage).{0,8}count.{0,40}(per|each|once per) principle'                     '-i'
check "Rationale — why isolation matters (anti-drift guard)" '(rationali[sz]e across principles|isolation|prevent.{0,30}rationali[sz]e)'                      '-i'

if [ "$fail" -eq 0 ]; then
  echo "PASS"
  exit 0
else
  echo "FAIL"
  exit 1
fi
