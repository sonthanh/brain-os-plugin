---
name: improve
description: |
  Analyze skill outcomes + user corrections để propose self-improvements. Triggers: 'improve', 'skill learning', 'why does this skill keep getting it wrong', '/improve [skill-name]'.
---

# Improve — Skill Learning Loop

## Usage

```
/improve <skill-name>        # Improve a specific skill (Phase 1–5, from outcome logs + description hygiene)
/improve                     # Scan all outcome logs, rank by error rate, suggest which to improve
/improve memory              # Triage memory feedback inbox via 5-tier rubric (Phase 0 — Step 0.0/0.5/0.7 only)
```

Description hygiene is integrated into the per-skill flow — Phase 1 detects bloated frontmatter as one signal source, Phase 4 generates a "description trim" mutation strategy alongside the other strategies, and the existing semantic-judge gate verifies trigger preservation. There is no separate `/improve descriptions` sub-mode; every per-skill run includes the hygiene check.

## Clarifications

Answers to the five most common questions about `/improve` behavior — answer inline so nobody has to ask twice.

### Cadence — when does /improve run?

Three modes:
- **Auto-per-run** — skills auto-invoke `/improve {skill}` immediately after appending an outcome log line with `result != pass`. No user confirmation. See `skill-spec.md § 11 Auto-improve rule`.
- **Scheduled batch** — daily cron at 20:00 local (`com.brain.improve` plist) runs Phase 0 first (`/improve memory` triage + index reconcile + expiry), then scans outcome logs, ranks by error rate, picks top candidate, and runs full Phase 1–5 if weekly quota allows.
- **Manual** — user invokes `/improve <skill>` ad hoc to force a learning pass. `/improve memory` runs Phase 0 (Step 0.0 + 0.5 + 0.7) only.

### Signals — what counts as evidence?

Six sources, processed in Phase 1 in this order:
1. **Outcome logs** (primary) — `{vault}/daily/skill-outcomes/{skill}.log`. `corrections=N` and `interrupt="..."` are strongest direct signals.
2. **Trace JSONL files** — `{vault}/daily/skill-traces/{skill}.jsonl`. Behavioral patterns (tool-call sequences). Supplementary weight.
3. **Grill sessions** — `{vault}/daily/grill-sessions/`. Clarifying questions about the skill = underspec signal (see Phase 1 step 3).
4. **Aha moments** — `{vault}/thinking/aha/`. User-recorded insights mentioning the skill.
5. **User corrections via git diff** — detected against the skill's anchor commit. Substantive content changes only (whitespace/typos filtered).
6. **Frontmatter description bloat** — static check on `skills/{skill}/SKILL.md` frontmatter. Char-count floor via `scripts/scan-skill-descriptions.py`. Always runs (no outcome data needed); contributes a "description bloated" pattern to Phase 2 → triggers a "description trim" mutation strategy in Phase 4.

Weight order: direct corrections > interrupts > partial+low score > trace patterns. Trace patterns must co-occur with an outcome-log signal to justify a SKILL.md edit. Description bloat is independent — it can run on its own (no other signal needed), and produces a frontmatter-only candidate that the semantic-judge will route through normally.

### Auto-apply vs review — does a human gate the change?

**Full auto. No human-in-loop by default.**

Safety relies on the Phase 4 eval gate, not human review:
- Phase 4 step 8–9: if no variant meets or exceeds the before-baseline eval pass count → `git checkout -- skills/{skill}/SKILL.md` and revert everything.
- Commit messages are descriptive so the user can revert after the fact if they disagree with a kept variant.
- Manual review mode is NOT supported. Do not add one — the eval gate is the safety net. Adding optional review flags reintroduces ambiguity about when they apply.

**Description trim variants follow the same Phase 4 gate as every other variant.** The Phase 4 semantic-preservation judge already checks that a candidate's frontmatter matches the pre-edit description's trigger conditions — that is the trigger-preservation gate. If a description trim would silently drop a routing keyword, the judge returns FAIL, the variant is dropped, and Phase 4's standard revert protocol applies. No separate carve-out; the existing eval gate is the safety net.

### Scope — single skill or all?

