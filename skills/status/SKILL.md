---
name: status
description: "Use when user wants a briefing on current state — tasks, emails, handovers, priorities. Reads a lazily-regenerated cache. Triggers on: status, what should I do, what's pending, brief me, morning review, wrap up, end of day"
---

## Config

**Vault path + GitHub task repo:** read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md` (or user-local `~/.brain-os/brain-os.config.md` which takes precedence). The keys are `vault_path:` and `gh_task_repo:`. In shell/hook contexts, `source hooks/resolve-vault.sh` and use `$VAULT_PATH` / `$GH_TASK_REPO`.

# /status — Briefing at Any Time

Works any time of day. No daily boundary assumption. Shows what needs attention right now. **Reads from a prebuilt cache; does not query GH or parse files on the hot path.**

## Architecture

`/status` displays a bash-regenerated markdown file at `~/.cache/brain-os/status.md`. The briefing is produced by `render-status.sh` (pure bash, no LLM) — queries GitHub Issues, parses `sla-open.md`, filters `git log`, extracts research signals, etc. Regeneration is lazy: it runs only when the cache is stale. Hot-path cost is one `Read` of a ~2 KB markdown file.

**Cache:** `~/.cache/brain-os/status.md`
**Dirty marker:** `~/.cache/brain-os/status.dirty`
**Regen script:** `${CLAUDE_PLUGIN_ROOT}/skills/status/render-status.sh`

### Why this design

Every `/status` invocation previously ran 4 `gh issue list` calls + 7 file reads + LLM synthesis, bloating session context past 41k tokens. The briefing is 99% mechanical aggregation (counts, filters, table parsing, date math), so the regen is implemented as pure bash. The LLM only reads the output.

Freshness is guaranteed by:

- **mtime watch** of every file the briefing depends on (`sla-open.md`, today's `daily-summary.md` / `needs-reply.md`, `content-ideas.md`, `context/*.md`, latest `*-ai-engineer-weekly.md`) — any source newer than the cache ⇒ regen.
- **Dirty marker** (`status.dirty`) touched by the `touch-status-dirty.sh` PostToolUse hook whenever a Bash command mutates a GitHub issue (`gh issue edit|close|reopen|comment|delete|...`). GH state is the one source that has no file on disk, so it needs an explicit signal.
- **Daily reset** via a `<!-- cache-date: YYYY-MM-DD -->` header at the top of `status.md` — if the header date ≠ today, regen. No cron job; survives reboots.
- **Max-age safety net** — regen forced when cache mtime is older than `STATUS_CACHE_MAX_AGE` seconds (default 1800 / 30 min). Catches external GH mutations that bypass the hook: cron jobs, launchd tasks, or `gh issue close` run from a plain terminal outside Claude Code. Bounds drift to at most 30 min for those blind spots without pounding GitHub on every invocation.

### Concurrency

Two sessions running `/status` at the same moment each call `render-status.sh --if-stale`. Worst case both regen and race on the output; `render-status.sh` writes atomically via `mv tmpfile status.md` (atomic on the same filesystem) so the last writer wins with fully fresh data.

The dirty marker is cleared on the **first line** of regen, before any source is read. If a concurrent mutation touches the marker mid-regen, the next `/status` sees it and regenerates again — no lost-signal race.

## Behavior

1. **Run the regen gate.** Invoke:

   ```
   bash ${CLAUDE_PLUGIN_ROOT}/skills/status/render-status.sh --if-stale
   ```

   - If user passed `-f` (force): omit `--if-stale` — regen unconditionally.
   - The script exits 0 in ≤100 ms when cache is fresh; regen is typically 1–3 s.

2. **Read the cache** — `Read ~/.cache/brain-os/status.md` — and display its contents verbatim. Do not re-aggregate, re-sort, or re-phrase the briefing. The cache IS the briefing.

3. **If a pending handover is present in the briefing**, ask: "Want to pick up [topic] (#N)?"

## Output format (produced by `render-status.sh`)

```
## Status — YYYY-MM-DD HH:MM

### Pending Handovers                  ← omitted when none
- #N — [title]

### Tasks
**Ready (N)**
- #N — [P1] ...
- #N — [P1] ... 🔄 _looks picked up elsewhere; run `/pickup N`_   ← stealth-picked detection (recent vault commit referencing #N OR recent handover/grill/task file match)
**In Progress (N)**
**Blocked (N)**                        ← omitted when N=0
**Backlog: N items** (expand on request)

### Content                            ← omitted when ai-leaders-vietnam repo absent
- X ideas ready, Y in writing
(Writing list if Y > 0)

### Email                              ← omitted when no daily-summary today
- X needs reply today
- Key: [first Key Signals bullet]

### SLA                                ← always shown
B breached (X mine / Y team / Z awareness) + O open
Top breaches: (up to 3, ranked by user_category r-user → team-sla-at-risk → other)
→ Full ledger: [[business/intelligence/emails/sla-open]]

### Cron (last 24h)
- [launchd + GH-Actions summary — auto-journal, pickup-auto, vault-lint, improve, clean-temp-git-cache]

### Research Signal (YYYY-MM-DD)       ← ≤8 days old + Brain-os applicability present
- [verbatim bullet 1]
- [verbatim bullet 2]
- [verbatim bullet 3]
→ Full report: [[knowledge/research/reports/YYYY-MM-DD-ai-engineer-weekly]]

### Email Focus                        ← filtered by user_category, capped at 5
- ⭐ r-user (tier/owner) — sender — "subject" — state
- 🟡 team (tier/owner) — sender — "subject" — state
_+ N awareness item(s) — glance via full ledger._   ← header-only count
```

When no SLA items exist, the `### SLA` section renders as `All clear — no open items.` — it is never omitted.

## Rules

- No daily note creation — this is a briefing, not a ritual.
- No "morning" or "evening" framing — works at any hour.
- **Do not rerun GH queries or reparse source files in prose.** The cache is authoritative. If the user asks a follow-up ("what's Ready?", "show me #91"), query GH directly for that specific issue; don't regen the briefing.
- **Email Focus = filtered by `user_category` from the dual-perspective taxonomy** (ai-brain#100 Phase 2). Shown: `r-user` (user owes reply, breached or open) and `team-sla-at-risk` (team owes reply; shown when breached, or open+fast/normal). `awareness` counted in a trailing summary line — not listed inline. `noise` never enters the ledger. Legacy rows without `Category` render under an "uncategorized" bucket so nothing is silently dropped.
- **Cache trust envelope:** the cache is correct for the set of sources watched + the dirty marker. If the user reports a staleness bug, investigate the regen gate (missing mtime-watch target? gh issue event type not matched by the hook?) rather than disabling the cache.
- **Never invent SLA state** — if `sla-open.md` doesn't exist, the SLA section reports `All clear (no ledger)` and no SLA-driven prioritization happens.
- **`render-status.sh` runs `set -uo pipefail` by design — never add `-e`.** Sections degrade gracefully: a missing source file or empty awk match should render as "All clear" / skipped section, not abort the whole briefing. Each block has its own guards; don't promote them to a global fail-fast.

## Troubleshooting

- **Briefing looks stale:** `rm -f ~/.cache/brain-os/status.md` then `/status`, or run `/status -f`.
- **Regen fails silently:** `bash render-status.sh 2>&1` in a terminal shows the first error. Common causes: `gh` unauthed (tasks section skipped with "GH unavailable"), `jq` missing, `VAULT_PATH` misconfigured.
- **Hook not firing on GH mutations:** check `~/.claude/plugins/cache/brain-os-marketplace/brain-os/*/hooks/hooks.json` registers `touch-status-dirty.sh` under `PostToolUse` with matcher `Bash`.
- **Tighter freshness for live debugging:** export `STATUS_CACHE_MAX_AGE=60` before running `/status` to force regen on any cache older than 60 s. Revert by unsetting the var — the 1800 s default is a deliberate tradeoff between drift and GitHub load.

## Outcome log

Follow `skill-spec.md § 11`. Append to `{vault}/daily/skill-outcomes/status.log`:

```
{date} | status | briefing | ~/work/brain-os-plugin | N/A | commit:N/A | {result}
```

- `result`: `pass` (briefing delivered), `fail` (cache unreadable and regen failed)
