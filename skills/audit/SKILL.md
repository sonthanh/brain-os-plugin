---
name: audit
description: "One-shot principle check via advisor. Use when you want to stress-test a decision, plan, or code against your principles — non-interactive, returns findings. For interactive stress-testing, use /grill instead."
---

# Principle Audit

One-shot audit of current context through your curated principles, verified by a stronger model (advisor). Unlike `/grill` (interactive, asks questions), `/audit` is non-interactive — it loads principles, calls advisor, and returns findings.

## Usage

| Invocation | Behavior |
|------------|----------|
| `/audit`           | p0: auto-pick top 3 most relevant principles (single `advisor()` call) |
| `/audit p1`        | audit through P1 only (single `advisor()` call) |
| `/audit p0`        | same as bare `/audit` |
| `/audit p1 p5`     | audit through P1 + P5 in one combined `advisor()` call (shorthand) |
| `/audit --all`     | audit through ALL 5 principles via **5 SEPARATE `advisor()` calls** (one per principle, isolated contexts) |

`/audit --all <context-source>` accepts the same optional context-source argument as the other invocations. When omitted, the advisor sees the current conversation transcript (which the harness forwards).

## How It Works — single / shorthand modes (no `--all`)

1. Read principles from `{vault}/thinking/principles/tracker.md`
2. Pick principles: p0 auto-selects top 3 most relevant to current context, or use specified IDs
3. Print selected principles into conversation (so advisor sees them)
4. State: "Audit this conversation context through these principles. For each principle: does the current approach pass or fail? What specifically needs to change?"
5. Call `advisor()` ONCE — stronger model applies the selected principles in a single review
6. Format advisor findings for the user (single `## Audit Summary` table)
7. Log principle usage to tracker: one row covering the run, increment Uses once per principle applied

`/audit p1` and `/audit p1 p5` are **unchanged** under this mode — they continue to work exactly as before. `--all` is additive, not a replacement.

## How It Works — `--all` mode (5 isolated advisor calls)

When `--all` is passed, run principles **sequentially as 5 separate `advisor()` calls** — one call per principle, each with an independent context window. **NOT one `advisor()` call with all 5 principles in the prompt.** The per-call isolation is the load-bearing semantic; collapsing to a single batched call defeats the purpose of this mode (see `## Why per-principle isolation matters` below).

Steps:

1. Read all 5 principle definitions (P1..P5) from `{vault}/thinking/principles/tracker.md`.
2. Resolve audit context: the named context-source arg if provided, otherwise the current conversation transcript.
3. Print all 5 principle definitions + the resolved context summary into the conversation so the user can see what is about to run.
4. For each principle in **P1, P2, P3, P4, P5** — sequential, deterministic order, not parallel:
   1. Compose an `advisor()` prompt that contains ONLY that single principle's text + the resolved audit context + the standard "does this pass or fail this principle, what specifically needs to change?" framing. Do NOT include the other four principles in the prompt.
   2. Call `advisor()`.
   3. Parse the returned response for its `## Audit Summary` row using the regex `^\| P[0-9]+ \| (PASS|FLAG|FAIL) \|`. Capture the verdict (PASS/FLAG/FAIL) and the key-finding cell.
   4. Capture the full advisor response text for later use in the per-principle findings section.
5. Consolidate the 5 captured rows into ONE merged `## Audit Summary` table — rows ordered **P1 → P5** regardless of advisor return latency or other ordering signals.
6. Append a `## Per-principle Findings` section containing the full advisor response for each principle, separated by `### P{N}` subheadings (also P1 → P5 order).
7. Append **one tracker log row per principle** (5 rows total) and increment the Uses count **once per principle** (5 increments). See `## Tracker Integration` below.
8. Append the outcome-log row per `## Outcome log` below.

