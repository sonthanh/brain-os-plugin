---
name: pickup
description: "Use when starting a new session and wanting to resume unfinished work from a previous handover"
---

# Pickup — Resume Work

## `/pickup` — Single interactive flow

1. Read `{vault}/business/tasks/inbox.md`

2. **Handovers first:** Find unchecked 📋 tasks not already In Progress
   - Found → move to In Progress (session lock) → load handover doc → start
   - Multiple → show list, ask user which one
   - None → continue to step 3

3. **Ready tasks?**
   - **Yes** → skip to step 4 (no groom needed)
   - **No** → groom Backlog: promote unblocked + clear tasks to Ready, ask user about vague ones

4. **Autogrill Ready tasks** (see Autogrill section below)

5. **Start top remaining task** — first Ready task → In Progress → begin

## Step 2: Autogrill Ready Tasks

For each non-📋 Ready task, run vault-first Q&A:

1. **Generate grill questions** — the same questions you'd ask a human:
   - What's the goal?
   - What context exists?
   - What are the constraints/requirements?
   - What's the expected output?
   - Task-specific questions based on the domain
   - Aim for 5-10 questions per task

2. **Search vault for each answer** — grep, read wiki-links, follow references

3. **Log the Q&A** to `{vault}/daily/grill-sessions/YYYY-MM-DD-autogrill.md`:
   ```markdown
   ## HH:MM — <task name>

   ### Q&A

   | # | Question | Answer | Source |
   |---|----------|--------|--------|
   | 1 | What is X? | Found: ... | [[path/to/source]] |
   | 2 | How does Y? | ❌ NOT FOUND | — |

   ### Gaps (needs human)
   - Q2: How does Y?

   ### Decision
   - N/M answered → auto-close / escalate

   ### Artifacts
   - Files created/modified
   ```

4. **Decide per task:**
   - **≥80% questions answered** → auto-close: produce the artifact, mark Done, log process
   - **<80% answered** → escalate: surface specific unanswered questions for human grill

5. **Run tasks in parallel** — launch multiple agents for independent tasks

6. **Present results:**
   ```
   Autogrill complete:
   ✅ [Task A] — auto-closed (7/8 questions answered)
   ❓ [Task B] — needs you on 4 questions:
      - Q3: What pricing model?
      - Q5: What's the timeline?
      - Q7: Who is the target?
      - Q8: What channels?
   ```

### After human answers gaps:

When the user grills on the remaining questions:
1. **Write answers back to vault** — update the relevant context/strategy/goals files
2. **Re-run autogrill** on the task — should now auto-close with full answers
3. The vault gets smarter every cycle

## `/pickup auto` — Launch tasks in background

1. **Find eligible tasks in Ready column** — apply time-aware filtering:
   - **Work hours (09:00–22:00)**: only pick `⚡` (quick) tasks. Skip `🏋️` (heavy).
   - **Off-hours (22:00–09:00) or weekends**: pick any task including `🏋️`.
2. **Pick eligible tasks** and move to In Progress
3. **Launch as background Claude process in worktree**:
   ```bash
   claude -w "auto-{slug}" \
     --model opus \
     --dangerously-skip-permissions \
     -p "<prompt>" \
     > /tmp/auto-task-{slug}.log 2>&1 &
   ```
   The prompt MUST include the full task description + autogrill Q&A log instructions + Ralph Loop.
4. **Report immediately** (don't wait for completion)

#### `/pickup auto --all` — Launch ALL eligible tasks in parallel

Same as above but for every eligible task. Each gets its own worktree.

#### Weight tags
- `⚡` — quick task (< 30 min), safe to run anytime
- `🏋️` — heavy task (1h+), only run off-hours

#### Auto mode rules
- **Fire-and-forget** — launch in background, report immediately, user continues working.
- **Worktree isolation** — each task runs via `claude -w` to avoid conflicts.
- **Self-completing** — execute → log autogrill Q&A → update inbox.md → commit + push.
- **Respect skill flows** — if a task maps to a skill, invoke that skill.
- **Time-aware** — never run 🏋️ tasks during work hours unless explicitly overridden.
- **No budget cap** — tasks run until complete. Ralph Loop ensures completion.

## Handover Task Behavior

### For each handover task found:
1. **Read the linked handover doc** completely (all sections)
2. **Run "Commands to Verify State"** from the handover to confirm nothing changed
3. **Check for incomplete grills** — scan handover for "INCOMPLETE", "NOT completed", "grill session started but". If found:
   - Do NOT start executing tasks
   - Present the incomplete grill status
   - Resume the grill FIRST using `/grill <topic>` before any implementation
4. **Present brief summary**:
   ```
   Picking up: [topic]
   Status: [status]
   TL;DR: [from handover]

   Next steps:
   1. [step 1]
   2. [step 2]

   Starting with step 1.
   ```
5. **Start executing step 1** immediately (don't wait for confirmation unless blocked)

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

## Flow
```
Session A:
  /handover → creates handover doc + writes task to inbox.md

Session B (new Claude):
  /pickup → straight to handovers → load doc → start working
  ... work done ...
  marks task ✅ in inbox.md

  /pickup auto → launch eligible in background → self-completes
```
