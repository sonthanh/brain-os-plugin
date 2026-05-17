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

### Cadence — when does /improve run?

Three modes:
- **Auto-per-run** — skills auto-invoke `/improve {skill}` after a `result != pass` outcome log line. No user confirmation.
- **Scheduled batch** — daily cron at 20:00 local runs Phase 0 first (`/improve memory`), then scans logs, picks top candidate, runs full Phase 1–5.
- **Manual** — user invokes `/improve <skill>` ad hoc. `/improve memory` runs Phase 0 (Step 0.0 + 0.5 + 0.7) only.

### Signals — what counts as evidence?

Six sources, processed in Phase 1 in this order:
1. **Outcome logs** (primary) — `corrections=N` and `interrupt="..."` are strongest signals
2. **Trace JSONL files** — behavioral patterns; supplementary weight
3. **Grill sessions** — clarifying questions as underspec signals
4. **Aha moments** — supplementary context, NOT a priority hint
5. **User corrections via git diff** — substantive content changes only; filter cosmetic diffs
6. **Frontmatter description bloat** — static check via `scripts/scan-skill-descriptions.py`. Always runs; no outcome data needed.

### Auto-apply vs review

**Full auto. No human-in-loop by default.** Safety relies on the Phase 4 eval gate. Manual review mode is NOT supported — the eval gate is the safety net.

**Description trim variants follow the same Phase 4 gate as every other variant.** The semantic-preservation judge verifies trigger routing via the trigger-preservation gate. No separate carve-out — the existing eval gate is the safety net.

### Scope

- `/improve <skill>` → full Phase 1–5 on that skill only.
- `/improve` (no arg) → Phase 1 rank-only: scans all logs, recommends top candidate, stops and reports. Does NOT auto-run Phase 2–5.
- Daily cron orchestrates: `/improve` no-arg first to pick skill, then `/improve <top>` separately.

### Optional log fields

**7 required pipe-delimited fields** + optional trailing `key=value` pairs. Parser ignores unknown keys (forward-compat). Never change the 7 required fields or their order — that breaks every prior log line.

---

## Phase 0 — Memory triage + index reconcile + expiry (`/improve memory`)

Phase 0 runs **before** Phase 1 in the daily cron and when invoked via `/improve memory`. Empty memory dir → no-op.

### Step 0.0 — Triage (5-tier rubric)

Glob `~/.claude*/projects/*/memory/feedback_*.md` across all Claude account dirs, then realpath-dedupe so symlinks between accounts don't double-process the same physical file. Zero feedback files → skip Step 0.0; proceed to Step 0.5.

**Walk the rubric per file** (top-to-bottom, first match wins):

1. **Deterministic tool-input/output violation?** → **HOOK** (`PreToolUse`/`PostToolUse`). Write `~/.claude/hooks/<name>.sh` + register in `~/.claude/settings.json`. Compliance: hard.

2. **Multi-step workflow or behavioral procedure?** → **SKILL** (with evals). Edit `skills/{name}/SKILL.md` + add matching evals. Compliance: encoded steps.

3. **Path-scoped rule (only relevant in certain dirs/file types)?** → **`.claude/rules/<topic>.md`** with `paths:` frontmatter. Compliance: soft.

4. **Cross-cutting global guidance, long-term?** → **CLAUDE.md** (project or user). Compliance: soft.

5. **Default — none of the above?** → **MEMORY-STAY**. Leave file in place; stamp `last_validated: <today>`.

**Confidence routing:** output `tier: <tier>` + `confidence: high` → encode immediately. OR `tier: ambiguous` → file `type:human-review` issue with a rubric trace + proposal. Treat as ambiguous when two tiers both fit, the rule is too vague, or encoding requires design judgment.

**Encoding execution:** stage the encoding artifact, then Delete the source memory feedback file (`rm <canonical_path>`). Commit with `improve: encoded memory feedback — <slug> → <tier>`. The rationale survives source deletion because the commit body quotes the original rule + Why + How-to-apply.

**Failure handling:** encoding error → leave source file in place; file `type:human-review` issue; continue.

