---
name: airtable-knowledge-extract
description: "Extract knowledge từ Airtable bases vào vault dưới dạng linked entity pages. Sonnet worker + Opus reviewer ≥95% gate, mandatory HITL re-anchor mỗi base mới. Use khi seeding historical knowledge từ company Airtable bases."
---

# /airtable-knowledge-extract — Airtable → Vault Knowledge Extractor

Phase 1 MVP. Pure-TypeScript bun pipeline (`scripts/run.mts`) drives a per-base × vertical-slice extract from Airtable into a per-run cache (`~/.claude/airtable-extract-cache/<run-id>/`). Sonnet worker writes entity slices; Opus 4.6 reviewer gates each 10-slice batch at ≥95%; self-improver appends rejected examples; re-anchor enforces a mandatory HITL teach round on every new base. Settled design: `{vault}/daily/grill-sessions/2026-04-27-auto-eval-scale-pipeline.md`.

## Vault Path

Read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md` (or user-local `~/.brain-os/brain-os.config.md`, which takes precedence — same logic as `hooks/resolve-vault.sh`, ported to TS in `scripts/outcome-log.mts`). Key: `vault_path:`. The outcome log lands at `<vault_path>/daily/skill-outcomes/airtable-knowledge-extract.log`.

## RUN MODE — Pattern B: never orchestrate from session; launch via supaterm tab

This is a **Pattern B pipeline** (rationale: `{vault}/thinking/aha/2026-04-18-orchestration-on-script.md`). The bun runtime owns the per-base loop; `claude -p` worker subprocesses do per-slice work. A real run takes ~30–60 min per base.

**Rule 1 — never orchestrate from a Claude session.** Each Bash tool result re-reads the full transcript; a 30-min in-session orchestration burns Opus context-tokens at $300+/run. Do NOT poll, Monitor, or TaskUpdate during the loop.

**Rule 2 — supaterm tab + `env -u CLAUDECODE` is how Claude launches it.** `sp tab new --script` creates a background supaterm tab that survives the Claude session. Stripping `CLAUDECODE` from the env makes child `claude -p` workers run outside the parent session context.

**When the user invokes `/airtable-knowledge-extract`, print the `## Run` block below verbatim and stop in-session.** Do not Bash it from the session. The user pastes the block (after filling in `<list-of-base-ids>`) into their terminal or invokes the supaterm command directly.

## Run

Resolve the bases to process up-front via `scripts/active-bases.mts` (which internally calls `list-bases.mts`, applies the inclusion + exclusion rules from `references/base-selection-rules.md`, and emits the filtered set). Then chain the per-base pre-steps and the orchestrator inside one supaterm tab:

```bash
RUN_ID="$(date -u +%Y-%m-%d)-airtable-extract"
SKILL_DIR="${CLAUDE_PLUGIN_ROOT}/skills/airtable-knowledge-extract"
sp tab new --script "env -u CLAUDECODE bash -c '
  set -euo pipefail
  cd \"$SKILL_DIR\"
  ACTIVE_IDS=\$(AIRTABLE_RUN_ID=\"$RUN_ID\" bun run scripts/active-bases.mts --ids)
  for BASE_ID in \$ACTIVE_IDS; do
    AIRTABLE_RUN_ID=\"$RUN_ID\" bun run scripts/classify-clusters.mts \"\$BASE_ID\" > /dev/null
    AIRTABLE_RUN_ID=\"$RUN_ID\" bun run scripts/legacy-link-detector.mts \"\$BASE_ID\" > /dev/null
    AIRTABLE_RUN_ID=\"$RUN_ID\" bun run scripts/seed-selection.mts \"\$BASE_ID\" > /dev/null
    AIRTABLE_RUN_ID=\"$RUN_ID\" bun run scripts/rubric-author.mts \"\$BASE_ID\" > /dev/null
    bun run scripts/run.mts --run-id \"$RUN_ID\" --base \"\$BASE_ID\" -P 1 \\
      2>&1 | tee -a /tmp/airtable-extract-\"$RUN_ID\".log
  done
  sleep 10
'"
```

