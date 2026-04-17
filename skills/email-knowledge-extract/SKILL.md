---
name: email-knowledge-extract
description: "Batch-extract structured business knowledge (people, companies, meetings, decisions) from Gmail into the Obsidian vault. Sonnet-only pipeline, quota-aware, checkpoint-resumable across sessions. Use when user says /email-knowledge-extract, wants to bootstrap entity pages from historical email, or resume a paused extraction run."
---

## Vault Location
**Vault path:** Read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md`

# /email-knowledge-extract — Batch-extract knowledge from Gmail

Codifies the Phase 0-winning Sonnet-only pipeline (eval: `daily/eval-reports/2026-04-14-email-pipeline` → 82/100, Opus-judged) into a resumable batch extractor. Grill design doc: `daily/grill-sessions/2026-04-17-email-knowledge-extract-skill-design.md`.

## Design summary (why this shape)

- **Subscription-only budget.** Claude Code quota + Task subagents, never API. Quota-aware + resumable is mandatory.
- **Hybrid orchestration.** SKILL.md is the outer loop; TS helpers do deterministic work (Gmail fetch, junk filter, page write, checkpoint); Task subagents do the latent Sonnet extraction.
- **Prompt caching.** `prompts/extract.md` is structured as STABLE PREFIX + variable email suffix. Do not edit the prefix between calls within a run.
- **Session discipline.** 40-batch hard cap per session to stay clear of context compaction. Exit cleanly as `phase: paused-session-limit` and let `/pickup auto` cron resume.
- **Atomic disk state per batch.** `write-pages.ts` is the single transactional write point. Mid-batch compaction is safe because every batch leaves disk fully consistent.
- **Idempotent append.** Every entity page has a `sources:` frontmatter array; if `msg_id` is already there, Timeline append is a no-op. Resume after a crash never duplicates.

## Behavior

### `/email-knowledge-extract` — Start or resume a 1y extraction run

Default run-id: `$(date +%Y-%m-%d)-1y`. Default window: 1y. Default batch size: 20. Default session cap: 40 batches.

1. **Resolve vault path** from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md`.
2. **Detect resume vs fresh.** Read `{vault}/daily/email-extraction-state.json` if present.
   - Exists and `phase ∈ {running, paused-session-limit, paused-quota, paused-manual}` → resume.
   - Exists and `phase == completed` → tell the user, offer to start a new run with a new `run_id`. Stop.
   - Does not exist → fresh run. Tell the user the planned `run_id`, window, window_start, window_end. Proceed without confirmation.
3. **Session reset.** Run `tsx ${CLAUDE_PLUGIN_ROOT}/skills/email-knowledge-extract/scripts/save-state.ts --reset-session --phase running` before the first batch, so `batches_this_session` starts at 0 and `phase` is `running`.
4. **Outer loop** (repeat until a termination condition below fires):
   1. **Fetch batch.**
      ```bash
      tsx ${CLAUDE_PLUGIN_ROOT}/skills/email-knowledge-extract/scripts/fetch-batch.ts \
        --run-id $RUN_ID --count 20
      ```
      Capture stdout as JSON array `$BATCH`.
      - If `$BATCH` is `[]` → call `save-state.ts --phase completed`; report summary; stop.
   2. **Load the extraction prompt ONCE per session.** Read `${CLAUDE_PLUGIN_ROOT}/skills/email-knowledge-extract/prompts/extract.md` into a variable `$PROMPT_PREFIX`. This is the STABLE PREFIX used across every Task subagent call — prompt-cache hits depend on it not changing.
   3. **Fan out Task subagents.** Emit one assistant turn containing **one Task tool_use block per email in `$BATCH`** (up to 20). Each block's prompt is the concatenation of `$PROMPT_PREFIX` + the VARIABLE SUFFIX (the single email's headers + labelIds + junk_filter_reason + body). Each subagent MUST return only a single JSON object matching `references/entity-schema.md` — no prose, no code fences.
   4. **Collect outputs.** For each subagent return, the raw JSON string is what we persist — do NOT parse/re-serialize in the parent; `write-pages.ts` validates. Assemble an array `$RESULTS` of rows:
      ```json
      { "email_id": "<id>", "sonnet_raw_text": "<raw>", "email_meta": { "msg_id": "<id>", "thread_id": "...", "subject": "...", "from": "...", "date": "...", "body": "<truncated>", "gmail_url": "...", "internal_date": "...", "junk_filter_reason": "..." }, "is_retry": false }
      ```
      Write `$RESULTS` to a temp file (e.g., `/tmp/email-knowledge-extract/batch-$(date +%s).json`).
   5. **Atomic write.**
      ```bash
      tsx ${CLAUDE_PLUGIN_ROOT}/skills/email-knowledge-extract/scripts/write-pages.ts \
        --run-id $RUN_ID --results $RESULTS_FILE
      ```
      Parse the stdout JSON for `{ batches_this_session, counts, warnings, failed, last_msg_id }`.
   6. **Check termination conditions.**
      - `batches_this_session >= 40` → `save-state.ts --phase paused-session-limit`; report summary; stop.
      - Any Task subagent returned a clear quota-exhausted signal (stderr "rate_limit_exceeded" / "quota" / 429) → `save-state.ts --phase paused-quota`; report; stop.
      - `$BATCH` had fewer than `count` messages (and not `[]`) — continue; the next loop will probably hit `[]` and complete.
      - Else → loop (step 4.1).