### Step 0.5 — Index reconcile

Idempotent. Rebuilds `MEMORY.md` from disk: for each `*.md` in canonical memory dir (excluding `MEMORY.md`), read `name` + `description`, emit `- [<name>](<filename>) — <description>`, sorted by filename. Drop entries for files that no longer exist. Replace content while preserving any standing footer note beginning with `_Memory feedback is`.

### Step 0.7 — Expiry check

Surface stale memory entries. Default `EXPIRY_DAYS=90`. Files without `last_validated:` are SKIPPED (lazy migration).

For each `*.md`: parse `last_validated:` (ISO). If `> EXPIRY_DAYS` days old: file `type:human-review` issue titled `Memory expiry: <filename> ({N} days since last_validated)`. After user closes issue, next run deletes the file.

**Telegram alert:** post digest at end of each daily run via `send_telegram()`.

---

## Phase 1 — Collect signals

When invoked without a skill name: scan all outcome logs, rank by `partial` + `fail` rate, recommend top candidate. Stop and report.

When invoked with a skill name:

1. **Read outcome log** at `{vault}/daily/skill-outcomes/{skill}.log`
   - Format: `date | skill | action | source_repo | output_path | commit:hash | result [| key=value ...]`
   - 7 required pipe-delimited fields, then optional trailing `key=value` fields
   - result = `pass`, `partial`, or `fail`
   - Optional: `corrections=N`, `args="..."`, `score=N.N`, `interrupt="..."`
   - Parser ignores unknown keys (forward-compat). If no log exists, report "no outcome data yet" and stop.

2. **Read trace files** at `{vault}/daily/skill-traces/{skill}.jsonl` — supplementary; skip if absent.

3. **Scan grill sessions** — grep `{vault}/daily/grill-sessions/` for skill mentions. **Clarifying-question detection**: for each match, check whether `?` appears within 2 lines. Each detected question = an **underspec signal**. Meta-case: questions about `/improve`'s own mechanism → extend Clarifications section inline.

4. **Scan aha moments** — grep `{vault}/thinking/aha/` for skill mentions. Role: **supplementary context**, NOT a priority hint. Can surface test cases, priority signals, or framing context.

5. **Detect user corrections via git diff** — for each log entry with a commit hash, check if output file was modified in a later user commit. Filter cosmetic diffs; keep substantive content changes only.

6. **Frontmatter description bloat** — static check on `skills/{skill}/SKILL.md` via `scripts/scan-skill-descriptions.py`. Always runs; no outcome data needed. Emits "description is bloated" pattern if flagged.

**Six sources** total. Weight: direct corrections > interrupts > partial+low-score > trace patterns. Trace patterns must co-occur with an outcome-log signal to justify a SKILL.md edit.

---

## Phase 2 — Extract patterns

Synthesize signals: what does the skill consistently get wrong? What do corrections share? Weight by `corrections=N`; use `interrupt="..."` as explicit failure reason; use `score=N.N` to distinguish severity.

### Trace-based process detectors

When trace data exists, run these detectors on the JSONL tool-call sequence. Trace-derived patterns are supplementary — require co-occurrence with an outcome-log signal to justify a SKILL.md edit. Skip if no trace file.

**Detector 1 — Skipped vault-first:**
IF `WebSearch`/`WebFetch` before any `Grep`/`Read` targeting vault paths
→ `Pattern: makes external calls before grepping vault → must search vault first`
→ also: `skill searches web before checking vault → should grep vault first per brain-first lookup rule`

**Detector 2 — Over-read context:**
IF ≥10 `Read` calls in session, OR any `Read` >500 lines, OR same file read repeatedly
→ `Pattern: reads same file repeatedly → should use targeted offset/limit reads`
→ also: `skill reads excessive context → should read targeted sections only`

**Detector 3 — Skipped grill:**
IF skill SKILL.md defines a grill phase AND no `Skill` call with `"grill"` in input appears before `Write`/`Edit`
→ `Pattern: produces output without grill → must run grill before generating`
→ also: `skill jumps to editing without reading specs/references → should consult skill references before producing output`

