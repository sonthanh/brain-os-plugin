---
name: close
description: "Use when ending the day, wrapping up a work session, or needing to extract action items and surface connections from today's activity"
---

## Vault Location
**Vault path:** Read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md`

# /close -- End of Day Processing

## Behavior
When I type `/close`, run end-of-day processing:

1. **Review today's daily note** at `{vault}/daily/YYYY-MM-DD.md` -- what was planned vs what happened
2. **Extract action items** -- find any unfinished tasks, promises, or follow-ups
3. **Surface vault connections** -- identify new links between today's work and existing vault files
4. **Log decisions** -- if any decisions were made today across sessions, ensure they are saved
5. **Update daily note** with:
   - Completed items checked off
   - New action items for tomorrow
   - Key decisions made
   - Reflections prompt: ask me "What is one thing you learned or noticed today?"
6. **Suggest vault updates** -- any context files that should be updated based on today's work?
7. Say: "Day closed. Tomorrow's top carry-over items: [list]. Anything to add to your reflections?"
