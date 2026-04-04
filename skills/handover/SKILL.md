---
name: handover
description: "Use when ending a session with unfinished work that needs to be continued in a future session"
---

# Handover — Session Continuity Skill

Creates a handover document and writes a task to the vault backlog. The next session runs `/pickup` to resume.

## Behavior

### `/handover` — Save session state + create backlog task

1. **Scan the current session** — what was discussed, decided, built, still pending
2. **Create handover file** at `{vault}/daily/handovers/YYYY-MM-DD-topic.md`
3. **Write a task to backlog** at `{vault}/business/tasks/inbox.md`:
   ```
   - [ ] [Handover] Topic description → [[daily/handovers/YYYY-MM-DD-topic]] (status: ready-to-continue)
   ```
4. **Update MEMORY.md** with pointer to handover

The vault IS the task queue. No commands to remember.

## Handover Document Template

```markdown
---
title: "Handover: [topic]"
created: YYYY-MM-DDTHH:MM:SS
status: in-progress | blocked | ready-to-continue
tags: [handover, topic]
---

# Handover: [Topic]

## TL;DR
[2-3 sentences: what was this session about, where did we stop, what's next]

## Session Summary
[What was accomplished — be specific with file paths and numbers]

## Decisions Made (SETTLED — do NOT re-ask)
| Decision | Answer | Why |
|----------|--------|-----|

## Current State
- Files created: [full paths]
- Files modified: [full paths]
- Tools installed: [with paths]
- Git status: [committed? pushed?]

## What's Next
1. [Step 1 — exactly what to do, which files to touch]
2. [Step 2]
3. [Step 3]

## Blockers / Open Questions
- [anything needing user input]

## Key File Locations
| What | Path |
|------|------|

## Commands to Verify State
```bash
# Run these first to confirm nothing changed since handover
[commands]
```

## Context the Next Session Needs
[User preferences, constraints, gotchas not captured elsewhere]
```

## Rules

### Be Specific, Not Vague
- **Wrong**: "Continue working on the plugin"
- **Right**: "Create plugin.json at ~/work/brain-os/plugin.json. Move 24 skill dirs from ~/.claude/skills/ into brain-os/skills/. Test with `cowork install .`"

### Full Paths Only
Every file reference = absolute path. Next session has no memory of "that file."

### Decisions = SETTLED
If grilled and confirmed, the next session MUST NOT re-ask.

### Always Write to Backlog
The handover is useless if nobody reads it. The backlog task in `inbox.md` ensures `/pickup` finds it.

### Task Format in inbox.md
```
- [ ] [Handover] Short description → [[daily/handovers/YYYY-MM-DD-topic]] (status)
```
When `/pickup` completes the task, it marks it done:
```
- [x] [Handover] Short description → [[daily/handovers/YYYY-MM-DD-topic]] ✅ YYYY-MM-DD
```
