#!/usr/bin/env python3
"""LLM-as-judge: score similarity between agent answer and NotebookLM answer."""

import sys
import json


JUDGE_PROMPT = """You are an expert judge evaluating whether two answers about the same topic convey the same knowledge.

QUESTION: {question}

ANSWER A (Agent):
{answer_a}

ANSWER B (NotebookLM/Oracle):
{answer_b}

Score how well Answer A captures the essential knowledge in Answer B on a scale of 0-100.

CRITICAL: Wrong concepts are catastrophic. Score 0 if Answer A states something INCORRECT or contradicts Answer B. Missing details are less severe than wrong concepts.

Scoring rubric:
- 95-100: Answer A captures all key facts, concepts, specific details (names, numbers, frameworks), and nuances. No conceptual errors. Concise phrasing is fine.
- 85-94: Answer A captures core concepts correctly but misses some important specifics (a name, a number, a sub-step). No conceptual errors.
- 70-84: Answer A has the right general idea but misses multiple important details or nuances.
- 50-69: Answer A captures the topic but has significant gaps in specifics.
- 30-49: Answer A has some relevant info but major gaps.
- 1-29: Answer A is mostly irrelevant.
- 0: Answer A states something WRONG or contradicts Answer B (conceptual error).

Respond in EXACTLY this JSON format (no other text):
{{"score": <number>, "missing": "<what Answer A is missing, or 'nothing' if complete>", "conceptual_error": <true|false>, "verdict": "<pass|fail>"}}

A score >= 95 is a PASS. Below 95 is FAIL. Any conceptual_error is an automatic FAIL regardless of score."""


def build_judge_prompt(question: str, answer_a: str, answer_b: str) -> str:
    """Build the judge prompt for Claude to evaluate."""
    return JUDGE_PROMPT.format(
        question=question,
        answer_a=answer_a,
        answer_b=answer_b,
    )


def parse_judge_response(response: str) -> dict:
    """Parse the judge's JSON response."""
    # Try to find JSON in the response
    try:
        # Direct parse
        return json.loads(response.strip())
    except json.JSONDecodeError:
        pass

    # Try to extract JSON from markdown code block
    import re
    json_match = re.search(r"\{[^}]+\}", response, re.DOTALL)
    if json_match:
        try:
            return json.loads(json_match.group())
        except json.JSONDecodeError:
            pass

    # Fallback
    return {"score": 0, "missing": "Failed to parse judge response", "verdict": "fail"}


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--test":
        prompt = build_judge_prompt(
            question="What is Thinking Time?",
            answer_a="A disciplined ritual of sitting and thinking for 30-45 minutes.",
            answer_b="A 30-45 minute session of uninterrupted concentration with specific tools and process.",
        )
        print(prompt)
    else:
        # Read evaluation data from stdin
        data = json.loads(sys.stdin.read())
        prompt = build_judge_prompt(
            question=data["question"],
            answer_a=data["answer_a"],
            answer_b=data["answer_b"],
        )
        print(prompt)
