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

## Gmail Triage Status
Check `{vault}/daily/gmail-triage/` for unprocessed triage reports (files with unchecked `- [ ]` actions).
If any exist, include in the daily plan:
- Count of pending actions by type (archive, delete, needs-reply, etc.)
- List subject lines of any `needs-reply` emails
- Prompt: "Run `/gmail` to process pending email actions."

## Knowledge Pipeline Status
Run: `python3 ${CLAUDE_PLUGIN_ROOT}/skills/audit/scripts/audit.py {vault}/knowledge/raw --status`
Include in today's summary if any books are pending audit or recently absorbed.
Also run: `python3 ${CLAUDE_PLUGIN_ROOT}/skills/self-learn/scripts/summary.py {vault}/knowledge/raw/the-road-less-stupid --status`
Show latest self-learn pipeline status.

## Auto-Schedule
This skill is designed to run as a **scheduled remote task at 7:00 AM Europe/Zurich** daily.
It pushes the daily plan to the vault on main and sends a Telegram summary.
Read Telegram chat ID from `{vault}/context/about-me.md`.
Set up via `/schedule` or `claude.ai/code/scheduled`.
