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
   - **Clear to execute?** Does the task have enough context to act on? → Ready
   - Vague tasks (no clear next step, needs scoping): → stays in Backlog
3. Move clear + unblocked tasks to Ready
4. Report promotions: "Promoted: [task names] → Ready"
5. If vague tasks remain in Backlog, append: "N tasks need context — run `/pickup groom` to classify them"

## `/pickup groom` — Interactive backlog classification

For tasks that Step 0 couldn't auto-classify (vague, needs scoping, unclear priority):

1. List each remaining Backlog task with current assessment
2. For each unclear task, ask the user targeted questions:
   - What's the concrete next step?
   - Weight: ⚡ quick or 🏋️ heavy?
   - Any blockers?
3. Update the task in inbox.md with the classification
4. Move newly-classified tasks to Ready

## `/pickup` — Resume handover tasks (default)

After grooming:

1. Find unchecked handover tasks — lines matching `📋` tag in Ready
2. **If one task**: load its handover doc and start
3. **If multiple tasks**: show list, ask user which one to pick up
4. **If zero handover tasks**: run **Step 2: Autogrill** on Ready tasks

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

## `/pickup next` — Start the top priority Ready task

After grooming:

1. Pick the first task in Ready column (top = highest priority)
2. Move it to In Progress in inbox.md
3. If task has a detail file: read it for context
4. Start working on it immediately

## `/pickup auto` — Launch tasks in background

After grooming:

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

## Flow
```
Session A:
  /handover → creates handover doc + writes task to inbox.md

Session B (new Claude):
  /pickup → groom → handovers first → autogrill remaining → surface gaps
  ... work done ...
  marks task ✅ in inbox.md

  /pickup auto → grabs eligible tasks → launches in background → self-completes
```
