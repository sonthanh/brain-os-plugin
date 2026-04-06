---
name: gmail
description: "Execute Gmail triage actions — cleanup inbox (archive, delete, label, star, unsubscribe), draft replies, and process pending triage reports from vault. Use when user says /gmail, wants to clean inbox, process email actions, or draft email replies."
---

## Vault Location
**Vault path:** Read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md`

# /gmail — Execute Gmail Triage Actions

Reads the latest triage report from the vault, executes cleanup actions, and drafts replies. Designed to be conflict-safe — checks message state before acting, so it won't re-process emails you've already handled manually.

## Behavior

### `/gmail` — Process latest triage report

1. **Find latest report**: Read the most recent file in `{vault}/daily/gmail-triage/`
2. **Parse `## Actions` section**: Each line is `- [ ] action | msg_id | context`
3. **Check current state**: For each action, verify the message still exists and hasn't been handled already
4. **Execute actions** via `tsx ${CLAUDE_PLUGIN_ROOT}/skills/gmail/scripts/gmail-clean.ts`:

   | Action | What it does |
   |---|---|
   | `archive` | Remove INBOX label |
   | `delete` | Move to trash |
   | `label:name` | Add label (create if doesn't exist) |
   | `star` | Add STARRED label |
   | `mark-important` | Add IMPORTANT label |
   | `unsubscribe` | Move to trash + create filter to auto-delete future emails from sender |
   | `needs-reply` | Skip — handled separately with `/gmail draft` |

5. **Update report**: Check off completed actions in the triage file
6. **Report summary**: "Processed 12 actions: 5 archived, 3 deleted, 2 labeled, 1 starred, 1 unsubscribed. 2 skipped (already handled)."

### `/gmail draft` — Draft replies for flagged emails (interactive)

1. Read triage report for `needs-reply` actions
2. For each, read the full email thread via Gmail
3. Read `{vault}/context/about-me.md` and `{vault}/context/business.md` for voice/context
4. Draft a reply — show it to the user for approval before creating in Gmail
5. Create draft in Gmail via `gmail_create_draft` with the approved text

### `/gmail auto-draft` — Autonomously draft replies (no approval needed)

Fully autonomous mode — reads needs-reply queue, generates drafts, creates them in Gmail. Safe because drafts are never sent.

1. Follow the command spec at `{vault}/commands/gmail-auto-draft.md`
2. Execute all steps end-to-end without user interaction
3. Report results when done

### `/gmail status` — Show pending actions

1. List all triage reports in `{vault}/daily/gmail-triage/`
2. Count unchecked actions across reports
3. Show summary: "3 reports pending, 14 unprocessed actions (5 archive, 3 delete, 2 need reply...)"

## Setup

Requires Google OAuth credentials for the Gmail API. Run the setup script:
```bash
tsx ${CLAUDE_PLUGIN_ROOT}/skills/gmail/scripts/setup-oauth.ts
```

This creates `${CLAUDE_PLUGIN_ROOT}/skills/gmail/.credentials.json` (gitignored).

## Rules

The skill reads `{vault}/business/intelligence/gmail-rules.md` for user-defined patterns. AI judgment is used as fallback when no rule matches.
