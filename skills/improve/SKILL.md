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
   - Format: `date | skill | action | source_repo | output_path | commit:hash | result [| key=value ...]`
   - 7 required pipe-delimited fields, then optional trailing `key=value` fields (also pipe-delimited)
   - result = `pass`, `partial`, or `fail`
   - Optional trailing fields (per `skill-spec.md § 11`):
     - `corrections=N` → weight signal: higher N = stronger failure pattern, prioritize in Phase 2
     - `args="..."` → original input/topic — replay as eval case in Phase 3
     - `score=N.N` → rubric score from evaluator skill — correlate with result (partial+score=9.5 differs from partial+score=6.1)
     - `interrupt="..."` → user-stated reason for stopping — feed into Phase 2 as explicit failure reason
   - Unknown keys are ignored (forward-compat for future fields)
   - If trailing fields are absent, parse the 7 required fields only (backwards-compat with old log lines)
   - If no log exists, report "no outcome data yet" and stop

2. **Read trace files** (if available) at `{vault}/daily/skill-traces/{skill}.jsonl`
   - JSONL format: each line is a tool call record with `ts`, `event`, `tool`, `session`, `input` fields
   - Use traces to understand behavioral patterns: which tools the skill calls, in what order, and what inputs it uses
   - Correlate trace sessions with outcome log entries by timestamp proximity
   - If no trace file exists, skip — traces are supplementary, not required

3. **Scan grill sessions** — grep `{vault}/daily/grill-sessions/` for mentions of the skill name

4. **Scan aha moments** — grep `{vault}/thinking/aha/` for mentions of the skill name

5. **Detect user corrections via git diff** — for each outcome log entry with a commit hash:
   - In the repo that contains the output file, check if the same file was modified in a later commit by the user (not by the skill)
   - If yes, `git diff <skill-commit>..<user-commit> -- <output_path>` to capture what changed
   - **Filter cosmetic diffs:** skip entries where the diff is only whitespace, typos, or formatting. Only keep substantive content changes (added/removed paragraphs, reworded arguments, structural changes).

---

## Phase 2 — Extract patterns (latent — use judgment)

Read all collected signals. Synthesize into patterns:

- What does the skill consistently get wrong?
- What do user corrections have in common?
- What did grill sessions or aha moments flag?
- Weight by `corrections=N` — entries with higher N represent stronger failure signals
- Use `interrupt="..."` values as explicit failure reasons (user told you what went wrong)
- Use `score=N.N` to distinguish severity: a `partial` with score 9.0 is cosmetic; a `partial` with score 5.0 is structural
- Cross-reference trace files for behavioral patterns (e.g., skill always calls tool X before failing)

### Trace-based process detectors

When trace data exists, run these detectors against the JSONL tool-call sequence. Each detector is an IF/THEN rule — if the condition matches, emit a pattern. Weight trace-derived patterns **lower than direct user corrections** (`corrections=N`) but **higher than zero-signal inference**.

If no trace file exists, skip this subsection entirely — Phase 2 still works from outcome logs alone.

**Detector 1 — Skipped vault-first lookup**
IF trace shows `WebSearch` or `WebFetch` tool calls WITHOUT a prior `Grep` or `Read` targeting vault paths (e.g., `~/work/brain/`, `{vault}/`)
THEN → `Pattern: skill searches web before checking vault → should grep vault first per brain-first lookup rule`

**Detector 2 — Over-read context**
IF trace shows ≥10 `Read` calls in a single session, OR any `Read` call with line range >500 lines, OR repeated reads of the same file
THEN → `Pattern: skill reads excessive context ({N} reads / {M} lines) → should read targeted sections only`

**Detector 3 — Skipped research before action**
IF trace shows `Edit` or `Write` calls WITHOUT prior `Read`/`Grep`/`Glob` calls for spec or reference files in the same skill directory
THEN → `Pattern: skill jumps to editing without reading specs/references → should consult skill references before producing output`

**Detector 4 — Missing spec consultation**
IF the skill has `references/` files and trace shows zero `Read` calls to any file under `skills/{skill}/references/`
THEN → `Pattern: skill ignores its own reference files → should read references/ before generating output`

New detectors can be added following the same IF/THEN format.

Write each pattern as: `Pattern: <what happens> → <what user wants instead>`

### Trace-based process failure detection

When trace data exists (`{vault}/daily/skill-traces/{skill}.jsonl`), scan for these process-shaped failures. Each detector walks the tool_call events within a single session in chronological order.

1. **Skipped vault-first grep** — `WebFetch`, `WebSearch`, or `Agent` tool_calls appear before any `Grep` or `Read` targeting vault paths (`{vault}/` or `~/work/brain/`). Emit: `Pattern: makes external calls before grepping vault → must search vault first`

2. **Over-read context** (heuristic) — same file path appears in multiple consecutive `Read` tool_calls within one session, suggesting the skill scanned a large file in parts instead of reading a targeted section. This is a heuristic signal, not definitive — flag but don't weight heavily. Emit: `Pattern: reads same file repeatedly → should use targeted offset/limit reads`

