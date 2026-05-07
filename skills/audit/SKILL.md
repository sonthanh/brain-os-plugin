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
| `/audit --team [<context-source>]` | audit through ALL 5 principles via a **subprocess-isolated agent team** — `TeamCreate` + N×5 `principle-auditor-p{1..5}` teammates (default N=2) running a 3-round protocol (initial verdict → within-principle vote → cross-principle DM-debate signature). Variance dampened by within-principle consensus; verdict drift dampened by per-agent fresh context (each teammate re-reads its own `agents/principle-auditor-pN.md` definition + spawn prompt, no orchestrator interpretation in the loop). |

`/audit --all <context-source>` accepts the same optional context-source argument as the other invocations. When omitted, each per-principle Agent receives the current conversation transcript as the audit context (the orchestrator embeds it in the per-call prompt; the Agent itself starts with a fresh context).

`/audit --team <context-source>` accepts the same optional context-source argument. When omitted, the lead embeds the current conversation transcript into each teammate's spawn prompt verbatim. The team primitive is more expensive than `--all` (10 teammates × ~3 rounds vs 5 Agent calls × 1 round), so `--team` is reserved for high-stakes audits where within-principle variance dampening matters — see `## When to pick` below.

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

## How It Works — `--team` mode (subprocess-isolated agent-teams, ai-brain#252 Phase B)

When `--team` is passed, the lead spawns a **TeamCreate-managed team** of N×5 principle-auditor teammates (default N=2 → 10 teammates). Each teammate is a fresh-context Agent spawned via `Agent(subagent_type="principle-auditor-pN", team_name="audit-...", name="pN-{a|b}", ...)`. Each teammate re-reads its own subagent definition (`agents/principle-auditor-pN.md`) — the orchestrator does NOT compose principle text into the spawn prompt, eliminating the run-to-run prompt-drift class of variance that `--all` showed during 2026-05-07 P2/P5 reproducibility runs.

Steps (lead-orchestrated):

1. Read all 5 principle definitions from `{vault}/thinking/principles/tracker.md` for the lead's own context (the teammates load from their agent definitions, not from the lead).
2. Resolve audit context: the named context-source arg if provided, otherwise the current conversation transcript.
3. **Pre-spawn token-budget estimate.** Subscription model: estimate per-teammate token use (≈ AUDIT_CONTEXT size + agent-definition size + per-round overhead × 3 rounds × N×5 teammates). If the estimate would consume more than ~30% of the current 5-hour session usage budget OR push the weekly limit past 80%, abort with a clear message naming the budget breach (do NOT silently proceed). Default N=2; if estimate exceeds budget, downgrade to N=1 and document in the run output.
4. Generate `RUN_ID="audit-$(date +%s)"`. Create `~/.claude/audit-runs/${RUN_ID}/` for per-teammate JSON output.
5. `TeamCreate({team_name: RUN_ID, description: "audit --team for <context>"})`. The `audit-*` prefix is load-bearing — the `TeammateIdle` hook scopes its enforcement to this prefix.
6. For each principle P ∈ {1..5} and each within-principle slot S ∈ {a, b} (when N=2):
   - Spawn `Agent(subagent_type="principle-auditor-p${P}", team_name=RUN_ID, name="p${P}-${S}", prompt=<spawn prompt below>)`.
7. **Spawn prompt** (embedded verbatim per teammate):
   - `AUDIT_RUN_DIR` = absolute path to the run dir.
   - `AGENT_NAME` = `pN-a` or `pN-b`.
   - `WITHIN_PRINCIPLE_PEER` = `pN-b` if this is `pN-a` (and N=2), or `pN-a` if this is `pN-b`, or `null` when N=1.
   - `CROSS_PRINCIPLE_LEADS` = the 4 names of the OTHER 4 principles' lead agents (convention: `pN-a` is the lead of principle N).
   - `AUDIT_CONTEXT` = full text of the artifact under audit, embedded verbatim. Do NOT summarise.
   - `ROUND_BUDGET` = 3 (default; configurable for this run).
