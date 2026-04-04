#!/usr/bin/env python3
"""Generate questions for validation: topic-based, blind, and adversarial."""

import sys
import json
import random
from pathlib import Path


TOPIC_QUESTION_PROMPT = """Given this knowledge note from the book "The Road Less Stupid" by Keith J. Cunningham:

TOPIC: {topic}
CONTENT: {content}

Generate {count} diverse questions that test deep understanding of this concept.
Questions should require specific knowledge from the book, not general knowledge.
Mix factual recall, application, and conceptual understanding.

Respond in EXACTLY this JSON format (no other text):
[{{"question": "...", "type": "topic", "topic": "{topic}"}}]"""


BLIND_QUESTION_PROMPT = """The book "The Road Less Stupid" by Keith J. Cunningham covers these chapters/sections:

{chapters}

Generate {count} questions that test knowledge across the book.
Focus on cross-cutting themes, relationships between concepts, and practical application.
Do NOT ask about specific chapter numbers — ask about the IDEAS.

Respond in EXACTLY this JSON format (no other text):
[{{"question": "...", "type": "blind", "topic": "cross-cutting"}}]"""


ADVERSARIAL_QUESTION_PROMPT = """You are a rigorous examiner testing someone's mastery of "The Road Less Stupid" by Keith J. Cunningham.

Known topics the learner claims to understand:
{topics}

Generate {count} adversarial questions designed to expose shallow understanding:
- Edge cases and subtle distinctions between concepts
- Questions where common misconceptions would lead to wrong answers
- Questions requiring synthesis of multiple concepts
- Questions about specific processes, numbers, or frameworks from the book

Respond in EXACTLY this JSON format (no other text):
[{{"question": "...", "type": "adversarial", "topic": "..."}}]"""


def get_topics_from_vault(vault_dir: str) -> list[dict]:
    """Scan Obsidian vault and return topics with their content."""
    vault = Path(vault_dir)
    topics = []

    if not vault.exists():
        return topics

    for md_file in sorted(vault.rglob("*.md")):
        content = md_file.read_text(encoding="utf-8")
        # Extract title from first heading
        title = md_file.stem.replace("-", " ").title()
        for line in content.split("\n"):
            if line.startswith("# "):
                title = line[2:].strip()
                break

        category = md_file.parent.name
        topics.append({
            "title": title,
            "category": category,
            "content": content,
            "path": str(md_file),
        })

    return topics


def build_topic_prompts(vault_dir: str, questions_per_topic: int = 3) -> list[dict]:
    """Build prompts for topic-based questions."""
    topics = get_topics_from_vault(vault_dir)
    prompts = []
    for topic in topics:
        prompts.append({
            "prompt": TOPIC_QUESTION_PROMPT.format(
                topic=topic["title"],
                content=topic["content"][:500],
                count=questions_per_topic,
            ),
            "type": "topic",
            "topic": topic["title"],
            "expected_count": questions_per_topic,
        })
    return prompts


def build_blind_prompt(chapters: list[str], count: int = 30) -> dict:
    """Build prompt for blind questions."""
    return {
        "prompt": BLIND_QUESTION_PROMPT.format(
            chapters="\n".join(f"- {ch}" for ch in chapters),
            count=count,
        ),
        "type": "blind",
        "expected_count": count,
    }


def build_adversarial_prompt(vault_dir: str, count: int = 20) -> dict:
    """Build prompt for adversarial questions."""
    topics = get_topics_from_vault(vault_dir)
    topic_names = [t["title"] for t in topics]
    return {
        "prompt": ADVERSARIAL_QUESTION_PROMPT.format(
            topics="\n".join(f"- {t}" for t in topic_names),
            count=count,
        ),
        "type": "adversarial",
        "expected_count": count,
    }


def calculate_question_counts(num_topics: int) -> dict:
    """Calculate question distribution based on topic count.

    Coverage formula: min_questions = max(100, topics × 3)
    Split: 50% topic-based, 30% blind, 20% adversarial
    """
    total = max(100, num_topics * 3)
    topic_total = int(total * 0.5)
    blind_count = int(total * 0.3)
    adversarial_count = total - topic_total - blind_count

    # Per-topic questions (at least 1 each)
    per_topic = max(1, topic_total // max(1, num_topics))

    return {
        "total": total,
        "topic_per_topic": per_topic,
        "topic_total": per_topic * num_topics,
        "blind": blind_count,
        "adversarial": adversarial_count,
        "num_topics": num_topics,
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: question_gen.py <vault_dir> [--counts | --prompts]")
        sys.exit(1)

    vault = sys.argv[1]

    if "--counts" in sys.argv:
        topics = get_topics_from_vault(vault)
        counts = calculate_question_counts(len(topics))
        print(json.dumps(counts, indent=2))
    elif "--prompts" in sys.argv:
        topics = get_topics_from_vault(vault)
        counts = calculate_question_counts(len(topics))
        all_prompts = {
            "topic": build_topic_prompts(vault, counts["topic_per_topic"]),
            "blind": build_blind_prompt(
                [t["title"] for t in topics], counts["blind"]
            ),
            "adversarial": build_adversarial_prompt(vault, counts["adversarial"]),
            "counts": counts,
        }
        print(json.dumps(all_prompts, ensure_ascii=False, indent=2))
    else:
        topics = get_topics_from_vault(vault)
        print(f"Found {len(topics)} topics in vault")
        for t in topics:
            print(f"  - [{t['category']}] {t['title']}")