3. **Skipped grill step** — the skill's SKILL.md includes a grill/Q&A phase, but no `Skill` tool_call with `input.skill` containing `"grill"` appears in the trace session before output-producing tool_calls (`Write`, `Edit`). Emit: `Pattern: produces output without grill → must run grill before generating`

4. **Missing spec sections** (output inspection, not trace) — compare the skill's output artifact against required section headers in the skill's own SKILL.md. If the SKILL.md defines `## Section` headers in its output template and the output file is missing any, flag it. This uses the output file, not the trace. Emit: `Pattern: output missing required section "{name}" → must include all spec sections`

**Scoring**: trace-detected patterns are supplementary signals. Weight them below outcome-log corrections and user interrupts. A trace pattern alone does not justify a SKILL.md edit — it must co-occur with at least one outcome-log signal (partial/fail result, correction, or interrupt).

---

## Phase 3 — Generate evals from corrections (deterministic)

For each substantive user correction found in Phase 1:

1. Extract the original prompt/input that triggered the skill — prefer `args="..."` from the outcome log (exact input), fall back to git log message
2. The skill's output = the failing case
3. The user's corrected version = the expected output
4. Generate an assertion from the diff pattern (e.g., "must include company-specific example", "must not name frameworks by author")

Write evals to `evals/evals.json` in the skill's source directory. Append to existing evals, don't overwrite.

---

## Phase 4 — Improve the skill via variant generation (latent + deterministic)

1. **Locate the skill source** — read the `source_repo` field from the outcome log. The SKILL.md to edit is at `{source_repo}/skills/{skill}/SKILL.md`
2. **Run existing evals** as "before" baseline. Record pass count.
3. **Git tag** `pre-improve-vN` in the source repo (N = increment from last tag)
4. **Save the original SKILL.md** content (the pre-edit version) for revert and diff sizing

### Variant generation (3-5 candidates)

Generate 3-5 candidate SKILL.md edits, each addressing the Phase 2 patterns via a different mutation strategy. Hold each candidate as complete SKILL.md text **in memory** — do NOT write any candidate to disk until a winner is selected.

**Mutation strategies** — pick 3-5 that best fit the patterns:

| Strategy | What it does |
|----------|-------------|
| **Narrow rule** | Add a single, specific rule targeting the exact failure pattern |
| **Broad principle** | Add a general principle covering this and adjacent failure modes |
| **Gotcha addition** | Add to the Gotchas section as a warning/anti-pattern |
| **Example-based** | Add a concrete before/after example showing wrong vs. right behavior |
| **Restructure** | Move/merge existing rules to better cover the gap |

Each candidate must use a meaningfully different strategy — not cosmetic rephrasing of the same rule. Keep all changes surgical — only add/modify lines that address the patterns.

**Minimum 3 candidates required.** Generate up to 5 when patterns are complex or when multiple strategies clearly apply.

### Evaluate and select

5. **Evaluate each candidate in memory** — load `evals/evals.json`, check each expectation string against each candidate's text (same text-search logic as `/eval`). Record pass count per candidate. Do NOT write candidates to disk for eval — the expectation check is a string match, not a runtime test.
6. **Rank candidates** by selection criteria (in priority order):
   - **Eval pass count** — must be >= before baseline (hard gate, disqualifies if not met)
   - **Minimal diff size** — `diff <original> <candidate> | wc -l` — prefer surgical changes
   - **Pattern coverage** — count how many Phase 2 patterns each candidate addresses
7. **Tiebreaker:** if multiple candidates tie on all three criteria, prefer the candidate with the smallest absolute file size (less bloat)

### Eval gate

8. **Select the winning candidate** — highest-ranked variant that passes the eval gate
9. **If NO candidate passes** (all have eval count < before) → `git checkout -- skills/{skill}/SKILL.md`, report what was tried and why all variants failed
10. **If winner found** → apply that candidate's SKILL.md, commit with message `improve: {skill} — {one-line summary}`
11. **Record in report** — which variants were generated, their eval scores, diff sizes, and which was selected (or that all were rejected)

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

## Variant evaluation
| Variant | Strategy | Eval pass | Diff lines | Patterns covered | Selected |
|---------|----------|-----------|------------|------------------|----------|
| V1 | {axes used} | {X}/{Y} | {N} | {N}/{total} | {yes/no} |
| V2 | ... | ... | ... | ... | ... |

## Eval results
- Before: {X}/{Y} pass ({percent}%)
- After (winner): {X}/{Y} pass ({percent}%)
- Candidates tested: {N}
- Candidates passing gate: {N}
- Decision: KEPT (V{N}) / REVERTED (all failed)

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

## Outcome log

Follow `skill-spec.md § 11`. Append to `{vault}/daily/skill-outcomes/improve.log`:

```
{date} | improve | improve | ~/work/brain-os-plugin | daily/improve-reports/{date}-{skill}.md | commit:{hash} | {result}
```

- `result`: `pass` if evals improved and changes kept, `partial` if changes reverted (evals dropped), `fail` if no outcome data
- Optional: `args="{skill-name}"`, `score={after_pass}/{after_total}`
