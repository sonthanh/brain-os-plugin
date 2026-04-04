---
name: ghost
description: "Use when needing to draft an answer in the user's voice, or predict how the user would respond to a question based on vault history"
---

## Vault Location
**Vault path:** Read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md`

# /ghost [question]

## Behavior
When I type `/ghost [question]`, answer the question as I would:

1. **Build a voice profile** -- read `{vault}/context/about-me.md`, `{vault}/context/preferences.md`, recent daily notes, and `{vault}/thinking/reflections/` to understand how I think and communicate
2. **Scan relevant vault files** for my actual opinions and perspectives on the topic
3. **Write the answer in my voice** -- matching my tone, vocabulary, reasoning style, and values
4. **Evaluate fidelity** -- rate how confident you are (1-10) that this matches how I would actually respond
5. **Flag gaps** -- note where you had to guess because the vault does not have enough data on this topic

## Format

