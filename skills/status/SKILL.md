---
name: status
description: "Use when user wants a briefing on current state — tasks, emails, handovers, priorities. Replaces /today and /close. Triggers on: status, what should I do, what's pending, brief me, morning review, wrap up, end of day"
model: sonnet
---

## Vault Location
**Vault path:** Read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md`

# /status — Briefing at Any Time

Works any time of day. No daily boundary assumption. Shows what needs attention right now.

## Behavior

1. **Check pending handovers** — read `{vault}/business/tasks/inbox.md` for unchecked `[Handover]` tasks. If found, list them with links.

2. **Check tasks** — read `{vault}/business/tasks/inbox.md` for all unchecked priority tasks and backlog items.

3. **Check email intelligence** (if today's files exist):
   - `{vault}/business/intelligence/emails/YYYY-MM-DD-daily-summary.md` — totals, key signals
   - `{vault}/business/intelligence/emails/YYYY-MM-DD-needs-reply.md` — pending replies with priority
   - `{vault}/business/intelligence/emails/YYYY-MM-DD-client-support-queue.md` — SLA breaches

4. **Check recent activity** — `git log --oneline --since="24 hours ago"` across the vault repo to show what was done recently.

5. **Read context** — `{vault}/context/strategy.md` and `{vault}/context/goals.md` for priorities.

6. **Present briefing**:
   ```
   ## Status — YYYY-MM-DD HH:MM

   ### Pending Handovers
   - [topic] → [[daily/handovers/...]] — [status]

   ### Tasks
   - [ ] Task 1
   - [ ] Task 2

   ### Email
   - X needs reply (Y high priority)
   - Z SLA breaches
   - Key: [one-line signal]

   ### Recent Activity (24h)
   - [commit summaries]

   ### Suggested Focus
   1. [top priority with reasoning]
   2. [second priority]
   3. [third priority]
   ```

7. **If pending handover exists**, ask: "Want to pick up [topic]?"

## Rules
- No daily note creation — this is a briefing, not a ritual
- No "morning" or "evening" framing — works at any hour
- Keep it concise — if nothing needs attention, say "All clear."
- SLA breaches always go to top of suggested focus
