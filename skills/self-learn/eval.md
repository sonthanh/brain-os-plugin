# Self-Learn Eval

## Q1: Autoresearch Architecture
type: grep
patterns:
  - "information barriers"
  - "Question Generator"
  - "Knowledge Agent"
  - "Oracle"
  - "Judge"
pass: all patterns found
why: Phase 2 requires 4 independent roles with information barriers to prevent knowledge leaking

## Q2: NotebookLM Setup
type: grep
patterns:
  - "notebooklm use"
  - "notebooklm ask"
pass: all patterns found
why: Agent must know to set notebook first, then query — without this it will fail silently

## Q3: Question Distribution
type: grep
patterns:
  - "50%"
  - "30%"
  - "20%"
  - "max(100"
pass: all patterns found
why: The 50/30/20 split (topic/blind/adversarial) is core to catching gaps, not arbitrary

## Q4: Script References
type: grep
patterns:
  - "epub_parser"
  - "note_writer"
  - "question_gen"
  - "judge"
  - "summary.py"
pass: all patterns found
why: Each script is a critical tool the agent must invoke — missing reference = agent won't use it

## Q5: Stopping Condition
type: grep
patterns:
  - "100%"
  - "≥ 95"
  - "catastrophic"
pass: all patterns found
why: The 100% pass at ≥95 threshold with "wrong concepts are catastrophic" is the quality gate

## Q6: Phase Structure
type: grep
patterns:
  - "## Phase 1"
  - "## Phase 2"
  - "## Phase 3"
pass: all patterns found
why: 3-phase structure (extract/validate/extend) is the backbone of the skill

## Q7: Note Template
type: grep
patterns:
  - "source:"
  - "author:"
  - "chapter:"
  - "## Key Insight"
  - "## Related"
pass: all patterns found
why: Note template defines the output format — without it, extracted notes will be inconsistent
