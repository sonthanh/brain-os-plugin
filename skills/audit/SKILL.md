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
| `/audit --all`     | audit through ALL 5 principles via **5 SEPARATE `Agent(subagent_type=general-purpose)` calls** (one per principle, fresh-context isolation per call) |

`/audit --all <context-source>` accepts the same optional context-source argument as the other invocations. When omitted, each per-principle Agent receives the current conversation transcript as the audit context (the orchestrator embeds it in the per-call prompt; the Agent itself starts with a fresh context).

## How It Works — single / shorthand modes (no `--all`)

1. Read principles from `{vault}/thinking/principles/tracker.md`
2. Pick principles: p0 auto-selects top 3 most relevant to current context, or use specified IDs
3. Print selected principles into conversation (so advisor sees them)
4. State: "Audit this conversation context through these principles. For each principle: does the current approach pass or fail? What specifically needs to change?"
5. Call `advisor()` ONCE — stronger model applies the selected principles in a single review
6. Format advisor findings for the user (single `## Audit Summary` table)
7. Log principle usage to tracker: one row covering the run, increment Uses once per principle applied

`/audit p1` and `/audit p1 p5` are **unchanged** under this mode — they continue to work exactly as before. `--all` is additive, not a replacement.

## How It Works — `--all` mode (5 isolated Agent calls)

When `--all` is passed, run principles **sequentially as 5 separate `Agent(subagent_type=general-purpose)` calls** — one call per principle, each spawned with a fresh, independent context window. **NOT one call with all 5 principles in the prompt; NOT 5 `advisor()` calls.** The per-call isolation is the load-bearing semantic; collapsing to a single batched call OR using `advisor()` (which forwards the full conversation transcript per call, leaking earlier verdicts) defeats the purpose of this mode (see `## Why per-principle isolation matters` below).

Steps:

1. Read all 5 principle definitions (P1..P5) from `{vault}/thinking/principles/tracker.md`.
2. Resolve audit context: the named context-source arg if provided, otherwise the current conversation transcript.
3. Print all 5 principle definitions + the resolved context summary into the conversation so the user can see what is about to run.
4. For each principle in **P1, P2, P3, P4, P5** — sequential, deterministic order, not parallel:
   1. Compose an `Agent` prompt that contains ONLY that single principle's text + the resolved audit context + the standard "does this pass or fail this principle, what specifically needs to change?" framing + an instruction to return its verdict as a single `^\| P{N} \| (PASS|FLAG|FAIL) \| <key finding>` table row. Do NOT include the other four principles in the prompt. Do NOT include results from prior principle calls in the prompt.
   2. Call `Agent(subagent_type="general-purpose", description="audit P{N}", prompt=<composed prompt>)`. The Agent runs with its own fresh context — none of the orchestrator's transcript is forwarded.
   3. Parse the returned summary for its row using the regex `^\| P[0-9]+ \| (PASS|FLAG|FAIL) \|`. Capture the verdict (PASS/FLAG/FAIL) and the key-finding cell.
   4. Capture the full Agent response text for later use in the per-principle findings section.
5. Consolidate the 5 captured rows into ONE merged `## Audit Summary` table — rows ordered **P1 → P5** regardless of Agent return latency or other ordering signals. The orchestrator builds the table; individual Agents return only their single row + per-principle prose.
6. Append a `## Per-principle Findings` section containing the full Agent response for each principle, separated by `### P{N}` subheadings (also P1 → P5 order).
7. Append **one tracker log row per principle** (5 rows total) and increment the Uses count **once per principle** (5 increments). See `## Tracker Integration` below.
8. Append the outcome-log row per `## Outcome log` below.

