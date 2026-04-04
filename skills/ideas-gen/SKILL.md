---
name: ideas-gen
description: "Use when wanting to brainstorm or generate new ideas by scanning across all vault domains for cross-domain patterns and opportunities"
---

## Vault Location
**Vault path:** Read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md`

# /ideas

## Behavior
When I type `/ideas`, run a comprehensive idea generation:

1. **Gather vault structure** -- understand all files, connections, orphans, dead ends
2. **Read context files** -- `{vault}/context/`, recent `{vault}/daily/`, active `{vault}/business/projects/`
3. **Scan thinking zone** -- `{vault}/thinking/ideas/`, `{vault}/thinking/patterns/`, `{vault}/thinking/connections/`
4. **Cross-domain analysis** -- find patterns across different areas of the vault
5. **Generate ideas** organized by category:
   - Tools to build
   - Content to create
   - Systems to implement
   - Conversations to have
   - Subjects to investigate
   - Skills/commands to create
6. **Rank by impact** -- top 5 high-impact "do now" items

## Format


Write the full report to `{vault}/thinking/agent-output/YYYY-MM-DD-ideas.md`
