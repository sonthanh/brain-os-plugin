#!/usr/bin/env python3
"""Run Phase 2 validation: batch query NotebookLM and save answers."""

import json
import subprocess
import sys
import time
import os

NLM_BIN = os.path.expanduser("~/.local/bin/notebooklm")

QUERY_DELAY = int(os.environ.get("NLM_QUERY_DELAY", 3))  # between successful queries
BACKOFF_START = 15  # first backoff on rate limit
BACKOFF_MAX = 120   # cap


def ask_nlm(question: str, retries: int = 3) -> str:
    """Ask NotebookLM a question with exponential backoff on rate limits."""
    backoff = BACKOFF_START
    for attempt in range(retries + 1):
        try:
            result = subprocess.run(
                [NLM_BIN, "ask", question],
                capture_output=True, text=True, timeout=120
            )
            if result.returncode == 0:
                output = result.stdout
                if "Answer:" in output:
                    answer = output.split("Answer:", 1)[1]
                    if "Conversation:" in answer:
                        answer = answer.rsplit("Conversation:", 1)[0]
                    return answer.strip()
                return output.strip()
            else:
                stderr = result.stderr.strip()
                if "rate limit" in stderr.lower() and attempt < retries:
                    print(f" RATE LIMITED, backoff {backoff}s...", end="", flush=True)
                    time.sleep(backoff)
                    backoff = min(backoff * 2, BACKOFF_MAX)
                    continue
                elif attempt < retries:
                    time.sleep(QUERY_DELAY)
                    continue
                return f"ERROR: {stderr}"
        except subprocess.TimeoutExpired:
            if attempt < retries:
                time.sleep(QUERY_DELAY)
                continue
            return "ERROR: Timeout"
        except Exception as e:
            return f"ERROR: {str(e)}"
    return "ERROR: All retries failed"


def main():
    questions_file = sys.argv[1] if len(sys.argv) > 1 else "/tmp/self-learn-questions.json"
    output_file = sys.argv[2] if len(sys.argv) > 2 else "/tmp/self-learn-answers.jsonl"

    # Resume support: check how many already done
    done_ids = set()
    if os.path.exists(output_file):
        with open(output_file, "r") as f:
            for line in f:
                try:
                    entry = json.loads(line)
                    done_ids.add(entry["id"])
                except:
                    pass

    with open(questions_file) as f:
        data = json.load(f)

    questions = data["questions"]
    remaining = [q for q in questions if q["id"] not in done_ids]

    print(f"Total questions: {len(questions)}")
    print(f"Already done: {len(done_ids)}")
    print(f"Remaining: {len(remaining)}")
    print(f"Output: {output_file}")
    print("---")

    with open(output_file, "a") as out:
        for i, q in enumerate(remaining):
            qid = q["id"]
            question = q["q"]
            print(f"[{qid}/{len(questions)}] ({q['type']}) {question[:60]}...", end=" ", flush=True)

            answer = ask_nlm(question)
            is_error = answer.startswith("ERROR:")

            entry = {
                "id": qid,
                "type": q["type"],
                "topic": q["topic"],
                "question": question,
                "nlm_answer": answer,
                "error": is_error,
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S")
            }
            out.write(json.dumps(entry, ensure_ascii=False) + "\n")
            out.flush()

            status = "ERR" if is_error else f"OK ({len(answer)} chars)"
            print(status)

            # Delay between questions to avoid rate limiting
            if not is_error:
                time.sleep(QUERY_DELAY)

    # Summary
    total_ok = 0
    total_err = 0
    with open(output_file) as f:
        for line in f:
            entry = json.loads(line)
            if entry.get("error"):
                total_err += 1
            else:
                total_ok += 1

    print(f"\n=== DONE ===")
    print(f"Successful: {total_ok}/{len(questions)}")
    print(f"Errors: {total_err}")
    print(f"Results saved to: {output_file}")


if __name__ == "__main__":
    main()
