---
name: today
description: "Use when starting the day, needing a prioritized plan, or wanting to review tasks, calendar, and recent activity"
---

## Vault Location
**Vault path:** Read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md`

# /today -- Morning Review

## Behavior
When I type `/today`, create a prioritized plan for the day:

1. **Read recent context**: last 5 daily notes from `{vault}/daily/`, `{vault}/context/strategy.md`, `{vault}/context/goals.md`
2. **Check tasks**: `{vault}/business/tasks/inbox.md` for pending items
3. **Review active projects**: scan `{vault}/business/projects/` and `{vault}/personal/projects/` for anything in progress
4. **Check for follow-ups**: look at recent `{vault}/business/intelligence/decisions/` for action items
5. **Generate a prioritized daily plan**:
   - Top 3 priorities for today (with reasoning)
   - What is urgent vs important
   - Suggested time blocks
   - Anything overdue or at risk
6. **Create/update today's daily note** at `{vault}/daily/YYYY-MM-DD.md` with the plan
7. Ask: "Does this plan look right? Want to adjust priorities?"

## Knowledge Pipeline Status
Run: `python3 ${CLAUDE_PLUGIN_ROOT}/skills/audit/scripts/audit.py {vault}/knowledge/raw --status`
Include in today's summary if any books are pending audit or recently absorbed.
Also run: `python3 ${CLAUDE_PLUGIN_ROOT}/skills/self-learn/scripts/summary.py {vault}/knowledge/raw/the-road-less-stupid --status`
Show latest self-learn pipeline status.