Sequential (not parallel) ordering is intentional: it keeps debugging straightforward (failures attribute to a single principle's call) and the deterministic P1→P5 row order makes diffs across runs trivially comparable.

## Output consolidation contract

The `--all` mode output MUST follow this exact structure so downstream consumers (notably `/slice`'s gate parser) keep working unchanged:

```
## Audit Summary
| Principle | Verdict | Key Finding |
|-----------|---------|-------------|
| P1 | PASS|FLAG|FAIL | one-line finding |
| P2 | PASS|FLAG|FAIL | one-line finding |
| P3 | PASS|FLAG|FAIL | one-line finding |
| P4 | PASS|FLAG|FAIL | one-line finding |
| P5 | PASS|FLAG|FAIL | one-line finding |

## Per-principle Findings

### P1
<full text from P1's advisor response>

### P2
<full text from P2's advisor response>

### P3
<full text from P3's advisor response>

### P4
<full text from P4's advisor response>

### P5
<full text from P5's advisor response>
```

**Format contract (do not alter):**

- The heading is exactly `## Audit Summary`. Same heading as single-mode output.
- Verdict cell values are exactly `PASS`, `FLAG`, or `FAIL` — no synonyms, no decoration.
- Every verdict row matches the regex `^\| P[0-9]+ \| (PASS|FLAG|FAIL) \|` so `/slice`'s gate parser keeps working unchanged:

  ```bash
  echo "$AUDIT_OUTPUT" | grep -E '^\| P[0-9]+ \| (FAIL|FLAG) \|' && AUDIT_BLOCK=1
  ```

- Rows always appear in **P1 → P5** order, regardless of advisor return latency. Consumers may rely on this ordering.
- `## Per-principle Findings` is a sibling H2 to `## Audit Summary`, with `### P{N}` H3 subheadings (P1 → P5).
- **Backward compat:** single-principle invocation (`/audit p1`) and combined-shorthand invocation (`/audit p1 p5`) continue to emit the original single-`advisor()` output and the original `## Audit Summary` table layout — `--all` is additive, not a replacement. Existing call sites that invoke `/audit p1` or `/audit p2` from `/slice` keep working unchanged.

## Why per-principle isolation matters (load-bearing — do NOT collapse to one batched call)

The 2026-05-03/04 grill that fell into the P4 trap had `/audit p1` and `/audit p2` invoked in **separate sessions**; both passed. The hypothesis `/audit --all` tests is: "5 isolated `advisor()` calls catch what 2 separate sessions missed because all 5 principles run on the same content within one /audit invocation." A single `advisor()` call with all 5 principles in the prompt would give the LLM permission to **rationalize across principles silently** — exactly the failure mode this gate exists to prevent. Per-call isolation is the empirical fork that determines whether agent-teams (Phase B, ai-brain#252) is needed: if `--all` catches the failure mode in the 2026-05-04 replay smoke test, agent-teams stays deferred. **A future maintainer who collapses the 5 calls into 1 to "simplify" defeats the entire mode** — the `--all` sugar is incidental, the isolation is the contract.

## Principle Selection (p0 logic)

When no specific principle is given (`/audit` or `/audit p0`), pick the **top 3 most relevant** to what's currently being discussed. Pick order:
1. Principles that directly challenge the current approach (flag candidates first)
2. Principles that guard the most expensive failure mode (cost-of-wrong matters)
3. Principles most recently applied to a similar context

Single-principle audits produce the sharpest results. Default p0 to 3 but respect user's specific picks.

`/audit --all` overrides p0 entirely — it always runs all 5 principles regardless of relevance scoring (relevance is what the per-principle advisor calls evaluate; the user opted into the full sweep).

**P3 scope check:** P3 (Value Equation) requires ≥50 words of content AND structural differences between options (not phrasing-only). Skip P3 for micro-edits — it won't discriminate. Under `--all`, P3 still runs; expect a `PASS` verdict with a "scope insufficient" key-finding when the content is too thin for P3 to bite.

## Output

Single-mode output: present the advisor's findings directly, then append a single `## Audit Summary` table:

```
## Audit Summary
| Principle | Verdict | Key Finding |
|-----------|---------|-------------|
| P1 | PASS/FLAG/FAIL | one-line finding |

Logged to tracker.
```

`--all` mode output: see `## Output consolidation contract` above.

**Format contract**: The `## Audit Summary` heading and table structure (`| P{N} | PASS|FLAG|FAIL |`) are consumed programmatically by downstream skills (e.g. `/slice` audit gate). Verdict values must be exactly `PASS`, `FLAG`, or `FAIL` — do not alter heading, column structure, or verdict text in either mode.

## Tracker Integration

After each audit, append rows to the Log table in `{vault}/thinking/principles/tracker.md`:

```
| {date} | {principles} | {context} | {outcome} |
```

Also increment the Uses count for each principle applied.

**Single / shorthand mode:** one log row covering all selected principles (e.g. `principles=p1,p5`), increment Uses once per principle.

**`--all` mode:** **one log row per principle** (5 rows total, one per principle, P1 → P5), and **increment the Uses count once per principle** (5 increments). Each row carries `{principles}=p{N}` (single principle ID per row) so per-principle benefit attribution stays clean across `--all` runs vs single-principle runs.

## Outcome log

Follow `skill-spec.md § 11`. Append to `{vault}/daily/skill-outcomes/audit.log`:

```
{date} | audit | audit | ~/work/brain-os-plugin | thinking/principles/tracker.md | commit:N/A | {result} | args="{principles}" findings={summary}
```

- `result`: `pass` when audit completes and produces findings (regardless of verdicts); `partial` if some principles couldn't be fully evaluated (e.g. one of the 5 `--all` advisor calls returned no parseable summary row); `fail` if advisor call failed or tracker.md unreadable
- `findings`: verdict breakdown capturing content quality separately from skill execution — e.g. `3FLAG+2PASS`, `1FAIL+1FLAG+1PASS`. Under `--all`, the breakdown reflects all 5 principles (so `1FAIL+2FLAG+2PASS` totals to 5).
- `args=`: principle IDs used (e.g. `p1 p5`, or `--all` for the 5-call mode)

`--all` mode writes a single outcome-log row (not 5) — the per-principle granularity lives in the tracker log; the outcome log captures the run-level result.