### `/email-knowledge-extract status` — Show run progress

1. Read `{vault}/daily/email-extraction-state.json`.
2. Report:
   ```
   run_id: {run_id}  window: {window}  phase: {phase}
   processed: {processed_count} / {total_estimated} ({%})
   extracted: {extracted_count}  empty: {extracted_empty_count}  failed: {error_count}
   batches: {batches_completed} total  ({batches_this_session} this session)
   last checkpoint: {last_checkpoint_at}
   last msg: {last_msg_id}  ({last_internal_date})
   failed_ids pending retry: {count_with_attempts_lt_3}
   ```

### `/email-knowledge-extract dry-run` — Validate on frozen 100-email sample

Runs the full extraction loop against `references/phase0-samples.json` (frozen Phase 0 fixture) instead of live Gmail. Use to verify the skill works end-to-end after edits.

1. Set `RUN_ID=dryrun-$(date +%Y-%m-%d-%H%M)`.
2. Start with a fresh state: remove any `{vault}/daily/email-extraction-state.json` that has the dryrun `run_id` (never touch a real run's state).
3. Execute the outer loop with `--fixture ${CLAUDE_PLUGIN_ROOT}/skills/email-knowledge-extract/references/phase0-samples.json` added to every `fetch-batch.ts` invocation.
4. Run until `fetch-batch.ts` returns `[]`. Report:
   - Batches executed, entities created, Patch 3 WARNs emitted, failures.
   - Top 5 entities created (most Timeline entries).
5. Do NOT commit the dry-run artifacts. They serve as smoke-test output for the caller to inspect, then discard.

### `/email-knowledge-extract reset` — Abandon run (destructive — confirm first)

Prompts the user for confirmation before:
1. Moving `{vault}/daily/email-extraction-state.json` to `{vault}/daily/email-extraction-state.json.abandoned-$(date +%s)`.
2. Moving `{vault}/business/intelligence/email-extraction/<run_id>/` to `…/<run_id>.abandoned/`.
3. Does NOT touch entity pages already written — they're correct data, just paused mid-run.

Never run this without explicit user consent.

## Quota + rate-limit handling

- **Gmail 429** — `fetch-batch.ts` retries with exponential backoff (1s, 2s, 4s). After 3 failures it throws and the orchestrator should `save-state.ts --phase paused-manual` and stop.
- **Sonnet quota exhausted** — the Task subagent usually surfaces this as an error message or a structured "rate_limit_exceeded" payload. On first such signal, call `save-state.ts --phase paused-quota` and stop. `/pickup auto` picks the skill back up on its next cron tick (every 3h) — quota typically replenishes within the 5h rolling window.

## Concurrency knobs

Tune at call-time if you observe quota burning too fast:

- `--count N` on `fetch-batch.ts` — number of emails per batch (default 20; ceiling 50 per design).
- Number of Task tool_use blocks per assistant turn — match `--count` 1:1 by default; drop to 10 if a session feels slow.

## Checkpoints + safety-net artifacts

Every run writes:

- `{vault}/daily/email-extraction-state.json` — lean committable state (progress counts, cursor, phase, failed_ids).
- `{vault}/business/intelligence/email-extraction/{run_id}/processed-ids.jsonl` — one line per email processed (msg_id + outcome). **gitignored**.
- `{vault}/business/intelligence/email-extraction/{run_id}/skipped.jsonl` — one line per junk-filter skip (audit trail). **gitignored**.
- `{vault}/business/intelligence/email-extraction/{run_id}/warnings.jsonl` — Patch 3 drift signals + fuzzy-match candidates. **gitignored**.
- `{vault}/business/intelligence/email-extraction/{run_id}/raw-extractions.jsonl` — every validated Sonnet output, un-deduplicated, full fidelity. **gitignored**. Used by `/improve` to propose prompt tweaks without re-running Sonnet.
- `{vault}/business/intelligence/email-extraction/{run_id}/failed.jsonl` — every validation failure with attempts + detail. **gitignored**.

The `business/intelligence/email-extraction/` directory must be in `{vault}/.gitignore` (the skill does not fail if the line is missing, but CI may flag it).

## Phase 0 patches baked in

All three patches from `references/phase0-patches.md` are already in `prompts/extract.md`:

1. **Payment notification extraction** — prompt instructs Sonnet to extract `decisions[]` for any payment email with amount ≥ USD 10 equivalent, regardless of sender automation.
2. **CC-chain actor extraction** — prompt instructs Sonnet to parse signature blocks + quoted-reply chains for actors.
3. **No EMVN self-reference** — prompt rule + TS WARN in `sanity-check.ts::patch3Warnings()`. Warnings are logged, not auto-stripped.

`/improve email-knowledge` reviews `warnings.jsonl` to propose prompt v2.

## `/improve` integration

Expose the following signals (all via JSONL in `business/intelligence/email-extraction/{run_id}/`):

- Skip-rate by rule (top-N skip reasons; false-skip candidates) from `skipped.jsonl`.
- Validation failure patterns from `failed.jsonl` (error kind × frequency).
- Patch 3 drift from `warnings.jsonl`.
- Fuzzy-match candidates → suggest human merge or canonical-slug alias.
- Empty-output ratio (`extracted_empty / processed`) by sender/domain — detects classes Sonnet is under-extracting from.

---

## Outcome log

`write-pages.ts` appends one line per batch to `{vault}/daily/skill-outcomes/email-knowledge-extract.log`:

```
{date} | email-knowledge-extract | batch | ~/work/brain-os-plugin | {state.json path} | commit:N/A | {pass|partial|fail} | run={run_id} processed=N extracted=N empty=N failed=N warnings=N
```

- `pass` if zero failures in the batch.
- `partial` if any failures but at least one extraction succeeded.
- `fail` (manual insertion by orchestrator) if a session terminated on an unrecoverable error (not routine quota pause).

## Skill trace

Per `skill-spec.md §12`, SKILL.md invocations are captured via the PostToolUse hook to `{vault}/daily/skill-traces/email-knowledge-extract.jsonl`. No action required inside SKILL.md — the hook handles it.

## Phase 0.5 DoD cross-check

A run is "done" for Phase 0.5 when:
- Skill exists at `~/work/brain-os-plugin/skills/email-knowledge-extract/` with all files listed in the grill Build Checklist.
- `dry-run` on `references/phase0-samples.json` completes end-to-end without errors.
- At least one Patch 3 WARN observed in `warnings.jsonl` on the dry-run (proves the drift detector is wired).
- At least one Patch 1 force-extract observed in `skipped.jsonl` ORM payment-email extraction in `raw-extractions.jsonl`.
- Entity pages created under `{vault}/people/` and/or `{vault}/companies/` with `sources:` frontmatter, Timeline entries with Gmail URLs, Compiled Truth stubs.
- Outcome log has a line; skill trace hook wrote at least one event.
- Committed + pushed to `brain-os-plugin` main (auto-syncs to installed cache).