**Detector 4 — Missing spec consultation:**
IF skill has `references/` files AND trace shows zero `Read` calls to any `references/` file
→ `Pattern: skill ignores its own reference files → should read references/ before generating output`

Write each pattern as: `Pattern: <what happens> → <what user wants instead>`

---

## Phase 3 — Generate evals

For each substantive user correction from Phase 1:
1. Extract original prompt/input — prefer `args="..."` from log; fall back to git log message.
2. Skill's output = failing case. User's correction = expected output.
3. Generate assertion from diff pattern.

Append to `evals/evals.json` in skill's source directory. Don't overwrite existing evals.

---

## Phase 4 — Improve the skill via variant generation

1. **Locate skill source** — read `source_repo` from outcome log. SKILL.md: `{source_repo}/skills/{skill}/SKILL.md`.
2. **Run existing evals** as "before" baseline. Record pass count.
3. **Git tag** `pre-improve-vN` in source repo.
4. **Save original SKILL.md** content for revert and diff sizing.

### Variant generation (3-5 candidates)

Generate 3-5 candidate edits addressing Phase 2 patterns via different mutation strategies. Hold in memory as complete SKILL.md text — Do NOT write candidates to disk until winner selected.

**Mutation strategies:**

| Strategy | What it does |
|----------|-------------|
| **Narrow rule** | Add one specific rule targeting the exact failure pattern |
| **Broad principle** | Add a general principle covering this and adjacent failures |
| **Gotcha addition** | Add to Gotchas section as warning/anti-pattern |
| **Example-based** | Add concrete before/after example |
| **Restructure** | Move/merge existing rules to better cover the gap |
| **Description trim** | Replace frontmatter description with tighter version ≤ 300 chars preserving routing keywords. Verified by semantic-judge (Gate 2). Body unchanged — frontmatter only. |

Each candidate must use a meaningfully different strategy. **Minimum 3 candidates required** for behavioral patterns. **Description-trim variants are the exception**: when the *only* signal is description bloat (no corrections, no traces, no grill questions), Phase 4 generates a single description-trim candidate and runs it through the gates.

**Trim guidance for the Description trim strategy:** preserve **WHAT + WHEN + DIFFERENTIATOR**. Move workflow steps and multi-paragraph elaboration to SKILL.md body. The semantic-judge enforces preservation of all routing keywords.

### Evaluate and select

5. **Evaluate each candidate in memory** — load `evals/evals.json`, check each expectation string against candidate text (text-search). Record pass count.
6. **Gate 1 — Size limit (20KB)** — compute `byte-size(candidate)`. **Disqualify** any variant exceeding **20480** bytes.
7. **Rank surviving candidates** by: (a) eval pass count ≥ before baseline (hard gate), (b) **Minimal diff** — prefer surgical changes, (c) pattern coverage count.
8. **Tiebreaker:** tied on all three → prefer smallest absolute file size.

### Constraint gates

9. **Gate 2 — Semantic preservation (LLM judge)**

   **Short-circuit (deterministic):** if candidate's full frontmatter block is byte-identical to pre-edit frontmatter → mark as PASS without spawning Agent. Record as `Semantic: PASS (short-circuit — frontmatter unchanged)`.

   **Full judge (when frontmatter changed):** spawn Agent (`subagent_type: general-purpose`, model: sonnet):

   > You are judging whether a proposed SKILL.md edit still matches its **original trigger conditions**. The pre-edit frontmatter `description` is the canonical spec.
   >
   > **Routing-surface preservation rule (non-negotiable):** Extract every single-quoted phrase (`'…'`), double-quoted phrase (`"…"`), and backtick-quoted token (`` `…` ``) from the pre-edit description. These — and ONLY these — are the routing surface. If ANY token is missing from the candidate description (verbatim substring match), return FAIL. Unquoted prose, decorative adjectives, and explanatory clauses can be paraphrased, truncated, or dropped freely. Semantic equivalence does not save a missing quoted token.
   >
   > Also FAIL if candidate drifts into different skill territory.
   >
   > Reply: `PASS` or `FAIL` on first line, one-sentence rationale on second. No other output.
   >
   > Pre-edit frontmatter description:
   > ```
   > {pre_edit_description}
   > ```
   >
   > Candidate SKILL.md:
   > ```
   > {candidate_full_text}
   > ```

   **Output handling:** first line must be exactly `PASS` or `FAIL`. Anything else → treat as FAIL. Conservative default protects skill routing.

   First candidate returning PASS → select as winner. On FAIL, drop and re-judge next-ranked.

