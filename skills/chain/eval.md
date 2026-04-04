# Chain Eval

## Q1: Pipeline Order
type: grep
patterns:
  - "self-learn"
  - "ingest"
  - "audit"
  - "absorb"
  - "sync"
pass: all patterns found
why: The 5-step pipeline must run in exact order — skipping or reordering breaks the knowledge flow

## Q2: Pipeline State Tracking
type: grep
patterns:
  - "audit-flag.json"
  - "resume"
  - "pipeline_completed"
pass: all patterns found
why: State tracking allows interrupted pipelines to resume from the right step

## Q3: Error Handling
type: grep
patterns:
  - "FAIL"
  - "PASS"
  - "audited: false"
pass: all patterns found
why: Pipeline must handle audit failures by stopping and notifying, not continuing blindly
