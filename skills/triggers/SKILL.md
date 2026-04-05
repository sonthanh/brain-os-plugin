---
name: triggers
description: "Manage and debug remote scheduled tasks — check status, verify runs, pull logs from git, diagnose failures, re-trigger. Use when user says /triggers, asks about remote tasks, scheduled jobs, or wants to debug a failed run."
---

## Vault Location
**Vault path:** Read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md`

# /triggers — Remote Task Manager

Manage, monitor, and debug all scheduled remote tasks from one place.

## Commands

### `/triggers` or `/triggers status` — Overview

1. Use `RemoteTrigger` tool with action `list` to get all triggers
2. For each trigger, show:
   - Name, cron expression, enabled/disabled, next run time
3. Check `{vault}/daily/gmail-triage/` for the latest report — show its timestamp
4. Check git log on the vault for recent remote commits:
   ```bash
   cd {vault} && git log --oneline --since="24 hours ago" --grep="triage\|Gmail\|gmail"
   ```
5. Compare: did the last scheduled run produce a report? If not, flag it.

### `/triggers run <name>` — Manual trigger

1. Use `RemoteTrigger` tool with action `list` to find the trigger by name
2. Use `RemoteTrigger` tool with action `run` with the trigger_id
3. Report: "Triggered. Check status in a few minutes with `/triggers check`"

### `/triggers check` — Verify last run succeeded

1. Pull latest vault changes: `cd {vault} && git pull`
2. Find the most recent triage report in `{vault}/daily/gmail-triage/`
3. Read it — check if it looks valid (has ## Actions, ## Summary sections)
4. Check git log for the commit that created it — was it recent?
5. If no recent report exists after a triggered run:
   - Check if the remote task pushed to a different branch (e.g., `claude/` prefix)
   - Check if there were merge conflicts
   - Report the diagnosis

### `/triggers update <name> --prompt <file>` — Update trigger prompt

1. Read the new prompt from the specified file (e.g., `remote-triage-prompt.md`)
2. Use `RemoteTrigger` tool with action `get` to fetch current trigger config
3. Use `RemoteTrigger` tool with action `update` to replace the prompt
4. Confirm: "Trigger prompt updated. Run `/triggers run <name>` to test."

### `/triggers cron <name> <expression>` — Update schedule

1. Use `RemoteTrigger` tool with action `update` with the new cron_expression
2. Confirm the new schedule and next run time

### `/triggers diagnose` — Full diagnostic

Run when something isn't working. Checks everything:

1. **Trigger exists and is enabled** — `RemoteTrigger` list
2. **Vault repo is clean** — no merge conflicts, main branch up to date
3. **Recent commits from remote** — git log for remote-authored commits
4. **Triage reports exist** — check `{vault}/daily/gmail-triage/` for today's reports
5. **Reports are valid** — parse latest report, verify format
6. **Gmail rules exist** — check `{vault}/business/intelligence/gmail-rules.md`
7. **Telegram working** — try sending a test message:
   ```bash
   tsx ${CLAUDE_PLUGIN_ROOT}/skills/gmail/scripts/notify-telegram.ts --chat-id=<id> "Test from /triggers diagnose"
   ```
   Read chat ID from `{vault}/context/about-me.md`

Report all findings with pass/fail status and suggested fixes for any failures.
