---
name: audit
description: "Use when verifying ingested book knowledge against NotebookLM, checking audit status, or managing audit flags before absorbing"
---

# Knowledge Audit

Independent verification of self-learn knowledge. Runs 50 fresh questions against NotebookLM to catch errors the original validation missed. Audit is separate from self-learn — it owns the `audited` flag entirely.

## Configuration
```yaml
obsidian_vault: /Users/thanhdo/work/brain/knowledge/raw
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
# Run audit
python3 ${CLAUDE_PLUGIN_ROOT}/skills/audit/scripts/audit.py /Users/thanhdo/work/brain/knowledge/raw <optional-fuzzy-name>

# Check status
python3 ${CLAUDE_PLUGIN_ROOT}/skills/audit/scripts/audit.py /Users/thanhdo/work/brain/knowledge/raw --status

# Set flag
python3 ${CLAUDE_PLUGIN_ROOT}/skills/audit/scripts/audit.py /Users/thanhdo/work/brain/knowledge/raw --set-flag <true|false|manual> <optional-fuzzy-name>
```

## How Audit Runs

1. Fuzzy match book name against `knowledge/raw/` folders
2. Generate 50 fresh questions (25 topic, 15 cross-cutting, 10 adversarial)
3. Agent answers from Obsidian notes only
4. NotebookLM answers via `notebooklm ask`
5. LLM-as-judge scores at ≥95 threshold
6. 100% pass → `audited: true`. Any fail → `audited: false`, report to inbox

Results saved to `{book_vault}/_validation/audit-results-{date}.jsonl`.
