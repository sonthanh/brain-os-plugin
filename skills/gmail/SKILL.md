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
   - **Reply All**: always include all CC recipients from the original email
   - **From**: use the email address that received the original email (not a default)

### `/gmail auto-draft` — Autonomously draft replies (no approval needed)

Fully autonomous mode — reads needs-reply queue, generates drafts, creates them in Gmail. Safe because drafts are never sent.

1. Follow the command spec at `{vault}/commands/gmail-auto-draft.md`
2. Execute all steps end-to-end without user interaction
3. All drafts must use **Reply All** (include CC) and set **From** to the receiving address
4. Report results when done

### `/gmail status` — Show pending actions + SLA state

1. List all triage reports in `{vault}/daily/gmail-triage/`
2. Count unchecked actions across reports
3. Show summary: "3 reports pending, 14 unprocessed actions (5 archive, 3 delete, 2 need reply...)"
4. Read `{vault}/business/intelligence/emails/sla-open.md`. Print:
   - Total open / breached
   - Per-tier breached count (`fast`, `normal`, `slow`)
   - Top 5 most overdue items grouped by owner

### `/gmail sla` — SLA ledger maintenance

The SLA ledger lives at `{vault}/business/intelligence/emails/sla-open.md`. The triage workflow appends new items each run; resolution/cleanup is interactive via this command.

`/gmail sla list` — render the open ledger to terminal, sorted by tier severity then age.

`/gmail sla resolve <message_id>` — manually mark a ledger row resolved.
1. Find the row in `## Breached` or `## Open`
2. Move it to `## Resolved (last 7 days, audit trail)` with `Resolved (UTC)` = now and `Resolved by` = `manual`
3. Save the file
4. Report which item was resolved

`/gmail sla check` — for each open item, use Gmail API (`gmail_read_message` on the message ID, walk the thread) to detect resolution per the 4-guard rule in `business/intelligence/gmail-rules.md` § SLA monitoring → Resolution detection:
1. A reply exists in the thread sent AFTER the original incoming message
2. Reply sender is a `me` address OR `@team1.example` / `@team2.example` / `@team3.example` / `@team6.example` team member
3. Reply addressed TO the original external party
4. Reply does NOT carry `Auto-Submitted` header

If all 4 met → move to `Resolved` with `Resolved by` = sender of the qualifying reply.

If a NEW external message arrived AFTER the team's reply → re-open at the same tier with `received_at` = the new external message's date.

Print a diff: how many resolved, how many re-opened, how many still open/breached.

Resolution detection also runs automatically in the GHA workflow (via `/tmp/sla-threads.json` from `gmail-fetch@v0`). This command is for ad-hoc checks between workflow runs.

## Setup

Requires Google OAuth credentials for the Gmail API. Run the setup script:
```bash
tsx ${CLAUDE_PLUGIN_ROOT}/skills/gmail/scripts/setup-oauth.ts
```

This creates `${CLAUDE_PLUGIN_ROOT}/skills/gmail/.credentials.json` (gitignored).

## Rules

The skill reads `{vault}/business/intelligence/gmail-rules.md` for user-defined patterns. AI judgment is used as fallback when no rule matches.

---

## Outcome log

After each `/gmail` or `/gmail auto-draft` run, append one line to `{vault}/daily/skill-outcomes/gmail.log`:

```
{date} | gmail | {mode} | ~/work/brain-os-plugin | {vault}/daily/gmail-triage/{triage-file} | commit:N/A | {result}
```

- `mode`: `triage`, `draft`, or `auto-draft`
- `triage-file`: the filename of the triage report processed (e.g., `2026-04-11-triage.md`)
- `result`: `pass` if all actions executed cleanly, `partial` if some skipped/already-handled, `fail` if errors

This log feeds `/improve gmail` to detect patterns in skipped actions, draft rejections, and triage errors.