8. Wait for all N×5 teammates to write their final round-3 JSON to `${AUDIT_RUN_DIR}/agent-${name}.json`. Each teammate runs all 3 rounds within one agent turn (filesystem-polling between rounds); idle = round 3 done OR wait-loop timeout. The `TeammateIdle` hook (`hooks/audit-team-consensus.sh`) observes each idle event, logs progress to `${AUDIT_RUN_DIR}/hook.log`, and escalates (osascript banner + Supaterm tab + `escalation.md`) when an agent idles with unresolved dissent (round<3, within-principle split, missing signatures, or `dissent_acknowledged:true`).
9. Aggregate to `${AUDIT_RUN_DIR}/consensus.json`:
   - For each principle P, collect the within-principle agents' verdicts. If unanimous → that's the principle's verdict; record `variance_within=converged`. If split → use the majority verdict (or the first agent's verdict on a 1-1 tie when N=2), and record `variance_within=split:P${P}`.
   - Build the `Audit Summary` table rows P1 → P5 from the principle-level verdicts.
   - Build a `Variance Notes` section listing every `variance_within=split` and any P2 `scope_flag` that came back as `ambiguous`.
10. Output the lead synthesis (Audit Summary table + Per-principle Findings + Variance Notes) — see `## Output consolidation contract` below; `--team` extends `--all`'s contract additively.
11. `TeamDelete()` after all teammates have shut down (lead sends `shutdown_request` to each, awaits `shutdown_response: approve=true`).
12. Append outcome-log row per `## Outcome log` below, including the `variance=` field.

**Round protocol (run by each teammate within a single agent turn):**

- **Round 1:** Initial verdict. Apply own calibration note (P2 scope, P3 scope-sufficiency, P5 severity rubric, P4 temporal ordering, P1 simplicity). Write own JSON.
- **Round 2 (skip when N=1):** Within-principle vote. Poll within-principle peer's JSON, compare verdict + scope (where applicable). On disagreement, DM peer with one reconciliation question; wait up to 60s. Record `agreed: true|false` and dissenting verdicts.
- **Round 3:** Cross-principle signature. Poll the 4 other principles' lead JSONs. Sign whether each finding is internally consistent with that lead's stated principle. On substantive conflict, DM the lead with one reconciliation question; wait up to 60s. Record 4 signatures.

Hard cap: 3 rounds. Past round 3 without consensus → teammate sets `dissent_acknowledged: true` and idles; the hook escalates to user.

**Race-safety contract:** each teammate writes ONLY to its own `agent-${name}.json`. The lead aggregates after all teammates idle. There is no shared-write `consensus.json` (the lead synthesises it post-aggregation). Multiple teammates writing to one file would race; per-teammate file ownership is the load-bearing primitive.

**Subprocess-isolation contract:** the principle text + calibration notes live in the agent definition file (`agents/principle-auditor-pN.md`), NOT in the lead's spawn-prompt composition. The lead embeds only `AUDIT_CONTEXT` + agent metadata; the principle interpretation layer is read by the teammate from its own definition file with a fresh context. Future maintainers who fold principle text into the lead's spawn prompt re-introduce orchestrator-prompt-drift (the variance source `--all` exhibited on 2026-05-07).

## When to pick (single advisor / `--all` Agent-spawn / `--team` subprocess-team)

