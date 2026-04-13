---
name: think
description: "Use when entering deep thinking mode, exploring ideas, finding patterns, or reflecting on vault content. Also triggers on: challenge, stress-test, emerge, drift, trace, connect, ideas, ghost, brainstorm, what if, poke holes"
---

## Pre-Think Check
**IMPORTANT: Before starting, check for un-audited knowledge.**
Run: `python3 ${CLAUDE_PLUGIN_ROOT}/skills/audit/scripts/audit.py {vault}/knowledge/raw --status`
If any book shows ❌ or 👁️, warn: "⚠️ Un-audited knowledge: [book]. Run /audit to verify."

## Vault Location
**Vault path:** Read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md`

# /think — Deep Thinking Mode

## Usage
```
/think                        Open-ended reflection and exploration
/think digest                 Review agent-output, promote insights to proper vault zones
/think challenge <topic>      Stress-test a belief against vault evidence
/think emerge                 Surface ideas the vault implies but never stated
/think drift                  Compare stated goals vs actual behavior (30-60 days)
/think trace <topic>          Track how an idea evolved over time
/think connect <A> <B>        Find bridges between two domains
/think ideas                  Brainstorm across all vault domains
/think ghost <question>       Answer a question as the user would
```

If no angle given, show the menu above and ask: "What's on your mind?"

## General Behaviors (all angles)
- Focus on `{vault}/thinking/`, `{vault}/daily/`, and `{vault}/context/`
- Minimize business framing unless user brings it up
- Be a thinking partner — ask probing questions, challenge assumptions
- Write output to `{vault}/thinking/agent-output/YYYY-MM-DD-<angle>-<topic>.md`
- Ask "why" and "what if" questions, surface contradictions, suggest new angles

---

## Angles

### digest
Review agent-output files and promote insights to proper thinking/ zones:
1. **Scan** — read all files in `{vault}/thinking/agent-output/` (skip README.md)
2. **Summarize each file** — 2-3 line summary per file, grouped by theme
3. **Present for review** — show the user what's there:
   ```
   📂 Agent Output (N files)

   1. [filename] — summary
      → Suggested zone: patterns/ | ideas/ | connections/ | reflections/ | principles/
      → Key insight: one-liner

   2. [filename] — summary
      → Suggested zone: ...
      → Key insight: ...
   ```
4. **Ask user** — "Which insights to promote? (all / numbers / skip)" 
5. **For each promoted insight:**
   - Move file from `agent-output/` to the target zone (rename if needed for clarity)
   - Update frontmatter: add `promoted: YYYY-MM-DD`, update `zone` field
   - Add wiki-links from related existing vault files → the promoted file
   - Add wiki-links from the promoted file → related vault files
6. **Clear agent-output** — after all files are processed (promoted, merged, or skipped), delete ALL processed files from agent-output/. This folder is a staging area, not storage. Knowledge already lives in its destination.
7. **Summary** — report what was promoted where, with link count

**Rules:**
- NEVER auto-promote without user confirmation — this is the human's thinking zone
- Suggest zones based on content type: recurring theme → patterns/, novel idea → ideas/, bridge between domains → connections/, personal observation → reflections/, reusable principle → principles/
- If an insight overlaps with an existing vault file, suggest merging instead of creating a new file — then delete the agent-output file
- Keep promoted filenames clean: `YYYY-MM-DD-topic.md` (drop the `grill-insights-` prefix)
- agent-output/ must be empty (except README.md) after digest completes — no exceptions

### challenge <topic>
Pressure-test a belief or decision:
1. **Find current position** — scan vault for what user believes about this topic
2. **Find contradictions** — stated beliefs that conflict with actions or other beliefs
3. **Present counter-evidence** — arguments, data, perspectives that challenge the view
4. **Track belief shifts** — has user changed mind on this before?
5. **Ask hard questions** — 3-5 questions probing the weakest parts

### emerge
Surface ideas the vault implies but user never explicitly stated:
1. **Deep scan** — read across thinking/, daily/, personal/research/, context/
2. **Find scattered premises** — ideas in different contexts that form a larger conclusion
3. **Identify unnamed patterns** — recurring themes not yet named or formalized
4. **Surface unarticulated directions** — where actions/interests point that user hasn't consciously decided

### drift
Compare stated intentions vs actual behavior:
1. **Read goals** — context/goals.md, context/strategy.md
2. **Read 30-60 days of daily notes** — what was actually spent time on
3. **Compare** — where do goals align with activity? Where do they diverge?
4. **Surface avoidance** — goals set but consistently not worked on
5. **Surface hidden priorities** — things done repeatedly but not in stated goals

### trace <topic>
Track how an idea evolved over time:
1. **Build vocabulary map** — search vault for all mentions and related terms
2. **Create timeline** — order mentions chronologically
3. **Identify phases** — discovery, skepticism, adoption, mastery, etc.
4. **Show evolution** — how understanding or position changed
5. **Current state** — where is the user now with this idea?

### connect <domain1> <domain2>
Find bridges between two domains:
1. **Scan domain 1** — find all vault files related
2. **Scan domain 2** — find all vault files related
3. **Find bridges** — shared themes, patterns, insights
4. **Generate novel connections** — non-obvious links based on vault evidence
5. **Suggest actions** — what could be done with these connections?

### ideas
Comprehensive idea generation:
1. **Gather vault structure** — files, connections, orphans, dead ends
2. **Read context** — context/, recent daily/, active projects/
3. **Scan thinking zone** — ideas/, patterns/, connections/
4. **Cross-domain analysis** — patterns across different vault areas
5. **Generate ideas**: tools to build, content to create, systems to implement, conversations to have, subjects to investigate
6. **Rank by impact** — top 5 "do now" items

### ghost <question>
Answer a question as the user would:
1. **Build voice profile** — read about-me.md, preferences.md, recent daily notes, reflections/
2. **Scan relevant vault files** for actual opinions on the topic
3. **Write answer in user's voice** — matching tone, vocabulary, reasoning, values
4. **Rate fidelity** — confidence 1-10 that this matches how user would respond
5. **Flag gaps** — where vault lacks data on this topic

## Outcome log

Follow `skill-spec.md § 11`. Append to `{vault}/daily/skill-outcomes/think.log`:

```
{date} | think | {action} | ~/work/brain-os-plugin | thinking/agent-output/{date}-{angle}-{topic}.md | commit:{hash} | {result}
```

- `action`: `think`, `digest`, `challenge`, `emerge`, `drift`, `trace`, `connect`, `ideas`, or `ghost`
- `result`: `pass` if output written, `partial` if gaps flagged or vault data sparse, `fail` if no relevant vault content found
- Optional: `args="{angle} {topic}"`
