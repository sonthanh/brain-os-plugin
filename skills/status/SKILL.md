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

3. **Check content ideas** (if `~/work/ai-leaders-vietnam/` exists):
   - Read `~/work/ai-leaders-vietnam/content-ideas.md` (canonical location — writing focus lives in the ai-leaders-vietnam repo, not the vault)
   - Count items in "Next Up" and "Writing" columns
   - Add to briefing: `### Content\n- X ideas ready, Y in writing`
   - If Writing > 0: list titles so user knows what's in flight

4. **Check email intelligence** (if today's files exist):
   - `{vault}/business/intelligence/emails/YYYY-MM-DD-daily-summary.md` — totals, key signals
   - `{vault}/business/intelligence/emails/YYYY-MM-DD-needs-reply.md` — pending replies with priority

5. **Check SLA ledger** — read `{vault}/business/intelligence/emails/sla-open.md`. This is the **single source of truth** for unanswered emails across days, owners, and tiers. The triage workflow maintains it each run.

   Parse the `## Breached` table and `## Open` table. From the breached items extract:
   - Count by tier: `fast`, `normal`, `slow`
   - Group by owner bucket (`me-personal`, `me-business`, `partners`, `support`, `business`, `legal`, `accounting`, `hr`, `license`)
   - Top 3 most overdue (sorted by tier severity, then by overdue duration)

   If `sla-open.md` is missing, treat as zero — do not error.

6. **Check recent activity** — `git log --oneline --since="24 hours ago"` across the vault repo to show what was done recently.

7. **Read context** — `{vault}/context/strategy.md` and `{vault}/context/goals.md` for priorities.

8. **Present briefing**:
   ```
   ## Status — YYYY-MM-DD HH:MM

   ### Pending Handovers
   - [topic] → [[daily/handovers/...]] — [status]

   ### Tasks
   - [ ] Task 1
   - [ ] Task 2

   ### Content
   - X ideas ready, Y in writing

   ### Email
   - X needs reply today (Y high priority)
   - Key: [one-line signal]

   ### SLA  ← always show, even if zero
   B breached / O open total — fast: F, normal: N, slow: S
   By owner: me-personal F+N, me-business F+N, partners F+N, ...
   Top breaches:
   - 🔴 fast — sender → owner — "Subject" — Nh overdue
   - 🟠 normal — sender → owner — "Subject" — N business days overdue
   - 🟡 slow — sender → owner — "Subject" — N business days overdue
   → Full ledger: [[business/intelligence/emails/sla-open]]

   ### Recent Activity (24h)
   - [commit summaries]

   ### Email Focus
   1. [top email item needing user action]
   2. [second]
   3. [third]

   ### Task Focus
   1. [top task from inbox with reasoning]
   2. [second]
   3. [third]
   ```

   When `B == 0 && O == 0`, render `### SLA` as a single line: `All clear — no open items.` Don't omit the section.

9. **If pending handover exists**, ask: "Want to pick up [topic]?"

## Rules
- No daily note creation — this is a briefing, not a ritual
- No "morning" or "evening" framing — works at any hour
- Keep it concise — if nothing needs attention, say "All clear."
- **Email Focus and Task Focus are independent sections — never merge.** User scans each separately; mixing lets email noise displace task priorities.
- **Email Focus = only owner buckets that need user action:** `me-personal` + `me-business`. Team-owned breaches (`support`, `partners`, `business`, `legal`, `accounting`, `hr`, `license`) stay visible in the SLA table but do NOT bubble into Email Focus — team handles routine ops.
  - Within Email Focus, `fast` breaches outrank `normal` outrank `slow`. Cap at 3 items.
  - If no me-personal/me-business items breached or open-urgent: `Email Focus: All clear.`
- **Task Focus = ranked tasks from inbox.md only.** Prefer `Ready` P1/P2 tasks over Backlog. Never include email items.
  - If no Ready tasks: suggest top 1-2 Backlog items worth promoting.
- Never invent SLA state — if `sla-open.md` doesn't exist, the SLA section reports `All clear (no ledger)` and the system skips SLA-driven priority bumping.

## Outcome log

Follow `skill-spec.md § 11`. Append to `{vault}/daily/skill-outcomes/status.log`:

```
{date} | status | briefing | ~/work/brain-os-plugin | N/A | commit:N/A | {result}
```

- `result`: `pass` (briefing delivered), `fail` (vault unreadable or missing)
