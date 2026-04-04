---
name: eval
description: "Use when testing skill correctness after editing, or wanting to verify all skills pass their eval checks"
---

# Skill Eval

Run eval checks against brain-os skills to catch regressions.

## Usage

```
/eval                    # Quick summary: which skills have eval.md, last results
/eval self-learn         # Run eval on specific skill
/eval --all              # Run eval on all skills that have eval.md
```

## How It Works

1. Find `eval.md` in the target skill directory
2. Parse each `## Q` section for `type`, `patterns`, and `pass` criteria
3. Run grep checks against the skill's `SKILL.md`
4. Report results in unit-test style

## Eval Runner Logic

For each question in `eval.md`:

```
Read the ## Q section
Extract patterns list
For each pattern:
  grep -qiF "$pattern" SKILL.md → found/not found
Check pass criteria:
  "all patterns found" → every pattern must match
  "at least one pattern found" → any pattern must match
Report ✓ or ✗ with the question title
```

## Output Format

```
Self-Learn Eval (7 checks)
  ✓ Q1: Autoresearch Architecture
  ✓ Q2: NotebookLM Setup
  ✗ Q3: Question Distribution — missing: "30%"
  ✓ Q4: Script References
  ✓ Q5: Stopping Condition
  ✓ Q6: Phase Structure
  ✓ Q7: Note Template

6/7 passed. 1 FAILED.
```

## Implementation

When `/eval <skill-name>` is invoked:

1. Read `${CLAUDE_PLUGIN_ROOT}/skills/<skill-name>/eval.md`
2. If no eval.md: report "No eval.md found for <skill-name>"
3. Read `${CLAUDE_PLUGIN_ROOT}/skills/<skill-name>/SKILL.md`
4. For each `## Q` block, parse and run grep checks
5. Print results with ✓/✗ per check
6. Print summary: `X/Y passed`

When `/eval --all`:
1. Scan all skill dirs for eval.md
2. Run eval on each
3. Print combined summary

## Adding Evals to a Skill

Create `eval.md` in the skill directory:

```markdown
## Q1: Descriptive Name
type: grep
patterns:
  - "pattern one"
  - "pattern two"
pass: all patterns found
why: Explain why these patterns matter
```

Supported pass criteria:
- `all patterns found` — every pattern must exist in SKILL.md
- `at least one pattern found` — any pattern must exist
