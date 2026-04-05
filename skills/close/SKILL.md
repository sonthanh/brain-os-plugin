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
6. **Gmail triage cleanup** -- check `{vault}/daily/gmail-triage/` for any unprocessed reports from today. If any remain:
   - List the pending actions count
   - Warn: "You have N unprocessed email actions. Run `/gmail` before closing, or they'll carry over to tomorrow."
7. **Suggest vault updates** -- any context files that should be updated based on today's work?
8. Send Telegram summary (read chat ID from `{vault}/context/about-me.md`) with: completed items, carry-over items, pending gmail actions.
9. Say: "Day closed. Tomorrow's top carry-over items: [list]. Anything to add to your reflections?"

## Auto-Schedule
This skill is designed to run as a **scheduled remote task at 10:30 PM Europe/Zurich** daily.
It pushes the end-of-day summary to the vault on main and sends a Telegram notification.
Set up via `/schedule` or `claude.ai/code/scheduled`.
