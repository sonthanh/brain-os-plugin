#!/usr/bin/env python3
"""Parse epub files into structured chapter text using ebooklib + BeautifulSoup."""

import sys
import json
import re
from pathlib import Path

import warnings

import ebooklib
from ebooklib import epub
from bs4 import BeautifulSoup, XMLParsedAsHTMLWarning

warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)


def html_to_text(html_content: str) -> str:
    """Convert HTML to clean text with markdown-style headings."""
    soup = BeautifulSoup(html_content, "lxml")

    # Remove script/style tags
    for tag in soup(["script", "style"]):
        tag.decompose()

    # Convert headings to markdown
    for i in range(1, 7):
        for heading in soup.find_all(f"h{i}"):
            prefix = "#" * i + " "
            heading.string = prefix + heading.get_text(strip=True)

    text = soup.get_text(separator="\n")
    # Clean up whitespace
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def extract_title(text: str, fallback: str = "Untitled") -> str:
    """Extract the best title from section text.

    Handles pattern: '# Chapter N' followed by subtitle on next non-empty line.
    """
    lines = [l.strip() for l in text.split("\n") if l.strip()]

    # Pattern: "# Chapter N" heading followed by subtitle
    for i, line in enumerate(lines):
        if re.match(r"^#\s+Chapter\s+\d+", line) and i + 1 < len(lines):
            subtitle = lines[i + 1].strip().strip('"').strip()
            if subtitle and len(subtitle) < 200 and not subtitle.startswith("—"):
                chapter_num = re.search(r"Chapter\s+(\d+)", line).group(0)
                return f"{chapter_num}: {subtitle}"

    # Pattern: "# Appendix N" or similar
    for i, line in enumerate(lines):
        if re.match(r"^#\s+(Appendix|Part|Section)\s+\d+", line) and i + 1 < len(lines):
            subtitle = lines[i + 1].strip().strip('"').strip()
            prefix = re.match(r"^#\s+(.+)", line).group(1)
            if subtitle and len(subtitle) < 200:
                return f"{prefix}: {subtitle}"
            return prefix

    # Fallback: first heading
    for line in lines:
        if line.startswith("# "):
            return line[2:].strip()

    # Fallback: first meaningful line
    for line in lines:
        if len(line) > 5 and len(line) < 200 and not line.startswith("©"):
            return line

    return fallback


def parse_epub(epub_path: str) -> list[dict]:
    """Parse epub into ordered list of chapters.

    Returns: [{"title": str, "text": str, "index": int, "word_count": int}, ...]
    """
    epub_path = Path(epub_path)
    if not epub_path.exists():
        raise FileNotFoundError(f"Epub not found: {epub_path}")

    book = epub.read_epub(str(epub_path))
    chapters = []
    idx = 0

    # Get items in spine order
    for item in book.get_items_of_type(ebooklib.ITEM_DOCUMENT):
        content = item.get_content().decode("utf-8", errors="replace")
        text = html_to_text(content)

        # Skip very short sections (copyright, dedications, etc.)
        word_count = len(text.split())
        if word_count < 50:
            continue

        title = extract_title(text, f"Section {idx + 1}")

        # Clean title — remove "Chapter N" prefix pattern for the title field
        # but keep it in the text
        clean_title = re.sub(r"^Chapter\s+\d+\s*[:.]?\s*", "", title).strip()
        if not clean_title:
            clean_title = title

        chapters.append({
            "title": clean_title,
            "text": text,
            "index": idx,
            "word_count": word_count,
        })
        idx += 1

    return chapters


def get_chapter_summary(chapters: list[dict]) -> str:
    """Generate a summary of extracted chapters."""
    lines = [f"Total chapters: {len(chapters)}", f"Total words: {sum(c['word_count'] for c in chapters)}", ""]
    for ch in chapters:
        lines.append(f"  [{ch['index']:2d}] {ch['title'][:60]:<60s} ({ch['word_count']:,} words)")
    return "\n".join(lines)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: epub_parser.py <path-to-epub> [--json | --summary]")
        sys.exit(1)

    epub_file = sys.argv[1]
    chapters = parse_epub(epub_file)

    if "--json" in sys.argv:
        print(json.dumps(chapters, ensure_ascii=False, indent=2))
    elif "--summary" in sys.argv:
        print(get_chapter_summary(chapters))
    else:
        print(get_chapter_summary(chapters))
        print("\n--- First 300 chars of each chapter ---")
        for ch in chapters:
            print(f"\n[{ch['index']}] {ch['title']}")
            print(ch["text"][:300])
