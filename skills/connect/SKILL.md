---
name: connect
description: "Use when wanting to find connections, bridges, or shared patterns between two different domains or topics in the vault"
---

## Vault Location
**Vault path:** Read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md`

# /connect [domain1] [domain2]

## Behavior
When I type `/connect [domain1] [domain2]`, find connections between two domains:

1. **Scan domain 1** -- find all vault files related to the first domain
2. **Scan domain 2** -- find all vault files related to the second domain
3. **Find bridges** -- identify shared themes, patterns, or insights that connect them
4. **Generate novel connections** -- propose non-obvious links based on vault evidence
5. **Suggest actions** -- what could I do with these connections?

## Format


Write the connection analysis to `{vault}/thinking/agent-output/YYYY-MM-DD-connect-[d1]-[d2].md`