| Mode | Use when | Cost (subscription token estimate) | Variance dampening |
|------|----------|------------------------------------|--------------------|
| `/audit p1` (single-mode advisor) | Sharpest single-principle audit; quick gut check; in-context decision review | Lowest — one advisor call, ~3-10K tokens | None (single shot) |
| `/audit --all` (5 Agent calls) | Default for grill-end audit + `/slice` gate; covers all 5 principles with fresh-context isolation per call; cheap enough to run on every grill | Medium — 5 Agent calls × ~5-15K tokens each = 25-75K tokens | Per-principle isolation only (no within-principle vote) |
| `/audit --team` (N×5 subprocess team) | High-stakes architecture audits where verdict-drift between runs has been observed (per-principle calibration drift, scope ambiguity, severity rubric drift); audits that lock load-bearing decisions for downstream stories | Highest — N×5 teammates × ~10-25K tokens × 3 rounds = 150-750K tokens (default N=2). Pre-spawn budget gate before running. | Within-principle vote (N=2) + cross-principle DM-debate signature. Variance metric in `audit.log` (`variance=converged`, `variance=split:P2,P5`, `variance=scope-flagged:P2-local-vs-meta`). |

`--team` is **additive** to `--all`, not a replacement. `/audit p1` and `/audit --all` continue to work unchanged. `--team` is reserved for the high-stakes case where the marginal cost of within-principle consensus is justified by the cost of locking a flawed decision.

## Why per-principle isolation matters (load-bearing — do NOT collapse to one batched call OR revert to `advisor()`)

The 2026-05-03/04 grill that fell into the P4 trap had `/audit p1` and `/audit p2` invoked in **separate sessions**; both passed. The hypothesis `/audit --all` tests is: "5 fresh-context-isolated calls catch what 2 separate sessions missed, because all 5 principles run on the same content within one /audit invocation." A single batched call with all 5 principles in the prompt would give the LLM permission to **rationalize across principles silently** — exactly the failure mode this gate exists to prevent.

**Why Agent(general-purpose), not advisor() — the empirical finding from #253 AC#7 (2026-05-07).** When `/audit --all` first ran end-to-end against the 2026-05-04 replay grill, the runner discovered that `advisor()` forwards the full conversation transcript to the reviewer on every call. By P3, the advisor was reading P1+P2's verdicts before forming its own — the transcript leakage defeats the "fresh context per principle" contract even though the calls were structurally sequential. The runner switched to `Agent(subagent_type="general-purpose", ...)` per principle: each Agent spawns with a fresh context, sees only the per-call prompt the orchestrator embeds, and cannot read the orchestrator's transcript. P4 then FAILed cleanly on the in-doc lock-before-validate violation that the 2-session 2026-05-05 audit had missed (tracker rows 89-90 — both P1 PASS + P2 PASS individually, neither saw the cross-principle gap).

**Future-maintainer guard.** Two failure modes silently regress this contract:

1. **Batched call:** "simplifying" by collapsing the 5 principle prompts into one call. The LLM rationalizes across principles. Catch: any change that produces fewer than 5 distinct calls for `--all` is a regression.
2. **Reverting to `advisor()`:** `advisor()` reads cleaner in skill prose and seems equivalent to `Agent`, but it leaks transcript. Catch: `skills/audit/evals/check-all-flag.sh` grep-guards the SKILL.md text for both `Agent` + `subagent_type=general-purpose` + an explicit transcript-leak warning. The CI script must stay PASS or `--all` is broken.