- `/improve <skill>` → full Phase 1–5 on that skill only.
- `/improve` (no arg) → Phase 1 rank-only: scans all logs, recommends top candidate, **stops and reports**. Does NOT auto-run Phase 2–5.
- Daily cron batch orchestrates: it runs `/improve` no-arg first to pick the top skill, then separately invokes `/improve <top>` with the chosen argument. Each log entry therefore records a specific skill in the `args="..."` field.

### Optional log fields — how to add one without breaking the parser?

Outcome log format: **7 required pipe-delimited fields** + optional trailing `key=value` pairs (also pipe-delimited). Parser in Phase 1 step 1 ignores unknown keys (forward-compat).

Procedure to add a new optional field:
1. Add to the canonical optional-fields table in `skill-spec.md § 11` — single source of truth.
2. Update Phase 2 logic to consume the field when it informs pattern extraction.
3. Existing logs without the new field continue to parse — no backfill needed.

**Never** change the 7 required fields or their order. That WILL break every prior log line.

## Vault paths

- Outcome logs: `{vault}/daily/skill-outcomes/`
- Grill sessions: `{vault}/daily/grill-sessions/`
- Aha moments: `{vault}/thinking/aha/`
- Reports: `{vault}/daily/improve-reports/`
- **Memory feedback inbox:** `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/<vault>/memory/feedback_*.md` and any sibling account directories under `~/.claude*/` — auto-loaded by Claude Code at session start; typically symlinked across accounts to share one physical dir. `/improve memory` triages each entry into the 5-tier rubric below and removes the source on encoding. Source feedback memory files are deleted (not archived) — git history preserves the rationale because each encoding commits the original rule body + Why + How-to-apply (see Step 0.0).

---

## Phase 0 — Memory triage + index reconcile + expiry (`/improve memory`)

Phase 0 runs **before** Phase 1 in the daily cron and when invoked via `/improve memory`. The three steps below are deterministic to set up and idempotent — empty memory dir → no-op. Latent judgment is required only when the rubric (Step 0.0) needs to classify a rule into a tier; everything else is mechanical.

The 5-tier triage rubric replaces the prior `feedback-pending/` pipeline. Memory is now the single inbox for behavioral feedback the user gives mid-conversation. `/improve memory` triages each entry into the right artifact (hook / skill / `.claude/rules/` / CLAUDE.md / memory-stay), encodes it there, deletes the source file, and rebuilds the MEMORY.md index.

### Step 0.0 — Triage (5-tier rubric)

#### Collect feedback files

Glob across all Claude account directories on the machine, then realpath-dedupe so any symlinks between accounts don't double-process the same physical file:

```bash
shopt -s nullglob
declare -A SEEN
for f in ~/.claude*/projects/*/memory/feedback_*.md; do
  canon=$(/usr/bin/python3 -c "import os,sys;print(os.path.realpath(sys.argv[1]))" "$f")
  [[ -z "${SEEN[$canon]:-}" ]] && SEEN[$canon]=1 && printf '%s\n' "$canon"
done | sort
```

Zero feedback files → skip Step 0.0; proceed to Step 0.5 (index reconcile is still useful for cleaning stale MEMORY.md entries).

#### Walk the rubric per file (top-to-bottom, first match wins)

For each canonical feedback file, read its frontmatter (`name`, `description`, `type`) and body (the rule + Why + How-to-apply), then walk the decision tree:

1. **Can the violation be detected by inspecting tool inputs / outputs deterministically?** → **HOOK** (`PreToolUse` or `PostToolUse`). Compliance: hard. *Encoding:* write a new shell script under `~/.claude/hooks/<descriptive-name>.sh` that exits non-zero (PreToolUse) or warns (PostToolUse) when the violation pattern matches. Register it in `~/.claude/settings.json` `hooks.{PreToolUse|PostToolUse}` matching the relevant tool (Write/Edit/Bash/etc.). Test: the hook should fire on a planted violation and pass on a clean call.

2. **Is the rule a multi-step workflow or behavioral procedure?** → **SKILL** (with evals). Compliance: encoded steps. *Encoding:* invoke `/skill-creator` interactively if a new skill is needed, OR — for an addition to an existing skill — edit the appropriate `~/work/<plugin>/skills/<name>/SKILL.md` plus add a matching case to `evals/evals.json` (coverage-parity additions, mirroring the existing pattern). When auto-running from cron and the rule maps to an existing skill, take the surgical edit path; when it implies a brand-new skill, queue the case as `type:human-review` (skill creation needs an interactive grill — see `~/work/brain/working-rules.md` and the project CLAUDE.md owner-label rule).

