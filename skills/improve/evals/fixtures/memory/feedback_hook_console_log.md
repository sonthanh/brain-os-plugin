---
name: no-console-log-in-prod
description: Don't write console.log calls into production source files
type: feedback
expected_tier: hook
last_validated: 2026-04-26
---

# Don't write console.log calls into production source files

## Rule

Refuse to write `console.log(` into any file under `src/` excluding `*.test.*` and `*.spec.*` paths.

## Why

Console logs leak debugging artifacts into the production browser console. The linter eventually catches them, but only after CI runs — that's a 5–10 minute round trip per PR for a fully preventable mistake. Catching it at Write time means the human sees the redirect immediately and uses the proper logger from the start.

## How to apply

PreToolUse hook on Write/Edit: regex match `console\.log\(` in `new_string` AND target path matches `src/**/*` AND not `*.test.*`/`*.spec.*` → exit non-zero with a message redirecting to the project's logger module.
