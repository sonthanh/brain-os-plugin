---
name: chain
description: "Use when running the complete knowledge pipeline for a book, from self-learn through ingestion, audit, absorption, and sync"
---

# Chain — Full Knowledge Pipeline Orchestrator

## Usage
```
/chain <epub_path> --notebook-id <nlm_id>
/chain --resume              Resume a pipeline that was interrupted
/chain --status              Show pipeline status for all books
```

## Full Pipeline
```
Step 1: /self-learn --book <epub> --notebook-id <id>
  ├── Phase 1: Extract (epub → atomic notes in knowledge/raw/)
  ├── Phase 2: Validate (questions vs NotebookLM, ≥95 threshold, 100% pass)
  └── Phase 3: Extend (synthesis + applied + research)
        ↓
Step 2: /ingest (raw notes → structured book note in knowledge/books/)
        ↓
Step 3: /audit (50 fresh questions vs NotebookLM → audit flag)
  ├── PASS → audited: true
  └── FAIL → audited: false → STOP, notify user
        ↓
Step 4: /absorb (book note → vault connections, bypass approval since audited: true)
        ↓
Step 5: /sync (git commit + push all changes)
        ↓
Step 6: Notify all 3 channels
  ├── Obsidian task in business/tasks/inbox.md
  ├── Daily note entry
  └── Audit flag updated with pipeline_completed timestamp
```

## How to Execute

**IMPORTANT: Run each step sequentially. Do NOT skip steps.**

### Step 1: Self-Learn
```
/self-learn --book <epub_path> --notebook-id <nlm_id>
```
Wait for all 3 phases to complete. Check with `/self-learn --status`.

### Step 2: Ingest
Run the `/ingest` skill on the book's raw notes folder.

### Step 3: Audit
```bash
python3 ${CLAUDE_PLUGIN_ROOT}/skills/audit/scripts/audit.py {vault}/knowledge/raw --status
```
If flag is `false`, run `/audit` with 50 fresh questions.
If flag is already `true` (from self-learn validation), proceed.

### Step 4: Absorb
Run the `/absorb` skill. Since audit is true, bypass approval — apply all vault connections automatically.

### Step 5: Sync
Run `/sync` to commit and push all changes to git.

### Step 6: Notify
- Add review task to `business/tasks/inbox.md`
- Create/update daily note with pipeline log
- Update audit flag with `pipeline_completed` timestamp

## Pipeline State
Each book's pipeline state is tracked in `_validation/audit-flag.json`:
```json
{
  "flag": "true|false|manual",
  "last_audit": "ISO timestamp",
  "audit_score": "159/159 at >=95",
  "pipeline_completed": "ISO timestamp",
  "ingested": true,
  "absorbed": true
}
```

## Resume
If pipeline is interrupted, `/chain --resume` checks audit-flag.json to determine which step to resume from.

## Error Handling
- **Phase 2 fails (< 100% pass)**: Loop continues fixing until 100%. No timeout.
- **Audit fails**: Pipeline stops. Flag stays false. Task written to inbox.
- **Git push fails**: Pull first, resolve conflicts, retry push.
- **NotebookLM timeout**: Retry 3 times with backoff. If still failing, pause and notify user.
