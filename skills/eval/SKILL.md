---
name: eval
description: "Use when testing skill correctness after editing, or wanting to verify all skills pass their eval checks"
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
5. Run the bash smoke check (see § Bash smoke check below) on the same skill
6. Print ✓/✗ per eval with summary — smoke findings count as failures

When `/eval --all`:
1. Scan all skill dirs for `evals/evals.json`
2. Run eval on each
3. Run the bash smoke check across all skills
4. Print combined summary — smoke findings count as failures

## Bash smoke check

Skill prose IS code Claude executes verbatim (ai-brain#163: a recipe with an
unresolved `$CLAUDE_PLUGIN_ROOT` died silently in a detached shell). Every eval
run therefore also validates the fenced bash blocks, not just textual output:

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(ls -d ~/.claude/plugins/cache/brain-os-marketplace/brain-os/*/ 2>/dev/null | sort -V | tail -1)}"; PLUGIN_ROOT="${PLUGIN_ROOT%/}"
bun run "$PLUGIN_ROOT/scripts/skill-bash-smoke.ts" <skill-name>   # omit arg for --all
```

The tool extracts every ` ```bash ` block from SKILL.md, normalizes doc
placeholders (`<N>`, `<tracker-repo>`), then enforces:

- **Parse** — `bash -n` must accept the block (broken quoting/heredoc/if-fi fails).
- **Plugin-root** — any block referencing `CLAUDE_PLUGIN_ROOT` must resolve it
  with a `:-` glob fallback or `:?` assertion in the same block.

Exit 0 = clean. Exit 1 = findings (report each as a failed eval line). Unit
tests for the tool live in `scripts/skill-bash-smoke.test.ts`.

## Adding Evals to a Skill

Create `evals/evals.json` in your skill directory following the schema above. Each eval should test a critical aspect of the skill that would break if removed.

## Outcome log

Follow `skill-spec.md § 11`. Append to `{vault}/daily/skill-outcomes/eval.log`:

```
{date} | eval | {action} | ~/work/brain-os-plugin | N/A | commit:N/A | {result}
```

- `action`: `eval` (single skill) or `eval-all` (all skills)
- `result`: `pass` if all evals pass, `partial` if some fail, `fail` if errors prevent running
- Optional: `args="{skill-name}"`, `score={passed}/{total}`
