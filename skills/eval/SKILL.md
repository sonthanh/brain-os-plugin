---
name: eval
description: "Use when testing skill correctness after editing, or wanting to verify all skills pass their eval checks"
model: sonnet
---

# Skill Eval

Run eval checks against brain-os skills to catch regressions. Uses the standard `evals/evals.json` format from the skill-creator framework.

## Usage

```
/eval                    # List which skills have evals
/eval self-learn         # Run eval on specific skill
/eval --all              # Run eval on all skills with evals/evals.json
```

## How It Works

1. Find `evals/evals.json` in the target skill directory
2. For each eval entry, read the `prompt` and `expectations`
3. Read the skill's `SKILL.md` and check each expectation against its content
4. Report results in unit-test style

## Output Format

```
self-learn (7 evals)
  ✓ #1 Phase 2 validation architecture
  ✓ #2 NotebookLM CLI commands
  ✗ #3 Question distribution — FAILED: "States 30% blind/cross-cutting questions"
  ✓ #4 Script references
  ✓ #5 Quality threshold
  ✓ #6 Note template format
  ✓ #7 Post-completion pipeline

6/7 passed. 1 FAILED.
```

## evals.json Format

Standard schema from skill-creator. Located at `evals/evals.json` inside each skill directory:

```json
{
  "skill_name": "self-learn",
  "evals": [
    {
      "id": 1,
      "prompt": "Explain the Phase 2 validation architecture",
      "expected_output": "Lists 4 roles with information barriers",
      "expectations": [
        "Mentions Question Generator that creates questions without seeing answers",
        "Mentions Knowledge Agent that answers ONLY from Obsidian notes",
        "Describes information barriers preventing knowledge leaking"
      ]
    }
  ]
}
```

## Implementation

When `/eval <skill-name>` is invoked:

1. Read `${CLAUDE_PLUGIN_ROOT}/skills/<skill-name>/evals/evals.json`
2. If not found: report "No evals found for <skill-name>"
3. Read `${CLAUDE_PLUGIN_ROOT}/skills/<skill-name>/SKILL.md`
4. For each eval, check each expectation against SKILL.md content
5. Print ✓/✗ per eval with summary

When `/eval --all`:
1. Scan all skill dirs for `evals/evals.json`
2. Run eval on each
3. Print combined summary

## Adding Evals to a Skill

Create `evals/evals.json` in your skill directory following the schema above. Each eval should test a critical aspect of the skill that would break if removed.

## Outcome log

<<<<<<< Updated upstream
Follow `skill-spec.md § 11`. Append to `{vault}/daily/skill-outcomes/eval.log`:

```
{date} | eval | {action} | ~/work/brain-os-plugin | N/A | commit:N/A | {result}
```

- `action`: `eval` (single skill) or `eval-all` (all skills)
- `result`: `pass` if all evals pass, `partial` if some fail, `fail` if errors prevent running
- Optional: `args="{skill-name}"`, `score={passed}/{total}`
=======
After each `/eval` run, append one line to `{vault}/daily/skill-outcomes/eval.log`:

```
{date} | eval | {action} | ~/work/brain-os-plugin | N/A | commit:N/A | {result}
```

- `mode`: `single` (specific skill), `all`, or `list`
- `result`: `pass` if all evals pass, `partial` if some skills fail, `fail` if errors
>>>>>>> Stashed changes