### Eval gate

10. **Apply winner** — write winning SKILL.md to disk. Commit: `improve: {skill} — {one-line summary}`.
11. **Revert if all fail** — all candidates fail eval baseline, OR all disqualified by size gate, OR all remaining fail semantic judge → `git checkout -- skills/{skill}/SKILL.md`. Report which gate rejected which variant. Same revert protocol regardless of which gate tripped.
12. **Record in report** — variants generated, eval scores, diff sizes, size-gate results, semantic-judge verdict + rationale, winner or all rejected.

---

## Phase 5 — Report

Write to `{vault}/daily/improve-reports/{date}-{skill}.md`:

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
| V1 | {strategy} | {X}/{Y} | {N} | {N}/{total} | {bytes} | {yes/no} | {PASS/FAIL + rationale or short-circuit} | {yes/no} |

## Eval results
- Before: {X}/{Y} pass ({percent}%)
- After (winner): {X}/{Y} pass ({percent}%)
- Candidates tested: {N}
- Decision: KEPT (V{N}) / REVERTED (all failed)

## Auto-generated evals
- {N} new eval cases added from user corrections

## Memory triage (Phase 0)
| Slug | Tier | Confidence | Encoding artifact | Source deleted? | Commit |
|------|------|------------|-------------------|-----------------|--------|
```

Commit and push the report to the vault.

---

## Gotchas

- NEVER edit installed plugin copies (`~/.claude/plugins/`). Always edit the source repo. The `source_repo` field in outcome log points to the right place.
- Keep SKILL.md changes surgical — don't rewrite sections unrelated to the patterns found.
- **The eval gate is non-negotiable. If evals drop, revert. No exceptions.**
- A skill with zero outcome log entries has nothing to improve — stop.
- **Meta self-grilling signal** — if a grill session contains a clarifying question about `/improve`'s own mechanism (cadence/signals/auto-apply/scope/log fields), that's a signal the Clarifications section is underspecified. Patch the answer inline in SKILL.md; don't route to a reference. Every question answered inline = one future user doesn't need to ask.
- **Eval coverage audit before commit.** When /improve modifies a SKILL.md, audit `evals/evals.json` for coverage gaps. Add missing evals in the SAME commit as the SKILL.md change — don't split. `pre-commit-eval-gap.sh` enforces this at repo level.
- **Learning loops derive from observable state, never user-edited markdown.** When recommending changes to a skill with a self-learning loop, input signals MUST be observable state (Gmail labels, diffs, API responses) — not manually-edited files. Ask: "what does the user already do with their hands?" That is the input signal.
- **Keep SKILL.md under 18KB.** Variant generation fails when SKILL.md exceeds the 20KB size gate. Review byte count before adding new sections; prefer tightening existing prose over appending.

---

## Outcome log

Append to `{vault}/daily/skill-outcomes/improve.log`:

```
{date} | improve | {action} | ~/work/brain-os-plugin | {output_path} | commit:{hash} | {result}
```

- `action`: `improve` (Phase 1–5 single-skill), `memory` (Phase 0 only — triage + index reconcile + expiry), `rank` (no-arg rank-only)
- `output_path`: `daily/improve-reports/{date}-{skill}.md` for improve/rank; `N/A` for memory
- `result`: `pass` if evals improved and changes kept OR ≥1 memory file processed cleanly; `partial` if some reverted/some triages ambiguous; `fail` if all reverted or no input data
- Optional: `args="{skill-name}"`, `score={after_pass}/{after_total}`, `desc_trim_applied=1`, `triaged={N}`, `encoded={N}`, `deleted={N}`, `ambiguous={N}`, `expired={N}`
