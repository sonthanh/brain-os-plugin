---
name: handover-verify-state-section
description: /handover output must always include a Commands to Verify State section
type: feedback
expected_tier: skill
last_validated: 2026-04-26
---

# /handover must include Commands to Verify State

## Rule

The /handover skill must, at the end of every handover document it writes, append a "Commands to Verify State" section listing the bash commands a future session should run (typically `git status`, `gh issue view N`, and any topic-specific log tails) before resuming work.

## Why

Pickup sessions resume cold — they only see the handover doc. Without a verify-state section, the picker-up has to reconstruct what changed since handover by spelunking through git log and asking. The handover already knows which files and issues are load-bearing; encoding the commands inline turns a 5-minute reconstruction into a 30-second check.

## How to apply

This is a surgical addition to the existing /handover skill (`~/work/brain-os-plugin/skills/handover/SKILL.md` already defines the multi-step flow). Add one step at the end of the existing doc-writing phase that emits the section. Belongs in a skill — the rule has multiple sub-steps (decide which commands matter, format them, append). Add a coverage-parity eval case to `evals/evals.json` mirroring the existing skill-content-check pattern.
