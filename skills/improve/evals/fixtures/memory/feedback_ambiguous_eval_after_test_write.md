---
name: skills-eval-after-test-write
description: Write tests for skills then run /eval — could be hook, rules, or skill
type: feedback
expected_tier: ambiguous
last_validated: 2026-04-26
---

# Run /eval after writing skill tests

## Rule

When writing or modifying test cases for any skill under `~/work/brain-os-plugin/skills/<X>/evals/`, run `/eval <X>` immediately after the file is saved to catch regressions before they reach the next cron run.

## Why

Skill evals are the safety net for /improve's auto-tuning loop — broken or stale evals let bad SKILL.md edits land. Catching the regression at write-time keeps the next /improve cron from acting on a corrupted gate. Two prior incidents traced back to evals.json being edited and not re-run, then cron consuming the broken gate as authoritative.

## How to apply

This rule sits across multiple tiers — none of them is the obviously-right home, and a confident classification would skip the human-review surfacing the rubric was designed for:

- A PostToolUse hook on Write/Edit could detect the `evals/evals.json` path and auto-run `/eval` (deterministic-detection — tier hook).
- It is path-scoped to `skills/<X>/evals/` only, so the always-on rule belongs nowhere else (path-scoped — tier rules).
- It is a 2-step workflow (write → run /eval → inspect output → fix) which is the heartbeat of the /tdd skill (multi-step procedure — tier skill).

Confident-classify any of those and the others lose. Better: queue this as `type:human-review` with the rubric trace so the user picks (or splits the rule into the parts that go each way).
