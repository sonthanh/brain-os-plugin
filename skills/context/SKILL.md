---
name: context
description: "Use when needing to load full context about the user — identity, business, goals, current state, and pending tasks"
---

## Vault Location
**Vault path:** Read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md`

# /context -- Load Full Context

## Behavior
When I type `/context`, load comprehensive context about me:

1. Read ALL files in `{vault}/context/` to understand who I am, my business, strategy, ICP, brand, team, preferences, and goals
2. Read the latest 3-5 daily notes from `{vault}/daily/` to understand my current state
3. Scan `{vault}/business/tasks/inbox.md` for pending items
4. Check `{vault}/thinking/ideas/` for any active ideas
5. Summarize what you now know:
   - Who I am and what I do
   - Current priorities and focus areas
   - Recent activity and decisions
   - Pending tasks
   - Active ideas and projects
6. Say: "Context loaded. I now have a complete picture of your current state. What would you like to work on?"
