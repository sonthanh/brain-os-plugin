---
name: challenge
description: "Use when wanting to stress-test a belief, assumption, or decision against vault history and counter-evidence"
---

## Vault Location
**Vault path:** Read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md`

# /challenge [topic]

## Behavior
When I type `/challenge [topic]`, pressure test my current beliefs:

1. **Find my current position** -- scan `{vault}/thinking/`, `{vault}/daily/`, and relevant context files to understand what I believe about this topic
2. **Find contradictions** -- look for places where my stated beliefs conflict with my actions or other beliefs in the vault
3. **Present counter-evidence** -- find arguments, data, or perspectives that challenge my view
4. **Track belief shifts** -- if I have changed my mind on this before, surface that evolution
5. **Ask hard questions** -- 3-5 questions that probe the weakest parts of my position

## Format