Sequential (not parallel) ordering is intentional: it keeps debugging straightforward (failures attribute to a single principle's call) and the deterministic P1→P5 row order makes diffs across runs trivially comparable. Sequential is also fine for correctness: each Agent already gets fresh context, so there's no cross-contamination risk that parallel would prevent — it just makes the run linear.

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
<full text from P1's Agent response>

### P2
<full text from P2's Agent response>

### P3
<full text from P3's Agent response>

### P4
<full text from P4's Agent response>

### P5
<full text from P5's Agent response>
```

**Format contract (do not alter):**

- The heading is exactly `## Audit Summary`. Same heading as single-mode output.
- Verdict cell values are exactly `PASS`, `FLAG`, or `FAIL` — no synonyms, no decoration.
- Every verdict row matches the regex `^\| P[0-9]+ \| (PASS|FLAG|FAIL) \|` so `/slice`'s gate parser keeps working unchanged:

  ```bash
  echo "$AUDIT_OUTPUT" | grep -E '^\| P[0-9]+ \| (FAIL|FLAG) \|' && AUDIT_BLOCK=1
  ```

- Rows always appear in **P1 → P5** order, regardless of per-principle Agent return latency. Consumers may rely on this ordering.
- `## Per-principle Findings` is a sibling H2 to `## Audit Summary`, with `### P{N}` H3 subheadings (P1 → P5).
- **Backward compat:** single-principle invocation (`/audit p1`) and combined-shorthand invocation (`/audit p1 p5`) continue to emit the original single-`advisor()` output and the original `## Audit Summary` table layout — `--all` is additive, not a replacement. Existing call sites that invoke `/audit p1` or `/audit p2` from `/slice` keep working unchanged.

## Why per-principle isolation matters (load-bearing — do NOT collapse to one batched call OR revert to `advisor()`)

The 2026-05-03/04 grill that fell into the P4 trap had `/audit p1` and `/audit p2` invoked in **separate sessions**; both passed. The hypothesis `/audit --all` tests is: "5 fresh-context-isolated calls catch what 2 separate sessions missed, because all 5 principles run on the same content within one /audit invocation." A single batched call with all 5 principles in the prompt would give the LLM permission to **rationalize across principles silently** — exactly the failure mode this gate exists to prevent.

**Why Agent(general-purpose), not advisor() — the empirical finding from #253 AC#7 (2026-05-07).** When `/audit --all` first ran end-to-end against the 2026-05-04 replay grill, the runner discovered that `advisor()` forwards the full conversation transcript to the reviewer on every call. By P3, the advisor was reading P1+P2's verdicts before forming its own — the transcript leakage defeats the "fresh context per principle" contract even though the calls were structurally sequential. The runner switched to `Agent(subagent_type="general-purpose", ...)` per principle: each Agent spawns with a fresh context, sees only the per-call prompt the orchestrator embeds, and cannot read the orchestrator's transcript. P4 then FAILed cleanly on the in-doc lock-before-validate violation that the 2-session 2026-05-05 audit had missed (tracker rows 89-90 — both P1 PASS + P2 PASS individually, neither saw the cross-principle gap).

**Future-maintainer guard.** Two failure modes silently regress this contract:

1. **Batched call:** "simplifying" by collapsing the 5 principle prompts into one call. The LLM rationalizes across principles. Catch: any change that produces fewer than 5 distinct calls for `--all` is a regression.
2. **Reverting to `advisor()`:** `advisor()` reads cleaner in skill prose and seems equivalent to `Agent`, but it leaks transcript. Catch: `skills/audit/evals/check-all-flag.sh` grep-guards the SKILL.md text for both `Agent` + `subagent_type=general-purpose` + an explicit transcript-leak warning. The CI script must stay PASS or `--all` is broken.

Per-call fresh-context isolation is the empirical fork that determined whether agent-teams (Phase B, ai-brain#252) was needed: AC#7 caught the failure mode, so #252 stays deferred. **A future maintainer who collapses the 5 Agent calls OR swaps them back to `advisor()` defeats the entire mode** — the `--all` sugar is incidental, the fresh-context isolation is the contract.

## Principle Selection (p0 logic)

When no specific principle is given (`/audit` or `/audit p0`), pick the **top 3 most relevant** to what's currently being discussed. Pick order:
1. Principles that directly challenge the current approach (flag candidates first)
2. Principles that guard the most expensive failure mode (cost-of-wrong matters)
3. Principles most recently applied to a similar context

Single-principle audits produce the sharpest results. Default p0 to 3 but respect user's specific picks.

`/audit --all` overrides p0 entirely — it always runs all 5 principles regardless of relevance scoring (relevance is what the per-principle Agent calls evaluate; the user opted into the full sweep).

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

- `result`: `pass` when audit completes and produces findings (regardless of verdicts); `partial` if some principles couldn't be fully evaluated (e.g. one of the 5 `--all` Agent calls returned no parseable summary row, or single-mode `advisor()` returned no parseable row); `fail` if the per-principle call failed (Agent or advisor) or tracker.md unreadable
- `findings`: verdict breakdown capturing content quality separately from skill execution — e.g. `3FLAG+2PASS`, `1FAIL+1FLAG+1PASS`. Under `--all`, the breakdown reflects all 5 principles (so `1FAIL+2FLAG+2PASS` totals to 5).
- `args=`: principle IDs used (e.g. `p1 p5`, or `--all` for the 5-call mode)

`--all` mode writes a single outcome-log row (not 5) — the per-principle granularity lives in the tracker log; the outcome log captures the run-level result.
