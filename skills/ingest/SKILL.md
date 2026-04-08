---
name: ingest
description: "Use when processing raw knowledge input (book notes, highlights, raw files) into structured vault notes"
---

## Vault Location
**Vault path:** Read from `${CLAUDE_PLUGIN_ROOT}/brain-os.config.md`

**Note:** When using `/study` pipeline, ingestion is handled by self-learn Phase 3 automatically. Use `/ingest` standalone for manual processing of raw files outside the study pipeline.

## Behavior

### If `/ingest` (no argument) — Process all raw files
1. **Scan `{vault}/knowledge/raw/`** for unprocessed files
2. For each file, determine the source type (book, article, podcast, course)
3. Process each one (see processing steps below)
4. After processing, add `processed: true` to the raw file's frontmatter
5. Report summary: "Ingested X files. Created/updated Y knowledge notes."

### If `/ingest [filepath]` — Process a specific file
1. Read the specified file
2. Process it (see processing steps below)

## Processing Steps (Per Source)

### For Books:
1. **Extract metadata**: title, author, publication year, genre/topic
2. **Extract key concepts**: main ideas, frameworks, models, mental models
3. **Extract actionable insights**: things I can apply to my life/business
4. **Extract memorable quotes**: max 3-5 short quotes (under 15 words each)
5. **Identify vault connections**: which existing vault files relate to this content?
6. **Create or update** the book note at `{vault}/knowledge/books/[book-slug].md` using the Book Note Template below
7. **Create wiki-links** to related vault files

### For Articles/Podcasts/Courses:
Same process, saved to respective `{vault}/knowledge/[type]/` folder.

## Book Note Template

```markdown
---
title: "[Book Title]"
author: "[Author]"
year: [Year]
finished: YYYY-MM-DD
rating: X/10
tags: [knowledge, book, topic1, topic2]
zone: knowledge
status: reading | completed | abandoned
---

# [Book Title]
**Author**: [Author]
**Rating**: X/10

## One-Sentence Summary
> [The book in one sentence]

## Core Thesis
[What is the author's main argument? 2-3 sentences max]

## Key Concepts

### 1. [Concept Name]
[Explanation in my own words. How I understand this.]

### 2. [Concept Name]
[Explanation]

### 3. [Concept Name]
[Explanation]

## Frameworks & Mental Models
- **[Framework name]**: [Brief description + when to use it]

## Actionable Insights
- [ ] [Something I can apply to my life/business]
- [ ] [Another actionable takeaway]

## Connections to My Vault
- Relates to [[context/strategy]] because...
- Connects to [[thinking/ideas/...]] on...
- Could inform [[business/...]]

## My Reactions & Thoughts
> [Personal reactions — what I agree/disagree with, what surprised me]

## Memorable Passages
> [Short quote or paraphrase, max 15 words] (p. XX)

## Questions This Raises
- [Question the book made me think about]
```

## After Ingestion (standalone mode only)
Auto-chain: `/audit` → `/absorb` → commit + push → notify.
Do NOT ask for confirmation — execute the full chain.
