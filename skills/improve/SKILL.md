---
name: improve
description: |
  Analyze skill outcomes and user corrections to propose self-improvements. Use when a skill's output repeatedly needs manual fixes, after a grill session surfaces skill weaknesses, or on a schedule to continuously improve skill quality. Triggers on: improve, skill learning, why does this skill keep getting it wrong, make this skill better.
---

# Improve — Skill Learning Loop

## Usage

```
/improve <skill-name>        # Improve a specific skill (Phase 1–5, from outcome logs)
/improve                     # Scan all outcome logs, rank by error rate, suggest which to improve
/improve feedback            # Scan daily/feedback-pending/, encode each rule into target skill (Phase 0)
```

## Clarifications

Answers to the five most common questions about `/improve` behavior — answer inline so nobody has to ask twice.

### Cadence — when does /improve run?

Three modes:
- **Auto-per-run** — skills auto-invoke `/improve {skill}` immediately after appending an outcome log line with `result != pass`. No user confirmation. See `skill-spec.md § 11 Auto-improve rule`.
- **Scheduled batch** — daily cron (currently `trig_0183t3F6yec8NsdF6faNVn2m` at 6:07am) runs Phase 0 first (feedback-pending encode), then scans outcome logs, ranks by error rate, picks top candidate, and runs full Phase 1–5.
- **Manual** — user invokes `/improve <skill>` ad hoc to force a learning pass. `/improve feedback` runs Phase 0 only.

### Signals — what counts as evidence?

Five sources, processed in Phase 1 in this order:
1. **Outcome logs** (primary) — `{vault}/daily/skill-outcomes/{skill}.log`. `corrections=N` and `interrupt="..."` are strongest direct signals.
2. **Trace JSONL files** — `{vault}/daily/skill-traces/{skill}.jsonl`. Behavioral patterns (tool-call sequences). Supplementary weight.
3. **Grill sessions** — `{vault}/daily/grill-sessions/`. Clarifying questions about the skill = underspec signal (see Phase 1 step 3).
4. **Aha moments** — `{vault}/thinking/aha/`. User-recorded insights mentioning the skill.
5. **User corrections via git diff** — detected against the skill's anchor commit. Substantive content changes only (whitespace/typos filtered).

Weight order: direct corrections > interrupts > partial+low score > trace patterns. Trace patterns must co-occur with an outcome-log signal to justify a SKILL.md edit.

### Auto-apply vs review — does a human gate the change?

**Full auto. No human-in-loop by default.**

Safety relies on the Phase 4 eval gate, not human review:
- Phase 4 step 8–9: if no variant meets or exceeds the before-baseline eval pass count → `git checkout -- skills/{skill}/SKILL.md` and revert everything.
- Commit messages are descriptive so the user can revert after the fact if they disagree with a kept variant.
- Manual review mode is NOT supported. Do not add one — the eval gate is the safety net. Adding optional review flags reintroduces ambiguity about when they apply.

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
- **Feedback queue:** `{vault}/daily/feedback-pending/` (input) + `{vault}/daily/feedback-encoded/` (archive)

---

## Phase 0 — Encode pending feedback (deterministic scan + latent encoding)

Phase 0 runs **before** Phase 1 in the daily cron and when invoked via `/improve feedback`. Skip entirely when `daily/feedback-pending/` contains no files other than `README.md`.

Explicit user feedback is higher-signal than log-derived patterns — it's a direct rule the user wants enforced, not an inferred hypothesis. Phase 0 translates each pending file into code in its target skill, validates via the skill's eval suite, and archives the file on success. No LLM judgment about *what* the rule should be; only about *where* and *how* to encode it.

### Step 0.1 — Collect pending files

```bash
find {vault}/daily/feedback-pending -maxdepth 1 -name '*.md' ! -name 'README.md' | sort
```

Zero files → stop. Report "no pending feedback" and exit Phase 0.

### Step 0.2 — Per file, resolve target

Parse frontmatter:
- `target_skill` (REQUIRED) → locate `<source-repo>/skills/<target_skill>/SKILL.md`. Source-repo resolution follows the installed-plugin convention (e.g., `target_skill: gmail-triage` → `~/work/brain/commands/gmail-triage.md` for vault-level skills OR `~/work/brain-os-plugin/skills/gmail/SKILL.md` for plugin skills; resolver reads `source_repo` hints in the skill itself or walks known roots).
- `target_path` (OPTIONAL) → exact file the encoding goes into; overrides the default SKILL.md.

Missing / unresolvable `target_skill` → flip `status: stale` in frontmatter with `stale_reason: "unresolved target_skill"`, leave in pending/, notify user, skip to next file.

### Step 0.3 — Latent: propose encoding

**Scope validation first.** Before proposing the encoding, validate that the declared `target_path` matches the rule's actual scope. Mis-routed rules (a universal rule encoded into a single SKILL.md when the plugin has a shared-reference layer) create SSOT violations — sibling skills that should inherit the rule never see it. This check is defense-in-depth for upstream feedback-creation logic; when upstream classifies correctly the check is a no-op.

