# Audit Eval

## Q1: Three-State Flag System
type: grep
patterns:
  - "true"
  - "false"
  - "manual"
  - "audit-flag.json"
pass: all patterns found
why: The 3-state flag (true/false/manual) controls /absorb and /think behavior — losing any state breaks the pipeline

## Q2: Script Reference
type: grep
patterns:
  - "audit.py"
  - "status"
  - "set-flag"
pass: all patterns found
why: audit.py is the core tool — agent must know all 3 modes (run/status/set-flag)

## Q3: Question Generation
type: grep
patterns:
  - "50 fresh"
  - "topic"
  - "cross-cutting"
  - "adversarial"
pass: all patterns found
why: 50 fresh questions (not reused from self-learn) with 3 types is the audit methodology

## Q4: Scoring and Results
type: grep
patterns:
  - "≥95"
  - "100%"
  - "audit-results"
pass: all patterns found
why: Same scoring threshold as self-learn, results saved to validation directory
