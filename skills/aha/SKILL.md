---
name: aha
description: "Capture key moments mid-session with full context. Triggers on natural language: aha, mark this, key moment, that's interesting, remember this decision, this is important, breakthrough"
---

## Vault Location
**Vault path:** Read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md`

# /aha — Capture Key Moments

Captures the current context automatically when something clicks. Designed for speed — don't break flow.

## Behavior

When triggered (by `/aha`, `/aha <note>`, or natural language like "aha"):

1. **Capture context automatically** (no questions asked):
   - Current repo (from working directory)
   - Last 3-5 git commits in this session
   - Recent git diff --stat (what changed)
   - The decision or insight that just happened (from conversation context)

2. **Append to daily aha file**: `{vault}/daily/sessions/YYYY-MM-DD-aha.md`

   Format per entry:
   ```markdown
   ## HH:MM — <repo> (<topic>)
   > "<user's one-liner if provided>"

   **Context:** <what was being worked on, 1-2 sentences>
   **Decision:** <the key decision or insight>
   **Evidence:** <commits, file changes, or conversation that led here>
   **Files:** <key files involved>
   ```

3. **Confirm briefly**: "Captured." — then continue working. No summary, no questions.

## Trigger Rules
- **"aha" at start of message = ALWAYS a trigger**, even with instructions after it
  - "aha cần tạo task..." → capture aha first, then handle the instruction
  - "aha switching to remote task" → capture with that as the quote
- **"aha" mid-sentence is NOT a trigger** — e.g., "I had an aha about..." is normal speech
- Primary trigger: `/aha` (always reliable)
- Natural language: best-effort, depends on position in message

## Rules
- Speed over completeness — capture in <5 seconds, don't ask follow-up questions
- If user provides a one-liner (`aha switching to remote task is faster`), use it as the quote
- If no one-liner, infer the key moment from recent conversation context
- One file per day, multiple entries appended
- This is RAW MATERIAL for `/journal` — don't polish, just capture
- Never break the user's flow with confirmation dialogs or summaries
