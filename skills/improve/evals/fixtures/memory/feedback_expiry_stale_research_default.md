---
name: stale-research-model-default
description: Old preference for Sonnet over Opus on /research from late 2025
type: feedback
expected_tier: memory
expected_expiry: true
last_validated: 2025-12-15
---

# Old /research model default: Sonnet over Opus

## Rule

When invoking `/research`, prefer Sonnet for breadth over Opus for depth — the weekly Opus quota cap got eaten quickly on long research batches.

## Why

Quota math from late 2025: Opus consumed the weekly subscription budget after roughly a dozen long research runs. Switching defaults to Sonnet stretched the cap and let the daily cron keep firing without manual intervention.

## How to apply

Set `--model sonnet` as the default flag in the /research cron and any /research invocation defaults — falls back to Opus only when the user explicitly asks for a deep run.
