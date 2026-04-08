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
/grill <topic>              Manual grill (default — ask everything)
/grill auto <topic>         Auto-grill (vault-first, skip known answers)
/grill compare <topic>      Compare existing sessions on same topic
/grill                      Resume or ask what to grill on
```

## Modes

### Manual (default)
Ask every question from scratch. No vault search. Pure grill.
This is the proven mode — it always works. Saves to `YYYY-MM-DD-<topic>-manual.md`.

### Auto (`/grill auto`)
Searches vault before each question. Presents found knowledge. Only grills for gaps.
Saves to `YYYY-MM-DD-<topic>-auto.md`.
Best for: topics where vault has rich context and you want to skip re-answering settled questions.

### Compare (`/grill compare`)
Compares two grill sessions (manual vs auto) on the same topic. Flexible workflow:

**Typical flow:**
1. `/grill auto <topic>` → run auto-grill, find issues
2. `/grill <topic>` → re-grill manually to get ground truth
3. `/grill compare <topic>` → diff the two sessions

**What compare does:**
1. Find existing sessions for `<topic>` in `daily/grill-sessions/` (looks for `*-<topic>-auto.md` and `*-<topic>-manual.md`)
2. If both exist → produce comparison report
3. If only one exists → tell user which mode is missing, offer to run it
4. Comparison report:
   ```
   ## Comparison: <topic>

   ### Stats
   - Auto: N questions, vault answered M (X%)
   - Manual: N questions, human answered all

   ### Where auto was right
   - [Question]: vault said X, manual confirmed X ✅

   ### Where auto was wrong
   - [Question]: vault said X, manual revealed Y ❌
     → Vault entry updated: [[context/file]]

   ### What auto missed
   - [Question]: auto skipped this (vault had no info), manual uncovered important insight
     → New vault entry: [[context/file]]

   ### Learnings
   - Vault accuracy: X% (N/M correct)
   - Files updated: [list]
   - Files confirmed accurate: [list]
   ```
5. Save to `YYYY-MM-DD-<topic>-comparison.md`
6. Auto-update stale vault entries from the diff
7. Log accuracy trend: if multiple comparisons exist, show improvement over time

## Session Log Format

Every grill session (auto or manual) saves a structured log to `{vault}/daily/grill-sessions/`:

```markdown
---
topic: "<topic>"
mode: auto | manual
date: YYYY-MM-DD
duration_questions: N
vault_answered: N
human_answered: N
vault_accuracy: "N/N (X%)"
context_files_updated: [list]
---

# Grill Session: <topic>

## Stats
- Mode: auto | manual
- Total questions: N
- Vault-sourced answers: N (X%)
- Human-answered gaps: N (Y%)
- Context files updated: N

## Decisions

### 1. [Question/Branch]
- **Source:** vault | human
- **Vault said:** [if auto mode, what vault provided]
- **Decision:** [final answer]
- **Saved to:** [[context/file]] | (not saved — vault already had this)

### 2. [Question/Branch]
...

## Context Files Updated
- [[context/strategy.md]] — added [what]
- [[context/business.md]] — updated [what]

## Open Questions
- [anything unresolved for next session]
```

## Feedback Loop

If user is unhappy with the auto-grill result:
1. User says "grill was wrong about X" or "vault was stale on Y"
2. Agent immediately updates the stale vault entry
3. Logs the correction in the session file under `## Corrections`
4. Next auto-grill on same topic will use the corrected knowledge
