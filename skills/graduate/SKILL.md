---
name: graduate
description: "Use when ideas in daily notes or agent-output have matured enough to deserve their own standalone vault files"
---

## Vault Location
**Vault path:** Read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md`

# /graduate

## Behavior
When I type `/graduate`, extract ideas from daily notes and agent-output that deserve standalone files:

1. **Scan recent daily notes** (last 7-14 days) from `{vault}/daily/` for ideas, insights, and tagged items (#idea, #pattern, #insight)
2. **Scan `{vault}/thinking/agent-output/`** for analysis that should be promoted
3. **Cross-reference with existing vault** -- does this idea already have a standalone note?
4. **Present candidates** for graduation:
   - What the idea is
   - Where it was found
   - Why it deserves a standalone note
   - Suggested location (thinking/ideas/, thinking/patterns/, etc.)
5. **Ask me to pick** which ones to graduate
6. **Create the standalone notes** with:
   - Core claim or question
   - Context from the source daily note
   - Backlinks to related vault files
   - Tags for discoverability

## Format

