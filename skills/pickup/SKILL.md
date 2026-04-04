---
name: pickup
description: "Use when starting a new session and wanting to resume unfinished work from a previous handover"
---

# Pickup — Resume From Backlog

## Behavior

### `/pickup` — Auto-find and resume unfinished work

1. **Scan backlog** — read `{vault}/business/tasks/inbox.md`
2. **Find unchecked handover tasks** — lines matching `- [ ] [Handover]`
3. **If one task**: load its handover doc and start
4. **If multiple tasks**: show list, ask user which one to pick up
5. **If zero tasks**: "No pending handover tasks. All caught up."

### For each handover task found:
1. **Read the linked handover doc** completely (all sections)
2. **Run "Commands to Verify State"** from the handover to confirm nothing changed
3. **Present brief summary**:
   ```
   Picking up: [topic]
   Status: [status]
   TL;DR: [from handover]

   Next steps:
   1. [step 1]
   2. [step 2]

   Starting with step 1.
   ```
4. **Start executing step 1** immediately (don't wait for confirmation unless blocked)

### After completing all steps:
1. **Mark task done** in inbox.md: `- [x] [Handover] ... ✅ YYYY-MM-DD`
2. **Update handover status**: `status: completed`
3. **If new unfinished work emerged**: run `/handover` to create a new handover

## Rules

### Do NOT re-ask settled decisions
The handover's "Decisions Made" section = requirements. Never re-grill.

### Always verify state first
Run the "Commands to Verify State" before starting. Files may have changed.

### Stale handover warning
If handover is > 7 days old:
```
⚠️ This handover is [N] days old. Verifying current state first...
```

### The vault is the task queue
- `/handover` writes tasks to `inbox.md`
- `/pickup` reads tasks from `inbox.md`
- No external system, no arguments to remember
- The user just types `/pickup` and work resumes

## How to Find Handover Tasks in inbox.md
Look for lines matching:
```
- [ ] [Handover] ... → [[daily/handovers/...]] (status)
```

## Flow
```
Session A:
  /handover → creates handover doc + writes task to inbox.md

Session B (new Claude):
  /pickup → scans inbox.md → finds handover task → loads doc → executes
  ... work done ...
  marks task ✅ in inbox.md

  /handover → new handover if unfinished work remains
```
