---
name: grill
description: "Interview the user relentlessly about a topic until reaching a bulletproof, actionable plan. Use when user says 'grill me', 'stress-test this plan', 'poke holes in this', or wants to be challenged on every aspect of a design, strategy, or decision."
---

## Vault Location
**Vault path:** Read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md`

Interview me relentlessly about every aspect of this until we reach a shared understanding. Walk down each branch of the design tree resolving dependencies between decisions one by one. If a question can be answered by searching the vault (grep, read wiki-links, follow references), browsing the web, or reading code — do that instead of asking me. For each question, provide your recommended best practice answer. When presenting options, list pros/cons for each then ONE recommendation — never per-option. Grill until we have a bulletproof, actionable plan.

Save decisions to `{vault}/daily/grill-sessions/YYYY-MM-DD-<topic-slug>.md`

## Usage
```
/grill <topic>
```
