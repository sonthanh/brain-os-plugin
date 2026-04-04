#!/usr/bin/env python3
"""Wrapper around notebooklm-py CLI for querying NotebookLM."""

import subprocess
import sys
import json
import os
import re


NLM_BIN = os.path.expanduser("~/.local/bin/notebooklm")


def ensure_notebook(notebook_id: str) -> bool:
    """Set the active notebook context."""
    result = subprocess.run(
        [NLM_BIN, "use", notebook_id],
        capture_output=True, text=True, timeout=30
    )
    return result.returncode == 0


def ask(question: str, notebook_id: str | None = None) -> dict:
    """Ask NotebookLM a question and return the answer.

    Returns: {"answer": str, "success": bool, "error": str | None}
    """
    if notebook_id:
        ensure_notebook(notebook_id)

    try:
        result = subprocess.run(
            [NLM_BIN, "ask", question],
            capture_output=True, text=True, timeout=120
        )

        if result.returncode != 0:
            return {
                "answer": "",
                "success": False,
                "error": result.stderr.strip() or "Unknown error"
            }

        # Parse the output - extract the Answer section
        output = result.stdout
        answer = ""

        # The CLI outputs "Answer:" followed by the content
        if "Answer:" in output:
            answer = output.split("Answer:", 1)[1].strip()
        else:
            # Fallback: take everything after the first blank line
            answer = output.strip()

        # Clean up citation markers like [1], [2, 3]
        answer = re.sub(r"\s*\[\d+(?:,\s*\d+)*\]\s*", " ", answer)
        answer = re.sub(r"\s+", " ", answer).strip()

        return {
            "answer": answer,
            "success": True,
            "error": None
        }

    except subprocess.TimeoutExpired:
        return {
            "answer": "",
            "success": False,
            "error": "Timeout: NotebookLM took too long to respond"
        }
    except Exception as e:
        return {
            "answer": "",
            "success": False,
            "error": str(e)
        }


def ask_batch(questions: list[str], notebook_id: str | None = None) -> list[dict]:
    """Ask multiple questions sequentially."""
    if notebook_id:
        ensure_notebook(notebook_id)

    results = []
    for q in questions:
        result = ask(q)
        results.append({"question": q, **result})
    return results


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: nlm_client.py <question> [--notebook-id <id>]")
        print("       nlm_client.py --batch < questions.json")
        sys.exit(1)

    nb_id = None
    if "--notebook-id" in sys.argv:
        idx = sys.argv.index("--notebook-id")
        nb_id = sys.argv[idx + 1]

    if "--batch" in sys.argv:
        questions = json.loads(sys.stdin.read())
        results = ask_batch(questions, nb_id)
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        question = sys.argv[1]
        result = ask(question, nb_id)
        if result["success"]:
            print(result["answer"])
        else:
            print(f"Error: {result['error']}", file=sys.stderr)
            sys.exit(1)
