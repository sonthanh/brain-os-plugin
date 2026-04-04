#!/usr/bin/env python3
"""Write atomic Obsidian notes (~100 words each) with frontmatter and wikilinks."""

import os
import re
import sys
import json
from pathlib import Path


def slugify(text: str) -> str:
    """Convert text to kebab-case filename."""
    text = text.lower().strip()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[\s_]+", "-", text)
    text = re.sub(r"-+", "-", text)
    return text.strip("-")[:80]


def write_note(
    base_dir: str,
    category: str,
    title: str,
    content: str,
    key_insight: str,
    related: list[str],
    source: str = "The Road Less Stupid",
    author: str = "Keith J. Cunningham",
    chapter: int | str = "",
    tags: list[str] | None = None,
) -> str:
    """Write a single atomic note to Obsidian vault.

    Returns the path of the created file.
    """
    base = Path(base_dir)
    category_dir = base / slugify(category)
    category_dir.mkdir(parents=True, exist_ok=True)

    filename = slugify(title) + ".md"
    filepath = category_dir / filename

    # Build frontmatter
    tags_str = ", ".join(tags) if tags else slugify(category)
    related_links = "\n".join(f"- [[{r}]]" for r in related) if related else "- (none yet)"

    note = f"""---
source: "{source}"
author: "{author}"
chapter: {chapter}
tags: [{tags_str}]
---

# {title}

{content.strip()}

## Key Insight
{key_insight.strip()}

## Related
{related_links}
"""

    filepath.write_text(note, encoding="utf-8")
    return str(filepath)


def write_notes_batch(base_dir: str, notes: list[dict]) -> list[str]:
    """Write multiple notes. Each dict has: category, title, content, key_insight, related, chapter, tags."""
    paths = []
    for n in notes:
        path = write_note(
            base_dir=base_dir,
            category=n["category"],
            title=n["title"],
            content=n["content"],
            key_insight=n["key_insight"],
            related=n.get("related", []),
            chapter=n.get("chapter", ""),
            tags=n.get("tags"),
        )
        paths.append(path)
    return paths


if __name__ == "__main__":
    # Test: write a sample note
    if len(sys.argv) < 2:
        print("Usage: note_writer.py <base_dir> [--test]")
        sys.exit(1)

    base = sys.argv[1]
    if "--test" in sys.argv:
        path = write_note(
            base_dir=base,
            category="decision-making",
            title="Thinking Time",
            content="A disciplined 30-45 min ritual of uninterrupted concentration. Sit still, write questions by hand, brainstorm without filtering, then evaluate top ideas. Schedule results on calendar. Do 2-3x per week.",
            key_insight="The highest-leverage activity a business owner can do is sit and think deliberately, not react.",
            related=["dumb-tax", "five-core-disciplines", "asking-right-questions"],
            chapter=2,
            tags=["decision-making", "thinking-time", "discipline"],
        )
        print(f"Test note written to: {path}")
    else:
        # Read JSON from stdin
        notes = json.loads(sys.stdin.read())
        paths = write_notes_batch(base, notes)
        for p in paths:
            print(p)