Per-call fresh-context isolation is the empirical fork that determined whether agent-teams (Phase B, ai-brain#252) was needed: AC#7 caught the original P4 failure mode (`--all` does dampen lock-before-validate), so the cheap `--all` primitive stayed live. BUT a separate empirical signal — per-principle verdict variance across two reproducibility runs of `--all` against the same 2026-05-04 fixture (P2 PASS↔FAIL on scope drift; P5 FLAG↔FAIL on severity rubric drift) — surfaced 2026-05-07 and unblocked Phase B (#252 SHIPPED 2026-05-07). The diagnosis: even with fresh-context Agent isolation, the *orchestrator* composes per-principle prompts from its own context, introducing an interpretation layer that drifts run-to-run. `--team` (#252) eliminates this by reading principle text + calibration from the agent definition file (`agents/principle-auditor-pN.md`) via subprocess isolation — the lead never composes principle text into the spawn prompt.

**Three iterations, three contracts (history — protect against silent regression to a prior iteration):**

1. **Iteration 1 (#253 D9 / #255):** `advisor()` per principle. Failed because `advisor()` forwards the full conversation transcript per call; by P3 the reviewer reads P1+P2 verdicts. Discovered AC#7 morning smoke 2026-05-07.
2. **Iteration 2 (#260):** `Agent(subagent_type="general-purpose")` per principle. Each Agent has fresh context, but the orchestrator still composes per-principle prompts from its own context — orchestrator-prompt drift produces verdict variance. Discovered AC#7 afternoon re-run 2026-05-07.
3. **Iteration 3 (#252, this story, SHIPPED 2026-05-07):** `Agent(subagent_type="principle-auditor-pN")` via TeamCreate. Each Agent re-reads its own principle definition + calibration from the agent file with a fresh context; the lead embeds ONLY audit context, never principle text. Within-principle N=2 consensus dampens residual variance; cross-principle DM-debate signs each finding's internal consistency with its principle.

**Future-maintainer guard.** Three failure modes silently regress these contracts:

1. **Batched call:** "simplifying" by collapsing the 5 principle prompts into one call. The LLM rationalizes across principles. Catch: any change that produces fewer than 5 distinct calls for `--all` is a regression.
2. **Reverting to `advisor()`:** `advisor()` reads cleaner in skill prose and seems equivalent to `Agent`, but it leaks transcript. Catch: `skills/audit/evals/check-all-flag.sh` grep-guards the SKILL.md text for `Agent` + `subagent_type=general-purpose` + an explicit transcript-leak warning in `--all` mode.
3. **Folding principle text into the lead's spawn prompt for `--team`:** future maintainer "simplifies" by inlining principle text into the spawn prompt instead of relying on the agent definition file. This re-introduces orchestrator-prompt-drift (Iteration 2's failure mode) into Iteration 3. Catch: `check-all-flag.sh` grep-guards that the `--team` workflow in this SKILL.md says principle text lives in the AGENT FILE, not in the spawn prompt.

**A future maintainer who collapses the 5 Agent calls in `--all`, swaps them back to `advisor()`, OR folds principle text into the lead's `--team` spawn prompt defeats the corresponding mode** — the `--all` and `--team` invocation sugar is incidental; per-call isolation (advisor → Agent → subprocess-team) is the load-bearing contract per iteration.

## Principle Selection (p0 logic)

When no specific principle is given (`/audit` or `/audit p0`), pick the **top 3 most relevant** to what's currently being discussed. Pick order:
1. Principles that directly challenge the current approach (flag candidates first)
2. Principles that guard the most expensive failure mode (cost-of-wrong matters)
3. Principles most recently applied to a similar context

Single-principle audits produce the sharpest results. Default p0 to 3 but respect user's specific picks.

`/audit --all` overrides p0 entirely — it always runs all 5 principles regardless of relevance scoring (relevance is what the per-principle Agent calls evaluate; the user opted into the full sweep).

**P3 scope check:** P3 (Value Equation) requires ≥50 words of content AND structural differences between options (not phrasing-only). Skip P3 for micro-edits — it won't discriminate. Under `--all` and `--team`, P3 still runs; expect a `PASS` verdict with a "scope insufficient" key-finding when the content is too thin for P3 to bite. Under `--team` the P3 agent's `scope_flag` field captures the content-vs-architecture choice and feeds the variance metric.

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

`--team` mode output: extends `--all`'s contract additively. Same `## Audit Summary` table (P1 → P5) for downstream consumer compat (`/slice` gate parser keeps working). Same `## Per-principle Findings` section. Plus a NEW `## Variance Notes` section appended after Per-principle Findings:

```
## Variance Notes
- P2: split (a=PASS local-scope, b=FAIL meta-scope) — variance=split:P2
- P5: converged on FAIL (severity rubric applied; both agents counted same load-bearing invariants)
- P3: scope=architecture (insufficient-content PASS — recorded for /improve calibration)
```

The Variance Notes block is empty when all within-principle votes are unanimous and no scope flags surfaced. The block's presence + content is what `/improve` reads to detect rubric drift across runs (e.g. recurring `split:P2` would signal that the P2 scope calibration note in `agents/principle-auditor-p2.md` needs sharper rules).

**Format contract**: The `## Audit Summary` heading and table structure (`| P{N} | PASS|FLAG|FAIL |`) are consumed programmatically by downstream skills (e.g. `/slice` audit gate). Verdict values must be exactly `PASS`, `FLAG`, or `FAIL` — do not alter heading, column structure, or verdict text in any of the three modes.

## Tracker Integration

After each audit, append rows to the Log table in `{vault}/thinking/principles/tracker.md`:

```
| {date} | {principles} | {context} | {outcome} |
```

Also increment the Uses count for each principle applied.

**Single / shorthand mode:** one log row covering all selected principles (e.g. `principles=p1,p5`), increment Uses once per principle.

**`--all` mode:** **one log row per principle** (5 rows total, one per principle, P1 → P5), and **increment the Uses count once per principle** (5 increments). Each row carries `{principles}=p{N}` (single principle ID per row) so per-principle benefit attribution stays clean across `--all` runs vs single-principle runs.

**`--team` mode:** same as `--all` for the tracker — **one log row per principle** (5 rows), Uses incremented once per principle (5 increments). Each row's `{outcome}` cell additionally carries the within-principle agreement state (e.g. `P2 FAIL within-agreed=true cross-signed=4/4`, or `P2 FAIL within-agreed=false split-on-scope`) so per-principle drift across `--team` runs is visible in tracker history without needing to read the run dir.

## Outcome log

Follow `skill-spec.md § 11`. Append to `{vault}/daily/skill-outcomes/audit.log`:

```
{date} | audit | audit | ~/work/brain-os-plugin | thinking/principles/tracker.md | commit:N/A | {result} | args="{principles}" findings={summary}
```

- `result`: `pass` when audit completes and produces findings (regardless of verdicts); `partial` if some principles couldn't be fully evaluated (e.g. one of the 5 `--all` Agent calls returned no parseable summary row, one or more `--team` teammates idled with round<3, or single-mode `advisor()` returned no parseable row); `fail` if the per-principle call failed (Agent / advisor / TeamCreate) or tracker.md unreadable
- `findings`: verdict breakdown capturing content quality separately from skill execution — e.g. `3FLAG+2PASS`, `1FAIL+1FLAG+1PASS`. Under `--all` and `--team`, the breakdown reflects all 5 principles (so `1FAIL+2FLAG+2PASS` totals to 5).
- `args=`: principle IDs used (e.g. `p1 p5`, `--all` for the 5-call mode, or `--team` for the agent-team mode; under `--team` also include `N=<n>` to record the within-principle slot count, e.g. `--team N=2`)
- `variance=` (`--team` mode only): comma-separated variance signals from the run. Format:
  - `variance=converged` — all within-principle votes unanimous AND no scope flags surfaced.
  - `variance=split:P2,P5` — comma-separated list of principles where within-principle votes split (verdict disagreement OR scope disagreement).
  - `variance=scope-flagged:P2-local-vs-meta` — when P2's scope calibration surfaced an ambiguous artifact and the agents picked different scopes; the lead must pick one before locking the verdict.
  - Multiple signals can compose: `variance=split:P5,scope-flagged:P2-local-vs-meta`.
  - The `variance=` field is REQUIRED on `--team` rows — `check-all-flag.sh` grep-guards its presence.
- `tokens=` (`--team` mode, optional but recommended): post-hoc total token usage across all teammates, recorded for AC#7 baseline calibration. Format: `tokens=in/out` (e.g. `tokens=180000/45000`). Lead reads from session metadata if available.

`--all` and `--team` modes write a single outcome-log row each (not 5) — the per-principle granularity lives in the tracker log; the outcome log captures the run-level result + variance.
