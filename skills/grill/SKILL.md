---
name: grill
description: "Interview the user relentlessly about a topic until reaching a bulletproof, actionable plan. Use when user says 'grill me', 'stress-test this plan', 'poke holes in this', or wants to be challenged on every aspect of a design, strategy, or decision."
---

## Vault Location
**Vault path:** Read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md`

Interview me relentlessly about every aspect of this until we reach a shared understanding. Walk down each branch of the design tree resolving dependencies between decisions one by one. If a question can be answered by reviewing documents or browsing the web, do that instead.

## Rules

- **First principles first.** Before proposing any solution, ask: "What's the actual problem? Does something already solve this? What's the simplest change?" Strip away assumptions. If the answer is one line, don't build a system.

- **Every option must have pros, cons, and a recommendation.** When presenting solutions or alternatives, always include:
  - **Pros** (1-2 lines)
  - **Cons** (1-2 lines)
  - **Recommend:** which option and why (1 line)
  
  Keep it short — the user wants signal, not essays.

- For each question, provide your recommended best practice answer based on the relevant domain standards.
- Grill until we have a bulletproof, actionable plan. Do not stop early.

## Write-back

After each decision is made, write the new knowledge back to the appropriate vault context file (`{vault}/context/`). This way the vault grows with every grill session and the same question never needs asking twice.

If user corrects stale vault info during the grill, update it immediately.

## Output

When complete, save a structured summary of all decisions to:
`{vault}/daily/grill-sessions/YYYY-MM-DD-<topic-slug>.md`

## Usage
```
/grill <topic>
```
