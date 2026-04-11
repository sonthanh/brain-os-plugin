---
name: absorb
description: "Use when extracting deep insights from a book and connecting them to vault zones (business, personal, thinking)"
---

## Pre-Absorb Check
Run: `python3 ${CLAUDE_PLUGIN_ROOT}/skills/verify/scripts/verify.py {vault}/knowledge/raw --status`
- ❌ (false): BLOCK — "Run /verify first before absorbing."
- 👁️ (manual): Run WITH approval prompt — show each proposal, ask "Approve? (all / pick numbers / skip)"
- ✅ (true): Run autonomously, bypass approval.

## Vault Location
**Vault path:** Read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md`

## Behavior

### If `/absorb [book-name]` — Deep dive on one book
1. **Read the book note** from `{vault}/knowledge/books/[book].md`
2. **Read your current context** — `{vault}/context/strategy.md`, `{vault}/context/goals.md`, `{vault}/context/business.md`
3. **Cross-reference** book insights against your actual situation
4. **Generate absorption report** with 3 sections:

#### Section 1: Business Applications
- How does this book's insights apply to [[context/business]]?
- What should change in [[context/strategy]] based on this?
- Any implications for [[context/icp]] or [[context/brand]]?

#### Section 2: Personal Applications
- What habits, mindsets, or practices should I adopt?
- How does this change how I think about [[context/goals]]?

#### Section 3: Thinking Seeds
- What new ideas does this book seed?
- What existing ideas in `{vault}/thinking/ideas/` does this reinforce or challenge?
- What connections to other books or knowledge emerge?

5. **Propose vault updates**:
   - "Should I add [insight] to your strategy doc?"
   - "Should I create a new idea note in thinking/ideas/?"
   - "Should I update your preferences/rules based on [learning]?"
6. **Wait for approval** before making any changes

### If `/absorb` (no argument) — Cross-book synthesis
1. **Read all recent book notes** (last 5-10 books)
2. **Find cross-book patterns** — themes that appear across multiple books
3. **Identify knowledge gaps** — topics you keep reading about but haven't crystallized into action
4. **Generate synthesis report**:
   - Common threads across your reading
   - Contradictions between authors
   - The strongest actionable insights (backed by multiple sources)
   - Suggested `{vault}/thinking/patterns/` entries for recurring themes
5. **Save report** to `{vault}/thinking/agent-output/YYYY-MM-DD-absorption-synthesis.md`

## Output Format (Single Book)

```
## Absorption Report: [Book Title]

### For Your Business (AI Leaders Vietnam)
| Insight | Applies to | Suggested Action |
|---------|-----------|-----------------|
| [Insight] | [[context/strategy]] | [What to do] |
| [Insight] | [[context/icp]] | [What to do] |

### For You Personally
- [How this changes your thinking or habits]

### Thinking Seeds
- **New idea**: [Idea name] — [Brief description]
  → Create in thinking/ideas/? [y/n]
- **Reinforces**: [[thinking/ideas/existing-idea]] — [How]
- **Challenges**: [[thinking/patterns/existing-pattern]] — [How]

### Vault Updates Proposed
1. Add to context/strategy.md: [what]
2. Create thinking/ideas/[new-idea].md
3. Update context/preferences.md: [new rule from book]

Approve updates? (all / pick numbers / skip)
```

## Rules
- Never update vault files without explicit approval
- Always show what will change before changing it
- Prioritize actionable insights over theoretical knowledge
- Connect to EXISTING vault content — don't create orphan notes
