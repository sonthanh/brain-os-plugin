---
name: study
description: "Use when running the complete knowledge pipeline for a book, from self-learn through ingestion, verification, absorption, and sync"
context: fork
---

# Study — Full Knowledge Pipeline Orchestrator

## Usage
```
/study <epub_path> --notebook-id <nlm_id>
/study --resume              Resume a pipeline that was interrupted
/study --status              Show pipeline status for all books
```

## Full Pipeline
```
Step 1: /self-learn --book <epub> --notebook-id <id>
  ├── Phase 1: Extract (epub → atomic notes in knowledge/raw/)
  ├── Phase 2: Validate (questions vs NotebookLM, ≥95 threshold, 100% pass)
  └── Phase 3: Extend + Ingest (book note in knowledge/books/ + synthesis)
        ↓
Step 2: /verify (50 fresh questions vs NotebookLM → audit flag)
  ├── PASS → audited: true
  └── FAIL → audited: false → STOP, notify user
        ↓
Step 3: /absorb (book note → vault connections, bypass approval since audited: true)
        ↓
Step 4: commit + push (git commit + push all changes)
        ↓
Step 5: Notify all 3 channels
  ├── Obsidian task in business/tasks/inbox.md
  ├── Daily note entry
  └── Audit flag updated with pipeline_completed timestamp
```

## How to Execute

**IMPORTANT: Run each step sequentially. Do NOT skip steps.**

### Step 1: Self-Learn (includes ingestion)
```
/self-learn --book <epub_path> --notebook-id <nlm_id>
```
Wait for all 3 phases to complete. Phase 3 now creates the structured book note
in `knowledge/books/` (previously a separate `/ingest` step). Check with `/self-learn --status`.

### Step 2: Verify
```bash
python3 ${CLAUDE_PLUGIN_ROOT}/skills/verify/scripts/verify.py {vault}/knowledge/raw --status
```
If flag is `false`, run `/verify` with 50 fresh questions.
If flag is already `true` (from self-learn validation), proceed.

### Step 3: Absorb
Run the `/absorb` skill. Since verify is true, bypass approval — apply all vault connections automatically.

### Step 4: Commit + Push
Commit and push all vault changes to git.

### Step 5: Notify
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
If pipeline is interrupted, `/study --resume` checks audit-flag.json to determine which step to resume from.

## Error Handling
- **Phase 2 fails (< 100% pass)**: Loop continues fixing until 100%. No timeout.
- **Verify fails**: Pipeline stops. Flag stays false. Task written to inbox.
- **Git push fails**: Pull first, resolve conflicts, retry push.
- **NotebookLM timeout**: Retry 3 times with backoff. If still failing, pause and notify user.

## Outcome log

<<<<<<< Updated upstream
Follow `skill-spec.md § 11`. Append to `{vault}/daily/skill-outcomes/study.log`:

```
{date} | study | study | ~/work/brain-os-plugin | knowledge/books/{slug}.md | commit:{hash} | {result}
```

- `result`: `pass` if full pipeline complete (self-learn → verify → absorb → commit), `partial` if interrupted mid-pipeline, `fail` if verify fails
- Optional: `args="{epub_path}"`, `score={step_reached}/5`
=======
After each `/study` run, append one line to `{vault}/daily/skill-outcomes/study.log`:

```
{date} | study | {action} | ~/work/brain-os-plugin | {vault}/knowledge/books/{book-slug}.md | commit:{hash} | {result}
```

- `mode`: `full`, `resume`, or `status`
- `result`: `pass` if full pipeline completed, `partial` if stopped at verification, `fail` if errors
>>>>>>> Stashed changes
