---
name: self-learn
description: "Use when mastering a book's content through autonomous extraction, validation against NotebookLM, and knowledge extension"
---

# Self-Learning Agent

3-phase autonomous agent: extract book content → validate against NotebookLM → extend beyond the source. Inspired by [autoresearch](https://github.com/ehmo/autoresearch) — independent teams with information barriers.

**All knowledge lives in Obsidian, never in this skill.**

## Configuration

```yaml
obsidian_vault: "{vault}/knowledge/raw"  # Read {vault} from ${CLAUDE_PLUGIN_ROOT}/brain-os.config.md
notebooklm_bin: ~/.local/bin/notebooklm
scripts_dir: ${CLAUDE_PLUGIN_ROOT}/skills/self-learn/scripts
```

## Phase 1: EXTRACT

**Goal:** Read the book → identify atomic concepts → write Obsidian notes.

1. Parse epub via `scripts/lib/epub_parser.py` to get chapter text
2. For EACH chapter sequentially:
   a. Identify atomic concepts — look for:
      - Named frameworks (e.g., "The Four Hats", "Thinking Time")
      - Core principles (e.g., "minimize dumb tax")
      - Processes/rituals (step-by-step methods)
      - Mental models (2nd-order consequences, checking assumptions)
      - Distinctions (operator vs owner, revenue vs profit)
      - Actionable tools (specific questions, decision frameworks)
   b. Create one note per concept (~100 words) using `scripts/lib/note_writer.py`
   c. Categorize into topic folders, link to related concepts from previous chapters
3. After all chapters: report total topics extracted and category breakdown

### Knowledge Path
```
{obsidian_vault}/{book-slug}/
  ├── decision-making/
  ├── business-operations/
  ├── leadership/
  └── [discovered categories]/
```

### Note Template
```markdown
---
source: "{book_title}"
author: "{author}"
chapter: {chapter_number}
tags: [{tags}]
---

# {Concept Title}

{~100 words: concise, crystal clear, key point only}

## Key Insight
{One sentence takeaway}

## Related
- [[related-concept-1]]
- [[related-concept-2]]
```

## Phase 2: VALIDATE (Autoresearch Loop)

**Goal:** Compare agent knowledge against NotebookLM. Patch gaps until mastery.

### Architecture — 4 independent roles with information barriers
1. **Question Generator** — creates questions without seeing answers
2. **Knowledge Agent** — answers ONLY from Obsidian notes (never the book directly)
3. **Oracle (NotebookLM)** — answers from full book via `notebooklm ask`
4. **Judge** — scores similarity without knowing which answer is agent vs oracle

### NotebookLM Setup
```bash
~/.local/bin/notebooklm use {notebook_id}    # Set active notebook FIRST
~/.local/bin/notebooklm ask "{question}"      # Then ask questions
```

### Process
1. Generate questions: `total = max(100, num_topics × 3)`
   - 50% topic-based (from Obsidian note content) via `scripts/lib/question_gen.py`
   - 30% blind (from chapter titles, cross-cutting)
   - 20% adversarial (designed to expose shallow understanding)
2. For EACH question:
   a. **Agent answers** by reading relevant Obsidian notes only
   b. **NotebookLM answers** via `notebooklm ask "{question}"`
   c. **Judge scores** using `scripts/lib/judge.py` prompt (0-100 scale)
   d. If score < 95: identify what's missing → update/create Obsidian notes
3. Track scores in validation log
4. **Stop when:** 100% pass rate — ALL questions score ≥ 95
5. If not passing: generate NEW questions targeting weak topics, repeat

**Wrong concepts are catastrophic.** Fix conceptual errors before missing details. A note that says the wrong thing is far worse than a note missing a detail.

### Validation Log
```
Round 1: 85/100 passed (85%) — weak: [business-operations, leadership-hats]
Round 2: 94/100 passed (94%) — weak: [accountability-structures]
Round 3: 100/100 passed (100%) — MASTERY ACHIEVED
```

## Phase 3: EXTEND + INGEST

### 3a. Create Structured Book Note

After validation passes, create the structured book note directly (previously a separate `/ingest` step):

1. Read all validated atomic notes from `{obsidian_vault}/{book-slug}/`
2. Synthesize into a single structured book note at `{vault}/knowledge/books/{book-slug}.md`
3. Use the Book Note Template (see `/ingest` skill for template)
4. Extract: metadata, key concepts, frameworks, actionable insights, quotes, vault connections
5. Mark `ingested: true` in `_validation/audit-flag.json`

### 3b. Extend Beyond Source

1. **Synthesize** with adjacent thinkers — tagged `source: "synthesis"`
2. **Apply** to new domains — in `applied/{domain}/`, tagged `source: "application"`
3. **Research** current developments — tagged `source: "research-{date}"`

Extension notes use same template but different source tags.

## After Completion

Pipeline continues autonomously: `/verify` → `/absorb` → commit + push → notify.
Phase 2 must reach 100% pass at ≥95 before Phase 3 runs. See `/study` for full pipeline.

## Usage

```
/self-learn --book <epub_path> --notebook-id <nlm_id>
/self-learn --phase extract --book <epub_path>
/self-learn --phase validate --notebook-id <nlm_id>
/self-learn --phase extend
```

### Status — always run the script, never generate manually
```bash
python3 ${CLAUDE_PLUGIN_ROOT}/skills/self-learn/scripts/summary.py {vault}/knowledge/raw/the-road-less-stupid --status
python3 ${CLAUDE_PLUGIN_ROOT}/skills/self-learn/scripts/summary.py {vault}/knowledge/raw/the-road-less-stupid --phase3
python3 ${CLAUDE_PLUGIN_ROOT}/skills/self-learn/scripts/summary.py {vault}/knowledge/raw/the-road-less-stupid
```

### Available Books
| Book | Vault Path | NotebookLM ID |
|------|-----------|---------------|
| The Road Less Stupid | `knowledge/raw/the-road-less-stupid` | `9c6d742c-d512-42f6-a42c-ccdd993ef19f` |
| Start with Why | `knowledge/raw/start-with-why` | `e990cedd-7dca-4812-824e-7a9e757f0065` |
| Changing World Order | `knowledge/raw/dalio-changing-world-order` | `bf8f46c4-0dfb-4f5e-9013-7a9e757f0065` |
