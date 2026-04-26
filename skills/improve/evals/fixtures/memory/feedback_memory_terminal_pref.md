---
name: terminal-warp-preference
description: User uses Warp on macOS as primary terminal — tailor terminal suggestions accordingly
type: feedback
expected_tier: memory
last_validated: 2026-04-26
---

# Terminal preference: Warp on macOS

## Rule

The user's primary terminal is Warp on macOS. When suggesting terminal-side workflows — multi-pane setups, command automation, launch configurations, keyboard-driven sequences — default to Warp's idioms (Launch Configurations, AppleScript bridges, Warp's command palette) rather than tmux or iTerm patterns.

## Why

The right idiom on the first try saves a clarification turn. tmux suggestions don't apply directly in Warp; iTerm AppleScript uses a different protocol. The user has expressed this preference repeatedly; surfacing the wrong stack each time is a small but compounding annoyance.

## How to apply

This is a soft preference that helps Claude tailor responses — no enforceable workflow steps, no path-scoping, no tool-input pattern that's deterministically detectable, no global "always do X" commitment that belongs in CLAUDE.md. Stays as auto-loaded memory; the file gets updated naturally when the user's setup changes.
