---
name: grill
description: "Interview the user relentlessly about a topic until reaching a bulletproof, actionable plan. Use when user says 'grill me', 'stress-test this plan', 'poke holes in this', or wants to be challenged on every aspect of a design, strategy, or decision."
---

## Vault Location
**Vault path:** Read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md`

Interview me relentlessly about every aspect of this until we reach a shared understanding. Walk down each branch of the design tree resolving dependencies between decisions one by one.

## Vault-First Protocol

Before each question branch, search the vault FIRST. Only grill for genuine gaps.

### For each question:

1. **SEARCH vault** — scan these locations for existing answers:
   - `{vault}/context/` — business context, goals, strategy, preferences
   - `{vault}/daily/grill-sessions/` — previous grill decisions on same/related topics
   - `{vault}/thinking/` — ideas, patterns, connections
   - `{vault}/knowledge/books/` — frameworks and mental models
   - `{vault}/personal/` — personal context

2. **If vault has an answer** — present it:
   ```
   Vault says: [knowledge found]
   Source: [[vault-path]]
   → Still accurate? (yes / update)
   ```
   User confirms → use it, move on. User corrects → update the vault file immediately.

3. **If vault has nothing** — ask the question with your recommended answer + pros/cons/recommend format.

## Rules

- **First principles first.** Before proposing any solution, ask: "What's the actual problem? Does something already solve this? What's the simplest change?" Strip away assumptions. If the answer is one line, don't build a system.

- **Vault-first, always.** Never ask the human something the vault already answers. Every repeated question is a failure of the system.

- **Present options with pros/cons, then ONE recommendation.** When presenting alternatives:
  - List each option with **Pros** and **Cons** (1-2 lines each)
  - After all options, give ONE **→ Recommend:** line picking the best option and why
  
  Never recommend each option individually — that's recommending nothing.

- **Research before asking.** If a question can be answered by reviewing documents, browsing the web, or reading code — do that instead of asking the user. Don't ask diagnostic questions that data can answer.

- For each question, provide your recommended best practice answer based on the relevant domain standards.
- Grill until we have a bulletproof, actionable plan. Do not stop early.

## Write-back

After each decision is made, write the new knowledge back to the appropriate vault context file (`{vault}/context/`). This way the vault grows with every grill session and the same question never needs asking twice.

If user corrects stale vault info during the grill, update it immediately.

## Output

When complete, save a structured summary of all decisions to:
`{vault}/daily/grill-sessions/YYYY-MM-DD-<topic-slug>.md`

Include:
- Questions asked (vault-sourced vs human-answered breakdown)
- All decisions made with rationale
- Context files updated during this session

## Usage
```
/grill <topic>
```
