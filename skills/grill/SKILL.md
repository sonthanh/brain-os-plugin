---
name: grill
description: "Interview the user relentlessly about a topic until reaching a bulletproof, actionable plan. Use when user says 'grill me', 'stress-test this plan', 'poke holes in this', or wants to be challenged on every aspect of a design, strategy, or decision."
---

## Vault Location
**Vault path:** Read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md`

# /grill — Auto-Search Vault, Then Grill for Gaps

Interview relentlessly about every aspect of a topic. Walk down each branch of the design tree resolving dependencies one by one.

**Core principle:** Search the vault BEFORE asking the human. Only grill for genuine gaps.

## Auto-Search Protocol

Before each question branch, execute this loop:

### Step 1: SEARCH vault for existing answers
Scan these vault locations for relevant knowledge:
- `{vault}/context/` — business context, goals, strategy, preferences
- `{vault}/daily/grill-sessions/` — previous grill decisions on same/related topics
- `{vault}/thinking/` — ideas, patterns, connections, reflections
- `{vault}/knowledge/books/` — frameworks and mental models from books
- `{vault}/personal/` — personal context that may inform decisions

### Step 2: PRESENT what vault knows
If vault has relevant info, present it:
```
Vault says: [knowledge found]
Source: [[vault-path]]
→ Still accurate? (yes / no / partially — explain)
```

If user confirms → use it, move to next branch. No need to grill on settled knowledge.
If user corrects → update the vault file with corrected info (Step 4).
If vault has nothing → ask the question (normal grill).

### Step 3: GRILL for gaps only
For questions the vault can't answer:
- Ask the question with your recommended answer
- Every option gets **Pros**, **Cons**, **Recommend** (keep short — signal, not essays)
- Provide best-practice recommendation based on domain standards

### Step 4: WRITE answers back to vault
After the human provides a new answer:
1. Identify the right vault context file (or create one if no fit):
   - Business decisions → `{vault}/context/business.md` or `{vault}/context/strategy.md`
   - Personal preferences → `{vault}/context/preferences.md`
   - Technical decisions → `{vault}/context/` or relevant zone
   - Topic-specific → existing file or new `{vault}/context/{topic}.md`
2. Append the new knowledge to that file
3. Confirm: "Saved to [[context/file]] — won't ask again."

## Rules

- **Vault-first, always.** Never ask the human something the vault already answers. Every repeated question is a failure of the system.
- **Every option: pros, cons, recommend.** Keep each 1-2 lines. User wants signal.
- **Grill until bulletproof.** Do not stop early. A plan with unresolved branches is not done.
- **Write back immediately.** Don't batch — save each answer as soon as confirmed. If session crashes, knowledge is preserved.
- **Surface conflicts.** If vault has contradictory info (e.g., goals.md says X but grill-session says Y), surface the conflict and ask which is current. Update the stale one.

## Output

When complete, save a structured summary of all decisions to:
`{vault}/daily/grill-sessions/YYYY-MM-DD-<topic-slug>.md`

Include:
- Questions asked (with vault-sourced vs human-answered breakdown)
- All decisions made with rationale
- Context files updated during this session
- Open questions for future sessions (if any)

## Usage
```
/grill <topic>           Start grilling on a topic
/grill                   Resume or ask what to grill on
```