3. **Is the rule path-scoped (only relevant in certain dirs / file types)?** → **`.claude/rules/<topic>.md`** with `paths:` frontmatter. Compliance: soft (advisory) — Claude only loads it when reading matching files. *Encoding:* write `~/.claude/rules/<topic>.md` with frontmatter listing the `paths:` glob and the rule body. Conserves global context — the rule lives off the always-on stack.

4. **Is the rule cross-cutting global guidance committed long-term?** → **CLAUDE.md** (project or user). Compliance: soft. *Encoding:* append a section to `~/.claude/CLAUDE.md` (user-global) or `<project>/CLAUDE.md` (project-scoped). Keep it short — CLAUDE.md is loaded into every conversation.

5. **Default — none of the above match?** → **MEMORY-STAY**. Compliance: soft, accepted. *Encoding:* leave the file in place; ensure frontmatter has `last_validated: <today-ISO>` (add if missing). The rule remains as auto-loaded soft guidance.

#### Confidence routing

For each file, output one of:
- `tier: <hook|skill|rules|claude-md|memory>` + `confidence: high` → encode immediately.
- `tier: ambiguous` → file a `type:human-review` issue in the configured task repo with a rubric trace + classification proposal. The user triages, closes the issue → next `/improve memory` run encodes per their choice.

