---
name: status
description: "Use when user wants a briefing on current state — tasks, emails, handovers, priorities. Replaces /today and /close. Triggers on: status, what should I do, what's pending, brief me, morning review, wrap up, end of day"
model: sonnet
---

## Config

**Vault path + GitHub task repo:** read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md` (or user-local `~/.brain-os/brain-os.config.md` which takes precedence). The keys are `vault_path:` and `gh_task_repo:`. In shell/hook contexts, `source hooks/resolve-vault.sh` and use `$VAULT_PATH` / `$GH_TASK_REPO`. In skill prose, substitute `$GH_TASK_REPO` below with the configured value.

# /status — Briefing at Any Time

Works any time of day. No daily boundary assumption. Shows what needs attention right now.

## Behavior

1. **Check pending handovers** — `gh issue list -R $GH_TASK_REPO --state open --label type:handover --json number,title,body`. The `type:handover` label IS the signal — do not infer from `daily/handovers/` filenames, the SessionStart hook's "Recent Handovers" index (context, not a task list), or wiki-link references inside other issues' bodies.

   An In Progress issue that mentions a handover file in its body is ONE item (the issue), not two. The handover file is the spec for that issue — it is not itself a pending handover.

2. **Check tasks** — query GH at render time (other sessions may have changed labels):
   ```
   gh issue list -R $GH_TASK_REPO --state open --label status:in-progress --json number,title,labels
   gh issue list -R $GH_TASK_REPO --state open --label status:ready --json number,title,labels
   gh issue list -R $GH_TASK_REPO --state open --label status:blocked --json number,title,labels
   gh issue list -R $GH_TASK_REPO --state open --label status:backlog --json number --jq 'length'
   ```
   List `In Progress` / `Ready` / `Blocked` with counts + titles (prefix each with `#N`). Backlog = count only unless user asks for detail. Closed issues = Done; do not list.

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

   Also check this week's AI-engineer research signal: look for the most recent `{vault}/knowledge/research/reports/*-ai-engineer-weekly.md` (preferred) or `*-ai-engineer-daily.md` (historical fallback), capped at **≤8 days old**. Extract the `## Brain-os applicability` section's bullets. If the file or section is missing, skip silently — do not invent suggestions.

8. **Present briefing**:
   ```
   ## Status — YYYY-MM-DD HH:MM

   ### Pending Handovers
   - #N — [title] → handover doc link from body

   ### Tasks
   **Ready (N)**
   - #N — [P1] ...
   **In Progress (N)**
   - #N — [P1] ...
   **Blocked (N)**
   - #N — [P1] ...
   **Backlog: N items** (expand on request)

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

   ### Research Signal (YYYY-MM-DD)  ← only if ≤8-day-old ai-engineer-weekly (or historical -daily) report has a Brain-os applicability section
   - [bullet 1 verbatim from report]
   - [bullet 2]
   - [bullet 3]
   → Full report: [[knowledge/research/reports/YYYY-MM-DD-ai-engineer-weekly]]

   ### Email Focus
   1. [top email item needing user action]
   2. [second]
   3. [third]
   ```

   When `B == 0 && O == 0`, render `### SLA` as a single line: `All clear — no open items.` Don't omit the section.

9. **If pending handover exists**, ask: "Want to pick up [topic] (#N)?"

## Rules
- No daily note creation — this is a briefing, not a ritual
- No "morning" or "evening" framing — works at any hour
- Keep it concise — if nothing needs attention, say "All clear."
- **Tasks section is the primary task view. Do NOT add a "Task Focus" synthesis.** Issues are already prioritized by `priority:p*` labels and sorted by column; re-ranking is redundant noise. User picks from the Ready list directly.
- **Email Focus stays** — email has many SLA items and needs triage/owner filtering. This is different from tasks.
- **Email Focus = only owner buckets that need user action:** `me-personal` + `me-business`. Team-owned breaches (`support`, `partners`, `business`, `legal`, `accounting`, `hr`, `license`) stay visible in the SLA table but do NOT bubble into Email Focus — team handles routine ops.
  - Within Email Focus, `fast` breaches outrank `normal` outrank `slow`. Cap at 3 items.
  - If no me-personal/me-business items breached or open-urgent: `Email Focus: All clear.`
- Never invent SLA state — if `sla-open.md` doesn't exist, the SLA section reports `All clear (no ledger)` and the system skips SLA-driven priority bumping.
- **Multi-session concurrency:** GH issues are server-side SSOT — labels reflect the latest state across all sessions. Always re-query at render time; do not cache earlier reads in a long session.
- **Research Signal is advisory, not a task queue:** display verbatim bullets from the most recent `*-ai-engineer-weekly.md` (preferred) or `*-ai-engineer-daily.md` (historical), capped at ≤8 days old. Omit the section if the file or its `## Brain-os applicability` block is missing. Never generate or paraphrase suggestions — if the report didn't ship, the section doesn't render.

## Outcome log

Follow `skill-spec.md § 11`. Append to `{vault}/daily/skill-outcomes/status.log`:

```
{date} | status | briefing | ~/work/brain-os-plugin | N/A | commit:N/A | {result}
```

- `result`: `pass` (briefing delivered), `fail` (vault unreadable or missing)
