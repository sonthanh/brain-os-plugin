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

## Rules
- **Narrative over list** — tell a story, don't just list commits
- **Real examples are gold** — include actual code, actual prompts, actual error messages
- **Failures are content** — "I tried X and it broke" is more valuable than "I did X"
- **Hormozi lens**: best stuff goes in the free Facebook post (the decision, the insight, the result). Implementation detail goes in paid Substack (the exact prompts, the code, the config).
- **Don't fabricate** — every claim must trace to a git commit, aha moment, or grill session
- **Default to today** — if no date specified, use today's date
- **Day numbering** — check `{vault}/daily/journal/` for the latest day number and increment

## Integration with ai-leaders-vietnam
The journey doc is INPUT for the writing pipeline:
```
/journal → journey doc → (copy to ai-leaders-vietnam) → context-collector or journey-extractor → writer → ai-checking → evaluator → deliver
```
The user copies the journey doc to ai-leaders-vietnam and runs the content pipeline there.
