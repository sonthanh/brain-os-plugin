---
name: book
description: "Use when capturing book knowledge through conversation, without raw notes — just memory and impressions"
---

## Vault Location
**Vault path:** Read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md`

## Behavior

### Phase 1: Quick Context (2-3 questions)
1. "What is the book about in one sentence?"
2. "What is the most important thing you took away?"
3. "Rating out of 10? What makes it that rating?"

### Phase 2: Deep Extraction (guided conversation)
Ask focused questions one at a time. Adapt based on the book type:

**For business/strategy books:**
- "What framework or model from this book is most useful?"
- "How does this apply to what you are building with AI Leaders Vietnam?"
- "What would you change in your business based on this?"

**For personal development books:**
- "What habit or mindset shift does the author advocate?"
- "Which of these resonated with you? Which did not?"
- "What will you actually do differently after reading this?"

**For technical/AI books:**
- "What is the key technical insight?"
- "How does this change how you think about AI implementation?"
- "What should you share with your community?"

**For any book:**
- "What did you disagree with?"
- "What surprised you?"
- "If you could only remember one thing from this book in 5 years, what would it be?"

### Phase 3: Build the Note
1. From our conversation, construct the full book note using the template from `/ingest`
2. Show me the draft before saving
3. After approval, save to `{vault}/knowledge/books/[book-slug].md`
4. Update `{vault}/knowledge/books/_index.md`
5. Ask: "Want me to run `/absorb [book]` to connect these insights to your vault?"

## Conversation Rules
- Ask ONE question at a time -- do not overwhelm
- If I give a short answer, probe deeper: "Can you say more about that?"
- If I go on a tangent, capture it -- tangents often reveal the most valuable insights
- Respect my language -- if I answer in Vietnamese, capture in Vietnamese
- The goal is to extract knowledge I might forget in a month

## Quick Mode
If I say `/book [title] quick`, do a compressed version:
1. Ask only: "One sentence summary? Key takeaway? Rating? One thing to apply?"
2. Create a minimal book note
3. Save immediately
