#!/usr/bin/env bash
# Verifies skills/audit/SKILL.md documents the /audit --all flag per
# ai-brain#255 + ai-brain#260 contract AND the /audit --team flag per
# ai-brain#252 (Phase B) contract.
#
# --all (Iteration 2): 5 separate Agent(subagent_type=general-purpose)
# calls (NOT advisor() — forwards full transcript per call, breaks the
# isolation contract; empirical finding from #253 AC#7 smoke 2026-05-07),
# deterministic P1→P5 order, consolidation contract, backward-compat
# note, per-principle tracker logging.
#
# --team (Iteration 3, ai-brain#252): TeamCreate-managed N×5 team via
# principle-auditor-p{1..5} subagent definitions, 3-round protocol with
# within-principle vote + cross-principle DM-debate, per-teammate JSON
# write protocol (race-safe by per-file ownership), variance= field in
# audit.log, subprocess-isolation contract (principle text in AGENT FILE
# not in spawn prompt — the iteration-3 contract that prevents regressing
# to iteration-2's orchestrator-prompt-drift failure mode).
#
# Pure prose lint — fast regression guard for the load-bearing semantics
# that --all must NOT degrade to a single batched call OR silently revert
# to advisor(), AND that --team must NOT fold principle text into the
# lead's spawn prompt (which would re-introduce iteration-2's drift).

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

echo "audit/SKILL.md — /audit --all + --team contract checks"

# --- /audit --all contract (Iteration 2) ---
check "AC#1 — --all flag documented in usage"                '/audit --all'                                                                                  ''
check "AC#1 — 5 SEPARATE Agent calls (load-bearing isolation)" '5 separate.{0,40}Agent.{0,80}(call|invocation)'                                                '-i'
check "AC#1 — Agent uses general-purpose subagent_type"      'subagent_type.{0,20}general-purpose'                                                             '-i'
check "AC#1 — anti-pattern: NOT one batched call"            '(NOT one|not one).{0,80}(call|invocation).{0,40}all 5'                                          '-i'
check "AC#1 — anti-pattern: advisor() leaks transcript"      '(advisor.{0,40}(forward|transcript|leak)|forward.{0,30}transcript|transcript.{0,30}per call)'   '-i'
check "AC#1 — deterministic P1→P5 ordering callout"          'P1.{0,4}(→|to|through).{0,4}P5'                                                                 ''
check "AC#2 — Output consolidation contract subsection"      '^##+ Output consolidation contract'                                                              ''
check "AC#2 — regex compat preserved"                        '\\\| P\[0-9\]\+ \\\| \(PASS\|FLAG\|FAIL\)'                                                       ''
check "AC#2 — Per-principle Findings section format"         '^##+ Per-principle Findings'                                                                    ''
check "AC#2 — example block names per-principle source as 'Agent response'" "P[1-5]'s Agent response"                                                          ''
check "AC#2 — return-latency wording references Agent (not stale advisor)" 'regardless of per-principle Agent return latency'                                  ''
check "AC#3 — backward compat note for single + p1 p5"       '(backward compat|backward-compat|continues? (to )?work|unchanged)'                              '-i'
check "AC#4 — tracker: one row per principle on --all"       '(one|each).{0,40}(row|log row|tracker row).{0,40}(per principle|each principle)'                '-i'
check "AC#4 — tracker: use count increment per principle"    'increment.{0,40}(use|usage).{0,8}count.{0,40}(per|each|once per) principle'                     '-i'
check "Rationale — why isolation matters (anti-drift guard)" '(rationali[sz]e across principles|isolation|prevent.{0,30}rationali[sz]e)'                      '-i'

# --- /audit --team contract (Iteration 3, ai-brain#252 Phase B) ---
check "AC#252-1 — --team flag documented in usage"           '/audit --team'                                                                                  ''
check "AC#252-2 — TeamCreate primitive named"                'TeamCreate'                                                                                     ''
check "AC#252-3 — principle-auditor-pN agent definitions referenced" 'principle-auditor-p\{?1\.\.5\}?|principle-auditor-pN'                                  '-i'
check "AC#252-4 — N=2 within-principle default documented"   '(N\s*=\s*2|default N=2|N×5|N x 5)'                                                              '-i'
check "AC#252-5 — 3-round protocol named"                    '3-round protocol'                                                                               '-i'
check "AC#252-6 — within-principle vote step"                'within-principle (vote|consensus)'                                                               '-i'
check "AC#252-7 — cross-principle DM-debate signature"       '(cross-principle.{0,40}(signature|DM)|DM-debate)'                                               '-i'
check "AC#252-8 — race-safety: per-teammate JSON files (no shared write)" '(per-teammate JSON|agent-\$\{?name\}?\.json|each teammate writes ONLY)'           '-i'
check "AC#252-9 — variance= field in audit.log spec"         'variance='                                                                                      ''
check "AC#252-10 — variance signal: converged"               'variance=converged'                                                                              ''
check "AC#252-11 — variance signal: split:P{N}"              'variance=split:P'                                                                                ''
check "AC#252-12 — variance signal: scope-flagged"           'variance=scope-flagged'                                                                          ''
check "AC#252-13 — Variance Notes output section"            '^##+ Variance Notes'                                                                            ''
check "AC#252-14 — subprocess isolation: principle text in AGENT FILE not spawn prompt" '(principle text.{0,40}(agent definition|agent file)|principle.{0,40}calibration.{0,40}live in.{0,40}agent definition|read by the teammate from its own definition file)' '-i'
check "AC#252-15 — anti-pattern: folding principle text into spawn prompt" '(fold|folding|inlin(e|ing)).{0,80}principle text.{0,40}spawn prompt'             '-i'
check "AC#252-16 — TeammateIdle hook scoped to audit-* teams" '(audit-\*|TeammateIdle.{0,40}audit-\*|hook.{0,40}audit-\*)'                                    '-i'
check "AC#252-17 — When-to-pick mode comparison table"       '^##+ When to pick'                                                                              ''
check "AC#252-18 — Phase B status: SHIPPED (not deferred)"   '(#252.{0,20}SHIPPED|Phase B.{0,40}SHIPPED|SHIPPED.{0,40}#252|SHIPPED.{0,40}2026-05-07)'         ''
check "AC#252-19 — three-iteration history documented"       '(Iteration 1|Iteration 2|Iteration 3|three iterations|3 iterations)'                            '-i'
check "AC#252-20 — round budget hard cap of 3"               '(ROUND_BUDGET|round.{0,20}cap|3 rounds.{0,30}(cap|hard|max))'                                   '-i'
check "AC#252-21 — token-budget pre-spawn estimate (subscription)" '(token.budget|pre-spawn.{0,30}(estimate|budget)|subscription.{0,40}(token|budget))'      '-i'

if [ "$fail" -eq 0 ]; then
  echo "PASS"
  exit 0
else
  echo "FAIL"
  exit 1
fi