Treat as ambiguous when (a) two tiers both fit (e.g., a workflow rule that's also path-scoped), (b) the rule is too vague to act on, or (c) the encoding step would need design judgment beyond the rubric (e.g., new-skill creation, hook design touching multiple tools).

#### Encoding execution

For high-confidence cases, perform the encoding action for the chosen tier (above), then in a single git commit:
1. Stage the encoding artifact (new hook script, edited skill SKILL.md + evals.json, new `.claude/rules/` file, or CLAUDE.md edit).
2. **Delete the source memory feedback file** (`rm <canonical_path>`).
3. Commit with message `improve: encoded memory feedback — <slug> → <tier>` and a body that quotes the original rule's full text + Why + How-to-apply (the rationale survives source deletion).

Memory dirs are NOT git-tracked, so the deletion is a filesystem rm — no git stage needed for it. The commit captures only the encoding artifact + (for any vault-side artifacts) any vault changes.

#### Failure handling

- Encoding step errors (e.g., hook script syntax invalid, skill eval regresses) → leave source memory file in place, file a `type:human-review` issue with the failure detail, continue to next file.
- The skill-tier path may need to run the target skill's eval suite; if eval regresses (`after_pass < before_pass`), `git checkout --` the encoding change and treat as failure.
- Push commits at the end of the phase (one `git push`).

### Step 0.5 — Index reconcile (rewrite MEMORY.md from disk)

Idempotent. Rebuilds `MEMORY.md` so the index always matches what's on disk in the canonical memory dir.

```bash
canonical_dir=$(/usr/bin/python3 -c "import os,sys;print(os.path.realpath(sys.argv[1]))" \
  "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/<vault-slug>/memory")
cd "$canonical_dir"
```

For each `*.md` file in the dir (excluding `MEMORY.md` itself):
1. Read the frontmatter `name` (or filename stem if missing) and `description`.
2. Emit one line: `- [<name>](<filename>) — <description>`.
3. Sort lines by filename for stable order.

Replace `MEMORY.md` content (preserving any standing footer note about the inbox model — keep the last italic line untouched if it begins with `_Memory feedback is the inbox`). Drop entries for files that no longer exist on disk. Do NOT touch the trailing footer note — it's user-maintained context.

### Step 0.7 — Expiry check (`last_validated:` > N days)

Surface stale memory entries for human-confirm-delete. Default `EXPIRY_DAYS=90`. Files without `last_validated:` are SKIPPED (lazy migration — files only get a `last_validated:` stamp when they are touched by Step 0.0 encoding or manually edited).

For each `*.md` file in the canonical memory dir:
1. Parse frontmatter `last_validated:` (ISO date `YYYY-MM-DD`).
2. Skip if missing.
3. Compute `today - last_validated` in days. If `> EXPIRY_DAYS`:
   - Add the filename + age to the Step 0.7 report.
   - File a `type:human-review` issue in `$GH_TASK_REPO` titled `Memory expiry: <filename> ({N} days since last_validated)` with body listing the file path + content + last-validated date. Label `status:ready` `priority:p3` `weight:quick` `owner:human` (memory deletion is a judgment call).
4. After the user closes the issue with `--reason completed`, the next `/improve memory` run reads the closed issue's title, deletes the matching memory file, and skips re-issuing.

**Telegram alert:** `improve-cron.sh` posts a single Telegram digest at the end of each daily run with: triaged count, encoded count, deleted count, expiry count. Routes via the same `send_telegram()` helper the cron already uses.

### Step 0.9 — Outcome metrics

Phase 0 emits these metrics for the cron log AND the outcome log line (see `## Outcome log` below):

```
step=0.0 triaged=<N> encoded=<N> deleted=<N> ambiguous=<N> failed=<N>
step=0.5 indexed=<N> dropped=<N>
step=0.7 expired=<N> issued=<N>
```

`triaged = encoded + ambiguous + failed`. `deleted` matches `encoded` for the high-confidence path (encoding succeeds → source removed); `ambiguous` and `failed` keep their files in place.

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

3. **Scan grill sessions** — grep `{vault}/daily/grill-sessions/` for mentions of the skill name.
   - **Clarifying-question detection** — for each match, check whether a `?` appears within 2 lines of the skill-name mention. Each detected question is an **underspec signal**: the user had to ask something SKILL.md should have answered inline.
   - Emit one pattern per detected question: `Pattern: user asked "<question text>" in grill <file> — answer belongs inline in SKILL.md`.
   - Weight: an underspec signal counts as a `corrections=1` equivalent for Phase 2 ranking.
   - Meta-case (`/improve` improving itself): questions about `/improve`'s own triggers, signals, auto/manual semantics, scope, or log fields all mean the Clarifications section is missing an answer — extend it, don't re-route to a reference file.

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
| **Description trim** | Replace the SKILL.md frontmatter description with a tighter version (≤ 300 chars) preserving routing keywords. Use when Phase 1 emits a `description is bloated` pattern. Variant body equals the pre-edit body — only frontmatter changes. The semantic-judge (Gate 2) verifies trigger preservation; no separate gate. |

Each candidate must use a meaningfully different strategy — not cosmetic rephrasing of the same rule. Keep all changes surgical — only add/modify lines that address the patterns.

**Minimum 3 candidates required** for behavioral patterns. **Description-trim variants are the exception**: when the *only* signal is description bloat (no outcome-log corrections, no traces, no grill questions), Phase 4 generates a single description-trim candidate and runs it through the gates — no need to fabricate alternative behavioral strategies. Generate up to 5 when patterns are complex or when multiple strategies clearly apply.

### Trim guidance for the Description trim strategy (latent — judgment)

When generating a description-trim candidate, preserve only **WHAT + WHEN + DIFFERENTIATOR**:

- **WHAT** — one phrase naming the primary action ("Test-driven development", "Capture key moments mid-session").
- **WHEN** — trigger keywords a user would type to invoke this skill: every quoted phrase (`'grill me'`, `"why is X broken"`), every backtick-quoted token (skill names, flags), and every imperative verb phrase ("Use when X", "Use khi Y", "Triggers on: Z"). The semantic-judge enforces preservation.
- **DIFFERENTIATOR** — one short clause distinguishing this skill from siblings ("Different from /improve (per-skill)", "Bài kinh nghiệm cá nhân → fb-writer").

**Move to SKILL.md body** if not already there: numbered workflow steps, technical thresholds duplicated from body, flag taxonomies, multi-paragraph elaboration. Most of this content already lives in the body — the description was duplicating it.

**Drop entirely**: hedge language ("comprehensive", "robust"), redundant phrasing, marketing decoration.

### Evaluate and select

5. **Evaluate each candidate in memory** — load `evals/evals.json`, check each expectation string against each candidate's text (same text-search logic as `/eval`). Record pass count per candidate. Do NOT write candidates to disk for eval — the expectation check is a string match, not a runtime test.
6. **Gate 1 — Size limit (20KB)** — For each candidate, compute `byte-size(candidate)`. Disqualify any variant exceeding **20480 bytes**. Rationale: Anthropic SKILL.md best-practice caps skills at a scannable length; variants inflating past 20KB signal rule sprawl that a human should refactor, not auto-apply. Deterministic check — runs after in-memory eval, before ranking.
7. **Rank surviving candidates** by selection criteria (in priority order):
   - **Eval pass count** — must be >= before baseline (hard gate, disqualifies if not met)
   - **Minimal diff size** — `diff <original> <candidate> | wc -l` — prefer surgical changes
   - **Pattern coverage** — count how many Phase 2 patterns each candidate addresses
8. **Tiebreaker:** if multiple candidates tie on all three criteria, prefer the candidate with the smallest absolute file size (less bloat)

### Constraint gates

9. **Gate 2 — Semantic preservation (LLM judge)** — Walk the ranked list top-down.

   **Short-circuit (deterministic):** if a candidate's full frontmatter block (everything between the opening `---` and the next `---`) is byte-identical to the pre-edit frontmatter, mark the semantic judge as PASS without spawning the Agent. Trigger routing is defined by `description`, `name`, and any other frontmatter keys Claude Code consumes — an unchanged frontmatter guarantees routing is preserved. Record in the Phase 5 report as `Semantic: PASS (short-circuit — frontmatter unchanged)` so the skip is auditable.

   **Full judge (when frontmatter changed, even whitespace):** spawn an Agent sub-agent (`subagent_type: general-purpose`, model: sonnet) with this prompt:

   > You are judging whether a proposed edit to a skill's SKILL.md still matches the skill's **original trigger conditions**. The pre-edit frontmatter `description` field is the canonical trigger spec — Claude Code uses it to route invocations by string-matching user input against text in the description.
   >
   > **Routing-surface preservation rule (non-negotiable):** Extract every single-quoted phrase (`'…'`), double-quoted phrase (`"…"`), and backtick-quoted token (`` `…` ``) from the pre-edit description. These — and ONLY these — are the routing surface; Claude Code matches user input against them verbatim. If ANY of these quoted/backticked tokens is missing from the candidate description (verbatim substring match), return FAIL. Unquoted prose, decorative adjectives, and explanatory clauses can be paraphrased, truncated, or dropped freely — they are not routing keywords. Semantic equivalence does not save a missing quoted token: a candidate that drops `'grill me'` but keeps `'stress-test this plan'` is FAIL even if the skill still does the same thing.
   >
   > Also FAIL if the candidate drifts into different skill territory (changes scope or primary action), even when all quoted tokens survive.
   >
   > Reply strictly `PASS` or `FAIL` on the first line, then a one-sentence rationale on the second line. No other output.
   >
   > Pre-edit frontmatter description (ANCHOR — do not treat the candidate's own frontmatter as the spec):
   > ```
   > {pre_edit_description}
   > ```
   >
   > Candidate SKILL.md (full text, including any mutated frontmatter):
   > ```
   > {candidate_full_text}
   > ```

   **Output handling:** first line must be exactly `PASS` or `FAIL`. Anything else (malformed, non-`PASS` text, empty) → treat as FAIL. Conservative default protects skill routing.

   First candidate returning `PASS` → select as winner. On `FAIL`, drop the candidate and re-judge the next-ranked one.

### Eval gate

10. **Apply winner** — write winning candidate's SKILL.md to disk, commit with message `improve: {skill} — {one-line summary}`.
11. **Revert if all fail** — If all candidates fail eval baseline, OR all are disqualified by the size gate, OR all remaining fail the semantic judge → `git checkout -- skills/{skill}/SKILL.md`, report which gate rejected which variant. Same revert protocol regardless of which gate tripped.
12. **Record in report** — which variants were generated, their eval scores, diff sizes, size-gate result, semantic-judge verdict + rationale, and which was selected (or that all were rejected).

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
| Variant | Strategy | Eval pass | Diff lines | Patterns covered | Size (bytes) | Size OK? | Semantic | Selected |
|---------|----------|-----------|------------|------------------|--------------|----------|----------|----------|
| V1 | {axes used} | {X}/{Y} | {N} | {N}/{total} | {bytes} | {yes/no} | {PASS/FAIL + rationale or skipped} | {yes/no} |
| V2 | ... | ... | ... | ... | ... | ... | ... | ... |

## Eval results
- Before: {X}/{Y} pass ({percent}%)
- After (winner): {X}/{Y} pass ({percent}%)
- Candidates tested: {N}
- Candidates passing gate: {N}
- Decision: KEPT (V{N}) / REVERTED (all failed)

## Auto-generated evals
- {N} new eval cases added from user corrections

## Memory triage (Phase 0)
| Slug | Tier | Confidence | Encoding artifact | Source deleted? | Commit |
|------|------|------------|-------------------|------------------|--------|
| {slug} | hook\|skill\|rules\|claude-md\|memory\|ambiguous | high\|low | {path written} | yes\|no | {sha or —} |

## Index reconcile + expiry
- Index reconcile: {N} entries written, {M} stale entries dropped from MEMORY.md.
- Expiry: {N} files past `last_validated:` threshold; {M} `type:human-review` issues filed.
- Ambiguous classifications: {N} files queued as `type:human-review` issues for user triage.
```

Commit and push the report to the vault.

---

## Gotchas

- NEVER edit installed plugin copies (`~/.claude/plugins/`). Always edit the source repo. The `source_repo` field in the outcome log points to the right place.
- When editing SKILL.md, keep changes surgical. Don't rewrite sections that aren't related to the patterns found.
- The eval gate is non-negotiable. If evals drop, revert. No exceptions.
- A skill with zero outcome log entries has nothing to improve — say so and stop. Don't hallucinate patterns.
- **Meta self-grilling signal** — if a grill session contains a clarifying question about `/improve`'s own mechanism (cadence, signals, auto-apply, scope, log fields), that's a direct signal the Clarifications section is underspecified. Patch the answer inline in SKILL.md, don't file it to a reference. Every user question answered inline = one future user doesn't need to ask.
- **Eval coverage audit before commit.** When /improve modifies a SKILL.md (added checks, expanded signatures, new rules), audit the skill's `evals/evals.json` in the same pass for coverage gaps: checks with zero matching evals, newly-expanded checks still covered only by pre-expansion evals, skew across checks. Add the missing evals in the SAME commit as the SKILL.md change — don't split. `pre-commit-eval-gap.sh` enforces this at repo level, but the audit here surfaces gaps before the hook blocks.
- **Learning loops derive from observable state, never user-edited markdown.** When /improve is recommending changes to a skill that carries a feedback mechanism (gmail-triage draft corrections, SLA feedback, classifier correction, any compounding self-learning loop), the input signal MUST be observable state — Gmail labels, message content diffs, API responses, file-presence checks — not a manually-edited `learnings.md` / `corrections.md` file. Users won't touch the file; the loop never closes; the value prop collapses. Redesign any proposal that requires the user to open and edit a file to close the loop. Ask first: "what does the user already do with their hands?" That is the input signal.

---

## Outcome log

Follow `skill-spec.md § 11`. Append to `{vault}/daily/skill-outcomes/improve.log`:

```
{date} | improve | {action} | ~/work/brain-os-plugin | {output_path} | commit:{hash} | {result}
```

- `action`: `improve` (Phase 1–5 single-skill), `memory` (Phase 0 only — triage + index reconcile + expiry), `rank` (no-arg rank-only report)
- `output_path`: `daily/improve-reports/{date}-{skill}.md` for improve/rank; `N/A` for memory mode (artifacts are spread across hooks/skills/rules/CLAUDE.md/issue queue and tracked per-commit)
- `result`: `pass` if evals improved and changes kept (improve) OR ≥1 memory file processed cleanly (memory); `partial` if some changes reverted, some memory triages routed to ambiguous, or some encodings failed; `fail` if all reverted, all stale, or no input data
- Optional: `args="{skill-name}"`, `score={after_pass}/{after_total}`, `desc_trim_applied=1` (Phase 4 description-trim variant won and was applied — a frontmatter-only Phase 4 outcome), `triaged={N}` (memory mode: total feedback files seen), `encoded={N}` (memory mode: encoded into a tier), `deleted={N}` (memory mode: source files removed), `ambiguous={N}` (memory mode: queued as human-review), `expired={N}` (memory mode: surfaced for confirm-delete)
