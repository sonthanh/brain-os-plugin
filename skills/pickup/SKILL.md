---
name: pickup
description: "Use when starting a new session and wanting to resume unfinished work from a previous handover"
---

# Pickup — Resume Work

## Step 0: Groom Backlog (runs on every invocation, silently)

Before anything else, every `/pickup` call does this:

1. Read `{vault}/business/tasks/inbox.md`
2. Read timezone from `{vault}/context/preferences.md`
3. For each Backlog task, check if ALL blockers are resolved (⛓️ slugs and `blocked-by` in Done)
4. Move unblocked tasks to Ready
5. Report promotions only if something moved: "Promoted: [task names] → Ready"

This is invisible plumbing — the user never invokes it separately.

## `/pickup groom` — Explicit backlog review

Runs the same Step 0 grooming but with **verbose output**: lists every backlog task, its blockers, and whether each blocker is resolved. Reports what moved and what's still blocked.

For now this is identical to the silent groom — reserved for future interactive grooming (e.g., re-classify tasks, suggest priority, split large tasks).

## `/pickup` — Resume handover tasks (default)

After grooming:

1. Find unchecked handover tasks — lines matching `📋` tag in Ready
2. **If one task**: load its handover doc and start
3. **If multiple tasks**: show list, ask user which one to pick up
4. **If zero handover tasks**: show all Ready tasks as a summary so user can decide

## `/pickup auto` — Execute next 🤖 auto task autonomously

After grooming:

1. **Find 🤖 tasks in Ready column**
2. **Apply time-aware filtering**:
   - **Work hours (09:00–22:00)**: only pick `⚡` (quick) tasks. Skip `🏋️` (heavy) and untagged tasks.
   - **Off-hours (22:00–09:00) or weekends**: pick any 🤖 task including `🏋️` and untagged.
   - If no eligible 🤖 tasks: report "No eligible auto tasks for current time window."
3. **Pick the first eligible one** (top = highest priority)
4. **Move it to In Progress** in inbox.md
5. **If task has a detail file** (`[[slug|Name]]`): read it for context
6. **If task references a skill** (e.g., "self-learn pipeline"): invoke that skill
7. **Execute the task end-to-end** — do NOT stop to ask permission, do NOT ask for confirmation
8. **When done**:
    - Move task to Done: `- [x] 🤖 ... ✅ YYYY-MM-DD`
    - Update detail file if it exists (log entry + status)
    - Report completion status to user:
      ```
      ✅ Completed: [task name]
      Summary: [what was done, 2-3 lines]
      ```
9. **If task fails or is blocked**: report the blocker, move task back to Ready, do NOT attempt next task

#### Weight tags
- `⚡` — quick task (< 30 min), safe to run anytime
- `🏋️` — heavy task (1h+), only run off-hours

#### Auto mode rules
- **ONE task per invocation** — finish it, report, stop. User decides whether to run again.
- **No human input** — if a task requires 👤 decisions, skip it and pick the next 🤖 task.
- **No confirmation loops** — treat task description as the requirement. Execute.
- **Respect skill flows** — if a task maps to a skill (e.g., `/study`, `/ingest`), invoke that skill with full autonomy.
- **Time-aware** — never run 🏋️ tasks during work hours unless explicitly overridden.

## Handover Task Behavior

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
- The user types `/pickup auto` and the next 🤖 task runs autonomously

## How to Find Handover Tasks in inbox.md

Handover tasks:
```
- [ ] 📋 ... → [[daily/handovers/...]] (status)
```

Auto tasks:
```
- [ ] 🤖 ... (in Ready column)
```

## Flow
```
Session A:
  /handover → creates handover doc + writes task to inbox.md

Session B (new Claude):
  /pickup → scans inbox.md → finds handover task → loads doc → executes
  ... work done ...
  marks task ✅ in inbox.md

  /pickup auto → grabs top 🤖 task → executes fully → reports result
```