On the first invocation within a run-id, `active-bases.mts` writes both `~/.claude/airtable-extract-cache/<run-id>/bases.json` (raw Meta API listing, via the wrapped `list-bases.mts`) and `~/.claude/airtable-extract-cache/<run-id>/active-bases.json` (filter trace per base). On any subsequent invocation with the same run-id, the cached trace is read and the API probes are skipped.

For the first run on a new base, keep `-P 1` so re-anchor's rung-0' shallow slice gates HITL approval before any parallel rung-1 sweep. Once the user has approved the re-anchor and the rubric, raise to `-P 5` for rung-1 throughput.

`rubric-author.mts` defaults to an interactive readline grill — one question at a time with a concrete sample record, accepting `k`/`d`/rewrite/`+`/batch shortcuts. Prompts go to stderr so the `> /dev/null` redirect on stdout doesn't suppress the UI; the operator switches to the supaterm tab when it pauses on input. Pass `--editor` to fall back to the original `$EDITOR`-based flow for non-interactive contexts. Full shortcut table + plumbing notes: `references/rubric-author-flow.md`.

### HITL — export-decision-and-exit (re-anchor + self-improve)

Both `re-anchor.mts` and `self-improve.mts` use the **export-decision-and-exit** pattern (issue #232). Workers do NOT block on stdin or poll a file mid-run. Instead:

1. Worker computes its decision context (slices, verdict, sample entities for re-anchor; raw + reasoning for self-improve).
2. Worker writes the context to a known JSON path.
3. Worker EXITS with code **42** (`HITL_PENDING_EXIT_CODE`).
4. `run.mts` propagates exit 42 → updates `state.json` `phase=hitl-pending` → exits 42 itself with a one-line operator pointer.
5. `set -euo pipefail` in the supaterm bash chain bails the for-loop.
6. **Agent (Claude in chat)** detects the `*-decision-needed.json` file, reads context, drives a grill conversation with concrete examples (per the `rubric-author` #228 pattern), and writes the decision JSON to the spec'd `decision_path`.
7. Operator re-runs the same supaterm chain; the for-loop walks confirmed bases (no-op fast-paths) until it reaches the paused base; the worker detects the decision file, consumes (and deletes) it, and proceeds.

Decision file paths and shapes:

| Phase | Needed file (worker → agent) | Decision file (agent → worker) |
|-------|------------------------------|--------------------------------|
| `re-anchor` | `<runDir>/hitl/re-anchor-decision-needed.json` | `<runDir>/hitl/re-anchor-decision.json` — `{verdict: "approve"\|"reject", notes, rewrites?}` |
| `self-improve` (per slice) | `<basePath>/corrections/correction-needed-<slice_id>.json` | `<basePath>/corrections/correction-decided-<slice_id>.json` — `{corrected, reason}` |

Notes:

- The needed-file payload includes a `wake_token` (uuid). It is informational; the decision file does not need to echo it.
- For self-improve, `selfImprove` is **atomic** in two-pass mode: if any reject lacks a decision file, it writes needed-files for the missing ones only and throws `HitlPendingError` without consuming any decisions that are already present.
- For non-interactive contexts (CI smoke runs, scripted tests) where the legacy stdin / file-poll behavior is required, pass `--strict-stdin-hitl` to `re-anchor.mts` or `self-improve.mts`.

## Status & analysis

Both are read-only one-shots — safe to Bash from a session when the user asks "how's it going?".

```bash
# live snapshot (human-formatted)
bun run ${CLAUDE_PLUGIN_ROOT}/skills/airtable-knowledge-extract/scripts/status.mts <run-id>

# JSON snapshot for /improve / dashboards
bun run ${CLAUDE_PLUGIN_ROOT}/skills/airtable-knowledge-extract/scripts/status.mts <run-id> --json

# user-only — do NOT call from a session, it loops:
# tail -f /tmp/airtable-extract-<run-id>.log
```

## Outputs

| Path | Purpose |
|------|---------|
| `~/.claude/airtable-extract-cache/<run-id>/state.json` | Orchestrator resume state (single source of truth for `--run-id` resume) |
| `~/.claude/airtable-extract-cache/<run-id>/cost-meter.jsonl` | Per-call token usage (guard input + cumulative reporter) |
| `~/.claude/airtable-extract-cache/<run-id>/bases.json` | Cached Airtable Meta API bases listing (raw, unfiltered) |
| `~/.claude/airtable-extract-cache/<run-id>/active-bases.json` | Filter trace per base — `{id, name, included, excluded_by, last_activity, table_count}` |
| `~/.claude/airtable-extract-cache/<run-id>/clusters-<base-id>.json` | Cluster classification cache (link-graph components) |
| `~/.claude/airtable-extract-cache/<run-id>/seed-records-<base-id>-<cluster-id>.json` | Seed record selection cache |
| `~/.claude/airtable-extract-cache/<run-id>/bases/<base-id>/out/<entity-type>/<slug>.md` | Extracted entity page — frontmatter + body with `[[wikilinks]]` to other extracted slugs |
| `~/.claude/airtable-extract-cache/<run-id>/bases/<base-id>/out/airtable-cleanup-tasks.md` | Detected legacy / broken Airtable cross-cluster links |
| `~/.claude/airtable-extract-cache/<run-id>/bases/<base-id>/examples.jsonl` | Self-improver per-base examples bank (raw / corrected / reason triples) |
| `~/.claude/airtable-extract-cache/<run-id>/metrics/base-<base-id>-rung-<n>.jsonl` | Per-base run-summary (batch outcomes, pass-rate, consec-fails) |
| `<vault>/daily/skill-outcomes/airtable-knowledge-extract.log` | Outcome log line per skill-spec § 11 (one row per `run.mts` invocation) |

Entity pages stage in the cache, not the vault, until the user reviews via `sp tab focus` and merges into the live vault. This is intentional Phase 1 design — the vault is the import destination, not the live extraction target.

## Contract

- **Model tiers pinned.** Worker = `claude -p --model sonnet`; reviewer = `claude -p --model opus`. Drift caught by `tests/extract-slice.test.ts` and `tests/review-slice.test.ts`.
- **Reviewer gate ≥95% per 10-slice batch.** Below threshold: self-improver appends `(raw, corrected, reason)` to per-base `examples.jsonl`, retry runs at `Math.max(1, floor(P/2))`. Two consecutive `fail-after-retry` outcomes → SIGTERM workers + osascript notify + exit `kind=escalated-batch`.
- **Mandatory re-anchor on every new base.** Rung-0' shallow slice + HITL approve before rung-1 sweep. Rejection → exit `kind=escalated-re-anchor`, base re-tried on the next run-id (no auto-promotion).
- **Idempotent resume.** Re-running the same `--run-id` picks up at the last persisted batch index; `seed-selection.mts`'s deterministic cache is what makes this safe.
- **Pure TypeScript via bun** (per `feedback_scripts_ts_bun_only.md`). Unit tests under `tests/*.test.ts`; integration smoke under `tests/integration.test.ts`.
- **Cost-meter is the source of truth for spend.** Guard polls it every 30s and SIGTERMs workers on max-tokens / max-wallclock breach (calibrated from rung-0 observation, not user-set upfront).

## When NOT to use

- Two-way sync into Airtable — read-only, Phase 1.
- Cron-scheduled live re-import — one-shot per invocation in Phase 1.
- Bases mid-schema-rewrite — re-anchor will reject; settle the schema first.
- Datasets so small a manual copy is faster — heuristic: <50 records across <3 tables, just copy by hand.

## Outcome log

Follow `{vault}/skill-spec.md § 11`. After each `run.mts` invocation completes (success or escalation), the CLI `main()` in `scripts/run.mts` calls `appendOutcomeLog` (`scripts/outcome-log.mts`) to append one line to `{vault}/daily/skill-outcomes/airtable-knowledge-extract.log`:

```
{date} | airtable-knowledge-extract | extract | ~/work/brain-os-plugin | <metrics-or-cache-path> | commit:none | {pass|partial|fail} | run_id=… base_id=… batches_done=… total_batches=… pass_rate=…
```

- `pass` — `kind=paused` (base completed) or `kind=no-bases` (queue drained).
- `fail` — `kind=escalated-re-anchor` or `kind=escalated-batch` (escalation reason in `escalation=` optional field).
- `commit:none` — extracted pages stage in cache, not in a tracked repo, so there is no anchor commit hash for diff detection.

If `result != pass`, auto-invoke `/brain-os:improve airtable-knowledge-extract`. The eval gate inside `/improve` reverts any change that drops pass-rate, so auto-apply is safe.
