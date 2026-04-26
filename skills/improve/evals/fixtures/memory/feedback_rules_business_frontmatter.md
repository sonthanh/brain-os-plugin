---
name: business-frontmatter-date-refresh
description: Editing files under brain/business/ must refresh frontmatter date
type: feedback
expected_tier: rules
last_validated: 2026-04-26
---

# Refresh frontmatter date in business notes

## Rule

When editing any markdown file under `~/work/brain/business/`, ensure the frontmatter `date:` field is set to today's date (YYYY-MM-DD) before saving.

## Why

The vault uses `date:` as the canonical "last meaningful update" marker for status briefings and the morning recency ranking. Stale `date:` values skew the briefing — files get surfaced as fresh when nothing in them actually changed today. The cost of forgetting is invisible until the next morning brief surfaces three-week-old items as priorities.

## How to apply

The rule only matters inside one path (`~/work/brain/business/`). It is not a workflow (single check, not multi-step), not deterministically detectable from tool inputs alone (requires comparing frontmatter `date:` to today), and not a global commitment. Best fit: `~/.claude/rules/business-frontmatter.md` with `paths: [~/work/brain/business/**/*.md]` frontmatter — Claude loads the rule only when reading or editing matching files, keeping the always-on context lean.
