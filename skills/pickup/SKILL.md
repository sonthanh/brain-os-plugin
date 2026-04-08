---
name: pickup
description: "Use when starting a new session and wanting to resume unfinished work from a previous handover"
---

# Pickup — Resume Work

## Step 0: Groom Backlog (runs on every invocation, silently)

Before anything else, every `/pickup` call does this:

1. Read `{vault}/business/tasks/inbox.md` and `{vault}/context/preferences.md` (timezone)
2. For each Backlog task, assess readiness:
   - **Blocked?** Check ⛓️ slugs and `blocked-by` — if any blocker is NOT in Done → stays in Backlog
   - **Clear to execute?** Does the task have enough context to act on? Consider:
     - 🤖 tasks: is there a skill, detail file, or clear instruction? → Ready
     - 👤 tasks: is the next action obvious from the description? → Ready
     - Vague tasks (no clear next step, needs scoping): → stays in Backlog
3. Move clear + unblocked tasks to Ready
4. Report promotions: "Promoted: [task names] → Ready"
5. If vague tasks remain in Backlog, append: "N tasks need context — run `/pickup groom` to classify them"

## `/pickup groom` — Interactive backlog classification

For tasks that Step 0 couldn't auto-classify (vague, needs scoping, unclear priority):

1. List each remaining Backlog task with current assessment:
   ```
   Backlog (N tasks):
   1. 👤 Fix pointer/duplicate violation enforcement
      Status: UNCLEAR — what exactly should be built? Hook? Eval? Lint rule?
      Need: user to define scope → then move to Ready
   2. ...
   ```
2. For each unclear task, ask the user targeted questions to classify it:
   - What's the concrete next step?
   - Is this 🤖 auto or 👤 manual?
   - Weight: ⚡ quick or 🏋️ heavy?
   - Any blockers?
3. Update the task in inbox.md with the classification
4. Move newly-classified tasks to Ready

## `/pickup` — Resume handover tasks (default)

After grooming:

1. Find unchecked handover tasks — lines matching `📋` tag in Ready
2. **If one task**: load its handover doc and start
3. **If multiple tasks**: show list, ask user which one to pick up
4. **If zero handover tasks**: show all Ready tasks as a summary so user can decide

## `/pickup auto` — Launch 🤖 tasks in background

After grooming:

1. **Find 🤖 tasks in Ready column**
2. **Apply time-aware filtering** (skipped if user explicitly overrides):
   - **Work hours (09:00–22:00)**: only pick `⚡` (quick) tasks. Skip `🏋️` (heavy) and untagged tasks.
   - **Off-hours (22:00–09:00) or weekends**: pick any 🤖 task including `🏋️` and untagged.
   - If no eligible 🤖 tasks: report "No eligible auto tasks for current time window."
3. **Pick the first eligible one** (top = highest priority)
4. **Move it to In Progress** in inbox.md
5. **Build the prompt** from task description + any linked detail file + skill reference
6. **Launch as background Claude process in worktree** — isolated from main work, user is NOT blocked:
   ```bash
   claude -w "auto-{slug}" \
     --model opus \
     --dangerously-skip-permissions \
     -p "<prompt>" \
     > /tmp/auto-task-{slug}.log 2>&1 &
   ```
   The prompt MUST include:
   - The full task description
   - "When done: (1) move task to Done in inbox.md, (2) commit and push, (3) send Telegram notification with task name + result summary"
   - Any linked skill invocation (e.g., `/study`, `/ingest`)
   - Ralph Loop instructions: "Do NOT stop until the task is complete. If blocked, log the blocker and move task back to Ready."
7. **Report to user immediately** (don't wait for completion):
   ```
   🚀 Launched: [task name]
   Running in background (PID: XXXX)
   Log: /tmp/auto-task-{slug}.log
   Will notify via Telegram when done.
   ```

#### `/pickup auto --all` — Launch ALL eligible 🤖 tasks

Same as above but for **every** eligible 🤖 task, not just the first one. Each task gets its own worktree:
```bash
# For each eligible task:
claude -w "auto-{slug}" \
  --model opus \
  --dangerously-skip-permissions \
  -p "<prompt>" \
  > /tmp/auto-task-{slug}.log 2>&1 &
```
All launch in parallel. Report all PIDs and logs to user at once.

#### Weight tags
- `⚡` — quick task (< 30 min), safe to run anytime
- `🏋️` — heavy task (1h+), only run off-hours

#### Auto mode rules
- **Fire-and-forget** — launch in background, report immediately, user continues working.
- **Worktree isolation** — each task runs via `claude -w` in its own worktree to avoid conflicts with main workspace.
- **No human input** — if a task requires 👤 decisions, skip it and pick the next 🤖 task.
- **Self-completing** — the background process handles: execute → update inbox.md → commit + push → notify via Telegram. Each task reports independently — whichever finishes first notifies first.
- **Respect skill flows** — if a task maps to a skill (e.g., `/study`, `/ingest`), invoke that skill with full autonomy.
- **Time-aware** — never run 🏋️ tasks during work hours unless explicitly overridden.
- **No budget cap** — tasks run until complete. Ralph Loop ensures completion.

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