Skip scope validation when any of the following hold:

- `target_skill` is a list (e.g. `[fb-writer, substack-writer, news-analyst]`) — multi-skill declaration already signals universal intent.
- `target_path` resolves inside a `references/` directory — already routing to the shared layer.
- The target skill has no sibling `references/` directory (walk from `<source-repo>/skills/<target_skill>/` up one level and check `<source-repo>/references/`). No shared layer exists to route to.

Otherwise — target resolves to an individual `SKILL.md` AND a sibling `references/` exists — run the hybrid detector below.

**Deterministic scope detection:**

1. Locate the references dir by walking from `<source-repo>/skills/<target_skill>/` up one level to `<source-repo>/references/`.
2. Extract section titles from every `*.md` in that dir — grep `^##+ ` headers.
3. Normalize the rule body (Rule / Why / How to apply — **exclude** Suggested encoding, which often cross-references shared sections without making the rule universal) to lowercase.
4. For each section title, extract distinctive key terms (2+ word phrases, or single words longer than 4 chars that aren't common stopwords). Check whether any key term appears in the normalized rule body.
5. Distinct-section matches:
   - ≥2 distinct section titles matched → **likely universal**, flag scope mismatch.
   - Exactly 1 match → **inconclusive**, fall through to latent fallback.
   - Zero matches → **likely skill-specific**, no override.

**Latent fallback** (runs only when deterministic is inconclusive OR when references dir has fewer than 3 section titles to grep against):

Spawn an Agent sub-agent (`subagent_type: general-purpose`, model: sonnet) with this prompt:

> You are judging whether a feedback rule is UNIVERSAL (applies to every skill in a category and belongs in a shared reference file) or SKILL-SPECIFIC (only for one skill, belongs in its own SKILL.md).
>
> Reply strictly on line 1: `UNIVERSAL` or `SKILL-SPECIFIC`. One-sentence rationale on line 2. No other output.
>
> Rule body (Rule / Why / How to apply):
> ```
> {rule_body}
> ```
>
> Existing shared reference contents (what already lives in the shared layer for this plugin):
> ```
> {shared_reference_contents_truncated_to_4000_chars}
> ```
>
> Declared target: {target_path}

**Output handling:** first line must be exactly `UNIVERSAL` or `SKILL-SPECIFIC`. Malformed / non-conforming / empty → treat as `SKILL-SPECIFIC`. Conservative default — respect declared target when uncertain.

**Override policy:**

- `scope_detected: universal` + declared `target_path` = individual SKILL.md → **override**. Set `final_target_path` to the references file whose section titles matched (deterministic path) or to `references/shared-rules.md` if it exists (latent path), falling back to the references file with the most section titles overall.
- `scope_detected: skill-specific` → respect declared `target_path`, no override.
- `scope_detected: uncertain` (latent returned malformed or ambiguous) → respect declared `target_path`, no override, but record uncertainty for the Phase 5 report so routing drift is visible.

Record per-file into the Phase 5 report: `scope_declared`, `scope_detected`, `override_applied`, `final_target_path`.

---

Once `final_target_path` is resolved, propose the **smallest change** that enforces the rule at that path:

- **Spec-level rule** → bullet added to an existing section of the target file (SKILL.md, shared reference, or markdown spec file like `commands/gmail-triage.md`).
- **Deterministic pattern** (regex, filter, constant) → script edit (e.g. `scripts/foo.ts`, `lib/bar.ts`).
- **Acceptance case** → new fixture in the skill's eval suite (`evals/`, `commands/<skill>-evals/`).

If the file provides `Suggested encoding`, treat it as a strong hint — deviate only if it would produce a broken or dead change, OR if scope detection overrode the target (the suggested encoding location then points at the now-wrong file; re-derive for `final_target_path`). Otherwise, choose the location that makes the rule most enforceable at the skill's next invocation.

Keep the change surgical. Do not refactor surrounding code. Do not add comments that restate the rule — the pending-file Why/How-to-apply IS the explanation, and it will live permanently in `feedback-encoded/`.

### Step 0.4 — Deterministic: eval gate

Identify the skill's eval suite. Typical locations:
- Plugin skills: `{source-repo}/skills/<skill>/evals/evals.json` (run via `/eval <skill>` or `scripts/eval-<skill>.sh`).
- Vault-level commands: `{vault}/commands/<skill>-evals/` + `{vault}/scripts/eval-<skill>.sh`.

```bash
before_pass=$(run_eval | tee /tmp/improve-feedback-before.log | tail -1)
apply_change
after_pass=$(run_eval | tee /tmp/improve-feedback-after.log | tail -1)
```

- `after_pass >= before_pass` → encoding accepted.
- `after_pass < before_pass` → revert (`git checkout -- <changed files>`), flip `status: stale` with `stale_reason: "eval regression {before} → {after}"`, leave in pending/.

When the target skill has no eval suite, fall back to a spec-only check: apply the change, run the skill on a dry-run fixture if one exists, else accept the encoding but mark `eval_pass_after: n/a` in the archived frontmatter (so future readers know it was not regression-tested).

### Step 0.5 — Commit + archive

On accept:
1. Stage + commit the target-file edit with message `improve: encoded feedback — <slug> → <target_skill>`.
2. Rewrite the pending file's frontmatter:
   ```yaml
   status: encoded
   encoded_at: YYYY-MM-DD HH:MM
   encoded_in_commit: <short-sha>
   eval_pass_after: <N>/<M>
   scope_declared: <target_path as declared in pending frontmatter, or "n/a" if absent>
   scope_detected: universal | skill-specific | uncertain | skipped
   override_applied: true | false
   final_target_path: <path actually written to — equals scope_declared when override_applied=false>
   ```
   (`scope_detected: skipped` covers the short-circuits in Step 0.3 — list target, references target, no references dir.)
3. `mv` the file from `daily/feedback-pending/` to `daily/feedback-encoded/` (preserving filename). Commit the move.
4. Push both commits in one `git push` at the end of the phase.

### Step 0.6 — Report

Append one line per file to the Phase 5 report "Feedback encoded" table (and to the outcome log):

```
| <slug> | <target_skill> | encoded | <before>/<total> → <after>/<total> | <commit-sha> | <scope_declared> | <scope_detected> | <override_applied> | <final_target_path> |
| <slug> | <target_skill> | stale   | <reason> | — | <scope_declared> | <scope_detected> | false | <scope_declared> |
```

When `override_applied: true` the final_target_path differs from scope_declared — that is the signal upstream feedback-creation routed incorrectly. Track these counts in the outcome log via `scope_overrides={N}` so routing drift surfaces across runs.

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

Each candidate must use a meaningfully different strategy — not cosmetic rephrasing of the same rule. Keep all changes surgical — only add/modify lines that address the patterns.

**Minimum 3 candidates required.** Generate up to 5 when patterns are complex or when multiple strategies clearly apply.

### Evaluate and select

5. **Evaluate each candidate in memory** — load `evals/evals.json`, check each expectation string against each candidate's text (same text-search logic as `/eval`). Record pass count per candidate. Do NOT write candidates to disk for eval — the expectation check is a string match, not a runtime test.
6. **Gate 1 — Size limit (20KB)** — For each candidate, compute `byte-size(candidate)`. Disqualify any variant exceeding **20480 bytes**. Rationale: Anthropic SKILL.md best-practice caps skills at a scannable length; variants inflating past 20KB signal rule sprawl that a human should refactor, not auto-apply. Deterministic check — runs after in-memory eval, before ranking.
7. **Rank surviving candidates** by selection criteria (in priority order):
   - **Eval pass count** — must be >= before baseline (hard gate, disqualifies if not met)
   - **Minimal diff size** — `diff <original> <candidate> | wc -l` — prefer surgical changes
   - **Pattern coverage** — count how many Phase 2 patterns each candidate addresses
8. **Tiebreaker:** if multiple candidates tie on all three criteria, prefer the candidate with the smallest absolute file size (less bloat)

### Constraint gates

9. **Gate 2 — Semantic preservation (LLM judge)** — Walk the ranked list top-down. For each candidate, spawn an Agent sub-agent (`subagent_type: general-purpose`, model: sonnet) with this prompt:

   > You are judging whether a proposed edit to a skill's SKILL.md still matches the skill's **original trigger conditions**. The pre-edit frontmatter `description` field is the canonical trigger spec — Claude Code uses it to route invocations. Answer whether the candidate still matches those triggers, or whether it drifts into different skill territory.
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

## Feedback encoded (Phase 0)
| Slug | Target skill | Status | Eval | Commit | Scope declared | Scope detected | Override | Final target path |
|------|--------------|--------|------|--------|----------------|----------------|----------|-------------------|
| {slug} | {skill} | encoded | {before}/{total} → {after}/{total} | {sha} | {declared_path} | universal\|skill-specific\|uncertain\|skipped | true\|false | {final_path} |

## Scope overrides
- {N} feedback files had scope detected as universal but declared an individual SKILL.md target → routing was overridden to the shared reference layer. High counts signal upstream feedback-creation drift; companion issue tracks the upstream fix.
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

---

## Outcome log

Follow `skill-spec.md § 11`. Append to `{vault}/daily/skill-outcomes/improve.log`:

```
{date} | improve | {action} | ~/work/brain-os-plugin | {output_path} | commit:{hash} | {result}
```

- `action`: `improve` (Phase 1–5 single-skill), `feedback` (Phase 0 only), `rank` (no-arg rank-only report)
- `output_path`: `daily/improve-reports/{date}-{skill}.md` for improve/rank; `daily/feedback-encoded/` (or last archived slug) for feedback
- `result`: `pass` if evals improved and changes kept (or ≥1 feedback file encoded); `partial` if some changes reverted or some feedback stale; `fail` if all reverted, all stale, or no input data
- Optional: `args="{skill-name}"`, `score={after_pass}/{after_total}`, `encoded={N}/{M}` (feedback mode: N encoded of M pending), `scope_overrides={N}` (feedback mode: N files had target_path overridden by scope detection — see Phase 0.3)
