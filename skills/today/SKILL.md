---
name: today
description: "Use when starting the day, needing a prioritized plan, or wanting to review tasks, calendar, and recent activity"
---

## Vault Location
The vault is at `/Users/thanhdo/work/brain/`

# /today -- Morning Review

## Behavior
When I type `/today`, create a prioritized plan for the day:

1. **Read recent context**: last 5 daily notes from `/Users/thanhdo/work/brain/daily/`, `/Users/thanhdo/work/brain/context/strategy.md`, `/Users/thanhdo/work/brain/context/goals.md`
2. **Check tasks**: `/Users/thanhdo/work/brain/business/tasks/inbox.md` for pending items
3. **Review active projects**: scan `/Users/thanhdo/work/brain/business/projects/` and `/Users/thanhdo/work/brain/personal/projects/` for anything in progress
4. **Check for follow-ups**: look at recent `/Users/thanhdo/work/brain/business/intelligence/decisions/` for action items
5. **Generate a prioritized daily plan**:
   - Top 3 priorities for today (with reasoning)
   - What is urgent vs important
   - Suggested time blocks
   - Anything overdue or at risk
6. **Create/update today's daily note** at `/Users/thanhdo/work/brain/daily/YYYY-MM-DD.md` with the plan
7. Ask: "Does this plan look right? Want to adjust priorities?"

## Knowledge Pipeline Status
Run: `python3 ${CLAUDE_PLUGIN_ROOT}/skills/audit/scripts/audit.py /Users/thanhdo/work/brain/knowledge/raw --status`
Include in today's summary if any books are pending audit or recently absorbed.
Also run: `python3 ${CLAUDE_PLUGIN_ROOT}/skills/self-learn/scripts/summary.py /Users/thanhdo/work/brain/knowledge/raw/the-road-less-stupid --status`
Show latest self-learn pipeline status.
