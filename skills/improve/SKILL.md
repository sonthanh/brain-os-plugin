---
name: improve
description: |
  Analyze skill outcomes and user corrections to propose self-improvements. Use when a skill's output repeatedly needs manual fixes, after a grill session surfaces skill weaknesses, or on a schedule to continuously improve skill quality. Triggers on: improve, skill learning, why does this skill keep getting it wrong, make this skill better.
---

# Improve — Skill Learning Loop

## Usage

```
/improve <skill-name>        # Improve a specific skill
/improve                     # Scan all outcome logs, rank by error rate, suggest which to improve
```

## Vault paths

- Outcome logs: `{vault}/daily/skill-outcomes/`
- Grill sessions: `{vault}/daily/grill-sessions/`
- Aha moments: `{vault}/thinking/aha/`
- Reports: `{vault}/daily/improve-reports/`

---

## Phase 1 — Collect signals (deterministic)

When invoked without a skill name, scan all outcome logs, rank skills by `partial` + `fail` rate, and recommend the top candidate. Stop and report.

When invoked with a skill name:

1. **Read outcome log** at `{vault}/daily/skill-outcomes/{skill}.log`
   - Format: `date | skill | action | source_repo | output_path | commit:hash | result`
   - result = `pass`, `partial`, or `fail`
   - If no log exists, report "no outcome data yet" and stop

2. **Scan grill sessions** — grep `{vault}/daily/grill-sessions/` for mentions of the skill name

3. **Scan aha moments** — grep `{vault}/thinking/aha/` for mentions of the skill name

4. **Detect user corrections via git diff** — for each outcome log entry with a commit hash:
   - In the repo that contains the output file, check if the same file was modified in a later commit by the user (not by the skill)
   - If yes, `git diff <skill-commit>..<user-commit> -- <output_path>` to capture what changed
   - **Filter cosmetic diffs:** skip entries where the diff is only whitespace, typos, or formatting. Only keep substantive content changes (added/removed paragraphs, reworded arguments, structural changes).

---

## Phase 2 — Extract patterns (latent — use judgment)

Read all collected signals. Synthesize into patterns:

- What does the skill consistently get wrong?
- What do user corrections have in common?
- What did grill sessions or aha moments flag?

Write each pattern as: `Pattern: <what happens> → <what user wants instead>`

---

## Phase 3 — Generate evals from corrections (deterministic)

For each substantive user correction found in Phase 1:

1. Extract the original prompt/input that triggered the skill (from git log message or outcome log)
2. The skill's output = the failing case
3. The user's corrected version = the expected output
4. Generate an assertion from the diff pattern (e.g., "must include company-specific example", "must not name frameworks by author")

Write evals to `evals/evals.json` in the skill's source directory. Append to existing evals, don't overwrite.

---

## Phase 4 — Improve the skill (latent + deterministic)

1. **Locate the skill source** — read the `source_repo` field from the outcome log. The SKILL.md to edit is at `{source_repo}/skills/{skill}/SKILL.md`
2. **Run existing evals** as "before" baseline. Record pass count.
3. **Git tag** `pre-improve-vN` in the source repo (N = increment from last tag)
4. **Edit SKILL.md** — translate patterns into new rules or gotchas. Add to the appropriate section. Don't restructure the entire skill — surgical additions only.
5. **Run evals again** as "after". Record pass count.
6. **Eval gate:**
   - If after >= before → keep changes, commit with message `improve: {skill} — {one-line summary}`
   - If after < before → `git checkout -- skills/{skill}/SKILL.md`, report what was tried and why it failed

---

## Phase 5 — Report

Write report to `{vault}/daily/improve-reports/{date}-{skill}.md`:

```markdown
# Improve Report: {skill} — {date}

## Signals analyzed
- {N} outcome log entries ({X} partial, {Y} fail, {Z} pass)
- {N} grill sessions mentioning {skill}
- {N} aha moments mentioning {skill}
- {N} user corrections detected

## Patterns found
- Pattern: {description} ({N} occurrences)

## Changes made
- {what was added/modified in SKILL.md}

## Eval results
- Before: {X}/{Y} pass ({percent}%)
- After: {X}/{Y} pass ({percent}%)
- Decision: KEPT / REVERTED

## Auto-generated evals
- {N} new eval cases added from user corrections
```

Commit and push the report to the vault.

---

## Gotchas

- NEVER edit installed plugin copies (`~/.claude/plugins/`). Always edit the source repo. The `source_repo` field in the outcome log points to the right place.
- When editing SKILL.md, keep changes surgical. Don't rewrite sections that aren't related to the patterns found.
- The eval gate is non-negotiable. If evals drop, revert. No exceptions.
- A skill with zero outcome log entries has nothing to improve — say so and stop. Don't hallucinate patterns.

---

## Outcome logging convention

After building or modifying this skill, update `skill-spec.md` to include the outcome logging convention so all future skills inherit it.
