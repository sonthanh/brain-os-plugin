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
# Run verify
python3 ${CLAUDE_PLUGIN_ROOT}/skills/verify/scripts/verify.py {vault}/knowledge/raw <optional-fuzzy-name>

# Check status
python3 ${CLAUDE_PLUGIN_ROOT}/skills/verify/scripts/verify.py {vault}/knowledge/raw --status

# Set flag
python3 ${CLAUDE_PLUGIN_ROOT}/skills/verify/scripts/verify.py {vault}/knowledge/raw --set-flag <true|false|manual> <optional-fuzzy-name>
```

## How Verify Runs

1. Fuzzy match book name against `knowledge/raw/` folders
2. Generate 50 fresh questions (25 topic, 15 cross-cutting, 10 adversarial)
3. Agent answers from Obsidian notes only
4. NotebookLM answers via `notebooklm ask`
5. LLM-as-judge scores at ≥95 threshold
6. 100% pass → `audited: true`. Any fail → `audited: false`, report to inbox

Results saved to `{book_vault}/_validation/audit-results-{date}.jsonl`.

## Outcome log

<<<<<<< Updated upstream
Follow `skill-spec.md § 11`. Append to `{vault}/daily/skill-outcomes/verify.log`:

```
{date} | verify | verify | ~/work/brain-os-plugin | knowledge/raw/{slug}/_validation/audit-results-{date}.jsonl | commit:{hash} | {result}
```

- `result`: `pass` if 100% questions score ≥95 (audited=true), `fail` if any question fails (audited=false)
- Optional: `args="{book-name}"`, `score={passed}/{total}`
=======
After each `/verify` run, append one line to `{vault}/daily/skill-outcomes/verify.log`:

```
{date} | verify | {action} | ~/work/brain-os-plugin | {book_vault}/_validation/audit-results-{date}.jsonl | commit:{hash} | {result}
```

- `mode`: `verify`, `status`, or `set-flag`
- `result`: `pass` if 100% questions pass, `partial` if <100% pass rate, `fail` if errors
>>>>>>> Stashed changes
