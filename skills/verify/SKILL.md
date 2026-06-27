---
name: verify
description: "Use when verifying ingested book knowledge against NotebookLM, checking verification status, or managing audit flags before absorbing"
---

# Knowledge Verify

Independent verification of self-learn knowledge. Runs 50 fresh questions against NotebookLM to catch errors the original validation missed. Verify is separate from self-learn — it owns the `audited` flag entirely.

## Configuration
```yaml
obsidian_vault: "{vault}/knowledge/raw"  # Read {vault} from ${CLAUDE_PLUGIN_ROOT}/brain-os.config.md
notebooklm_bin: ~/.local/bin/notebooklm
```

## Audit Flags

| Flag | `/think` | `/absorb` |
|------|----------|-----------|
| `true` (verified) | No warning | Auto-absorb |
| `false` (unverified) | Warning | Blocked |
| `manual` (re-review) | Warning | Approval prompt |

Stored in `{book_vault}/_validation/audit-flag.json`.

## Commands

**Always run the script — it handles fuzzy matching and execution.**

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(ls -d ~/.claude/plugins/cache/brain-os-marketplace/brain-os/*/ 2>/dev/null | sort -V | tail -1)}"; PLUGIN_ROOT="${PLUGIN_ROOT%/}"
# Run verify
python3 ${PLUGIN_ROOT}/skills/verify/scripts/verify.py {vault}/knowledge/raw <optional-fuzzy-name>

# Check status
python3 ${PLUGIN_ROOT}/skills/verify/scripts/verify.py {vault}/knowledge/raw --status

# Set flag
python3 ${PLUGIN_ROOT}/skills/verify/scripts/verify.py {vault}/knowledge/raw --set-flag <true|false|manual> <optional-fuzzy-name>
```

## How Verify Runs

A 5-phase flow. NotebookLM is rate-limited, so the oracle batch stays **sequential and OUTSIDE** the fan-out; only the per-question judge + reduce run inside the Workflow (the Workflow runtime has no `fs`/subprocess). The judge runner is shared — `references/verify.workflow.js` is parameterized by `threshold` so `/self-learn` consumes the same file at 90 while verify runs at 95.

```
[0] Bash/agent  gen 50 fresh Qs (25 topic / 15 cross-cutting / 10 adversarial) → questions.json
[1] Bash        run_validation.py → oracle answers   (sequential, backoff — REUSED verbatim, rate-limited)
                  load items: {qid, question, topic, oracleAnswer, noteScope}
                  └── args (oracle answer INLINE per item) ──▶
[2] Workflow    references/verify.workflow.js · parallel(50): one judge agent per question —
                  reads ONLY its scoped notes, forms its own answer, compares vs its INLINE
                  oracleAnswer at ≥95 → {qid, score, pass, gap}
[3] reduce      (pure JS, in-workflow) passRate · weakClusters (fails clustered by topic) ·
                  audited = (every score ≥ threshold)
                  ◀── result: {passRate, audited, perQuestion, weakClusters} ──┘
[4] Bash        write audit-results-{date}.jsonl from perQuestion · set flag via
                  `verify.py --set-flag <true|false>` (merges — preserves pipeline_completed /
                  ingested / absorbed / notebook_id) · on any fail write the inbox report ·
                  append the outcome-log line
```

1. **Generate questions** — fuzzy match the book against `knowledge/raw/`, generate 50 fresh questions, write `questions.json` (`{id, q, type, topic}`, the self-learn format).
2. **Oracle batch** — `run_validation.py` (reused verbatim) asks NotebookLM each question via `notebooklm ask` sequentially with exponential backoff, producing one oracle answer per question. Assemble the items `{qid, question, topic, oracleAnswer, noteScope}`.
3. **Judge fan-out** — invoke the Workflow tool on `references/verify.workflow.js` with `{items, bookPath, threshold: 95}`. Each worker is handed its single `oracleAnswer` inline and reads only its own note scope — no other question's oracle answer or notes enter its context.
4. **Reduce** — the workflow returns `{passRate, audited, perQuestion, weakClusters}`. `audited` is true ONLY when every question scored ≥95 (and every question was judged).
5. **Write outputs** — write `{book_vault}/_validation/audit-results-{date}.jsonl` from `perQuestion`; set the flag with `verify.py --set-flag true|false` (the writer merges, preserving non-managed keys); on any fail, write the inbox report naming the `weakClusters`.

Results saved to `{book_vault}/_validation/audit-results-{date}.jsonl`.

## Outcome log

Follow `skill-spec.md § 11`. Append to `{vault}/daily/skill-outcomes/verify.log`:

```
{date} | verify | verify | ~/work/brain-os-plugin | knowledge/raw/{slug}/_validation/audit-results-{date}.jsonl | commit:{hash} | {result}
```

- `result`: `pass` if 100% questions score ≥95 (audited=true), `fail` if any question fails (audited=false)
- Optional: `args="{book-name}"`, `score={passed}/{total}`
