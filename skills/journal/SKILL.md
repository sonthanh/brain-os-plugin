---
name: journal
description: "Aggregate daily working journey across all repos and sessions into structured content material for the '100 days building AI Brain OS' series. Triggers on: journal, daily journey, what did I do today, extract journey, content material"
---

## Vault Location
**Vault path:** Read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md`

# /journal — Daily Journey Extraction

Aggregates everything from today (or a specified date) into structured content material ready for the ai-leaders-vietnam writing pipeline.

## Data Sources

Scan ALL of these (skip any that don't exist):

1. **Git logs** across all repos:
   ```bash
   for repo in ~/work/brain ~/work/brain-ops ~/work/brain-os-plugin ~/work/brain-os-marketplace; do
     echo "=== $(basename $repo) ==="
     git -C "$repo" log --oneline --since="YYYY-MM-DDT00:00" --until="YYYY-MM-DDT23:59" 2>/dev/null
   done
   ```

2. **Aha moments**: `{vault}/daily/sessions/YYYY-MM-DD-aha.md`

3. **Grill sessions**: `{vault}/daily/grill-sessions/YYYY-MM-DD-*.md`

4. **Handovers**: `{vault}/daily/handovers/YYYY-MM-DD-*.md`

5. **Email intelligence**: `{vault}/business/intelligence/emails/YYYY-MM-DD-daily-summary.md`

6. **Session summaries**: `{vault}/daily/sessions/YYYY-MM-DD-*.md` (from Stop hook)

## Output

Write to: `{vault}/daily/journal/YYYY-MM-DD-journey.md`

Format:
```markdown
---
title: "Day N — [headline]"
created: YYYY-MM-DD
tags: [journal, 100-days, content-material]
zone: daily
---

# Day N — [Compelling headline that captures the day's theme]

## The Story (narrative arc)
[2-3 paragraphs telling what happened today as a story. Start with the problem/goal,
describe what was tried, what broke, what worked. Include turning points.
This is the HOOK for the Facebook post.]

## Key Decisions
| Decision | What I chose | Why | What I rejected |
|----------|-------------|-----|-----------------|
[From grill sessions, handovers, and aha moments]

## Aha Moments
[Direct from daily aha file — the best 3-5 moments with context]

## Real Examples
[Code diffs, before/after, exact commands — the Substack-worthy detail.
These are the implementation shortcuts people pay for.]

## Numbers
[Concrete metrics: files changed, tests passing, time saved, costs, etc.]

## What Broke
[Failures, wrong turns, bugs. This is the vulnerability content.]

## What I'd Do Differently
[Hindsight insights — the "lesson learned" angle]

## Content Angles
[3 potential post angles for the writer pipeline, each with:]
- **Hook:** [opening line]
- **Platform:** [Facebook short-form / Substack long-form / both]
- **Hormozi principle:** [which principle this leverages]
```

## Default Mode: Backfill

When `/journal` is invoked **without arguments** (or with just "backfill"):

1. **Scan** `{vault}/daily/journal/` for existing `YYYY-MM-DD-journey.md` files
2. **Determine Day 1** from the earliest journal file's date
3. **Check every date** from Day 1 through yesterday for missing journals
4. **List status** of all days:
   ```
   OK       Day 1 — 2026-04-04 — Day 1 — I Taught an AI to Read a Book Better Than I Can
   MISSING  Day 4 — 2026-04-07
   OK       Day 5 — 2026-04-08 — Day 5 — ...
   ```
5. **For each missing day**, create the journal using the full process above (data sources → output format)
6. **Skip days with no data** — if a date has zero commits across all repos AND no session files, write a minimal journal noting it was a rest day

This means running `/journal` always catches up all missing days automatically.

### Explicit date mode

When invoked with a specific date or day number (e.g., `/journal day 3` or `/journal 2026-04-06`):
- Create only that specific day's journal
- Still determine the correct day number from the journal directory

## Vault Knowledge Extraction (after writing journal)

After the journal is written, scan all daily sources for knowledge that should live in vault `context/` files:

1. **Scan** today's grill sessions, aha moments, handovers, session logs for:
   - **Decisions made** — what was chosen and why
   - **Facts learned** — new information about business, users, market
   - **Preferences stated** — how user wants things done
   - **Context updated** — strategy changes, goal shifts, process changes

2. **For each item**, find the right `context/` file:
   - Business decisions → `context/business.md` or `context/strategy.md`
   - Preferences/rules → `context/preferences.md`
   - New topic → create `context/{topic}.md`

3. **Append** to the context file (don't overwrite existing content)

4. **Principles (P1-P4):** If extraction finds a principle-related decision, update `thinking/principles/tracker.md` usage count. If a NEW principle is proposed, do NOT auto-add — flag it for user review.

5. **Report** at the end of journal: "Extracted N items to vault: [list of context files updated]"

## Rules
- **Narrative over list** — tell a story, don't just list commits
- **Real examples are gold** — include actual code, actual prompts, actual error messages
- **Failures are content** — "I tried X and it broke" is more valuable than "I did X"
- **Hormozi lens**: best stuff goes in the free Facebook post (the decision, the insight, the result). Implementation detail goes in paid Substack (the exact prompts, the code, the config).
- **Don't fabricate** — every claim must trace to a git commit, aha moment, or grill session
- **Day numbering** — check `{vault}/daily/journal/` for the earliest file to determine Day 1, then count sequentially

## Integration with ai-leaders-vietnam
The journey doc is INPUT for the writing pipeline:
```
/journal → journey doc → (copy to ai-leaders-vietnam) → context-collector or journey-extractor → writer → ai-checking → evaluator → deliver
```
The user copies the journey doc to ai-leaders-vietnam and runs the content pipeline there.
